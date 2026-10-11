#!/bin/zsh
# Finder에서 두 번 눌러도 이 파일이 있는 프로젝트 폴더를 기준으로 실행한다.
# ${0:A:h}는 zsh에서 실행 파일의 절대 경로 중 부모 폴더를 얻는 표현이다.
cd -- "${0:A:h}"
# Finder로 실행하면 터미널과 PATH가 다를 수 있어 일반적인 Python 설치 위치를 보충한다.
export PATH="/opt/homebrew/bin:/usr/local/bin:/Library/Frameworks/Python.framework/Versions/Current/bin:$PATH"
# 다른 프로젝트의 설정 때문에 Python 상태 확인부터 실패하는 일을 피한다.
unset PYTHONHOME PYTHONPATH
# 명령 존재 여부와 Python 3.9 이상인지 함께 확인한다. 다른 Mac의 사용자명 경로는 사용하지 않는다.
if ! command -v python3 >/dev/null || ! python3 -c 'import sys; sys.exit(sys.version_info < (3,9))' 2>/dev/null; then
  print 'Python 3.9 이상이 필요합니다. 먼저 setup.command를 열어주세요.'
  read 'reply?Enter를 누르면 닫습니다. '
  exit 1
fi
# bootstrap이 .venv를 생성/확인한 뒤 그 Python으로 앱과 로컬 서버를 시작한다.
# 수동 activate는 필요 없다. 전달받은 --no-browser 등의 인자도 그대로 보낸다.
python3 bootstrap.py run.py "$@"
launcher_exit=$?
# 종료 메시지를 읽기 전에 터미널 창이 바로 닫히지 않게 기다린다.
if [[ -t 0 ]]; then
  read 'reply?Enter를 누르면 닫습니다. '
fi
exit "$launcher_exit"
