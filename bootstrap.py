#!/usr/bin/env python3
"""Prepare a project-local venv and run an app entry point with its Python."""
# Finder 실행과 터미널 실행에서 같은 .venv를 사용하기 위한 진입점이다.
# 이 파일 자체는 설치된 Python으로 실행하되, 실제 앱은 .venv의 Python으로 교체 실행한다.
# pip 업그레이드나 외부 패키지 설치를 하지 않으며 앱에는 표준 라이브러리만 필요하다.
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
SCRIPTS = ("run.py", "setup_mac.py", "server.py", "package_app.py")
LOCATION_FILE = ".decision-lab-location"
REPAIR = (
    "기존 .venv는 삭제하지 않았습니다. 앱을 종료한 뒤 .venv를 "
    ".venv-backup 등 다른 이름으로 보관하고 python3 bootstrap.py를 다시 실행하세요. "
    "새 환경에는 필요했던 선택 패키지를 다시 설치해야 합니다."
)


def python_environment(env_dir=None):
    """다른 프로젝트의 Python 경로 설정이 새 환경에 섞이지 않도록 정리한다."""
    env = dict(os.environ)
    for key in ("PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "VIRTUAL_ENV_PROMPT"):
        env.pop(key, None)
    env["PYTHONNOUSERSITE"] = "1"
    if env_dir is not None:
        env["VIRTUAL_ENV"] = str(env_dir)
        env["PATH"] = str(env_dir / "bin") + os.pathsep + env.get("PATH", "")
    return env


def ensure_environment(root=ROOT):
    """없으면 만들고, 이미 있으면 실제로 독립된 Python 환경인지 확인한다.

    venv 안에는 실행 파일의 절대 경로가 들어간다. 다른 Mac/폴더에서 복사한 환경은
    새로 만들어야 하므로 생성 위치도 기록한다. 유효하지 않은 기존 폴더는 덮어쓰지 않는다.
    수동으로 만든 정상 venv는 처음 확인할 때 위치만 기록하고 그대로 사용한다.
    """
    if sys.version_info < (3, 9):
        raise RuntimeError("Python 3.9 이상으로 bootstrap.py를 실행해주세요.")
    env_dir = Path(root).resolve() / ".venv"
    marker = env_dir / LOCATION_FILE
    if env_dir.is_symlink():
        raise RuntimeError(".venv가 다른 폴더를 가리키는 링크입니다. " + REPAIR)
    if not env_dir.exists():
        print("앱 전용 Python 환경(.venv)을 준비합니다.", flush=True)
        try:
            # ensurepip에 포함된 pip만 준비한다. 인터넷에서 패키지를 받지 않는다.
            # --clear/--upgrade를 쓰지 않아 기존 환경을 지우거나 갱신하지 않는다.
            subprocess.run(
                [sys.executable, "-I", "-m", "venv", str(env_dir)],
                env=python_environment(),
                check=True,
            )
        except (OSError, subprocess.CalledProcessError) as exc:
            raise RuntimeError(".venv 생성에 실패했습니다. " + REPAIR) from exc
    try:
        if marker.exists() and marker.read_text(encoding="utf-8").strip() != str(env_dir):
            raise ValueError("다른 위치에서 만들어진 .venv입니다")
        cfg = dict(
            line.split("=", 1)
            for line in (env_dir / "pyvenv.cfg").read_text(encoding="utf-8").splitlines()
            if "=" in line
        )
        cfg = {key.strip(): value.strip().lower() for key, value in cfg.items()}
        if cfg.get("include-system-site-packages") != "false":
            raise ValueError("시스템 패키지와 분리된 venv가 아닙니다")
        python = env_dir / "bin/python"
        # 활성화 표시(VIRTUAL_ENV)만 믿지 않고 실제 실행된 Python의 prefix를 검사한다.
        probe = subprocess.run(
            [str(python), "-I", "-c",
             "import json,sys; print(json.dumps({'version': list(sys.version_info[:2]), "
             "'prefix': sys.prefix, 'base_prefix': sys.base_prefix}))"],
            env=python_environment(),
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
        info = json.loads(probe.stdout)
        if (
            tuple(info["version"]) < (3, 9)
            or Path(info["prefix"]).resolve() != env_dir
            or info["prefix"] == info["base_prefix"]
        ):
            raise ValueError("올바른 가상환경 Python을 실행하지 못했습니다")
        marker.write_text(str(env_dir) + "\n", encoding="utf-8")
        return python
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        raise RuntimeError(".venv를 사용할 수 없습니다: " + str(exc) + ". " + REPAIR) from exc


def main(argv=None):
    """인자가 없으면 환경만 준비하고, 지정한 앱 파일이 있으면 그 파일로 프로세스를 교체한다."""
    parser = argparse.ArgumentParser(description="앱의 .venv 준비 및 실행")
    parser.add_argument("script", nargs="?", choices=SCRIPTS)
    parser.add_argument("args", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    python = ensure_environment()
    if args.script is None:
        print("준비 완료: " + str(python))
        return 0
    # 새 부모 프로세스를 남기지 않아 Ctrl+C가 기존 run.py의 종료 처리로 전달된다.
    # 경로를 인자 배열로 넘기므로 공백·한글이 있는 프로젝트 폴더에서도 동작한다.
    os.chdir(ROOT)
    os.execve(
        str(python),
        [str(python), str(ROOT / args.script), *args.args],
        python_environment(python.parent.parent),
    )


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError) as exc:
        print("Python 환경 준비 오류:", exc, file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\n환경 준비를 중단했습니다.", file=sys.stderr)
        sys.exit(130)
