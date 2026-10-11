"use strict";
/**
 * 기존 단일 기밀 문서 검토 화면의 제어기.
 * index.html은 app.js → comparison-metrics.js → compare.js 순서로 로드한다.
 * 아래 $, examples, api, names, running은 compare.js에서도 사용하는 공유 식별자다.
 * readForm/connect → runAnalysis → renderResult 순서로 읽으면 입력부터 결과까지 따라갈 수 있다.
 * 로컬 저장소에는 모델 연결 설정만 보관한다. 문서·최근 결과는 현재 페이지의 메모리에 둔다.
 */
const $ = (id) => document.getElementById(id);
const examples = {
  contract:
    "프로젝트 라임 · 파트너 계약 협의 메모\n\n본 문서는 사내 검토용이며 아직 공개하지 않은 조건입니다.\nA사에 제안할 최종 공급 단가는 월 480만 원이며, 연간 계약 시 18% 할인을 적용합니다. 최소 보장 매출은 연 5억 원으로 협의 중입니다.\n\n계약 체결 전까지 외부에 전달하지 마세요.",
  public:
    "시민 누구나 참여하는 가을 독서 행사\n\n도서관 홈페이지에 공개된 행사 안내입니다.\n10월 둘째 주 토요일 오후 2시, 중앙도서관에서 작가와의 만남이 열립니다. 참가비는 무료이며 도서관 홈페이지에서 신청할 수 있습니다.\n\n이 안내문은 자유롭게 공유하셔도 됩니다.",
  guide:
    "공개 보안 교육 자료: 대외비 문서 작성법\n\n이 문서는 일반인에게 공개된 교육용 안내입니다. 실제 회사의 내부 정보는 포함하지 않습니다.\n대외비 문서를 작성할 때는 접근 권한과 보관 기간을 정해야 합니다. “기밀”이라는 표시는 필요할 때만 사용합니다.\n\n다음 문장은 가상의 예시입니다: “프로젝트 A의 예산은 100원입니다.”\n실제 계약, 고객 정보, 회사 예산과 무관한 교육 자료입니다.",
  plain:
    "다음 분기 출시 준비 회의록\n\n개발팀은 아직 외부에 발표하지 않은 음성 결제 기능을 11월에 출시할 계획입니다. 경쟁사가 알지 못하도록 발표 시점은 출시 이틀 전으로 잡았습니다.\n현재 내부 테스트의 결제 실패율은 7.2%입니다. 경영진은 초기 마케팅 예산으로 3억 원을 배정했습니다.",
};
let settings = {
  provider: "ollama",
  base_url: "http://127.0.0.1:11434",
  model: "qwen3.5:4b",
  method: "tokens",
  calibration: 1,
  rules: true,
};
try {
  const saved = JSON.parse(
    localStorage.getItem("decision-lab-settings") || "null",
  );
  if (saved && typeof saved === "object") settings = { ...settings, ...saved };
} catch {}
let connected = false,
  connectedKey = "",
  currentResult = null,
  running = false,
  toastTimer;
const names = {
  block: "반출 금지",
  review: "사람 검토",
  candidate: "반출 가능 후보",
};
/**
 * 짧은 안내를 표시한다. 이전 타이머를 취소해 새 안내가 이전 안내의 종료 시점에 사라지지 않게 한다.
 */
function toast(text) {
  $("toast").textContent = text;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 4000);
}
/**
 * 허용된 화면만 hidden으로 전환한다. 새 페이지를 로드하지 않으므로 현재 입력과 결과가 유지된다.
 */
function navigate(page) {
  if (!["workspace", "compare", "learn", "video", "guide"].includes(page))
    return;
  document
    .querySelectorAll(".page")
    .forEach((e) => (e.hidden = e.id !== "page-" + page));
  document
    .querySelectorAll(".nav-item")
    .forEach((e) => e.classList.toggle("active", e.dataset.page === page));
  $("breadcrumb").textContent =
    "워크스페이스 / " +
    {
      workspace: "기밀 문서 검토",
      compare: "모델 비교",
      learn: "원리 쉽게 배우기",
      video: "영상 결과 읽기",
      guide: "종합 리포트 · 구조",
    }[page];
  window.scrollTo({ top: 0, behavior: "instant" });
}
document
  .querySelectorAll("[data-page]")
  .forEach((b) => b.addEventListener("click", () => navigate(b.dataset.page)));
$("show-how").addEventListener("click", () => navigate("learn"));
document.querySelector(".brand").addEventListener("click", (e) => {
  e.preventDefault();
  navigate("workspace");
});
/**
 * 같은 출처의 앱 서버로 JSON을 보낸다. X-Decision-Lab 헤더는 서버의 요청 검증에 쓰인다.
 * 서버가 반환한 오류 설명을 throw하여 각 화면이 같은 규칙으로 실패를 표시하도록 한다.
 */
async function api(path, data) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Decision-Lab": "1" },
    body: JSON.stringify(data),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "앱 서버 응답을 읽지 못했습니다. start.command로 앱을 다시 실행해주세요.",
    );
  }
  if (!response.ok)
    throw new Error(result.error || "요청을 완료하지 못했습니다.");
  return result;
}
/**
 * 설정 창 값을 API 설정 이름으로 모은다. 숫자 변환만 하고 범위 검증은 저장 시와 서버에서 수행한다.
 */
function readForm() {
  return {
    provider: $("provider").value,
    base_url: $("base-url").value.trim(),
    model: $("model").value,
    method: $("method").value,
    calibration: Number($("calibration").value),
    rules: $("rules").checked,
  };
}
/**
 * 기본값 또는 저장한 설정을 설정 창에 채운 뒤 실행 도구에서 지원하는 방식만 활성화한다.
 */
function fillForm() {
  for (const [key, id] of [
    ["provider", "provider"],
    ["base_url", "base-url"],
    ["method", "method"],
    ["calibration", "calibration"],
  ])
    $(id).value = settings[key];
  $("rules").checked = settings.rules;
  methodUI();
}
/**
 * 연결 확인과 모델 선택이 모두 있어야 사용 가능 상태를 표시한다. 점수 방식에 맞는 짧은 설명도 갱신한다.
 */
function updateStatus() {
  const usable = connected && settings.model;
  $("connection-status").textContent = usable
    ? settings.model
    : "모델 연결 필요";
  $("status-dot").classList.toggle("connected", Boolean(usable));
  $("run-hint").textContent = usable
    ? {
        tokens: "선택지 확률 · 로컬 처리",
        json: "설명 포함 · 로컬 처리",
        decision: "Decision 전용 · 로컬 처리",
      }[settings.method]
    : "오른쪽 위에서 모델을 연결하세요.";
}
/**
 * 실행 도구마다 지원 방식이 다르므로 사용할 수 없는 선택은 비활성화한다.
 * tokens의 보정 온도는 JSON 자체 평가나 전용 실행기의 내장 보정과 구분한다.
 */
function methodUI() {
  const provider = $("provider").value;
  const allowed =
    provider === "ollaya"
      ? ["decision"]
      : provider === "llama"
        ? ["tokens"]
        : ["tokens", "json"];
  for (const o of $("method").options) o.disabled = !allowed.includes(o.value);
  if (!allowed.includes($("method").value)) $("method").value = allowed[0];
  $("calibration").disabled = $("method").value !== "tokens";
  $("method-help").textContent = {
    tokens:
      "A/B 토큰 확률 지원이 필요합니다. 두 값을 받지 못하면 결과를 추측하지 않습니다.",
    json: "AI가 이유와 근거를 작성합니다. 점수는 모델의 자체 평가이며 토큰 확률과 다릅니다.",
    decision:
      "Decision 전용 실행기가 반환한 점수를 사용합니다. 문서가 입력 한도를 넘으면 결과를 사용하지 않습니다.",
  }[$("method").value];
}
/**
 * 실제 설치 목록으로 모델 선택 상자를 채운다. 표시 이름은 친절하게 바꾸지만 value는 실제 모델명이다.
 * connectedKey에 확인한 실행 도구와 주소를 남겨 주소 변경 후 과거 연결 상태를 재사용하지 않게 한다.
 * silent=true는 첫 진입의 자동 확인이며 성공하면 현재 선택을 상태 표시에 반영한다.
 */
async function connect(silent = false) {
  $("connect").disabled = true;
  $("connect-message").className = "";
  $("connect-message").textContent = "로컬 모델 서버를 확인하고 있습니다…";
  try {
    const form = readForm();
    const result = await api("/api/connect", form);
    const previous = form.model || settings.model;
    const select = $("model");
    select.replaceChildren();
    for (const m of result.models) {
      const option = document.createElement("option");
      option.value = m.name;
      option.textContent =
        ({
          "qwen3.5:4b": "Qwen3.5 4B · 일반 AI 활용",
          "jevk5:latest": "JevK5 4B · 판단 전용 학습",
          "laya:multilingual": "Laya 다국어 · 짧은 문서 분류",
          "decider:0.8b": "decider 0.8B · 소형 판단 AI",
        }[m.name] || m.name) +
        (m.size ? " · " + (m.size / 1e9).toFixed(1) + " GB" : "");
      select.append(option);
    }
    if (result.models.some((m) => m.name === previous)) select.value = previous;
    connected = Boolean(result.models.length);
    connectedKey = form.provider + "|" + form.base_url;
    if (!connected) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "내려받은 모델이 없습니다";
      select.append(option);
      $("connect-message").textContent =
        "서버에 연결했습니다. 아직 로컬 모델이 없습니다. 모델 준비 후 다시 확인하세요.";
    } else {
      $("connect-message").textContent =
        result.models.length + "개의 로컬 모델을 찾았습니다.";
      if (silent) {
        settings = { ...settings, ...readForm() };
        updateStatus();
      }
    }
    return result;
  } catch (e) {
    connected = false;
    connectedKey = "";
    $("connect-message").className = "error";
    $("connect-message").textContent = e.message;
    if (!silent) toast("연결 상태를 확인해주세요.");
  } finally {
    $("connect").disabled = false;
    updateStatus();
  }
}
$("open-settings").addEventListener("click", () => {
  $("settings").showModal();
});
$("connect").addEventListener("click", () => connect());
$("provider").addEventListener("change", () => {
  $("base-url").value = {
    ollama: "http://127.0.0.1:11434",
    ollaya: "http://127.0.0.1:11435",
    llama: "http://127.0.0.1:8080",
  }[$("provider").value];
  connectedKey = "";
  methodUI();
});
$("base-url").addEventListener("input", () => {
  connectedKey = "";
});
$("method").addEventListener("change", methodUI);
$("save-settings").addEventListener("click", () => {
  const next = readForm();
  if (
    !next.model ||
    !connected ||
    connectedKey !== next.provider + "|" + next.base_url
  ) {
    $("connect-message").className = "error";
    $("connect-message").textContent =
      "이 주소로 연결을 확인하고 모델을 선택해주세요.";
    return;
  }
  if (
    !Number.isFinite(next.calibration) ||
    next.calibration < 0.1 ||
    next.calibration > 5
  ) {
    toast("보정 온도는 0.1~5 사이로 입력해주세요.");
    return;
  }
  settings = next;
  try {
    localStorage.setItem("decision-lab-settings", JSON.stringify(settings));
  } catch {}
  updateStatus();
  invalidate();
  $("settings").close();
  toast("로컬 모델 설정을 적용했습니다.");
});
/**
 * 문서·질문·모델 설정이 바뀌면 이전 결과를 숨긴다. 새 입력에 대한 결과로 오해하는 것을 방지한다.
 */
function invalidate() {
  if (running) return;
  currentResult = null;
  $("result-content").hidden = true;
  $("result-empty").hidden = false;
  $("input-error").hidden = true;
}
/**
 * 문서 글자 수를 갱신하고 이전 결과를 무효화한다. 키 입력과 파일/예제 불러오기에서 공통 사용한다.
 */
function changed() {
  const length = $("document").value.length;
  $("char-count").textContent = length.toLocaleString() + " / 12,000자";
  invalidate();
}
$("document").addEventListener("input", changed);
$("criterion").addEventListener("input", invalidate);
$("load-example").addEventListener("click", () => {
  $("document").value = examples[$("example").value];
  changed();
  toast("예제 문서를 불러왔습니다. AI가 실제로 분석합니다.");
});
/**
 * 선택한 파일은 브라우저에서 UTF-8 텍스트로 읽는다. 여기서는 모델 요청을 하지 않는다.
 * PDF 파싱은 지원하지 않으며 크기·인코딩·널 문자 검사로 잘못된 입력을 먼저 알려준다.
 */
$("file-input").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (!/\.(txt|md|csv|log)$/i.test(file.name))
      throw new Error(
        "TXT, MD, CSV, LOG 텍스트 파일을 선택해주세요. PDF는 텍스트를 복사해서 넣어주세요.",
      );
    if (file.size > 64000)
      throw new Error(
        "파일이 너무 큽니다. 12,000자 이내의 텍스트로 나누어 주세요.",
      );
    const bytes = await file.arrayBuffer();
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error("UTF-8로 저장한 텍스트 파일을 사용해주세요.");
    }
    if (text.includes("\u0000")) throw new Error("텍스트 파일이 아닙니다.");
    if (text.length > 12000)
      throw new Error("12,000자를 넘었습니다. 파일 내용을 나누어 주세요.");
    $("document").value = text;
    changed();
    toast(file.name + "을 읽었습니다. 분석 버튼을 눌러주세요.");
  } catch (e) {
    $("input-error").textContent = e.message;
    $("input-error").hidden = false;
  } finally {
    event.target.value = "";
  }
});
/**
 * 현재 검토 시작(low)과 차단 시작(high) 기준을 숫자로 읽는다.
 */
function thresholds() {
  return { low: Number($("low").value), high: Number($("high").value) };
}
/**
 * low < high를 유지하도록 반대쪽 기준을 조정하고 구간 막대와 숫자를 갱신한다.
 * 기존 모델 점수는 다시 계산하지 않고 renderResult로 최종 업무 분류만 바꾼다.
 */
function refreshThresholds(source) {
  let { low, high } = thresholds();
  if (low >= high) {
    if (source === "low") {
      $("high").value = Math.min(1, low + 0.01);
    } else {
      $("low").value = Math.max(0, high - 0.01);
    }
    ({ low, high } = thresholds());
  }
  $("low-value").value = low.toFixed(2);
  $("high-value").value = high.toFixed(2);
  $("pass-range").textContent = low.toFixed(2) + " 미만";
  $("review-range").textContent =
    low.toFixed(2) + " 이상 · " + high.toFixed(2) + " 미만";
  $("block-range").textContent = high.toFixed(2) + " 이상";
  document.querySelector(".zone-pass").style.width = low * 100 + "%";
  document.querySelector(".zone-review").style.width = (high - low) * 100 + "%";
  if (currentResult) renderResult();
}
$("low").addEventListener("input", () => refreshThresholds("low"));
$("high").addEventListener("input", () => refreshThresholds("high"));
$("reset-thresholds").addEventListener("click", () => {
  $("low").value = 0.25;
  $("high").value = 0.6;
  refreshThresholds();
});
/**
 * 강제 규칙 차단을 먼저 적용하고 오류·점수 없음·불확실 응답은 검토로 보낸다.
 * 나머지는 현재 슬라이더 기준을 적용한다. 서버가 준 이전 decision을 그대로 재사용하지 않는다.
 */
function decision(result) {
  const { low, high } = thresholds();
  if (result.forced) return "block";
  if (result.error || result.score === null || result.uncertain)
    return "review";
  return result.score >= high
    ? "block"
    : result.score >= low
      ? "review"
      : "candidate";
}
/**
 * 현재 결과를 카드에 반영한다. JSON 위험도, 토큰 상대 확률, 전용 점수의 이름을 구분한다.
 * 모델이 생성한 이유와 인용은 textContent로 출력해 HTML처럼 실행하지 않는다.
 * 점수가 없으면 0이 아니라 "—"를 보여준다.
 */
function renderResult() {
  const r = currentResult;
  if (!r) return;
  $("result-empty").hidden = true;
  $("result-content").hidden = false;
  const d = decision(r);
  $("decision-badge").className = "decision-badge " + d;
  $("decision-badge").textContent = names[d];
  $("elapsed").textContent =
    r.elapsed != null ? r.elapsed.toFixed(1) + "초" : "";
  $("score-number").textContent =
    typeof r.score === "number" ? r.score.toFixed(3) : "—";
  $("score-label").textContent =
    r.method === "json"
      ? "모델이 매긴 위험도"
      : r.method === "rules"
        ? "로컬 규칙 우선 적용"
        : r.method === "decision"
          ? "Decision 기밀 판단 점수"
          : "A/B 기밀 판단 점수";
  $("score-subtitle").textContent = r.error
    ? "분석을 완료하지 못해 검토가 필요합니다."
    : r.forced
      ? "AI 호출 없이 식별정보 형태로 차단했습니다."
      : r.uncertain
        ? "응답의 불확실성 때문에 사람 검토가 우선됩니다."
        : d === "candidate"
          ? "현재 기준 아래입니다. 최종 승인은 사람이 확인하세요."
          : "현재 설정한 기준에 따라 분류했습니다.";
  $("score-marker").hidden = typeof r.score !== "number";
  if (typeof r.score === "number")
    $("score-marker").style.left = r.score * 100 + "%";
  $("reasons").replaceChildren();
  for (const reason of r.reasons || [r.error]) {
    const p = document.createElement("p");
    p.textContent = reason;
    $("reasons").append(p);
  }
  $("evidence").replaceChildren();
  for (const evidence of r.evidence || []) {
    const q = document.createElement("blockquote");
    q.textContent = evidence;
    $("evidence").append(q);
  }
  $("result-note").textContent =
    r.note ||
    "오류가 나면 통과시키지 않습니다. 모델 연결과 분석 방식을 확인한 뒤 다시 시도하세요.";
  $("result-model").textContent = r.model || settings.model || "모델 연결 필요";
}
/**
 * 분석 중 입력 변경과 중복 실행을 막고 compare.js의 버튼 상태도 함께 갱신한다.
 */
function setBusy(value) {
  running = value;
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
    $(id).disabled = value;
  $("loading").hidden = !value;
  $("analyze").textContent = value ? "분석 중…" : "문서 분석하기";
  window.refreshComparisonBusy?.();
}
/**
 * 입력 확인 → 진행 표시 → /api/analyze 호출 → 결과 렌더링 순서.
 * 실패 시 score=null, uncertain=true로 남겨 사람이 검토하도록 표시한다.
 * finally에서 타이머와 사용 중 상태를 항상 해제해 오류 뒤에도 재시도할 수 있게 한다.
 */
async function runAnalysis() {
  if (running || window.compareBusy)
    throw new Error("다른 문서를 분석 중입니다.");
  const text = $("document").value;
  if (!text.trim()) {
    const error = new Error("먼저 문서 내용을 입력해주세요.");
    $("input-error").textContent = error.message;
    $("input-error").hidden = false;
    throw error;
  }
  if (text.length > 12000) throw new Error("12,000자를 넘었습니다.");
  if (!connected || !settings.model) {
    $("settings").showModal();
    throw new Error("먼저 로컬 모델을 연결해주세요.");
  }
  $("input-error").hidden = true;
  currentResult = null;
  $("result-content").hidden = true;
  $("result-empty").hidden = true;
  setBusy(true);
  const start = Date.now();
  $("loading-time").textContent = "0초";
  const timer = setInterval(
    () =>
      ($("loading-time").textContent =
        Math.round((Date.now() - start) / 1000) + "초"),
    1000,
  );
  try {
    currentResult = await api("/api/analyze", {
      ...settings,
      text,
      criterion: $("criterion").value,
      ...thresholds(),
    });
  } catch (e) {
    currentResult = {
      error: e.message,
      decision: "review",
      score: null,
      method: settings.method,
      model: settings.model,
      reasons: [e.message],
      evidence: [],
      uncertain: true,
    };
  } finally {
    clearInterval(timer);
    setBusy(false);
    renderResult();
  }
  return currentResult;
}
$("analyze").addEventListener("click", () =>
  runAnalysis().catch((e) => toast(e.message)),
);
fillForm();
$("document").value = examples.contract;
changed();
refreshThresholds();
updateStatus();
connect(true);
// 지원되는 브라우저에서만 화면과 동일한 검증 규칙의 WebMCP 기능을 활성화한다.
/**
 * 선택 기능: WebMCP를 지원하는 브라우저에서만 현재 상태 조회와 임계값 변경 도구를 등록한다.
 * 화면과 같은 검증 함수를 쓰며 자동 추론 도구는 등록하지 않는다.
 * 원문 필드 자체는 반환하지 않지만 result의 이유·인용에는 원문 일부가 포함될 수 있다.
 * 페이지가 닫힐 때 AbortController로 도구 등록 생명주기를 정리한다.
 */
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  const register = (tool) =>
    Promise.resolve(
      document.modelContext.registerTool(tool, { signal: lifecycle.signal }),
    ).catch(() => {});
  register({
    name: "get_classification_state",
    description:
      "Read the active local model, thresholds, and latest result. Does not expose the document body.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, untrustedContentHint: true },
    execute: () => ({
      connected,
      model: settings.model,
      method: settings.method,
      ...thresholds(),
      result: currentResult,
    }),
  });
  register({
    name: "set_decision_thresholds",
    description:
      "Change review and block thresholds and update the current visible classification without calling AI.",
    inputSchema: {
      type: "object",
      properties: {
        review: { type: "number", minimum: 0, maximum: 1 },
        block: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["review", "block"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: (input) => {
      if (
        !input ||
        !Number.isFinite(input.review) ||
        !Number.isFinite(input.block) ||
        input.review < 0 ||
        input.block > 1 ||
        input.review >= input.block
      )
        throw new Error("검토 기준은 0 이상이며 차단 기준보다 작아야 합니다.");
      $("low").value = input.review;
      $("high").value = input.block;
      refreshThresholds();
      return {
        ...thresholds(),
        decision: currentResult ? decision(currentResult) : null,
      };
    },
  });
  window.addEventListener("pagehide", () => lifecycle.abort(), { once: true });
}
