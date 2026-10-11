#!/usr/bin/env python3
"""Portable, project-local Mac setup. --check never changes the machine."""
# Mac 최초 준비 도구. 앱 실행과 모델 다운로드를 구분한다.
# --check: 상태만 출력 / --yes: 준비 질문 생략 / --no-pull: 모델 가중치 다운로드 생략.
# Ollaya 런타임은 프로젝트 .runtime, 새로 시작하는 모델 서버의 가중치는 프로젝트 폴더에 둔다.
# 아래 SHA-256은 내려받은 공식 배포 파일이 기대한 파일과 같은지 확인하기 위한 고정값이다.
import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent
OLLAYA_VERSION = "0.9.0"
ASSET = "ollaya-darwin-arm64.tgz"
SHA256 = "a3b7b9be7aeac7f3f61a27ab1c0b88173d84841deb1e78254fa85f0c46060542"
PACKS = [
    (ASSET, SHA256),
    (
        "ollaya-darwin-arm64-mlx.tgz",
        "374f30c7eea496eb509f942cab9335a8bcdf0f88356f1c72282d3d7e3848c572",
    ),
]
MODEL_GROUPS = {
    "ollama": ["qwen3.5:4b"],
    "ollaya": ["jevk5:latest", "laya:multilingual", "decider:0.8b"],
}
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# 프로젝트 안의 실행기 → Ollama 앱 → 일반 Homebrew 위치 → PATH 순으로 탐색한다.
# Mac의 사용자명이나 특정 개발자 PC 경로에 의존하지 않도록 한다.
def ollama_binary():
    return next(
        (
            str(p)
            for p in [
                ROOT / ".runtime/ollama/bin/ollama",
                Path("/Applications/Ollama.app/Contents/Resources/ollama"),
                Path("/opt/homebrew/bin/ollama"),
                Path("/usr/local/bin/ollama"),
            ]
            if p.is_file()
        ),
        shutil.which("ollama"),
    )


# Apple Silicon 여부를 판단한다. Rosetta에서 실행된 Python은 x86_64로 보일 수 있어
# sysctl.proc_translated도 확인한다. 조회할 수 없으면 지원한다고 추측하지 않는다.
def silicon():
    if platform.machine() == "arm64":
        return True
    try:
        return (
            subprocess.check_output(
                ["/usr/sbin/sysctl", "-n", "sysctl.proc_translated"],
                stderr=subprocess.DEVNULL,
            ).strip()
            == b"1"
        )
    except (OSError, subprocess.CalledProcessError):
        return False


# OS·Python·실행기·디스크 여유 공간을 읽어 준비 가능 여부를 반환한다.
# 이 함수 자체는 모델이나 프로그램을 설치하지 않는다.
def check():
    major = (
        int(platform.mac_ver()[0].split(".")[0]) if platform.system() == "Darwin" else 0
    )
    data = {
        "os": platform.system(),
        "architecture": platform.machine(),
        "macOS": platform.mac_ver()[0],
        "python": platform.python_version(),
        "python_ok": sys.version_info >= (3, 9),
        "ollama": ollama_binary(),
        "ollaya": (
            str(ROOT / ".runtime/ollaya/bin/ollaya")
            if (ROOT / ".runtime/ollaya/bin/ollaya").is_file()
            else None
        ),
        "ollaya_supported": platform.system() == "Darwin" and silicon() and major >= 14,
        "free_gb": round(shutil.disk_usage(ROOT).free / 1e9, 1),
    }
    return data


# 압축을 풀기 전에 각 항목의 실제 경로가 목적 폴더 내부인지 검사한다.
# ../ 경로 이동, 폴더 밖 심볼릭/하드 링크, 장치 파일을 거절해 외부 파일 덮어쓰기를 막는다.
# install_ollaya에서 SHA-256 검증을 마친 배포 파일을 넘기는 흐름과 함께 사용한다.
def safe_extract(archive, dest):
    root = dest.resolve()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            target = (root / member.name).resolve()
            if target != root and root not in target.parents:
                raise RuntimeError("압축 파일의 경로가 올바르지 않습니다.")
            if member.isdev() or member.isfifo():
                raise RuntimeError("지원하지 않는 압축 파일 항목입니다.")
            if member.issym() or member.islnk():
                linked = (
                    (target.parent if member.issym() else root) / member.linkname
                ).resolve()
                if linked != root and root not in linked.parents:
                    raise RuntimeError("압축 파일 링크가 범위를 벗어납니다.")
        tar.extractall(root)


# 고정 버전의 기본 런타임과 MLX 파일을 받아 검증한 뒤 프로젝트에 설치한다.
# 임시 폴더에서 모두 준비한 후 목적지로 옮겨 다운로드 실패가 정상 설치처럼 남지 않게 한다.
# 기존 실행기는 재사용하고, 불완전한 기존 폴더는 자동 삭제하거나 덮어쓰지 않는다.
def install_ollaya():
    dest = ROOT / ".runtime/ollaya"
    if (dest / "bin/ollaya").is_file():
        print("프로젝트의 기존 Ollaya를 사용합니다.")
        return dest / "bin/ollaya"
    dest.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix="decision-setup-", dir=str(dest.parent)
    ) as tmp:
        tmp = Path(tmp)
        stage = tmp / "unpacked"
        stage.mkdir()
        for asset, checksum in PACKS:
            archive = tmp / asset
            url = (
                "https://github.com/ollaya-dev/ollaya/releases/download/v"
                + OLLAYA_VERSION
                + "/"
                + asset
            )
            print(
                "공식 Ollaya "
                + OLLAYA_VERSION
                + " / "
                + asset
                + "를 내려받고 SHA-256을 검증합니다."
            )
            with OPENER.open(url, timeout=120) as source, archive.open("wb") as target:
                shutil.copyfileobj(source, target)
            if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
                raise RuntimeError("Ollaya 체크섬이 다릅니다. 설치를 중단했습니다.")
            safe_extract(archive, stage)
        if not (stage / "bin/ollaya").is_file():
            raise RuntimeError("배포 파일에 실행기가 없습니다.")
        if dest.exists():
            raise RuntimeError(
                ".runtime/ollaya에 불완전한 설치가 있습니다. 폴더를 다른 이름으로 보관한 뒤 다시 준비하세요."
            )
        shutil.move(str(stage), str(dest))
        (dest / "bin/ollaya").chmod(0o755)
    return dest / "bin/ollaya"


# 설치/시작 상태 확인용 짧은 조회. 아직 실행 전이거나 연결 실패면 None으로 반환한다.
def get(base, path):
    try:
        with OPENER.open(base + path, timeout=2) as response:
            return json.load(response)
    except Exception:
        return None


# 필요한 실행기를 준비하고, 없는 기본 모델만 내려받는다.
# 이미 같은 이름의 모델이 있으면 다시 pull하지 않아 기존 가중치를 임의 갱신하지 않는다.
# installed-models.json은 준비한 버전·모델 식별값·실행 환경의 기록이며 기본 배포 ZIP에서는 제외된다.
def prepare_models(info, yes=False, no_pull=False):
    if not info["ollama"]:
        print(
            "Ollama 설치가 필요합니다: https://ollama.com/download/mac\n설치 후 setup.command를 다시 열어주세요."
        )
        if not yes:
            webbrowser.open("https://ollama.com/download/mac")
        return 2
    if not no_pull and not yes:
        print(
            "기본 모델 다운로드에는 약 10GB 이상의 저장 공간과 인터넷이 필요합니다. 기존 모델은 재사용합니다."
        )
        if input("모델을 준비할까요? [y/N] ").strip().lower() not in ("y", "yes"):
            return 0
    binary = install_ollaya() if info["ollaya_supported"] else None
    if not binary:
        print(
            "이 Mac은 Ollaya 실행 대상이 아닙니다. Ollama 모델로 준비합니다. Ollaya는 Apple Silicon + macOS 14 이상이 필요합니다."
        )
    if no_pull:
        return 0
    # 이 준비 과정이 시작한 서버만 추적한다. 준비 도중 실패해도 finally에서 정리하며
    # 사용자가 원래 실행하던 서버는 목록에 넣지 않는다.
    processes = []
    manifest = {
        "prepared_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "machine": info,
        "servers": {},
    }
    try:
        for provider, exe, port, folder in [
            ("ollama", info["ollama"], 11434, ".models"),
            ("ollaya", str(binary) if binary else None, 11435, ".ollaya-models"),
        ]:
            if not exe:
                continue
            base = "http://127.0.0.1:" + str(port)
            prefix = provider.upper()
            env = dict(
                os.environ,
                **{
                    prefix + "_HOST": "127.0.0.1:" + str(port),
                    prefix + "_MODELS": str(ROOT / folder),
                },
            )
            if provider == "ollama":
                env["OLLAMA_NO_CLOUD"] = "1"
            else:
                env["OLLAYA_MAX_LOADED_MODELS"] = "1"
            if not get(base, "/api/version"):
                proc = subprocess.Popen(
                    [exe, "serve"],
                    env=env,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                processes.append(proc)
                for _ in range(50):
                    if get(base, "/api/version"):
                        break
                    if proc.poll() is not None:
                        raise RuntimeError(provider + "를 시작하지 못했습니다.")
                    time.sleep(0.2)
                else:
                    raise RuntimeError(provider + " 서버 시작 시간이 초과됐습니다.")
            print(
                provider
                + " 모델을 준비합니다. 이미 실행 중인 서버는 그 서버의 저장 폴더를 사용합니다."
            )
            present = {
                m.get("name") for m in (get(base, "/api/tags") or {}).get("models", [])
            }
            for model in MODEL_GROUPS[provider]:
                if model in present:
                    print(model + " · 기존 가중치를 유지합니다.")
                else:
                    subprocess.run([exe, "pull", model], env=env, check=True)
            manifest["servers"][provider] = {
                "version": get(base, "/api/version"),
                "models": get(base, "/api/tags"),
            }
        (ROOT / "installed-models.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(
            "\n준비 완료. start.command를 열어 자유 성능평가를 이용하세요. 모델 식별값은 installed-models.json에 기록했습니다."
        )
        return 0
    finally:
        for p in reversed(processes):
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait()


# 명령행 옵션을 해석하고 지원 OS·Python·여유 공간을 검사한다.
# --check는 검사를 읽기 전용으로 마친다. 실제 준비일 때만 prepare_models로 진행한다.
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--no-pull", action="store_true")
    args = parser.parse_args()
    info = check()
    if args.check:
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0
    if info["os"] != "Darwin" or not info["python_ok"]:
        raise RuntimeError("Mac과 Python 3.9 이상이 필요합니다.")
    if not args.no_pull and info["free_gb"] < 15:
        raise RuntimeError("모델 다운로드를 위해 여유 공간 15GB 이상을 확보하세요.")
    return prepare_models(info, args.yes, args.no_pull)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as exc:
        print("준비 중단:", exc)
        sys.exit(1)
