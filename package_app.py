#!/usr/bin/env python3
"""Allowlisted portable ZIP; does not package user experiments or machine settings."""
# 다른 Mac으로 전달할 ZIP 생성기. 실행 위치와 무관하게 프로젝트 폴더 기준으로 묶는다.
# 포함 파일을 명시적으로 고르는 허용 목록 방식이라 개인 실험·로그·설정이 섞이지 않는다.
# 기본 ZIP은 코드·정적 화면·설명서·테스트만 담고 큰 모델 가중치나 런타임은 담지 않는다.
import argparse
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parent
BASE = [
    "README.md",
    "server.py",
    "evaluation.py",
    "bootstrap.py",
    "run.py",
    "setup_mac.py",
    "package_app.py",
    "start.command",
    "setup.command",
    ".gitignore",
    ".gitattributes",
    "report/decision-models-report.docx",
    "report/decision-models-report.pdf",
    "report/sources.json",
]


# 배포 ZIP 경로를 반환한다. include_models=True일 때만 프로젝트의 가중치를 추가한다.
# 중복 파일을 제거하고 정렬해 일관된 순서로 저장하며 심볼릭 링크는 거절한다.
# .tmp 파일을 완성한 뒤 교체하므로 실패 중인 새 압축본이 기존 정상 ZIP을 덮어쓰지 않는다.
# ZIP 내부 최상위 폴더를 decision-lab으로 통일해 다른 Mac에서 그대로 실행할 수 있게 한다.
def package(include_models=False):
    files = [ROOT / p for p in BASE if (ROOT / p).is_file()]
    files += (
        list((ROOT / "dist").glob("*.html"))
        + list((ROOT / "dist").glob("*.css"))
        + list((ROOT / "dist").glob("*.js"))
        + list((ROOT / "dist").glob("*.svg"))
    )
    files += list((ROOT / "tests").glob("test_*.py")) + list(
        (ROOT / "tests").glob("*.test.cjs")
    )
    # README가 연결하는 사용 안내·가상 예제·화면 이미지를 함께 보낸다.
    # 개인 실험과 조사 원문, 검증 로그, .git 이력은 이 허용 목록에 넣지 않는다.
    files += list((ROOT / "docs").glob("*.md"))
    files += list((ROOT / "docs/images").glob("*.jpg"))
    files += list((ROOT / "examples").glob("*.md"))
    files += list((ROOT / "examples").glob("*.json"))
    if include_models:
        for folder in [".models", ".ollaya-models"]:
            files += [
                f
                for f in (ROOT / folder).rglob("*")
                if f.is_file() and not f.is_symlink()
            ]
    out = (
        ROOT
        / "releases"
        / (
            "decision-lab-mac-with-models.zip"
            if include_models
            else "decision-lab-mac.zip"
        )
    )
    out.parent.mkdir(exist_ok=True)
    temp = out.with_suffix(".tmp")
    with zipfile.ZipFile(
        temp, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=5
    ) as z:
        for file in sorted(set(files)):
            if file.is_symlink():
                raise ValueError("배포에 심볼릭 링크를 포함하지 않습니다.")
            z.write(file, "decision-lab/" + str(file.relative_to(ROOT)))
    temp.replace(out)
    print(str(out) + " · " + str(out.stat().st_size) + " bytes")
    return out


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--include-models", action="store_true")
    args = parser.parse_args()
    package(args.include_models)
