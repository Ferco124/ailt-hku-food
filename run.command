#!/bin/sh
# macOS double-click launcher. Finder opens .command files in Terminal and runs
# them through your login shell, which is the reliable way to start this app on a
# Mac. run.sh is invoked via `sh` so a ZIP-stripped executable bit cannot stop it.
set -u
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

sh ./run.sh
status=$?

if [ "$status" -ne 0 ]; then
  printf '\nThe launcher exited with status %s.\n' "$status" >&2
  printf '%s' 'Press Return to close. ' >&2
  read -r _
fi