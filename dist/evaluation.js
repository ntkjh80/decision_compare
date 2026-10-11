"use strict";
/**
 * 자유 성능평가 페이지의 화면 제어기. evaluation.html의 id와 연결된다.
 * 읽는 순서: experiment(입력 확정) → run(순차 실행) → requestOne(API 한 건)
 * → renderResults(모델별 집계) → drawCharts/renderInspect(비교 화면).
 * 지표 공식은 EvaluationMetrics, 모델별 API 차이는 서버 evaluation.py가 담당한다.
 * 즉시 실행 함수로 감싸 변수를 이 페이지 안에만 두며 문서·결과는 메모리에 보관한다.
 * 실험 파일 저장은 원문을 포함하고 결과 저장은 원문을 제외한다. 아래 내보내기 주석을 참고한다.
 */
(() => {
  const $ = (id) => document.getElementById(id),
    M = EvaluationMetrics;
  const colors = [
    "#277e72",
    "#6373b5",
    "#be743e",
    "#ad5180",
    "#738b37",
    "#447fbb",
    "#80684a",
    "#9669af",
  ];
  /**
   * 입력 문서·모델 이름·오류 문구를 HTML로 해석하지 않고 textContent로 표시한다.
   * 문서에 태그가 들어 있어도 화면 코드로 실행하지 않기 위한 공통 DOM 생성 함수다.
   */
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const pct = (x) => (M.num(x) ? (x * 100).toFixed(1) + "%" : "—"),
    dec = (x) => (M.num(x) ? x.toFixed(3) : "—"),
    sec = (x) => (M.num(x) ? x.toFixed(3) + "초" : "—");
  /**
   * 연습용 질문·선택지·정답. 실제 모델 성능을 대표하는 검증 데이터는 아니다.
   * Score 배열의 순서는 점수 순서이며 첫 설명이 0점이다.
   * 예제 정답(expected)은 브라우저 채점용으로만 사용하고 모델 요청에는 포함하지 않는다.
   */
  const presets = {
    choice: {
      question: "이 문의를 처리할 담당 부서를 선택하세요.",
      criteria:
        "billing = 결제, 청구, 환불\ntechnical = 오류, 장애, 기능 문제\naccount = 계정, 로그인, 회원 정보",
      rows: [
        [
          "중복 결제",
          "구독료가 두 번 결제됐습니다. 한 번은 환불해주세요.",
          "billing",
        ],
        [
          "로그인",
          "비밀번호를 잊었습니다. 계정을 복구하고 싶습니다.",
          "account",
        ],
        ["앱 오류", "파일을 업로드하면 앱이 강제 종료됩니다.", "technical"],
        ["영수증", "지난달 결제 영수증을 보내주세요.", "billing"],
        ["회원 정보", "계정의 이메일 주소를 변경하고 싶어요.", "account"],
        [
          "화면 장애",
          "설정 화면의 버튼이 눌리지 않고 멈춰 있습니다.",
          "technical",
        ],
      ],
    },
    score: {
      question:
        "이 문의는 얼마나 긴급한가요? 고객의 표현보다 실제 영향 범위를 기준으로 판단하세요.",
      criteria:
        "일반 · 일정에 맞춰 처리해도 됨\n주의 · 일부 사용에 지장, 오늘 확인 필요\n긴급 · 전체 서비스 중단 또는 즉시 큰 피해",
      rows: [
        [
          "전체 장애",
          "전체 고객이 서비스에 접속할 수 없습니다. 현재 모든 거래가 중단됐습니다.",
          2,
        ],
        [
          "단순 제안",
          "다음 업데이트에 배경색 선택 기능을 추가해 주세요. 급하지는 않습니다.",
          0,
        ],
        [
          "일부 오류",
          "제 계정에서만 보고서 저장이 안 됩니다. 다른 기능은 쓸 수 있지만 오늘 확인이 필요합니다.",
          1,
        ],
        ["사용법", "언제든 괜찮으니 알림 설정 방법을 알려주세요.", 0],
        [
          "결제 중단",
          "모든 고객의 결제가 실패하고 있습니다. 영업이 전면 중단됐습니다.",
          2,
        ],
        [
          "단일 기능",
          "일부 고객의 이미지 업로드가 실패합니다. 다른 업무는 가능하며 오늘 안에 확인 바랍니다.",
          1,
        ],
      ],
    },
    noul: {
      question: "고객이 이미 결제한 돈의 환불을 요청한다.",
      criteria:
        "true = 이미 낸 돈을 돌려달라고 요청함\nfalse = 환불 요청이 아님",
      rows: [
        ["중복 환불", "중복 결제된 금액을 돌려주세요.", true],
        ["로그인 문의", "비밀번호를 재설정하고 싶습니다.", false],
        ["반품 환불", "반품했으니 결제 금액을 환불해주세요.", true],
        [
          "정책 확인",
          "구매 전에 환불 정책이 궁금합니다. 아직 결제하지 않았습니다.",
          false,
        ],
        [
          "해지 환불",
          "구독을 취소했고 이번 달 요금도 돌려받고 싶습니다.",
          true,
        ],
        ["영수증 요청", "환불은 필요 없고 결제 영수증만 보내주세요.", false],
      ],
    },
  };
  /**
   * 상태 구분: drafts=카테고리별 편집 중 입력, models=선택 가능한 모델,
   * batch=최근 실행 당시 조건과 누적 응답, summaries=현재 기준으로 다시 계산한 요약.
   * busy는 평가 중, checking은 모델 검색 중, stopping은 현재 요청 뒤 멈추라는 표시다.
   * 편집 상태와 실행 기록을 분리해 실행 후 입력을 바꾸더라도 과거 결과의 조건이 섞이지 않게 한다.
   */
  let category = "choice",
    drafts = {},
    models = [],
    batch = null,
    busy = false,
    stopping = false,
    checking = false,
    idCounter = 0,
    summaries = [];
  const sampleRows = (k) =>
    presets[k].rows.map(([name, text, expected]) => ({ name, text, expected }));
  for (const k of Object.keys(presets))
    drafts[k] = {
      question: presets[k].question,
      criteria: presets[k].criteria,
      rows: sampleRows(k),
    };
  /**
   * 오류 영역의 표시 여부와 텍스트를 함께 갱신한다. 빈 문자열이면 이전 오류를 지운다.
   */
  function error(message) {
    $("eval-error").hidden = !message;
    $("eval-error").textContent = message || "";
  }
  /**
   * 선택지 입력란을 서버가 받을 구조로 변환한다.
   * Choice/Noul은 첫 = 앞을 ID, 뒤를 설명으로 해석한다. ID는 정답과 이어지는 키이므로 중복 불가.
   * Score는 입력한 줄 순서를 낮은 점수부터 단계 배열로 사용한다.
   * 브라우저 검증은 빠른 피드백용이고 서버에서도 동일한 종류의 입력 검증을 다시 한다.
   */
  function criteria() {
    const lines = $("eval-criteria")
      .value.split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (category === "score") {
      if (lines.length < 2 || lines.length > 10)
        throw Error("Score 단계는 2~10개로 작성하세요.");
      return lines;
    }
    const pairs = lines.map((s) => {
      const pos = s.indexOf("=");
      if (pos < 1) throw Error("선택지는 ID = 설명 형식으로 작성하세요.");
      return [s.slice(0, pos).trim(), s.slice(pos + 1).trim()];
    });
    if (
      pairs.some(
        ([k, v]) =>
          !k || !v || v.length > 500 || !/^[\p{L}\p{N}_-]{1,60}$/u.test(k),
      ) ||
      new Set(pairs.map((p) => p[0])).size !== pairs.length
    )
      throw Error(
        "선택지 ID는 중복 없이 문자·숫자·밑줄·하이픈으로, 설명은 1~500자로 작성하세요.",
      );
    const c = Object.fromEntries(pairs);
    if (
      category === "noul" &&
      (pairs.length !== 2 ||
        !Object.hasOwn(c, "true") ||
        !Object.hasOwn(c, "false"))
    )
      throw Error("Noul은 true와 false 설명을 모두 작성하세요.");
    if (category === "choice" && (pairs.length < 2 || pairs.length > 10))
      throw Error("Choice 선택지는 2~10개여야 합니다.");
    return c;
  }
  /**
   * 편집 도중 형식이 아직 완성되지 않았을 수 있다. 그때는 빈 후보 목록으로 화면을 그린다.
   */
  function keys() {
    try {
      return M.labels({ category, criteria: criteria() });
    } catch {
      return [];
    }
  }
  /**
   * 현재 질문·선택지 텍스트를 카테고리별 초안에 저장한다. 다른 카테고리로 이동할 때 편집 내용을 보존한다.
   */
  function syncDraft() {
    drafts[category].question = $("eval-question").value;
    drafts[category].criteria = $("eval-criteria").value;
  }
  /**
   * 선택한 카테고리의 초안을 화면에 반영하고 설명·정답 입력 방식도 바꾼다.
   * aria-pressed는 보조기술에서도 어떤 카테고리가 선택됐는지 알 수 있게 한다.
   */
  function applyCategory(k) {
    category = k;
    const d = drafts[k];
    $("eval-question").value = d.question;
    $("eval-criteria").value = d.criteria;
    document.querySelectorAll("[data-category]").forEach((b) => {
      b.classList.toggle("active", b.dataset.category === k);
      b.setAttribute("aria-pressed", String(b.dataset.category === k));
    });
    $("category-help").textContent = {
      choice:
        "이름 있는 선택지 중 하나를 고릅니다. 분류 정확도와 선택 확률을 함께 비교합니다.",
      score:
        "낮은 단계부터 설명을 적습니다. 첫 단계는 0점이며 출력은 확률로 가중한 기대 점수라 소수가 될 수 있습니다.",
      noul: "하나의 명제가 참일 확률을 구합니다. 판정 기준은 결과 화면에서 0~1 사이로 바꿀 수 있습니다.",
    }[k];
    $("criteria-title").textContent =
      k === "score"
        ? "단계 설명 · 낮은 단계부터 한 줄에 하나"
        : "선택지 · ID = 의미, 한 줄에 하나";
    $("criteria-help").textContent =
      k === "score"
        ? "예: 일반 / 주의 / 긴급을 각각 한 줄에 작성 → 0·1·2 단계"
        : "ID는 정답과 연결되는 이름입니다. 설명은 모델이 읽는 판단 기준입니다.";
    renderDataset();
    error("");
  }
  /**
   * 파일 업로드와 실행 시작이 함께 쓰는 문서·정답 검사. 정리한 새 문서 배열을 반환한다.
   * 정답 null은 미지정이며 실패나 오답을 의미하지 않는다. Score 소수 정답도 허용한다.
   * 문자 수와 UTF-8 바이트 수를 둘 다 검사한다. 한글은 글자 수보다 바이트 수가 크기 때문이다.
   * 검증을 통과한 뒤에만 초안/실험에 반영하여 잘못된 파일로 기존 입력을 덮어쓰지 않는다.
   */
  function validateRows(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 100)
      throw Error("입력은 1~100건이어야 합니다.");
    return rows.map((r, i) => {
      if (
        !r ||
        typeof r.text !== "string" ||
        !r.text.trim() ||
        r.text.length > 12000
      )
        throw Error(i + 1 + "번 입력은 1~12,000자여야 합니다.");
      const expected = r.expected ?? null,
        c = criteria(),
        config = { category, criteria: c };
      if (expected !== null) {
        if (category === "score") {
          if (!M.num(expected) || expected < 0 || expected > c.length - 1)
            throw Error(i + 1 + "번 정답 점수가 단계 범위를 벗어났습니다.");
        } else if (M.truth(expected, config) === null)
          throw Error(i + 1 + "번 정답을 현재 선택지에 맞게 지정하세요.");
      }
      if (
        new TextEncoder().encode(
          r.text + $("eval-question").value + JSON.stringify(c),
        ).length > 24000
      )
        throw Error(i + 1 + "번 입력·질문·선택지 합계가 24KB를 넘습니다.");
      return {
        name:
          typeof r.name === "string" && r.name.trim()
            ? r.name.slice(0, 100)
            : "입력 " + (i + 1),
        text: r.text,
        expected,
      };
    });
  }
  /**
   * 현재 카테고리의 문서 편집 행을 만든다. 이벤트는 해당 행 객체 r를 직접 갱신한다.
   * Choice/Noul 정답은 선택 상자, Score는 소수도 가능한 숫자 입력을 사용한다.
   * 선택지를 바꿔 기존 정답이 없어졌을 때 임의 답으로 바꾸지 않고 "다시 지정"으로 남긴다.
   */
  function renderDataset() {
    const wrap = $("dataset-editor");
    wrap.replaceChildren();
    const labels = keys();
    drafts[category].rows.forEach((r, i) => {
      const row = el("div", null, "dataset-row"),
        content = el("div", null, "dataset-content");
      row.append(el("span", String(i + 1).padStart(2, "0"), "row-number"));
      const name = el("input");
      name.value = r.name;
      name.maxLength = 100;
      name.setAttribute("aria-label", i + 1 + "번 입력 이름");
      name.oninput = () => (r.name = name.value);
      const text = el("textarea");
      text.rows = 2;
      text.value = r.text;
      text.maxLength = 12000;
      text.setAttribute("aria-label", i + 1 + "번 평가 입력");
      text.oninput = () => (r.text = text.value);
      content.append(name, text);
      row.append(content);
      const label = el("label", "내가 확인한 정답");
      let answer;
      if (category === "score") {
        answer = el("input");
        answer.type = "number";
        answer.min = 0;
        answer.max = Math.max(0, labels.length - 1);
        answer.step = "any";
        answer.placeholder = "모르면 비워두기";
        answer.value = r.expected ?? "";
        answer.oninput = () =>
          (r.expected = answer.value === "" ? null : Number(answer.value));
      } else {
        answer = el("select");
        answer.append(new Option("정답 미지정", ""));
        labels.forEach((k) =>
          answer.append(
            new Option(
              category === "noul"
                ? k === "true"
                  ? "참 · true"
                  : "거짓 · false"
                : k,
              k,
            ),
          ),
        );
        if (r.expected != null && !labels.includes(String(r.expected))) {
          answer.append(
            new Option("다시 지정: " + String(r.expected), String(r.expected)),
          );
        }
        answer.value = r.expected == null ? "" : String(r.expected);
        answer.onchange = () =>
          (r.expected =
            answer.value === ""
              ? null
              : category === "noul"
                ? answer.value === "true"
                : answer.value);
      }
      answer.setAttribute("aria-label", i + 1 + "번 정답");
      label.append(answer);
      row.append(label);
      const remove = el("button", "×", "remove-row");
      remove.setAttribute("aria-label", i + 1 + "번 입력 삭제");
      remove.onclick = () => {
        drafts[category].rows.splice(i, 1);
        renderDataset();
      };
      row.append(remove);
      wrap.append(row);
    });
  }
  /**
   * 앱 서버에 JSON POST를 보내는 공통 함수. 모델 서버로 직접 요청하지 않는다.
   * AbortController는 브라우저의 기다림을 제한한다. 이미 시작한 모델 추론의 강제 종료를 뜻하지 않는다.
   * 성공/실패 모두 finally에서 타이머를 지워 뒤늦은 중단 이벤트가 남지 않게 한다.
   */
  async function api(path, body, timeout = 150000) {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), timeout);
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Decision-Lab": "1" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || "요청 실패");
      return d;
    } finally {
      clearTimeout(timer);
    }
  }
  const friendly = (name) =>
    ({
      "qwen3.5:4b": "Qwen3.5 · 4B",
      "jevk5:latest": "JevK5 · 4B",
      "laya:multilingual": "Laya · 다국어",
      "decider:0.8b": "decider · 0.8B",
    })[name] || name;
  /**
   * 실행 도구+주소+모델명이 같은 항목은 중복 추가하지 않는다.
   * 표시 이름(title)과 실제 API 모델명(model)을 나누어 읽기 쉬운 제목과 정확한 호출을 함께 유지한다.
   * 추가만으로 모델을 내려받거나 추론하지 않는다.
   */
  function addModel(m) {
    if (
      models.some(
        (x) =>
          x.provider === m.provider &&
          x.base_url === m.base_url &&
          x.model === m.model,
      )
    )
      return;
    models.push({
      id: "m" + ++idCounter,
      title: friendly(m.model),
      mode: m.provider === "ollaya" ? "native" : "tokens",
      selected: true,
      ...m,
    });
  }
  /**
   * 모델마다 선택 여부와 응답 방식을 표시한다.
   * Ollaya는 전용 native, 일반 서버는 토큰 확률 또는 자체 생성 JSON을 선택한다.
   * 서로 다른 방식의 확률을 같은 의미로 오해하지 않도록 카드에 설명을 붙인다.
   */
  function renderModels() {
    const wrap = $("eval-models");
    wrap.replaceChildren();
    for (const m of models) {
      const card = el("article", null, "eval-model-card"),
        label = el("label", null, "model-select"),
        check = el("input");
      check.type = "checkbox";
      check.checked = m.selected;
      check.onchange = () => (m.selected = check.checked);
      label.append(check, el("span", m.title));
      card.append(
        label,
        el(
          "p",
          m.provider +
            " · " +
            m.model +
            "\n" +
            m.base_url +
            (m.size ? " · " + (m.size / 1e9).toFixed(1) + " GB" : ""),
          "model-meta",
        ),
      );
      const modeLabel = el("label", "결과를 받는 방식");
      const select = el("select");
      if (m.provider === "ollaya")
        select.append(new Option("전용 Choice·Score·Noul", "native"));
      else {
        select.append(
          new Option("답 토큰의 확률", "tokens"),
          new Option("JSON으로 확률 생성", "json"),
        );
      }
      select.value = m.mode;
      select.onchange = () => (m.mode = select.value);
      modeLabel.append(select);
      card.append(modeLabel);
      if (m.provider !== "ollaya")
        card.append(
          el(
            "small",
            "JSON의 확률은 자체 평가입니다. 토큰 방식은 모든 후보 확률이 필요합니다.",
          ),
        );
      wrap.append(card);
    }
    if (!models.length)
      wrap.append(el("p", "모델을 찾거나 직접 추가해주세요.", "help"));
  }
  /**
   * 실행/검색 중 질문·문서·실행 조건 변경을 막아 동일 실험 안에 다른 조건이 섞이지 않게 한다.
   * 결과의 재집계 설정은 추론 조건이 아니므로 계속 바꿀 수 있다. 중단 버튼도 별도로 관리한다.
   */
  function lock() {
    document
      .querySelectorAll(
        "#experiment input,#experiment textarea,#experiment select,#experiment button,[data-category],#discover-models,#eval-models input,#eval-models select,.connection-grid input,.custom-model-grid input,.custom-model-grid select,.custom-model-grid button,#eval-repeats,#eval-warmup,#eval-order,#eval-seed,#eval-timeout,#eval-context,#eval-temperature,#eval-run",
      )
      .forEach((e) => (e.disabled = busy || checking));
    $("eval-stop").hidden = !busy;
    $("eval-stop").disabled = stopping;
  }
  /**
   * Ollama와 Ollaya의 목록 조회는 서로 독립적이므로 함께 요청한다.
   * Promise.allSettled로 한쪽 연결이 실패해도 다른 쪽 모델 목록을 사용할 수 있게 한다.
   * 가중치 digest·크기·실행기 버전을 보관해 결과가 어떤 모델에서 나왔는지 추적한다.
   */
  async function discover() {
    if (busy || checking) return;
    checking = true;
    lock();
    $("model-message").textContent = "로컬 모델 목록을 확인합니다…";
    const reports = await Promise.allSettled(
      ["ollama", "ollaya"].map((provider) =>
        api(
          "/api/connect",
          { provider, base_url: $("eval-" + provider).value.trim() },
          15000,
        ),
      ),
    );
    let messages = [];
    reports.forEach((r, i) => {
      const provider = ["ollama", "ollaya"][i],
        base_url = $("eval-" + provider).value.trim();
      if (r.status === "fulfilled") {
        for (const m of r.value.models)
          addModel({
            provider,
            base_url,
            model: m.name,
            size: m.size,
            digest: m.digest,
            details: m.details,
            runtime_version: r.value.version,
          });
        messages.push(provider + " " + r.value.models.length + "개");
      } else messages.push(provider + ": " + r.reason.message);
    });
    $("model-message").textContent = messages.join(" · ");
    checking = false;
    renderModels();
    lock();
  }
  /**
   * 숫자 입력의 빈 값·범위·정수 조건을 검사한다.
   * Number("")가 0이 되는 JavaScript 변환 때문에 빈 문자열을 별도로 거절한다.
   */
  function setting(id, min, max, integer = false) {
    const raw = $(id).value,
      n = Number(raw);
    if (
      raw === "" ||
      !Number.isFinite(n) ||
      n < min ||
      n > max ||
      (integer && !Number.isInteger(n))
    )
      throw Error(
        $(id).closest("label").firstChild.textContent.trim() +
          ": " +
          min +
          "~" +
          max +
          " 범위를 확인하세요.",
      );
    return n;
  }
  /**
   * 추론 전 고정할 실행 설정을 수집한다.
   * temperature는 토큰 확률의 사후 보정 온도다. 실제 생성 요청은 서버에서 결정적으로 설정한다.
   * warmup은 모델별 준비 실행 횟수(0/1)이고 repeats는 본 평가의 반복 횟수다.
   */
  function settings() {
    return {
      repeats: setting("eval-repeats", 1, 10, true),
      warmup: Number($("eval-warmup").value),
      order: $("eval-order").value,
      seed: setting("eval-seed", 0, 2147483647, true),
      timeout: setting("eval-timeout", 10, 300, true),
      context: setting("eval-context", 2048, 32768, true),
      temperature: setting("eval-temperature", 0.1, 5),
    };
  }
  /**
   * 실행에 사용할 조건을 한 번 모아 스냅샷으로 만든다.
   * 선택한 모델 객체와 검증한 문서 객체를 복사해 편집 중 상태와 실행 기록을 분리한다.
   * 추론 요청에는 이 스냅샷을 쓰고, 이후 결과 재집계에서도 batch.config를 기준으로 한다.
   */
  function experiment() {
    syncDraft();
    const question = $("eval-question").value.trim();
    if (!question || question.length > 2000)
      throw Error("질문을 1~2,000자로 작성하세요.");
    return {
      category,
      question,
      criteria: criteria(),
      documents: validateRows(drafts[category].rows),
      settings: settings(),
      models: models.filter((m) => m.selected).map((m) => ({ ...m })),
    };
  }
  /**
   * 고정 시드 난수와 Fisher–Yates로 문서 인덱스 순서를 섞는다.
   * 같은 시드·문서 수면 같은 순서이며, run에서 한 번 만든 순서를 모든 모델과 반복에 공유한다.
   * >>> 0은 32비트 부호 없는 정수로 맞추는 연산이다. 이 난수는 보안용이 아니다.
   */
  function orderFor(n, config) {
    const a = Array.from({ length: n }, (_, i) => i);
    if (config.order === "shuffle") {
      let seed = config.seed >>> 0;
      const random = () => {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
        return seed / 4294967296;
      };
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
    }
    return a;
  }
  /**
   * 문서 하나를 모델 하나에 평가시키고 {result, elapsed}를 반환한다.
   * performance.now로 브라우저 요청 직전부터 응답 처리까지의 종단간 시간을 잰다.
   * 서버의 제한 시간에 20초 여유를 더해 서버 오류 응답을 받을 기회를 둔다.
   * 네트워크 실패도 시간과 원인을 가진 결과로 남겨 실패율·지연 집계에서 사라지지 않게 한다.
   */
  async function requestOne(model, doc, config) {
    const started = performance.now();
    let result;
    try {
      result = await api(
        "/api/evaluate",
        {
          provider: model.provider,
          base_url: model.base_url,
          model: model.model,
          mode: model.mode,
          category: config.category,
          question: config.question,
          criteria: config.criteria,
          text: doc.text,
          settings: config.settings,
        },
        (config.settings.timeout + 20) * 1000,
      );
    } catch (e) {
      result = {
        status: "error",
        error_kind: "transport",
        error:
          e.name === "AbortError"
            ? "브라우저 요청 시간이 초과됐습니다."
            : e.message,
        schema_valid: null,
        response_received: false,
      };
    }
    return { result, elapsed: (performance.now() - started) / 1000 };
  }
  /**
   * 실험 전체를 수행한다. 모델 → 반복 → 동일 문서 순으로 await하며 한 건씩 실행한다.
   * 모델별로 묶어 실행하므로 매 요청마다 큰 모델을 바꿔 적재하는 비용을 줄인다.
   * 중단은 현재 요청이 끝난 뒤 다음 요청을 시작하지 않는 방식이다. 완료된 결과는 보존한다.
   * 새 run은 batch를 교체하므로 이전 결과가 필요하면 먼저 내보내야 한다.
   */
  async function run() {
    if (busy) return;
    let config;
    try {
      config = experiment();
      if (!config.models.length) throw Error("모델을 하나 이상 선택하세요.");
      if (
        config.documents.length *
          config.models.length *
          config.settings.repeats >
        1000
      )
        throw Error(
          "총 요청은 1,000회까지입니다. 입력·모델·반복 횟수를 줄이세요.",
        );
    } catch (e) {
      error(e.message);
      return;
    }
    error("");
    busy = true;
    stopping = false;
    batch = {
      format: "decision-lab-evaluation-v1",
      created: new Date().toISOString(),
      config,
      rows: [],
      warmups: [],
      finished: false,
      stopped: false,
      order: orderFor(config.documents.length, config.settings),
    };
    lock();
    initResults();
    renderResults();
    const total =
      config.documents.length * config.models.length * config.settings.repeats;
    $("eval-progress-bar").max = total;
    $("eval-progress-bar").value = 0;
    try {
      for (const model of config.models) {
        if (stopping) break;
        if (config.settings.warmup) {
          $("eval-progress").textContent =
            model.title + " · 준비 실행 중 (집계 제외)";
          const r = await requestOne(
            model,
            config.documents[batch.order[0]],
            config,
          );
          /**
           * 준비 실행은 별도 배열에만 보관한다. 실패했더라도 기록하되 정확도·지연의 분모에는 넣지 않는다.
           * 여기서 rows에 함께 넣으면 준비 실행 제외라는 사용자 설정과 실제 통계가 달라진다.
           */
          batch.warmups.push({ modelId: model.id, ...r });
          if (stopping) break;
        }
        for (let repeat = 0; repeat < config.settings.repeats; repeat++) {
          for (const index of batch.order) {
            if (stopping) break;
            const doc = config.documents[index];
            $("eval-progress").textContent =
              model.title +
              " · " +
              doc.name +
              " · 반복 " +
              (repeat + 1) +
              " / " +
              config.settings.repeats +
              " · 완료 " +
              batch.rows.length +
              " / " +
              total;
            const response = await requestOne(model, doc, config);
            batch.rows.push({
              modelId: model.id,
              document: index,
              repeat: repeat + 1,
              expected: doc.expected,
              ...response,
            });
            $("eval-progress-bar").value = batch.rows.length;
            renderResults();
          }
          if (stopping) break;
        }
      }
      batch.finished = batch.rows.length === total;
      batch.stopped = !batch.finished;
    } catch (e) {
      error(e.message);
      batch.stopped = true;
    } finally {
      busy = false;
      lock();
      renderResults();
      $("eval-progress").textContent =
        (batch.finished ? "평가 완료" : "현재 요청까지 마침") +
        " · " +
        batch.rows.length +
        " / " +
        total +
        "건. 새로고침 전에 결과를 저장하세요.";
    }
  }
  /**
   * 모델 호출 없이 변경 가능한 채점 설정: Noul 판정 기준, 검토 확신도 기준,
   * ECE 구간 수, Confidence 출처, ROC의 양성 클래스.
   */
  function metricOptions() {
    return {
      threshold: setting("metric-threshold", 0, 1),
      referral: setting("metric-referral", 0, 1),
      bins: Number($("metric-bins").value),
      basis: $("metric-basis").value,
      positive: $("metric-positive").value,
    };
  }
  /**
   * 실행 당시 카테고리와 선택지로 결과 제어기를 구성한다. 문서×반복별로 나란히 비교할 항목도 만든다.
   */
  function initResults() {
    $("result-controls").hidden = false;
    $("metric-threshold").disabled = batch.config.category !== "noul";
    const select = $("metric-positive");
    select.replaceChildren();
    for (const k of M.labels(batch.config)) select.append(new Option(k, k));
    select.value =
      batch.config.category === "noul" ? "true" : select.options[0].value;
    const doc = $("inspect-document");
    doc.replaceChildren();
    batch.config.documents.forEach((d, i) => {
      for (let r = 1; r <= batch.config.settings.repeats; r++)
        doc.append(new Option(d.name + " · 반복 " + r, i + ":" + r));
    });
  }
  /**
   * 텍스트만 넣는 공통 표 생성기. 표 머리글과 데이터 행을 구분하고 임의 HTML을 삽입하지 않는다.
   */
  function table(headers, rows) {
    const t = el("table"),
      head = el("thead"),
      tr = el("tr");
    headers.forEach((h) => tr.append(el("th", h)));
    head.append(tr);
    t.append(head);
    const body = el("tbody");
    for (const values of rows) {
      const row = el("tr");
      values.forEach((v) => row.append(el("td", String(v))));
      body.append(row);
    }
    t.append(body);
    return t;
  }
  /**
   * 열이 많은 지표·혼동행렬 표를 가로 스크롤 영역으로 감싸 좁은 화면에서도 읽게 한다.
   */
  function scrollTable(t) {
    const w = el("div", null, "table-scroll");
    w.append(t);
    return w;
  }
  /**
   * 저장한 응답을 modelId별로 나눈 뒤 계산 전용 summarize를 호출한다.
   * 총 요청·성공·채점 표본 수를 함께 보여 지표마다 어떤 분모를 쓰는지 확인할 수 있게 한다.
   * Score 카드는 MAE, Choice/Noul 카드는 Accuracy를 주 지표로 표시한다.
   * 표·그래프·개별 문서·오류 상세가 모두 같은 summaries와 metricOptions를 사용한다.
   */
  function renderResults() {
    if (!batch) return;
    let opts;
    try {
      opts = metricOptions();
      error("");
    } catch (e) {
      error(e.message);
      return;
    }
    const config = batch.config;
    summaries = config.models.map((m) => ({
      ...m,
      metrics: M.summarize(
        config,
        batch.rows.filter((r) => r.modelId === m.id),
        opts,
      ),
    }));
    $("export-results").disabled = busy || !batch.rows.length;
    $("export-csv").disabled = busy || !batch.rows.length;
    $("run-snapshot").textContent =
      config.category.toUpperCase() +
      " · " +
      config.question +
      " · 입력 " +
      config.documents.length +
      "건 × " +
      config.models.length +
      "개 모델 × " +
      config.settings.repeats +
      "회 · " +
      new Date(batch.created).toLocaleString("ko-KR") +
      " · " +
      (config.settings.warmup ? "준비 실행 제외" : "첫 로딩 포함") +
      " · " +
      (batch.finished ? "완료" : batch.stopped ? "중단" : "진행 중");
    const n = batch.rows.length,
      success = summaries.reduce((s, m) => s + m.metrics.success, 0);
    $("eval-summary").replaceChildren();
    for (const [label, value, help] of [
      [
        "완료한 요청",
        n +
          " / " +
          config.documents.length *
            config.models.length *
            config.settings.repeats,
        "실행된 요청만 집계합니다.",
      ],
      [
        "유효한 응답",
        success + "건",
        "실패 " + (n - success) + "건 · 실패는 상세 기록 확인",
      ],
      [
        "서로 다른 평가 입력",
        config.documents.length + "건",
        config.documents.length < 20
          ? "체험 규모입니다. 성능 순위로 일반화하지 마세요."
          : "반복 횟수를 늘려도 고유 입력 수는 늘지 않습니다.",
      ],
    ]) {
      const tile = el("article", label, "summary-tile");
      tile.append(el("strong", value), el("small", help));
      $("eval-summary").append(tile);
    }
    $("model-scorecards").replaceChildren();
    for (const [i, m] of summaries.entries()) {
      const s = m.metrics,
        card = el("article", null, "inspect-card scorecard");
      card.style.borderTop = "3px solid " + colors[i % colors.length];
      card.append(
        el("h4", m.title),
        el(
          "small",
          config.category === "score"
            ? "점수 오차 MAE · 낮을수록 좋음"
            : "정답률 · 정답 있는 성공 응답",
        ),
        el(
          "strong",
          config.category === "score" ? dec(s.mae) : pct(s.accuracy),
          "scorecard-number",
        ),
        el(
          "p",
          "macro-F1 " + dec(s.macroF1) + " · ECE " + dec(s.probCalibration.ece),
        ),
        el("p", "응답 p95 " + sec(s.p95)),
        el("p", "낮은 확신 → 검토 " + pct(s.referralRate)),
        el(
          "small",
          "유효 응답 " +
            s.success +
            " / " +
            s.attempts +
            " · 채점 " +
            s.labeled +
            "건",
        ),
      );
      $("model-scorecards").append(card);
    }
    // 세 번째 값은 아래 상세 설명의 ID다. 계산 함수와 설명 연결을 같은 행에서 관리한다.
    // 버튼의 실제 텍스트는 지표 이름만 유지해 지표 CSV에 도움말 문구가 섞이지 않게 한다.
    const metrics = [
      [
        "채점 성공 / 정답 요청",
        (s) => s.labeled + " / " + s.allLabeled,
        "guide-samples",
      ],
      ["Accuracy", (s) => pct(s.accuracy), "guide-accuracy"],
      ["실패 포함 정답률", (s) => pct(s.effectiveAccuracy), "guide-effective"],
      ["macro-F1", (s) => dec(s.macroF1), "guide-f1"],
      ["선택 확률 ECE ↓", (s) => dec(s.probCalibration.ece), "guide-ece"],
      [
        "Confidence ECE ↓ · 진단",
        (s) => dec(s.confidenceCalibration.ece),
        "guide-confidence-ece",
      ],
      ["Brier ↓", (s) => dec(s.brier), "guide-brier"],
      [
        "스키마 위반율 ↓",
        (s) =>
          pct(s.schemaRate) +
          " (" +
          s.schemaViolations +
          "/" +
          s.schemaChecked +
          ")",
        "guide-schema",
      ],
      ["전체 실패율 ↓", (s) => pct(s.failureRate), "guide-failure"],
      [
        "종단간 p50 / p95 ↓",
        (s) => sec(s.p50) + " / " + sec(s.p95),
        "guide-latency",
      ],
      [
        "시간 표본",
        (s) => s.latencyN + "건" + (s.latencyN < 20 ? " · p95 표본 부족" : ""),
        "guide-samples",
      ],
      [
        "모델 준비 / 추론 p50",
        (s) => sec(s.loadP50) + " / " + sec(s.inferenceP50),
        "guide-runtime",
      ],
      [
        "낮은 확신 → 인간 검토",
        (s) => pct(s.referralRate) + " (" + s.referrals + "/" + s.success + ")",
        "guide-referral",
      ],
      [
        "실패 포함 검토 필요율",
        (s) => pct(s.totalReviewRate),
        "guide-referral",
      ],
      ["자동 처리 비율", (s) => pct(s.coverage), "guide-coverage"],
      [
        "자동 처리 답의 정확도",
        (s) => pct(s.selectiveAccuracy) + " (정답 " + s.retainedLabeled + "건)",
        "guide-selective",
      ],
      ["선택 클래스 ROC-AUC ↑", (s) => dec(s.curve.auc), "guide-roc"],
      ["선택 클래스 AP ↑", (s) => dec(s.curve.ap), "guide-ap"],
      ["전체 클래스 macro-AUC ↑", (s) => dec(s.macroAuc), "guide-macro-auc"],
    ];
    if (config.category === "score")
      metrics.push(
        [
          "Score MAE / RMSE ↓",
          (s) => dec(s.mae) + " / " + dec(s.rmse),
          "guide-mae",
        ],
        ["점수 정답 표본", (s) => s.scoreN + "건", "guide-samples"],
      );
    const rendered = table(
      ["지표", ...summaries.map((m) => m.title)],
      metrics.map(([name, fn]) => [
        name,
        ...summaries.map((m) => fn(m.metrics)),
      ]),
    );
    Array.from(rendered.tBodies[0].rows).forEach((row, i) => {
      const [name, , guideId] = metrics[i];
      const button = el("button", name, "metric-help-link metric-table-help");
      button.type = "button";
      button.dataset.metricHelp = guideId;
      button.setAttribute("aria-label", name + " 설명 보기");
      row.cells[0].replaceChildren(button);
    });
    $("metrics-table").replaceChildren(...rendered.children);
    drawCharts();
    renderInspect();
    renderDetails(opts);
  }
  /**
   * SVG는 일반 HTML과 네임스페이스가 달라 createElementNS로 만든다. 그래프 주석도 텍스트로 넣는다.
   */
  function svgNode(tag, attrs = {}, text) {
    const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n;
  }
  /**
   * 0~1 범위의 비교 곡선을 공통 SVG 좌표계에 그린다. 수학의 y축을 화면 좌표로 뒤집는다.
   * 수치 없는 점을 0점으로 그리지 않고 제외하며, 자료가 없으면 빈 상태 설명을 보여준다.
   * 선 색과 범례 순서를 모델 순서에 맞춰 여러 그래프에서 같은 모델을 따라갈 수 있게 한다.
   */
  function plot(id, series, xLabel, yLabel, diagonal = false) {
    const wrap = $(id);
    wrap.replaceChildren();
    if (!series.some((s) => s.points.length)) {
      wrap.append(
        el(
          "div",
          "그래프를 그릴 정답과 유효한 응답이 부족합니다.",
          "empty-chart",
        ),
      );
      return;
    }
    const svg = svgNode("svg", {
        viewBox: "0 0 460 305",
        role: "img",
        "aria-label": yLabel + " 대 " + xLabel,
      }),
      x = (v) => 48 + v * 380,
      y = (v) => 253 - v * 220;
    for (let i = 0; i <= 4; i++) {
      const v = i / 4;
      svg.append(
        svgNode("line", {
          x1: 48,
          y1: y(v),
          x2: 428,
          y2: y(v),
          stroke: "#e4ebea",
        }),
        svgNode(
          "text",
          {
            x: 38,
            y: y(v) + 4,
            "text-anchor": "end",
            "font-size": 11,
            fill: "#718189",
          },
          v * 100 + "%",
        ),
        svgNode(
          "text",
          {
            x: x(v),
            y: 273,
            "text-anchor": "middle",
            "font-size": 11,
            fill: "#718189",
          },
          v * 100 + "%",
        ),
      );
    }
    if (diagonal)
      svg.append(
        svgNode("line", {
          x1: x(0),
          y1: y(0),
          x2: x(1),
          y2: y(1),
          stroke: "#a8b6b4",
          "stroke-dasharray": "5 5",
        }),
      );
    svg.append(
      svgNode(
        "text",
        {
          x: 238,
          y: 299,
          "text-anchor": "middle",
          "font-size": 11,
          fill: "#687880",
        },
        xLabel,
      ),
      svgNode(
        "text",
        { x: 48, y: 17, "font-size": 11, fill: "#687880" },
        yLabel,
      ),
    );
    const legend = el("div", null, "chart-legend");
    series.forEach((s, i) => {
      const c = colors[i % colors.length];
      svg.append(
        svgNode("polyline", {
          points: s.points.map((p) => x(p.x) + "," + y(p.y)).join(" "),
          fill: "none",
          stroke: c,
          "stroke-width": 2,
        }),
      );
      s.points.forEach((p) => {
        const dot = svgNode("circle", {
          cx: x(p.x),
          cy: y(p.y),
          r: 3.5,
          fill: c,
        });
        dot.append(
          svgNode(
            "title",
            {},
            s.name + " · " + (p.title || pct(p.x) + " / " + pct(p.y)),
          ),
        );
        svg.append(dot);
      });
      const label = el("span"),
        dot = el("i", null, "legend-dot");
      dot.style.background = c;
      label.append(dot, document.createTextNode(s.name));
      legend.append(label);
    });
    wrap.append(svg, legend);
  }
  /**
   * ECE 구간 평균·ROC·검토 위험 곡선은 metrics의 이미 계산된 점으로 그린다.
   * 확률 ECE와 API Confidence ECE를 바꿔 볼 수 있다. 대각선은 완전 보정/무작위 ROC 참고선이다.
   * 지연 막대는 모델 중 가장 큰 p95를 기준으로 길이를 맞추고 실제 초 단위 값도 같이 표시한다.
   */
  function drawCharts() {
    const conf = $("calibration-view").value === "confidence";
    plot(
      "calibration-chart",
      summaries.map((m) => ({
        name: m.title,
        points: (conf
          ? m.metrics.confidenceCalibration
          : m.metrics.probCalibration
        ).bins
          .filter((b) => b.n)
          .map((b) => ({
            x: b.confidence,
            y: b.accuracy,
            title:
              b.n +
              "건 · 평균 " +
              pct(b.confidence) +
              " · 정답률 " +
              pct(b.accuracy),
          })),
      })),
      "평균 " + (conf ? "확신도" : "선택 확률"),
      "실제 정답률",
      true,
    );
    plot(
      "roc-chart",
      summaries.map((m) => ({
        name: m.title,
        points: m.metrics.curve.points.map((p) => ({
          x: p.fpr,
          y: p.tpr,
          title:
            "기준 " +
            (p.threshold === null ? "최대 초과" : dec(p.threshold)) +
            " · FPR " +
            pct(p.fpr) +
            " · Recall " +
            pct(p.tpr),
        })),
      })),
      "거짓 양성률 FPR",
      "재현율 TPR",
      true,
    );
    plot(
      "risk-chart",
      summaries.map((m) => ({
        name: m.title,
        points: m.metrics.risk
          .filter((p) => p.coverage !== null && p.risk !== null)
          .sort((a, b) => a.coverage - b.coverage)
          .map((p) => ({
            x: p.coverage,
            y: p.risk,
            title:
              "확신 기준 " +
              dec(p.threshold) +
              " · 자동 " +
              pct(p.coverage) +
              " · 오답 " +
              pct(p.risk),
          })),
      })),
      "자동 처리 비율 · 정답 응답 기준",
      "자동 처리 오답률",
    );
    const wrap = $("latency-chart");
    wrap.replaceChildren();
    const max = Math.max(...summaries.map((m) => m.metrics.p95 || 0), 0.001);
    summaries.forEach((m, i) => {
      const row = el(
          "div",
          m.title +
            " · p50 " +
            sec(m.metrics.p50) +
            " / p95 " +
            sec(m.metrics.p95),
          "latency-row",
        ),
        track = el("div", null, "latency-track");
      for (const [key, cls] of [
        ["p95", "latency-p95"],
        ["p50", "latency-p50"],
      ]) {
        const bar = el("div", null, cls);
        bar.style.width = ((m.metrics[key] || 0) / max) * 100 + "%";
        bar.style.background = colors[i % colors.length];
        track.append(bar);
      }
      row.append(track);
      wrap.append(row);
    });
  }
  /**
   * 선택한 문서와 반복에 대해 모델 결과를 나란히 보여준다.
   * 미실행·실패·성공을 구분하고 예측, 사람이 붙인 정답, 확률 분포와 Confidence 출처를 표시한다.
   * 판정 기준을 바꿀 때 같은 원시 응답에 새 기준을 적용하므로 모델 재호출은 없다.
   */
  function renderInspect() {
    if (!batch) return;
    const [index, repeat] = $("inspect-document").value.split(":").map(Number),
      wrap = $("inspect-results"),
      config = batch.config,
      opts = metricOptions();
    wrap.replaceChildren();
    for (const model of batch.config.models) {
      const card = el("article", null, "inspect-card");
      card.append(el("h4", model.title));
      const row = batch.rows.find(
        (r) =>
          r.modelId === model.id && r.document === index && r.repeat === repeat,
      );
      if (!row) {
        card.append(el("p", "아직 실행하지 않았습니다."));
        wrap.append(card);
        continue;
      }
      if (!M.valid(row.result, M.labels(config))) {
        card.append(
          el("p", row.result.error || "유효하지 않은 응답", "warning"),
          el("small", row.result.error_kind + " · " + sec(row.elapsed)),
        );
        wrap.append(card);
        continue;
      }
      const predicted = M.prediction(row.result, config, opts),
        gold = M.truth(row.expected, config),
        conf =
          opts.basis === "api" && M.num(row.result.api_confidence)
            ? row.result.api_confidence
            : row.result.probabilities[predicted];
      card.append(
        el(
          "div",
          config.category === "score"
            ? "점수 " + dec(row.result.value)
            : predicted,
          "verdict" + (gold !== null && predicted !== gold ? " wrong" : ""),
        ),
        el(
          "p",
          "정답: " +
            (row.expected ?? "미지정") +
            (gold !== null ? (predicted === gold ? " · 정답" : " · 오답") : ""),
        ),
        el(
          "p",
          "판정 단계: " +
            predicted +
            " · " +
            (conf < opts.referral ? "사람 검토" : "자동 처리 후보"),
        ),
        el("p", "확신 " + pct(conf) + " · 종단간 " + sec(row.elapsed)),
        el("small", row.result.confidence_source),
      );
      for (const [k, v] of Object.entries(row.result.probabilities)) {
        const bar = el("div", null, "prob-row"),
          track = el("div", null, "prob-track"),
          fill = el("div", null, "prob-fill");
        fill.style.width = v * 100 + "%";
        track.append(fill);
        bar.append(el("span", k), el("span", pct(v)), track);
        card.append(bar);
      }
      wrap.append(card);
    }
  }
  /**
   * 요약값을 검증할 수 있도록 클래스별 Precision/Recall/F1, 혼동행렬,
   * ECE 구간 표본 수, ROC 임계값 표, 오류 및 준비 실행 기록을 펼쳐 보여준다.
   */
  function renderDetails(opts) {
    const classes = $("class-details"),
      bins = $("bin-details"),
      roc = $("roc-details"),
      fail = $("failure-details");
    for (const w of [classes, bins, roc, fail]) w.replaceChildren();
    for (const m of summaries) {
      const s = m.metrics,
        c = el("section", null, "model-detail");
      c.append(
        el("h4", m.title),
        scrollTable(
          table(
            ["클래스", "정답 수", "Precision", "Recall", "F1"],
            s.classes.map((r) => [
              r.label,
              r.support,
              pct(r.precision),
              pct(r.recall),
              dec(r.f1),
            ]),
          ),
        ),
        el("p", "혼동행렬: 행은 실제 정답, 열은 모델 예측입니다.", "help"),
        scrollTable(
          table(
            ["정답 ↓ / 예측 →", ...M.labels(batch.config)],
            s.matrix.map((r, i) => [M.labels(batch.config)[i], ...r]),
          ),
        ),
      );
      classes.append(c);
      const b = el("section", null, "model-detail"),
        cal =
          $("calibration-view").value === "confidence"
            ? s.confidenceCalibration
            : s.probCalibration;
      b.append(
        el("h4", m.title),
        scrollTable(
          table(
            ["구간", "표본", "평균 확신/확률", "실제 정답률"],
            cal.bins.map((r, i) => [
              dec(r.low) +
                "–" +
                dec(r.high) +
                (i === cal.bins.length - 1 ? " (1 포함)" : ""),
              r.n,
              pct(r.confidence),
              pct(r.accuracy),
            ]),
          ),
        ),
      );
      bins.append(b);
      const r = el("section", null, "model-detail");
      r.append(
        el(
          "h4",
          m.title +
            " · 양성 " +
            opts.positive +
            " · " +
            s.curve.positive +
            " / 음성 " +
            s.curve.negative,
        ),
        scrollTable(
          table(
            ["점수 ≥ 기준", "FPR", "Recall", "Precision"],
            s.curve.points.map((p) => [
              p.threshold === null ? "최고 점수 초과" : dec(p.threshold),
              pct(p.fpr),
              pct(p.tpr),
              pct(p.precision),
            ]),
          ),
        ),
      );
      roc.append(r);
      const f = el("section", null, "model-detail");
      f.append(
        el("h4", m.title),
        el(
          "p",
          "오류 유형: " +
            (Object.entries(s.errors)
              .map(([k, v]) => k + " " + v + "건")
              .join(" · ") || "없음"),
        ),
      );
      for (const w of batch.warmups.filter((w) => w.modelId === m.id))
        f.append(
          el(
            "p",
            "준비 실행 · " +
              sec(w.elapsed) +
              " · " +
              (w.result.error || "성공"),
          ),
        );
      for (const row of batch.rows.filter(
        (r) => r.modelId === m.id && r.result.status !== "ok",
      ))
        f.append(
          el(
            "p",
            batch.config.documents[row.document].name +
              " / " +
              row.result.error,
          ),
        );
      fail.append(f);
    }
  }
  /**
   * 브라우저 환경에 따라 Blob 다운로드가 막힐 수 있어 앱 서버의 임시 파일 URL을 사용한다.
   * 자동 클릭이 작동하지 않아도 사용자가 누를 수 있는 다운로드 링크를 화면에 남긴다.
   * mime 인자는 호출 의도를 나타내지만 실제 Content-Type은 서버가 파일 확장자로 정한다.
   */
  async function download(name, data, mime = "application/json") {
    try {
      const file = await api("/api/export", {
        filename: name,
        content:
          typeof data === "string" ? data : JSON.stringify(data, null, 2),
      });
      const a = el("a", "준비된 파일 저장: " + name);
      a.href = file.url;
      a.download = name;
      $("download-ready").replaceChildren(a);
      $("download-ready").hidden = false;
      a.click();
    } catch (e) {
      error(e.message);
    }
  }
  /**
   * 파일 크기와 UTF-8을 검사한 뒤 JSON으로 읽는다. 깨진 문자를 자동 대체해 질문 의미가 달라지는 것을 피한다.
   */
  async function fileJSON(file) {
    if (!file || file.size > 4000000)
      throw Error("4MB 이하의 UTF-8 JSON 파일을 사용하세요.");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      ),
    );
  }
  /**
   * 실험 저장은 재실행용이다. 질문·선택지·정답뿐 아니라 문서 원문과 실행 조건도 포함한다.
   * 아래 결과 JSON과 저장 범위가 다르므로 파일을 공유할 때 이 차이를 이해해야 한다.
   */
  $("save-experiment").onclick = () => {
    try {
      download("decision-experiment-" + category + ".json", {
        format: "decision-lab-experiment-v1",
        ...experiment(),
      });
    } catch (e) {
      error(e.message);
    }
  };
  /**
   * 불러오기는 전체 성공 또는 원상 복구로 처리한다.
   * 초안·모델·설정의 백업을 먼저 만들고, 질문이 유효해도 뒤의 설정 검증이 실패하면 모두 되돌린다.
   * 내부 모델 ID는 새로 발급해 파일에 든 ID와 현재 화면의 ID가 충돌하지 않게 한다.
   */
  $("load-experiment").onchange = async (e) => {
    syncDraft();
    const backup = {
      category,
      drafts: structuredClone(drafts),
      models: structuredClone(models),
      settings: Object.fromEntries(
        [
          "repeats",
          "warmup",
          "order",
          "seed",
          "timeout",
          "context",
          "temperature",
        ].map((k) => [k, $("eval-" + k).value]),
      ),
    };
    try {
      const d = await fileJSON(e.target.files[0]);
      if (
        d.format !== "decision-lab-experiment-v1" ||
        !presets[d.category] ||
        typeof d.question !== "string" ||
        !d.criteria ||
        !Array.isArray(d.documents)
      )
        throw Error("이 페이지에서 저장한 실험 파일을 사용하세요.");
      const prior = category,
        old = structuredClone(drafts[d.category]);
      syncDraft();
      try {
        drafts[d.category] = {
          question: d.question,
          criteria: Array.isArray(d.criteria)
            ? d.criteria.join("\n")
            : Object.entries(d.criteria)
                .map(([k, v]) => k + " = " + v)
                .join("\n"),
          rows: d.documents,
        };
        applyCategory(d.category);
        criteria();
        validateRows(d.documents);
      } catch (err) {
        drafts[d.category] = old;
        applyCategory(prior);
        throw err;
      }
      for (const [k, v] of Object.entries(d.settings || {})) {
        const field = $("eval-" + k);
        if (
          field &&
          [
            "repeats",
            "warmup",
            "order",
            "seed",
            "timeout",
            "context",
            "temperature",
          ].includes(k)
        )
          field.value = v;
      }
      settings();
      if (Array.isArray(d.models)) {
        models = [];
        for (const m of d.models.slice(0, 20)) {
          if (
            ["ollama", "ollaya", "llama"].includes(m.provider) &&
            typeof m.model === "string" &&
            typeof m.base_url === "string"
          )
            addModel({ ...m, id: "m" + ++idCounter, title: friendly(m.model) });
        }
        renderModels();
      }
      error("");
    } catch (err) {
      drafts = backup.drafts;
      models = backup.models;
      applyCategory(backup.category);
      for (const [k, v] of Object.entries(backup.settings))
        $("eval-" + k).value = v;
      renderModels();
      error(err.message);
    } finally {
      e.target.value = "";
    }
  };
  $("dataset-upload").onchange = async (e) => {
    try {
      drafts[category].rows = validateRows(await fileJSON(e.target.files[0]));
      renderDataset();
      error("");
    } catch (err) {
      error(err.message);
    } finally {
      e.target.value = "";
    }
  };
  /**
   * 결과 공유용 저장: 문서 text 필드를 제외하고 SHA-256 식별값으로 바꾼다.
   * 해시는 같은 입력인지 대조하는 표식이며 원문을 복원할 수 있는 저장 방식이 아니다.
   * 문서 이름·질문·선택지·정답·모델 응답/오류는 남는다. 완전한 익명화 파일을 뜻하지는 않는다.
   * 실행 조건과 재집계 조건(metricSettings)을 함께 저장해 수치를 다시 해석할 수 있게 한다.
   */
  $("export-results").onclick = async () => {
    if (!batch) return;
    const documents = await Promise.all(
      batch.config.documents.map(async ({ text, ...rest }) => ({
        ...rest,
        sha256: Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(text),
            ),
          ),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      })),
    );
    download("decision-results-" + batch.config.category + ".json", {
      ...batch,
      config: { ...batch.config, documents },
      metricSettings: metricOptions(),
      summaries,
      note: "입력 원문 제외. 원문과 실행 조건은 질문·데이터 저장으로 별도 보관. 시간은 브라우저 종단간 초. 준비 실행은 지표 제외.",
    });
  };
  /**
   * 현재 보이는 지표표를 CSV로 저장한다. 큰따옴표는 두 번 써서 셀 경계를 보존한다.
   * =, +, @, -로 시작하는 셀에는 작은따옴표를 붙여 스프레드시트 수식으로 해석되는 것을 줄인다.
   * UTF-8 BOM과 CRLF는 한국어 파일을 일반 스프레드시트 앱에서 열기 쉽게 하기 위한 처리다.
   */
  $("export-csv").onclick = () => {
    const rows = Array.from($("metrics-table").rows).map((r) =>
      Array.from(r.cells)
        .map((c) => {
          let v = c.textContent;
          if (/^[=+@\-]/.test(v)) v = "'" + v;
          return '"' + v.replaceAll('"', '""') + '"';
        })
        .join(","),
    );
    download(
      "decision-metrics-" + batch.config.category + ".csv",
      "\uFEFF" + rows.join("\r\n"),
      "text/csv;charset=utf-8",
    );
  };
  /**
   * 이하 이벤트 연결은 화면 조작을 위 함수에 이어준다.
   * 새 문서의 정답은 null로 시작한다. 아직 모르는 정답을 임의로 지정해 채점하지 않는다.
   */
  $("add-row").onclick = () => {
    if (drafts[category].rows.length >= 100) {
      error("최대 100건입니다.");
      return;
    }
    drafts[category].rows.push({
      name: "입력 " + (drafts[category].rows.length + 1),
      text: "",
      expected: null,
    });
    renderDataset();
  };
  $("load-samples").onclick = () => {
    drafts[category] = {
      question: presets[category].question,
      criteria: presets[category].criteria,
      rows: sampleRows(category),
    };
    applyCategory(category);
  };
  $("eval-criteria").addEventListener("change", () => {
    syncDraft();
    renderDataset();
  });
  for (const b of document.querySelectorAll("[data-category]"))
    b.onclick = () => {
      syncDraft();
      applyCategory(b.dataset.category);
    };
  $("discover-models").onclick = discover;
  $("custom-provider").onchange = () => {
    $("custom-base").value = {
      ollaya: "http://127.0.0.1:11435",
      ollama: "http://127.0.0.1:11434",
      llama: "http://127.0.0.1:8080",
    }[$("custom-provider").value];
  };
  $("add-model").onclick = () => {
    const model = $("custom-name").value.trim();
    if (!model || model.length > 200) {
      error("모델 이름을 입력하세요.");
      return;
    }
    if (models.length >= 20) {
      error("최대 20개 모델을 추가할 수 있습니다.");
      return;
    }
    addModel({
      model,
      provider: $("custom-provider").value,
      base_url: $("custom-base").value.trim(),
    });
    renderModels();
    error("");
  };
  /**
   * 안내의 본문을 재사용하는 문맥 도움말. 지표 계산이나 평가 상태에는 손대지 않는다.
   * native dialog는 Escape 닫기와 키보드 포커스 제한을 제공한다.
   * 실행 중 결과표가 다시 그려져 기존 버튼이 사라질 수 있으므로 닫을 때 같은 설명의
   * 새 버튼도 찾아 포커스를 돌려준다. 안내 본문에는 중복될 수 있는 id를 넣지 않는다.
   */
  let metricHelpTrigger = null;
  function openMetricHelp(guideId, trigger) {
    const guide = $(guideId);
    if (!guide?.matches("#metric-guide .metric-explainer")) return;
    const dialog = $("metric-help-dialog");
    metricHelpTrigger = { element: trigger, guideId };
    $("metric-help-title").textContent =
      guide.querySelector(".metric-name").textContent;
    $("metric-help-content").replaceChildren(
      guide.querySelector(".metric-guide-body").cloneNode(true),
    );
    if (!dialog.open) dialog.showModal();
    $("metric-help-content").scrollTop = 0;
  }
  // 동적으로 다시 생성되는 결과표와 정적인 그래프 버튼에 같은 이벤트 위임을 적용한다.
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-metric-help]");
    if (trigger) openMetricHelp(trigger.dataset.metricHelp, trigger);
  });
  $("metric-help-dialog").addEventListener("close", () => {
    const prior = metricHelpTrigger;
    const target = prior?.element.isConnected
      ? prior.element
      : Array.from(document.querySelectorAll("[data-metric-help]")).find(
          (button) => button.dataset.metricHelp === prior?.guideId,
        );
    target?.focus({ preventScroll: true });
  });
  $("expand-metric-guide").onclick = () => {
    document
      .querySelectorAll("#metric-guide .metric-explainer")
      .forEach((detail) => {
        detail.open = true;
      });
  };
  $("collapse-metric-guide").onclick = () => {
    document
      .querySelectorAll("#metric-guide .metric-explainer")
      .forEach((detail) => {
        detail.open = false;
      });
  };
  // 목차나 #guide-ece 같은 직접 링크로 들어오면 닫힌 설명도 펼친다.
  function revealMetricGuide() {
    const id = location.hash.slice(1);
    const guide = $(id);
    if (!guide?.matches("#metric-guide .metric-explainer")) return;
    guide.open = true;
    guide.scrollIntoView({ block: "start" });
  }
  window.addEventListener("hashchange", revealMetricGuide);
  document
    .querySelector(".metric-guide-nav")
    .addEventListener("click", (event) => {
      const link = event.target.closest("a[href^='#guide-']");
      if (link) $(link.hash.slice(1)).open = true;
    });
  revealMetricGuide();
  $("eval-run").onclick = run;
  $("eval-stop").onclick = () => {
    stopping = true;
    lock();
    $("eval-progress").textContent =
      "현재 요청이 끝나면 중단합니다. 모델 추론을 강제 종료하지 않습니다.";
  };
  /**
   * 입력/변경 이벤트는 렌더링만 다시 한다. 평가 비용 없이 기준을 탐색할 수 있다.
   * 같은 평가 데이터에 맞춰 기준을 고른 뒤 그 데이터로 최종 성능까지 주장하지 않도록 UI에서 안내한다.
   */
  for (const id of ["metric-threshold", "metric-referral"])
    $(id).addEventListener("input", renderResults);
  for (const id of [
    "metric-basis",
    "metric-bins",
    "metric-positive",
    "calibration-view",
  ])
    $(id).addEventListener("change", renderResults);
  $("inspect-document").onchange = () => {
    try {
      renderInspect();
    } catch (e) {
      error(e.message);
    }
  };
  /**
   * 최초 진입: 예제 초안 표시 → 빈 모델 영역 표시 → 설치된 모델 목록 조회. 평가 자체는 버튼을 눌러야 시작한다.
   */
  applyCategory(category);
  renderModels();
  discover();
})();
