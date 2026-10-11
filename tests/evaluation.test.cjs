// 화면·모델 없이 계산 모듈을 직접 검사한다. 수동 계산 가능한 표본으로 정의와 분모를 확인한다.
const test = require("node:test"),
  assert = require("node:assert/strict"),
  M = require("../dist/evaluation-metrics.js");
const choice = { category: "choice", criteria: { a: "A", b: "B" } };
const row = (expected, p, extra = {}) => ({
  expected,
  elapsed: 1,
  result: {
    status: "ok",
    schema_valid: true,
    probabilities: { a: p, b: 1 - p },
    api_confidence: Math.abs(2 * p - 1),
  },
  ...extra,
});
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} ≠ ${b}`);
// 성공·실패·정답 미지정이 섞인 예제에서 정확도와 실패 포함 정확도의 분모를 확인한다.
test("Accuracy, per-class metrics, macro-F1 and effective accuracy use distinct denominators", () => {
  const s = M.summarize(choice, [
    row("a", 0.9),
    row("b", 0.8),
    row("b", 0.1),
    row(null, 0.6),
    {
      expected: "a",
      elapsed: 10,
      result: { status: "error", error_kind: "transport", schema_valid: null },
    },
  ]);
  close(s.accuracy, 2 / 3);
  close(s.effectiveAccuracy, 0.5);
  close(s.macroF1, 2 / 3);
  assert.deepEqual(s.matrix, [
    [1, 0],
    [1, 1],
  ]);
  assert.equal(s.allLabeled, 4);
  assert.equal(s.success, 4);
  assert.equal(s.schemaRate, 0);
  close(s.failureRate, 0.2);
});
// 확률 1도 마지막 ECE 구간에 포함되며 빈 구간/빈 데이터가 가짜 0 오차로 표시되지 않는지 검사한다.
test("ECE includes p=1 in final bin; empty bins and unlabeled examples excluded", () => {
  const c = M.calibration(
    [
      { confidence: 0.9, correct: true },
      { confidence: 0.9, correct: false },
      { confidence: 1, correct: true },
    ],
    10,
  );
  assert.equal(c.n, 3);
  assert.equal(c.bins[9].n, 3);
  close(c.ece, 4 / 15);
  assert.equal(M.calibration([]).ece, null);
});
// 동점 처리 순서에 AUC가 좌우되지 않으며 AP의 계단식 가중 합이 맞는지 확인한다.
test("ROC uses all score ties as one group and AP is step-weighted precision", () => {
  const c = M.roc([
    { score: 0.9, positive: true },
    { score: 0.9, positive: false },
    { score: 0.2, positive: true },
    { score: 0.1, positive: false },
  ]);
  close(c.auc, 0.625);
  close(c.ap, 7 / 12);
  assert.equal(c.points.length, 4);
  assert.equal(M.roc([{ score: 0.9, positive: true }]).auc, null);
});
// Noul 기준만 바꾸면 분류·검토율은 바뀌어도 원시 양성 확률의 ROC는 유지되어야 한다.
test("Noul threshold changes predictions, predicted confidence, review and errors without changing ROC", () => {
  const config = { category: "noul", criteria: { true: "yes", false: "no" } },
    rows = [
      {
        expected: true,
        elapsed: 1,
        result: {
          status: "ok",
          schema_valid: true,
          value: 0.6,
          probabilities: { true: 0.6, false: 0.4 },
        },
      },
      {
        expected: false,
        elapsed: 3,
        result: {
          status: "ok",
          schema_valid: true,
          value: 0.2,
          probabilities: { true: 0.2, false: 0.8 },
        },
      },
    ];
  const a = M.summarize(config, rows, { threshold: 0.5, referral: 0.5 }),
    b = M.summarize(config, rows, { threshold: 0.7, referral: 0.5 });
  assert.equal(a.accuracy, 1);
  assert.equal(b.accuracy, 0.5);
  assert.equal(a.referralRate, 0);
  assert.equal(b.referralRate, 0.5);
  assert.equal(a.curve.auc, b.curve.auc);
  close(a.brier, 0.1);
});
// Score의 1.5 같은 소수 정답은 회귀 오차에 포함하되 단계 분류 지표에서는 제외한다.
test("Score expected-value regression includes fractional gold, classification excludes it", () => {
  const config = { category: "score", criteria: ["low", "mid", "high"] };
  const rows = [
    {
      expected: 2,
      elapsed: 1,
      result: {
        status: "ok",
        schema_valid: true,
        probabilities: { 0: 0.1, 1: 0.6, 2: 0.3 },
        value: 1.2,
      },
    },
    {
      expected: 1.5,
      elapsed: 2,
      result: {
        status: "ok",
        schema_valid: true,
        probabilities: { 0: 0, 1: 0.5, 2: 0.5 },
        value: 1.5,
      },
    },
  ];
  const s = M.summarize(config, rows);
  assert.equal(s.scoreN, 2);
  assert.equal(s.labeled, 1);
  assert.equal(s.accuracy, 0);
  close(s.mae, 0.4);
  close(s.rmse, Math.sqrt(0.32));
});
// 통신 실패는 스키마 위반율에서는 제외하지만 전체 실패·검토 부담·지연에서는 포함한다.
test("Schema violation rate excludes transport failures and records all failures as review needs", () => {
  const rows = [
    row("a", 0.9),
    {
      expected: "a",
      elapsed: 2,
      result: { status: "error", error_kind: "schema", schema_valid: false },
    },
    {
      expected: "b",
      elapsed: 3,
      result: { status: "error", error_kind: "transport", schema_valid: null },
    },
  ];
  const s = M.summarize(choice, rows, { referral: 0.9 });
  close(s.schemaRate, 0.5);
  close(s.failureRate, 2 / 3);
  assert.equal(s.totalReviewRate, 1);
  assert.equal(s.selectiveAccuracy, null);
  assert.equal(s.p50, 2);
  close(s.p95, 2.9);
});
// 표본 없는 지표는 null이다. 정확도 0% 또는 응답 0초로 오해하게 만들지 않는다.
test("No data means undefined metrics, no fake zero score or latency", () => {
  const s = M.summarize(choice, []);
  for (const key of [
    "accuracy",
    "macroF1",
    "p50",
    "p95",
    "schemaRate",
    "mae",
    "brier",
    "coverage",
  ])
    assert.equal(s[key], null);
  assert.equal(M.quantile([null, undefined], 0.5), null);
});
// 같은 응답이라도 선택 확률과 별도 Confidence의 ECE 및 검토 여부가 다름을 확인한다.
test("API confidence and selected probability calibrations remain distinct", () => {
  const s = M.summarize(choice, [row("a", 0.9)], {
      referral: 0.85,
      basis: "api",
    }),
    p = M.summarize(choice, [row("a", 0.9)], {
      referral: 0.85,
      basis: "probability",
    });
  close(s.probCalibration.ece, 0.1);
  close(s.confidenceCalibration.ece, 0.2);
  assert.equal(s.referralRate, 1);
  assert.equal(p.referralRate, 0);
});

// 반올림으로 확률이 동률이어도 전용 API가 반환한 Choice 답을 보존해야 한다.
test("Rounded tied probabilities preserve the native Choice answer", () => {
  const r = row("b", 0.5);
  r.result.value = "b";
  assert.equal(M.summarize(choice, [r]).accuracy, 1);
});
