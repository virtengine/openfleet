/* ─────────────────────────────────────────────────────────────
 *  Settings Schema — Shared definition of all configurable env vars
 *  Used by both the Settings UI and the server-side settings API.
 * ────────────────────────────────────────────────────────────── */

/**
 * @typedef {Object} SettingDef
 * @property {string} key          - Environment variable name
 * @property {string} label        - Human-readable label
 * @property {string} description  - Tooltip help text explaining the setting
 * @property {string} category     - Category ID for grouping
 * @property {string} type         - 'string' | 'number' | 'boolean' | 'select' | 'secret' | 'text'
 * @property {*}      [defaultVal] - Default value
 * @property {string[]} [options]  - Valid choices for 'select' type
 * @property {boolean} [sensitive] - If true, value is masked in UI and excluded from GET responses
 * @property {string}  [validate]  - Regex pattern string for validation
 * @property {number}  [min]       - Min value for 'number' type
 * @property {number}  [max]       - Max value for 'number' type
 * @property {string}  [unit]      - Display unit (e.g., 'ms', 'min', 'sec')
 * @property {boolean} [restart]   - If true, changing requires process restart
 * @property {boolean} [advanced]  - If true, hidden unless "Show advanced" is on
 */

export const CATEGORIES = [
  { id: "telegram",  label: "Telegram Bot",        icon: "📱", description: "Bot token, chat, polling, and notification settings" },
  { id: "miniapp",   label: "Mini App / UI",        icon: "🖥️", description: "Web UI server, port, auth, and tunnel settings" },
  { id: "executor",  label: "Executor / AI",        icon: "⚡", description: "Agent execution, SDK selection, parallelism, and timeouts" },
  { id: "kanban",    label: "Kanban / Tasks",        icon: "📋", description: "Task backend, sync, labels, and project mapping" },
  { id: "github",    label: "GitHub / Git",          icon: "🐙", description: "Repository, auth, PR, merge, and reconciliation settings" },
  { id: "network",   label: "Network / Tunnel",      icon: "🌐", description: "Cloudflare tunnel, presence, and multi-instance coordination" },
  { id: "security",  label: "Security / Sandbox",    icon: "🛡️", description: "Sandbox mode, container isolation, and permissions" },
  { id: "sentinel",  label: "Sentinel / Reliability", icon: "🔗", description: "Auto-restart, crash recovery, and repair agent settings" },
  { id: "hooks",     label: "Agent Hooks",           icon: "🪝", description: "Pre-push, pre-commit, and lifecycle hook configuration" },
  { id: "logging",   label: "Logging / Monitoring",  icon: "📊", description: "Work logs, error thresholds, cost tracking, and retention" },
  { id: "advanced",  label: "Advanced",              icon: "🔧", description: "Daemon, dev mode, paths, and low-level tuning" },
];

/** @type {SettingDef[]} */
export const SETTINGS_SCHEMA = [
  // ── Telegram Bot ──────────────────────────────────────────────
  { key: "TELEGRAM_BOT_TOKEN",              label: "Bot Token",                  category: "telegram", type: "secret",  sensitive: true, description: "Token from @BotFather. Required for all Telegram features.", restart: true },
  { key: "TELEGRAM_CHAT_ID",               label: "Chat ID",                    category: "telegram", type: "secret",  sensitive: true, description: "Primary chat/group ID for status messages and commands." },
  { key: "TELEGRAM_ALLOWED_CHAT_IDS",      label: "Allowed Chat IDs",           category: "telegram", type: "string",  description: "Comma-separated list of chat IDs allowed to send commands. Leave empty to allow all.", validate: "^[0-9,\\-\\s]*$" },
  { key: "TELEGRAM_INTERVAL_MIN",          label: "Status Interval",            category: "telegram", type: "number",  defaultVal: 10, min: 1, max: 1440, unit: "min", description: "Minutes between automatic status summary messages." },
  { key: "TELEGRAM_COMMAND_POLL_TIMEOUT_SEC", label: "Poll Timeout",            category: "telegram", type: "number",  defaultVal: 20, min: 5, max: 120, unit: "sec", description: "Long-polling timeout for receiving commands." },
  { key: "TELEGRAM_AGENT_TIMEOUT_MIN",     label: "Agent Timeout",              category: "telegram", type: "number",  defaultVal: 90, min: 5, max: 720, unit: "min", description: "Maximum time an SDK-triggered agent can run before timeout." },
  { key: "TELEGRAM_COMMAND_CONCURRENCY",   label: "Command Concurrency",        category: "telegram", type: "number",  defaultVal: 2, min: 1, max: 10, description: "Max concurrent command handlers." },
  { key: "TELEGRAM_VERBOSITY",             label: "Message Verbosity",          category: "telegram", type: "select",  defaultVal: "summary", options: ["minimal", "summary", "detailed"], description: "Level of detail in Telegram status messages." },
  { key: "TELEGRAM_BATCH_NOTIFICATIONS",   label: "Batch Notifications",        category: "telegram", type: "boolean", defaultVal: false, description: "Batch multiple notifications into periodic digests instead of sending individually." },
  { key: "TELEGRAM_BATCH_INTERVAL_SEC",    label: "Batch Interval",             category: "telegram", type: "number",  defaultVal: 300, min: 30, max: 3600, unit: "sec", description: "Seconds between batch flushes when batching is enabled.", advanced: true },
  { key: "TELEGRAM_BATCH_MAX_SIZE",        label: "Batch Max Size",             category: "telegram", type: "number",  defaultVal: 50, min: 5, max: 500, description: "Force flush batch when it reaches this many messages.", advanced: true },
  { key: "TELEGRAM_IMMEDIATE_PRIORITY",    label: "Immediate Priority",         category: "telegram", type: "select",  defaultVal: "1", options: ["1", "2", "3"], description: "Messages at or above this priority send immediately even when batching. 1=critical only, 2=+errors, 3=+warnings.", advanced: true },
  { key: "TELEGRAM_API_BASE_URL",          label: "API Base URL",               category: "telegram", type: "string",  defaultVal: "https://api.telegram.org", description: "Override for Telegram API proxy.", advanced: true, validate: "^https?://" },
  { key: "TELEGRAM_HTTP_TIMEOUT_MS",       label: "HTTP Timeout",               category: "telegram", type: "number",  defaultVal: 15000, min: 5000, max: 60000, unit: "ms", description: "Per-request timeout for Telegram API calls.", advanced: true },
  { key: "TELEGRAM_RETRY_ATTEMPTS",        label: "Retry Attempts",             category: "telegram", type: "number",  defaultVal: 4, min: 0, max: 10, description: "Number of retry attempts for transient Telegram API failures.", advanced: true },
  { key: "PROJECT_NAME",                   label: "Project Name",               category: "telegram", type: "string",  description: "Display name used in Telegram messages and logs. Auto-detected from package.json if not set." },

  // ── Mini App / UI Server ──────────────────────────────────────
  { key: "TELEGRAM_MINIAPP_ENABLED",       label: "Enable Mini App",            category: "miniapp", type: "boolean", defaultVal: false, description: "Enable the Telegram Mini App web UI server.", restart: true },
  { key: "TELEGRAM_UI_PORT",               label: "UI Port",                    category: "miniapp", type: "number",  min: 1024, max: 65535, description: "HTTP/HTTPS port for the Mini App server. Required when enabled.", restart: true },
  { key: "TELEGRAM_UI_HOST",               label: "Bind Host",                  category: "miniapp", type: "string",  defaultVal: "0.0.0.0", description: "Network interface to bind. Use 127.0.0.1 for local-only access.", restart: true },
  { key: "TELEGRAM_UI_PUBLIC_HOST",        label: "Public Host",                category: "miniapp", type: "string",  description: "Public hostname if behind a reverse proxy. Auto-detected if not set." },
  { key: "TELEGRAM_UI_BASE_URL",           label: "Base URL Override",          category: "miniapp", type: "string",  description: "Full public URL (e.g., https://my-domain.com). Takes precedence over auto-detection.", validate: "^https?://" },
  { key: "TELEGRAM_UI_ALLOW_UNSAFE",       label: "Allow Unsafe (No Auth)",     category: "miniapp", type: "boolean", defaultVal: false, description: "⚠️ DANGER: Disables ALL authentication. Only for local development.", restart: true },
  { key: "TELEGRAM_UI_AUTH_MAX_AGE_SEC",   label: "Auth Token Max Age",         category: "miniapp", type: "number",  defaultVal: 86400, min: 300, max: 604800, unit: "sec", description: "Maximum age for Telegram initData tokens before they expire." },
  { key: "TELEGRAM_UI_TUNNEL",             label: "Tunnel Mode",                category: "miniapp", type: "select",  defaultVal: "auto", options: ["auto", "cloudflared", "disabled"], description: "Cloudflare tunnel mode. 'auto' starts tunnel if cloudflared is available.", restart: true },

  // ── Executor / AI ──────────────────────────────────────────
  { key: "EXECUTOR_MODE",                  label: "Executor Mode",              category: "executor", type: "select", defaultVal: "vk", options: ["vk", "internal", "hybrid"], description: "Task execution mode. 'internal' uses built-in agent pool, 'vk' delegates to Vibe-Kanban, 'hybrid' uses both.", restart: true },
  { key: "INTERNAL_EXECUTOR_PARALLEL",     label: "Max Parallel Agents",        category: "executor", type: "number", defaultVal: 3, min: 1, max: 20, description: "Maximum number of concurrent agent execution slots." },
  { key: "INTERNAL_EXECUTOR_SDK",          label: "Default SDK",                category: "executor", type: "select", defaultVal: "auto", options: ["auto", "codex", "copilot", "claude"], description: "Default AI SDK for task execution. 'auto' selects based on availability and task complexity." },
  { key: "INTERNAL_EXECUTOR_TIMEOUT_MS",   label: "Task Timeout",               category: "executor", type: "number", defaultVal: 5400000, min: 60000, max: 14400000, unit: "ms", description: "Maximum time a single task execution can run (default: 90 min)." },
  { key: "INTERNAL_EXECUTOR_MAX_RETRIES",  label: "Max Retries",                category: "executor", type: "number", defaultVal: 2, min: 0, max: 10, description: "Number of automatic retries per task before marking as failed." },
  { key: "INTERNAL_EXECUTOR_POLL_MS",      label: "Poll Interval",              category: "executor", type: "number", defaultVal: 30000, min: 5000, max: 300000, unit: "ms", description: "How often the executor polls the kanban board for new tasks.", advanced: true },
  { key: "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED", label: "PR Review Agent",    category: "executor", type: "boolean", defaultVal: true, description: "Enable automatic PR review handoff after task completion." },
  { key: "INTERNAL_EXECUTOR_REPLENISH_ENABLED", label: "Auto Replenish Backlog", category: "executor", type: "boolean", defaultVal: false, description: "Automatically generate new tasks when backlog is low." },
  { key: "PRIMARY_AGENT",                  label: "Primary Agent SDK",          category: "executor", type: "select", defaultVal: "codex-sdk", options: ["codex-sdk", "copilot-sdk", "claude-sdk"], description: "Which AI SDK handles primary agent sessions and chat commands." },
  { key: "EXECUTORS",                      label: "Executor Distribution",      category: "executor", type: "string", defaultVal: "CODEX:DEFAULT:100", description: "Weighted executor configuration. Format: TYPE:VARIANT:WEIGHT,... (e.g., CODEX:DEFAULT:70,COPILOT:DEFAULT:30)", validate: "^[A-Z_]+:[A-Z_]+:\\d+" },
  { key: "EXECUTOR_DISTRIBUTION",          label: "Distribution Strategy",      category: "executor", type: "select", defaultVal: "weighted", options: ["weighted", "round-robin", "primary-only"], description: "How tasks are distributed across configured executors.", advanced: true },
  { key: "FAILOVER_STRATEGY",              label: "Failover Strategy",          category: "executor", type: "select", defaultVal: "next-in-line", options: ["next-in-line", "weighted-random", "round-robin"], description: "Strategy for selecting next executor when the primary fails.", advanced: true },
  { key: "COMPLEXITY_ROUTING_ENABLED",     label: "Complexity Routing",         category: "executor", type: "boolean", defaultVal: true, description: "Automatically route tasks to different AI models based on estimated complexity.", advanced: true },
  { key: "PROJECT_REQUIREMENTS_PROFILE",   label: "Requirements Profile",       category: "executor", type: "select", defaultVal: "feature", options: ["simple-feature", "feature", "large-feature", "system", "multi-system"], description: "Project complexity profile for task generation and planning." },

  // ── AI Provider Keys ────────────────────────────────────────
  { key: "OPENAI_API_KEY",                 label: "OpenAI API Key",             category: "executor", type: "secret", sensitive: true, description: "OpenAI API key for Codex SDK. Required if using Codex executor." },
  { key: "AZURE_OPENAI_API_KEY",           label: "Azure API Key",              category: "executor", type: "secret", sensitive: true, description: "Azure OpenAI API key (used when provider/profile is azure)." },
  { key: "CODEX_MODEL",                    label: "Codex Model",                category: "executor", type: "string", defaultVal: "gpt-4o", description: "Model for Codex SDK. E.g., gpt-4o, o3, o4-mini." },
  { key: "CODEX_MODEL_PROFILE",            label: "Active Model Profile",       category: "executor", type: "select", defaultVal: "xl", options: ["xl", "m"], description: "Select active Codex model profile for runtime sessions." },
  { key: "CODEX_MODEL_PROFILE_SUBAGENT",   label: "Subagent Profile",           category: "executor", type: "select", defaultVal: "m", options: ["xl", "m"], description: "Default profile to prefer for subagent-style delegated work." },
  { key: "CODEX_MODEL_PROFILE_XL_PROVIDER", label: "XL Provider",               category: "executor", type: "select", defaultVal: "openai", options: ["openai", "azure", "compatible"], description: "Provider for XL profile." },
  { key: "CODEX_MODEL_PROFILE_XL_MODEL",   label: "XL Model",                   category: "executor", type: "string", defaultVal: "gpt-5.3-codex", description: "Model/deployment name for XL profile." },
  { key: "CODEX_MODEL_PROFILE_XL_BASE_URL", label: "XL Base URL",               category: "executor", type: "string", description: "Optional base URL override for XL profile.", validate: "^$|^https?://" },
  { key: "CODEX_MODEL_PROFILE_XL_API_KEY", label: "XL API Key",                 category: "executor", type: "secret", sensitive: true, description: "Optional profile-scoped API key for XL profile." },
  { key: "CODEX_MODEL_PROFILE_M_PROVIDER", label: "M Provider",                 category: "executor", type: "select", defaultVal: "openai", options: ["openai", "azure", "compatible"], description: "Provider for M profile." },
  { key: "CODEX_MODEL_PROFILE_M_MODEL",    label: "M Model",                    category: "executor", type: "string", defaultVal: "gpt-5.1-codex-mini", description: "Model/deployment name for M profile." },
  { key: "CODEX_MODEL_PROFILE_M_BASE_URL", label: "M Base URL",                 category: "executor", type: "string", description: "Optional base URL override for M profile.", validate: "^$|^https?://" },
  { key: "CODEX_MODEL_PROFILE_M_API_KEY", label: "M API Key",                  category: "executor", type: "secret", sensitive: true, description: "Optional profile-scoped API key for M profile." },
  { key: "CODEX_SUBAGENT_MODEL",           label: "Subagent Model",             category: "executor", type: "string", defaultVal: "gpt-5.1-codex-mini", description: "Preferred lightweight model for delegated/subagent work." },
  { key: "ANTHROPIC_API_KEY",              label: "Anthropic API Key",          category: "executor", type: "secret", sensitive: true, description: "Anthropic API key for Claude SDK. Required if using Claude executor." },
  { key: "CLAUDE_MODEL",                   label: "Claude Model",               category: "executor", type: "string", defaultVal: "claude-opus-4-6", description: "Model for Claude SDK. E.g., claude-opus-4-6, claude-sonnet-4-5." },
  { key: "COPILOT_MODEL",                  label: "Copilot Model",              category: "executor", type: "string", defaultVal: "gpt-5", description: "Model for Copilot SDK sessions." },
  { key: "COPILOT_CLI_TOKEN",              label: "Copilot CLI Token",          category: "executor", type: "secret", sensitive: true, description: "Auth token for Copilot CLI remote mode." },

  // ── Kanban / Tasks ─────────────────────────────────────────
  { key: "KANBAN_BACKEND",                 label: "Kanban Backend",             category: "kanban", type: "select", defaultVal: "internal", options: ["internal", "vk", "github", "jira"], description: "Task management backend. 'internal' uses built-in store, 'github' syncs with GitHub Issues/Projects." },
  { key: "KANBAN_SYNC_POLICY",             label: "Sync Policy",                category: "kanban", type: "select", defaultVal: "internal-primary", options: ["internal-primary", "bidirectional"], description: "How tasks sync between internal store and external backend." },
  { key: "OPENFLEET_TASK_LABEL",       label: "Task Label",                 category: "kanban", type: "string", defaultVal: "openfleet", description: "GitHub label used to scope which issues are managed by OpenFleet." },
  { key: "OPENFLEET_ENFORCE_TASK_LABEL", label: "Enforce Task Label",       category: "kanban", type: "boolean", defaultVal: true, description: "Only pick up issues that have the task label. Prevents processing unrelated issues." },
  { key: "STALE_TASK_AGE_HOURS",           label: "Stale Task Age",             category: "kanban", type: "number", defaultVal: 3, min: 1, max: 168, unit: "hours", description: "Hours before an in-progress task with no activity is considered stale and eligible for recovery." },
  { key: "TASK_PLANNER_MODE",              label: "Task Planner Mode",          category: "kanban", type: "select", defaultVal: "kanban", options: ["kanban", "codex-sdk", "disabled"], description: "How the autonomous task planner operates. 'disabled' turns off automatic task generation." },
  { key: "TASK_PLANNER_DEDUP_HOURS",       label: "Planner Dedup Window",       category: "kanban", type: "number", defaultVal: 6, min: 1, max: 72, unit: "hours", description: "Hours to look back for duplicate task detection.", advanced: true },
  { key: "OPENFLEET_PROMPT_PLANNER",  label: "Planner Prompt Path",         category: "advanced", type: "string", description: "Override the task planner prompt file path.", advanced: true },

  // ── GitHub / Git ─────────────────────────────────────────
  { key: "GITHUB_TOKEN",                   label: "GitHub Token",               category: "github", type: "secret", sensitive: true, description: "Personal access token or fine-grained token for GitHub API. Required for GitHub kanban backend." },
  { key: "GITHUB_REPOSITORY",              label: "Repository",                 category: "github", type: "string", description: "GitHub repository in owner/repo format. Auto-detected from git remote if not set.", validate: "^[\\w.-]+/[\\w.-]+$" },
  { key: "GITHUB_PROJECT_MODE",            label: "Project Mode",               category: "github", type: "select", defaultVal: "issues", options: ["issues", "kanban"], description: "Use GitHub Issues directly, or GitHub Projects v2 kanban board." },
  { key: "GITHUB_PROJECT_NUMBER",          label: "Project Number",             category: "github", type: "number", min: 1, description: "GitHub Projects v2 number. Required when project mode is 'kanban'." },
  { key: "GITHUB_PROJECT_WEBHOOK_PATH",    label: "Project Webhook Path",       category: "github", type: "string", description: "HTTP path exposed by the UI server for GitHub webhook deliveries.", validate: "^/.*", advanced: true },
  { key: "GITHUB_PROJECT_WEBHOOK_SECRET",  label: "Project Webhook Secret",     category: "github", type: "secret", sensitive: true, description: "Shared secret to validate GitHub webhook signatures.", advanced: true },
  { key: "GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE", label: "Require Webhook Signature", category: "github", type: "boolean", defaultVal: false, description: "Reject webhook payloads unless signature validation succeeds.", advanced: true },
  { key: "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD", label: "Sync Failure Alert Threshold", category: "github", type: "number", defaultVal: 3, min: 1, max: 20, description: "Consecutive project sync failures that trigger an alert.", advanced: true },
  { key: "GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD", label: "Rate Limit Alert Threshold", category: "github", type: "number", defaultVal: 3, min: 1, max: 20, description: "Rate-limit events before triggering an alert.", advanced: true },
  { key: "GITHUB_DEFAULT_ASSIGNEE",        label: "Default Assignee",           category: "github", type: "string", description: "GitHub username to assign new issues to. Uses authenticated user if not set." },
  { key: "GITHUB_AUTO_ASSIGN_CREATOR",     label: "Auto-Assign Creator",        category: "github", type: "boolean", defaultVal: true, description: "Automatically assign the authenticated user when creating issues." },
  { key: "VK_TARGET_BRANCH",               label: "Target Branch",              category: "github", type: "string", defaultVal: "origin/main", description: "Default base branch for PR comparisons and merge targets." },
  { key: "CODEX_ANALYZE_MERGE_STRATEGY",   label: "Merge Analysis",             category: "github", type: "boolean", defaultVal: true, description: "Enable intelligent merge strategy analysis for PRs." },
  { key: "DEPENDABOT_AUTO_MERGE",          label: "Dependabot Auto-Merge",      category: "github", type: "boolean", defaultVal: true, description: "Automatically merge passing Dependabot PRs." },
  { key: "GH_RECONCILE_ENABLED",           label: "Issue Reconciler",           category: "github", type: "boolean", defaultVal: true, description: "Auto-close issues when their associated PR is merged." },

  // ── Network / Tunnel ──────────────────────────────────────
  { key: "CLOUDFLARE_TUNNEL_NAME",         label: "Tunnel Name",                category: "network", type: "string", description: "Named Cloudflare tunnel for persistent URL. Leave empty for random quick tunnel." },
  { key: "CLOUDFLARE_TUNNEL_CREDENTIALS",  label: "Tunnel Credentials",         category: "network", type: "secret", sensitive: true, description: "Path to Cloudflare tunnel credentials JSON file." },
  { key: "TELEGRAM_PRESENCE_INTERVAL_SEC", label: "Presence Interval",          category: "network", type: "number", defaultVal: 60, min: 10, max: 600, unit: "sec", description: "How often this instance announces its presence to the coordinator." },
  { key: "TELEGRAM_PRESENCE_DISABLED",     label: "Disable Presence",           category: "network", type: "boolean", defaultVal: false, description: "Disable multi-instance presence entirely." },
  { key: "VE_INSTANCE_LABEL",              label: "Instance Label",             category: "network", type: "string", description: "Human-friendly name for this instance in multi-instance setups." },
  { key: "VE_COORDINATOR_ELIGIBLE",        label: "Coordinator Eligible",       category: "network", type: "boolean", defaultVal: true, description: "Whether this instance can be elected as coordinator in multi-instance mode." },
  { key: "VE_COORDINATOR_PRIORITY",        label: "Coordinator Priority",       category: "network", type: "number", defaultVal: 10, min: 1, max: 100, description: "Lower value = higher priority in coordinator election." },
  { key: "FLEET_ENABLED",                  label: "Fleet Enabled",              category: "network", type: "boolean", defaultVal: true, description: "Enable multi-workstation fleet coordination.", advanced: true },
  { key: "FLEET_BUFFER_MULTIPLIER",        label: "Fleet Buffer Multiplier",    category: "network", type: "number", defaultVal: 3, min: 1, unit: "x", description: "Scale the planning buffer when coordinating across instances.", advanced: true },
  { key: "FLEET_SYNC_INTERVAL_MS",         label: "Fleet Sync Interval",        category: "network", type: "number", defaultVal: 120000, min: 10000, max: 3600000, unit: "ms", description: "How often fleet state is synced across instances.", advanced: true },
  { key: "FLEET_PRESENCE_TTL_MS",          label: "Fleet Presence TTL",         category: "network", type: "number", defaultVal: 300000, min: 60000, max: 3600000, unit: "ms", description: "Time before a fleet instance is considered offline.", advanced: true },
  { key: "FLEET_KNOWLEDGE_ENABLED",        label: "Fleet Knowledge Enabled",    category: "network", type: "boolean", defaultVal: true, description: "Share local knowledge files across the fleet.", advanced: true },
  { key: "FLEET_KNOWLEDGE_FILE",           label: "Fleet Knowledge File",       category: "network", type: "string", defaultVal: "AGENTS.md", description: "Knowledge file name to share across fleet members.", advanced: true },

  // ── Security / Sandbox ────────────────────────────────────
  { key: "CODEX_SANDBOX",                  label: "Sandbox Mode",               category: "security", type: "select", defaultVal: "workspace-write", options: ["workspace-write", "danger-full-access", "read-only"], description: "Agent filesystem access level. 'workspace-write' is permissive within workspace while avoiding full host access." },
  { key: "CODEX_FEATURES_BWRAP",           label: "Bubblewrap Sandbox",          category: "security", type: "boolean", defaultVal: true, description: "Enable Linux bubblewrap sandbox. Disable if user namespaces are blocked (bwrap uid map errors)." },
  { key: "CODEX_SANDBOX_PERMISSIONS",      label: "Sandbox Permissions",         category: "security", type: "string", defaultVal: "disk-full-write-access", description: "Comma-separated sandbox permission entries for Codex CLI config." },
  { key: "CODEX_SANDBOX_WRITABLE_ROOTS",   label: "Writable Roots",              category: "security", type: "string", description: "Comma-separated writable roots for workspace-write sandbox (include repo/.git as needed)." },
  { key: "CONTAINER_ENABLED",              label: "Container Isolation",        category: "security", type: "boolean", defaultVal: false, description: "Run agent tasks inside Docker/Podman containers for OS-level isolation.", restart: true },
  { key: "CONTAINER_RUNTIME",              label: "Container Runtime",          category: "security", type: "select", defaultVal: "docker", options: ["auto", "docker", "podman", "container"], description: "Container engine to use for isolated execution." },
  { key: "CONTAINER_IMAGE",                label: "Container Image",            category: "security", type: "string", defaultVal: "node:22-slim", description: "Docker image for agent execution containers." },
  { key: "CONTAINER_TIMEOUT_MS",           label: "Container Timeout",          category: "security", type: "number", defaultVal: 1800000, min: 60000, max: 7200000, unit: "ms", description: "Maximum time a container can run before being killed (default: 30 min)." },
  { key: "MAX_CONCURRENT_CONTAINERS",      label: "Max Containers",             category: "security", type: "number", defaultVal: 3, min: 1, max: 10, description: "Maximum number of concurrent agent containers." },
  { key: "CONTAINER_MEMORY_LIMIT",         label: "Memory Limit",               category: "security", type: "string", description: "Container memory limit (e.g., '4g', '2048m'). Leave empty for no limit.", validate: "^\\d+[kmg]?$" },
  { key: "CONTAINER_CPU_LIMIT",            label: "CPU Limit",                  category: "security", type: "string", description: "Container CPU limit (e.g., '2', '1.5'). Leave empty for no limit.", validate: "^\\d+\\.?\\d*$" },

  // ── Sentinel / Reliability ─────────────────────────────────
  { key: "OPENFLEET_SENTINEL_AUTO_START", label: "Auto-Start Sentinel",     category: "sentinel", type: "boolean", defaultVal: false, description: "Automatically start the sentinel watchdog on boot." },
  { key: "SENTINEL_AUTO_RESTART_MONITOR",  label: "Auto-Restart on Crash",      category: "sentinel", type: "boolean", defaultVal: true, description: "Automatically restart the monitor process if it crashes." },
  { key: "SENTINEL_CRASH_LOOP_THRESHOLD",  label: "Crash Loop Threshold",       category: "sentinel", type: "number", defaultVal: 3, min: 2, max: 20, description: "Number of crashes within the window before declaring a crash loop." },
  { key: "SENTINEL_CRASH_LOOP_WINDOW_MIN", label: "Crash Loop Window",          category: "sentinel", type: "number", defaultVal: 10, min: 2, max: 60, unit: "min", description: "Rolling time window for crash loop detection." },
  { key: "SENTINEL_REPAIR_AGENT_ENABLED",  label: "Repair Agent",               category: "sentinel", type: "boolean", defaultVal: true, description: "Enable AI-powered repair agent when a crash loop is detected." },
  { key: "SENTINEL_REPAIR_TIMEOUT_MIN",    label: "Repair Timeout",             category: "sentinel", type: "number", defaultVal: 20, min: 5, max: 120, unit: "min", description: "Maximum time the repair agent can run." },

  // ── Agent Hooks ────────────────────────────────────────────
  { key: "OPENFLEET_HOOK_PROFILE",     label: "Hook Profile",               category: "hooks", type: "select", defaultVal: "strict", options: ["strict", "balanced", "lightweight", "none"], description: "Pre-configured hook intensity. 'strict' runs all checks, 'none' disables hooks." },
  { key: "OPENFLEET_HOOK_TARGETS",     label: "Hook Targets",               category: "hooks", type: "string", defaultVal: "codex,claude,copilot", description: "Comma-separated list of agent SDKs to install hooks for.", validate: "^[a-z,]+$" },
  { key: "OPENFLEET_HOOKS_ENABLED",    label: "Enable Hooks",               category: "hooks", type: "boolean", defaultVal: true, description: "Enable agent lifecycle hook scaffolding." },
  { key: "OPENFLEET_HOOKS_OVERWRITE",  label: "Overwrite Existing",         category: "hooks", type: "boolean", defaultVal: false, description: "Overwrite existing hook files when installing. Use with caution." },
  { key: "OPENFLEET_HOOKS_BUILTINS_MODE", label: "Built-ins Mode",          category: "hooks", type: "select", defaultVal: "force", options: ["force", "auto", "off"], description: "How built-in hooks are managed. 'force' always installs, 'auto' only if missing." },

  // ── Logging / Monitoring ────────────────────────────────────
  { key: "AGENT_WORK_LOGGING_ENABLED",     label: "Work Logging",               category: "logging", type: "boolean", defaultVal: true, description: "Enable structured agent work logging with transcripts." },
  { key: "AGENT_WORK_ANALYZER_ENABLED",    label: "Live Analyzer",              category: "logging", type: "boolean", defaultVal: true, description: "Enable real-time agent output stream analysis for anomaly detection." },
  { key: "AGENT_SESSION_LOG_RETENTION",     label: "Session Retention",          category: "logging", type: "number", defaultVal: 100, min: 10, max: 10000, description: "Number of agent session transcripts to keep before rotation." },
  { key: "AGENT_ERROR_LOOP_THRESHOLD",     label: "Error Loop Threshold",       category: "logging", type: "number", defaultVal: 4, min: 2, max: 20, description: "Errors in a 10-minute window that trigger a loop alert." },
  { key: "AGENT_STUCK_THRESHOLD_MS",       label: "Stuck Detection",            category: "logging", type: "number", defaultVal: 300000, min: 60000, max: 1800000, unit: "ms", description: "Idle time before an agent is considered stuck." },
  { key: "LOG_MAX_SIZE_MB",                label: "Max Log Size",               category: "logging", type: "number", defaultVal: 500, min: 0, max: 10000, unit: "MB", description: "Maximum total log size before rotation. 0 = unlimited." },

  // ── Advanced ────────────────────────────────────────────────
  { key: "DEVMODE",                        label: "Dev Mode",                   category: "advanced", type: "boolean", defaultVal: false, description: "Enable development mode with extra logging, self-restart watcher, and debug endpoints." },
  { key: "SELF_RESTART_WATCH_ENABLED",     label: "Self-Restart Watcher",       category: "advanced", type: "boolean", description: "Auto-restart when source files change. Defaults to true in devmode." },
  { key: "MAX_PARALLEL",                   label: "Global Max Parallel",        category: "advanced", type: "number", defaultVal: 6, min: 1, max: 50, description: "Global maximum parallel task slots across all executors." },
  { key: "RESTART_DELAY_MS",               label: "Restart Delay",              category: "advanced", type: "number", defaultVal: 10000, min: 1000, max: 60000, unit: "ms", description: "Delay before restarting after a crash." },
  { key: "SHARED_STATE_ENABLED",           label: "Shared State",               category: "advanced", type: "boolean", defaultVal: true, description: "Enable distributed task coordination for multi-instance setups." },
  { key: "SHARED_STATE_STALE_THRESHOLD_MS", label: "Stale Threshold",           category: "advanced", type: "number", defaultVal: 300000, min: 60000, max: 1800000, unit: "ms", description: "Time before a heartbeat is considered stale.", advanced: true },
  { key: "VE_CI_SWEEP_EVERY",              label: "CI Sweep Interval",          category: "advanced", type: "number", defaultVal: 15, min: 1, max: 100, description: "Trigger CI sweep after every N completed tasks.", advanced: true },
];

/**
 * Get settings grouped by category.
 * @param {boolean} includeAdvanced - Include settings marked as advanced
 * @returns {Map<string, SettingDef[]>}
 */
export function getGroupedSettings(includeAdvanced = false) {
  const groups = new Map();
  for (const cat of CATEGORIES) groups.set(cat.id, []);
  for (const s of SETTINGS_SCHEMA) {
    if (!includeAdvanced && s.advanced) continue;
    const list = groups.get(s.category);
    if (list) list.push(s);
  }
  return groups;
}

/**
 * Validate a value against a setting definition.
 * @param {SettingDef} def
 * @param {string} value
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateSetting(def, value) {
  if (value === "" || value == null) return { valid: true };
  if (def.key === "OPENFLEET_HOOK_TARGETS") {
    const targets = String(value || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const allowed = new Set(["codex", "claude", "copilot", "all"]);
    const invalid = targets.filter((entry) => !allowed.has(entry));
    if (invalid.length > 0) {
      return {
        valid: false,
        error: `Invalid targets: ${invalid.join(", ")}`,
      };
    }
    return { valid: true };
  }
  switch (def.type) {
    case "number": {
      const n = Number(value);
      if (isNaN(n)) return { valid: false, error: "Must be a number" };
      if (def.min != null && n < def.min) return { valid: false, error: `Minimum: ${def.min}` };
      if (def.max != null && n > def.max) return { valid: false, error: `Maximum: ${def.max}` };
      return { valid: true };
    }
    case "boolean":
      if (!["true", "false", "1", "0", ""].includes(String(value).toLowerCase()))
        return { valid: false, error: "Must be true or false" };
      return { valid: true };
    case "select":
      if (def.options && !def.options.includes(String(value)))
        return { valid: false, error: `Must be one of: ${def.options.join(", ")}` };
      return { valid: true };
    default:
      if (def.validate) {
        try {
          if (!new RegExp(def.validate).test(value))
            return { valid: false, error: `Invalid format` };
        } catch { /* ignore bad regex */ }
      }
      return { valid: true };
  }
}

/** List of env var keys that are sensitive and should never be returned in full via API. */
export const SENSITIVE_KEYS = new Set(
  SETTINGS_SCHEMA.filter((s) => s.sensitive).map((s) => s.key),
);
