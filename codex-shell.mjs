/**
 * codex-shell.mjs — Persistent Codex agent for openfleet.
 *
 * Uses the Codex SDK (@openai/codex-sdk) to maintain a REAL persistent thread
 * with multi-turn conversation, tool use (shell, file I/O, MCP), and streaming.
 *
 * This is NOT a chatbot. Each user message dispatches a full agentic turn where
 * Codex can read files, run commands, call MCP tools, and produce structured
 * output — all streamed back in real-time via ThreadEvent callbacks.
 *
 * Thread persistence: The SDK stores threads in ~/.codex/sessions. We save the
 * thread_id so we can resume the same conversation across restarts.
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentSdkConfig } from "./agent-sdk.mjs";
import { resolveRepoRoot } from "./repo-root.mjs";
import { resolveCodexProfileRuntime } from "./codex-model-profiles.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

// ── Configuration ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000; // 60 min for agentic tasks (matches Azure stream timeout)
const STATE_FILE = resolve(__dirname, "logs", "codex-shell-state.json");
const SESSIONS_DIR = resolve(__dirname, "logs", "sessions");
const MAX_PERSISTENT_TURNS = 50;
const REPO_ROOT = resolveRepoRoot();

// ── State ────────────────────────────────────────────────────────────────────

let CodexClass = null; // The Codex class from SDK
let codexInstance = null; // Singleton Codex instance
let activeThread = null; // Current persistent Thread
let activeThreadId = null; // Thread ID for resume
let activeTurn = null; // Whether a turn is in-flight
let turnCount = 0; // Number of turns in this thread
let currentSessionId = null; // Active session identifier
let codexRuntimeCaps = {
  hasSteeringApi: false,
  steeringMethod: null,
};
let agentSdk = resolveAgentSdkConfig();

// ── Helpers ──────────────────────────────────────────────────────────────────

function timestamp() {
  return new Date().toISOString();
}

function resolveCodexTransport() {
  const raw = String(process.env.CODEX_TRANSPORT || "auto")
    .trim()
    .toLowerCase();
  if (["auto", "sdk", "cli"].includes(raw)) {
    return raw;
  }
  console.warn(
    `[codex-shell] invalid CODEX_TRANSPORT='${raw}', defaulting to 'auto'`,
  );
  return "auto";
}

// ── SDK Loading ──────────────────────────────────────────────────────────────

async function loadCodexSdk() {
  agentSdk = resolveAgentSdkConfig({ reload: true });
  if (agentSdk.primary !== "codex") {
    console.warn(
      `[codex-shell] agent_sdk.primary=${agentSdk.primary} — Codex SDK disabled`,
    );
    return null;
  }
  const transport = resolveCodexTransport();
  if (transport === "cli") {
    console.warn(
      "[codex-shell] CODEX_TRANSPORT=cli uses SDK compatibility mode with persistent thread resume",
    );
  }
  if (CodexClass) return CodexClass;
  try {
    const mod = await import("@openai/codex-sdk");
    CodexClass = mod.Codex;
    console.log("[codex-shell] SDK loaded successfully");
    return CodexClass;
  } catch (err) {
    console.error(`[codex-shell] failed to load SDK: ${err.message}`);
    return null;
  }
}

// ── State Persistence ────────────────────────────────────────────────────────

async function loadState() {
  try {
    const raw = await readFile(STATE_FILE, "utf8");
    const data = JSON.parse(raw);
    activeThreadId = data.threadId || null;
    turnCount = data.turnCount || 0;
    currentSessionId = data.currentSessionId || null;
    console.log(
      `[codex-shell] loaded state: threadId=${activeThreadId}, turns=${turnCount}, session=${currentSessionId}`,
    );
  } catch {
    activeThreadId = null;
    turnCount = 0;
    currentSessionId = null;
  }
}

async function saveState() {
  try {
    await mkdir(resolve(__dirname, "logs"), { recursive: true });
    await writeFile(
      STATE_FILE,
      JSON.stringify(
        {
          threadId: activeThreadId,
          turnCount,
          currentSessionId,
          updatedAt: timestamp(),
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch (err) {
    console.warn(`[codex-shell] failed to save state: ${err.message}`);
  }
}

// ── Session Persistence ──────────────────────────────────────────────────────

function sessionFilePath(sessionId) {
  return resolve(SESSIONS_DIR, `${sessionId}.json`);
}

async function loadSessionData(sessionId) {
  try {
    const raw = await readFile(sessionFilePath(sessionId), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveSessionData(sessionId, data) {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    await writeFile(sessionFilePath(sessionId), JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.warn(`[codex-shell] failed to save session ${sessionId}: ${err.message}`);
  }
}

async function saveCurrentSession() {
  if (!currentSessionId) return;
  await saveSessionData(currentSessionId, {
    threadId: activeThreadId,
    turnCount,
    createdAt: (await loadSessionData(currentSessionId))?.createdAt || timestamp(),
    lastActiveAt: timestamp(),
  });
}

async function loadSession(sessionId) {
  // Save current session before switching
  await saveCurrentSession();
  const data = await loadSessionData(sessionId);
  if (data) {
    activeThreadId = data.threadId || null;
    turnCount = data.turnCount || 0;
    activeThread = null; // will be re-created/resumed via getThread()
    currentSessionId = sessionId;
    console.log(`[codex-shell] loaded session ${sessionId}: threadId=${activeThreadId}, turns=${turnCount}`);
  } else {
    activeThread = null;
    activeThreadId = null;
    turnCount = 0;
    currentSessionId = sessionId;
    console.log(`[codex-shell] created new session ${sessionId}`);
  }
  await saveState();
}

// ── Thread Management ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `# AGENT DIRECTIVE — EXECUTE IMMEDIATELY

You are an autonomous AI coding agent deployed inside openfleet.
You are NOT a chatbot. You are NOT waiting for input. You EXECUTE tasks.

CRITICAL RULES:
1. NEVER respond with "Ready" or "What would you like me to do?" — you already have your task below.
2. NEVER ask clarifying questions — infer intent and take action.
3. DO the work. Read files, run commands, analyze code, write output.
4. Show your work as you go — print what you're reading, what you found, what you're doing next.
5. Produce DETAILED, STRUCTURED output with your findings and actions taken.
6. If the task involves analysis, actually READ the files and show what you found.
7. If the task involves code changes, actually MAKE the changes.
8. Think step-by-step, show your reasoning, then act.

You have FULL ACCESS to:
- The target repository checked out for this openfleet instance
- Shell: git, gh, node, go, make, and all system commands (pwsh optional)
- File read/write: read any file, create/edit any file
- MCP servers configured in this environment (availability varies)

Key files:
  ${REPO_ROOT} — Repository root
  .cache/ve-orchestrator-status.json — Live status data (if enabled)
  scripts/openfleet/logs/ — Monitor logs (if available)
  AGENTS.md — Repo guide for agents
`;

const THREAD_OPTIONS = {
  sandboxMode: process.env.CODEX_SANDBOX || "workspace-write",
  workingDirectory: REPO_ROOT,
  skipGitRepoCheck: true,
  webSearchMode: "live",
  approvalPolicy: "never",
  // Note: sub-agent features (child_agents_md, collab, memory_tool, etc.)
  // are configured via ~/.codex/config.toml [features] section, not SDK ThreadOptions.
  // codex-config.mjs ensureFeatureFlags() handles this during setup.
};

/**
 * Get or create a thread.
 * Uses fresh-thread mode by default to avoid context bloat.
 * In CLI transport compatibility mode, reuse persisted thread IDs when possible.
 */
async function getThread() {
  if (activeThread) return activeThread;

  const { env: resolvedEnv } = resolveCodexProfileRuntime(process.env);
  Object.assign(process.env, resolvedEnv);

  if (!codexInstance) {
    const Cls = await loadCodexSdk();
    if (!Cls) throw new Error("Codex SDK not available");
    // Pass feature overrides via --config so they apply even if config.toml
    // hasn't been patched by codex-config.mjs yet.
    codexInstance = new Cls({
      config: {
        features: {
          child_agents_md: true,
          collab: true,
          memory_tool: true,
          undo: true,
          steer: true,
        },
      },
    });
  }

  const transport = resolveCodexTransport();
  const shouldResume = transport === "cli";

  if (activeThreadId && shouldResume) {
    if (typeof codexInstance.resumeThread === "function") {
      try {
        activeThread = codexInstance.resumeThread(
          activeThreadId,
          THREAD_OPTIONS,
        );
        if (activeThread) {
          detectThreadCapabilities(activeThread);
          console.log(`[codex-shell] resumed thread ${activeThreadId}`);
          return activeThread;
        }
      } catch (err) {
        console.warn(
          `[codex-shell] failed to resume thread ${activeThreadId}: ${err.message} — starting fresh`,
        );
      }
    } else {
      console.warn(
        "[codex-shell] SDK does not expose resumeThread(); starting fresh thread",
      );
    }
    activeThreadId = null;
  }

  // Fresh-thread mode (default): avoid token overflow from long-running reuse.
  if (activeThreadId && !shouldResume) {
    console.log(
      `[codex-shell] discarding previous thread ${activeThreadId} — creating fresh thread per task`,
    );
    activeThreadId = null;
  }

  // Start a new thread with the system prompt as the first turn
  activeThread = codexInstance.startThread(THREAD_OPTIONS);
  detectThreadCapabilities(activeThread);

  // Prime the thread with the system prompt so subsequent turns have context
  try {
    await activeThread.run(SYSTEM_PROMPT);
    // Capture the thread ID from the prime turn
    if (activeThread.id) {
      activeThreadId = activeThread.id;
      await saveState();
      console.log(`[codex-shell] new thread started: ${activeThreadId}`);
    }
  } catch (err) {
    console.warn(`[codex-shell] prime turn failed: ${err.message}`);
    // Thread is still usable even if prime fails
  }

  return activeThread;
}

function detectThreadCapabilities(thread) {
  if (!thread || typeof thread !== "object") {
    codexRuntimeCaps = { hasSteeringApi: false, steeringMethod: null };
    return codexRuntimeCaps;
  }
  const candidates = ["steer", "sendSteer", "steering"];
  const method =
    candidates.find((name) => typeof thread?.[name] === "function") || null;
  codexRuntimeCaps = {
    hasSteeringApi: !!method,
    steeringMethod: method,
  };
  return codexRuntimeCaps;
}

// ── Event Formatting ─────────────────────────────────────────────────────────

/**
 * Format a ThreadEvent into a human-readable string for Telegram streaming.
 * Returns null for events that shouldn't be sent.
 */
function formatEvent(event) {
  switch (event.type) {
    case "item.started": {
      const item = event.item;
      switch (item.type) {
        case "command_execution":
          return `⚡ Running: \`${item.command}\``;
        case "file_change":
          return null; // wait for completed
        case "mcp_tool_call":
          return `🔌 MCP [${item.server}]: ${item.tool}`;
        case "reasoning":
          return item.text ? `💭 ${item.text.slice(0, 300)}` : null;
        case "agent_message":
          return null; // wait for completed for full text
        case "todo_list":
          if (item.items && item.items.length > 0) {
            const todoLines = item.items.map(
              (t) => `  ${t.completed ? "✅" : "⬜"} ${t.text}`,
            );
            return `📋 Plan:\n${todoLines.join("\n")}`;
          }
          return null;
        case "web_search":
          return `🔍 Searching: ${item.query}`;
        default:
          return null;
      }
    }

    case "item.completed": {
      const item = event.item;
      switch (item.type) {
        case "command_execution": {
          const status = item.exit_code === 0 ? "✅" : "❌";
          const output = item.aggregated_output
            ? `\n${item.aggregated_output.slice(-500)}`
            : "";
          return `${status} Command done: \`${item.command}\` (exit ${item.exit_code ?? "?"})${output}`;
        }
        case "file_change": {
          if (item.changes && item.changes.length > 0) {
            const fileLines = item.changes.map(
              (c) =>
                `  ${c.kind === "add" ? "➕" : c.kind === "delete" ? "🗑️" : "✏️"} ${c.path}`,
            );
            return `📁 Files changed:\n${fileLines.join("\n")}`;
          }
          return null;
        }
        case "agent_message":
          return item.text || null;
        case "mcp_tool_call": {
          const status = item.status === "completed" ? "✅" : "❌";
          const resultInfo = item.error
            ? `Error: ${item.error.message}`
            : "done";
          return `${status} MCP [${item.server}/${item.tool}]: ${resultInfo}`;
        }
        case "todo_list": {
          if (item.items && item.items.length > 0) {
            const todoLines = item.items.map(
              (t) => `  ${t.completed ? "✅" : "⬜"} ${t.text}`,
            );
            return `📋 Updated plan:\n${todoLines.join("\n")}`;
          }
          return null;
        }
        default:
          return null;
      }
    }

    case "item.updated": {
      const item = event.item;
      // Stream partial reasoning and command output
      if (item.type === "reasoning" && item.text) {
        return `💭 ${item.text.slice(0, 300)}`;
      }
      if (item.type === "todo_list" && item.items) {
        const todoLines = item.items.map(
          (t) => `  ${t.completed ? "✅" : "⬜"} ${t.text}`,
        );
        return `📋 Plan update:\n${todoLines.join("\n")}`;
      }
      return null;
    }

    case "turn.completed":
      return null; // handled by caller
    case "turn.failed":
      return `❌ Turn failed: ${event.error?.message || "unknown error"}`;
    case "error":
      return `❌ Error: ${event.message}`;
    default:
      return null;
  }
}

function isRecoverableThreadError(err) {
  const message = err?.message || String(err || "");
  const lower = message.toLowerCase();
  return (
    lower.includes("invalid_encrypted_content") ||
    lower.includes("could not be verified") ||
    lower.includes("state db missing rollout path") ||
    lower.includes("rollout path") ||
    lower.includes("tool call must have a tool call id") ||
    lower.includes("tool_call_id") ||
    (lower.includes("400") && lower.includes("tool call"))
  );
}

// ── Main Execution ───────────────────────────────────────────────────────────

/**
 * Send a message to the Codex agent and stream events back.
 *
 * @param {string} userMessage - The user's message/task
 * @param {object} options
 * @param {function} options.onEvent - Callback for each formatted event string
 * @param {object} options.statusData - Current orchestrator status (for context)
 * @param {number} options.timeoutMs - Timeout in ms
 * @returns {Promise<{finalResponse: string, items: Array, usage: object|null}>}
 */
export async function execCodexPrompt(userMessage, options = {}) {
  const {
    onEvent = null,
    statusData = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sendRawEvents = false,
    abortController = null,
    persistent = false,
    sessionId = null,
  } = options;

  agentSdk = resolveAgentSdkConfig({ reload: true });
  if (agentSdk.primary !== "codex") {
    return {
      finalResponse: `❌ Agent SDK set to "${agentSdk.primary}" — Codex SDK disabled.`,
      items: [],
      usage: null,
    };
  }

  if (activeTurn) {
    return {
      finalResponse:
        "⏳ Agent is still executing a previous task. Please wait.",
      items: [],
      usage: null,
    };
  }

  activeTurn = true;

  try {
    if (!persistent) {
      // Task executor path — keep existing fresh-thread behavior
      activeThread = null;
    } else if (sessionId && sessionId !== currentSessionId) {
      // Switching to a different persistent session
      await loadSession(sessionId);
    } else if (!currentSessionId) {
      // First persistent call — initialise the default "primary" session
      await loadSession(sessionId || "primary");
    } else if (turnCount >= MAX_PERSISTENT_TURNS) {
      // Thread is too long — start fresh within the same session
      console.log(`[codex-shell] session ${currentSessionId} hit ${MAX_PERSISTENT_TURNS} turns — rotating thread`);
      activeThread = null;
      activeThreadId = null;
      turnCount = 0;
    }
    // else: persistent && same session && under limit → reuse activeThread

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const thread = await getThread();

      // Build the user prompt with optional status context
      let prompt = userMessage;
      if (statusData) {
        const statusSnippet = JSON.stringify(statusData, null, 2).slice(
          0,
          2000,
        );
        prompt = `[Orchestrator Status]\n\`\`\`json\n${statusSnippet}\n\`\`\`\n\n# YOUR TASK — EXECUTE NOW\n\n${userMessage}\n\n---\nDo NOT respond with "Ready" or ask what to do. EXECUTE this task. Read files, run commands, produce detailed output.`;
      } else {
        prompt = `# YOUR TASK — EXECUTE NOW\n\n${userMessage}\n\n---\nDo NOT respond with "Ready" or ask what to do. EXECUTE this task. Read files, run commands, produce detailed output.`;
      }

      // Set up timeout
      const controller = abortController || new AbortController();
      const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);

      try {
        // Use runStreamed for real-time event streaming
        const streamedTurn = await thread.runStreamed(prompt, {
          signal: controller.signal,
        });

        let finalResponse = "";
        const allItems = [];

        // Process events from the async generator
        for await (const event of streamedTurn.events) {
          // Capture thread ID on first turn
          if (event.type === "thread.started" && event.thread_id) {
            activeThreadId = event.thread_id;
            await saveState();
          }

          // Format and emit event
          if (onEvent) {
            const formatted = formatEvent(event);
            if (formatted || sendRawEvents) {
              try {
                if (sendRawEvents) {
                  await onEvent(formatted, event);
                } else {
                  await onEvent(formatted);
                }
              } catch {
                /* best effort */
              }
            }
          }

          // Collect items
          if (event.type === "item.completed") {
            allItems.push(event.item);
            if (event.item.type === "agent_message" && event.item.text) {
              finalResponse += event.item.text + "\n";
            }
          }

          // Track usage
          if (event.type === "turn.completed") {
            turnCount++;
            await saveState();
            if (persistent && currentSessionId) {
              await saveCurrentSession();
            }
          }
        }

        clearTimeout(timer);

        return {
          finalResponse:
            finalResponse.trim() || "(Agent completed with no text output)",
          items: allItems,
          usage: null,
        };
      } catch (err) {
        clearTimeout(timer);
        if (err.name === "AbortError") {
          const reason = controller.signal.reason;
          const msg =
            reason === "user_stop"
              ? "🛑 Agent stopped by user."
              : `⏱️ Agent timed out after ${timeoutMs / 1000}s`;
          return { finalResponse: msg, items: [], usage: null };
        }
        if (attempt === 0 && isRecoverableThreadError(err)) {
          console.warn(
            `[codex-shell] recoverable thread error: ${err.message || err} — resetting thread`,
          );
          await resetThread();
          continue;
        }
        throw err;
      }
    }
    return {
      finalResponse: "❌ Agent failed after retry.",
      items: [],
      usage: null,
    };
  } finally {
    activeTurn = false;
  }
}

/**
 * Try to steer an in-flight agent without stopping the run.
 * Best-effort: uses SDK steering APIs if available, else returns unsupported.
 */
export async function steerCodexPrompt(message) {
  try {
    agentSdk = resolveAgentSdkConfig({ reload: true });
    if (agentSdk.primary !== "codex") {
      return { ok: false, reason: "agent_sdk_not_codex" };
    }
    if (!agentSdk.capabilities?.steering) {
      return { ok: false, reason: "steering_disabled" };
    }
    const thread = await getThread();
    const runtimeCaps = detectThreadCapabilities(thread);
    const steerFn = runtimeCaps.steeringMethod
      ? thread?.[runtimeCaps.steeringMethod]
      : null;

    if (typeof steerFn === "function") {
      await steerFn.call(thread, message);
      return { ok: true, mode: "steer" };
    }

    return {
      ok: false,
      reason: "sdk_no_steering_api",
      detail: "Current Codex SDK Thread exposes only run()/runStreamed()",
    };
  } catch (err) {
    return { ok: false, reason: err.message || "steer_failed" };
  }
}

/**
 * Check if a turn is currently in flight.
 */
export function isCodexBusy() {
  return !!activeTurn;
}

/**
 * Get thread info for display.
 */
export function getThreadInfo() {
  return {
    threadId: activeThreadId,
    turnCount,
    isActive: !!activeThread,
    isBusy: !!activeTurn,
    sessionId: currentSessionId,
  };
}

/**
 * Reset the thread — starts a fresh conversation.
 */
export async function resetThread() {
  activeThread = null;
  activeThreadId = null;
  turnCount = 0;
  activeTurn = null;
  currentSessionId = null;
  await saveState();
  console.log("[codex-shell] thread reset");
}

// ── Session Exports ──────────────────────────────────────────────────────────

/**
 * Get the currently active session ID.
 */
export function getActiveSessionId() {
  return currentSessionId;
}

/**
 * List all saved sessions from logs/sessions/.
 */
export async function listSessions() {
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const files = await readdir(SESSIONS_DIR);
    const sessions = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const id = f.replace(/\.json$/, "");
      const data = await loadSessionData(id);
      if (data) sessions.push({ id, ...data });
    }
    return sessions;
  } catch {
    return [];
  }
}

/**
 * Switch to a different session (saves current, loads target).
 */
export async function switchSession(id) {
  await loadSession(id);
}

/**
 * Create a new named session (does not switch to it).
 */
export async function createSession(id) {
  const data = {
    threadId: null,
    turnCount: 0,
    createdAt: timestamp(),
    lastActiveAt: timestamp(),
  };
  await saveSessionData(id, data);
  return data;
}

// ── Initialisation ──────────────────────────────────────────────────────────

export async function initCodexShell() {
  await loadState();

  // Pre-load SDK
  const Cls = await loadCodexSdk();
  if (Cls) {
    codexInstance = new Cls({
      config: {
        features: {
          child_agents_md: true,
          collab: true,
          memory_tool: true,
          undo: true,
          steer: true,
        },
      },
    });
    console.log("[codex-shell] initialised with Codex SDK (sub-agent features enabled)");
  } else {
    console.warn(
      "[codex-shell] initialised WITHOUT Codex SDK — agent will not work",
    );
  }
}
