# Setup Portal Guide (`bosun --setup`)

This guide documents every option, field, and environment variable produced by the Bosun setup wizard. Run it once to configure a new project or any time you need to change settings.

---

## Table of Contents

1. [Launching the Setup Wizard](#launching-the-setup-wizard)
2. [Prerequisites](#prerequisites)
3. [Project Settings](#project-settings)
4. [Executor Configuration](#executor-configuration)
   - [GitHub Copilot (COPILOT)](#github-copilot-copilot)
   - [OpenAI Codex (CODEX)](#openai-codex-codex)
   - [Claude Code (CLAUDE_CODE)](#claude-code-claude_code)
   - [Multi-Executor Setup](#multi-executor-setup)
5. [Kanban Backend](#kanban-backend)
   - [Internal SQLite](#internal-sqlite)
   - [GitHub Projects](#github-projects)
   - [Jira](#jira)
6. [Telegram Integration](#telegram-integration)
7. [Orchestration & Failover](#orchestration--failover)
8. [Advanced: Codex Model Profiles](#advanced-codex-model-profiles)
9. [Advanced: Copilot Options](#advanced-copilot-options)
10. [Advanced: Infrastructure](#advanced-infrastructure)
11. [Output Files](#output-files)
12. [Side Effects at Apply Time](#side-effects-at-apply-time)
13. [Environment Variable Reference](#environment-variable-reference)

---

## Launching the Setup Wizard

```bash
# Interactive web UI (recommended) — opens browser at http://localhost:3456
bosun --setup

# Headless terminal mode — same fields, no browser required
bosun --setup-terminal
```

Both modes write identical output files. Use `--setup-terminal` in SSH sessions, containers, or CI pipelines where a browser is unavailable.

The web portal runs on **port 3456** by default. Set `VK_RECOVERY_PORT` in your environment to change it. It binds only to `127.0.0.1` — it is not accessible from the network unless you tunnel it.

---

## Prerequisites

Bosun's setup wizard validates these before letting you proceed:

| Dependency | Required version | Notes |
|---|---|---|
| Node.js | 18 or later | Check with `node --version` |
| Git | any recent | Must be in `PATH` |
| `gh` CLI | any recent | Must be authenticated — run `gh auth login` first |
| PowerShell | 7+ (Windows only) | Used for hook scripts on Windows |

**GitHub authentication is required** even if you are using Codex or Claude Code as your executor — `gh` is used for issue management, PR operations, and the reconciler.

---

## Project Settings

These fields identify your project and where Bosun stores its data.

### Project Name

**Env var:** `PROJECT_NAME`

Human-readable name shown in the dashboard, Telegram messages, and log output. Defaults to the directory name of `GITHUB_REPO`.

> **Tip:** Use a short, memorable name. It appears in every Telegram notification.

---

### GitHub Repo Slug

**Env var:** `GITHUB_REPO`

The `owner/repo` slug of your GitHub repository, e.g. `acme/my-app`. Used by the reconciler, PR operations, and the optional GitHub Projects kanban backend.

> **Tip:** Run `gh repo view --json nameWithOwner -q .nameWithOwner` to copy the exact slug.

---

### Bosun Home Directory

**Env var:** `BOSUN_HOME`  
**Default:** `~/bosun`

Where Bosun stores its global configuration — the agent library, shared knowledge, and log rotation scripts. All your projects can share one `BOSUN_HOME`.

> **Tip:** On a machine that runs multiple repositories, keep `BOSUN_HOME` at `~/bosun` (the default). Per-project overrides live in `.bosun/` inside each repo.

---

### Workspaces Directory

**Env var:** `BOSUN_WORKSPACES_DIR`  
**Config key:** `workspacesDir`

Where Bosun clones agent workspaces (sandboxed git worktrees). Each concurrent agent gets its own subdirectory here.

> **Warning:** This directory can grow large if many concurrent agents are running. Point it to a drive with plenty of space, or set a cleanup policy via the Workspace Hygiene workflow template.

---

## Executor Configuration

An **executor** is the AI coding agent that performs tasks. Bosun supports three SDKs. You can configure one or more.

**Env var:** `EXECUTORS` (comma-separated list, e.g. `COPILOT,CODEX`)

---

### GitHub Copilot (COPILOT)

**When to use:** Default recommendation. No API key required if you have a GitHub Copilot subscription. Best model quality for code tasks.

**Authentication:** OAuth via `gh auth login`. Bosun uses your existing `gh` session — no additional tokens needed.

| Field | Env var | Default | Description |
|---|---|---|---|
| Model | `COPILOT_MODEL` | `claude-opus-4.6` | Copilot model to use for coding tasks. |
| Transport | `COPILOT_TRANSPORT` | `mcp` | Protocol for Copilot API calls. Leave as `mcp` unless instructed otherwise. |
| Max requests | `COPILOT_AGENT_MAX_REQUESTS` | 200 | Hard cap on API calls per agent session to prevent runaway usage. |
| No experimental features | `COPILOT_NO_EXPERIMENTAL` | false | Disables beta/preview Copilot APIs. Safer in production environments. |
| No allow-all | `COPILOT_NO_ALLOW_ALL` | false | Restricts Copilot tool access to explicitly approved tools. |
| Ask user | `COPILOT_ENABLE_ASK_USER` | false | Allows agents to pause and prompt for human input mid-task. |
| All GitHub MCP tools | `COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS` | false | Grants access to the full GitHub MCP tool set (not just PR/issue tools). |
| MCP config file | `COPILOT_MCP_CONFIG` | — | Path to a custom `mcp.json` that extends Copilot's tool list. |

> **Recommended model:** `claude-opus-4.6` provides the best balance of code quality and speed. `gpt-4o` is a good alternative if you prefer OpenAI models via Copilot.

---

### OpenAI Codex (CODEX)

**When to use:** When you want direct OpenAI API access with fine-grained model/profile control, or when using a self-hosted OpenAI-compatible API.

**Authentication:** API key stored in `CODEX_API_KEY` (or `OPENAI_API_KEY`).

| Field | Env var | Default | Description |
|---|---|---|---|
| API key | `CODEX_API_KEY` | — | Your OpenAI API key. Required. |
| Model | `CODEX_MODEL` | `gpt-5.3-codex` | Default model for coding tasks. |
| Model profile | `CODEX_MODEL_PROFILE` | `default` | Named profile that bundles model + settings (see [Codex Model Profiles](#advanced-codex-model-profiles)). |
| Max threads | `CODEX_AGENT_MAX_THREADS` | 4 | Max parallel threads per Codex agent session. |
| Transport | `CODEX_TRANSPORT` | `api` | `api` (direct REST) or `mcp`. |
| Sandbox | `CODEX_SANDBOX` | false | Enables Codex sandbox mode (restricted filesystem/network). |
| Sandbox permissions | `CODEX_SANDBOX_PERMISSIONS` | — | Comma-separated list of extra sandbox permissions to grant. |
| Sandbox writable roots | `CODEX_SANDBOX_WRITABLE_ROOTS` | — | Paths the sandbox can write to. |
| Disable bwrap | `CODEX_FEATURES_NO_BWRAP` | false | Disables `bwrap` Linux namespacing. Required on systems without kernel support. |

> **Tip:** Use `CODEX_TRANSPORT=mcp` if your environment blocks direct OpenAI API connections and you are routing through the Codex MCP proxy.

---

### Claude Code (CLAUDE_CODE)

**When to use:** When you want Anthropic Claude models with the Claude Code SDK. Supports both OAuth (via Claude.ai) and API key.

| Field | Env var | Default | Description |
|---|---|---|---|
| Auth method | — | OAuth | Choose between OAuth (sign in via browser) or API key. |
| API key | `ANTHROPIC_API_KEY` | — | Required if using API key auth. |
| Model | `CLAUDE_MODEL` | `claude-opus-4.6` | Claude model to use. |

---

### Multi-Executor Setup

You can run multiple executors simultaneously. Bosun distributes tasks across them according to `EXECUTOR_DISTRIBUTION`.

```
EXECUTORS=COPILOT,CODEX
EXECUTOR_DISTRIBUTION=weighted
```

| Distribution | Description |
|---|---|
| `weighted` | Route tasks proportionally based on per-executor capacity / load. |
| `round-robin` | Alternate tasks evenly across executors, ignoring load. |
| `failover` | Use the secondary executor only when the primary hits errors. |

**Failover configuration:**

| Env var | Default | Description |
|---|---|---|
| `FAILOVER_STRATEGY` | `sequential` | `sequential` = try executors in order; `parallel` = try all at once, take first success |
| `FAILOVER_COOLDOWN_MINUTES` | 5 | Minutes to wait before retrying a failed executor |
| `FAILOVER_DISABLE_ON_CONSECUTIVE_FAILURES` | — | Pause an executor after this many consecutive failures (0 = never auto-disable) |

---

## Kanban Backend

The kanban backend controls where tasks are stored and how the board is rendered.

**Env var:** `KANBAN_BACKEND` (`internal` | `github` | `jira`)

---

### Internal SQLite

**Value:** `internal` *(default, recommended)*

Zero-configuration task storage backed by SQLite. No external accounts or tokens required. Tasks live entirely on your machine and are accessible from the Bosun dashboard.

> **Best for:** Solo developers, new projects, team setups where you want to avoid GitHub Projects billing or Jira licensing.

**Optional auto-replenishment:**

| Env var | Default | Description |
|---|---|---|
| `INTERNAL_EXECUTOR_REPLENISH_ENABLED` | false | Automatically fill the backlog when it runs low. |
| `INTERNAL_EXECUTOR_MIN_NEW_TASKS` | 1 | Minimum tasks to generate per replenishment batch. |
| `INTERNAL_EXECUTOR_MAX_NEW_TASKS` | 5 | Maximum tasks to generate per replenishment batch. |

---

### GitHub Projects

**Value:** `github`

Uses a GitHub Projects V2 board as the kanban backend. Task status is synced bidirectionally — moving a card in GitHub Projects updates Bosun and vice versa.

| Field | Env var | Description |
|---|---|---|
| Project number | `GITHUB_PROJECT_NUMBER` | The numeric ID of your GitHub Project. Find it in the project URL: `github.com/orgs/acme/projects/12` → `12`. |

> **Prerequisite:** Create the project first in GitHub. Bosun needs columns named **To Do**, **In Progress**, **In Review**, and **Done** (exact casing required, or configure `GITHUB_PROJECT_COLUMN_MAP`).

---

### Jira

**Value:** `jira`

Syncs tasks with an Atlassian Jira project. Supports both Jira Cloud and Jira Server.

| Field | Env var | Description |
|---|---|---|
| Instance URL | `JIRA_URL` | Base URL of your Jira instance, e.g. `https://acme.atlassian.net` |
| Project key | `JIRA_PROJECT_KEY` | Your Jira project key, e.g. `MYPROJ` |
| API token | `JIRA_API_TOKEN` | Jira API token (from Atlassian account settings → API tokens). For Jira Server use a Personal Access Token. |

> **Tip:** The sync is eventually consistent — Bosun polls Jira every `JIRA_SYNC_INTERVAL_MINUTES` (default 2) for status changes.

---

## Telegram Integration

Bosun can send progress notifications and alerts to a Telegram chat via a bot.

| Field | Env var | Default | Description |
|---|---|---|---|
| Bot token | `TELEGRAM_BOT_TOKEN` | — | Create a bot with [@BotFather](https://t.me/BotFather) and copy the token (format: `123456:ABC-DEF...`). |
| Chat ID | `TELEGRAM_CHAT_ID` | — | Numeric ID of the chat. For groups and channels it is **negative** (e.g. `-1001234567890`). Run `bosun --get-telegram-chat-id` after adding the bot to get this value. |
| UI tunnel | `TELEGRAM_UI_TUNNEL` | `auto` | `auto` = Bosun automatically exposes the dashboard via a tunnel when a message arrives. `disabled` = no tunnel. |
| Allow unsafe tunnel | `TELEGRAM_UI_ALLOW_UNSAFE` | false | Allows HTTP (non-HTTPS) tunnels. Not recommended in production. |
| Polling interval | `TELEGRAM_INTERVAL_MIN` | 1 | How often (in minutes) Bosun polls Telegram for new commands. Lower = more responsive, higher API usage. |

**Getting your Chat ID:**

```bash
bosun --get-telegram-chat-id
# 1. Send any message to your bot in Telegram
# 2. Bosun prints the chat ID to stdout
```

> **Tip:** For a group chat, add the bot to the group first, then run the command above. The printed ID for a group starts with `-100`.

---

## Orchestration & Failover

These settings control how many agents run in parallel and how Bosun responds to failures.

| Field | Env var | Default | Description |
|---|---|---|---|
| Max parallel agents | `MAX_PARALLEL` | 6 | Maximum number of concurrent agent sessions across all executors. Set lower to reduce API costs; higher for throughput. |
| Max retries per task | `MAX_RETRIES` | 3 | How many times Bosun will retry a failed task before marking it as blocked. |
| Failover cooldown | `FAILOVER_COOLDOWN_MINUTES` | 5 | Minimum minutes to wait between retrying a failed executor in failover mode. |
| Consecutive failure limit | `FAILOVER_DISABLE_ON_CONSECUTIVE_FAILURES` | — | Auto-disable an executor after this many consecutive failures. Protects against misconfigured executors draining API quota. |
| Primary agent | `PRIMARY_AGENT` | `bosun` | The named agent profile to use for orchestration decisions (not task execution). |
| Executor mode | `EXECUTOR_MODE` | `pool` | `pool` = agents are pooled and reused between tasks; `fresh` = new agent per task. |
| Orchestrator script | `ORCHESTRATOR_SCRIPT` | — | Path to a custom orchestrator MJS file if you need to override the default task-dispatch logic. |
| Orchestrator args | `ORCHESTRATOR_ARGS` | — | Extra CLI arguments appended to the orchestrator launch command. |

> **Tuning `MAX_PARALLEL`:** A value of 6 works well for most repositories. If you have many independent tasks and fast API limits, try 8–12. If you are on a free tier with rate limits, 1–2 is safer.

---

## Advanced: Codex Model Profiles

Model profiles bundle a model name + tuning parameters under a named key. Bosun ships several built-in profiles and you can define custom ones.

| Env var | Description |
|---|---|
| `CODEX_MODEL_PROFILE` | Default profile for all Codex tasks. |
| `CODEX_MODEL_PROFILE_SUBAGENT` | Profile used for sub-agent spawned tasks. |
| `CODEX_MODEL_PROFILE_XL_TASK` | Profile for large / long-horizon tasks. |
| `CODEX_MODEL_PROFILE_XL_MODEL` | Model override for XL tasks. |
| `CODEX_MODEL_PROFILE_XL_ARGS` | Extra CLI args for XL task sessions. |
| `CODEX_MODEL_PROFILE_M_TASK` | Profile for medium-complexity tasks. |
| `CODEX_MODEL_PROFILE_M_MODEL` | Model override for medium tasks. |
| `CODEX_MODEL_PROFILE_M_ARGS` | Extra CLI args for medium task sessions. |

**Built-in profile names:** `default`, `fast`, `quality`, `budget`.

> **Tip:** Use profile `quality` for complex refactoring or architectural tasks where accuracy matters more than speed. Use `fast` for trivial tasks like adding comments or formatting.

---

## Advanced: Copilot Options

Fine-grained control over GitHub Copilot agent behaviour.

| Env var | Default | Description |
|---|---|---|
| `COPILOT_AGENT_MAX_REQUESTS` | 200 | Hard limit on API requests per session. Prevents runaway cost from stuck agents. |
| `COPILOT_TRANSPORT` | `mcp` | API transport protocol. `mcp` uses the Model Context Protocol; `api` calls the Copilot REST API directly. |
| `COPILOT_NO_EXPERIMENTAL` | false | Set `true` to disable experimental Copilot features (more stable, fewer capabilities). |
| `COPILOT_NO_ALLOW_ALL` | false | Set `true` to restrict Copilot to an explicit tool allowlist. Use this in security-sensitive environments. |
| `COPILOT_ENABLE_ASK_USER` | false | Allows agents to pause mid-task and send a Telegram message asking for human clarification. |
| `COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS` | false | Grants access to every GitHub MCP tool (e.g. Project automation, Actions triggers). Only enable if your workflows require it. |
| `COPILOT_MCP_CONFIG` | — | Path to a JSON file extending the Copilot MCP tool configuration. Use this to add custom MCP servers. |

---

## Advanced: Infrastructure

Settings for containerisation, tunneling, and runtime extras.

| Env var | Default | Description |
|---|---|---|
| `CONTAINER_ENABLED` | false | Run each agent session inside a Docker/Podman container for filesystem isolation. |
| `CONTAINER_RUNTIME` | `docker` | Container runtime: `docker` or `podman`. |
| `VK_BASE_URL` | `http://localhost:3456` | Public-facing base URL for the Bosun dashboard. Used when generating share links or Telegram deep links. |
| `VK_RECOVERY_PORT` | 3456 | HTTP port the setup wizard and dashboard listen on. Change if 3456 is already in use. |
| `WHATSAPP_ENABLED` | false | Experimental: enables WhatsApp notification support via a WhatsApp API gateway. |

---

## Output Files

Running the setup wizard and clicking **Apply** produces the following files:

### `.env`

Written to the repository root. Contains all configured environment variables. This file is added to `.gitignore` automatically.

```dotenv
# Example .env snippet
PROJECT_NAME=my-app
GITHUB_REPO=acme/my-app
BOSUN_HOME=/home/user/bosun
BOSUN_WORKSPACES_DIR=/home/user/bosun/workspaces/my-app
EXECUTORS=COPILOT
COPILOT_MODEL=claude-opus-4.6
KANBAN_BACKEND=internal
MAX_PARALLEL=6
MAX_RETRIES=3
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...
TELEGRAM_CHAT_ID=-1001234567890
```

### `bosun.config.json`

Written to the repository root. Machine-readable configuration used by the Bosun daemon.

```jsonc
{
  "projectName": "my-app",
  "bosunHome": "/home/user/bosun",
  "workspacesDir": "/home/user/bosun/workspaces/my-app",
  "executors": [
    {
      "id": "copilot-1",
      "sdk": "copilot",
      "model": "claude-opus-4.6",
      "maxParallel": 6
    }
  ],
  "failover": {
    "strategy": "sequential",
    "cooldownMinutes": 5
  },
  "distribution": "weighted",
  "kanbanBackend": "internal"
}
```

### Scaffolded directories and files

| Path | Description |
|---|---|
| `workspaces/` | Root directory for agent worktrees (created if absent). |
| `.bosun/hooks/` | Hook script stubs (`pre-task.sh`, `post-task.sh`, `on-error.sh`). |
| `.bosun/prompts/` | Default prompt placeholders. |
| `.bosun/library.json` | Empty library manifest (if not already present). |
| `.vscode/settings.json` | Adds recommended VS Code settings (editor, terminal, git). |
| `.codex/config.json` | Codex project config (if Codex executor selected). |

---

## Side Effects at Apply Time

In addition to writing output files, the setup wizard performs these system-level changes:

### Codex: trusted projects registration

If Codex is selected, Bosun adds the repository root to the `trusted_projects` list in `~/.codex/config.toml`. This prevents Codex from prompting for permission every session.

```toml
# ~/.codex/config.toml (appended automatically)
[trusted_projects]
"/home/user/projects/my-app" = true
```

### Claude Code: additional directories

If Claude Code is selected, Bosun adds the repository root (and workspaces directory) to `additionalDirectories` in `~/.claude/settings.json`:

```json
{
  "additionalDirectories": ["/home/user/projects/my-app"]
}
```

This grants Claude Code read/write access to the project outside of the standard working directory.

### Global Codex config

A shared `.codex/config.json` is written inside `BOSUN_HOME` with model preferences and tool permissions so that all projects sharing the same `BOSUN_HOME` get consistent Codex defaults.

### VS Code settings

`.vscode/settings.json` is created (or merged) with:
- `git.enableSmartCommit: true`
- `terminal.integrated.defaultProfile.*`: points to the system shell
- `editor.formatOnSave: true`

These are non-destructive defaults — they do not overwrite any existing values.

---

## Environment Variable Reference

Complete alphabetical reference for every variable the setup wizard may write.

| Variable | Section | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Executor — Claude | — | Claude API key (API key auth mode only) |
| `BOSUN_HOME` | Project | `~/bosun` | Global Bosun home directory |
| `BOSUN_WORKSPACES_DIR` | Project | `~/bosun/workspaces/<project>` | Agent workspace root |
| `CODEX_AGENT_MAX_THREADS` | Codex | 4 | Max parallel threads per Codex session |
| `CODEX_API_KEY` | Codex | — | OpenAI / Codex API key |
| `CODEX_FEATURES_NO_BWRAP` | Codex | false | Disable Linux bwrap namespacing |
| `CODEX_MODEL` | Codex | `gpt-5.3-codex` | Codex model name |
| `CODEX_MODEL_PROFILE` | Codex | `default` | Named model profile |
| `CODEX_MODEL_PROFILE_M_ARGS` | Codex | — | CLI args for medium task profile |
| `CODEX_MODEL_PROFILE_M_MODEL` | Codex | — | Model for medium task profile |
| `CODEX_MODEL_PROFILE_M_TASK` | Codex | — | Medium task profile name |
| `CODEX_MODEL_PROFILE_SUBAGENT` | Codex | — | Sub-agent model profile |
| `CODEX_MODEL_PROFILE_XL_ARGS` | Codex | — | CLI args for XL task profile |
| `CODEX_MODEL_PROFILE_XL_MODEL` | Codex | — | Model for XL task profile |
| `CODEX_MODEL_PROFILE_XL_TASK` | Codex | — | XL task profile name |
| `CODEX_SANDBOX` | Codex | false | Enable Codex sandbox mode |
| `CODEX_SANDBOX_PERMISSIONS` | Codex | — | Comma-separated extra sandbox permissions |
| `CODEX_SANDBOX_WRITABLE_ROOTS` | Codex | — | Filesystem paths sandbox can write to |
| `CODEX_TRANSPORT` | Codex | `api` | API transport: `api` or `mcp` |
| `CONTAINER_ENABLED` | Infrastructure | false | Enable container isolation per agent |
| `CONTAINER_RUNTIME` | Infrastructure | `docker` | Container runtime: `docker` or `podman` |
| `COPILOT_AGENT_MAX_REQUESTS` | Copilot | 200 | Max API requests per Copilot session |
| `COPILOT_ENABLE_ALL_GITHUB_MCP_TOOLS` | Copilot | false | Enable full GitHub MCP toolset |
| `COPILOT_ENABLE_ASK_USER` | Copilot | false | Allow agents to ask humans mid-task |
| `COPILOT_MCP_CONFIG` | Copilot | — | Path to custom MCP config JSON |
| `COPILOT_MODEL` | Copilot | `claude-opus-4.6` | Model for Copilot tasks |
| `COPILOT_NO_ALLOW_ALL` | Copilot | false | Restrict Copilot to allowlisted tools |
| `COPILOT_NO_EXPERIMENTAL` | Copilot | false | Disable experimental Copilot features |
| `COPILOT_TRANSPORT` | Copilot | `mcp` | Copilot transport protocol |
| `EXECUTOR_DISTRIBUTION` | Multi-executor | `weighted` | `weighted`, `round-robin`, or `failover` |
| `EXECUTOR_MODE` | Orchestration | `pool` | `pool` or `fresh` |
| `EXECUTORS` | Executor | `COPILOT` | Comma-separated executor IDs |
| `FAILOVER_COOLDOWN_MINUTES` | Orchestration | 5 | Minutes between retrying a failed executor |
| `FAILOVER_DISABLE_ON_CONSECUTIVE_FAILURES` | Orchestration | — | Auto-disable threshold |
| `FAILOVER_STRATEGY` | Orchestration | `sequential` | `sequential` or `parallel` |
| `GITHUB_PROJECT_NUMBER` | Kanban — GitHub | — | GitHub Projects V2 number |
| `GITHUB_REPO` | Project | — | `owner/repo` slug |
| `INTERNAL_EXECUTOR_MAX_NEW_TASKS` | Kanban — Internal | 5 | Max tasks per replenishment |
| `INTERNAL_EXECUTOR_MIN_NEW_TASKS` | Kanban — Internal | 1 | Min tasks per replenishment |
| `INTERNAL_EXECUTOR_REPLENISH_ENABLED` | Kanban — Internal | false | Enable auto-replenishment |
| `JIRA_API_TOKEN` | Kanban — Jira | — | Jira API or Personal Access Token |
| `JIRA_PROJECT_KEY` | Kanban — Jira | — | Jira project key, e.g. `MYPROJ` |
| `JIRA_URL` | Kanban — Jira | — | Jira instance base URL |
| `KANBAN_BACKEND` | Kanban | `internal` | `internal`, `github`, or `jira` |
| `MAX_PARALLEL` | Orchestration | 6 | Max concurrent agent sessions |
| `MAX_RETRIES` | Orchestration | 3 | Max task retry attempts |
| `ORCHESTRATOR_ARGS` | Orchestration | — | Extra args for the orchestrator script |
| `ORCHESTRATOR_SCRIPT` | Orchestration | — | Custom orchestrator script path |
| `PRIMARY_AGENT` | Orchestration | `bosun` | Named agent profile for orchestration |
| `PROJECT_NAME` | Project | — | Human display name for the project |
| `TELEGRAM_BOT_TOKEN` | Telegram | — | Bot API token from @BotFather |
| `TELEGRAM_CHAT_ID` | Telegram | — | Numeric chat / group ID |
| `TELEGRAM_INTERVAL_MIN` | Telegram | 1 | Polling interval in minutes |
| `TELEGRAM_UI_ALLOW_UNSAFE` | Telegram | false | Allow HTTP tunnels |
| `TELEGRAM_UI_TUNNEL` | Telegram | `auto` | Tunnel mode: `auto` or `disabled` |
| `VK_BASE_URL` | Infrastructure | `http://localhost:3456` | Dashboard base URL |
| `VK_PROJECT_DIR` | Project | _(cwd)_ | Absolute path to the project root |
| `VK_RECOVERY_PORT` | Infrastructure | 3456 | Dashboard HTTP port |
| `WHATSAPP_ENABLED` | Infrastructure | false | Enable WhatsApp notifications |
