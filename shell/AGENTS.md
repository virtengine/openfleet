# Shell Executors Guide

## Scope
Executor wrappers and runtime bridges for Codex, Copilot, Claude, Gemini, and OpenCode.

## Start Files
- `shell/codex-shell.mjs` + `shell/codex-config.mjs`
- `shell/copilot-shell.mjs`
- `shell/claude-shell.mjs`
- `shell/gemini-shell.mjs`
- `shell/opencode-shell.mjs` + `shell/opencode-providers.mjs`
- `shell/pwsh-runtime.mjs` - PowerShell runtime bridge

## Common Task Routing
- Executor startup/auth failures -> relevant shell file + `agent/agent-pool.mjs`.
- Model/profile resolution -> `codex-model-profiles.mjs`, `config/config.mjs`.
- Cross-platform shell issues -> `pwsh-runtime.mjs`, wrapper scripts in `kanban/`.

## Tests
- Focused: `npm test -- tests/*shell*.test.mjs tests/*provider*.test.mjs`
- Full: `npm test`
