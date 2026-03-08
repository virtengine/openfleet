# SecOps Hunter Run Log

## 2026-03-09 (secops/hunter-20260309b)
- Source: GitHub Code Scanning (`/repos/virtengine/bosun/code-scanning/alerts?state=open`) showed 143 open alerts at run start.
- Strategy: prioritize high-volume, low-regression fixes by replacing ReDoS-prone regexes and ambiguous parsers with deterministic string parsing.
- Files patched this run:
  - `agent/agent-supervisor.mjs`
  - `agent/autofix.mjs`
  - `shell/codex-config.mjs`
  - `workspace/workspace-manager.mjs`
  - `workspace/worktree-manager.mjs`
  - `lib/session-insights.mjs`
  - `infra/monitor.mjs`
  - `setup.mjs`
  - `voice/voice-agents-sdk.mjs`
- Validation completed:
  - `npm test -- tests/agent-supervisor.test.mjs tests/autofix.test.mjs tests/codex-config.test.mjs tests/workspace-manager.test.mjs tests/worktree-manager.test.mjs tests/session-insights.test.mjs tests/setup.test.mjs tests/setup-env-output.test.mjs tests/monitor-epic-pr-guards.test.mjs tests/voice-agents-sdk.test.mjs`
  - `npm run build`

## Security Tooling Added To Playbook (OSS/free)
- `semgrep` (SAST): `pipx install semgrep` then `semgrep scan --config p/security-audit .`
- `gitleaks` (secret scanning): `gitleaks detect --source . --no-git`
- `osv-scanner` (dependency vuln scanning): `osv-scanner --lockfile=package-lock.json`
- `trivy` filesystem scan: `trivy fs --scanners vuln,secret,misconfig .`

Notes:
- Keep scans in CI as non-blocking first; promote to blocking once false positives are baselined.
- For CodeQL parity checks, run the same suite touched in this run before pushing security regex/parser refactors.

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
