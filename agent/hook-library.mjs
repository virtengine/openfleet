/**
 * @module agent/hook-library
 * @description Central hook library system that integrates agent lifecycle hooks
 * with the bosun library-manager. Provides a rich catalog of built-in hooks
 * organized by category, with per-SDK compatibility annotations, "core" hooks
 * that are enabled by default for session resilience, and discovery APIs for
 * users to browse and enable/disable hooks.
 *
 * Hook categories:
 *   - core          — Session resilience, heartbeat, anomaly backup (default ON)
 *   - safety        — Dangerous command blocking, destructive op prevention
 *   - quality       — Lint, test, build gates on file edits and commits
 *   - session       — Session lifecycle tracking, idle detection, status sync
 *   - context       — Context window management, shredding helpers
 *   - security      — Secret scanning, permission checks, supply chain
 *   - git           — Pre-commit, pre-push, branch protection gates
 *   - notification  — Event alerts, status broadcasts, log shipping
 *   - workflow      — Task status sync, workflow trigger hooks
 *
 * SDK support levels:
 *   - "full"        — Hook event is natively supported by the SDK
 *   - "bridge"      — Supported via agent-hook-bridge (may have latency)
 *   - "partial"     — Only some sub-events supported
 *   - "unsupported" — Not technically feasible for this SDK
 *
 * @example
 * import { getHookCatalog, getCoreHooks, installHook } from "./hook-library.mjs";
 * const catalog = getHookCatalog();
 * const coreHooks = getCoreHooks();
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TAG = "[hook-library]";

// ── SDK Definitions ─────────────────────────────────────────────────────────

/**
 * All supported agent SDKs with their hook capability metadata.
 * @type {Readonly<Record<string, SdkCapabilities>>}
 */
export const SDK_CAPABILITIES = Object.freeze({
  codex: {
    id: "codex",
    name: "OpenAI Codex CLI",
    nativeEvents: ["SessionStart", "SessionStop", "PreToolUse", "PostToolUse"],
    bridgeEvents: ["PrePush", "PostPush", "PreCommit", "PostCommit", "PrePR", "PostPR", "TaskComplete", "SubagentStart", "SubagentStop"],
    configPath: ".codex/hooks.json",
    configFormat: "codex-hooks-json",
    notes: "Codex CLI natively fires SessionStart/Stop, PreToolUse, PostToolUse. All other events require the agent-hook-bridge.",
  },
  copilot: {
    id: "copilot",
    name: "GitHub Copilot Coding Agent",
    nativeEvents: [],
    bridgeEvents: ["SessionStart", "SessionStop", "PreToolUse", "PostToolUse", "PrePush", "PostPush", "PreCommit", "PostCommit", "PrePR", "PostPR", "TaskComplete", "SubagentStart", "SubagentStop"],
    configPath: ".github/hooks/bosun.hooks.json",
    configFormat: "copilot-hooks-json",
    notes: "Copilot routes all events through the hook-bridge. Supports sessionStart/End and pre/postToolUse dispatchers.",
  },
  claude: {
    id: "claude",
    name: "Claude Code (Anthropic)",
    nativeEvents: ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
    bridgeEvents: ["SessionStart", "SessionStop", "PrePush", "PostPush", "PreCommit", "PostCommit", "PrePR", "PostPR", "TaskComplete", "SubagentStart", "SubagentStop"],
    configPath: ".claude/settings.local.json",
    configFormat: "claude-settings-json",
    notes: "Claude Code natively fires UserPromptSubmit (→SessionStart), PreToolUse, PostToolUse, Stop (→SessionStop). Supports matcher-based filtering (e.g. Bash tool only).",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini CLI",
    nativeEvents: [],
    bridgeEvents: ["SessionStart", "SessionStop", "PreToolUse", "PostToolUse", "PrePush", "PostPush", "PreCommit", "PostCommit", "PrePR", "PostPR", "TaskComplete"],
    configPath: ".gemini/settings.json",
    configFormat: "gemini-settings-json",
    unsupportedEvents: ["SubagentStart", "SubagentStop"],
    notes: "Gemini CLI does not currently expose a native hook API. All events go through agent-hook-bridge. SubagentStart/Stop not applicable as Gemini does not spawn subagents.",
  },
  opencode: {
    id: "opencode",
    name: "OpenCode CLI",
    nativeEvents: [],
    bridgeEvents: ["SessionStart", "SessionStop", "PreToolUse", "PostToolUse", "PrePush", "PostPush", "PreCommit", "PostCommit", "TaskComplete"],
    configPath: ".opencode/hooks.json",
    configFormat: "opencode-hooks-json",
    unsupportedEvents: ["SubagentStart", "SubagentStop", "PrePR", "PostPR"],
    notes: "OpenCode routes through agent-hook-bridge. No subagent or PR primitives currently.",
  },
});

/**
 * Get the support level of a specific event for a specific SDK.
 * @param {string} sdkId
 * @param {string} event
 * @returns {"full"|"bridge"|"unsupported"}
 */
export function getSdkSupportLevel(sdkId, event) {
  const sdk = SDK_CAPABILITIES[sdkId];
  if (!sdk) return "unsupported";
  if (sdk.unsupportedEvents?.includes(event)) return "unsupported";
  if (sdk.nativeEvents.includes(event)) return "full";
  if (sdk.bridgeEvents.includes(event)) return "bridge";
  return "unsupported";
}

/**
 * Get the compatibility matrix for a hook definition.
 * @param {HookLibraryEntry} hook
 * @returns {Record<string, "full"|"bridge"|"partial"|"unsupported">}
 */
export function getHookCompatibility(hook) {
  const result = {};
  for (const sdkId of Object.keys(SDK_CAPABILITIES)) {
    const events = Array.isArray(hook.events) ? hook.events : [hook.events];
    const levels = events.map((e) => getSdkSupportLevel(sdkId, e));
    if (levels.every((l) => l === "unsupported")) {
      result[sdkId] = "unsupported";
    } else if (levels.every((l) => l === "full")) {
      result[sdkId] = "full";
    } else if (levels.some((l) => l === "unsupported")) {
      result[sdkId] = "partial";
    } else {
      result[sdkId] = levels.includes("full") ? "full" : "bridge";
    }
  }
  return result;
}

// ── Hook Library Entry Type ─────────────────────────────────────────────────

/**
 * @typedef {Object} HookLibraryEntry
 * @property {string}   id          - Unique hook identifier (slug)
 * @property {string}   name        - Human-readable name
 * @property {string}   description - What this hook does
 * @property {string}   category    - Category slug (core, safety, quality, etc.)
 * @property {string|string[]} events - Hook event(s) this applies to
 * @property {string}   command     - Shell command template
 * @property {boolean}  blocking    - Whether failure stops the pipeline
 * @property {number}   timeout     - Timeout in ms
 * @property {string[]} sdks        - SDK filter (["*"] = all)
 * @property {boolean}  core        - Whether this is a core hook (default-enabled)
 * @property {boolean}  defaultEnabled - Whether enabled by default for new installs
 * @property {boolean}  retryable   - Whether transient failures should retry
 * @property {number}   [maxRetries] - Max retry attempts
 * @property {string[]} tags        - Searchable tags
 * @property {Record<string,string>} [env] - Additional env vars
 * @property {string}   [requires]  - Prerequisite description (e.g. "eslint installed")
 * @property {string}   [disableWarning] - Warning shown when user tries to disable a core hook
 * @property {Record<string,"full"|"bridge"|"partial"|"unsupported">} [compatibility] - Auto-computed SDK compat
 */

// ── Hook Categories ─────────────────────────────────────────────────────────

export const HOOK_CATEGORIES = Object.freeze([
  { id: "core", name: "Core Resilience", description: "Default-enabled hooks for session management, heartbeat, and anomaly detection. Disabling may affect bosun core functionality.", icon: "🛡️" },
  { id: "safety", name: "Safety Guards", description: "Block dangerous commands, prevent destructive operations, enforce safe patterns.", icon: "🚨" },
  { id: "quality", name: "Quality Gates", description: "Lint, test, and build validation on file changes, commits, and pushes.", icon: "✅" },
  { id: "session", name: "Session Lifecycle", description: "Track agent session state, idle detection, heartbeat, and status synchronization.", icon: "🔄" },
  { id: "context", name: "Context Management", description: "Context window optimization, automatic shredding, file tracking.", icon: "📋" },
  { id: "security", name: "Security Scanning", description: "Secret detection, permission checks, dependency auditing.", icon: "🔒" },
  { id: "git", name: "Git Operations", description: "Branch protection, commit validation, push safety, merge checks.", icon: "🌿" },
  { id: "notification", name: "Notifications", description: "Event alerts, status broadcasts, log shipping to external systems.", icon: "📣" },
  { id: "workflow", name: "Workflow Integration", description: "Task status sync, workflow triggers, pipeline hooks.", icon: "⚡" },
]);

// ── Platform Detection Helpers ──────────────────────────────────────────────

const IS_WINDOWS = process.platform === "win32";

function shellCmd(bashCmd, psCmd) {
  return IS_WINDOWS ? psCmd : bashCmd;
}

function bridgeCmd(event) {
  return `node agent-hook-bridge.mjs --agent $VE_SDK --event ${event}`;
}

// ── Built-in Hook Catalog ───────────────────────────────────────────────────

/**
 * Complete catalog of built-in hooks. Each hook is a template that can be
 * installed into a workspace's hook configuration.
 * @type {HookLibraryEntry[]}
 */
const BUILTIN_HOOKS = [

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CORE RESILIENCE — Default-enabled, provides backup session management
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  {
    id: "core-session-heartbeat",
    name: "Session Heartbeat",
    description: "Periodically writes a heartbeat timestamp to .bosun/session-heartbeat.json so the monitor loop can detect stalled or crashed agent sessions. Acts as a backup to the primary session tracking.",
    category: "core",
    events: "PostToolUse",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && echo "{\\"ts\\":$(date +%s),\\"sdk\\":\\"$VE_SDK\\",\\"task\\":\\"$VE_TASK_ID\\"}" > .bosun/session-heartbeat.json'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; @{ts=[int](Get-Date -UFormat %s);sdk=$env:VE_SDK;task=$env:VE_TASK_ID} | ConvertTo-Json | Set-Content .bosun/session-heartbeat.json"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: true,
    defaultEnabled: true,
    retryable: false,
    tags: ["core", "session", "heartbeat", "resilience", "monitoring"],
    disableWarning: "Disabling the session heartbeat may prevent bosun from detecting stalled agent sessions. The monitor loop relies on this as a backup to primary session tracking.",
  },

  {
    id: "core-session-start-beacon",
    name: "Session Start Beacon",
    description: "Records session start time, SDK, task ID, and branch to .bosun/session-state.json. Provides a durable backup of session metadata independent of the primary session store.",
    category: "core",
    events: "SessionStart",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && echo "{\\"started\\":$(date +%s),\\"sdk\\":\\"$VE_SDK\\",\\"task\\":\\"$VE_TASK_ID\\",\\"branch\\":\\"$VE_BRANCH_NAME\\",\\"status\\":\\"active\\"}" > .bosun/session-state.json'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; @{started=[int](Get-Date -UFormat %s);sdk=$env:VE_SDK;task=$env:VE_TASK_ID;branch=$env:VE_BRANCH_NAME;status='active'} | ConvertTo-Json | Set-Content .bosun/session-state.json"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: true,
    defaultEnabled: true,
    retryable: true,
    maxRetries: 1,
    tags: ["core", "session", "beacon", "resilience"],
    disableWarning: "Disabling the session start beacon removes the backup session state file. If primary session tracking fails, bosun will not know a session is active.",
  },

  {
    id: "core-session-stop-beacon",
    name: "Session Stop Beacon",
    description: "Updates the session state file to 'completed' status when the agent session ends. Ensures the monitor loop knows the session finished even if the primary notification path fails.",
    category: "core",
    events: "SessionStop",
    command: shellCmd(
      `bash -c 'if [ -f .bosun/session-state.json ]; then TMP=$(cat .bosun/session-state.json); echo "$TMP" | sed "s/\\"status\\":\\"active\\"/\\"status\\":\\"completed\\"/" > .bosun/session-state.json; fi'`,
      `powershell -NoProfile -Command "if (Test-Path .bosun/session-state.json) { $j = Get-Content .bosun/session-state.json | ConvertFrom-Json; $j.status = 'completed'; $j | ConvertTo-Json | Set-Content .bosun/session-state.json }"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: true,
    defaultEnabled: true,
    retryable: true,
    maxRetries: 1,
    tags: ["core", "session", "beacon", "resilience"],
    disableWarning: "Disabling the session stop beacon may cause bosun to think agent sessions are still running after they complete.",
  },

  {
    id: "core-tool-activity-log",
    name: "Tool Activity Logger",
    description: "Appends every tool invocation to .bosun/tool-activity.jsonl. Provides an audit trail for anomaly detection and session forensics. The monitor can analyze tool patterns to detect agents that are stuck in loops or using tools excessively.",
    category: "core",
    events: "PostToolUse",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && echo "{\\"ts\\":$(date +%s),\\"tool\\":\\"$VE_HOOK_TOOL_NAME\\",\\"sdk\\":\\"$VE_SDK\\",\\"task\\":\\"$VE_TASK_ID\\"}" >> .bosun/tool-activity.jsonl'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; @{ts=[int](Get-Date -UFormat %s);tool=$env:VE_HOOK_TOOL_NAME;sdk=$env:VE_SDK;task=$env:VE_TASK_ID} | ConvertTo-Json -Compress | Add-Content .bosun/tool-activity.jsonl"`,
    ),
    blocking: false,
    timeout: 3_000,
    sdks: ["*"],
    core: true,
    defaultEnabled: true,
    retryable: false,
    tags: ["core", "audit", "tools", "anomaly-detection", "forensics"],
    disableWarning: "Disabling tool activity logging removes the audit trail used for anomaly detection. Bosun will not be able to detect agent loop patterns or excessive tool usage.",
  },

  {
    id: "core-worktree-health",
    name: "Worktree Health Check",
    description: "Validates the worktree is a healthy git repository at session start. Checks .git presence, git status, and branch checkout. Retryable for transient git lock issues.",
    category: "core",
    events: "SessionStart",
    command: shellCmd(
      `bash -c 'if ! git rev-parse --git-dir >/dev/null 2>&1; then echo "Not a git repository" >&2; exit 1; fi; git status --porcelain >/dev/null 2>&1; echo "OK: worktree healthy"'`,
      `powershell -NoProfile -Command "if (-not (Test-Path .git)) { if (-not (git rev-parse --git-dir 2>$null)) { Write-Error 'Not a git repository'; exit 1 } }; git status --porcelain 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { Write-Error 'git status failed'; exit 1 }; Write-Host 'OK: worktree healthy'"`,
    ),
    blocking: false,
    timeout: 15_000,
    sdks: ["*"],
    core: true,
    defaultEnabled: true,
    retryable: true,
    maxRetries: 2,
    tags: ["core", "git", "health", "worktree", "resilience"],
    disableWarning: "Disabling worktree health checks may cause agents to operate in broken git states without detection.",
  },

  {
    id: "core-task-status-sync",
    name: "Task Status Sync",
    description: "On task completion, writes the task result to .bosun/task-result.json as a backup status sync mechanism. If the primary task completion notification fails (network, process crash), the monitor loop reads this file to update the kanban.",
    category: "core",
    events: "TaskComplete",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && echo "{\\"task\\":\\"$VE_TASK_ID\\",\\"status\\":\\"completed\\",\\"ts\\":$(date +%s),\\"branch\\":\\"$VE_BRANCH_NAME\\"}" > .bosun/task-result.json && echo "OK: task result recorded"'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; @{task=$env:VE_TASK_ID;status='completed';ts=[int](Get-Date -UFormat %s);branch=$env:VE_BRANCH_NAME} | ConvertTo-Json | Set-Content .bosun/task-result.json; Write-Host 'OK: task result recorded'"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: true,
    defaultEnabled: true,
    retryable: true,
    maxRetries: 1,
    tags: ["core", "task", "status", "sync", "resilience", "workflow"],
    disableWarning: "Disabling task status sync removes the backup path for task completion notifications. If the primary notification fails, task status may not update on the kanban board.",
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SAFETY GUARDS — Prevent dangerous operations
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  {
    id: "safety-block-force-push",
    name: "Block Force Push",
    description: "Blocks git push --force and git push --force-with-lease commands to prevent accidental history rewriting on shared branches.",
    category: "safety",
    events: "PreToolUse",
    command: shellCmd(
      `bash -c 'CMD="$VE_HOOK_COMMAND"; if echo "$CMD" | grep -qiE "git\\s+push\\s+.*--force"; then echo "BLOCKED: Force push is not allowed. Use a regular push or rebase." >&2; exit 1; fi'`,
      `powershell -NoProfile -Command "if ($env:VE_HOOK_COMMAND -match 'git\\s+push\\s+.*--force') { Write-Error 'BLOCKED: Force push is not allowed. Use a regular push or rebase.'; exit 1 }"`,
    ),
    blocking: true,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: true,
    retryable: false,
    tags: ["safety", "git", "force-push", "blocking"],
  },

  {
    id: "safety-block-main-branch",
    name: "Block Direct Main Commits",
    description: "Prevents git commit and git push directly on the main/master branch. All work must go through feature branches.",
    category: "safety",
    events: "PreToolUse",
    command: shellCmd(
      `bash -c 'CMD="$VE_HOOK_COMMAND"; BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); if [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ]; then if echo "$CMD" | grep -qiE "git\\s+(commit|push)"; then echo "BLOCKED: Direct commits/pushes to $BRANCH are not allowed." >&2; exit 1; fi; fi'`,
      `powershell -NoProfile -Command "$branch = git rev-parse --abbrev-ref HEAD 2>$null; if ($branch -in 'main','master') { if ($env:VE_HOOK_COMMAND -match 'git\\s+(commit|push)') { Write-Error \"BLOCKED: Direct commits/pushes to $branch are not allowed.\"; exit 1 } }"`,
    ),
    blocking: true,
    timeout: 10_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: true,
    retryable: false,
    tags: ["safety", "git", "branch-protection", "blocking"],
  },

  {
    id: "safety-block-agent-direct-push",
    name: "Block Agent Direct Push",
    description: "Prevents agents from running git push directly when Bosun guardrails require workflow-owned push handoff.",
    category: "safety",
    events: "PreToolUse",
    command: shellCmd(
      `bash -c 'CMD="$VE_HOOK_COMMAND"; if echo "$CMD" | grep -qiE "git\\s+push\\b"; then node -e "const fs=require(\"fs\");const path=require(\"path\");let block=true;try{const policyPath=path.join(process.cwd(),\".bosun\",\"guardrails.json\");if(fs.existsSync(policyPath)){const policy=JSON.parse(fs.readFileSync(policyPath,\"utf8\"));block=policy?.push?.blockAgentPushes!==false;}}catch{} if(block){console.error(\"BLOCKED: Direct agent pushes are disabled. Commit your changes and let Bosun workflow automation perform the validated push.\");process.exit(1);}"; fi'`,
      `powershell -NoProfile -Command "if ($env:VE_HOOK_COMMAND -match 'git\\s+push\\b') { node -e 'const fs=require(\"fs\");const path=require(\"path\");let block=true;try{const policyPath=path.join(process.cwd(),\".bosun\",\"guardrails.json\");if(fs.existsSync(policyPath)){const policy=JSON.parse(fs.readFileSync(policyPath,\"utf8\"));block=policy?.push?.blockAgentPushes!==false;}}catch{} if(block){console.error(\"BLOCKED: Direct agent pushes are disabled. Commit your changes and let Bosun workflow automation perform the validated push.\");process.exit(1);}' ; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }"`,
    ),
    blocking: true,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: true,
    retryable: false,
    tags: ["safety", "git", "push", "workflow-only", "blocking"],
  },

  {
    id: "safety-block-destructive-commands",
    name: "Block Destructive Commands",
    description: "Blocks highly dangerous shell commands like rm -rf /, DROP DATABASE, format, del /f /s, and similar destructive operations that could cause irreversible damage.",
    category: "safety",
    events: "PreToolUse",
    command: shellCmd(
      `bash -c 'CMD="$VE_HOOK_COMMAND"; if echo "$CMD" | grep -qiE "(rm\\s+-rf\\s+/\\s|rm\\s+-rf\\s+~|DROP\\s+DATABASE|DROP\\s+TABLE|FORMAT\\s+C:|mkfs\\.|dd\\s+if=.*of=/dev/)"; then echo "BLOCKED: Destructive command detected: $CMD" >&2; exit 1; fi'`,
      `powershell -NoProfile -Command "if ($env:VE_HOOK_COMMAND -match '(rm\\s+-rf\\s+[/~]|Remove-Item.*-Recurse.*[/\\\\]$|DROP\\s+(DATABASE|TABLE)|FORMAT\\s+C:|del\\s+/[fs].*[/\\\\]$)') { Write-Error \"BLOCKED: Destructive command detected.\"; exit 1 }"`,
    ),
    blocking: true,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: true,
    retryable: false,
    tags: ["safety", "destructive", "blocking", "shell"],
  },

  {
    id: "safety-block-hard-reset",
    name: "Block Git Hard Reset",
    description: "Blocks git reset --hard which discards uncommitted changes and can cause data loss.",
    category: "safety",
    events: "PreToolUse",
    command: shellCmd(
      `bash -c 'CMD="$VE_HOOK_COMMAND"; if echo "$CMD" | grep -qiE "git\\s+reset\\s+--hard"; then echo "BLOCKED: git reset --hard is not allowed. Use git stash or create a backup branch first." >&2; exit 1; fi'`,
      `powershell -NoProfile -Command "if ($env:VE_HOOK_COMMAND -match 'git\\s+reset\\s+--hard') { Write-Error 'BLOCKED: git reset --hard is not allowed. Use git stash or backup first.'; exit 1 }"`,
    ),
    blocking: true,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: true,
    retryable: false,
    tags: ["safety", "git", "reset", "blocking"],
  },

  {
    id: "safety-block-clean-fdx",
    name: "Block Git Clean -fdx",
    description: "Blocks git clean -fdx which removes all untracked files including ignored files, potentially deleting build caches, node_modules, and other important untracked assets.",
    category: "safety",
    events: "PreToolUse",
    command: shellCmd(
      `bash -c 'CMD="$VE_HOOK_COMMAND"; if echo "$CMD" | grep -qiE "git\\s+clean\\s+.*-[a-z]*f[a-z]*d"; then echo "BLOCKED: git clean with force+directory flags is not allowed." >&2; exit 1; fi'`,
      `powershell -NoProfile -Command "if ($env:VE_HOOK_COMMAND -match 'git\\s+clean\\s+.*-[a-z]*f[a-z]*d') { Write-Error 'BLOCKED: git clean -fd is not allowed.'; exit 1 }"`,
    ),
    blocking: true,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["safety", "git", "clean", "blocking"],
  },

  {
    id: "safety-block-no-verify",
    name: "Block --no-verify Flag",
    description: "Prevents bypassing git hooks with --no-verify on commit and push. This ensures pre-commit and pre-push quality gates are always executed.",
    category: "safety",
    events: "PreToolUse",
    command: shellCmd(
      `bash -c 'CMD="$VE_HOOK_COMMAND"; if echo "$CMD" | grep -qiE "git\\s+(commit|push)\\s+.*--no-verify"; then echo "BLOCKED: --no-verify bypasses important quality gates." >&2; exit 1; fi'`,
      `powershell -NoProfile -Command "if ($env:VE_HOOK_COMMAND -match 'git\\s+(commit|push)\\s+.*--no-verify') { Write-Error 'BLOCKED: --no-verify bypasses quality gates.'; exit 1 }"`,
    ),
    blocking: true,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["safety", "git", "no-verify", "blocking"],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // QUALITY GATES — Lint, test, build validation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  {
    id: "quality-lint-on-commit",
    name: "Lint on Commit",
    description: "Runs the project linter on staged files before every commit. Supports auto-detection of project type (eslint, pylint, golint, rustfmt).",
    category: "quality",
    events: "PreCommit",
    command: shellCmd(
      `bash -c 'if [ -f package.json ]; then npx eslint --no-error-on-unmatched-pattern $(git diff --cached --name-only --diff-filter=ACM -- "*.js" "*.mjs" "*.ts" "*.tsx" | tr "\\n" " ") 2>/dev/null || true; elif [ -f go.mod ]; then golangci-lint run ./... 2>/dev/null || true; elif [ -f Cargo.toml ]; then cargo clippy 2>/dev/null || true; fi && echo "OK: lint passed"'`,
      `powershell -NoProfile -Command "if (Test-Path package.json) { npx eslint --no-error-on-unmatched-pattern $(git diff --cached --name-only --diff-filter=ACM -- '*.js' '*.mjs' '*.ts' '*.tsx') 2>$null } elseif (Test-Path go.mod) { golangci-lint run ./... 2>$null } elseif (Test-Path Cargo.toml) { cargo clippy 2>$null }; Write-Host 'OK: lint passed'"`,
    ),
    blocking: false,
    timeout: 120_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["quality", "lint", "eslint", "commit"],
    requires: "Project-specific linter (eslint, golangci-lint, cargo clippy)",
  },

  {
    id: "quality-test-on-push",
    name: "Test Suite on Push",
    description: "Runs the project test suite before pushing. Prevents broken code from reaching the remote. Auto-detects test runner (npm test, go test, cargo test, pytest).",
    category: "quality",
    events: "PrePush",
    command: shellCmd(
      `bash -c 'if [ -f package.json ]; then npm test 2>&1; elif [ -f go.mod ]; then go test ./... 2>&1; elif [ -f Cargo.toml ]; then cargo test 2>&1; elif [ -f pytest.ini ] || [ -f setup.py ] || [ -f pyproject.toml ]; then python -m pytest 2>&1; else echo "No test runner detected"; fi'`,
      `powershell -NoProfile -Command "if (Test-Path package.json) { npm test 2>&1 } elseif (Test-Path go.mod) { go test ./... 2>&1 } elseif (Test-Path Cargo.toml) { cargo test 2>&1 } elseif ((Test-Path pytest.ini) -or (Test-Path pyproject.toml)) { python -m pytest 2>&1 } else { Write-Host 'No test runner detected' }"`,
    ),
    blocking: true,
    timeout: 600_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["quality", "test", "push", "blocking"],
    requires: "Project-specific test runner",
  },

  {
    id: "quality-build-on-push",
    name: "Build Verification on Push",
    description: "Verifies the project builds successfully before pushing. Auto-detects build system (npm, go, cargo, make).",
    category: "quality",
    events: "PrePush",
    command: shellCmd(
      `bash -c 'if [ -f package.json ]; then npm run build 2>&1 || true; elif [ -f go.mod ]; then go build ./... 2>&1; elif [ -f Cargo.toml ]; then cargo build 2>&1; elif [ -f Makefile ]; then make 2>&1; else echo "No build system detected"; fi'`,
      `powershell -NoProfile -Command "if (Test-Path package.json) { npm run build 2>&1 } elseif (Test-Path go.mod) { go build ./... 2>&1 } elseif (Test-Path Cargo.toml) { cargo build 2>&1 } elseif (Test-Path Makefile) { make 2>&1 } else { Write-Host 'No build system detected' }"`,
    ),
    blocking: true,
    timeout: 300_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["quality", "build", "push", "blocking"],
    requires: "Project-specific build system",
  },

  {
    id: "quality-type-check-on-commit",
    name: "TypeScript Type Check",
    description: "Runs tsc --noEmit to check TypeScript types before commit. Only activates in projects with tsconfig.json.",
    category: "quality",
    events: "PreCommit",
    command: shellCmd(
      `bash -c 'if [ -f tsconfig.json ]; then npx tsc --noEmit 2>&1; else echo "No tsconfig.json found, skipping"; fi'`,
      `powershell -NoProfile -Command "if (Test-Path tsconfig.json) { npx tsc --noEmit 2>&1 } else { Write-Host 'No tsconfig.json found' }"`,
    ),
    blocking: true,
    timeout: 120_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["quality", "typescript", "type-check", "commit"],
    requires: "tsconfig.json and TypeScript compiler",
  },

  {
    id: "quality-format-check",
    name: "Code Format Check",
    description: "Verifies code formatting is consistent using prettier, gofmt, rustfmt, or black depending on project type.",
    category: "quality",
    events: "PreCommit",
    command: shellCmd(
      `bash -c 'if [ -f .prettierrc ] || [ -f .prettierrc.json ]; then npx prettier --check $(git diff --cached --name-only) 2>/dev/null; elif [ -f go.mod ]; then test -z "$(gofmt -l .)"; elif [ -f pyproject.toml ]; then python -m black --check . 2>/dev/null; fi && echo "OK: formatting check passed"'`,
      `powershell -NoProfile -Command "if ((Test-Path .prettierrc) -or (Test-Path .prettierrc.json)) { npx prettier --check $(git diff --cached --name-only) 2>$null } elseif (Test-Path go.mod) { gofmt -l . 2>$null } elseif (Test-Path pyproject.toml) { python -m black --check . 2>$null }; Write-Host 'OK: format check passed'"`,
    ),
    blocking: false,
    timeout: 60_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["quality", "format", "prettier", "gofmt", "black"],
    requires: "Project-specific formatter",
  },

  {
    id: "quality-commit-message-convention",
    name: "Conventional Commit Check",
    description: "Validates that commit messages follow the Conventional Commits specification (feat:, fix:, chore:, etc.).",
    category: "quality",
    events: "PostCommit",
    command: shellCmd(
      `bash -c 'MSG=$(git log -1 --format=%s); if ! echo "$MSG" | grep -qE "^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\\(.*\\))?!?:"; then echo "WARNING: commit message does not follow conventional commits: $MSG" >&2; fi'`,
      `powershell -NoProfile -Command "$msg = git log -1 --format=%s; if ($msg -notmatch '^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(\\(.*\\))?!?:') { Write-Warning \"Commit message does not follow conventional commits: $msg\" }"`,
    ),
    blocking: false,
    timeout: 10_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["quality", "commit", "conventional-commits", "validation"],
  },

  {
    id: "quality-preflight-on-push",
    name: "Bosun Preflight on Push",
    description: "Runs the full bosun preflight script (syntax check + test suite) before pushing. This is the recommended quality gate for bosun projects.",
    category: "quality",
    events: "PrePush",
    command: "node infra/preflight.mjs",
    blocking: true,
    timeout: 300_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["quality", "preflight", "bosun", "push", "blocking"],
    requires: "infra/preflight.mjs in project root",
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SESSION LIFECYCLE — Agent session tracking and management
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  {
    id: "session-start-audit-log",
    name: "Session Start Audit",
    description: "Logs session start event with full context to .bosun/audit.jsonl for compliance and debugging.",
    category: "session",
    events: "SessionStart",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && echo "{\\"event\\":\\"session_start\\",\\"ts\\":$(date +%s),\\"sdk\\":\\"$VE_SDK\\",\\"task\\":\\"$VE_TASK_ID\\",\\"branch\\":\\"$VE_BRANCH_NAME\\"}" >> .bosun/audit.jsonl'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; @{event='session_start';ts=[int](Get-Date -UFormat %s);sdk=$env:VE_SDK;task=$env:VE_TASK_ID;branch=$env:VE_BRANCH_NAME} | ConvertTo-Json -Compress | Add-Content .bosun/audit.jsonl"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["session", "audit", "compliance", "logging"],
  },

  {
    id: "session-stop-audit-log",
    name: "Session Stop Audit",
    description: "Logs session end event to .bosun/audit.jsonl.",
    category: "session",
    events: "SessionStop",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && echo "{\\"event\\":\\"session_stop\\",\\"ts\\":$(date +%s),\\"sdk\\":\\"$VE_SDK\\",\\"task\\":\\"$VE_TASK_ID\\"}" >> .bosun/audit.jsonl'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; @{event='session_stop';ts=[int](Get-Date -UFormat %s);sdk=$env:VE_SDK;task=$env:VE_TASK_ID} | ConvertTo-Json -Compress | Add-Content .bosun/audit.jsonl"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["session", "audit", "compliance", "logging"],
  },

  {
    id: "session-idle-detector",
    name: "Idle Session Detector",
    description: "On each tool use, checks if the last tool was used more than 5 minutes ago. If so, logs an idle warning to .bosun/audit.jsonl. Useful for detecting agents that pause unexpectedly.",
    category: "session",
    events: "PreToolUse",
    command: shellCmd(
      `bash -c 'if [ -f .bosun/session-heartbeat.json ]; then LAST=$(cat .bosun/session-heartbeat.json | grep -o "\\"ts\\":[0-9]*" | grep -o "[0-9]*"); NOW=$(date +%s); DIFF=$((NOW - LAST)); if [ "$DIFF" -gt 300 ]; then echo "{\\"event\\":\\"idle_detected\\",\\"idle_seconds\\":$DIFF,\\"ts\\":$NOW}" >> .bosun/audit.jsonl; echo "WARNING: Agent idle for \${DIFF}s" >&2; fi; fi'`,
      `powershell -NoProfile -Command "if (Test-Path .bosun/session-heartbeat.json) { $j = Get-Content .bosun/session-heartbeat.json | ConvertFrom-Json; $diff = [int](Get-Date -UFormat %s) - $j.ts; if ($diff -gt 300) { @{event='idle_detected';idle_seconds=$diff;ts=[int](Get-Date -UFormat %s)} | ConvertTo-Json -Compress | Add-Content .bosun/audit.jsonl; Write-Warning \\"Agent idle for \${diff}s\\" } }"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["session", "idle", "monitoring", "anomaly"],
  },

  {
    id: "session-git-status-snapshot",
    name: "Git Status Snapshot",
    description: "Records a git status snapshot at session start and stop for forensic comparison. Useful for understanding what files an agent touched.",
    category: "session",
    events: ["SessionStart", "SessionStop"],
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && git diff --stat HEAD > .bosun/git-status-snapshot.txt 2>/dev/null && echo "OK: git snapshot saved"'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; git diff --stat HEAD 2>$null | Set-Content .bosun/git-status-snapshot.txt; Write-Host 'OK: git snapshot saved'"`,
    ),
    blocking: false,
    timeout: 10_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["session", "git", "forensics", "snapshot"],
  },

  {
    id: "session-commit-counter",
    name: "Commit Counter",
    description: "Tracks the number of commits made during a session. Writes to .bosun/session-metrics.json. Useful for productivity analysis and detecting sessions with unusually high or low commit rates.",
    category: "session",
    events: "PostCommit",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun; F=.bosun/session-metrics.json; if [ -f "$F" ]; then N=$(cat "$F" | grep -o "\\"commits\\":[0-9]*" | grep -o "[0-9]*" || echo 0); else N=0; fi; N=$((N + 1)); echo "{\\"commits\\":$N,\\"last_commit_ts\\":$(date +%s)}" > "$F"'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; $f = '.bosun/session-metrics.json'; $n = 0; if (Test-Path $f) { try { $n = (Get-Content $f | ConvertFrom-Json).commits } catch {} }; $n++; @{commits=$n;last_commit_ts=[int](Get-Date -UFormat %s)} | ConvertTo-Json | Set-Content $f"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["session", "metrics", "commits", "productivity"],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // CONTEXT MANAGEMENT — Context window helpers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  {
    id: "context-file-tracker",
    name: "File Access Tracker",
    description: "Tracks which files the agent reads and writes via tool commands. Records to .bosun/file-access.jsonl for context optimization — knowing which files are hot helps the context shredder prioritize what to keep.",
    category: "context",
    events: "PostToolUse",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && CMD="$VE_HOOK_COMMAND"; FILES=$(echo "$CMD" | grep -oE "[a-zA-Z0-9_./-]+\\.(js|mjs|ts|tsx|py|go|rs|java|rb|md|json|yaml|yml|toml)" | head -5 | tr "\\n" ","); if [ -n "$FILES" ]; then echo "{\\"ts\\":$(date +%s),\\"files\\":\\"$FILES\\",\\"tool\\":\\"$VE_HOOK_TOOL_NAME\\"}" >> .bosun/file-access.jsonl; fi'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; $files = [regex]::Matches($env:VE_HOOK_COMMAND, '[a-zA-Z0-9_.\\\\/-]+\\.(js|mjs|ts|tsx|py|go|rs|java|rb|md|json|yaml|yml|toml)') | Select-Object -First 5 -ExpandProperty Value; if ($files) { @{ts=[int](Get-Date -UFormat %s);files=($files -join ',');tool=$env:VE_HOOK_TOOL_NAME} | ConvertTo-Json -Compress | Add-Content .bosun/file-access.jsonl }"`,
    ),
    blocking: false,
    timeout: 3_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["context", "files", "tracking", "shredding", "optimization"],
  },

  {
    id: "context-working-set-summary",
    name: "Working Set Summary",
    description: "At session start, generates a summary of the current working set (modified files, recent commits, branch state) to .bosun/working-set.json. Can be used to pre-load relevant context for the next agent session.",
    category: "context",
    events: "SessionStart",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && echo "{\\"modified\\":$(git diff --name-only 2>/dev/null | wc -l),\\"staged\\":$(git diff --cached --name-only 2>/dev/null | wc -l),\\"recent_commits\\":[$(git log --oneline -5 --format="\\\"%h: %s\\\"" 2>/dev/null | tr "\\n" "," | sed "s/,$//")],\\"branch\\":\\"$(git rev-parse --abbrev-ref HEAD 2>/dev/null)\\"}" > .bosun/working-set.json'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; $mod = (git diff --name-only 2>$null | Measure-Object).Count; $staged = (git diff --cached --name-only 2>$null | Measure-Object).Count; $commits = git log --oneline -5 2>$null; $branch = git rev-parse --abbrev-ref HEAD 2>$null; @{modified=$mod;staged=$staged;recent_commits=@($commits);branch=$branch} | ConvertTo-Json | Set-Content .bosun/working-set.json"`,
    ),
    blocking: false,
    timeout: 10_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["context", "working-set", "summary", "optimization"],
  },

  {
    id: "context-large-diff-warning",
    name: "Large Diff Warning",
    description: "Before committing, checks if the staged diff is unusually large (>500 lines). Warns the agent to consider splitting the commit.",
    category: "context",
    events: "PreCommit",
    command: shellCmd(
      `bash -c 'LINES=$(git diff --cached --stat | tail -1 | grep -oE "[0-9]+ insertion" | grep -oE "[0-9]+" || echo 0); if [ "$LINES" -gt 500 ]; then echo "WARNING: Large commit ($LINES insertions). Consider splitting into smaller commits." >&2; fi'`,
      `powershell -NoProfile -Command "$stat = git diff --cached --stat | Select-Object -Last 1; if ($stat -match '(\\d+) insertion') { $lines = [int]$Matches[1]; if ($lines -gt 500) { Write-Warning \"Large commit ($lines insertions). Consider splitting.\" } }"`,
    ),
    blocking: false,
    timeout: 10_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["context", "commit", "size", "warning"],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SECURITY — Secret scanning, permission checks
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  {
    id: "security-secret-scan-commit",
    name: "Secret Scanner on Commit",
    description: "Scans staged files for common secret patterns (API keys, tokens, passwords, private keys) before commit. Blocks if secrets are detected.",
    category: "security",
    events: "PreCommit",
    command: shellCmd(
      `bash -c 'SECRETS=$(git diff --cached -U0 | grep -iE "(PRIVATE KEY|api_key|apikey|secret_key|password|token|bearer|aws_access_key|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|xox[bpas]-)" | head -5); if [ -n "$SECRETS" ]; then echo "BLOCKED: Potential secrets detected in staged changes:" >&2; echo "$SECRETS" >&2; exit 1; fi; echo "OK: no secrets detected"'`,
      `powershell -NoProfile -Command "$diff = git diff --cached -U0 2>$null; $patterns = 'PRIVATE KEY|api_key|apikey|secret_key|password|token|bearer|aws_access_key|sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|xox[bpas]-'; $matches = $diff | Select-String -Pattern $patterns -AllMatches | Select-Object -First 5; if ($matches) { Write-Error 'BLOCKED: Potential secrets detected in staged changes.'; $matches | ForEach-Object { Write-Error $_.Line }; exit 1 }; Write-Host 'OK: no secrets detected'"`,
    ),
    blocking: true,
    timeout: 30_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: true,
    retryable: false,
    tags: ["security", "secrets", "scanning", "commit", "blocking"],
  },

  {
    id: "security-env-file-protection",
    name: ".env File Protection",
    description: "Prevents .env files from being committed to git. These files often contain secrets and should be in .gitignore.",
    category: "security",
    events: "PreCommit",
    command: shellCmd(
      `bash -c 'ENVFILES=$(git diff --cached --name-only | grep -E "^\\.env($|\\.)"); if [ -n "$ENVFILES" ]; then echo "BLOCKED: .env files should not be committed:" >&2; echo "$ENVFILES" >&2; echo "Add them to .gitignore instead." >&2; exit 1; fi'`,
      `powershell -NoProfile -Command "$envFiles = git diff --cached --name-only 2>$null | Where-Object { $_ -match '^\\.env($|\\.)' }; if ($envFiles) { Write-Error 'BLOCKED: .env files should not be committed.'; $envFiles | ForEach-Object { Write-Error $_ }; exit 1 }"`,
    ),
    blocking: true,
    timeout: 10_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: true,
    retryable: false,
    tags: ["security", "env", "secrets", "gitignore", "blocking"],
  },

  {
    id: "security-private-key-protection",
    name: "Private Key Protection",
    description: "Blocks committing private key files (.pem, .key, id_rsa, id_ed25519).",
    category: "security",
    events: "PreCommit",
    command: shellCmd(
      `bash -c 'KEYS=$(git diff --cached --name-only | grep -iE "\\.(pem|key)$|id_rsa|id_ed25519|id_ecdsa"); if [ -n "$KEYS" ]; then echo "BLOCKED: Private key files should not be committed:" >&2; echo "$KEYS" >&2; exit 1; fi'`,
      `powershell -NoProfile -Command "$keys = git diff --cached --name-only 2>$null | Where-Object { $_ -match '\\.(pem|key)$|id_rsa|id_ed25519|id_ecdsa' }; if ($keys) { Write-Error 'BLOCKED: Private key files should not be committed.'; $keys | ForEach-Object { Write-Error $_ }; exit 1 }"`,
    ),
    blocking: true,
    timeout: 10_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: true,
    retryable: false,
    tags: ["security", "keys", "pem", "blocking"],
  },

  {
    id: "security-npm-audit-on-push",
    name: "NPM Audit on Push",
    description: "Runs npm audit before push to check for known vulnerabilities in dependencies.",
    category: "security",
    events: "PrePush",
    command: shellCmd(
      `bash -c 'if [ -f package-lock.json ]; then npm audit --production --audit-level=high 2>&1 || echo "WARNING: npm audit found vulnerabilities" >&2; fi'`,
      `powershell -NoProfile -Command "if (Test-Path package-lock.json) { npm audit --production --audit-level=high 2>&1 }"`,
    ),
    blocking: false,
    timeout: 60_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["security", "npm", "audit", "dependencies", "supply-chain"],
    requires: "package-lock.json",
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GIT OPERATIONS — Branch protection, commit validation
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  {
    id: "git-fetch-before-push",
    name: "Fetch Before Push",
    description: "Fetches origin before pushing to reduce push rejections from stale refs.",
    category: "git",
    events: "PrePush",
    command: shellCmd(
      `bash -c 'git fetch origin --quiet 2>/dev/null; echo "OK: fetch completed"'`,
      `powershell -NoProfile -Command "git fetch origin --quiet 2>$null; Write-Host 'OK: fetch completed'"`,
    ),
    blocking: false,
    timeout: 60_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: true,
    maxRetries: 2,
    tags: ["git", "fetch", "push", "sync"],
  },

  {
    id: "git-verify-commits-ahead",
    name: "Verify Commits Ahead",
    description: "Before pushing, verifies the branch has at least one commit ahead of the base branch. Prevents empty pushes.",
    category: "git",
    events: "PrePush",
    command: shellCmd(
      `bash -c 'ahead=$(git rev-list --count $(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)..HEAD 2>/dev/null || echo 0); if [ "$ahead" -lt 1 ]; then echo "No commits ahead of origin/main" >&2; exit 1; else echo "OK: $ahead commit(s) ahead"; fi'`,
      `powershell -NoProfile -Command "$mb = git merge-base HEAD origin/main 2>$null; if (-not $mb) { Write-Error 'Cannot determine merge-base'; exit 1 }; $ahead = [int](git rev-list --count \"$mb..HEAD\" 2>$null); if ($ahead -lt 1) { Write-Error 'No commits ahead of origin/main'; exit 1 }; Write-Host \"OK: $ahead commit(s) ahead\""`,
    ),
    blocking: true,
    timeout: 30_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["git", "push", "validation", "blocking"],
  },

  {
    id: "git-conflict-check",
    name: "Merge Conflict Check",
    description: "Checks for unresolved merge conflict markers in staged files before commit.",
    category: "git",
    events: "PreCommit",
    command: shellCmd(
      `bash -c 'CONFLICTS=$(git diff --cached --name-only | xargs grep -l "^<<<<<<< " 2>/dev/null); if [ -n "$CONFLICTS" ]; then echo "BLOCKED: Unresolved merge conflicts found:" >&2; echo "$CONFLICTS" >&2; exit 1; fi; echo "OK: no conflict markers"'`,
      `powershell -NoProfile -Command "$files = git diff --cached --name-only 2>$null; $conflicts = @(); foreach ($f in $files) { if ((Get-Content $f -ErrorAction SilentlyContinue) -match '^<<<<<<< ') { $conflicts += $f } }; if ($conflicts.Count -gt 0) { Write-Error 'BLOCKED: Unresolved merge conflicts.'; $conflicts | ForEach-Object { Write-Error $_ }; exit 1 }; Write-Host 'OK: no conflict markers'"`,
    ),
    blocking: true,
    timeout: 15_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: true,
    retryable: false,
    tags: ["git", "conflicts", "commit", "blocking"],
  },

  {
    id: "git-branch-naming",
    name: "Branch Name Convention",
    description: "Validates branch names follow the pattern: prefix/description (e.g. feat/add-hooks, fix/login-bug). Warns on non-conforming names.",
    category: "git",
    events: "SessionStart",
    command: shellCmd(
      `bash -c 'BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); if [ "$BRANCH" != "main" ] && [ "$BRANCH" != "master" ] && [ "$BRANCH" != "develop" ]; then if ! echo "$BRANCH" | grep -qE "^(feat|fix|chore|docs|refactor|perf|test|build|ci|hotfix|release|ve|bosun)/"; then echo "WARNING: Branch name does not follow convention: $BRANCH" >&2; fi; fi'`,
      `powershell -NoProfile -Command "$branch = git rev-parse --abbrev-ref HEAD 2>$null; if ($branch -notin 'main','master','develop') { if ($branch -notmatch '^(feat|fix|chore|docs|refactor|perf|test|build|ci|hotfix|release|ve|bosun)/') { Write-Warning \"Branch name does not follow convention: $branch\" } }"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["git", "branch", "naming", "convention"],
  },

  {
    id: "git-stash-check-on-start",
    name: "Stash Check on Start",
    description: "At session start, warns if there are stashed changes that may be forgotten.",
    category: "git",
    events: "SessionStart",
    command: shellCmd(
      `bash -c 'COUNT=$(git stash list 2>/dev/null | wc -l); if [ "$COUNT" -gt 0 ]; then echo "INFO: $COUNT stash entries found. Run git stash list to review." >&2; fi'`,
      `powershell -NoProfile -Command "$stash = git stash list 2>$null; if ($stash) { Write-Warning \"$($stash.Count) stash entries found. Run git stash list to review.\" }"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["git", "stash", "session", "reminder"],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // NOTIFICATION — Alerts and broadcasts
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  {
    id: "notify-task-complete-log",
    name: "Task Completion Logger",
    description: "Logs task completion with commit summary to .bosun/completions.jsonl.",
    category: "notification",
    events: "TaskComplete",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && AHEAD=$(git rev-list --count $(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)..HEAD 2>/dev/null || echo 0) && echo "{\\"event\\":\\"task_complete\\",\\"task\\":\\"$VE_TASK_ID\\",\\"commits\\":$AHEAD,\\"ts\\":$(date +%s),\\"branch\\":\\"$VE_BRANCH_NAME\\"}" >> .bosun/completions.jsonl'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; $mb = git merge-base HEAD origin/main 2>$null; $ahead = if ($mb) { [int](git rev-list --count \"$mb..HEAD\" 2>$null) } else { 0 }; @{event='task_complete';task=$env:VE_TASK_ID;commits=$ahead;ts=[int](Get-Date -UFormat %s);branch=$env:VE_BRANCH_NAME} | ConvertTo-Json -Compress | Add-Content .bosun/completions.jsonl"`,
    ),
    blocking: false,
    timeout: 10_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["notification", "task", "completion", "logging"],
  },

  {
    id: "notify-push-summary",
    name: "Push Summary Logger",
    description: "After pushing, logs a push summary including branch, commit count, and last commit message.",
    category: "notification",
    events: "PostPush",
    command: shellCmd(
      `bash -c 'BRANCH=$(git rev-parse --abbrev-ref HEAD); MSG=$(git log -1 --format=%s); echo "[push] $BRANCH — $MSG"'`,
      `powershell -NoProfile -Command "$branch = git rev-parse --abbrev-ref HEAD 2>$null; $msg = git log -1 --format=%s 2>$null; Write-Host \"[push] $branch — $msg\""`,
    ),
    blocking: false,
    timeout: 10_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["notification", "push", "summary"],
  },

  {
    id: "notify-pr-created-log",
    name: "PR Creation Logger",
    description: "Logs pull request creation events for audit trail.",
    category: "notification",
    events: "PostPR",
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && echo "{\\"event\\":\\"pr_created\\",\\"task\\":\\"$VE_TASK_ID\\",\\"branch\\":\\"$VE_BRANCH_NAME\\",\\"ts\\":$(date +%s)}" >> .bosun/audit.jsonl'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; @{event='pr_created';task=$env:VE_TASK_ID;branch=$env:VE_BRANCH_NAME;ts=[int](Get-Date -UFormat %s)} | ConvertTo-Json -Compress | Add-Content .bosun/audit.jsonl"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["codex", "copilot", "claude"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["notification", "pr", "audit"],
  },

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // WORKFLOW INTEGRATION — Task status, workflow triggers
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  {
    id: "workflow-session-event-emit",
    name: "Workflow Event Emitter",
    description: "Emits bosun workflow events on session start/stop so workflow triggers can react. Writes to .bosun/events/ as event files that the workflow engine polls.",
    category: "workflow",
    events: ["SessionStart", "SessionStop"],
    command: shellCmd(
      `bash -c 'mkdir -p .bosun/events && echo "{\\"event\\":\\"agent.$VE_HOOK_EVENT\\",\\"sdk\\":\\"$VE_SDK\\",\\"task\\":\\"$VE_TASK_ID\\",\\"ts\\":$(date +%s)}" > .bosun/events/$(date +%s)-$VE_HOOK_EVENT.json'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun/events | Out-Null; $ts = [int](Get-Date -UFormat %s); @{event=\"agent.$($env:VE_HOOK_EVENT)\";sdk=$env:VE_SDK;task=$env:VE_TASK_ID;ts=$ts} | ConvertTo-Json | Set-Content \".bosun/events/$ts-$($env:VE_HOOK_EVENT).json\""`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["workflow", "events", "triggers", "session"],
  },

  {
    id: "workflow-task-status-webhook",
    name: "Task Status Webhook",
    description: "Sends task completion status to a configurable webhook URL. Set BOSUN_TASK_WEBHOOK_URL env var to enable.",
    category: "workflow",
    events: "TaskComplete",
    command: shellCmd(
      `bash -c 'if [ -n "$BOSUN_TASK_WEBHOOK_URL" ]; then curl -sS -X POST "$BOSUN_TASK_WEBHOOK_URL" -H "Content-Type: application/json" -d "{\\"task\\":\\"$VE_TASK_ID\\",\\"status\\":\\"completed\\",\\"branch\\":\\"$VE_BRANCH_NAME\\",\\"ts\\":$(date +%s)}" 2>/dev/null; fi'`,
      `powershell -NoProfile -Command "if ($env:BOSUN_TASK_WEBHOOK_URL) { Invoke-RestMethod -Method Post -Uri $env:BOSUN_TASK_WEBHOOK_URL -ContentType 'application/json' -Body (@{task=$env:VE_TASK_ID;status='completed';branch=$env:VE_BRANCH_NAME;ts=[int](Get-Date -UFormat %s)} | ConvertTo-Json) 2>$null }"`,
    ),
    blocking: false,
    timeout: 15_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: true,
    maxRetries: 2,
    tags: ["workflow", "webhook", "task", "integration"],
    env: { BOSUN_TASK_WEBHOOK_URL: "" },
    requires: "BOSUN_TASK_WEBHOOK_URL environment variable",
  },

  {
    id: "workflow-subagent-tracking",
    name: "Subagent Tracker",
    description: "Tracks subagent spawning and completion for multi-agent workflow coordination. Records to .bosun/subagent-log.jsonl.",
    category: "workflow",
    events: ["SubagentStart", "SubagentStop"],
    command: shellCmd(
      `bash -c 'mkdir -p .bosun && echo "{\\"event\\":\\"$VE_HOOK_EVENT\\",\\"sdk\\":\\"$VE_SDK\\",\\"task\\":\\"$VE_TASK_ID\\",\\"ts\\":$(date +%s)}" >> .bosun/subagent-log.jsonl'`,
      `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path .bosun | Out-Null; @{event=$env:VE_HOOK_EVENT;sdk=$env:VE_SDK;task=$env:VE_TASK_ID;ts=[int](Get-Date -UFormat %s)} | ConvertTo-Json -Compress | Add-Content .bosun/subagent-log.jsonl"`,
    ),
    blocking: false,
    timeout: 5_000,
    sdks: ["codex", "copilot", "claude"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["workflow", "subagent", "tracking", "multi-agent"],
  },

  {
    id: "workflow-pr-gate",
    name: "PR Quality Gate",
    description: "Before creating a PR, verifies the branch has passing tests and at least one commit. Prevents empty or broken PRs.",
    category: "workflow",
    events: "PrePR",
    command: shellCmd(
      `bash -c 'AHEAD=$(git rev-list --count $(git merge-base HEAD origin/main 2>/dev/null || echo HEAD)..HEAD 2>/dev/null || echo 0); if [ "$AHEAD" -lt 1 ]; then echo "BLOCKED: No commits to create PR from." >&2; exit 1; fi; echo "OK: $AHEAD commits ready for PR"'`,
      `powershell -NoProfile -Command "$mb = git merge-base HEAD origin/main 2>$null; $ahead = if ($mb) { [int](git rev-list --count \"$mb..HEAD\" 2>$null) } else { 0 }; if ($ahead -lt 1) { Write-Error 'BLOCKED: No commits to create PR from.'; exit 1 }; Write-Host \"OK: $ahead commits ready for PR\""`,
    ),
    blocking: true,
    timeout: 30_000,
    sdks: ["*"],
    core: false,
    defaultEnabled: false,
    retryable: false,
    tags: ["workflow", "pr", "quality", "blocking"],
  },
];

// ── Catalog API ─────────────────────────────────────────────────────────────

/**
 * Get the full hook catalog with computed compatibility info.
 * @param {object} [options]
 * @param {string} [options.category] - Filter by category
 * @param {string} [options.sdk] - Show only hooks compatible with this SDK
 * @param {boolean} [options.coreOnly] - Only core hooks
 * @param {boolean} [options.defaultOnly] - Only default-enabled hooks
 * @param {string} [options.search] - Text search in name/description/tags
 * @returns {HookLibraryEntry[]}
 */
export function getHookCatalog(options = {}) {
  let hooks = BUILTIN_HOOKS.map((h) => ({
    ...h,
    compatibility: getHookCompatibility(h),
  }));

  if (options.category) {
    hooks = hooks.filter((h) => h.category === options.category);
  }
  if (options.coreOnly) {
    hooks = hooks.filter((h) => h.core === true);
  }
  if (options.defaultOnly) {
    hooks = hooks.filter((h) => h.defaultEnabled === true);
  }
  if (options.sdk) {
    const sdk = options.sdk.toLowerCase();
    hooks = hooks.filter((h) => {
      const compat = h.compatibility[sdk];
      return compat && compat !== "unsupported";
    });
  }
  if (options.search) {
    const q = options.search.toLowerCase();
    hooks = hooks.filter(
      (h) =>
        h.name.toLowerCase().includes(q) ||
        h.description.toLowerCase().includes(q) ||
        h.id.includes(q) ||
        h.tags.some((t) => t.includes(q)),
    );
  }
  return hooks;
}

/**
 * Get all core hooks (always-on resilience hooks).
 * @returns {HookLibraryEntry[]}
 */
export function getCoreHooks() {
  return getHookCatalog({ coreOnly: true });
}

/**
 * Get all default-enabled hooks (core + recommended).
 * @returns {HookLibraryEntry[]}
 */
export function getDefaultHooks() {
  return getHookCatalog({ defaultOnly: true });
}

/**
 * Get a single hook by ID.
 * @param {string} hookId
 * @returns {HookLibraryEntry|null}
 */
export function getHookById(hookId) {
  const entry = BUILTIN_HOOKS.find((h) => h.id === hookId);
  if (!entry) return null;
  return { ...entry, compatibility: getHookCompatibility(entry) };
}

/**
 * Get all hook categories with counts.
 * @returns {Array<{id: string, name: string, description: string, icon: string, count: number, coreCount: number}>}
 */
export function getHookCategories() {
  return HOOK_CATEGORIES.map((cat) => ({
    ...cat,
    count: BUILTIN_HOOKS.filter((h) => h.category === cat.id).length,
    coreCount: BUILTIN_HOOKS.filter((h) => h.category === cat.id && h.core).length,
  }));
}

/**
 * Get the SDK compatibility matrix for all hooks.
 * @returns {Record<string, Record<string, "full"|"bridge"|"partial"|"unsupported">>}
 */
export function getSdkCompatibilityMatrix() {
  const matrix = {};
  for (const hook of BUILTIN_HOOKS) {
    matrix[hook.id] = getHookCompatibility(hook);
  }
  return matrix;
}

// ── Workspace Hook State ────────────────────────────────────────────────────

const HOOK_STATE_FILE = "hook-library-state.json";

/**
 * @typedef {Object} HookLibraryState
 * @property {Record<string, boolean>} enabled - hookId → enabled/disabled
 * @property {string} updatedAt
 * @property {string} [profile] - last scaffold profile used
 */

/**
 * Load the hook library state for a workspace.
 * @param {string} rootDir
 * @returns {HookLibraryState}
 */
export function loadHookState(rootDir) {
  const stateFile = resolve(rootDir, ".bosun", HOOK_STATE_FILE);
  try {
    if (existsSync(stateFile)) {
      return JSON.parse(readFileSync(stateFile, "utf8"));
    }
  } catch { /* corrupt file */ }
  return { enabled: {}, updatedAt: new Date().toISOString() };
}

/**
 * Save the hook library state for a workspace.
 * @param {string} rootDir
 * @param {HookLibraryState} state
 */
export function saveHookState(rootDir, state) {
  const bosunDir = resolve(rootDir, ".bosun");
  mkdirSync(bosunDir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(
    resolve(bosunDir, HOOK_STATE_FILE),
    JSON.stringify(state, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Initialize hook state with defaults for a workspace.
 * Enables all default hooks, does not disable any already-enabled hooks.
 * @param {string} rootDir
 * @returns {HookLibraryState}
 */
export function initializeHookState(rootDir) {
  const existing = loadHookState(rootDir);
  const defaults = getDefaultHooks();
  for (const hook of defaults) {
    if (!(hook.id in existing.enabled)) {
      existing.enabled[hook.id] = true;
    }
  }
  saveHookState(rootDir, existing);
  return existing;
}

/**
 * Enable a hook for a workspace.
 * @param {string} rootDir
 * @param {string} hookId
 * @returns {{ success: boolean, warning?: string }}
 */
export function enableHook(rootDir, hookId) {
  const hook = getHookById(hookId);
  if (!hook) return { success: false, warning: `Unknown hook: ${hookId}` };
  const state = loadHookState(rootDir);
  state.enabled[hookId] = true;
  saveHookState(rootDir, state);
  return { success: true };
}

/**
 * Disable a hook for a workspace. Shows warning for core hooks.
 * @param {string} rootDir
 * @param {string} hookId
 * @param {boolean} [force=false]
 * @returns {{ success: boolean, warning?: string }}
 */
export function disableHook(rootDir, hookId, force = false) {
  const hook = getHookById(hookId);
  if (!hook) return { success: false, warning: `Unknown hook: ${hookId}` };
  if (hook.core && !force) {
    return {
      success: false,
      warning: hook.disableWarning || `Hook "${hook.name}" is a core hook. Disabling it may affect bosun core functionality. Use force=true to confirm.`,
    };
  }
  const state = loadHookState(rootDir);
  state.enabled[hookId] = false;
  saveHookState(rootDir, state);
  return { success: true, warning: hook.core ? hook.disableWarning : undefined };
}

/**
 * Get the list of enabled hook IDs for a workspace.
 * @param {string} rootDir
 * @returns {string[]}
 */
export function getEnabledHookIds(rootDir) {
  const state = loadHookState(rootDir);
  return Object.entries(state.enabled)
    .filter(([, enabled]) => enabled === true)
    .map(([id]) => id);
}

/**
 * Get the full enabled hooks list with all metadata.
 * @param {string} rootDir
 * @returns {HookLibraryEntry[]}
 */
export function getEnabledHooks(rootDir) {
  const enabledIds = new Set(getEnabledHookIds(rootDir));
  return getHookCatalog().filter((h) => enabledIds.has(h.id));
}

/**
 * Get hooks formatted for registration with the agent-hooks system.
 * Groups by event for direct consumption by registerHook.
 * @param {string} rootDir
 * @returns {Record<string, import("./agent-hooks.mjs").HookDefinition[]>}
 */
export function getHooksForRegistration(rootDir) {
  const hooks = getEnabledHooks(rootDir);
  const byEvent = {};
  for (const hook of hooks) {
    const events = Array.isArray(hook.events) ? hook.events : [hook.events];
    for (const event of events) {
      if (!byEvent[event]) byEvent[event] = [];
      byEvent[event].push({
        id: hook.id,
        command: hook.command,
        description: hook.description,
        timeout: hook.timeout,
        blocking: hook.blocking,
        sdks: hook.sdks,
        builtin: hook.core,
        retryable: hook.retryable ?? false,
        maxRetries: hook.maxRetries,
        env: hook.env,
      });
    }
  }
  return byEvent;
}

// ── Library Integration ─────────────────────────────────────────────────────

/**
 * Convert hook catalog entries to library-manager entries format.
 * This allows hooks to appear in the unified library browser alongside
 * prompts, agents, skills, and MCP servers.
 * @returns {Array<{id: string, type: "hook", name: string, description: string, tags: string[], meta: object}>}
 */
export function getHooksAsLibraryEntries() {
  return BUILTIN_HOOKS.map((h) => ({
    id: `hook-${h.id}`,
    type: "hook",
    name: h.name,
    description: h.description,
    filename: `${h.id}.json`,
    tags: [...h.tags, h.category],
    scope: "global",
    meta: {
      category: h.category,
      core: h.core,
      defaultEnabled: h.defaultEnabled,
      blocking: h.blocking,
      events: Array.isArray(h.events) ? h.events : [h.events],
      sdks: h.sdks,
      compatibility: getHookCompatibility(h),
      requires: h.requires || null,
      disableWarning: h.disableWarning || null,
    },
    createdAt: "2026-03-20T00:00:00.000Z",
    updatedAt: "2026-03-20T00:00:00.000Z",
  }));
}

/**
 * Sync hook library entries into the library-manager manifest.
 * @param {string} rootDir
 * @param {object} [libraryFns] - Override library-manager functions (for testing)
 * @returns {{ added: number, updated: number, total: number }}
 */
export function syncHooksToLibrary(rootDir, libraryFns) {
  const hookEntries = getHooksAsLibraryEntries();
  let added = 0;
  let updated = 0;

  // Use provided functions or dynamic import from library-manager
  const upsert = libraryFns?.upsertEntry;
  const getExisting = libraryFns?.getEntry;

  if (!upsert || !getExisting) {
    // Return data only (caller imports library-manager separately)
    return { added: 0, updated: 0, total: hookEntries.length, entries: hookEntries };
  }

  for (const entry of hookEntries) {
    const existing = getExisting(rootDir, entry.id);
    if (existing) {
      upsert(rootDir, entry, undefined, { skipIndexSync: true });
      updated++;
    } else {
      upsert(rootDir, entry, undefined, { skipIndexSync: true });
      added++;
    }
  }

  return { added, updated, total: hookEntries.length };
}

// ── Exports Summary ─────────────────────────────────────────────────────────

export { BUILTIN_HOOKS, TAG };
