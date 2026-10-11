/**
 * 자유 성능평가의 계산 전용 모듈. 화면(DOM)이나 모델 API를 호출하지 않는다.
 * 동일한 config/rows/opts를 주면 동일한 지표를 반환하므로 Node에서도 직접 테스트할 수 있다.
 * 브라우저에서는 EvaluationMetrics, Node에서는 module.exports로 같은 함수를 제공한다.
 *
 * 입력 rows의 한 건: {expected: 사람이 지정한 정답, elapsed: 종단간 초, result: 서버 응답}.
 * config: category/criteria 등 실험 조건. opts: 판정 기준·검토 기준 등 재집계 조건.
 * 핵심 원칙: 0은 실제 계산 결과, null은 계산 불가다. 빠진 점수·시간을 0으로 채우지 않는다.
 * 읽는 순서: labels/truth/prediction → calibration/roc → summarize.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EvaluationMetrics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";
  /**
   * 평균에는 유효한 숫자 배열을 전달한다. 빈 평균·0으로 나누는 비율은 null로 남긴다.
   * UI는 null을 "—"로 표시하므로 표본이 없는데 정확도 0% 또는 지연 0초로 오해하지 않는다.
   */
  const num = (x) => typeof x === "number" && Number.isFinite(x);
  const mean = (a) =>
    a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
  const divide = (n, d) => (d ? n / d : null);
  /**
   * 분위수: 값을 정렬한 뒤 (N-1)×q 위치의 양옆 표본을 선형 보간한다.
   * q=0.5는 중앙값(p50), q=0.95는 p95. 예: [1, 2, 3]의 p95는 2.9다.
   * p95는 이 값보다 느린 요청이 약 5% 있다는 뜻이며, 가장 느린 5%의 평균은 아니다.
   * 입력은 호출부에서 측정한 초 단위 값이며 유효한 숫자가 없으면 null을 반환한다.
   */
  function quantile(values, q) {
    const a = values.filter(num).sort((a, b) => a - b);
    if (!a.length) return null;
    const i = (a.length - 1) * q,
      lo = Math.floor(i);
    return a[lo] + (a[Math.ceil(i)] - a[lo]) * (i - lo);
  }
  /**
   * 카테고리별 정답 ID를 통일한다. Choice는 사용자 ID, Score는 단계 번호의 문자열,
   * Noul은 false/true 순서다. 이 순서가 혼동행렬의 행·열과 클래스별 표의 순서를 정한다.
   */
  function labels(config) {
    return config.category === "choice"
      ? Object.keys(config.criteria)
      : config.category === "score"
        ? config.criteria.map((_, i) => String(i))
        : ["false", "true"];
  }
  /**
   * 집계에 넣을 수 있는 성공 응답인지 방어적으로 확인한다.
   * 서버에서 상세 스키마 검증을 마쳤더라도 필수 확률·범위·합계를 다시 확인한다.
   * 오류 응답은 정확도 채점에서 빼지만 summarize의 실패율에서는 별도로 센다.
   */
  function valid(result, keys) {
    return (
      result?.status === "ok" &&
      result.probabilities &&
      keys.every(
        (k) =>
          num(result.probabilities[k]) &&
          result.probabilities[k] >= 0 &&
          result.probabilities[k] <= 1,
      ) &&
      Math.abs(keys.reduce((s, k) => s + result.probabilities[k], 0) - 1) <
        0.002
    );
  }
  /**
   * 확률에서 최종 분류 ID를 정한다. Noul은 현재 사용자가 지정한 참 판정 임계값을 쓴다.
   * Choice 전용 API가 반환한 유효한 선택은 보존한다. 표시 확률이 반올림으로 동률이 되어도
   * 선택지를 배열 순서로 다시 골라 원래 응답을 바꾸지 않기 위해서다.
   * Score의 분류용 예측은 최고 확률 단계다. 수치 오차에는 별도의 기대 점수 r.value를 쓴다.
   */
  function prediction(r, config, opts) {
    const keys = labels(config),
      p = r.probabilities;
    if (config.category === "choice" && keys.includes(r.value)) return r.value;
    return config.category === "noul"
      ? p.true >= opts.threshold
        ? "true"
        : "false"
      : keys.reduce((a, b) => (p[b] > p[a] ? b : a));
  }
  /**
   * 사용자 정답을 분류 ID로 바꾼다. 빈 값·알 수 없는 ID는 null로 반환한다.
   * Noul은 boolean과 문자열 true/false를 모두 받는다.
   * Score 소수 정답(예: 1.5)은 분류 클래스가 아니므로 여기서는 제외하고 MAE/RMSE에만 쓴다.
   */
  function truth(value, config) {
    if (value === null || value === undefined || value === "") return null;
    if (config.category === "noul")
      return value === true || value === "true"
        ? "true"
        : value === false || value === "false"
          ? "false"
          : null;
    return labels(config).includes(String(value)) ? String(value) : null;
  }
  /**
   * ECE(기대 보정 오차)와 신뢰도 그래프용 구간 통계를 계산한다.
   * 호출부가 고른 {confidence: 0~1, correct: 정답 여부}를 같은 너비의 bins개 구간에 넣는다.
   * 각 구간의 평균 확신도와 실제 정답률을 비교한다.
   * ECE = Σ (구간 표본 수 / 전체 표본 수) × |구간 정답률 - 구간 평균 확신도|.
   * 예: 모두 0.9를 냈는데 80%만 맞으면 해당 구간의 차이는 0.1이다.
   * 이는 값을 보정하는 학습 코드가 아니라 현재 데이터에서 보정 상태를 측정하는 코드다.
   * 빈 구간의 평균은 null, 전체 표본이 없으면 ECE도 null이다.
   */
  function calibration(rows, bins = 10) {
    const out = Array.from({ length: bins }, (_, i) => ({
      low: i / bins,
      high: (i + 1) / bins,
      n: 0,
      confidence: 0,
      accuracy: 0,
    }));
    for (const r of rows) {
      if (!num(r.confidence)) continue;
      /**
       * 확률 1.0은 floor(1×bins)=bins로 범위를 벗어나므로 마지막 구간에 포함한다.
       * 나머지는 [low, high) 구간이다. 호출부에서 이미 유효한 0~1 값만 전달한다.
       */
      const b = out[Math.min(bins - 1, Math.floor(r.confidence * bins))];
      b.n++;
      b.confidence += r.confidence;
      b.accuracy += r.correct ? 1 : 0;
    }
    const n = out.reduce((s, b) => s + b.n, 0);
    for (const b of out) {
      b.confidence = b.n ? b.confidence / b.n : null;
      b.accuracy = b.n ? b.accuracy / b.n : null;
    }
    return {
      n,
      bins: out,
      ece: n
        ? out.reduce(
            (s, b) =>
              s + (b.n ? (b.n / n) * Math.abs(b.accuracy - b.confidence) : 0),
            0,
          )
        : null,
    };
  }
  /**
   * 한 선택지를 양성으로 보는 이진 ROC, AUC, AP를 계산한다.
   * rows = [{score: 양성 확률, positive: 실제 양성 여부}, ...].
   * 점수가 높은 순서로 임계값을 내리며 TPR=TP/실제 양성 수, FPR=FP/실제 음성 수를 기록한다.
   * AUC는 ROC 아래 면적(사다리꼴 적분), AP는 recall 증가분으로 가중한 precision 합이다.
   * 양성이나 음성이 하나도 없으면 ROC를 평가할 수 없으므로 AUC/AP를 null로 둔다.
   */
  function roc(rows) {
    const sorted = rows
        .filter((r) => num(r.score))
        .sort((a, b) => b.score - a.score),
      P = sorted.filter((r) => r.positive).length,
      N = sorted.length - P;
    if (!P || !N)
      return { auc: null, ap: null, points: [], positive: P, negative: N };
    let tp = 0,
      fp = 0,
      area = 0,
      ap = 0,
      prev = { fpr: 0, tpr: 0 };
    /**
     * 시작점은 아무것도 양성으로 분류하지 않은 (0,0)이다.
     * threshold=null은 관측 최고 점수보다 높은 기준이라는 표시이며 측정 누락을 뜻하지 않는다.
     */
    const points = [{ threshold: null, fpr: 0, tpr: 0, precision: 1 }];
    for (let i = 0; i < sorted.length; ) {
      const v = sorted[i].score;
      /**
       * 동점은 한꺼번에 처리한다. 하나씩 처리하면 입력 배열 순서에 따라 AUC가 달라질 수 있다.
       */
      while (i < sorted.length && sorted[i].score === v) {
        sorted[i].positive ? tp++ : fp++;
        i++;
      }
      const cur = {
        threshold: v,
        fpr: fp / N,
        tpr: tp / P,
        precision: tp / (tp + fp),
      };
      area += ((cur.fpr - prev.fpr) * (cur.tpr + prev.tpr)) / 2;
      ap += (cur.tpr - prev.tpr) * cur.precision;
      points.push(cur);
      prev = cur;
    }
    return { auc: area, ap, points, positive: P, negative: N };
  }
  /**
   * 모델 하나의 모든 요청을 집계한다. 호출부가 modelId별로 rows를 먼저 나눈다.
   * rows에는 실제 요청한 건만 들어가며 준비 실행(warmup)과 미실행 건은 들어오지 않는다.
   * 정확도·ECE에는 정답이 있는 성공 응답만, 실패율·종단간 지연에는 실패 요청도 사용한다.
   * 수동 정답이 없어도 응답 성공 여부·속도·검토율은 비교할 수 있다.
   * opts를 바꾸어 다시 호출하면 모델을 재실행하지 않고 같은 응답을 다른 기준으로 평가한다.
   */
  function summarize(config, rows, opts = {}) {
    opts = {
      threshold: 0.5,
      referral: 0.6,
      bins: 10,
      basis: "api",
      positive: config.category === "noul" ? "true" : labels(config)[0],
      ...opts,
    };
    /**
     * 1. 성공 여부와 정답 유무를 나눈다.
     * prob는 실제로 선택한 답의 확률이다. Noul 기준을 높여 false를 택하면 1-p(true)를 쓴다.
     * confidence는 검토율에 사용할 값: API 값을 선택했고 값이 존재하면 그것을,
     * 그렇지 않으면 prob를 사용한다. api_confidence 원본은 변경하지 않는다.
     */
    const keys = labels(config),
      ok = rows.filter((r) => valid(r.result, keys)),
      items = ok.map((r) => {
        const predicted = prediction(r.result, config, opts),
          gold = truth(r.expected, config),
          prob = r.result.probabilities[predicted];
        return {
          ...r,
          predicted,
          gold,
          correct: predicted === gold,
          prob,
          confidence:
            opts.basis === "api" && num(r.result.api_confidence)
              ? r.result.api_confidence
              : prob,
        };
      }),
      known = items.filter((r) => r.gold !== null);
    /**
     * 2. 혼동행렬: 행=실제 정답, 열=모델 예측. 대각선이 정답 건수다.
     * 정답 없는 성공 응답은 known에 없으므로 틀렸다고 채점하지 않는다.
     */
    const matrix = keys.map(() => keys.map(() => 0));
    known.forEach(
      (r) => matrix[keys.indexOf(r.gold)][keys.indexOf(r.predicted)]++,
    );
    /**
     * 클래스별 TP는 대각선, support는 해당 행 합(실제 건수), pred는 해당 열 합(예측 건수).
     * Precision=TP/pred, Recall=TP/support, F1=2×TP/(support+pred).
     * 분모가 없는 Precision/Recall은 null, 실제·예측 모두 없는 클래스의 F1은 0으로 정의한다.
     * macro-F1은 설정된 모든 클래스 F1의 단순 평균이므로 소수 클래스도 같은 비중을 갖는다.
     */
    const classes = keys.map((label, i) => {
      const tp = matrix[i][i],
        support = matrix[i].reduce((a, b) => a + b, 0),
        pred = matrix.reduce((s, r) => s + r[i], 0),
        precision = divide(tp, pred),
        recall = divide(tp, support);
      return {
        label,
        support,
        predicted: pred,
        precision,
        recall,
        f1: support + pred ? (2 * tp) / (support + pred) : 0,
      };
    });
    /**
     * 3. 사람이 확인할 건과 자동 처리할 수 있는 건을 가른다. 기준과 같은 확신도는 자동 처리 쪽.
     * 정답을 몰라도 검토 여부는 정할 수 있으므로 items 전체를 사용한다.
     * 자동 처리 정확도(selectiveAccuracy)를 계산할 때만 정답 있는 retainedKnown으로 좁힌다.
     */
    const retained = items.filter((r) => r.confidence >= opts.referral),
      retainedKnown = retained.filter((r) => r.gold !== null),
      referrals = items.length - retained.length;
    /**
     * 4. 스키마 위반율의 분모는 schema_valid가 true 또는 false인 응답만이다.
     * 연결 실패처럼 null인 응답은 형식을 검사하지 못했으므로 제외한다.
     * 그 실패들은 아래 failureRate와 totalReviewRate에서 사라지지 않고 집계된다.
     */
    const schemaChecked = rows.filter(
        (r) => typeof r.result?.schema_valid === "boolean",
      ),
      violations = schemaChecked.filter(
        (r) => r.result.schema_valid === false,
      ).length;
    /**
     * Accuracy = 정답 건수 / 정답 있는 성공 응답 수.
     * effectiveAccuracy = 같은 정답 건수 / 정답 있는 전체 요청 수(실패 포함).
     * 두 값을 같이 보여야 실패를 많이 낸 모델의 성공 응답만 보고 성능을 과대평가하지 않는다.
     */
    const allKnown = rows.filter((r) => truth(r.expected, config) !== null),
      correct = known.filter((r) => r.correct).length;
    /**
     * 5. 선택한 클래스를 양성, 나머지를 음성으로 보는 OvR(one-vs-rest) ROC.
     * 분류 결과가 아닌 원래 확률을 쓰므로 Noul 판정 기준을 바꾸어도 ROC 자체는 변하지 않는다.
     * macro-AUC는 모든 클래스에서 AUC가 계산될 때만 평균한다.
     */
    const curve = roc(
      known.map((r) => ({
        score: r.result.probabilities[opts.positive],
        positive: r.gold === opts.positive,
      })),
    );
    const aucs = keys.map(
      (k) =>
        roc(
          known.map((r) => ({
            score: r.result.probabilities[k],
            positive: r.gold === k,
          })),
        ).auc,
    );
    /**
     * 6. Score 수치 평가에는 소수 정답도 포함한다. 예측값은 최고 확률 단계가 아니라 기대 점수.
     * MAE=절대 오차 평균, RMSE=제곱 오차 평균의 제곱근으로 큰 오차에 더 민감하다.
     * 단계 수나 범위가 다른 질문끼리는 같은 MAE 숫자를 곧바로 비교할 수 없다.
     */
    const scoreRows =
      config.category === "score"
        ? items.filter(
            (r) =>
              num(r.expected) &&
              r.expected >= 0 &&
              r.expected <= keys.length - 1,
          )
        : [];
    const mae = mean(
        scoreRows.map((r) => Math.abs(r.result.value - r.expected)),
      ),
      rmse = scoreRows.length
        ? Math.sqrt(
            mean(scoreRows.map((r) => (r.result.value - r.expected) ** 2)),
          )
        : null;
    /**
     * 7. Brier는 확률과 실제 정답의 차이를 제곱한 평균(낮을수록 좋음).
     * Noul은 참 확률 하나의 제곱 오차, 다중 분류는 클래스별 제곱 오차를 합산한다.
     * 후자는 2로 나누지 않는 정의이므로 이진 Noul과 수치 범위가 다르다.
     */
    const brier = mean(
      known.map((r) =>
        config.category === "noul"
          ? (r.result.probabilities.true - (r.gold === "true" ? 1 : 0)) ** 2
          : keys.reduce(
              (s, k) =>
                s + (r.result.probabilities[k] - (r.gold === k ? 1 : 0)) ** 2,
              0,
            ),
      ),
    );
    /**
     * 8. 검토 기준을 0~1에서 0.05 간격으로 바꿔 자동 처리 범위와 오답 위험의 관계를 그린다.
     * 이 곡선의 coverage 분모는 정답 있는 성공 응답(known)이다.
     * 아래 요약표 coverage의 분모(전체 요청)와 다르며, 곡선은 채점 가능한 표본 안의 관계를 보여준다.
     * 자동 처리할 표본이 0개이면 risk를 0으로 꾸미지 않고 null로 남긴다.
     */
    const risk = Array.from({ length: 21 }, (_, i) => {
      const threshold = i / 20,
        accepted = known.filter((r) => r.confidence >= threshold);
      return {
        threshold,
        coverage: divide(accepted.length, known.length),
        risk: accepted.length
          ? 1 - accepted.filter((r) => r.correct).length / accepted.length
          : null,
      };
    });
    const errors = {};
    rows
      .filter((r) => !valid(r.result, keys))
      .forEach((r) => {
        const key = r.result?.error_kind || "transport";
        errors[key] = (errors[key] || 0) + 1;
      });
    return {
      attempts: rows.length,
      success: ok.length,
      labeled: known.length,
      allLabeled: allKnown.length,
      accuracy: divide(correct, known.length),
      effectiveAccuracy: divide(correct, allKnown.length),
      macroF1: known.length ? mean(classes.map((c) => c.f1)) : null,
      classes,
      matrix,
      probCalibration: calibration(
        known.map((r) => ({ confidence: r.prob, correct: r.correct })),
        opts.bins,
      ),
      confidenceCalibration: calibration(
        known.map((r) => ({ confidence: r.confidence, correct: r.correct })),
        opts.bins,
      ),
      schemaChecked: schemaChecked.length,
      schemaViolations: violations,
      schemaRate: divide(violations, schemaChecked.length),
      failureRate: divide(rows.length - ok.length, rows.length),
      errors,
      referrals,
      /**
       * 검토율은 성공 응답 중 낮은 확신도의 비율.
       * 전체 검토 부담은 실패 요청도 모두 검토 대상으로 보고 전체 요청을 분모로 쓴다.
       */
      referralRate: divide(referrals, items.length),
      totalReviewRate: divide(referrals + rows.length - ok.length, rows.length),
      coverage: divide(retained.length, rows.length),
      selectiveAccuracy: divide(
        retainedKnown.filter((r) => r.correct).length,
        retainedKnown.length,
      ),
      retainedLabeled: retainedKnown.length,
      /**
       * 시간 지표는 정답 유무와 무관하고 실패 요청의 대기 시간도 포함한다.
       * 실제 수치가 있는 시간만 사용한다. 표본이 작아도 분위수는 나오지만 p95 추정은 불안정하다.
       * 준비/추론 시간은 실행기가 값을 제공한 성공 응답에서만 계산한다.
       */
      latencyN: rows.filter((r) => num(r.elapsed)).length,
      p50: quantile(
        rows.map((r) => r.elapsed),
        0.5,
      ),
      p95: quantile(
        rows.map((r) => r.elapsed),
        0.95,
      ),
      loadP50: quantile(
        ok.map((r) => r.result.timing?.load_seconds),
        0.5,
      ),
      inferenceP50: quantile(
        ok.map((r) => r.result.timing?.inference_seconds),
        0.5,
      ),
      curve,
      macroAuc: aucs.every(num) ? mean(aucs) : null,
      brier,
      mae,
      rmse,
      scoreN: scoreRows.length,
      risk,
      items,
    };
  }
  return {
    num,
    mean,
    quantile,
    labels,
    valid,
    prediction,
    truth,
    calibration,
    roc,
    summarize,
  };
});
