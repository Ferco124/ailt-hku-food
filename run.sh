#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -x "./runtime/node" ]; then
  exec "./runtime/node" "./scripts/launch.mjs"
fi
if command -v node >/dev/null 2>&1; then
  exec node "./scripts/launch.mjs"
fi
printf '%s\n' 'No bundled Node runtime found. Obtain the release folder for your OS, or install Node.js 22.16 or newer.' >&2
exit 1
