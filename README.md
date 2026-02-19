# @virtengine/openfleet

**OpenFleet** is a production-grade supervisor for AI coding agents. It routes tasks across executors, manages retries and failover, automates PR lifecycle, and keeps you in control through Telegram (with optional WhatsApp and container isolation).

[Website](https://openfleet.virtengine.com) · [Docs](https://openfleet.virtengine.com/docs/) · [GitHub](https://github.com/virtengine/virtengine/tree/main/scripts/openfleet) · [npm](https://www.npmjs.com/package/@virtengine/openfleet) · [Issues](https://github.com/virtengine/virtengine/issues)

![CI](https://github.com/virtengine/virtengine/actions/workflows/ci.yaml/badge.svg)
![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![npm](https://img.shields.io/npm/v/@virtengine/openfleet.svg)

---

## Quick start

```bash
npm install -g @virtengine/openfleet
cd your-repo
openfleet
```

First run launches setup automatically. You can also run setup directly:

```bash
openfleet --setup
```

Requires:
- Node.js 18+
- Git
- Bash (for `.sh` wrappers) or PowerShell 7+ (for `.ps1` wrappers)
- GitHub CLI (`gh`) recommended

---

## What OpenFleet does

- Routes work across Codex, Copilot, and Claude executors
- Automates retries, failover, and PR lifecycle management
- Monitors runs and recovers from stalled or broken states
- Provides Telegram control and a Mini App dashboard
- Integrates with GitHub, Jira, and Vibe-Kanban boards

---

## Documentation

**Published docs (website):** https://openfleet.virtengine.com/docs/

**Source docs (markdown):** `_docs/` is the source of truth for long-form documentation. Keep `site/docs` in sync with these markdown files so the website mirrors the same content.

Key references:
- [GitHub adapter enhancements](_docs/KANBAN_GITHUB_ENHANCEMENT.md)
- [GitHub Projects v2 index](_docs/GITHUB_PROJECTS_V2_INDEX.md)
- [GitHub Projects v2 quickstart](_docs/GITHUB_PROJECTS_V2_QUICKSTART.md)
- [GitHub Projects v2 API](_docs/GITHUB_PROJECTS_V2_API.md)
- [GitHub Projects v2 monitoring](_docs/GITHUB_PROJECTS_V2_MONITORING.md)
- [GitHub Projects v2 checklist](_docs/GITHUB_PROJECTS_V2_IMPLEMENTATION_CHECKLIST.md)
- [Jira integration](_docs/JIRA_INTEGRATION.md)
- [Agent logging quickstart](docs/agent-logging-quickstart.md)
- [Agent logging design](docs/agent-work-logging-design.md)
- [Agent logging summary](docs/AGENT_LOGGING_SUMMARY.md)

---

## CI/CD and quality gates

OpenFleet enforces a strict quality pipeline in both local hooks and CI:

- **Pre-commit hooks** auto-format and lint staged files.
- **Pre-push hooks** run targeted checks based on changed files (Go, portal, docs).
- **Prepublish checks** validate package contents and release readiness.

Local commands you can run any time:

```bash
# Syntax + tests for openfleet package
npm -C scripts/openfleet test

# Prepublish safety checks
npm -C scripts/openfleet run prepublishOnly
```

---

## Repository layout

- `cli.mjs` — entrypoint for the supervisor
- `monitor.mjs` — main orchestration loop
- `config.mjs` — unified config loader
- `ui-server.mjs` — Telegram Mini App backend
- `site/` — marketing + docs website
- `docs/` and `_docs/` — documentation sources (markdown)

---

## License

Apache-2.0
