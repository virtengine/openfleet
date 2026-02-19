/**
 * claude-shell.mjs - Persistent Claude agent adapter for openfleet.
 *
 * Uses the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) to run a
 * long-lived session with steering support via streaming input mode.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveRepoRoot } from "./repo-root.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

// ── Configuration ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 min for agentic tasks
const STATE_FILE = resolve(__dirname, "logs", "claude-shell-state.json");
const REPO_ROOT = resolveRepoRoot();

// ── State ───────────────────────────────────────────────────────────────────

let queryFn = null;
let activeQuery = null;
let activeQueue = null;
let activeTurn = false;
let activeSessionId = null;
let turnCount = 0;

// Track tool use IDs for mapping tool results to start events.
const toolUseById = new Map();

// ── Helpers ─────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString();
}

function normalizeList(value) {
  if (!value) return null;
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim());
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function envFlagEnabled(value) {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  return ["1", "true", "yes", "on", "y"].includes(raw);
}

function resolveClaudeTransport() {
  const raw = String(process.env.CLAUDE_TRANSPORT || "auto")
    .trim()
    .toLowerCase();
  if (["auto", "sdk", "cli"].includes(raw)) {
    return raw;
  }
  console.warn(
    `[claude-shell] invalid CLAUDE_TRANSPORT='${raw}', defaulting to 'auto'`,
  );
  return "auto";
}

function getToolName(block) {
  return block?.name || block?.tool_name || block?.toolName || "";
}

function getToolUseId(block) {
  return block?.tool_use_id || block?.toolUseId || block?.id || null;
}

function extractTextBlocks(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function extractResultText(block) {
  if (!block) return "";
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .map((c) => (typeof c === "string" ? c : c?.text || ""))
      .join("");
  }
  return "";
}

function formatEvent(event) {
  if (!event) return null;
  if (
    event.type === "item.started" &&
    event.item?.type === "command_execution"
  ) {
    return `⚡ Running: \`${event.item.command}\``;
  }
  if (
    event.type === "item.completed" &&
    event.item?.type === "command_execution"
  ) {
    const status = event.item.exit_code === 0 ? "✅" : "❌";
    return `${status} Command done: \`${event.item.command}\``;
  }
  if (event.type === "item.started" && event.item?.type === "mcp_tool_call") {
    return `🔌 MCP [${event.item.server}/${event.item.tool}]`;
  }
  if (event.type === "item.completed" && event.item?.type === "mcp_tool_call") {
    const status = event.item.status === "completed" ? "✅" : "❌";
    return `${status} MCP [${event.item.server}/${event.item.tool}]`;
  }
  if (event.type === "item.started" && event.item?.type === "web_search") {
    return `🔍 Searching: ${event.item.query || ""}`;
  }
  if (event.type === "item.updated" && event.item?.type === "reasoning") {
    return event.item.text ? `💭 ${event.item.text.slice(0, 300)}` : null;
  }
  return null;
}

function makeUserMessage(text) {
  return {
    type: "user",
    session_id: activeSessionId || "",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
  };
}

function createMessageQueue() {
  const queue = [];
  let resolver = null;
  let closed = false;

  async function* iterator() {
    while (true) {
      if (queue.length > 0) {
        yield queue.shift();
        continue;
      }
      if (closed) return;
      await new Promise((resolve) => {
        resolver = resolve;
      });
      resolver = null;
    }
  }

  function push(message) {
    if (closed) return false;
    queue.push(message);
    if (resolver) {
      resolver();
      resolver = null;
    }
    return true;
  }

  function close() {
    closed = true;
    if (resolver) {
      resolver();
      resolver = null;
    }
  }

  function size() {
    return queue.length;
  }

  return { iterator, push, close, size };
}

/**
 * Detect Claude API key from multiple sources (auth passthrough).
 * Priority: ENV > CLI config > undefined (SDK will prompt).
 */
function detectClaudeAuth() {
  // 1. Direct API key env vars (highest priority)
  const envKey =
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    process.env.CLAUDE_KEY;
  if (envKey) {
    console.log("[claude-shell] using API key from environment");
    return envKey;
  }

  // 2. Try to read from Claude CLI config (~/.config/claude/)
  try {
    const configPath = resolve(homedir(), ".config", "claude", "config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      if (config.api_key) {
        console.log("[claude-shell] using API key from CLI config");
        return config.api_key;
      }
    }
  } catch {
    // Config not found or invalid
  }

  console.log("[claude-shell] no pre-auth detected, SDK may prompt");
  return undefined;
}

function buildOptions() {
  const options = {
    cwd: REPO_ROOT,
    settingSources: ["user", "project"],
    permissionMode: process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions",
  };

  // Auth passthrough: detect API key from multiple sources
  const apiKey = detectClaudeAuth();
  if (apiKey) {
    options.apiKey = apiKey;
  }

  const model =
    process.env.CLAUDE_MODEL ||
    process.env.CLAUDE_CODE_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    "";
  if (model) options.model = model;

  const maxTurns = Number(process.env.CLAUDE_MAX_TURNS || "0");
  if (Number.isFinite(maxTurns) && maxTurns > 0) {
    options.maxTurns = maxTurns;
  }

  const includePartial = envFlagEnabled(process.env.CLAUDE_INCLUDE_PARTIAL);
  if (includePartial) {
    options.includePartialMessages = true;
  }

  const allowedTools = normalizeList(process.env.CLAUDE_ALLOWED_TOOLS);
  if (allowedTools && allowedTools.length > 0) {
    options.allowedTools = allowedTools;
  }

  return options;
}

function buildCommandForTool(name, input) {
  const toolName = String(name || "");
  if (toolName === "Bash") {
    return input?.command || input?.cmd || input?.script || "(bash)";
  }
  if (toolName === "Read") {
    const path = input?.path || input?.file_path || input?.file || "";
    return path ? `cat ${path}` : "cat";
  }
  if (toolName === "Grep") {
    const pattern = input?.pattern || input?.query || "";
    const path = input?.path || input?.file_path || "";
    if (pattern && path) return `rg \"${pattern}\" ${path}`;
    if (pattern) return `rg \"${pattern}\"`;
    return "rg";
  }
  if (toolName === "Glob") {
    const pattern = input?.pattern || input?.path || "";
    return pattern ? `ls ${pattern}` : "ls";
  }
  if (toolName === "WebSearch") {
    return input?.query || "";
  }
  if (toolName.startsWith("mcp__")) {
    return toolName;
  }
  return toolName || "tool";
}

function parseMcpName(name) {
  if (!name.startsWith("mcp__")) return null;
  const parts = name.split("__").filter(Boolean);
  if (parts.length < 3) return null;
  return { server: parts[1], tool: parts.slice(2).join("__") };
}

function buildToolStartEvent(toolName, input) {
  if (!toolName) return null;
  if (toolName === "WebSearch") {
    return {
      type: "item.started",
      item: { type: "web_search", query: input?.query || "" },
    };
  }
  if (toolName.startsWith("mcp__")) {
    const parsed = parseMcpName(toolName);
    if (!parsed) return null;
    return {
      type: "item.started",
      item: { type: "mcp_tool_call", server: parsed.server, tool: parsed.tool },
    };
  }

  const command = buildCommandForTool(toolName, input);
  if (!command) return null;
  return {
    type: "item.started",
    item: { type: "command_execution", command },
  };
}

function buildToolResultEvent(toolName, toolInput, resultBlock) {
  if (!toolName) return null;
  const isError = !!resultBlock?.is_error;

  if (toolName.startsWith("mcp__")) {
    const parsed = parseMcpName(toolName);
    if (!parsed) return null;
    return {
      type: "item.completed",
      item: {
        type: "mcp_tool_call",
        server: parsed.server,
        tool: parsed.tool,
        status: isError ? "failed" : "completed",
      },
    };
  }

  if (toolName === "Write" || toolName === "Edit") {
    const path =
      toolInput?.path ||
      toolInput?.file_path ||
      toolInput?.file ||
      toolInput?.filename ||
      "";
    if (!path) return null;
    return {
      type: "item.completed",
      item: {
        type: "file_change",
        changes: [
          {
            path,
            kind: toolName === "Write" ? "add" : "update",
            additions: 0,
            deletions: 0,
          },
        ],
      },
    };
  }

  const command = buildCommandForTool(toolName, toolInput);
  if (!command) return null;
  return {
    type: "item.completed",
    item: {
      type: "command_execution",
      command,
      exit_code: isError ? 1 : 0,
      aggregated_output: extractResultText(resultBlock),
    },
  };
}

// ── SDK Loading ─────────────────────────────────────────────────────────────

async function loadClaudeSdk() {
  if (queryFn) return queryFn;
  const transport = resolveClaudeTransport();
  if (transport === "cli") {
    console.warn(
      "[claude-shell] CLAUDE_TRANSPORT=cli uses SDK compatibility mode with session-id resume",
    );
  }
  try {
    const mod = await import("@anthropic-ai/claude-agent-sdk");
    queryFn = mod.query;
    if (!queryFn) {
      throw new Error("query() not found in Claude SDK");
    }
    console.log("[claude-shell] SDK loaded successfully");
    return queryFn;
  } catch (err) {
    console.error(`[claude-shell] failed to load SDK: ${err.message}`);
    return null;
  }
}

// ── State Persistence ───────────────────────────────────────────────────────

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    activeSessionId = data.sessionId || null;
    turnCount = data.turnCount || 0;
    console.log(
      `[claude-shell] loaded state: sessionId=${activeSessionId}, turns=${turnCount}`,
    );
  } catch {
    activeSessionId = null;
    turnCount = 0;
  }
}

async function saveState() {
  try {
    await mkdir(resolve(__dirname, "logs"), { recursive: true });
    await writeFile(
      STATE_FILE,
      JSON.stringify(
        {
          sessionId: activeSessionId,
          turnCount,
          updatedAt: timestamp(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    console.warn(`[claude-shell] failed to save state: ${err.message}`);
  }
}

function buildPrompt(userMessage, statusData) {
  if (!statusData) {
    return `# YOUR TASK — EXECUTE NOW\n\n${userMessage}\n\n---\nDo NOT respond with \"Ready\" or ask what to do. EXECUTE this task. Read files, run commands, produce detailed output.`;
  }
  const statusSnippet = JSON.stringify(statusData, null, 2).slice(0, 2000);
  return `[Orchestrator Status]\n\`\`\`json\n${statusSnippet}\n\`\`\`\n\n# YOUR TASK — EXECUTE NOW\n\n${userMessage}\n\n---\nDo NOT respond with \"Ready\" or ask what to do. EXECUTE this task. Read files, run commands, produce detailed output.`;
}

// ── Main Execution ─────────────────────────────────────────────────────────

/**
 * Send a message to the Claude agent and stream events back.
 *
 * @param {string} userMessage
 * @param {object} options
 * @param {function} options.onEvent
 * @param {object} options.statusData
 * @param {number} options.timeoutMs
 * @param {boolean} options.sendRawEvents
 * @param {AbortController} options.abortController
 * @returns {Promise<{finalResponse: string, items: Array, usage: object|null}>}
 */
export async function execClaudePrompt(userMessage, options = {}) {
  const {
    onEvent = null,
    statusData = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sendRawEvents = false,
    abortController = null,
  } = options;

  if (activeTurn) {
    return {
      finalResponse:
        "⏳ Agent is still executing a previous task. Please wait.",
      items: [],
      usage: null,
    };
  }

  const query = await loadClaudeSdk();
  if (!query) {
    return {
      finalResponse: "❌ Claude SDK not available.",
      items: [],
      usage: null,
    };
  }

  activeTurn = true;
  toolUseById.clear();

  const transport = resolveClaudeTransport();
  const shouldResume = transport === "cli";

  // Fresh-session mode (default): avoid token overflow from accumulated context.
  // CLI compatibility mode: keep and reuse session_id for continuation.
  if (activeSessionId && !shouldResume) {
    console.log(
      `[claude-shell] discarding previous session ${activeSessionId} — creating fresh session per task`,
    );
    activeSessionId = null;
  } else if (activeSessionId && shouldResume) {
    console.log(`[claude-shell] resuming session ${activeSessionId}`);
  }

  const controller = abortController || new AbortController();
  let abortReason = null;
  const onAbort = () => {
    abortReason = controller.signal.reason || "aborted";
    try {
      if (activeQuery?.interrupt) {
        void activeQuery.interrupt();
      }
    } catch {
      /* best effort */
    }
    if (activeQueue) {
      activeQueue.close();
    }
  };
  controller.signal.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => {
    try {
      controller.abort("timeout");
    } catch {
      /* noop */
    }
  }, timeoutMs);

  let finalResponse = "";
  const allItems = [];

  try {
    const queue = createMessageQueue();
    activeQueue = queue;
    queue.push(makeUserMessage(buildPrompt(userMessage, statusData)));

    const optionsPayload = buildOptions();

    activeQuery = query({
      prompt: queue.iterator(),
      options: optionsPayload,
    });

    for await (const message of activeQuery) {
      const sessionId = message?.session_id || message?.sessionId;
      if (sessionId && sessionId !== activeSessionId) {
        activeSessionId = sessionId;
        await saveState();
      }

      const contentBlocks = message?.message?.content || message?.content || [];

      if (message?.type === "assistant" && Array.isArray(contentBlocks)) {
        const text = extractTextBlocks(contentBlocks);
        if (text) {
          finalResponse += text + "\n";
        }

        for (const block of contentBlocks) {
          if (!block) continue;

          if (block.type === "thinking" && block.text) {
            const event = {
              type: "item.updated",
              item: { type: "reasoning", text: block.text },
            };
            if (onEvent) {
              const formatted = formatEvent(event);
              if (formatted || sendRawEvents) {
                await onEvent(formatted, event);
              }
            }
            continue;
          }

          if (block.type === "tool_use") {
            const toolName = getToolName(block);
            const toolId = getToolUseId(block);
            if (toolId) {
              toolUseById.set(toolId, { name: toolName, input: block.input });
            }
            const event = buildToolStartEvent(toolName, block.input);
            if (event && onEvent) {
              const formatted = formatEvent(event);
              if (formatted || sendRawEvents) {
                await onEvent(formatted, event);
              }
            }
            continue;
          }

          if (block.type === "tool_result") {
            const toolId = block.tool_use_id || block.toolUseId;
            const toolData = toolUseById.get(toolId) || {};
            const event = buildToolResultEvent(
              toolData.name,
              toolData.input,
              block,
            );
            if (event) {
              allItems.push(event.item);
              if (onEvent) {
                const formatted = formatEvent(event);
                if (formatted || sendRawEvents) {
                  await onEvent(formatted, event);
                }
              }
            }
            continue;
          }
        }
      }

      if (message?.type === "result" && message?.result) {
        if (!finalResponse) {
          finalResponse = message.result;
        }
      }
    }

    clearTimeout(timer);
    turnCount += 1;
    await saveState();

    return {
      finalResponse:
        finalResponse.trim() || "(Agent completed with no text output)",
      items: allItems,
      usage: null,
    };
  } catch (err) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      const reason = abortReason || controller.signal.reason;
      const msg =
        reason === "user_stop"
          ? "🛑 Agent stopped by user."
          : `⏱️ Agent timed out after ${timeoutMs / 1000}s`;
      return { finalResponse: msg, items: [], usage: null };
    }
    const message = err?.message || String(err || "unknown error");
    return {
      finalResponse: `❌ Claude agent failed: ${message}`,
      items: [],
      usage: null,
    };
  } finally {
    if (activeQueue) activeQueue.close();
    activeQueue = null;
    activeQuery = null;
    activeTurn = false;
  }
}

/**
 * Try to steer an in-flight agent without stopping the run.
 */
export async function steerClaudePrompt(message) {
  if (!activeTurn || !activeQueue) {
    return { ok: false, reason: "no_active_session" };
  }
  const ok = activeQueue.push(makeUserMessage(message));
  if (ok) {
    return { ok: true, mode: "enqueue" };
  }
  return { ok: false, reason: "queue_closed" };
}

/**
 * Check if a turn is currently in flight.
 */
export function isClaudeBusy() {
  return !!activeTurn;
}

/**
 * Get session info for display.
 */
export function getSessionInfo() {
  return {
    sessionId: activeSessionId,
    turnCount,
    isActive: !!activeQuery,
    isBusy: !!activeTurn,
  };
}

/**
 * Reset the session — starts a fresh conversation.
 */
export async function resetClaudeSession() {
  activeQuery = null;
  activeQueue = null;
  activeSessionId = null;
  turnCount = 0;
  activeTurn = false;
  await saveState();
  console.log("[claude-shell] session reset");
}

// ── Initialization ──────────────────────────────────────────────────────────

export async function initClaudeShell() {
  await loadState();
  const loaded = await loadClaudeSdk();
  if (loaded) {
    console.log("[claude-shell] initialised with Claude SDK");
  } else {
    console.warn(
      "[claude-shell] initialised WITHOUT Claude SDK — agent will not work",
    );
  }
}
