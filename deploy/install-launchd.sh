#!/usr/bin/env bash
# Installs the growth-engine tick as a per-user macOS LaunchAgent.
#
# NOTE: launchd agents are DENIED under TCC-protected folders (~/Documents,
# ~/Desktop) — exit 126, no prompt. If the repo lives there, use the menu bar
# app (deploy/build-menubar.sh) as the scheduler instead. This installer is
# for checkouts in non-protected locations.
#
# Idempotent: re-run after changing the interval or moving the repo.
# Uninstall:  ./deploy/install-launchd.sh --uninstall
#
# This schedules an AUTONOMOUS engine. It is safe by default: nothing
# publishes until DRY_RUN=false / LIVE_CHANNELS is set in .env.local AND the
# product is marked reviewed. Flip those only after the SETUP.md drills.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PRODUCT_JSON="${PRODUCT_DIR:-$REPO/product}/product.json"
PRODUCT_NAME="$(node -p "JSON.parse(require('fs').readFileSync('$PRODUCT_JSON','utf8')).name")"
PRODUCT_SLUG="$(node -p "JSON.parse(require('fs').readFileSync('$PRODUCT_JSON','utf8')).slug")"
LABEL="${GROWTH_LAUNCHD_LABEL:-growth.$PRODUCT_SLUG}"
APP_NAME="${GROWTH_APP_NAME:-$PRODUCT_NAME Marketing Engine}"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
INTERVAL="${GROWTH_INTERVAL_SECONDS:-1800}"   # default: every 30 min

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST_DST"
  echo "[install] uninstalled $LABEL"
  exit 0
fi

NODE="$(command -v node || true)"
CLAUDE="$(command -v claude || true)"
[[ -z "$NODE"   ]] && { echo "ERROR: 'node' not found on PATH"; exit 1; }
[[ -z "$CLAUDE" ]] && { echo "ERROR: 'claude' not found on PATH — the AI provider needs Claude Code installed + authenticated (see SETUP.md)"; exit 1; }

# PATH the agent runs with: node dir + claude dir + standard locations.
AGENT_PATH="$(dirname "$NODE"):$(dirname "$CLAUDE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

# The tick launcher carries the app name as its filename so macOS
# background-item lists stay legible. Generated (deploy/build is gitignored).
TICK="$REPO/deploy/build/$APP_NAME"
mkdir -p "$REPO/deploy/build"
cp "$REPO/deploy/tick-launcher.sh" "$TICK"
chmod +x "$TICK"

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s#@LABEL@#$LABEL#g" \
    -e "s#@TICK@#$TICK#g" \
    -e "s#@NODE@#$NODE#g" \
    -e "s#@REPO@#$REPO#g" \
    -e "s#@PATH@#$AGENT_PATH#g" \
    -e "s#@INTERVAL@#$INTERVAL#g" \
    "$REPO/deploy/growth-tick.plist.template" > "$PLIST_DST"

# Reload cleanly.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo "[install] $LABEL installed — tick every ${INTERVAL}s"
echo "[install] node=$NODE"
echo "[install] claude=$CLAUDE"
echo "[install] logs: $REPO/.runner.log"
echo "[install] run now once:  launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "[install] uninstall:     $0 --uninstall"
