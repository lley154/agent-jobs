#!/usr/bin/env bash
# Thin wrapper for Linux/macOS — all logic lives in the cross-platform
# launcher watch.mjs (so Linux/macOS/Windows share one implementation).
#
# Usage:   ./watch.sh "M5H 1T1" [--debug]
# Cron:    0 */3 * * *  cd /path/to/property-search && ./watch.sh "M5H 1T1" >> watch.log 2>&1
exec node "$(dirname "$0")/watch.mjs" "$@"
