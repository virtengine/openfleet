# @virtengine/openfleet

Autonomous supervisor for AI coding workflows.

`openfleet` watches task execution, routes work across agent executors, handles retries/failover, automates PR lifecycle, and keeps you in control through Telegram (with optional WhatsApp and container isolation).

---

## Why openfleet

AI coding agents are fast, but unattended loops are expensive:

- silent failures
- repeated retries with no progress
- stale worktrees and merge drift
- disconnected notifications

`openfleet` is the control plane that keeps delivery moving:

- task routing and executor failover
- monitored orchestration and auto-recovery
- conflict/PR lifecycle automation
- live bot control (`/status`, `/tasks`, `/pause`, `/resume`, etc.)

---

## Install

```bash
npm install -g @virtengine/openfleet
```

Requires:

- Node.js 18+
- git
- Linux, macOS, and Windows are fully supported
- Shell runtime for your selected orchestrator wrapper:
  - Bash for `.sh` wrappers
  - PowerShell (`pwsh`) for `.ps1` wrappers
- GitHub CLI (`gh`) recommended

---

## Quick start

```bash
cd your-repo
openfleet
```

First run launches setup automatically.

You can also run setup directly:

```bash
openfleet --setup
```

---

## Setup modes (new)

The setup wizard now starts with two modes:

- **Recommended**
  - prompts only for important decisions (project identity, executor preset/model profile, AI provider, Telegram, board/execution mode)
  - keeps advanced knobs on proven defaults
  - writes a standardized `.env` based on `.env.example` so all options remain documented
  - auto-generates repository `.vscode/settings.json` with Copilot agent/subagent/MCP/autonomous defaults

- **Advanced**
  - full control over repository layout, failover/distribution, hook targets/overrides, orchestrator path, VK wiring details, and optional channels

---

## How openfleet can run

### 1) Standard foreground supervisor

```bash
openfleet
```

### 2) Daemon mode

```bash
openfleet --daemon
openfleet --daemon-status
openfleet --stop-daemon
```

### 3) Startup service (auto-start on login)

```bash
openfleet --enable-startup
openfleet --startup-status
openfleet --disable-startup
```

### 4) Interactive shell mode

```bash
openfleet --shell
```

### 5) Sentinel companion mode (Telegram watchdog)

```bash
openfleet --sentinel
openfleet --sentinel-status
openfleet --sentinel-stop
```

---

## Execution architecture modes

Configured by `EXECUTOR_MODE`:

- `internal` (recommended)
  - tasks run through internal agent pool in monitor process
- `vk`
  - task execution delegated to VK orchestrator flow
- `hybrid`
  - internal + VK behavior for mixed/overflow scenarios

Task board backend (`KANBAN_BACKEND`):

- `internal` - local task-store source of truth (default)
- `vk` - Vibe-Kanban adapter
- `github` - GitHub Issues with shared state persistence
- `jira` - Jira Issues with status/shared-state parity

Sync policy (`KANBAN_SYNC_POLICY`):

- `internal-primary` - internal task-store remains source of truth (default)
- `bidirectional` - external status changes may update internal tasks

Autonomous runtime defaults:

- Copilot shell runs with experimental mode + allow-all + no-ask-user by default
- Codex config enforces critical feature flags (`child_agents_md`, `memory_tool`, collaboration)
- Setup configures common MCP servers automatically (`context7`, `sequential-thinking`, `playwright`, `microsoft-docs`)

Experimental autonomous backlog replenishment:

- `INTERNAL_EXECUTOR_REPLENISH_ENABLED=true|false`
- `INTERNAL_EXECUTOR_REPLENISH_MIN_NEW_TASKS=1|2`
- `INTERNAL_EXECUTOR_REPLENISH_MAX_NEW_TASKS=1..3`
- `PROJECT_REQUIREMENTS_PROFILE=simple-feature|feature|large-feature|system|multi-system`

**GitHub adapter enhancements:**
The GitHub Issues adapter now supports multi-agent coordination via structured state persistence:

- Claim tracking with `codex:claimed`, `codex:working`, `codex:stale` labels
- Heartbeat mechanism to detect stale/abandoned claims
- Task exclusion via `codex:ignore` label
- Structured comments with JSON state for agent coordination

See [KANBAN_GITHUB_ENHANCEMENT.md](./KANBAN_GITHUB_ENHANCEMENT.md) for details.

### GitHub Projects v2 backend (Phase 1 + 2)

`openfleet` now supports GitHub Projects v2 as a first-class kanban source and sync target:

- Phase 1 (read): read tasks directly from a Projects v2 board (`GITHUB_PROJECT_MODE=kanban`)
- Phase 2 (write): sync task status updates back to the board `Status` field
- Bidirectional mapping between codex statuses and project status options
- Safe fallback to issues mode when project metadata is missing or unavailable

Enable with env config:

```env
KANBAN_BACKEND=github
GITHUB_PROJECT_MODE=kanban
GITHUB_PROJECT_OWNER=your-org-or-user
GITHUB_PROJECT_NUMBER=3
GITHUB_PROJECT_AUTO_SYNC=true
```

Status mapping overrides (optional):

```env
GITHUB_PROJECT_STATUS_TODO=Todo
GITHUB_PROJECT_STATUS_INPROGRESS=In Progress
GITHUB_PROJECT_STATUS_INREVIEW=In Review
GITHUB_PROJECT_STATUS_DONE=Done
GITHUB_PROJECT_STATUS_CANCELLED=Cancelled
```

Projects v2 docs:

- [GITHUB_PROJECTS_V2_QUICKSTART.md](./GITHUB_PROJECTS_V2_QUICKSTART.md)
- [GITHUB_PROJECTS_V2_API.md](./GITHUB_PROJECTS_V2_API.md)
- [GITHUB_PROJECTS_V2_MONITORING.md](./GITHUB_PROJECTS_V2_MONITORING.md)
- [GITHUB_PROJECTS_V2_IMPLEMENTATION_CHECKLIST.md](./GITHUB_PROJECTS_V2_IMPLEMENTATION_CHECKLIST.md)

**Jira adapter parity config:**
Jira supports the same openfleet status vocabulary and shared-state fields,
with explicit mapping via env vars:

```env
KANBAN_BACKEND=jira
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=***

JIRA_STATUS_TODO=To Do
JIRA_STATUS_INPROGRESS=In Progress
JIRA_STATUS_INREVIEW=In Review
JIRA_STATUS_DONE=Done
JIRA_STATUS_CANCELLED=Cancelled

JIRA_CUSTOM_FIELD_OWNER_ID=customfield_10042
JIRA_CUSTOM_FIELD_ATTEMPT_TOKEN=customfield_10043
JIRA_CUSTOM_FIELD_ATTEMPT_STARTED=customfield_10044
JIRA_CUSTOM_FIELD_HEARTBEAT=customfield_10045
JIRA_CUSTOM_FIELD_RETRY_COUNT=customfield_10046
JIRA_CUSTOM_FIELD_IGNORE_REASON=customfield_10047
```

Setup wizard note: running `openfleet --setup` and selecting Jira will
open the Atlassian API token page (opt-in), list projects, and guide you
through project/issue type selection interactively.

See [JIRA_INTEGRATION.md](./JIRA_INTEGRATION.md) for full configuration and examples.

---

## Channels and control surfaces

### Telegram (primary control channel)

Core controls include:

- `/help` (inline keyboard)
- `/status`, `/tasks`, `/agents`, `/threads`, `/worktrees`
- `/pause`, `/resume`, `/restart`, `/retry`
- `/executor`, `/sdk`, `/kanban`, `/maxparallel`

### Telegram Mini App (Control Center)

A full interactive web UI that runs inside Telegram as a Mini App. Enable it with two env vars:

```env
TELEGRAM_MINIAPP_ENABLED=true
TELEGRAM_UI_PORT=3080
```

Once enabled, the server auto-detects your LAN IP and sets the bot menu button.
Access the Mini App from Telegram via:

- **`/app`** command — sends an inline button to open the Control Center
- **Menu button** — tap the bot's menu button (set automatically)
- **Browser** — open `http://<your-lan-ip>:3080` directly

The Mini App provides 7 tabs: Dashboard, Tasks, Agents, Infra, Control, Logs, and Settings — all with real-time WebSocket updates, haptic feedback, and native Telegram theming.

**For public/remote access**, set up a tunnel (ngrok, Cloudflare Tunnel) and configure:

```env
TELEGRAM_UI_BASE_URL=https://your-tunnel-domain.example.com
```

**For local browser testing** (without Telegram auth):

```env
TELEGRAM_UI_ALLOW_UNSAFE=true
```

### WhatsApp (optional)

Enable in env and authenticate:

```bash
openfleet --whatsapp-auth
# or
openfleet --whatsapp-auth --pairing-code
```

Telegram status commands include:

- `/whatsapp`
- `/container`

---

## Container isolation (optional)

`container-runner` can isolate agent executions with:

- Docker
- Podman
- Apple Container (`container`) on macOS

Key env vars:

- `CONTAINER_ENABLED=1`
- `CONTAINER_RUNTIME=auto|docker|podman|container`
- `CONTAINER_IMAGE=node:22-slim`
- `MAX_CONCURRENT_CONTAINERS=3`

---

## Configuration model

Load order (highest priority first):

1. CLI flags
2. environment variables
3. `.env`
4. `openfleet.config.json`
5. built-in defaults

### Files

- `.env` — runtime/environment settings
- `openfleet.config.json` — structured config (executors, failover, repos, profiles)
- `.openfleet/agents/*.md` — prompt templates scaffolded by setup

### SDK transport defaults

`openfleet` supports explicit transport selectors per SDK shell:

- `CODEX_TRANSPORT=sdk|auto|cli`
- `COPILOT_TRANSPORT=sdk|auto|cli|url`
- `CLAUDE_TRANSPORT=sdk|auto|cli`

Setup now defaults all three to `sdk` for predictable persistent-session behavior.
`auto` remains available when you intentionally want endpoint/CLI auto-detection.

### Recommended profile split

- Local development profile:
  - `DEVMODE=true`
  - `DEVMODE_MONITOR_MONITOR_ENABLED=true`
  - `*_TRANSPORT=sdk`
- End-user stability profile:
  - `DEVMODE=false`
  - `DEVMODE_MONITOR_MONITOR_ENABLED=false`
  - `*_TRANSPORT=sdk`

---

## Recommended configuration path

If you want a strong baseline with minimal decisions:

1. Run `openfleet --setup`
2. Pick **Recommended** mode
3. Choose executor preset that matches your token budget and speed goals
4. Configure AI provider credentials
5. Configure Telegram
6. Keep defaults for hooks/VK/orchestrator unless you already have a custom flow

This gives you a standardized `.env` with full inline documentation and sane defaults.

---

## Advanced configuration path

Use **Advanced** mode when you need:

- custom multi-repo topology
- custom failover/distribution behavior
- manual orchestrator path/args
- custom hook policy and event overrides
- explicit VK URL/port and wiring behavior
- explicit optional channel/runtime tuning

---

## Key config examples

### Executor config (`openfleet.config.json`)

```json
{
  "$schema": "./openfleet.schema.json",
  "projectName": "my-project",
  "executors": [
    {
      "name": "copilot-claude",
      "executor": "COPILOT",
      "variant": "CLAUDE_OPUS_4_6",
      "weight": 50,
      "role": "primary",
      "enabled": true
    },
    {
      "name": "codex-default",
      "executor": "CODEX",
      "variant": "DEFAULT",
      "weight": 50,
      "role": "backup",
      "enabled": true
    }
  ],
  "failover": {
    "strategy": "next-in-line",
    "maxRetries": 3,
    "cooldownMinutes": 5,
    "disableOnConsecutiveFailures": 3
  },
  "distribution": "weighted"
}
```

### Env shorthand for executors

```env
EXECUTORS=COPILOT:CLAUDE_OPUS_4_6:50,CODEX:DEFAULT:50
```

### Minimal local env

```env
PROJECT_NAME=my-project
GITHUB_REPO=myorg/myrepo
KANBAN_BACKEND=internal
KANBAN_SYNC_POLICY=internal-primary
EXECUTOR_MODE=internal
INTERNAL_EXECUTOR_REPLENISH_ENABLED=false
PROJECT_REQUIREMENTS_PROFILE=feature
VK_BASE_URL=http://127.0.0.1:54089
VK_RECOVERY_PORT=54089
MAX_PARALLEL=6
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

For full variable documentation see `.env.example`.

---

## Useful commands

```bash
openfleet --help
openfleet --setup
openfleet --doctor
openfleet --update
openfleet --no-update-check
openfleet --no-auto-update
openfleet --no-telegram-bot
openfleet --telegram-commands
openfleet --no-vk-spawn
openfleet --vk-ensure-interval 60000
openfleet --script ./my-orchestrator.sh
openfleet --args "-MaxParallel 6"
```

`--doctor` validates effective config (.env + config JSON + process env overrides), reports actionable fixes, and exits non-zero when blocking issues are found.

---

## Validation and tests

From `scripts/openfleet`:

```bash
npm run syntax:check
npm run test
```

Focused tests (example):

```bash
npx vitest run tests/whatsapp-channel.test.mjs tests/container-runner.test.mjs tests/telegram-buttons.test.mjs
```

---

## Notes on generated `.env`

The setup wizard now standardizes `.env` generation by applying your selected values onto `.env.example`.

Benefits:

- all options stay documented in your generated file
- chosen values are explicitly activated/uncommented
- unchosen options remain visible as commented documentation
- easier upgrades over time as new options are added

---

## Troubleshooting quick checks

- `openfleet --help` for supported flags
- `openfleet --setup` to re-run configuration safely
- verify `.env` + `openfleet.config.json` are in your config directory
- verify `gh auth status` for PR operations
- verify Telegram token/chat id with `openfleet-chat-id`

---

## License

Apache 2.0
