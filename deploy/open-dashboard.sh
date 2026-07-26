#!/bin/bash
# Open the dashboard (optionally at a given path, e.g. /setup), starting it
# first if it isn't running. Used by the menu bar app; safe to run by hand.
# The menu app launches this with the bare system PATH (no Homebrew), so
# npm/node must be found explicitly or the server silently never starts.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

DASH_PATH="${1:-/queue}"

# The menu bar app launches this with a bare GUI environment, so pick up the
# instance's port from .env.local (each instance must have its own PORT).
if [ -z "${PORT:-}" ] && [ -f .env.local ]; then
  PORT="$(grep -E '^PORT=' .env.local | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
fi
PORT="${PORT:-3400}"
export PORT

if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT"; then
  # Fresh clone: the menu bar app may be the very first thing that runs.
  [ -d node_modules ] || npm install >> .dashboard.log 2>&1
  # .next alone is not enough — a dev server leaves one without a production
  # BUILD_ID, and `next start` refuses it.
  [ -f .next/BUILD_ID ] || npm run build >> .dashboard.log 2>&1
  nohup npm run dashboard >> .dashboard.log 2>&1 &
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null "http://127.0.0.1:$PORT" && break
    sleep 0.5
  done
fi

# Never open a dead page: if the server didn't come up, fail loudly so the
# caller (menu bar app) can surface the error + log instead.
if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT"; then
  echo "[open-dashboard] server did not come up on :$PORT — see above" >> .dashboard.log
  exit 1
fi
open "http://127.0.0.1:$PORT$DASH_PATH"
