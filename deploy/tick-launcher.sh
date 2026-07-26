#!/bin/bash
# Launcher for the growth-engine tick. deploy/build-menubar.sh and
# deploy/install-launchd.sh copy this to deploy/build/"<Product> Marketing
# Engine" so macOS (Login Items & Extensions → Allow in the Background,
# Activity Monitor) shows a legible name instead of "node" — those lists
# display the executable's filename. NODE_BIN is injected by the caller.
cd "$(dirname "$0")/../.." || exit 1
exec "${NODE_BIN:-node}" --env-file-if-exists=.env.local --import tsx scripts/run.ts
