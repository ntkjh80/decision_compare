# 코드를 처음 읽는 분을 위한 구조 안내

이 앱은 **브라우저 화면 → Python 앱 서버 → 로컬 모델 서버**의 세 부분으로 나뉩니다. Python 앱이 AI 모델을 직접 학습하거나 추론하는 것은 아닙니다. 모델을 실행하는 도구에 요청하고, 돌아온 답을 검사해 비교하기 쉬운 형식으로 바꿉니다.

모든 경로는 저장소 루트를 기준으로 적었습니다. 파일에는 역할·계산 이유·예외 처리에 대한 한국어 주석이 있습니다.

## 1. 먼저 구분할 세 화면

| 화면 | 화면 제어 코드 | 계산 코드 | 서버 처리 |
|---|---|---|---|
| 기밀 문서 한 건 검토 | `dist/app.js` | 단일 결과는 서버에서 분류 | `server.py`의 `analyze()` |
| 기본 모델 4종 비교 | `dist/compare.js` | `dist/comparison-metrics.js` | `/api/analyze` |
| 자유 성능평가 | `dist/evaluation.js` | `dist/evaluation-metrics.js` | `/api/evaluate` → `evaluation.py` |

`dist/index.html`과 `styles.css`는 처음 두 화면 및 종합 설명을 담습니다. `dist/evaluation.html`과 `evaluation.css`는 자유 성능평가 전용입니다. `dist`는 직접 관리하는 소스이며 빌드 도구가 필요하지 않습니다.

## 2. 평가 버튼 한 번의 흐름

1. **입력을 확인합니다.** `evaluation.js`의 `criteria()`·`validateRows()`가 선택지와 문서를 확인합니다. Choice는 ID, Score는 범위 안의 숫자, Noul은 참·거짓 형식으로 정답을 해석합니다.
2. **실험을 고정합니다.** `experiment()`·`run()`이 질문, 선택지, 모델, 데이터, 순서와 설정을 복사합니다. 실행 중 입력을 잠가 조건이 섞이지 않게 합니다.
3. **요청을 보냅니다.** `requestOne()`이 각 문서를 모델에 차례로 보냅니다. 준비 실행은 따로 기록합니다. 채점용 정답은 모델 요청에 넣지 않습니다.
4. **서버가 검사합니다.** `server.py`는 로컬 주소, 요청 크기, 접근 조건 등을 확인하고 추론 잠금을 관리합니다. `evaluation.py`는 선택한 모델 실행 방식에 맞게 요청을 만듭니다.
5. **답을 검증합니다.** `validate_answer()`·`token_distribution()` 등이 선택지 누락, 확률 범위와 합계, Score 기대값, 입력 잘림 등을 확인합니다. 응답이 불완전하면 추측으로 채우지 않습니다.
6. **계산합니다.** `evaluation-metrics.js`의 `summarize()`가 정상 응답·실패·정답 미지정을 구분해 정확도, 보정, 검토율, 속도를 집계합니다.
7. **보여 줍니다.** `renderResults()`·`drawCharts()`·`renderInspect()`가 비교표, 그래프, 문서별 결과를 만듭니다.

‘현재 요청까지만’ 중단은 진행 중인 요청이 끝난 뒤 적용됩니다. 실행 중인 모델의 추론을 강제로 취소하는 기능과는 다릅니다.

## 3. 모델마다 API가 다른 이유

| 어댑터 | 받아 오는 값 | 구현에서 중요한 점 |
|---|---|---|
| Ollaya 전용 판단 | Choice·Score·Noul의 타입이 정해진 답 | 완료 표시와 입력 잘림 여부, 확률 분포, 모델이 제공한 Confidence를 검사합니다. |
| Ollama / llama.cpp 답 토큰 | A·B 등 답 후보의 로그확률 | 필요한 후보가 모두 있어야 합니다. 받지 못한 확률을 0으로 채우지 않습니다. |
| 일반 LLM JSON | 모델이 생성한 답과 확률 숫자 | JSON 형식과 값의 계약을 검사합니다. 숫자가 잘 읽힌다는 것과 잘 보정된 확률이라는 것은 다릅니다. |

모델 이름만 목록에 추가한다고 모든 모델이 지원되지는 않습니다. 실행기·프롬프트·응답 구조가 기존 계약과 다른 경우 별도 어댑터가 필요합니다.

## 4. 계산을 화면에서 분리한 이유

`evaluation-metrics.js`는 주어진 입력으로 숫자만 계산합니다. HTTP 요청, 파일 저장, 화면 조작을 하지 않으므로 모델 없이도 작은 고정 예제로 검증할 수 있습니다.

- `truth()`·`prediction()`: 사람이 붙인 정답과 모델의 최종 판단을 맞춰 해석합니다.
- `calibration()`: 확률 구간별 평균 확신과 실제 정답률을 비교합니다.
- `roc()`: 여러 임계값의 오탐률·재현율과 AUC·AP를 구합니다.
- `summarize()`: 각 지표의 분모를 정하고 결과를 한 묶음으로 반환합니다.

예를 들어 정답이 없는 문서는 속도 관측에는 포함될 수 있지만 정확도의 분모에서는 빠집니다. 실패한 요청은 전체 실패율에는 포함되지만 정상 응답의 확률 보정에는 포함되지 않습니다. 자세한 규칙은 [평가 상세 안내](evaluation-reference.md)에 있습니다.

## 5. 지표 설명을 수정하려면

설명 원본은 `dist/evaluation.html`의 `metric-guide` 영역입니다. 각 `details`에는 `guide-accuracy` 같은 ID가 있습니다.

`evaluation.js`의 `openMetricHelp()`는 해당 설명 본문을 복제해 대화상자에 보여 줍니다. 결과표의 지표 이름이나 그래프 설명 버튼은 `data-metric-help`로 설명 ID를 가리킵니다. **전체 안내와 팝업의 문장을 두 군데에서 따로 관리하지 않습니다.**

계산을 바꾸면 설명 속 분모와 예시도 함께 확인하세요. 설명만 바꾸는 작업이라면 계산 모듈을 수정할 필요가 없습니다.

## 6. 시작·설치·배포는 역할이 다릅니다

| 파일 | 하는 일 |
|---|---|
| `bootstrap.py` | `.venv`를 없을 때 생성하고 정상 환경을 재사용. 실제 Python의 경로·버전과 환경 분리를 검사하고 지정한 앱 파일로 교체 실행 |
| `setup.command` → `bootstrap.py` → `setup_mac.py` | Python·Ollama·Mac 지원 조건 확인, 고정된 Ollaya 0.9.0 배포 파일의 체크섬 검증, 기본 모델 준비 |
| `start.command` → `bootstrap.py` → `run.py` | 이미 실행 중인 서버 재사용, 필요할 때 서버 시작, 브라우저 열기, 직접 시작한 프로세스 종료 |
| `server.py` | 정적 화면·API·다운로드 제공. `--port`로 앱 포트를 지정할 수 있음 |
| `package_app.py` | 허용된 코드·설명·예제·리포트를 ZIP으로 묶음. 임시 ZIP 완성 후 교체 |

앱 코드 경로는 각 파일의 위치를 기준으로 계산하므로 특정 사용자 이름이나 기존 프로젝트 경로가 필요하지 않습니다. `.venv` 자체는 이동할 수 없으므로 다른 폴더·Mac에서는 새로 만듭니다. `run.py`는 이미 실행 중인 8765 앱 서버도 재사용하므로 다른 복사본을 시험할 때에는 기존 서버를 먼저 종료하거나 새 복사본의 서버를 다른 포트로 띄우세요.

## 7. 무엇을 어디서 고치나요?

| 바꾸려는 내용 | 시작할 파일 |
|---|---|
| 화면 문구·배치 | `dist/evaluation.html`, `dist/evaluation.css` |
| 기본 예제·편집 동작 | `dist/evaluation.js`의 `presets`, `applyCategory()` |
| 평가 실행·저장·그래프 | `dist/evaluation.js` |
| 정확도·보정·ROC 계산 | `dist/evaluation-metrics.js`와 `tests/evaluation.test.cjs` |
| 모델 요청·응답 지원 | `evaluation.py`와 `tests/test_evaluation.py` |
| 연결 허용 범위·한 건 검토 | `server.py`와 `tests/test_server.py` |
| Python 가상환경 준비·진입 파일 실행 | `bootstrap.py`와 `tests/test_bootstrap.py` |
| 기본 모델·실행기 버전 | `setup_mac.py`의 `MODEL_GROUPS`, 버전·체크섬 상수 |
| 배포에 포함할 파일 | `package_app.py` |
| 종합 Word 리포트 | `report/build_report.py` — 별도 문서 생성 도구 |

검증 명령과 첫 실행 방법은 [README](../README.md)에 있습니다.
