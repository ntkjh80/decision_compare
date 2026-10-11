#!/usr/bin/env python3
"""Launch the local app and, when needed, its existing Ollama installation."""
# 다른 Mac에서도 같은 폴더를 옮겨 실행하기 위한 시작 관리자.
# 현재 Python으로 앱 서버를 시작하고, 설치된 모델 실행기가 있으면 함께 시작한다.
# 사용자가 이미 실행한 서버는 재사용하며 이 프로그램이 직접 만든 프로세스만 정리한다.
import os
import json
from pathlib import Path
from setup_mac import ollama_binary
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
# 직접 시작한 하위 프로세스의 소유권 목록. 기존 서버를 종료하지 않는 기준이다.
children = []
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# 응답이 왔다는 것뿐 아니라 예상 서비스인지 확인한다.
# 앱은 app="decision-lab", 모델 서버는 version 값이 있어야 준비 완료로 본다.
# 시작 직후 연결이 안 되는 것은 정상일 수 있으므로 예외는 False로 바꿔 재시도하게 한다.
def ready(url):
    try:
        with opener.open(url, timeout=1) as response:
            data = json.load(response)
            return response.status == 200 and (
                data.get("app") == "decision-lab"
                if url.endswith("/health")
                else bool(data.get("version"))
            )
    except Exception:
        return False


# 1. 배포 파일 준비 → 2. 모델 서버 재사용/시작 → 3. 앱 서버 준비 → 4. 브라우저 열기.
# 모델이 없더라도 화면을 열어 연결 방법을 확인할 수 있다. 가중치를 자동 다운로드하지 않는다.
# --no-browser는 테스트나 터미널 실행에서 브라우저 자동 열기만 생략한다.
def main():
    if not (ROOT / "releases/decision-lab-mac.zip").is_file():
        from package_app import package

        package()
    if not ready("http://127.0.0.1:11434/api/version"):
        binary = ollama_binary()
        # 여기서 직접 시작하는 Ollama만 프로젝트의 .models를 사용한다.
        # 기존 서버를 재사용하면 그 서버의 저장 위치와 실행 설정이 적용된다.
        if binary:
            env = dict(
                os.environ,
                OLLAMA_HOST="127.0.0.1:11434",
                OLLAMA_MODELS=str(ROOT / ".models"),
                OLLAMA_NO_CLOUD="1",
            )
            children.append(
                subprocess.Popen(
                    [binary, "serve"],
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            )
            for _ in range(30):
                if ready("http://127.0.0.1:11434/api/version"):
                    break
                if children[-1].poll() is not None:
                    break
                time.sleep(0.3)
        else:
            print(
                "Ollama가 없습니다. https://ollama.com 에서 설치하거나 앱 설정에서 기존 llama.cpp 서버를 연결하세요."
            )
    if not ready("http://127.0.0.1:11435/api/version"):
        binary = ROOT / ".runtime/ollaya/bin/ollaya"
        if binary.is_file():
            env = dict(
                os.environ,
                OLLAYA_HOST="127.0.0.1:11435",
                OLLAYA_MODELS=str(ROOT / ".ollaya-models"),
                OLLAYA_MAX_LOADED_MODELS="1",
                OLLAYA_LOG="warn",
            )
            children.append(
                subprocess.Popen(
                    [str(binary), "serve"],
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            )
            for _ in range(30):
                if ready("http://127.0.0.1:11435/api/version"):
                    break
                if children[-1].poll() is not None:
                    break
                time.sleep(0.3)
        else:
            print(
                "Decision 전용 모델 비교는 Ollaya 설치가 필요합니다. 앱의 비교 화면에서 준비 상태를 확인하세요."
            )
    if not ready("http://127.0.0.1:8765/api/health"):
        children.append(
            subprocess.Popen([sys.executable, str(ROOT / "server.py")], cwd=ROOT)
        )
        for _ in range(30):
            if ready("http://127.0.0.1:8765/api/health"):
                break
            if children[-1].poll() is not None:
                raise RuntimeError(
                    "앱 서버가 시작되지 않았습니다. 8765 포트 사용 여부를 확인하세요."
                )
            time.sleep(0.2)
    if not ready("http://127.0.0.1:8765/api/health"):
        raise RuntimeError("앱에 연결할 수 없습니다.")
    print(
        "\n앱 주소: http://127.0.0.1:8765\n이 창을 유지해주세요. 종료하려면 Ctrl+C를 누르세요.\n"
    )
    if "--no-browser" not in sys.argv:
        webbrowser.open("http://127.0.0.1:8765/evaluation")
    try:
        # 시작 창을 유지해 프로세스 생명주기를 관리한다.
        # Ctrl+C가 오면 finally에서 자식부터 역순으로 정리하고 기존 서버는 그대로 둔다.
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n직접 시작한 프로세스를 정리합니다. 기존 서버는 유지됩니다.")
    finally:
        for process in reversed(children):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("실행 오류:", exc)
        for process in children:
            if process.poll() is None:
                process.terminate()
        sys.exit(1)
