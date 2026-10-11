# Git으로 올리고 다른 컴퓨터에서 받기

**Git**은 파일의 변경 이력을 저장하는 도구이고, **GitHub·GitLab 등의 원격 저장소**는 그 이력을 다른 컴퓨터와 공유하는 장소입니다. 로컬 저장소를 만드는 것만으로 인터넷에 공개되지는 않습니다.

이 안내의 명령은 모두 프로젝트의 `README.md`가 있는 폴더에서 실행합니다. 앱을 쓰기만 한다면 Git이 없어도 ZIP으로 옮길 수 있습니다.

## 1. 무엇이 올라가나요?

| Git에 포함 | Git에서 제외 |
|---|---|
| Python·HTML·CSS·JavaScript와 실행 파일 | `.models/`, `.ollaya-models/`의 큰 모델 파일 |
| README·상세 설명·화면 이미지 | `.runtime/`의 설치 실행기와 `.venv/` |
| 가상 평가 예제·자동 테스트 | `experiments/`, `results/`, `data/`, `exports/`의 개인 파일 |
| 완성 Word·PDF와 보고서 생성 코드 | `releases/`의 ZIP, 로그·캐시·OS 임시 파일 |
| 보고서에 쓰이는 과거 가상 예제 실행 기록 1개 | 나머지 검증 기록과 `local-artifacts/`의 조사 원문 |

제외 규칙은 `.gitignore`에 있습니다. 이미 Git이 추적하는 파일에는 새 제외 규칙이 소급 적용되지 않습니다. 실제 사용자 문서를 가상 예제에 덮어쓰면 추적 대상이 되므로 개인 데이터는 위의 전용 폴더를 사용하세요.

## 2. 로컬 상태 확인

```sh
git status
git log -1 --oneline
git remote -v
```

준비된 로컬 폴더는 `main` 브랜치로 초기화하고 파일을 등록한 상태입니다. **작성자 정보가 설정되어 있지 않은 환경에서는 첫 커밋을 만들지 않습니다.** `git log`가 아직 커밋이 없다고 표시하면 아래의 이름·이메일 설정 후 `git commit`으로 첫 커밋을 만드세요. 이미 커밋이 있다면 원격 연결 단계로 진행합니다.

ZIP을 받아 새 저장소를 시작하는 경우에는 `.git`이 없으므로 다음 절차로 초기화합니다. 이미 Git 저장소인 폴더에서는 다시 할 필요가 없습니다.

```sh
git init -b main
git add .
git diff --cached --stat
git commit -m "Initial import of Decision Model Lab"
```

커밋은 현재 파일 상태를 이력으로 저장합니다. 이름·이메일을 설정하라는 메시지가 나오면 자신의 정보를 이 저장소에만 설정한 다음 커밋 명령을 다시 실행합니다.

```sh
git config user.name "본인의 표시 이름"
git config user.email "본인의 커밋 이메일"
```

## 3. GitHub 등에 빈 저장소 만들기

GitHub 웹에서 새 저장소를 만들고 이름을 `decision_model` 등으로 정합니다. 공개 범위는 본인이 선택합니다. **README·라이선스·.gitignore를 원격에서 자동 생성하지 않은 빈 저장소**로 만들면 현재 로컬 이력과 충돌 없이 연결하기 쉽습니다.

원격 저장소 화면에 나오는 HTTPS 주소를 복사합니다. 아래는 형식 예시이며 실제 주소로 바꾸어야 합니다.

```sh
git remote add origin https://github.com/YOUR_NAME/decision_model.git
git push -u origin main
```

`origin`은 원격 저장소의 별칭이고, `main`은 올릴 브랜치입니다. 로그인이나 인증이 필요하면 해당 Git 호스팅 서비스의 안내를 따르세요. 인증 토큰을 소스나 README에 적지 않습니다.

이미 `origin`이 있으면 `git remote -v`로 목적지를 먼저 확인합니다. 주소를 변경하려는 것이 맞을 때만 `git remote set-url origin 실제주소`를 사용하세요. 원격에 이미 다른 커밋이 있어 push가 거절되면 그 내용을 확인하고 합쳐야 합니다. 덮어쓰는 강제 push는 이 안내에 포함하지 않습니다.

## 4. 이후 수정 내용 올리기

```sh
git status
git diff
git add README.md docs dist
git diff --cached --stat
git commit -m "Improve evaluation guidance"
git push
```

`git add` 뒤에는 실제로 수정한 파일·폴더를 적습니다. 변경 내용을 확인한 뒤 모두 포함하려면 `git add .`도 사용할 수 있습니다. ZIP을 최신으로 유지하려면 커밋과 별도로 `python3 package_app.py`를 실행합니다. ZIP은 Git 변경 목록에 나타나지 않는 것이 정상입니다.

## 5. 다른 Mac에서 받기

```sh
git clone https://github.com/YOUR_NAME/decision_model.git
cd decision_model
python3 setup_mac.py --check
```

이후 Finder의 `setup.command` → `start.command` 순서로 실행하거나 README의 터미널 절차를 사용합니다. 첫 복제에는 모델과 개인 실험이 포함되지 않습니다. 필요한 실험은 앱의 ‘질문·데이터 저장’ 파일을 별도로 가져와 불러옵니다.

## 6. 코드와 앱 ZIP은 따로 배포합니다

코드는 Git으로 관리하고, 비개발자에게 전달할 앱 묶음은 `python3 package_app.py`로 만듭니다. 생성된 `releases/decision-lab-mac.zip`을 직접 전달하거나 GitHub 등의 Release에 첨부할 수 있습니다. Release 생성과 파일 업로드는 자동으로 실행되지 않습니다.

기본 ZIP에는 모델 가중치가 없으므로 받는 사람도 처음 모델을 준비해야 합니다. 수 GB 모델을 소스 저장소에 추가할 필요는 없습니다.

이 저장소에는 아직 별도 오픈소스 라이선스를 지정하지 않았습니다. 사용할 라이선스를 정하면 루트의 `LICENSE` 파일과 README에 함께 반영하세요. 외부 모델과 실행기의 배포 조건은 각각 별도입니다.

[앱 사용 안내로 돌아가기](../README.md)
