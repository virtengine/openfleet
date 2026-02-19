#!/usr/bin/env bash
# publish-major.sh — safe wrapper around `npm run publish:major`
#
# See publish-minor.sh for details on why this wrapper exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

exec node publish.mjs --bump major "$@"
