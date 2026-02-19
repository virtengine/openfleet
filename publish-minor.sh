#!/usr/bin/env bash
# publish-minor.sh — safe wrapper around `npm run publish:minor`
#
# Resolves the script's own directory before launching node, so this works
# even when your shell's CWD is a stale/deleted git worktree inode (which
# causes npm's startup uv_cwd check to throw ENOENT before running anything).
#
# Usage:
#   ./publish-minor.sh                          # bump patch digit, publish
#   NPM_ACCESS_TOKEN=npm_xxx ./publish-minor.sh
#   ./publish-minor.sh --dry-run
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

exec node publish.mjs --bump minor "$@"
