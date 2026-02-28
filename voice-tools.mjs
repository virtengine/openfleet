/**
 * voice-tools.mjs — Voice-callable tools for the Realtime API.
 *
 * Each tool mirrors a bosun API endpoint or system operation.
 * Tools use OpenAI function-calling schema.
 *
 * @module voice-tools
 */

import { loadConfig } from "./config.mjs";
import { execPrimaryPrompt, getPrimaryAgentName, setPrimaryAgent } from "./primary-agent.mjs";

// ── Module-scope lazy imports ───────────────────────────────────────────────

let _kanbanAdapter = null;
let _sessionTracker = null;
let _fleetCoordinator = null;
let _agentSupervisor = null;
let _sharedStateManager = null;

async function getKanban() {
  if (!_kanbanAdapter) {
    _kanbanAdapter = await import("./kanban-adapter.mjs");
  }
  return _kanbanAdapter;
}

async function getSessionTracker() {
  if (!_sessionTracker) {
    _sessionTracker = await import("./session-tracker.mjs");
  }
  return _sessionTracker;
}

async function getFleetCoordinator() {
  if (!_fleetCoordinator) {
    _fleetCoordinator = await import("./fleet-coordinator.mjs");
  }
  return _fleetCoordinator;
}

async function getSupervisor() {
  if (!_agentSupervisor) {
    _agentSupervisor = await import("./agent-supervisor.mjs");
  }
  return _agentSupervisor;
}

async function getSharedState() {
  if (!_sharedStateManager) {
    _sharedStateManager = await import("./shared-state-manager.mjs");
  }
  return _sharedStateManager;
}

// ── Tool Definitions (OpenAI function-calling format) ────────────────────────

const TOOL_DEFS = [
  // ── Workspace Tools ──
  {
    type: "function",
    name: "list_tasks",
    description: "List tasks from the kanban board. Returns task IDs, titles, status, and assignees.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["todo", "inprogress", "inreview", "done", "cancelled", "all"],
          description: "Filter by task status. Default: all",
        },
        limit: {
          type: "number",
          description: "Max number of tasks to return. Default: 20",
        },
      },
    },
  },
  {
    type: "function",
    name: "get_task",
    description: "Get detailed information about a specific task by ID or number.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID or issue number" },
      },
      required: ["taskId"],
    },
  },
  {
    type: "function",
    name: "create_task",
    description: "Create a new task on the kanban board.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Task title" },
        description: { type: "string", description: "Task description/body" },
        priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
        labels: {
          type: "array",
          items: { type: "string" },
          description: "Labels to apply",
        },
      },
      required: ["title"],
    },
  },
  {
    type: "function",
    name: "update_task_status",
    description: "Update the status of a task (move between columns).",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID or issue number" },
        status: {
          type: "string",
          enum: ["todo", "inprogress", "inreview", "done", "cancelled"],
        },
      },
      required: ["taskId", "status"],
    },
  },
  // ── Agent Tools ──
  {
    type: "function",
    name: "delegate_to_agent",
    description: "Delegate a complex task to a coding agent (codex, copilot, claude, or opencode). Use this for code changes, file creation, debugging, or any operation requiring workspace access. The agent will execute the task and return its response.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The instruction to send to the agent. Be specific and detailed.",
        },
        executor: {
          type: "string",
          enum: ["codex-sdk", "copilot-sdk", "claude-sdk", "opencode-sdk"],
          description: "Which agent to use. Defaults to the configured primary agent.",
        },
        mode: {
          type: "string",
          enum: ["code", "ask", "architect"],
          description: "Agent mode: code (make changes), ask (read-only), architect (plan). Default: code",
        },
      },
      required: ["message"],
    },
  },
  {
    type: "function",
    name: "get_agent_status",
    description: "Get the current status of the active coding agent (busy, idle, session info).",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "switch_agent",
    description: "Switch the active primary agent to a different executor.",
    parameters: {
      type: "object",
      properties: {
        executor: {
          type: "string",
          enum: ["codex-sdk", "copilot-sdk", "claude-sdk", "opencode-sdk"],
          description: "The executor to switch to",
        },
      },
      required: ["executor"],
    },
  },
  // ── Session Tools ──
  {
    type: "function",
    name: "list_sessions",
    description: "List active chat/agent sessions.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max sessions to return. Default: 10" },
      },
    },
  },
  {
    type: "function",
    name: "get_session_history",
    description: "Get the recent message history from a session.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session ID to retrieve" },
        limit: { type: "number", description: "Max messages. Default: 20" },
      },
      required: ["sessionId"],
    },
  },
  // ── System Tools ──
  {
    type: "function",
    name: "get_system_status",
    description: "Get the overall bosun system status including agent health, task counts, and fleet info.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "get_fleet_status",
    description: "Get fleet coordination status across workstations.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "run_command",
    description: "Execute a bosun CLI command (e.g., 'sync', 'maintenance', 'config show').",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bosun command to run" },
      },
      required: ["command"],
    },
  },
  // ── Git/PR Tools ──
  {
    type: "function",
    name: "get_pr_status",
    description: "Get the status of open pull requests.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max PRs to return. Default: 10" },
      },
    },
  },
  // ── Config Tools ──
  {
    type: "function",
    name: "get_config",
    description: "Get current bosun configuration values.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Specific config key to retrieve. Omit for full config summary." },
      },
    },
  },
  {
    type: "function",
    name: "update_config",
    description: "Update a bosun configuration value.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "Config key to update" },
        value: { type: "string", description: "New value" },
      },
      required: ["key", "value"],
    },
  },
  // ── Workspace Navigation ──
  {
    type: "function",
    name: "search_code",
    description: "Search for code patterns in the workspace.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query or regex pattern" },
        filePattern: { type: "string", description: "Glob pattern to filter files. E.g., '**/*.mjs'" },
        maxResults: { type: "number", description: "Max results. Default: 20" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "read_file_content",
    description: "Read the content of a file in the workspace.",
    parameters: {
      type: "object",
      properties: {
        filePath: { type: "string", description: "Path relative to workspace root" },
        startLine: { type: "number", description: "Start line (1-indexed)" },
        endLine: { type: "number", description: "End line (1-indexed)" },
      },
      required: ["filePath"],
    },
  },
  {
    type: "function",
    name: "list_directory",
    description: "List files and directories in a workspace path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to workspace root. Default: root" },
      },
    },
  },
  // ── Monitoring ──
  {
    type: "function",
    name: "get_recent_logs",
    description: "Get recent agent or system log entries.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["agent", "system"], description: "Log type. Default: agent" },
        lines: { type: "number", description: "Number of recent lines. Default: 50" },
      },
    },
  },
];

// ── Tool Execution ──────────────────────────────────────────────────────────

/**
 * Get tool definitions in OpenAI format.
 */
export function getToolDefinitions() {
  return TOOL_DEFS;
}

/**
 * Execute a tool call by name with given arguments.
 * @param {string} toolName
 * @param {object} args
 * @param {object} context — { sessionId, userId }
 * @returns {Promise<{ result: string, error?: string }>}
 */
export async function executeToolCall(toolName, args = {}, context = {}) {
  const handler = TOOL_HANDLERS[toolName];
  if (!handler) {
    return { result: null, error: `Unknown tool: ${toolName}` };
  }
  try {
    const result = await handler(args, context);
    return { result: typeof result === "string" ? result : JSON.stringify(result, null, 2) };
  } catch (err) {
    console.error(`[voice-tools] ${toolName} error:`, err.message);
    return { result: null, error: err.message };
  }
}

// ── Tool Handlers ───────────────────────────────────────────────────────────

const TOOL_HANDLERS = {
  async list_tasks(args) {
    const kanban = await getKanban();
    const status = args.status || "all";
    const limit = args.limit || 20;
    const tasks = await kanban.listTasks({ status: status === "all" ? undefined : status });
    const limited = tasks.slice(0, limit);
    return limited.map(t => ({
      id: t.id || t.number,
      title: t.title,
      status: t.status,
      assignee: t.assignee || t.assignees?.[0] || "unassigned",
      labels: t.labels || [],
    }));
  },

  async get_task(args) {
    const kanban = await getKanban();
    const task = await kanban.getTask(args.taskId);
    if (!task) return `Task ${args.taskId} not found.`;
    return {
      id: task.id || task.number,
      title: task.title,
      status: task.status,
      description: task.body || task.description || "(no description)",
      assignee: task.assignee || "unassigned",
      labels: task.labels || [],
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  },

  async create_task(args) {
    const kanban = await getKanban();
    const result = await kanban.createTask({
      title: args.title,
      body: args.description || "",
      priority: args.priority,
      labels: args.labels,
    });
    return `Created task: ${result.title || args.title} (ID: ${result.id || result.number})`;
  },

  async update_task_status(args) {
    const kanban = await getKanban();
    await kanban.updateTaskStatus(args.taskId, args.status);
    return `Task ${args.taskId} moved to ${args.status}.`;
  },

  async delegate_to_agent(args, context) {
    const cfg = loadConfig();
    const executor = args.executor || cfg.voice?.delegateExecutor || cfg.primaryAgent || "codex-sdk";
    const mode = args.mode || "code";

    // Switch agent if different from current
    const currentAgent = getPrimaryAgentName();
    if (executor !== currentAgent) {
      setPrimaryAgent(executor);
    }

    try {
      const result = await execPrimaryPrompt(args.message, {
        mode,
        sessionId: context.sessionId || `voice-delegate-${Date.now()}`,
        sessionType: "voice-delegate",
        timeoutMs: 5 * 60 * 1000, // 5 min timeout for voice delegations
        onEvent: () => {
          // Could broadcast progress via WebSocket here
        },
      });
      const text = typeof result === "string"
        ? result
        : result?.finalResponse || result?.text || result?.message || JSON.stringify(result);
      return text.length > 2000 ? text.slice(0, 2000) + "... (truncated)" : text;
    } finally {
      // Restore original agent if we switched
      if (executor !== currentAgent) {
        try { setPrimaryAgent(currentAgent); } catch { /* best effort */ }
      }
    }
  },

  async get_agent_status() {
    const name = getPrimaryAgentName();
    return {
      activeAgent: name,
      status: "available",
      message: `${name} is the active primary agent.`,
    };
  },

  async switch_agent(args) {
    const previous = getPrimaryAgentName();
    setPrimaryAgent(args.executor);
    return `Switched primary agent from ${previous} to ${args.executor}.`;
  },

  async list_sessions(args) {
    const tracker = await getSessionTracker();
    const sessions = tracker.listSessions ? tracker.listSessions() : [];
    const limit = args.limit || 10;
    return sessions.slice(0, limit).map(s => ({
      id: s.id || s.taskId,
      type: s.type || "task",
      status: s.status,
      lastActive: s.lastActiveAt || s.lastActivityAt,
    }));
  },

  async get_session_history(args) {
    const tracker = await getSessionTracker();
    const session = tracker.getSession ? tracker.getSession(args.sessionId) : null;
    if (!session) return `Session ${args.sessionId} not found.`;
    const limit = args.limit || 20;
    const messages = (session.messages || []).slice(-limit);
    return messages.map(m => ({
      role: m.role || m.type,
      content: m.content,
      timestamp: m.timestamp,
    }));
  },

  async get_system_status() {
    const cfg = loadConfig();
    const name = getPrimaryAgentName();
    return {
      primaryAgent: name,
      kanbanBackend: cfg.kanbanBackend || cfg.kanban?.backend || "internal",
      projectName: cfg.projectName || "unknown",
      mode: cfg.mode || "generic",
      voiceEnabled: cfg.voice?.enabled !== false,
    };
  },

  async get_fleet_status() {
    try {
      const fleet = await getFleetCoordinator();
      const status = fleet.getFleetStatus ? fleet.getFleetStatus() : {};
      return status;
    } catch {
      return { error: "Fleet coordinator not available" };
    }
  },

  async run_command(args) {
    // Only allow safe read-only commands via voice
    const safeCommands = ["status", "config show", "sync", "health", "fleet status"];
    const cmd = String(args.command || "").trim().toLowerCase();
    const isSafe = safeCommands.some(s => cmd.startsWith(s));
    if (!isSafe) {
      return `Command "${args.command}" is not allowed via voice. Safe commands: ${safeCommands.join(", ")}`;
    }
    return `Command "${args.command}" acknowledged. Use the UI or CLI for execution.`;
  },

  async get_pr_status(args) {
    try {
      const { execSync } = await import("node:child_process");
      const limit = args.limit || 10;
      const result = execSync(
        `gh pr list --limit ${limit} --json number,title,state,author,url --jq ".[] | {number, title, state, author: .author.login}"`,
        { encoding: "utf8", timeout: 15_000 },
      );
      return result.trim() || "No open pull requests.";
    } catch {
      return "Could not fetch PR status. Ensure gh CLI is installed.";
    }
  },

  async get_config(args) {
    const cfg = loadConfig();
    if (args.key) {
      const value = cfg[args.key];
      return value !== undefined ? { [args.key]: value } : `Config key "${args.key}" not found.`;
    }
    // Return safe summary
    return {
      primaryAgent: cfg.primaryAgent,
      mode: cfg.mode,
      kanbanBackend: cfg.kanbanBackend || cfg.kanban?.backend,
      projectName: cfg.projectName,
      autoFixEnabled: cfg.autoFixEnabled,
      watchEnabled: cfg.watchEnabled,
      voiceEnabled: cfg.voice?.enabled !== false,
    };
  },

  async update_config(args) {
    return `Config update for "${args.key}" = "${args.value}" noted. Please apply via Settings UI for persistence.`;
  },

  async search_code(args) {
    try {
      const { execSync } = await import("node:child_process");
      const pattern = args.filePattern ? `--include="${args.filePattern}"` : "";
      const limit = args.maxResults || 20;
      const result = execSync(
        `grep -rn ${pattern} "${args.query}" . --max-count=${limit} 2>/dev/null || true`,
        { encoding: "utf8", timeout: 10_000, cwd: process.cwd() },
      );
      return result.trim() || `No matches found for "${args.query}".`;
    } catch {
      return `Search failed for "${args.query}".`;
    }
  },

  async read_file_content(args) {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    try {
      const fullPath = resolve(process.cwd(), args.filePath);
      const content = readFileSync(fullPath, "utf8");
      const lines = content.split("\n");
      const start = (args.startLine || 1) - 1;
      const end = args.endLine || lines.length;
      const slice = lines.slice(start, end).join("\n");
      return slice.length > 3000 ? slice.slice(0, 3000) + "\n... (truncated)" : slice;
    } catch (err) {
      return `Could not read ${args.filePath}: ${err.message}`;
    }
  },

  async list_directory(args) {
    const { readdirSync, statSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    try {
      const dir = resolve(process.cwd(), args.path || ".");
      const entries = readdirSync(dir).slice(0, 50);
      return entries.map(name => {
        try {
          const isDir = statSync(join(dir, name)).isDirectory();
          return isDir ? `${name}/` : name;
        } catch {
          return name;
        }
      });
    } catch (err) {
      return `Could not list ${args.path || "."}: ${err.message}`;
    }
  },

  async get_recent_logs(args) {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    try {
      const logsDir = resolve(process.cwd(), "logs");
      const type = args.type || "agent";
      const lines = args.lines || 50;
      const files = readdirSync(logsDir)
        .filter(f => f.includes(type) && f.endsWith(".log"))
        .sort((a, b) => {
          try {
            return statSync(join(logsDir, b)).mtimeMs - statSync(join(logsDir, a)).mtimeMs;
          } catch { return 0; }
        });
      if (!files.length) return `No ${type} logs found.`;
      const content = readFileSync(join(logsDir, files[0]), "utf8");
      const logLines = content.trim().split("\n");
      return logLines.slice(-lines).join("\n");
    } catch {
      return "Could not read logs.";
    }
  },
};

export { TOOL_DEFS as VOICE_TOOLS };
