"use strict";
/**
 * 기존 기밀 문서 비교 화면의 계산 전용 모듈.
 * 자유 평가의 다중 클래스 지표는 evaluation-metrics.js에 있고,
 * 여기는 기밀 누락·공개 문서 과잉 검토·모델 간 업무 행동 일치 여부를 계산한다.
 * 브라우저와 Node 테스트가 같은 구현을 쓰며 실패·미실행을 성공으로 세지 않는다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ComparisonMetrics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /**
   * 오류가 없고 점수가 실제 0~1 숫자인 응답만 유효하다. 미실행 결과(undefined)는 제외한다.
   */
  function valid(r) {
    return Boolean(
      r && !r.error && Number.isFinite(r.score) && r.score >= 0 && r.score <= 1,
    );
  }
  /**
   * 모델별 low/high를 적용해 가능 후보·검토·차단 중 하나를 반환한다.
   * 불확실 응답은 점수보다 사람 검토를 우선한다. 실패는 행동을 추정하지 않고 null로 둔다.
   */
  function outcome(r, p) {
    if (!valid(r)) return null;
    if (r.uncertain) return "review";
    return r.score >= p.high
      ? "block"
      : r.score >= p.low
        ? "review"
        : "candidate";
  }
  /**
   * 유효한 0 이상 시간만 정렬해 가운데 값을 구한다. 짝수 개면 중앙 두 값의 평균, 없으면 null.
   */
  function median(values) {
    const a = values
      .filter((v) => Number.isFinite(v) && v >= 0)
      .sort((a, b) => a - b);
    const n = a.length;
    return n ? (a[Math.floor((n - 1) / 2)] + a[Math.floor(n / 2)]) / 2 : null;
  }
  /**
   * p는 모델 프로필(모델 ID와 기준), batch는 문서 목록과 모델별 결과다.
   * 기밀 누락률의 분모는 정답이 기밀인 성공 응답, 공개 과잉 검토의 분모는 공개인 성공 응답이다.
   * 공개 문서를 사람 검토로 보내는 것도 이 화면에서는 불필요하게 붙잡은 건으로 센다.
   * 오류·미실행·실제 시간 제공 건수를 따로 반환해 각 수치의 분모를 확인할 수 있게 한다.
   */
  function modelSummary(batch, p) {
    const rows = batch.docs.map((d, i) => ({
      d,
      r: batch.results[p.id + ":" + i],
    }));
    const ok = rows.filter((x) => valid(x.r));
    const secrets = ok.filter((x) => x.d.label === "confidential");
    const publics = ok.filter((x) => x.d.label === "public");
    const times = ok
      .map((x) => x.r.timing?.inference_seconds)
      .filter((v) => Number.isFinite(v) && v >= 0);
    const errors = rows.filter((x) => x.r && !valid(x.r)).length;
    return {
      completed: ok.length,
      total: rows.length,
      errors,
      missing: rows.length - ok.length - errors,
      secretTotal: secrets.length,
      missed: secrets.filter((x) => outcome(x.r, p) === "candidate").length,
      publicTotal: publics.length,
      held: publics.filter((x) => outcome(x.r, p) !== "candidate").length,
      review: ok.filter((x) => outcome(x.r, p) === "review").length,
      inferenceMedian: median(times),
      timed: times.length,
    };
  }
  /**
   * 두 모델 이상이 모두 유효한 응답을 낸 같은 문서만 비교한다.
   * 비교 대상은 원시 점수가 아니라 각 모델 기준을 적용한 최종 행동이다.
   * 모두 동의했다는 것은 정답이라는 뜻이 아니므로 정확도와 별도로 표시한다.
   */
  function agreement(batch) {
    let comparable = 0,
      different = 0;
    if (batch.models.length < 2) return { comparable, different };
    batch.docs.forEach((d, i) => {
      const actions = batch.models.map((p) =>
        outcome(batch.results[p.id + ":" + i], p),
      );
      if (actions.some((a) => a === null)) return;
      comparable++;
      if (new Set(actions).size > 1) different++;
    });
    return { comparable, different };
  }
  return { valid, outcome, median, modelSummary, agreement };
});
