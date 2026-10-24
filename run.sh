#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

# Finder, cron and IDE tasks do not inherit an interactive PATH, so a plain
# `command -v node` misses nvm, Volta and Homebrew installations.
find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.nvm/current/bin/node" \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/bin/node"
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if [ -x "./runtime/node" ]; then
  exec "./runtime/node" "./scripts/launch.mjs"
fi

if node_bin="$(find_node)"; then
  exec "$node_bin" "./scripts/launch.mjs"
fi

printf '%s\n' \
  'No Node runtime found.' \
  'Install Node.js 22.16 or newer from https://nodejs.org, then run this again,' \
  'or use the packaged release folder, which includes its own runtime.' >&2
exit 1