#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="${SCRIPT_DIR}/ve-orchestrator.mjs"

# Native Linux/macOS path only.
if [[ -f "${NODE_SCRIPT}" ]] && command -v node >/dev/null 2>&1; then
  NODE_SCRIPT_PATH="${NODE_SCRIPT}"
  NODE_PLATFORM="$(node -p 'process.platform' 2>/dev/null || true)"
  if [[ "${NODE_PLATFORM}" == "win32" ]] && command -v wslpath >/dev/null 2>&1; then
    NODE_SCRIPT_PATH="$(wslpath -w "${NODE_SCRIPT}")"
  fi
  exec node "${NODE_SCRIPT_PATH}" "$@"
fi

echo "[ve-orchestrator.sh] Native runtime unavailable (need node + ve-orchestrator.mjs)." >&2
exit 1
