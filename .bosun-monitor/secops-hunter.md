## 2026-03-09 03:39:10 +11:00

- Scope: GitHub code-scanning remediation batch focused on `js/polynomial-redos` high-volume findings.
- Files hardened: `agent/agent-supervisor.mjs`, `agent/autofix.mjs`, `agent/fleet-coordinator.mjs`, `agent/hook-profiles.mjs`, `shell/codex-config.mjs`, `workspace/workspace-manager.mjs`, `workspace/worktree-manager.mjs`, `infra/maintenance.mjs`, `kanban/ve-kanban.mjs`, `kanban/vk-log-stream.mjs`, `server/setup-web-server.mjs`, `setup.mjs`, `task/task-assessment.mjs`, `telegram/telegram-bot.mjs`, `voice/voice-agents-sdk.mjs`.
- Security strategy: replaced risky regex patterns with bounded string parsing and explicit token/ordering checks to reduce ReDoS risk without behavior changes.
- Validation evidence: `node --check` passed on all touched files; `npm test` passed (156 files / 3429 tests); `npm run build` passed.
- Local OSS security tooling candidates (free, CLI-friendly):
  - `semgrep` (SAST rules, quick PR scans)
  - `gitleaks` (secret scanning)
  - `trivy fs` (dependency + IaC scanning)
  - `osv-scanner` (lockfile/package vulnerability checks)
  - `npm audit --omit=dev` (Node dependency CVEs)
  - `eslint-plugin-security` (JS security lint rules)

## 2026-03-09 12:25:00 +11:00

- Scope: GitHub code-scanning hardening batch focused on command-injection sinks and unsafe hostname substring checks.
- Files hardened: `agent/agent-endpoint.mjs`, `agent/agent-pool.mjs`, `agent/autofix.mjs`, `git/sdk-conflict-resolver.mjs`, `infra/container-runner.mjs`, `infra/library-manager.mjs`, `infra/monitor.mjs`, `server/ui-server.mjs`, `shell/codex-config.mjs`, `shell/codex-model-profiles.mjs`, `shell/codex-shell.mjs`, `voice/voice-tools.mjs`, `workspace/worktree-manager.mjs`.
- Security strategy: replaced shell-string execution with argument-safe `spawnSync` paths, added input validation for git refs/ports/repo URLs, and moved Azure host detection from substring checks to parsed-host suffix validation.
- Validation evidence:
  - `node --check` passed for all touched modules.
  - `npm test -- tests/library-manager.test.mjs tests/voice-tools.test.mjs tests/worktree-manager.test.mjs tests/ui-server.test.mjs` passed (214 tests).
  - `npm audit --audit-level=high --json` reports 0 vulnerabilities.
- Local OSS security tooling updates:
  - Executed: `npm audit --audit-level=high` (built-in dependency CVE scan).
  - Recommended next installs (free/open-source): `semgrep`, `gitleaks`, `osv-scanner`, `trivy`.
- Post-main CodeQL refresh (`run 22834818631`): open code-scanning alerts reduced from 94 to 65 (29 resolved this batch).

## 2026-03-09 15:29:17 +11:00

- Scope: SecOps follow-up batch on remaining CodeQL alerts (command/2nd-order injection, XSS, request forgery, insecure randomness, prototype pollution, stack-trace exposure, regex hardening).
- Files hardened: `infra/monitor.mjs`, `setup.mjs`, `server/ui-server.mjs`, `server/setup-web-server.mjs`, `git/sdk-conflict-resolver.mjs`, `task/task-executor.mjs`, `workspace/workspace-monitor.mjs`, `workflow/workflow-nodes.mjs`, `kanban/kanban-adapter.mjs`, `kanban/vk-log-stream.mjs`, `github/github-oauth-portal.mjs`, `voice/voice-action-dispatcher.mjs`, `voice/voice-tools.mjs`, `voice/voice-relay.mjs`, `voice/voice-auth-manager.mjs`, `task/task-store.mjs`, `desktop/main.mjs`, `lib/session-insights.mjs`, `ui/app.legacy.js`, `site/ui/app.legacy.js`, `site/js/telegram-chat-sim.js`, plus security regression tests.
- Security strategy: eliminate shell-string execution paths, enforce input/URL constraints before network or process dispatch, replace insecure randomness with `crypto.randomUUID`, add HTML sanitization before DOM injection, and harden error payloads to avoid stack exposure.
- Validation evidence:
  - `node --check` passed on all touched modules.
  - `npm test -- tests/monitor-is-branch-merged-guard.test.mjs tests/voice-auth-manager-oauth.test.mjs tests/ui-server.test.mjs` passed (99 tests).
  - Additional targeted suite run passed on 9 modules; one suite (`tests/setup-web-server-env.test.mjs`) currently fails under Vitest loader with `SyntaxError: Invalid or unexpected token` while passing under direct Node test loader (existing harness incompatibility to investigate separately).
  - `npm run build` passed.
- Local OSS security tooling updates:
  - Executed: `npm audit --audit-level=high`.
  - Recommended CLI installs (free/open source): `semgrep`, `gitleaks`, `osv-scanner`, `trivy`.

## 2026-03-09 15:52:40 +11:00

- Scope: PR #189 final follow-up to close residual CodeQL DOM-XSS alerts still open on PR head.
- Files hardened: `ui/app.legacy.js`, `site/ui/app.legacy.js`, `site/js/telegram-chat-sim.js`.
- Security strategy: removed parsed-DOM-to-HTML string roundtrip patterns (`innerHTML`/`createContextualFragment` from sanitized strings) and shifted to safer fragment/text handling to avoid DOM text reinterpretation sinks.
- Validation evidence:
  - `node --check ui/app.legacy.js site/ui/app.legacy.js site/js/telegram-chat-sim.js` passed.
  - `npm test -- tests/ui-server.test.mjs tests/demo-load-smoke.test.mjs` passed (51 tests).
- Local OSS security tooling updates:
  - No new tool install in this pass.
  - Existing recommended free CLI tools remain: `semgrep`, `gitleaks`, `osv-scanner`, `trivy`, plus `npm audit`.

## 2026-03-09 21:13:41 +11:00

- Scope: SecOps batch for remaining CodeQL alerts on task patching, workflow screenshot command execution, workspace git monitor shaping, and vendor shim string-sanitization paths.
- Files hardened: `task/task-store.mjs`, `workflow/workflow-nodes.mjs`, `workspace/workspace-monitor.mjs`, `ui/vendor/es-module-shims.js`, `site/ui/vendor/es-module-shims.js`.
- Security strategy:
  - replaced dynamic task property assignment with a direct allowlist to avoid prototype-polluting key writes.
  - replaced shell-string `node -e` execution with argument-safe `spawnSync` in screenshot workflow path.
  - constrained monitor git invocations to fixed command shapes before process spawn.
  - hardened vendor shim inline-script data/URL literal escaping (`wasmBytes` serialization and URL JS string encoding).
- Validation evidence:
  - `node --check` passed on all touched files.
  - `npm test -- tests/workflow-task-lifecycle.test.mjs tests/worktree-manager.test.mjs tests/ui-server.test.mjs` passed (252 tests).
- Local OSS tooling notes:
  - Executed: `npm audit` during install (0 vulnerabilities).
  - Keep free CLI stack in rotation: `semgrep`, `gitleaks`, `osv-scanner`, `trivy`, `npm audit`.
