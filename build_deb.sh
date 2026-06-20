#!/usr/bin/env bash
# Build the Linux .deb installer for screensound (Electron) via electron-builder.
# Usage: ./build_deb.sh   (run from anywhere; output lands in electron/dist/)
set -euo pipefail

cd "$(dirname "$0")/electron"

# First run on a fresh checkout: pull in electron-builder & friends.
[ -x node_modules/.bin/electron-builder ] || pnpm install

pnpm dist:linux

deb=$(realpath "$(ls -t dist/*.deb | head -1)")
printf '\n✓ Built: %s\n  Install with: sudo apt install "%s"\n' "$deb" "$deb"
