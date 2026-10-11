"use strict";
/**
 * 기존 기밀 문서 비교 화면의 제어기. app.js의 공통 상태/함수를 이어받는다.
 * profiles는 각 모델의 역할 설명과 연결 방식, batch는 실행 당시 문서·기준·결과다.
 * runComparison이 /api/analyze를 순차 호출하고 ComparisonMetrics가 집계한다.
 * 자유 Choice/Score/Noul 평가는 독립 페이지 evaluation.js가 담당한다.
 */
(() => {
  const profiles = [
    {
      id: "qwen",
      title: "Qwen3.5 · 4B",
      model: "qwen3.5:4b",
      provider: "ollama",
      method: "tokens",
      type: "일반 AI를 판단에 활용",
      description:
        "별도 판단 학습 없이 어디까지 구분하는지 확인하는 기준 모델입니다.",
      structure:
        "문서를 읽는 본체 → A·B 답 토큰 점수. 글을 쓰는 기능을 활용하지만 여기서는 답 하나의 점수만 읽습니다.",
      caution:
        "4B는 약 40억 개의 매개변수를 뜻합니다. 이 비교 화면에서는 설명을 생성하지 않습니다.",
    },
    {
      id: "jevk5",
      title: "JevK5 · 4B",
      model: "jevk5:latest",
      provider: "ollaya",
      method: "decision",
      type: "판단 연습을 더 시킨 AI",
      description:
        "Qwen과 비슷한 크기에서 판단 전용 학습이 어떤 차이를 만드는지 비교합니다.",
      structure:
        "Qwen3.5 본체 + 추가 학습 → 답 토큰 점수 → 온도 보정. TypeSafe의 Jev와는 다른 독립 모델입니다.",
      caution:
        "전용 질문 형식과 점수 보정을 함께 써야 합니다. Qwen과 압축 방식도 달라 학습 효과만 따로 측정한 실험은 아닙니다.",
    },
    {
      id: "laya",
      title: "Laya · 다국어",
      model: "laya:multilingual",
      provider: "ollaya",
      method: "decision",
      type: "짧은 문서를 읽는 분류 AI",
      description:
        "글을 생성하지 않는 구조입니다. 짧은 문서에서 속도와 오탐을 함께 확인하세요.",
      structure:
        "mmBERT 인코더 → 선택지 위치의 표현 → 분류 점수. 문장 양쪽 문맥을 읽는 약 3.22억 매개변수 모델입니다.",
      caution:
        "현재 연결 프로필은 입력 한도가 작습니다. 한국어 점수와 긴 문서 성능은 따로 검증해야 합니다.",
    },
    {
      id: "decider",
      title: "decider · 0.8B",
      model: "decider:0.8b",
      provider: "ollaya",
      method: "decision",
      type: "작은 판단 전용 AI",
      description:
        "약 8억 매개변수의 소형 모델입니다. 크기를 줄였을 때 정확도와 시간을 확인합니다.",
      structure:
        "작은 Qwen3.5 본체를 판단용으로 학습 → 답 토큰 점수 → 보정. 작은 크기가 항상 더 빠른 응답을 뜻하지는 않습니다.",
      caution:
        "배포 카드의 지원 언어는 영어입니다. 한국어 문서는 예제에서 작동하더라도 별도 평가가 필요합니다.",
    },
  ].map((p) => ({ ...p, low: 0.25, high: 0.6, ready: false }));
  const defaults = $("criterion").value;
  const exampleNames = {
    contract: "미공개 계약 조건",
    public: "공개 행사 안내",
    guide: "헷갈리는 보안 교육",
    plain: "표시 없는 내부 계획",
  };
  const samples = Object.entries(examples).map(([id, text]) => ({
    name: exampleNames[id],
    text,
    label: ["contract", "plain"].includes(id) ? "confidential" : "public",
  }));
  let imported = [],
    batch = null,
    checking = false,
    stop = false,
    connectionGeneration = 0,
    focusIndex = 0;
  window.compareBusy = false;
  const element = (tag, text, cls) => {
    const e = document.createElement(tag);
    if (text != null) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const base = (p) => $("compare-" + p.provider).value.trim();
  const error = (message) => {
    $("compare-error").hidden = !message;
    $("compare-error").textContent = message || "";
  };
  const fmt = (v) =>
    typeof v === "number" ? v.toFixed(v < 1 ? 3 : 2) + "초" : "미제공";
  const known = (d) =>
    d.label === "confidential"
      ? "기밀"
      : d.label === "public"
        ? "공개"
        : "정답 미지정";
  /**
   * 각 모델의 low/high를 검증한다. 서로 다른 점수 척도에 같은 기준이 항상 적절하지 않아 모델별로 저장한다.
   */
  function thresholdsFor(p) {
    const low = Number($("compare-low-" + p.id).value),
      high = Number($("compare-high-" + p.id).value);
    if (
      !Number.isFinite(low) ||
      !Number.isFinite(high) ||
      $("compare-low-" + p.id).value === "" ||
      $("compare-high-" + p.id).value === "" ||
      low < 0 ||
      high > 1 ||
      low >= high
    )
      throw new Error(
        p.title +
          ": 검토 기준은 0 이상, 차단 기준보다 작아야 하며 차단 기준은 1 이하여야 합니다.",
      );
    return { low, high };
  }
  const outcome = ComparisonMetrics.outcome;
  for (const p of profiles) {
    const card = element("article", null, "model-card");
    card.innerHTML = `<label class="model-card-title"><input type="checkbox" id="select-${p.id}" checked disabled><span><small>${p.type}</small><strong>${p.title}</strong></span></label><p>${p.description}</p><details class="model-explain"><summary>구조와 사용 시 주의점</summary><p>${p.structure}</p><p>${p.caution}</p></details><div class="model-ready" id="ready-${p.id}">확인 전</div><details class="threshold-details"><summary>이 모델의 검토·차단 기준</summary><div class="model-thresholds"><label>사람 검토 시작<input aria-label="${p.title} 검토 기준" id="compare-low-${p.id}" type="number" min="0" max="0.99" step="0.01" value="0.25"></label><label>반출 금지 시작<input aria-label="${p.title} 차단 기준" id="compare-high-${p.id}" type="number" min="0.01" max="1" step="0.01" value="0.60"></label></div><p class="compare-help">검토 기준 미만은 가능 후보, 차단 기준 이상은 반출 금지입니다.</p></details>`;
    $("model-cards").append(card);
    for (const id of ["low", "high"])
      $("compare-" + id + "-" + p.id).addEventListener("input", () => {
        try {
          const t = thresholdsFor(p);
          Object.assign(p, t);
          const active = batch?.models.find((m) => m.id === p.id);
          if (active) Object.assign(active, t);
          error("");
          render();
        } catch (e) {
          error(e.message);
        }
      });
  }
  /**
   * 비교 문서와 사람이 붙인 정답을 펼쳐 볼 수 있게 만든다. 원문은 텍스트로 표시한다.
   */
  function documentDetails(target, docs) {
    target.replaceChildren();
    for (const d of docs) {
      const item = element("details");
      item.append(
        element("summary", d.name + " · " + known(d)),
        element("pre", d.text),
      );
      target.append(item);
    }
  }
  documentDetails($("sample-documents"), samples);
  $("compare-document").value = examples.contract;
  $("compare-criterion").value = defaults;
  /**
   * 이 화면의 비교 실행, 단일 문서 분석, 모델 검색 상태를 함께 확인해 중복 조작을 막는다.
   * 설치가 확인되지 않은 모델은 선택할 수 없고 실행 중에는 현재 요청 뒤 중단만 가능하다.
   */
  function controls() {
    const busy = window.compareBusy || running;
    document
      .querySelectorAll(
        "#page-compare input, #page-compare select, #page-compare textarea, #page-compare button",
      )
      .forEach((e) => (e.disabled = busy || checking));
    for (const p of profiles)
      $("select-" + p.id).disabled = busy || checking || !p.ready;
    $("run-comparison").disabled = busy || checking;
    $("stop-comparison").hidden = !window.compareBusy;
    $("stop-comparison").disabled = stop;
    $("export-comparison").disabled =
      busy || !batch || !Object.keys(batch.results).length;
    if (window.compareBusy) {
      for (const id of [
        "document",
        "criterion",
        "analyze",
        "load-example",
        "example",
        "file-input",
        "open-settings",
        "save-settings",
        "connect",
      ])
        $(id).disabled = true;
    }
  }
  window.refreshComparisonBusy = controls;
  /**
   * 두 실행 도구에서 설치 목록을 독립적으로 조회한다.
   * connectionGeneration은 주소를 바꾼 뒤 이전 조회가 늦게 도착해 새 상태를 덮어쓰는 것을 막는다.
   * 응답의 모델 식별값·양자화 정보를 보관해 비교 조건을 확인할 수 있게 한다.
   */
  async function checkModels() {
    if (window.compareBusy || running || checking) return;
    checking = true;
    controls();
    const generation = ++connectionGeneration;
    const addresses = {
      ollama: $("compare-ollama").value.trim(),
      ollaya: $("compare-ollaya").value.trim(),
    };
    const results = await Promise.allSettled(
      ["ollama", "ollaya"].map((provider) =>
        api("/api/connect", { provider, base_url: addresses[provider] }),
      ),
    );
    if (generation !== connectionGeneration) {
      checking = false;
      controls();
      return;
    }
    let readyCount = 0;
    const messages = [];
    for (const [i, provider] of ["ollama", "ollaya"].entries()) {
      const response = results[i];
      if (response.status === "rejected")
        messages.push(
          (provider === "ollama" ? "Ollama" : "Ollaya") +
            ": " +
            response.reason.message,
        );
      for (const p of profiles.filter((p) => p.provider === provider)) {
        const model =
          response.status === "fulfilled"
            ? response.value.models.find((m) => m.name === p.model)
            : null;
        p.ready = Boolean(model);
        p.checkedBase = addresses[provider];
        p.size = model?.size || 0;
        p.digest = model?.digest || null;
        p.details = model?.details || {};
        $("ready-" + p.id).textContent = p.ready
          ? "준비 완료 · " + (p.size / 1e9).toFixed(1) + " GB"
          : response.status === "fulfilled"
            ? "모델 내려받기 필요"
            : "실행 도구 연결 필요";
        $("ready-" + p.id).title = p.ready
          ? [p.model, p.details.format, p.details.quantization_level]
              .filter(Boolean)
              .join(" · ")
          : "";
        $("ready-" + p.id).classList.toggle("is-ready", p.ready);
        if (p.ready) readyCount++;
      }
    }
    $("model-status").textContent =
      readyCount +
      " / 4개 모델 준비됨. " +
      (messages.join(" ") || "모델별 기본 기준 0.25 / 0.60은 시작용 값입니다.");
    checking = false;
    controls();
  }
  $("refresh-models").addEventListener("click", checkModels);
  for (const provider of ["ollama", "ollaya"])
    $("compare-" + provider).addEventListener("input", () => {
      connectionGeneration++;
      for (const p of profiles.filter((p) => p.provider === provider)) {
        p.ready = false;
        $("ready-" + p.id).textContent = "새 주소 확인 필요";
        $("ready-" + p.id).classList.remove("is-ready");
      }
      controls();
    });
  /**
   * 직접 입력·기본 예제·JSON 데이터셋 중 선택한 입력 영역만 표시한다.
   */
  function sourceUI() {
    const value = $("compare-source").value;
    for (const mode of ["single", "samples", "dataset"])
      $("compare-" + mode).hidden = value !== mode;
    $("copy-document").hidden = value !== "single";
  }
  $("compare-source").addEventListener("change", sourceUI);
  $("copy-document").addEventListener("click", () => {
    $("compare-document").value = $("document").value;
    $("compare-criterion").value = $("criterion").value;
    $("compare-truth").value = "";
    toast("현재 문서와 판단 기준을 가져왔습니다.");
  });
  $("dataset-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    imported = [];
    try {
      if (file.size > 1000000) throw new Error("파일은 1MB 이하여야 합니다.");
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      const docs = JSON.parse(content);
      if (!Array.isArray(docs) || !docs.length || docs.length > 50)
        throw new Error("문서 1~50건의 JSON 배열이 필요합니다.");
      imported = docs.map((d, i) => {
        if (
          !d ||
          typeof d.text !== "string" ||
          !d.text.trim() ||
          d.text.length > 12000 ||
          !["confidential", "public", null, undefined].includes(d.label) ||
          (d.name != null && typeof d.name !== "string")
        )
          throw new Error(
            i + 1 + "번 문서의 text, name, label 형식을 확인해주세요.",
          );
        return {
          name: (d.name || "문서 " + (i + 1)).slice(0, 100),
          text: d.text,
          label: d.label || null,
        };
      });
      $("dataset-status").textContent =
        file.name +
        " · " +
        imported.length +
        "건 · 정답 " +
        imported.filter((d) => d.label).length +
        "건";
      error("");
    } catch (err) {
      imported = [];
      $("dataset-status").textContent = "파일을 읽지 못했습니다.";
      error("평가 문서 읽기: " + err.message);
    } finally {
      e.target.value = "";
    }
  });
  /**
   * 이 기존 비교 화면은 Blob URL로 JSON을 내려받고 잠시 뒤 URL을 해제한다. 자유 평가의 서버 다운로드와는 별개다.
   */
  function download(data, name) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json;charset=utf-8",
      }),
    );
    const a = element("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $("dataset-template").addEventListener("click", () =>
    download(samples, "decision-lab-example-documents.json"),
  );
  /**
   * 선택한 입력 방식에서 문서 목록을 만들고 크기와 공통 기준을 검사한다.
   * 기본 예제의 기준 문장을 바꾸면 원래 정답을 그대로 채점할 수 없으므로 예제 label을 null로 바꾼다.
   */
  function getDocs() {
    const source = $("compare-source").value;
    let docs =
      source === "samples"
        ? samples.map((d) => ({
            ...d,
            label:
              $("compare-criterion").value.trim() === defaults ? d.label : null,
          }))
        : source === "dataset"
          ? imported.map((d) => ({ ...d }))
          : [
              {
                name: "내 문서",
                text: $("compare-document").value,
                label: $("compare-truth").value || null,
              },
            ];
    if (!docs.length) throw new Error("평가 문서 파일을 먼저 선택해주세요.");
    const criterion = $("compare-criterion").value.trim();
    if (!criterion) throw new Error("공통 판단 기준을 입력해주세요.");
    for (const d of docs) {
      if (!d.text.trim()) throw new Error("비교할 문서를 입력해주세요.");
      if (
        d.text.length > 12000 ||
        new TextEncoder().encode(d.text + criterion).length > 24000
      )
        throw new Error(
          d.name + ": 문서가 너무 깁니다. 나누어서 비교해주세요.",
        );
    }
    return docs;
  }
  /**
   * 모델별 요약과 문서×모델 결과표를 다시 그린다. 계산은 ComparisonMetrics에 위임한다.
   * 대기·미실행·오류를 점수 0으로 만들지 않고 각각 구분한다.
   * 모델 간 판단 일치 수는 정확도가 아니므로 별도 안내를 붙인다.
   */
  function render() {
    if (!batch) return;
    renderFocus();
    const summary = $("comparison-summary");
    summary.replaceChildren();
    const agreement = ComparisonMetrics.agreement(batch);
    $("comparison-agreement").textContent = agreement.comparable
      ? `모든 모델이 분석한 ${agreement.comparable}건 중 ${agreement.different}건에서 최종 분류가 달랐습니다. 같은 판단이어도 정답이라는 뜻은 아닙니다.`
      : "모든 모델의 결과가 모이면 판단이 갈린 문서 수를 알려드립니다.";
    for (const p of batch.models) {
      const s = ComparisonMetrics.modelSummary(batch, p);
      const card = element("article", null, "comparison-stat");
      card.append(element("strong", p.title));
      const stats = [
        ["분석 완료", s.completed + " / " + s.total],
        [
          "기밀을 놓침",
          s.secretTotal ? s.missed + " / " + s.secretTotal : "채점할 결과 없음",
        ],
        [
          "공개를 붙잡음",
          s.publicTotal ? s.held + " / " + s.publicTotal : "채점할 결과 없음",
        ],
        [
          "사람 검토",
          s.completed ? s.review + " / " + s.completed : "완료 없음",
        ],
        ["처리 시간 중앙값", fmt(s.inferenceMedian)],
      ];
      for (const [label, value] of stats) {
        const row = element("div");
        row.append(element("span", label), element("b", value));
        card.append(row);
      }
      card.append(
        element(
          "small",
          "오류 " +
            s.errors +
            "건 · " +
            (batch.finished ? "미실행 " : "대기 ") +
            s.missing +
            "건 · 시간 측정 " +
            s.timed +
            "건",
        ),
      );
      summary.append(card);
    }
    const table = element("table", null, "comparison-matrix");
    const head = element("thead");
    const hr = element("tr");
    hr.append(element("th", "같은 문서 / 정답"));
    for (const p of batch.models) {
      const th = element("th", p.title);
      th.append(
        element(
          "small",
          "검토 " + p.low.toFixed(2) + " · 차단 " + p.high.toFixed(2),
        ),
      );
      hr.append(th);
    }
    head.append(hr);
    table.append(head);
    const tbody = element("tbody");
    batch.docs.forEach((d, i) => {
      const row = element("tr");
      const doc = element("th", d.name);
      doc.scope = "row";
      doc.append(element("small", known(d)));
      row.append(doc);
      for (const p of batch.models) {
        const cell = element("td");
        const key = p.id + ":" + i,
          r = batch.results[key];
        if (!r) {
          cell.append(
            element(
              "span",
              batch.active === key
                ? "읽는 중…"
                : batch.finished
                  ? "미실행"
                  : "대기 중",
              "cell-pending",
            ),
          );
        } else if (r.error) {
          cell.append(
            element("strong", "분석 오류", "cell-error"),
            element("p", r.error),
          );
        } else {
          const decision = outcome(r, p);
          cell.append(
            element("strong", r.score.toFixed(3), "cell-score"),
            element("span", names[decision], "decision-badge " + decision),
            element("small", "처리 " + fmt(r.timing?.inference_seconds)),
          );
          const detail = element("details");
          detail.append(element("summary", "시간 · 방식 보기"));
          detail.append(
            element(
              "p",
              "모델 준비 " +
                fmt(r.timing?.load_seconds) +
                " / 전체 요청 " +
                fmt(r.elapsed),
            ),
            element("p", r.resolved_model || r.model),
            element("p", r.note),
          );
          if (r.uncertain)
            detail.append(
              element("p", "응답 형식의 불확실성으로 사람 검토가 우선됩니다."),
            );
          cell.append(detail);
        }
        row.append(cell);
      }
      tbody.append(row);
    });
    table.append(tbody);
    $("comparison-table").replaceChildren(table);
    $("comparison-context").hidden = false;
    $("compare-result-caption").textContent =
      batch.created +
      " 실행 · " +
      batch.docs.length +
      "개 문서 × " +
      batch.models.length +
      "개 모델 · " +
      (batch.finished
        ? batch.stopped
          ? "중단된 결과"
          : "실행 완료"
        : "진행 중") +
      " · 정답이 있는 완료 문서만 아래 분모에 포함됩니다.";
  }
  /**
   * 선택한 같은 문서를 모델 카드로 나란히 보여준다.
   * 점수 막대는 0~1, 시간 막대는 표시된 모델 중 최대 시간에 상대적으로 맞춘다.
   * 점수와 실제 초 단위 값, 각 모델의 기준선을 함께 보여 막대 길이만으로 판단하지 않게 한다.
   */
  function renderFocus() {
    $("comparison-focus").hidden = false;
    const d = batch.docs[focusIndex];
    const container = $("focus-models");
    container.replaceChildren();
    $("focus-truth").textContent = "사람이 붙인 정답: " + known(d);
    $("focus-document").textContent = d.text;
    const times = batch.models
      .map(
        (p) =>
          batch.results[p.id + ":" + focusIndex]?.timing?.inference_seconds,
      )
      .filter((v) => Number.isFinite(v) && v >= 0);
    const maxTime = Math.max(0, ...times);
    for (const p of batch.models) {
      const r = batch.results[p.id + ":" + focusIndex],
        decision = outcome(r, p),
        card = element("article", null, "focus-model");
      const heading = element("div", null, "focus-heading");
      heading.append(element("strong", p.title));
      heading.append(
        element(
          "span",
          decision
            ? names[decision]
            : r
              ? "분석 오류"
              : batch.active === p.id + ":" + focusIndex
                ? "읽는 중…"
                : batch.finished
                  ? "미실행"
                  : "대기 중",
          decision ? "decision-badge " + decision : "cell-pending",
        ),
      );
      card.append(heading);
      if (!decision) {
        card.append(
          element(
            "p",
            r?.error || "아직 비교할 점수가 없습니다.",
            "compare-help",
          ),
        );
        container.append(card);
        continue;
      }
      const label = element("div", null, "focus-score-label");
      label.append(
        element("span", "기밀 판단 점수"),
        element("b", r.score.toFixed(3)),
      );
      card.append(label);
      const track = element("div", null, "focus-score-track");
      track.setAttribute("role", "img");
      track.setAttribute(
        "aria-label",
        `기밀 판단 점수 ${r.score.toFixed(3)}, 검토 기준 ${p.low}, 차단 기준 ${p.high}`,
      );
      const bar = element("span", null, "focus-score-fill " + decision);
      bar.style.width = r.score * 100 + "%";
      track.append(bar);
      for (const [name, value] of [
        ["검토", p.low],
        ["차단", p.high],
      ]) {
        const tick = element("i");
        tick.style.left = value * 100 + "%";
        tick.title = name + " " + value;
        track.append(tick);
      }
      card.append(
        track,
        element(
          "small",
          `0 낮음 → 1 높음 · 검토 ${p.low.toFixed(2)} / 차단 ${p.high.toFixed(2)}`,
          "focus-scale",
        ),
      );
      const reading = r.uncertain
        ? "응답이 불확실해 사람 검토로 남겼습니다."
        : d.label === "confidential"
          ? decision === "candidate"
            ? "기밀을 놓쳤습니다."
            : decision === "review"
              ? "기밀을 검토 대상으로 잡았습니다."
              : "기밀을 차단했습니다."
          : d.label === "public"
            ? decision === "candidate"
              ? "공개 문서를 가능 후보로 분류했습니다."
              : "공개 문서를 불필요하게 붙잡았습니다."
            : "정답을 지정하지 않아 맞았는지는 평가하지 않습니다.";
      card.append(element("p", reading, "focus-reading"));
      const time = r.timing?.inference_seconds;
      card.append(element("div", "모델 처리 " + fmt(time), "focus-time-label"));
      if (Number.isFinite(time) && time >= 0) {
        const speed = element("div", null, "focus-time-track");
        const fill = element("span");
        fill.style.width = (maxTime ? (time / maxTime) * 100 : 0) + "%";
        speed.append(fill);
        card.append(speed);
      }
      const more = element("details", null, "focus-more");
      more.append(
        element("summary", "준비 시간과 전체 요청 보기"),
        element(
          "p",
          `모델 준비 ${fmt(r.timing?.load_seconds)} · 전체 요청 ${fmt(r.elapsed)}`,
        ),
        element("p", r.note),
      );
      card.append(more);
      container.append(card);
    }
  }
  $("focus-document-select").addEventListener("change", (e) => {
    focusIndex = Number(e.target.value);
    renderFocus();
  });
  /**
   * 문서·모델·연결 주소를 확정한 뒤 모델별로 순차 요청한다.
   * rules=false로 규칙 검사 우회를 끄고 모델 자체 응답을 비교한다.
   * 결과 키는 모델ID:문서인덱스. 실패도 해당 키에 기록하고 다른 요청은 계속 진행한다.
   * 중단 후에도 결과를 보존하며 finally에서 다른 화면의 입력 잠금까지 해제한다.
   */
  async function runComparison() {
    if (window.compareBusy || running || checking) return;
    error("");
    let docs, models, criterion;
    try {
      docs = getDocs();
      criterion = $("compare-criterion").value.trim();
      models = profiles
        .filter((p) => $("select-" + p.id).checked && p.ready)
        .map((p) => ({ ...p, ...thresholdsFor(p), base_url: base(p) }));
      if (models.length < 2)
        throw new Error("준비된 모델을 2개 이상 선택해주세요.");
      if (models.some((p) => p.checkedBase !== p.base_url))
        throw new Error("변경한 연결 주소를 먼저 확인해주세요.");
    } catch (e) {
      error(e.message);
      return;
    }
    window.compareBusy = true;
    stop = false;
    controls();
    batch = {
      created: new Date().toLocaleString("ko-KR"),
      criterion,
      docs,
      models,
      results: {},
      finished: false,
      stopped: false,
      active: null,
    };
    focusIndex = 0;
    $("focus-document-select").replaceChildren(
      ...docs.map((d, i) => {
        const o = element("option", d.name);
        o.value = i;
        return o;
      }),
    );
    $("focus-document-select").disabled = false;
    $("comparison-question").textContent = criterion;
    documentDetails($("comparison-documents"), docs);
    let completed = 0;
    const total = docs.length * models.length;
    render();
    try {
      for (const p of models) {
        for (let i = 0; i < docs.length; i++) {
          if (stop) break;
          const key = p.id + ":" + i;
          batch.active = key;
          $("compare-progress").textContent =
            p.title +
            " · " +
            docs[i].name +
            " 분석 중 (" +
            completed +
            " / " +
            total +
            ")";
          render();
          try {
            batch.results[key] = await api("/api/analyze", {
              provider: p.provider,
              base_url: p.base_url,
              model: p.model,
              method: p.method,
              text: docs[i].text,
              criterion,
              low: p.low,
              high: p.high,
              calibration: 1,
              rules: false,
            });
          } catch (e) {
            batch.results[key] = { error: e.message };
          }
          completed++;
          batch.active = null;
          render();
        }
        if (stop) break;
      }
    } finally {
      batch.active = null;
      batch.finished = true;
      batch.stopped = stop && completed < total;
      window.compareBusy = false;
      for (const id of [
        "document",
        "criterion",
        "analyze",
        "load-example",
        "example",
        "file-input",
        "open-settings",
        "save-settings",
        "connect",
      ])
        $(id).disabled = false;
      controls();
      render();
      $("compare-progress").textContent =
        (batch.stopped ? "중단했습니다. " : "비교를 마쳤습니다. ") +
        completed +
        " / " +
        total +
        "건 요청 완료. 오류는 결과표에서 확인하세요.";
    }
  }
  $("run-comparison").addEventListener("click", runComparison);
  $("stop-comparison").addEventListener("click", () => {
    stop = true;
    $("stop-comparison").disabled = true;
    $("compare-progress").textContent =
      "현재 요청이 끝나면 멈춥니다. 완료된 결과는 유지합니다.";
  });
  /**
   * 문서 text를 제외한 비교 기록을 저장한다. 현재 임계값으로 업무 행동을 다시 계산해 담는다.
   * 문서 이름·판단 기준·모델 응답은 포함되므로 파일 전체가 익명화된 것은 아니다.
   */
  $("export-comparison").addEventListener("click", () => {
    if (!batch) return;
    download(
      {
        format: "decision-lab-comparison-v1",
        created: batch.created,
        criterion: batch.criterion,
        note: "문서 원문 제외. 현재 기준값으로 분류. 모델 간 점수는 같은 확률 척도가 아니며 작은 표본은 성능 보장이 아닙니다.",
        finished: batch.finished,
        stopped: batch.stopped,
        models: batch.models.map(
          ({
            id,
            title,
            model,
            provider,
            method,
            base_url,
            low,
            high,
            size,
            digest,
            details,
          }) => ({
            id,
            title,
            model,
            provider,
            method,
            base_url,
            low,
            high,
            size,
            digest,
            details,
          }),
        ),
        documents: batch.docs.map(({ name, label }) => ({ name, label })),
        results: batch.models.flatMap((p) =>
          batch.docs.map((d, i) => {
            const r = batch.results[p.id + ":" + i];
            return {
              model_id: p.id,
              document_index: i,
              status: !r ? "not_run" : r.error ? "error" : "complete",
              ...r,
              ...(r && !r.error ? { decision: outcome(r, p) } : {}),
            };
          }),
        ),
      },
      "decision-lab-comparison.json",
    );
  });
  checkModels();
})();
