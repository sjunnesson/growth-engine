#!/bin/bash
# Open the approval dashboard, starting it first if it isn't running.
# Used by the menu bar app; safe to run by hand too.
# The menu app launches this with the bare system PATH (no Homebrew), so
# npm/node must be found explicitly or the server silently never starts.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

# The menu bar app launches this with a bare GUI environment, so pick up the
# instance's port from .env.local (each instance must have its own PORT).
if [ -z "${PORT:-}" ] && [ -f .env.local ]; then
  PORT="$(grep -E '^PORT=' .env.local | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
fi
PORT="${PORT:-3400}"
export PORT

if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT"; then
  [ -d .next ] || npm run build >> .dashboard.log 2>&1
  nohup npm run dashboard >> .dashboard.log 2>&1 &
  for _ in $(seq 1 40); do
    curl -sf -o /dev/null "http://127.0.0.1:$PORT" && break
    sleep 0.5
  done
fi
open "http://127.0.0.1:$PORT/queue"
