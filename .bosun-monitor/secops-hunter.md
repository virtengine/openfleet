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
