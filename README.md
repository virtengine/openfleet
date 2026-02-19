# bosun

Bosun is a production-grade supervisor for AI coding agents. It routes tasks across executors, automates PR lifecycles, and keeps operators in control through Telegram, the Mini App dashboard, and optional WhatsApp notifications.

[Website](https://bosun.virtengine.com) · [Docs](https://bosun.virtengine.com/docs/) · [GitHub](https://github.com/virtengine/bosun?tab=readme-ov-file#bosun) · [npm](https://www.npmjs.com/package/bosun) · [Issues](https://github.com/virtengine/bosun/issues)

[![CI](https://github.com/virtengine/bosun/actions/workflows/ci.yaml/badge.svg?branch=main)](https://github.com/virtengine/bosun/actions/workflows/ci.yaml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![npm](https://img.shields.io/npm/v/bosun.svg)](https://www.npmjs.com/package/bosun)

---

## Quick start

```bash
npm install -g bosun
cd your-repo
bosun
```

First run launches setup automatically. You can also run setup directly:

```bash
bosun --setup
```

Requires:
- Node.js 18+
- Git
- Bash (for `.sh` wrappers) or PowerShell 7+ (for `.ps1` wrappers)
- GitHub CLI (`gh`) recommended

---

## What Bosun does

- Routes work across Codex, Copilot, and Claude executors
- Automates retries, failover, and PR lifecycle management
- Monitors runs and recovers from stalled or broken states
- Provides Telegram control and a Mini App dashboard
- Integrates with GitHub, Jira, and Vibe-Kanban boards

---

## Documentation

**Published docs (website):** https://bosun.virtengine.com/docs/

**Source docs (markdown):** `_docs/` is the source of truth for long-form documentation. The website should be generated from the same markdown content so docs stay in sync.

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

Bosun enforces a strict quality pipeline in both local hooks and CI:

- **Pre-commit hooks** auto-format and lint staged files.
- **Pre-push hooks** run targeted checks based on changed files (Go, portal, docs).
- **Prepublish checks** validate package contents and release readiness.

Local commands you can run any time:

```bash
# Syntax + tests for bosun package
npm -C scripts/bosun test

# Prepublish safety checks
npm -C scripts/bosun run prepublishOnly
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
