/**
 * voice-tools.mjs — Voice-callable tools for the Realtime API.
 *
 * Each tool mirrors a bosun API endpoint or system operation.
 * Tools use OpenAI function-calling schema.
 *
 * @module voice-tools
 */

import { loadConfig } from "./config.mjs";
import { execPrimaryPrompt, getPrimaryAgentName, setPrimaryAgent, getAgentMode, setAgentMode } from "./primary-agent.mjs";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { resolveAgentRepoRoot } from "./repo-root.mjs";
import { getVisionSessionState } from "./vision-session-state.mjs";

// ── Voice response shaping (inspired by claude-phone VOICE_CONTEXT pattern) ──

/**
 * Injected as a preamble into every ask_agent_context prompt so the agent
 * returns TTS-ready responses.  The markers are identical to claude-phone's
 * convention so responses composed by any Claude-family executor are
 * automatically shaped for spoken delivery.
 */
const VOICE_CONTEXT_PREAMBLE = `[VOICE CONTEXT]
This query comes from a voice call. Respond concisely and conversationally.
PREFER: VOICE_RESPONSE: [your answer in 2 sentences, ≤40 words — this is what gets spoken]
For code results or lists, summarise the key finding verbally instead of dumping raw output.
[END VOICE CONTEXT]

`;

/**
 * Extract the TTS-ready fragment from an agent response.
 *
 * Priority:
 *   1. Content after a `VOICE_RESPONSE:` (or `🗣️ VOICE_RESPONSE:`) marker.
 *   2. First non-empty sentence (≤120 words) with code fences stripped.
 *
 * Always returns a plain string safe for TTS without backtick escaping.
 */
function formatVoiceToolResult(text) {
  const raw = String(text || "").trim();
  if (!raw) return raw;

  // 1) Honour explicit VOICE_RESPONSE: marker (claude-phone convention)
  const markerMatch = raw.match(/(?:🗣️\s*)?VOICE_RESPONSE:\s*([^\n]+)/i);
  if (markerMatch) {
    return markerMatch[1].trim();
  }

  // 2) Strip markdown: code fences, inline code, bullet markers
  const stripped = raw
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    .replace(/^[#>*-]+ /gm, "")
    .replace(/\n{2,}/g, " ")
    .replace(/\n/g, " ")
    .trim();

  // 3) Truncate to 100 words for spoken clarity
  const words = stripped.split(/\s+/);
  if (words.length <= 100) return stripped;
  return words.slice(0, 100).join(" ") + "…";
}

// ── Module-scope lazy imports ───────────────────────────────────────────────

let _kanbanAdapter = null;
let _sessionTracker = null;
let _fleetCoordinator = null;
let _agentSupervisor = null;
let _sharedStateManager = null;
let _agentPool = null;

const VALID_EXECUTORS = new Set([
  "codex-sdk",
  "copilot-sdk",
  "claude-sdk",
  "gemini-sdk",
  "opencode-sdk",
]);
const VALID_AGENT_MODES = new Set(["ask", "agent", "plan", "web", "instant"]);
const MODE_ALIASES = Object.freeze({
  code: "agent",
  architect: "plan",
  design: "plan",
  chat: "ask",
  question: "ask",
  fast: "instant",
  quick: "instant",
  browser: "web",
});

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

async function getAgentPool() {
  if (!_agentPool) {
    _agentPool = await import("./agent-pool.mjs");
  }
  return _agentPool;
}

async function resolveKanbanContext() {
  const cfg = loadConfig();
  const kanbanMod = await getKanban();
  const adapter = typeof kanbanMod.getKanbanAdapter === "function"
    ? kanbanMod.getKanbanAdapter()
    : null;
  if (!adapter) {
    throw new Error("Kanban adapter is unavailable");
  }
  const projects = typeof adapter.listProjects === "function"
    ? await adapter.listProjects()
    : [];
  const configuredProjectId = String(
    cfg?.kanban?.projectId || process.env.KANBAN_PROJECT_ID || process.env.VK_PROJECT_ID || "",
  ).trim() || null;
  const discoveredProjectIds = (Array.isArray(projects) ? projects : [])
    .map((project) => String(project?.id || project?.project_id || "").trim())
    .filter(Boolean);
  const projectIds = [];
  if (configuredProjectId) {
    projectIds.push(configuredProjectId);
  }
  for (const id of discoveredProjectIds) {
    if (!projectIds.includes(id)) projectIds.push(id);
  }
  if (!projectIds.length) {
    projectIds.push(null);
  }
  return { kanbanMod, adapter, projects, projectIds, projectId: projectIds[0] || null };
}

async function listTasksAcrossProjects(context = {}, filters = {}) {
  const { adapter, projectIds } = await resolveKanbanContext();
  const ids = Array.isArray(projectIds) && projectIds.length ? projectIds : [null];
  const all = [];
  const seen = new Set();
  let firstErr = null;
  for (const projectId of ids) {
    try {
      const tasks = await adapter.listTasks(projectId, filters);
      for (const task of Array.isArray(tasks) ? tasks : []) {
        const stableId = String(task?.id || task?.number || `${projectId || "default"}:${task?.title || ""}`).trim();
        if (!stableId || seen.has(stableId)) continue;
        seen.add(stableId);
        all.push(task);
      }
    } catch (err) {
      if (!firstErr) firstErr = err;
    }
  }
  if (!all.length && firstErr) {
    throw firstErr;
  }
  return all;
}

async function getLatestVisionSummary(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return "";
  try {
    const tracker = await getSessionTracker();
    const session = tracker.getSessionById
      ? tracker.getSessionById(id)
      : (tracker.getSession ? tracker.getSession(id) : null);
    const metaSummary = String(session?.metadata?.latestVisionSummary || "").trim();
    if (metaSummary) return `[Vision] ${metaSummary}`;
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (String(msg?.role || "").trim().toLowerCase() !== "system") continue;
      const text = String(msg?.content || "").trim();
      if (!text) continue;
      if (/^\[Vision\s/i.test(text)) return text;
    }
  } catch {
    // best effort: continue without visual context
  }
  return "";
}

function appendVisionSummary(message, visionSummary) {
  const base = String(message || "").trim();
  const summary = String(visionSummary || "").trim();
  if (!base || !summary) return base;
  return `${base}\n\nLive visual context from this call:\n${summary}`;
}

function normalizeCandidatePath(input) {
  if (!input) return "";
  try {
    return resolvePath(String(input));
  } catch {
    return String(input || "");
  }
}

async function resolveDelegationCwd(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) return process.cwd();
  try {
    const tracker = await getSessionTracker();
    const session = tracker.getSessionById?.(id) || tracker.getSession?.(id) || null;
    const metadata = session?.metadata && typeof session.metadata === "object"
      ? session.metadata
      : null;
    const explicit = normalizeCandidatePath(metadata?.workspaceDir);
    if (explicit && existsSync(explicit)) return explicit;
  } catch {
    // best effort
  }
  return process.cwd();
}

async function resolveToolCwd(context = {}) {
  const sessionId = String(context?.sessionId || "").trim();
  const fromSession = await resolveDelegationCwd(sessionId);
  if (fromSession && existsSync(fromSession)) return fromSession;
  const repoRoot = resolveAgentRepoRoot();
  if (repoRoot && existsSync(repoRoot)) return repoRoot;
  return process.cwd();
}

async function getWorkspaceContextSummary(context = {}) {
  const sessionId = String(context?.sessionId || "").trim();
  const cwd = await resolveToolCwd(context);
  const repoRoot = resolveAgentRepoRoot();
  let metadata = {};
  try {
    const tracker = await getSessionTracker();
    const session = tracker.getSessionById?.(sessionId) || tracker.getSession?.(sessionId) || null;
    metadata = session?.metadata && typeof session.metadata === "object" ? session.metadata : {};
  } catch {
    metadata = {};
  }
  return {
    sessionId: sessionId || null,
    workspaceId: String(metadata?.workspaceId || "").trim() || null,
    workspaceDir: String(metadata?.workspaceDir || "").trim() || null,
    repository: String(metadata?.repository || metadata?.repo || "").trim() || null,
    cwd,
    repoRoot,
  };
}

function makeBackgroundSessionId() {
  return `voice-bg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
    description: "Delegate a complex task to a coding agent (codex, copilot, claude, gemini, or opencode). Use this for code changes, file creation, debugging, or any operation requiring workspace access. The agent will execute the task and return its response.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The instruction to send to the agent. Be specific and detailed.",
        },
        executor: {
          type: "string",
          enum: ["codex-sdk", "copilot-sdk", "claude-sdk", "gemini-sdk", "opencode-sdk"],
          description: "Which agent to use. Defaults to the configured primary agent.",
        },
        mode: {
          type: "string",
          enum: ["ask", "agent", "plan", "code", "architect"],
          description: "Agent mode: code (make changes), ask (read-only), architect (plan). Default: code",
        },
        model: {
          type: "string",
          description: "Optional model override for the delegated call.",
        },
      },
      required: ["message"],
    },
  },
  {
    type: "function",
    name: "ask_agent_context",
    description: "Ask the coding agent a quick question in ask/instant mode and return the answer in this voice turn. Use for context, project understanding, debugging questions, and fast reasoning that needs workspace awareness.",
    parameters: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Question or instruction for the agent.",
        },
        mode: {
          type: "string",
          enum: ["ask", "instant"],
          description: "Low-latency query mode. Default: instant",
        },
        model: {
          type: "string",
          description: "Optional model override for this quick query.",
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
          enum: ["codex-sdk", "copilot-sdk", "claude-sdk", "gemini-sdk", "opencode-sdk"],
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
  {
    type: "function",
    name: "get_workspace_context",
    description: "Get current workspace and repository context for this voice/chat session.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "query_live_view",
    description: "Analyze the latest live camera/screen frame for this session with a specific question. Use this for real visual understanding of what is currently on screen.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Question about the current visual frame. Example: 'What error is shown on screen?'",
        },
      },
      required: ["query"],
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
  // ── Task Management (extended) ──
  {
    type: "function",
    name: "search_tasks",
    description: "Search tasks by text query across titles, descriptions, and labels.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        limit: { type: "number", description: "Max results. Default: 20" },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "get_task_stats",
    description: "Get task board statistics (counts by status, backlog size, etc.).",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "delete_task",
    description: "Delete a task from the kanban board.",
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
    name: "comment_on_task",
    description: "Add a comment to a task.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Task ID" },
        body: { type: "string", description: "Comment text" },
      },
      required: ["taskId", "body"],
    },
  },
  // ── Agent Mode ──
  {
    type: "function",
    name: "set_agent_mode",
    description: "Set the agent interaction mode (ask for questions, agent for code changes, plan for architecture).",
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["ask", "agent", "plan"],
          description: "The interaction mode to set",
        },
      },
      required: ["mode"],
    },
  },
  // ── Workflow & Skills ──
  {
    type: "function",
    name: "list_workflows",
    description: "List available workflow templates.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "list_skills",
    description: "List available agent skills from the knowledge base.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "list_prompts",
    description: "List available agent prompt definitions.",
    parameters: { type: "object", properties: {} },
  },
  // ── Batch Action ──
  {
    type: "function",
    name: "dispatch_action",
    description: "Execute a Bosun action by name. Use for any action not covered by dedicated tools. Actions: task.list, task.create, agent.delegate, system.status, workflow.list, skill.list, prompt.list, etc.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action name (e.g. task.stats, agent.status)" },
        params: {
          type: "object",
          description: "Action parameters",
        },
      },
      required: ["action"],
    },
  },
  // ── Generic MCP Gateway ──
  {
    type: "function",
    name: "invoke_mcp_tool",
    description: "Call any MCP (Model Context Protocol) tool by name via the agent. Use for GitHub operations (create PR, list issues), kanban integrations, or any capability exposed by a configured MCP server. This is the preferred way to trigger one-shot MCP actions from voice without needing a dedicated tool wrapper.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          description: "The MCP tool name, e.g. 'create_issue', 'create_pull_request', 'list_tasks'. For GitHub tools omit the server prefix.",
        },
        server: {
          type: "string",
          description: "Optional MCP server name to disambiguate, e.g. 'github', 'linear', 'jira'. Leave empty if unambiguous.",
        },
        args: {
          type: "object",
          description: "Arguments to pass to the MCP tool as key/value pairs.",
        },
      },
      required: ["tool"],
    },
  },
  // ── Context Warm-up ──
  {
    type: "function",
    name: "warm_codebase_context",
    description: "Pre-load codebase context into the agent so subsequent code questions answer instantly. Call this once at the start of a voice session when you know the user will ask project-specific questions.",
    parameters: { type: "object", properties: {} },
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
    const status = args.status || "all";
    const limit = args.limit || 20;
    const tasks = await listTasksAcrossProjects({}, {
      status: status === "all" ? undefined : status,
    });
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
    const { adapter } = await resolveKanbanContext();
    const task = await adapter.getTask(args.taskId);
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
    const { adapter, projectId } = await resolveKanbanContext();
    const result = await adapter.createTask(projectId, {
      title: args.title,
      body: args.description || "",
      priority: args.priority,
      labels: args.labels,
    });
    return `Created task: ${result.title || args.title} (ID: ${result.id || result.number})`;
  },

  async update_task_status(args) {
    const { adapter } = await resolveKanbanContext();
    await adapter.updateTaskStatus(args.taskId, args.status);
    return `Task ${args.taskId} moved to ${args.status}.`;
  },

  async delegate_to_agent(args, context) {
    const cfg = loadConfig();
    const requestedExecutor = String(
      args.executor || context.executor || cfg.voice?.delegateExecutor || cfg.primaryAgent || "codex-sdk",
    )
      .trim()
      .toLowerCase();
    const executor = VALID_EXECUTORS.has(requestedExecutor)
      ? requestedExecutor
      : (cfg.voice?.delegateExecutor || cfg.primaryAgent || "codex-sdk");

    const rawMode = String(args.mode || context.mode || "instant")
      .trim()
      .toLowerCase();
    const mode = MODE_ALIASES[rawMode] || (VALID_AGENT_MODES.has(rawMode) ? rawMode : "instant");
    const model = String(args.model || context.model || "").trim() || undefined;
    const parentSessionId = String(context.sessionId || "").trim() || null;
    const backgroundSessionId = makeBackgroundSessionId();
    const sessionType = "voice-delegate";
    const cwd = await resolveToolCwd(context);
    const workspaceContext = await getWorkspaceContextSummary(context);
    const visionSummary = await getLatestVisionSummary(parentSessionId || "");
    const delegateMessage = appendVisionSummary(args.message, visionSummary);
    const shortTitle = String(args.message || "").trim().slice(0, 90) || "Voice background task";

    // ── Fire-and-forget: launch via execPooledPrompt (isolated, no global state mutation) ──
    const pool = await getAgentPool();
    const delegationId = `voice-deleg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    // Record delegation start in session tracker (dedicated background session + parent linkage)
    try {
      const tracker = await getSessionTracker();
      if (tracker.createSession) {
        tracker.createSession({
          id: backgroundSessionId,
          type: sessionType,
          taskId: backgroundSessionId,
          metadata: {
            title: `Voice Background: ${shortTitle}`,
            source: "voice",
            parentSessionId,
            workspaceId: workspaceContext.workspaceId || undefined,
            workspaceDir: workspaceContext.workspaceDir || workspaceContext.cwd || undefined,
            repository: workspaceContext.repository || undefined,
            executor,
            mode,
            model: model || undefined,
          },
        });
      }
      if (parentSessionId && tracker.recordEvent) {
        tracker.recordEvent(parentSessionId, {
          role: "system",
          content: `[Voice Delegation] Started background session ${backgroundSessionId} with ${executor} (${mode}): ${args.message}`,
          timestamp: new Date().toISOString(),
          meta: {
            source: "voice",
            eventType: "voice_background_started",
            backgroundSessionId,
            executor,
            mode,
          },
        });
      }
      if (tracker.recordEvent) {
        tracker.recordEvent(backgroundSessionId, {
          role: "system",
          content: `[Background Task Started] Delegation ${delegationId} using ${executor} (${mode}).`,
          timestamp: new Date().toISOString(),
        });
      }
    } catch {
      // best effort — don't block on session recording
    }

    // Launch pooled prompt — non-blocking (fire-and-forget with .catch)
    pool.execPooledPrompt(delegateMessage, {
      sdk: executor,
      mode,
      model,
      cwd,
      timeoutMs: 5 * 60 * 1000,
      onEvent: (event) => {
        // Intentionally ignore per-token/per-step stream events here.
        // We only publish one final summary event to avoid chat/message spam.
      },
    })
      .then(async (result) => {
        const text = typeof result === "string"
          ? result
          : result?.finalResponse || result?.text || result?.message || JSON.stringify(result);
        const truncated = text.length > 4000 ? text.slice(0, 4000) + "... (truncated)" : text;

        // Record completion in session tracker — this automatically broadcasts
        // to WebSocket clients via the session event listener system
        try {
          const tracker = await getSessionTracker();
          if (tracker.recordEvent) {
            tracker.recordEvent(backgroundSessionId, {
              role: "assistant",
              content: truncated,
              timestamp: new Date().toISOString(),
            });
            if (parentSessionId) {
              const summaryText = truncated.replace(/\s+/g, " ").trim();
              const shortSummary = summaryText.length > 600
                ? `${summaryText.slice(0, 600)}...`
                : summaryText;
              tracker.recordEvent(parentSessionId, {
                role: "system",
                content: `{RESPONSE}: ${shortSummary}`,
                timestamp: new Date().toISOString(),
                meta: {
                  source: "voice",
                  eventType: "voice_background_summary",
                  backgroundSessionId,
                  executor,
                  mode,
                },
              });
            }
          }
          if (tracker.updateSessionStatus) {
            tracker.updateSessionStatus(backgroundSessionId, "done");
          }
        } catch {
          // best effort
        }
      })
      .catch((err) => {
        console.error(`[voice-tools] delegate_to_agent async error (${delegationId}):`, err?.message || err);
        // Record failure in session tracker
        getSessionTracker().then((tracker) => {
          if (tracker.updateSessionStatus) {
            tracker.updateSessionStatus(backgroundSessionId, "error");
          }
          if (tracker.recordEvent) {
            tracker.recordEvent(backgroundSessionId, {
              role: "system",
              content: `[Voice Delegation Error] ${err?.message || "Unknown error"}`,
              timestamp: new Date().toISOString(),
            });
            if (parentSessionId) {
              tracker.recordEvent(parentSessionId, {
                role: "system",
                content: `[Voice Delegation Error] Background session ${backgroundSessionId} failed: ${err?.message || "Unknown error"}`,
                timestamp: new Date().toISOString(),
                meta: {
                  source: "voice",
                  eventType: "voice_background_error",
                  backgroundSessionId,
                  executor,
                  mode,
                },
              });
            }
          }
        }).catch(() => {});
      });

    // Return immediately — don't block the voice session
    return `{RESPONSE}: Delegation started in background session ${backgroundSessionId} (delegation ${delegationId}). Agent "${executor}" is working in ${mode} mode. You can continue talking; query this session later with get_session_history.`;
  },

  async ask_agent_context(args, context) {
    const cfg = loadConfig();
    const requestedExecutor = String(
      context?.executor || cfg.voice?.delegateExecutor || cfg.primaryAgent || "codex-sdk",
    )
      .trim()
      .toLowerCase();
    const executor = VALID_EXECUTORS.has(requestedExecutor)
      ? requestedExecutor
      : (cfg.voice?.delegateExecutor || cfg.primaryAgent || "codex-sdk");

    const mode = "instant";
    const model = String(args.model || context?.model || "").trim() || undefined;
    const sessionId = String(context?.sessionId || "").trim() || `voice-ask-${Date.now()}`;
    const cwd = await resolveToolCwd(context);
    const visionSummary = await getLatestVisionSummary(sessionId);
    // Inject voice preamble so the agent returns TTS-shaped responses
    const message = VOICE_CONTEXT_PREAMBLE + appendVisionSummary(args.message, visionSummary);

    try {
      const pool = await getAgentPool();
      const result = await pool.execPooledPrompt(message, {
        sdk: executor,
        mode,
        model,
        cwd,
        timeoutMs: 10_000,
      });
      const text = typeof result === "string"
        ? result
        : result?.finalResponse || result?.text || result?.message || JSON.stringify(result);
      const trimmed = String(text || "").trim();
      if (!trimmed) return "{RESPONSE}: Agent returned no content.";
      const clipped = trimmed.length > 4000 ? `${trimmed.slice(0, 4000)}... (truncated)` : trimmed;
      // Apply TTS-safe formatting (extracts VOICE_RESPONSE: marker if present)
      return `{RESPONSE}: ${formatVoiceToolResult(clipped)}`;
    } catch (err) {
      // If quick mode cannot answer in time, auto-delegate to background.
      const backgroundMsg = await TOOL_HANDLERS.delegate_to_agent(
        {
          message: args.message,
          executor,
          mode: "agent",
          model,
        },
        context,
      );
      const cleanedBackgroundMsg = String(backgroundMsg || "")
        .replace(/^\{RESPONSE\}:\s*/i, "")
        .trim();
      const reason = String(err?.message || "instant query timed out").trim();
      return `{RESPONSE}: Quick answer unavailable (${reason}). ${cleanedBackgroundMsg}`;
    }
  },

  async ask_agent_context_legacy_fallback(args, context) {
    // Reserved for explicit compatibility only.
    const model = String(args.model || context?.model || "").trim() || undefined;
    const sessionId = String(context?.sessionId || "").trim() || `voice-ask-${Date.now()}`;
    const cwd = await resolveToolCwd(context);
    const visionSummary = await getLatestVisionSummary(sessionId);
    const message = appendVisionSummary(args.message, visionSummary);
    try {
      const fallback = await execPrimaryPrompt(message, {
        mode: "instant",
        model,
        sessionType: "voice-ask",
        cwd,
      });
      const text = typeof fallback === "string"
        ? fallback
        : fallback?.finalResponse || fallback?.text || fallback?.message || JSON.stringify(fallback);
      return `{RESPONSE}: ${String(text || "").trim() || "No response."}`;
    } catch (fallbackErr) {
      return `{RESPONSE}: Quick agent query failed: ${fallbackErr?.message || "unknown error"}`;
    }
  },

  async get_agent_status() {
    const name = getPrimaryAgentName();
    let activeSessions = [];
    try {
      const pool = await getAgentPool();
      activeSessions = typeof pool.getActiveSessions === "function"
        ? pool.getActiveSessions().slice(0, 20)
        : [];
    } catch {
      activeSessions = [];
    }
    return {
      activeAgent: name,
      status: "available",
      activeSessions: activeSessions.length,
      activeSessionThreads: activeSessions.map((entry) => ({
        taskKey: entry.taskKey || null,
        sdk: entry.sdk || null,
        threadId: entry.threadId || null,
        ageMs: entry.age || null,
      })),
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
    const session = tracker.getSessionById?.(args.sessionId) || tracker.getSession?.(args.sessionId) || null;
    if (!session) return `Session ${args.sessionId} not found.`;
    const limit = args.limit || 20;
    const messages = (session.messages || []).slice(-limit);
    return messages.map(m => ({
      role: m.role || m.type,
      content: m.content,
      timestamp: m.timestamp,
    }));
  },

  async get_system_status(args, context) {
    const cfg = loadConfig();
    const name = getPrimaryAgentName();
    const workspace = await getWorkspaceContextSummary(context);
    return {
      primaryAgent: name,
      kanbanBackend: cfg.kanbanBackend || cfg.kanban?.backend || "internal",
      projectName: cfg.projectName || "unknown",
      mode: cfg.mode || "generic",
      voiceEnabled: cfg.voice?.enabled !== false,
      workspace,
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

  async search_code(args, context) {
    try {
      const { execSync } = await import("node:child_process");
      const pattern = args.filePattern ? `--include="${args.filePattern}"` : "";
      const limit = args.maxResults || 20;
      const cwd = await resolveToolCwd(context);
      const result = execSync(
        `grep -rn ${pattern} "${args.query}" . --max-count=${limit} 2>/dev/null || true`,
        { encoding: "utf8", timeout: 10_000, cwd },
      );
      return result.trim() || `No matches found for "${args.query}".`;
    } catch {
      return `Search failed for "${args.query}".`;
    }
  },

  async read_file_content(args, context) {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    try {
      const cwd = await resolveToolCwd(context);
      const fullPath = resolve(cwd, args.filePath);
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

  async list_directory(args, context) {
    const { readdirSync, statSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    try {
      const cwd = await resolveToolCwd(context);
      const dir = resolve(cwd, args.path || ".");
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

  async get_workspace_context(args, context) {
    return await getWorkspaceContextSummary(context);
  },

  async query_live_view(args, context) {
    const sessionId = String(context?.sessionId || "").trim();
    if (!sessionId) {
      return "{RESPONSE}: Live vision query requires an active session.";
    }
    const query = String(args?.query || "").trim();
    if (!query) {
      return "{RESPONSE}: Please provide a vision query.";
    }
    const state = getVisionSessionState(sessionId);
    const frameDataUrl = String(state?.lastFrameDataUrl || "").trim();
    if (!frameDataUrl) {
      return "{RESPONSE}: No live frame is available yet. Start camera/screen sharing and try again.";
    }
    try {
      const { analyzeVisionFrame } = await import("./voice-relay.mjs");
      const analysis = await analyzeVisionFrame(frameDataUrl, {
        source: String(state?.lastFrameSource || "screen").trim() || "screen",
        context: {
          sessionId,
          executor: context?.executor,
          mode: context?.mode,
          model: context?.model,
        },
        prompt: query,
      });
      const summary = String(analysis?.summary || "").trim();
      if (!summary) return "{RESPONSE}: Vision model returned no summary.";
      return `{RESPONSE}: ${summary}`;
    } catch (err) {
      return `{RESPONSE}: Live vision query failed: ${String(err?.message || "unknown error")}`;
    }
  },

  async get_recent_logs(args, context) {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { resolve, join } = await import("node:path");
    try {
      const cwd = await resolveToolCwd(context);
      const logsDir = resolve(cwd, "logs");
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

  async search_tasks(args) {
    const query = String(args.query || "").trim().toLowerCase();
    if (!query) return "Search query is required.";
    const limit = args.limit || 20;
    const tasks = await listTasksAcrossProjects({}, { status: undefined });
    const matches = (Array.isArray(tasks) ? tasks : []).filter((t) => {
      const text = `${t.title || ""} ${t.body || t.description || ""} ${(t.labels || []).join(" ")}`.toLowerCase();
      return text.includes(query);
    });
    return {
      query: args.query,
      count: Math.min(matches.length, limit),
      total: matches.length,
      tasks: matches.slice(0, limit).map((t) => ({
        id: t.id || t.number,
        title: t.title,
        status: t.status,
        labels: t.labels || [],
      })),
    };
  },

  async get_task_stats() {
    const tasks = await listTasksAcrossProjects({}, { status: undefined });
    const all = Array.isArray(tasks) ? tasks : [];
    const byStatus = {};
    for (const t of all) {
      const s = t.status || "unknown";
      byStatus[s] = (byStatus[s] || 0) + 1;
    }
    return {
      total: all.length,
      byStatus,
      backlog: byStatus.todo || 0,
      inProgress: byStatus.inprogress || 0,
      inReview: byStatus.inreview || 0,
      done: byStatus.done || 0,
    };
  },

  async delete_task(args) {
    const { adapter } = await resolveKanbanContext();
    const taskId = String(args.taskId || "").trim();
    if (!taskId) return "taskId is required.";
    await adapter.deleteTask(taskId);
    return `Task ${taskId} deleted.`;
  },

  async comment_on_task(args) {
    const { adapter } = await resolveKanbanContext();
    const taskId = String(args.taskId || "").trim();
    const body = String(args.body || "").trim();
    if (!taskId) return "taskId is required.";
    if (!body) return "comment body is required.";
    await adapter.addComment(taskId, body);
    return `Comment added to task ${taskId}.`;
  },

  async set_agent_mode(args) {
    const rawMode = String(args.mode || "").trim().toLowerCase();
    const VALID = new Set(["ask", "agent", "plan"]);
    if (!VALID.has(rawMode)) return `Invalid mode: ${rawMode}. Use: ask, agent, plan`;
    const previous = getAgentMode();
    setAgentMode(rawMode);
    return `Agent mode changed from ${previous} to ${rawMode}.`;
  },

  async list_workflows() {
    try {
      const wf = await import("./workflow-templates.mjs");
      const templates = wf.listTemplates ? wf.listTemplates() : [];
      return {
        count: templates.length,
        templates: templates.map((t) => ({
          id: t.id,
          name: t.name || t.id,
          description: (t.description || "").slice(0, 100),
        })),
      };
    } catch {
      return { count: 0, templates: [], error: "Workflow templates not available." };
    }
  },

  async list_skills() {
    try {
      const skills = await import("./bosun-skills.mjs");
      const builtins = skills.BUILTIN_SKILLS || [];
      return {
        count: builtins.length,
        skills: builtins.map((s) => ({
          filename: s.filename,
          title: s.title,
          tags: s.tags || [],
        })),
      };
    } catch {
      return { count: 0, skills: [] };
    }
  },

  async list_prompts() {
    try {
      const prompts = await import("./agent-prompts.mjs");
      const defs = prompts.getAgentPromptDefinitions
        ? prompts.getAgentPromptDefinitions()
        : prompts.AGENT_PROMPT_DEFINITIONS || [];
      return {
        count: defs.length,
        prompts: defs.map((d) => ({
          key: d.key,
          filename: d.filename,
          description: (d.description || "").slice(0, 80),
        })),
      };
    } catch {
      return { count: 0, prompts: [] };
    }
  },

  async dispatch_action(args, context) {
    const action = String(args.action || "").trim();
    if (!action) return { error: "action name is required" };
    try {
      const { dispatchVoiceAction } = await import("./voice-action-dispatcher.mjs");
      const result = await dispatchVoiceAction(
        { action, params: args.params || {} },
        context,
      );
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /**
   * Generic MCP gateway — routes arbitrary MCP tool calls through the agent
   * rather than requiring a bespoke voice-tool wrapper for each MCP operation.
   *
   * The approach (inspired by claude-phone's structured prompting):
   *   • Build a precise, structured prompt asking the agent to invoke the tool
   *   • Request a short spoken confirmation as the VOICE_RESPONSE: reply
   *   • Fall back gracefully if the agent can't find the tool
   *
   * This deliberately reuses `ask_agent_context` so MCP calls get the same
   * 10 s timeout + auto-delegation path on failure.
   */
  async invoke_mcp_tool(args, context) {
    const tool = String(args.tool || "").trim();
    if (!tool) return "{RESPONSE}: tool name is required.";
    const server = String(args.server || "").trim();
    const mcpArgs = args.args && typeof args.args === "object" ? args.args : {};
    const toolRef = server ? `${server} MCP server's \"${tool}\" tool` : `\"${tool}\" MCP tool`;
    const argsJson = Object.keys(mcpArgs).length
      ? `\n\nArguments:\n${JSON.stringify(mcpArgs, null, 2)}`
      : "";
    const taskPrompt = `Invoke the ${toolRef} right now.${argsJson}\n\nAfter invoking the tool, respond with:\nVOICE_RESPONSE: [1-sentence natural language confirmation of what happened]`;
    return TOOL_HANDLERS.ask_agent_context({ message: taskPrompt, mode: "instant" }, context);
  },

  /**
   * Pre-warm the agent with a quick repo overview so follow-up codebase
   * questions benefit from cached context instead of a cold-start lookup.
   *
   * Fire-and-forget: returns immediately and loads in the background.
   */
  async warm_codebase_context(args, context) {
    const cwd = await resolveToolCwd(context);
    let topLevel = [];
    try {
      const { readdirSync } = await import("node:fs");
      topLevel = readdirSync(cwd)
        .filter((n) => !n.startsWith(".") && n !== "node_modules")
        .slice(0, 25);
    } catch {
      // best effort
    }
    const warmPrompt = `You are being pre-loaded with workspace context for an upcoming voice session.\nTop-level items in the project: ${topLevel.join(", ") || "(unknown)"}\nBriefly orient yourself to the project structure so you can answer questions quickly.`;
    TOOL_HANDLERS.ask_agent_context({ message: warmPrompt, mode: "instant" }, context).catch(() => {});
    return "{RESPONSE}: Codebase context pre-loading started in the background.";
  },
};

export { TOOL_DEFS as VOICE_TOOLS };

/**
 * Convenience export so voice-relay.mjs (and future callers) can trigger a
 * context warm-up at voice session open without importing internal handlers.
 *
 * @param {object} context — voice call context ({ sessionId, executor, ... })
 * @returns {Promise<void>}
 */
export async function warmCodebaseContext(context = {}) {
  await TOOL_HANDLERS.warm_codebase_context({}, context).catch(() => {});
}
