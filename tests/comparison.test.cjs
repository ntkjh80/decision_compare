// 화면·모델 없이 계산 모듈을 직접 검사한다. 수동 계산 가능한 표본으로 정의와 분모를 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../dist/comparison-metrics.js");
const models = [
  { id: "a", low: 0.25, high: 0.6 },
  { id: "b", low: 0.25, high: 0.6 },
];
// 경계값·불확실성·오류를 각각 구분한다. 실패를 반출 가능으로 바꾸지 않는 것이 핵심이다.
test("boundaries and uncertainty preserve human review", () => {
  assert.equal(M.outcome({ score: 0.249 }, models[0]), "candidate");
  assert.equal(M.outcome({ score: 0.25 }, models[0]), "review");
  assert.equal(M.outcome({ score: 0.6 }, models[0]), "block");
  assert.equal(
    M.outcome({ score: 0.01, uncertain: true }, models[0]),
    "review",
  );
  for (const r of [
    null,
    { error: "timeout" },
    { score: NaN },
    { score: 2 },
    { score: true },
  ])
    assert.equal(M.outcome(r, models[0]), null);
});
// 모든 모델이 완료한 문서만 행동 일치 여부를 비교한다. 부분 완료는 일치로 추정하지 않는다.
test("partial comparisons never claim agreement; all three actions are compared", () => {
  const batch = {
    models,
    docs: [{}, {}, {}],
    results: {
      "a:0": { score: 0.1 },
      "b:0": { score: 0.9 },
      "a:1": { score: 0.1 },
      "b:1": { error: "bad" },
      "a:2": { score: 0.1 },
    },
  };
  assert.deepEqual(M.agreement(batch), { comparable: 1, different: 1 });
  batch.results["b:2"] = { score: 0.2 };
  assert.deepEqual(M.agreement(batch), { comparable: 2, different: 1 });
});
// 기밀/공개별 정답 표본과 실패·대기·정답 미지정을 섞어 분모가 잘못 늘어나지 않는지 검사한다.
test("quality denominators exclude errors, unknown truth and pending rows", () => {
  const batch = {
    models,
    docs: [
      { label: "confidential" },
      { label: "confidential" },
      { label: "public" },
      { label: null },
      { label: "public" },
    ],
    results: {
      "a:0": { score: 0.1, timing: { inference_seconds: 0.2 } },
      "a:1": { error: "bad" },
      "a:2": { score: 0.7, timing: { inference_seconds: 0.4 } },
      "a:3": { score: 0.4 },
    },
  };
  assert.deepEqual(M.modelSummary(batch, models[0]), {
    completed: 3,
    total: 5,
    errors: 1,
    missing: 1,
    secretTotal: 1,
    missed: 1,
    publicTotal: 1,
    held: 1,
    review: 1,
    inferenceMedian: 0.30000000000000004,
    timed: 2,
  });
});
// 누락 시간은 미측정으로 남고 기준 변경은 원시 점수를 바꾸지 않는지 검사한다.
test("no timing stays unknown and threshold edits reclassify without changing scores", () => {
  assert.equal(M.median([undefined, null, NaN, -1]), null);
  assert.equal(M.median([0, 0.2, 0.1]), 0.1);
  const r = { score: 0.7 };
  assert.equal(M.outcome(r, { low: 0.25, high: 0.8 }), "review");
  assert.equal(r.score, 0.7);
});
