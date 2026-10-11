#!/bin/zsh
# Finder에서 두 번 눌러도 이 파일이 있는 프로젝트 폴더를 기준으로 실행한다.
# ${0:A:h}는 zsh에서 실행 파일의 절대 경로 중 부모 폴더를 얻는 표현이다.
cd -- "${0:A:h}"
# Finder로 실행하면 터미널과 PATH가 다를 수 있어 일반적인 Python 설치 위치를 보충한다.
export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"
# 명령 존재 여부와 Python 3.9 이상인지 함께 확인한다. 다른 Mac의 사용자명 경로는 사용하지 않는다.
if ! command -v python3 >/dev/null || ! python3 -c 'import sys; sys.exit(sys.version_info < (3,9))' 2>/dev/null; then
  print 'Python 3.9 이상이 필요합니다. 공식 macOS 설치를 마친 뒤 이 파일을 다시 열어주세요.'
  open 'https://www.python.org/downloads/macos/'
  read 'reply?Enter를 누르면 닫습니다. '
  exit 1
fi
# 준비 도구를 실행한다. 네트워크 다운로드와 설치는 이 Python 파일에서 관리한다.
python3 setup_mac.py
# 종료 메시지를 읽기 전에 터미널 창이 바로 닫히지 않게 기다린다.
read 'reply?Enter를 누르면 닫습니다. '
