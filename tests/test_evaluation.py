# 회귀 테스트: 앱의 계약과 오류 처리를 고정된 예제로 검사한다. 학습된 모델의 정확도 평가는 아니다.
import copy
import io
import math
import tempfile
import threading
import tarfile
import unittest
from pathlib import Path
from unittest.mock import Mock
import evaluation as ev
import server
import setup_mac


class EvaluationTests(unittest.TestCase):
    # 각 테스트의 기본 요청을 만들고 extra로 필요한 조건만 바꾼다. 실제 사용자 문서는 사용하지 않는다.
    def body(self, **extra):
        return dict(
            {
                "provider": "ollaya",
                "base_url": "http://127.0.0.1:11435",
                "model": "laya:multilingual",
                "category": "choice",
                "question": "담당 부서?",
                "criteria": {"billing": "결제", "technical": "기술"},
                "text": "환불 요청",
                "mode": "native",
            },
            **extra,
        )

    # 가짜 remote와 독립 잠금으로 어댑터만 검사한다. 실제 모델 서버에 접속하거나 가중치를 읽지 않는다.
    def evaluate(self, body, response):
        remote = Mock(return_value=response)
        lock = threading.Lock()
        result = ev.evaluate(
            body,
            remote=remote,
            config=server.config,
            lock=lock,
            timings=server.timings,
            app_error=server.AppError,
        )
        self.assertFalse(lock.locked())
        return result, remote

    # 전용 API의 완료 표시와 answers 묶음을 만들어 개별 테스트는 답의 의미에 집중하게 한다.
    def answer(self, answer):
        return {
            "state_truncated": False,
            "done_reason": "decide",
            "answers": {"evaluation": answer},
            "eval_duration": 1000000,
        }

    # Choice 선택지·질문을 보존하고 선택 확률과 API Confidence를 따로 반환하는지 확인한다.
    def test_choice_contract_and_no_question_loss(self):
        body = self.body()
        r, remote = self.evaluate(
            body,
            self.answer(
                {
                    "type": "choice",
                    "choice": "billing",
                    "probabilities": {"billing": 0.8, "technical": 0.2},
                    "confidence": 0.6,
                }
            ),
        )
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["api_confidence"], 0.6)
        self.assertEqual(
            remote.call_args.args[2]["questions"]["evaluation"]["criteria"],
            body["criteria"],
        )

    # Score는 최빈 단계나 반올림값이 아니라 확률의 기대값이어야 한다. 1.2와 2를 구분하는 사례다.
    def test_score_mean_not_argmax_or_rounding(self):
        body = self.body(category="score", criteria=["낮음", "보통", "높음"])
        answer = {
            "type": "score",
            "score": 1.2,
            "confidence": 0.4,
            "probabilities": {"0": 0.1, "1": 0.6, "2": 0.3},
            "legend": {"0": "낮음", "1": "보통", "2": "높음"},
        }
        r, _ = self.evaluate(body, self.answer(answer))
        self.assertEqual(r["value"], 1.2)
        answer["score"] = 2
        r, _ = self.evaluate(body, self.answer(answer))
        self.assertEqual(r["error_kind"], "schema")

    # Noul에 없는 API Confidence를 임의로 만들어내지 않고 None으로 남기는지 확인한다.
    def test_noul_has_no_fabricated_api_confidence(self):
        r, _ = self.evaluate(
            self.body(category="noul", criteria={"true": "예", "false": "아니오"}),
            self.answer({"type": "noul", "noul": 0.9}),
        )
        self.assertIsNone(r["api_confidence"])
        self.assertEqual(r["value"], 0.9)

    # 후보 누락·잘못된 확률·범위 밖 답이 모두 스키마 위반으로 기록되는지 확인한다.
    def test_invalid_distribution_and_outside_choice_are_schema_errors(self):
        for probs, value in [
            ({"billing": 0.8, "technical": 0.8}, "billing"),
            ({"billing": True, "technical": 0}, "billing"),
            ({"billing": float("nan"), "technical": 0.2}, "billing"),
            ({"billing": 0.8, "technical": 0.2}, "other"),
            ({"billing": 1}, "billing"),
        ]:
            r, _ = self.evaluate(
                self.body(),
                self.answer(
                    {
                        "type": "choice",
                        "choice": value,
                        "probabilities": probs,
                        "confidence": 0.6,
                    }
                ),
            )
            self.assertEqual(r["error_kind"], "schema")
            self.assertIs(r["schema_valid"], False)

    # 입력 잘림과 연결 실패를 스키마 위반율에 섞지 않고 서로 다른 실패로 기록하는지 확인한다.
    def test_truncation_transport_and_schema_are_separate(self):
        r, _ = self.evaluate(self.body(), {"state_truncated": True})
        self.assertEqual(r["error_kind"], "truncated")
        self.assertIsNone(r["schema_valid"])
        remote = Mock(side_effect=server.AppError("timeout"))
        r = ev.evaluate(
            self.body(),
            remote=remote,
            config=server.config,
            lock=threading.Lock(),
            timings=server.timings,
            app_error=server.AppError,
        )
        self.assertEqual(r["error_kind"], "transport")
        self.assertIsNone(r["schema_valid"])

    # 모든 후보 확률은 필수이고 합계의 작은 반올림 차이만 허용하는지 확인한다.
    def test_all_token_options_required_and_rounding_tolerance(self):
        p, mass = ev.token_distribution(
            [
                {"token": "A", "logprob": math.log(0.6)},
                {"token": " B", "logprob": math.log(0.3)},
            ],
            ["a", "b"],
            1,
        )
        self.assertAlmostEqual(p["a"], 2 / 3)
        self.assertAlmostEqual(mass, 0.9)
        with self.assertRaises(ev.EvaluationError):
            ev.token_distribution([{"token": "A", "logprob": -0.1}], ["a", "b"], 1)
        p = ev.distribution({"a": 0.3333, "b": 0.3333, "c": 0.3333}, ["a", "b", "c"])
        self.assertAlmostEqual(sum(p.values()), 1)

    # 잘못된 질문·설정·외부 서버 주소가 추론 전에 차단되는지 확인한다.
    def test_input_and_remote_address_rejected_before_inference(self):
        for body in [
            self.body(criteria={"one": "only"}),
            self.body(category="other"),
            self.body(text=""),
            self.body(settings={"timeout": True}),
        ]:
            with self.assertRaises(ev.EvaluationError):
                self.evaluate(body, {})
        with self.assertRaises(server.AppError):
            self.evaluate(self.body(base_url="https://example.com"), {})

    # 필수 확률 외에 요청하지 않은 필드가 있는 JSON도 형식 위반으로 관측되는지 확인한다.
    def test_ollama_json_wrong_shape_is_measured(self):
        r, _ = self.evaluate(
            self.body(provider="ollama", mode="json"),
            {
                "message": {
                    "content": '{"probabilities":{"billing":0.8,"technical":0.2},"extra":1}'
                }
            },
        )
        self.assertEqual(r["error_kind"], "schema")

    # 자유 평가에서도 원격 별칭의 메타데이터만 조회하고 문서를 보내지 않는지 확인한다.
    def test_cloud_alias_never_receives_input(self):
        r, remote = self.evaluate(
            self.body(provider="ollama", mode="tokens"), {"remote_host": "cloud"}
        )
        self.assertEqual(r["error_kind"], "input")
        self.assertEqual(remote.call_count, 1)

    # Mac 준비용 압축 파일에 ../ 항목이 들어 있어도 목적 폴더 밖에 풀지 않는지 확인한다.
    def test_archive_path_escape_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "bad.tgz"
            with tarfile.open(archive, "w:gz") as tar:
                member = tarfile.TarInfo("../outside")
                member.size = 1
                tar.addfile(member, io.BytesIO(b"x"))
            dest = Path(tmp) / "out"
            dest.mkdir()
            with self.assertRaises(RuntimeError):
                setup_mac.safe_extract(archive, dest)


class ExportTests(unittest.TestCase):
    # 공유 내보내기 캐시를 비워 이전 테스트 결과가 다음 테스트의 건수에 영향을 주지 않게 한다.
    def tearDown(self):
        with server.EXPORT_LOCK:
            server.EXPORTS.clear()

    # 내보내기 파일명으로 경로/HTML을 지정하거나 크기 제한을 우회할 수 없는지 확인한다.
    def test_export_names_and_size_are_restricted(self):
        for name in ["../../outside.json", "decision-test.html", "name.json"]:
            with self.assertRaises(server.AppError):
                server.prepare_export({"filename": name, "content": "x"})
        with self.assertRaises(server.AppError):
            server.prepare_export(
                {"filename": "decision-test.json", "content": "x" * 8000001}
            )

    # 다운로드 주소가 매번 달라지고 캐시가 최대 개수 이상 커지지 않는지 확인한다.
    def test_exports_have_opaque_links_and_bounded_memory(self):
        links = [
            server.prepare_export(
                {"filename": "decision-test.json", "content": '{"x":1}'}
            )["url"]
            for _ in range(10)
        ]
        self.assertEqual(len(set(links)), 10)
        self.assertEqual(len(server.EXPORTS), 8)

    # 응답은 도착했지만 JSON 파싱에 실패한 경우 연결 실패로 숨기지 않고 스키마 위반으로 센다.
    def test_raw_invalid_json_is_schema_not_transport(self):
        remote = Mock(side_effect=server.ModelJSONError("invalid JSON"))
        body = EvaluationTests().body()
        r = ev.evaluate(
            body,
            remote=remote,
            config=server.config,
            lock=threading.Lock(),
            timings=server.timings,
            app_error=server.AppError,
        )
        self.assertEqual(r["error_kind"], "schema")
        self.assertTrue(r["response_received"])
