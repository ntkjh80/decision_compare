# 회귀 테스트: 앱의 계약과 오류 처리를 고정된 예제로 검사한다. 학습된 모델의 정확도 평가는 아니다.
import json
import math
import unittest
from unittest.mock import patch
import server


class DecisionTests(unittest.TestCase):
    # 각 테스트의 기본 요청을 만들고 extra로 필요한 조건만 바꾼다. 실제 사용자 문서는 사용하지 않는다.
    def body(self, **extra):
        return dict(
            {
                "provider": "ollama",
                "base_url": "http://127.0.0.1:11434",
                "model": "qwen3.5:4b",
                "text": "미공개 계약 금액은 100원입니다.",
                "rules": True,
                "method": "tokens",
                "low": 0.25,
                "high": 0.6,
            },
            **extra,
        )

    # 외부 주소·위장 주소·리다이렉트가 문서 전송 대상으로 통과하지 않는지 확인한다.
    def test_remote_and_redirect_addresses_rejected(self):
        for url in [
            "https://example.com",
            "http://example.com:1234",
            "http://localhost.example.com:12",
            "http://127.0.0.1:23/path",
            "http://name@127.0.0.1:3",
            "http://127.0.0.1:4?x=1",
            "file:///etc/passwd",
        ]:
            with self.assertRaises(server.AppError):
                server.local_url(url)
        self.assertEqual(
            server.local_url("http://localhost:8080"), "http://127.0.0.1:8080"
        )

    # 두 답의 상대 확률 계산과, 한 답이 없을 때 추측하지 않는 동작을 확인한다.
    def test_token_normalization_and_missing_option(self):
        score, mass = server.normalize_logprobs(
            [
                {"token": "A", "logprob": math.log(0.3)},
                {"token": "B", "logprob": math.log(0.1)},
            ]
        )
        self.assertAlmostEqual(score, 0.75)
        self.assertAlmostEqual(mass, 0.4)
        with self.assertRaises(server.AppError):
            server.normalize_logprobs([{"token": "A", "logprob": -0.1}])

    # 공백 토큰 변형은 합산하고 정상 확률로 쓸 수 없는 값은 거르는지 확인한다.
    def test_token_variants_and_invalid_numbers(self):
        score, _ = server.normalize_logprobs(
            [
                {"token": "A", "logprob": math.log(0.2)},
                {"token": " A", "logprob": math.log(0.1)},
                {"token": "B", "logprob": math.log(0.3)},
            ]
        )
        self.assertAlmostEqual(score, 0.5)
        with self.assertRaises(server.AppError):
            server.number(float("nan"), "test", 0, 1)

    # 임계값과 같은 점수의 경계 처리, 점수 없음·불확실 응답의 사람 검토 우선순위를 확인한다.
    def test_decision_boundaries_and_fail_closed(self):
        self.assertEqual(server.classify(0.249, 0.25, 0.6), "candidate")
        self.assertEqual(server.classify(0.25, 0.25, 0.6), "review")
        self.assertEqual(server.classify(0.6, 0.25, 0.6), "block")
        self.assertEqual(server.classify(None, 0.25, 0.6), "review")
        self.assertEqual(server.classify(0.01, 0.25, 0.6, uncertain=True), "review")

    # 규칙 차단은 모델을 호출하지 않으며 가짜 AI 점수를 만들지 않는지 확인한다.
    def test_rules_skip_model(self):
        with patch("server.remote") as remote:
            result = server.analyze(self.body(text="-----BEGIN PRIVATE KEY-----"))
            self.assertEqual(result["decision"], "block")
            self.assertIsNone(result["score"])
            remote.assert_not_called()

    # 평범한 이름의 원격 별칭도 메타데이터 단계에서 막고 문서를 보내지 않는지 확인한다.
    def test_cloud_alias_rejected_before_document(self):
        with patch(
            "server.remote", return_value={"remote_host": "https://ollama.com"}
        ) as remote:
            with self.assertRaises(server.AppError):
                server.analyze(self.body())
            self.assertEqual(remote.call_count, 1)
            self.assertEqual(remote.call_args[0][1], "/api/show")

    # A/B 안의 상대 점수가 높아도 원래 후보 확률 합이 낮으면 검토로 보내는지 확인한다.
    def test_ollama_low_option_mass_forces_review(self):
        response = {
            "logprobs": [
                {
                    "top_logprobs": [
                        {"token": "A", "logprob": math.log(0.09)},
                        {"token": "B", "logprob": math.log(0.01)},
                    ]
                }
            ]
        }
        with patch("server.remote", side_effect=[{}, response]):
            result = server.analyze(self.body())
            self.assertEqual(result["decision"], "review")
            self.assertTrue(result["uncertain"])

    # llama.cpp 호환 응답의 중첩 로그확률 경로를 실제 어댑터가 읽는지 확인한다.
    def test_llama_response_compatibility(self):
        response = {
            "choices": [
                {
                    "logprobs": {
                        "content": [
                            {
                                "top_logprobs": [
                                    {"token": "A", "logprob": math.log(0.9)},
                                    {"token": "B", "logprob": math.log(0.1)},
                                ]
                            }
                        ]
                    }
                }
            ]
        }
        with patch("server.remote", return_value=response):
            result = server.analyze(
                self.body(provider="llama", base_url="http://localhost:8080")
            )
            self.assertEqual(result["decision"], "block")
            self.assertAlmostEqual(result["score"], 0.9)

    # 원문에 없는 인용 근거를 생성하면 그대로 믿지 않고 검토 대상으로 남기는지 확인한다.
    def test_json_hallucinated_evidence_is_review(self):
        response = {
            "message": {
                "content": json.dumps(
                    {
                        "risk_score": 0.1,
                        "reason": "공개 정보",
                        "evidence": ["존재하지 않는 문장"],
                        "uncertain": False,
                    }
                )
            }
        }
        with patch("server.remote", side_effect=[{}, response]):
            result = server.analyze(self.body(method="json"))
            self.assertEqual(result["decision"], "review")
            self.assertEqual(result["evidence"], [])

    # 문자열·불리언·무한대 등 점수로 사용할 수 없는 JSON 값을 거절하는지 확인한다.
    def test_json_invalid_score_rejected(self):
        response = {
            "message": {
                "content": json.dumps(
                    {
                        "risk_score": 1.5,
                        "reason": "위험",
                        "evidence": [],
                        "uncertain": False,
                    }
                )
            }
        }
        with patch("server.remote", side_effect=[{}, response]):
            with self.assertRaises(server.AppError):
                server.analyze(self.body(method="json"))

    # 너무 긴 문서를 잘라 처리하지 않고 거절하며 역전된 임계값도 허용하지 않는지 확인한다.
    def test_length_and_threshold_validation(self):
        for extra in [
            {"text": "x" * 12001},
            {"text": "한" * 9000},
            {"text": ""},
            {"low": 0.8, "high": 0.2},
            {"calibration": 0},
            {"rules": "yes"},
        ]:
            with self.assertRaises(server.AppError):
                server.analyze(self.body(**extra))

    # 정상적인 전용 판단 응답의 기준값. extra로 잘림·종료 표시 등을 바꿔 실패 조건을 검증한다.
    def native(self, **extra):
        return dict(
            {
                "model": "jevk5:latest",
                "answers": {"confidential": {"type": "noul", "noul": 0.82}},
                "state_truncated": False,
                "done_reason": "decide",
                "load_duration": 2000000000,
                "eval_duration": 250000000,
            },
            **extra,
        )

    # 사용자가 입력한 판단 기준이 전용 요청에 전달되고 Noul 점수가 그대로 반환되는지 확인한다.
    def test_decision_adapter_preserves_question_and_score(self):
        with patch("server.remote", return_value=self.native()) as remote:
            result = server.analyze(
                self.body(
                    provider="ollaya",
                    method="decision",
                    model="jevk5:latest",
                    base_url="http://127.0.0.1:11435",
                    rules=False,
                )
            )
            payload = remote.call_args[0][2]
            self.assertEqual(remote.call_args[0][1], "/api/decide")
            self.assertEqual(payload["state"], self.body()["text"])
            self.assertEqual(payload["questions"]["confidential"]["type"], "noul")
            self.assertEqual(result["score"], 0.82)
            self.assertEqual(result["decision"], "block")
            self.assertEqual(
                result["timing"], {"load_seconds": 2.0, "inference_seconds": 0.25}
            )
            self.assertIsNone(result["calibration"])

    # 입력이 잘렸거나 완전 처리 여부를 확인할 수 없는 응답은 비교 점수로 사용하지 않는지 확인한다.
    def test_decision_rejects_truncated_or_unverified_input(self):
        for flag in [True, None, "false", 0]:
            with patch("server.remote", return_value=self.native(state_truncated=flag)):
                with self.assertRaises(server.AppError):
                    server.analyze(self.body(provider="ollaya", method="decision"))

    # 전용 API라는 이유만으로 유형·범위가 잘못된 응답을 신뢰하지 않는지 확인한다.
    def test_decision_rejects_invalid_answers(self):
        for answers in [
            None,
            {},
            {"confidential": None},
            {"confidential": {"type": "choice", "noul": 0.5}},
            {"confidential": {"type": "noul", "noul": True}},
            {"confidential": {"type": "noul", "noul": 1.1}},
        ]:
            with patch("server.remote", return_value=self.native(answers=answers)):
                with self.assertRaises(server.AppError):
                    server.analyze(self.body(provider="ollaya", method="decision"))

    # 모델 비교 시 규칙 검사를 꺼 실제 모델 응답을 측정할 수 있는지 확인한다.
    def test_rules_can_be_disabled_for_fair_model_comparison(self):
        with patch("server.remote", return_value=self.native()) as remote:
            result = server.analyze(
                self.body(
                    provider="ollaya",
                    method="decision",
                    text="가상의 -----BEGIN PRIVATE KEY----- 예제",
                    rules=False,
                )
            )
            self.assertFalse(result["forced"])
            self.assertEqual(remote.call_count, 1)

    # 모델 로딩 시간과 추론 시간을 분리하며 누락된 시간은 0으로 채우지 않는지 확인한다.
    def test_timing_does_not_count_model_load_as_inference(self):
        self.assertEqual(
            server.timings(
                {
                    "load_duration": 4000000000,
                    "prompt_eval_duration": 200000000,
                    "eval_duration": 50000000,
                },
                "ollama",
            ),
            {"load_seconds": 4.0, "inference_seconds": 0.25},
        )
        self.assertEqual(
            server.timings({}, "llama"),
            {"load_seconds": None, "inference_seconds": None},
        )

    # 전용 실행기에 일반 채팅 방식을 잘못 요청하면 모델 호출 전에 거절하는지 확인한다.
    def test_decision_runtime_cannot_use_generic_chat_method(self):
        with patch("server.remote") as remote:
            with self.assertRaises(server.AppError):
                server.analyze(self.body(provider="ollaya", method="tokens"))
            remote.assert_not_called()


if __name__ == "__main__":
    unittest.main()
