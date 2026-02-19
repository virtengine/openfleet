/**
 * session-tracker.mjs — Captures the last N agent messages for review handoff.
 *
 * When an agent completes (DONE/idle), the session tracker provides the last 10
 * messages as context for the reviewer agent, including both agent outputs and
 * tool calls/results.
 *
 * Supports disk persistence: each session is stored as a JSON file in
 * `logs/sessions/<sessionId>.json` and auto-loaded on init.
 *
 * @module session-tracker
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = resolve(__dirname, "logs", "sessions");

const TAG = "[session-tracker]";

/** Default: keep last 10 messages per task session. */
const DEFAULT_MAX_MESSAGES = 10;

/** Default: keep a larger history for manual/primary chat sessions. */
const DEFAULT_CHAT_MAX_MESSAGES = 2000;

/** Maximum characters per message entry to prevent memory bloat. */
const MAX_MESSAGE_CHARS = 2000;

/** Maximum total sessions to keep in memory. */
const MAX_SESSIONS = 50;

function resolveSessionMaxMessages(type, metadata, explicitMax, fallbackMax) {
  if (Number.isFinite(explicitMax)) {
    return explicitMax > 0 ? explicitMax : 0;
  }
  if (Number.isFinite(metadata?.maxMessages)) {
    return metadata.maxMessages > 0 ? metadata.maxMessages : 0;
  }
  const normalizedType = String(type || "").toLowerCase();
  if (["primary", "manual", "chat"].includes(normalizedType)) {
    return DEFAULT_CHAT_MAX_MESSAGES;
  }
  return fallbackMax;
}

// ── Message Types ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} SessionMessage
 * @property {string} type        - "agent_message"|"tool_call"|"tool_result"|"error"|"system"
 * @property {string} content     - Truncated content
 * @property {string} timestamp   - ISO timestamp
 * @property {Object} [meta]      - Optional metadata (tool name, etc.)
 */

/**
 * @typedef {Object} SessionRecord
 * @property {string} taskId
 * @property {string} taskTitle
 * @property {number} startedAt
 * @property {number|null} endedAt
 * @property {SessionMessage[]} messages
 * @property {number} totalEvents     - Total events received (before truncation)
 * @property {string} status          - "active"|"completed"|"idle"|"failed"
 * @property {number} lastActivityAt  - Timestamp of last event
 */

/** Debounce interval for disk writes (ms). */
const FLUSH_INTERVAL_MS = 2000;

// ── SessionTracker Class ────────────────────────────────────────────────────

export class SessionTracker {
  /** @type {Map<string, SessionRecord>} taskId → session record */
  #sessions = new Map();

  /** @type {number} */
  #maxMessages;

  /** @type {number} idle threshold (ms) — 2 minutes without events = idle */
  #idleThresholdMs;

  /** @type {string|null} directory for session JSON files */
  #persistDir;

  /** @type {Set<string>} session IDs with pending disk writes */
  #dirty = new Set();

  /** @type {ReturnType<typeof setInterval>|null} */
  #flushTimer = null;

  /**
   * @param {Object} [options]
   * @param {number} [options.maxMessages=10]
   * @param {number} [options.idleThresholdMs=120000]
   * @param {string|null} [options.persistDir] — null disables persistence
   */
  constructor(options = {}) {
    this.#maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.#idleThresholdMs = options.idleThresholdMs ?? 180_000; // 3 minutes — gives agents breathing room
    this.#persistDir = options.persistDir !== undefined ? options.persistDir : null;

    if (this.#persistDir) {
      this.#ensureDir();
      this.#loadFromDisk();
      this.#flushTimer = setInterval(() => this.#flushDirty(), FLUSH_INTERVAL_MS);
      if (this.#flushTimer.unref) this.#flushTimer.unref();
    }
  }

  /**
   * Start tracking a new session for a task.
   * If a session already exists, it's replaced.
   *
   * @param {string} taskId
   * @param {string} taskTitle
   */
  startSession(taskId, taskTitle) {
    // Evict oldest sessions if at capacity
    if (this.#sessions.size >= MAX_SESSIONS && !this.#sessions.has(taskId)) {
      const oldest = [...this.#sessions.entries()]
        .sort((a, b) => a[1].startedAt - b[1].startedAt)
        .slice(0, Math.ceil(MAX_SESSIONS / 4));
      for (const [id] of oldest) {
        this.#sessions.delete(id);
      }
    }

    this.#sessions.set(taskId, {
      taskId,
      taskTitle,
      id: taskId,
      type: "task",
      maxMessages: this.#maxMessages,
      startedAt: Date.now(),
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      endedAt: null,
      messages: [],
      totalEvents: 0,
      turnCount: 0,
      status: "active",
      lastActivityAt: Date.now(),
      metadata: {},
    });
    this.#markDirty(taskId);
  }

  /**
   * Record an agent SDK event for a task session.
   * Call this from the `onEvent` callback inside `execWithRetry`.
   *
   * Normalizes events from all 3 SDKs:
   * - Codex: { type: "item.completed"|"item.created", item: {...} }
   * - Copilot: { type: "message"|"tool_call"|"tool_result", ... }
   * - Claude: { type: "content_block_delta"|"message_stop", ... }
   *
   * Also supports direct message objects: { role, content, timestamp, turnIndex }
   *
   * Auto-creates sessions for unknown taskIds when the event carries enough info.
   *
   * @param {string} taskId
   * @param {Object} event - Raw SDK event or direct message object
   */
  recordEvent(taskId, event) {
    let session = this.#sessions.get(taskId);

    // Auto-create session if it doesn't exist yet
    if (!session) {
      if (event && (event.role || event.type)) {
        this.#autoCreateSession(taskId, event);
        session = this.#sessions.get(taskId);
      }
      if (!session) return;
    }

    session.totalEvents++;
    session.lastActivityAt = Date.now();
    session.lastActiveAt = new Date().toISOString();

    const maxMessages =
      session.maxMessages === null || session.maxMessages === undefined
        ? this.#maxMessages
        : session.maxMessages;

    // Direct message format (role/content)
    if (event && event.role && event.content !== undefined) {
      const msg = {
        role: event.role,
        content: String(event.content).slice(0, MAX_MESSAGE_CHARS),
        timestamp: event.timestamp || new Date().toISOString(),
        turnIndex: event.turnIndex ?? session.turnCount,
      };
      session.turnCount++;
      session.messages.push(msg);
      if (Number.isFinite(maxMessages) && maxMessages > 0) {
        while (session.messages.length > maxMessages) session.messages.shift();
      }
      this.#markDirty(taskId);
      return;
    }

    const msg = this.#normalizeEvent(event);
    if (!msg) {
      this.#markDirty(taskId);
      return; // Skip uninteresting events — still update timestamp
    }

    // Push to ring buffer (keep only last N)
    session.messages.push(msg);
    if (Number.isFinite(maxMessages) && maxMessages > 0) {
      while (session.messages.length > maxMessages) session.messages.shift();
    }
    this.#markDirty(taskId);
  }

  /**
   * Mark a session as completed.
   * @param {string} taskId
   * @param {"completed"|"failed"|"idle"} [status="completed"]
   */
  endSession(taskId, status = "completed") {
    const session = this.#sessions.get(taskId);
    if (!session) return;

    session.endedAt = Date.now();
    session.status = status;
    this.#markDirty(taskId);
  }

  /**
   * Get the last N messages for a task session.
   * @param {string} taskId
   * @param {number} [n] - defaults to maxMessages
   * @returns {SessionMessage[]}
   */
  getLastMessages(taskId, n) {
    const session = this.#sessions.get(taskId);
    if (!session) return [];
    const count = n ?? this.#maxMessages;
    return session.messages.slice(-count);
  }

  /**
   * Get a formatted summary of the last N messages.
   * This is the string that gets passed to the review agent.
   *
   * @param {string} taskId
   * @param {number} [n]
   * @returns {string}
   */
  getMessageSummary(taskId, n) {
    const messages = this.getLastMessages(taskId, n);
    if (messages.length === 0) return "(no session messages recorded)";

    const session = this.#sessions.get(taskId);
    const header = [
      `Session: ${session?.taskTitle || taskId}`,
      `Total events: ${session?.totalEvents ?? 0}`,
      `Duration: ${session ? Math.round((Date.now() - session.startedAt) / 1000) : 0}s`,
      `Status: ${session?.status ?? "unknown"}`,
      `--- Last ${messages.length} messages ---`,
    ].join("\n");

    const lines = messages.map((msg) => {
      const ts = new Date(msg.timestamp).toISOString().slice(11, 19);
      const prefix = this.#typePrefix(msg.type || msg.role || "unknown");
      const meta = msg.meta?.toolName ? ` [${msg.meta.toolName}]` : "";
      return `[${ts}] ${prefix}${meta}: ${msg.content}`;
    });

    return `${header}\n${lines.join("\n")}`;
  }

  /**
   * Check if a session appears to be idle (no events for > idleThreshold).
   * @param {string} taskId
   * @returns {boolean}
   */
  isSessionIdle(taskId) {
    const session = this.#sessions.get(taskId);
    if (!session || session.status !== "active") return false;
    return Date.now() - session.lastActivityAt > this.#idleThresholdMs;
  }

  /**
   * Get detailed progress status for a running session.
   * Returns a structured assessment of agent progress suitable for mid-execution monitoring.
   *
   * @param {string} taskId
   * @returns {{ status: "active"|"idle"|"stalled"|"not_found"|"ended", idleMs: number, totalEvents: number, lastEventType: string|null, hasEdits: boolean, hasCommits: boolean, elapsedMs: number, recommendation: "none"|"continue"|"nudge"|"abort" }}
   */
  getProgressStatus(taskId) {
    const session = this.#sessions.get(taskId);
    if (!session) {
      return {
        status: "not_found", idleMs: 0, totalEvents: 0,
        lastEventType: null, hasEdits: false, hasCommits: false,
        elapsedMs: 0, recommendation: "none",
      };
    }

    if (session.status !== "active") {
      return {
        status: "ended", idleMs: 0, totalEvents: session.totalEvents,
        lastEventType: session.messages.at(-1)?.type ?? null,
        hasEdits: false, hasCommits: false,
        elapsedMs: (session.endedAt || Date.now()) - session.startedAt,
        recommendation: "none",
      };
    }

    const now = Date.now();
    const idleMs = now - session.lastActivityAt;
    const elapsedMs = now - session.startedAt;

    // Check if agent has done any meaningful edits or commits
    const hasEdits = session.messages.some((m) => {
      if (m.type !== "tool_call") return false;
      const c = (m.content || "").toLowerCase();
      return c.includes("write") || c.includes("edit") || c.includes("create") ||
        c.includes("replace") || c.includes("patch") || c.includes("append");
    });

    const hasCommits = session.messages.some((m) => {
      if (m.type !== "tool_call") return false;
      const c = (m.content || "").toLowerCase();
      return c.includes("git commit") || c.includes("git push");
    });

    // Determine status — check stalled FIRST (it's the stricter condition)
    let status = "active";
    if (idleMs > this.#idleThresholdMs * 2) {
      status = "stalled";
    } else if (idleMs > this.#idleThresholdMs) {
      status = "idle";
    }

    // Determine recommendation
    let recommendation = "none";
    if (status === "stalled") {
      recommendation = "abort";
    } else if (status === "idle") {
      // If agent was idle but had some activity, try CONTINUE
      recommendation = session.totalEvents > 0 ? "continue" : "nudge";
    } else if (elapsedMs > 30 * 60_000 && session.totalEvents < 5) {
      // 30 min with < 5 events — agent is stalled even if not technically idle
      recommendation = "continue";
    }

    return {
      status, idleMs, totalEvents: session.totalEvents,
      lastEventType: session.messages.at(-1)?.type ?? null,
      hasEdits, hasCommits, elapsedMs, recommendation,
    };
  }

  /**
   * Get all active sessions (for watchdog scanning).
   * @returns {Array<{ taskId: string, taskTitle: string, idleMs: number, totalEvents: number, elapsedMs: number }>}
   */
  getActiveSessions() {
    const result = [];
    const now = Date.now();
    for (const [taskId, session] of this.#sessions) {
      if (session.status !== "active") continue;
      result.push({
        taskId,
        taskTitle: session.taskTitle,
        idleMs: now - session.lastActivityAt,
        totalEvents: session.totalEvents,
        elapsedMs: now - session.startedAt,
      });
    }
    return result;
  }

  /**
   * Get the full session record.
   * @param {string} taskId
   * @returns {SessionRecord|null}
   */
  getSession(taskId) {
    return this.#sessions.get(taskId) ?? null;
  }

  /**
   * Remove a session from tracking (after review handoff).
   * @param {string} taskId
   */
  removeSession(taskId) {
    this.#sessions.delete(taskId);
  }

  /**
   * Get stats about tracked sessions.
   * @returns {{ active: number, completed: number, total: number }}
   */
  getStats() {
    let active = 0;
    let completed = 0;
    for (const session of this.#sessions.values()) {
      if (session.status === "active") active++;
      else completed++;
    }
    return { active, completed, total: this.#sessions.size };
  }

  // ── Persistence API ─────────────────────────────────────────────────────

  /**
   * Create a new session with explicit options.
   * @param {{ id: string, type?: string, taskId?: string, metadata?: Object }} opts
   */
  createSession({ id, type = "manual", taskId, metadata = {}, maxMessages }) {
    const now = new Date().toISOString();
    const resolvedMax = resolveSessionMaxMessages(
      type,
      metadata,
      maxMessages,
      this.#maxMessages,
    );
    const session = {
      id,
      taskId: taskId || id,
      taskTitle: metadata.title || id,
      type,
      status: "active",
      createdAt: now,
      lastActiveAt: now,
      startedAt: Date.now(),
      endedAt: null,
      messages: [],
      totalEvents: 0,
      turnCount: 0,
      lastActivityAt: Date.now(),
      metadata,
      maxMessages: resolvedMax,
    };
    this.#sessions.set(id, session);
    this.#markDirty(id);
    this.#flushDirty(); // immediate write for create
    return session;
  }

  /**
   * List all sessions (metadata only, no full messages).
   * Sorted by lastActiveAt descending.
   * @returns {Array<Object>}
   */
  listAllSessions() {
    const list = [];
    for (const s of this.#sessions.values()) {
      list.push({
        id: s.id || s.taskId,
        taskId: s.taskId,
        title: s.taskTitle || s.title || null,
        type: s.type || "task",
        status: s.status,
        turnCount: s.turnCount || 0,
        createdAt: s.createdAt || new Date(s.startedAt).toISOString(),
        lastActiveAt: s.lastActiveAt || new Date(s.lastActivityAt).toISOString(),
        preview: this.#lastMessagePreview(s),
        lastMessage: this.#lastMessagePreview(s),
      });
    }
    list.sort((a, b) => (b.lastActiveAt || "").localeCompare(a.lastActiveAt || ""));
    return list;
  }

  /**
   * Get full session including all messages, read from disk if needed.
   * @param {string} sessionId
   * @returns {Object|null}
   */
  getSessionMessages(sessionId) {
    const session = this.#sessions.get(sessionId);
    if (!session) return null;
    return { ...session };
  }

  /**
   * Get a session by id (alias for getSession with id lookup).
   * @param {string} sessionId
   * @returns {Object|null}
   */
  getSessionById(sessionId) {
    return this.#sessions.get(sessionId) ?? null;
  }

  /**
   * Update session status.
   * @param {string} sessionId
   * @param {string} status
   */
  updateSessionStatus(sessionId, status) {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.status = status;
    if (status === "completed" || status === "archived") {
      session.endedAt = Date.now();
    }
    this.#markDirty(sessionId);
  }

  /**
   * Flush all dirty sessions to disk immediately.
   */
  flush() {
    this.#flushDirty();
  }

  /**
   * Stop the flush timer (for cleanup).
   */
  destroy() {
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#flushDirty();
  }

  /**
   * Merge any on-disk session updates into memory.
   * Useful when another process writes session files.
   */
  refreshFromDisk() {
    if (!this.#persistDir) return;
    this.#ensureDir();
    let files = [];
    try {
      files = readdirSync(this.#persistDir).filter((f) => f.endsWith(".json"));
    } catch {
      return;
    }
    for (const file of files) {
      const filePath = resolve(this.#persistDir, file);
      try {
        const raw = readFileSync(filePath, "utf8");
        const data = JSON.parse(raw || "{}");
        const sessionId = String(data.id || data.taskId || "").trim();
        if (!sessionId) continue;
        const lastActiveAt =
          Date.parse(data.lastActiveAt || "") ||
          Date.parse(data.updatedAt || "") ||
          0;
        const existing = this.#sessions.get(sessionId);
        const existingLast =
          existing?.lastActivityAt ||
          Date.parse(existing?.lastActiveAt || "") ||
          0;
        if (existing && existingLast >= lastActiveAt) {
          continue;
        }
        this.#sessions.set(sessionId, {
          taskId: data.taskId || sessionId,
          taskTitle: data.title || data.taskTitle || null,
          id: sessionId,
          type: data.type || "task",
          startedAt: Date.parse(data.createdAt || "") || Date.now(),
          createdAt: data.createdAt || new Date().toISOString(),
          lastActiveAt: data.lastActiveAt || data.updatedAt || new Date().toISOString(),
          endedAt: data.endedAt || null,
          messages: Array.isArray(data.messages) ? data.messages : [],
          totalEvents: Array.isArray(data.messages) ? data.messages.length : 0,
          turnCount: data.turnCount || 0,
          status: data.status || "active",
          lastActivityAt: lastActiveAt || Date.now(),
          metadata: data.metadata || {},
        });
      } catch {
        /* ignore corrupt session file */
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Auto-create a session when recordEvent is called for an unknown taskId. */
  #autoCreateSession(taskId, event) {
    const type = event._sessionType || "task";
    this.createSession({
      id: taskId,
      type,
      taskId,
      metadata: { autoCreated: true },
    });
  }

  /** Get preview text from last message */
  #lastMessagePreview(session) {
    const last = session.messages?.at(-1);
    if (!last) return "";
    const content = last.content || "";
    return content.slice(0, 100);
  }

  #markDirty(sessionId) {
    if (this.#persistDir) {
      this.#dirty.add(sessionId);
    }
  }

  #ensureDir() {
    if (this.#persistDir && !existsSync(this.#persistDir)) {
      mkdirSync(this.#persistDir, { recursive: true });
    }
  }

  #sessionFilePath(sessionId) {
    // Sanitize sessionId for filesystem safety
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_\-\.]/g, "_");
    return resolve(this.#persistDir, `${safe}.json`);
  }

  #flushDirty() {
    if (!this.#persistDir || this.#dirty.size === 0) return;
    this.#ensureDir();
    for (const sessionId of this.#dirty) {
      const session = this.#sessions.get(sessionId);
      if (!session) continue;
      try {
        const filePath = this.#sessionFilePath(sessionId);
        const data = {
          id: session.id || session.taskId,
          taskId: session.taskId,
          title: session.taskTitle || session.title || null,
          taskTitle: session.taskTitle || null,
          type: session.type || "task",
          status: session.status,
          createdAt: session.createdAt || new Date(session.startedAt).toISOString(),
          lastActiveAt: session.lastActiveAt || new Date(session.lastActivityAt).toISOString(),
          turnCount: session.turnCount || 0,
          messages: session.messages || [],
          metadata: session.metadata || {},
        };
        writeFileSync(filePath, JSON.stringify(data, null, 2));
      } catch (err) {
        // Silently ignore write errors — disk persistence is best-effort
      }
    }
    this.#dirty.clear();
  }

  #loadFromDisk() {
    if (!this.#persistDir || !existsSync(this.#persistDir)) return;
    try {
      const files = readdirSync(this.#persistDir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        try {
          const raw = readFileSync(resolve(this.#persistDir, file), "utf8");
          const data = JSON.parse(raw);
          if (!data.id && !data.taskId) continue;
          const id = data.id || data.taskId;
          if (this.#sessions.has(id)) continue; // don't overwrite in-memory
          this.#sessions.set(id, {
            id,
            taskId: data.taskId || id,
            taskTitle: data.metadata?.title || id,
            type: data.type || "task",
            status: data.status || "completed",
            createdAt: data.createdAt || new Date().toISOString(),
            lastActiveAt: data.lastActiveAt || new Date().toISOString(),
            startedAt: data.createdAt ? new Date(data.createdAt).getTime() : Date.now(),
            endedAt: data.status !== "active" ? Date.now() : null,
            messages: data.messages || [],
            totalEvents: (data.messages || []).length,
            turnCount: data.turnCount || 0,
            lastActivityAt: data.lastActiveAt ? new Date(data.lastActiveAt).getTime() : Date.now(),
            metadata: data.metadata || {},
          });
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // Directory read failed — proceed without disk data
    }
  }

  /**
   * Normalize a raw SDK event into a SessionMessage.
   * Returns null for events that shouldn't be tracked (noise).
   *
   * @param {Object} event
   * @returns {SessionMessage|null}
   * @private
   */
  #normalizeEvent(event) {
    if (!event || !event.type) return null;

    const ts = new Date().toISOString();

    // ── Codex SDK events ──
    if (event.type === "item.completed" && event.item) {
      const item = event.item;

      if (item.type === "agent_message" && item.text) {
        return {
          type: "agent_message",
          content: item.text.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (item.type === "function_call") {
        return {
          type: "tool_call",
          content: `${item.name}(${(item.arguments || "").slice(0, 500)})`,
          timestamp: ts,
          meta: { toolName: item.name },
        };
      }

      if (item.type === "function_call_output") {
        return {
          type: "tool_result",
          content: (item.output || "").slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      return null; // Skip other item types
    }

    // ── Copilot SDK events ──
    if (event.type === "message" && event.content) {
      return {
        type: "agent_message",
        content: (typeof event.content === "string" ? event.content : JSON.stringify(event.content))
          .slice(0, MAX_MESSAGE_CHARS),
        timestamp: ts,
      };
    }

    if (event.type === "tool_call") {
      return {
        type: "tool_call",
        content: `${event.name || event.tool || "tool"}(${(event.arguments || event.input || "").slice(0, 500)})`,
        timestamp: ts,
        meta: { toolName: event.name || event.tool },
      };
    }

    if (event.type === "tool_result" || event.type === "tool_output") {
      return {
        type: "tool_result",
        content: (event.output || event.result || "").slice(0, MAX_MESSAGE_CHARS),
        timestamp: ts,
      };
    }

    // ── Claude SDK events ──
    if (event.type === "content_block_delta" && event.delta?.text) {
      return {
        type: "agent_message",
        content: event.delta.text.slice(0, MAX_MESSAGE_CHARS),
        timestamp: ts,
      };
    }

    if (event.type === "message_stop" || event.type === "message_delta") {
      return {
        type: "system",
        content: `${event.type}${event.delta?.stop_reason ? ` (${event.delta.stop_reason})` : ""}`,
        timestamp: ts,
      };
    }

    // ── Error events (any SDK) ──
    if (event.type === "error" || event.type === "stream_error") {
      return {
        type: "error",
        content: (event.error?.message || event.message || JSON.stringify(event)).slice(0, MAX_MESSAGE_CHARS),
        timestamp: ts,
      };
    }

    return null;
  }

  /**
   * Get a display prefix for a message type.
   * @param {string} type
   * @returns {string}
   * @private
   */
  #typePrefix(type) {
    switch (type) {
      case "agent_message": return "AGENT";
      case "tool_call":     return "TOOL";
      case "tool_result":   return "RESULT";
      case "error":         return "ERROR";
      case "system":        return "SYS";
      case "user":          return "USER";
      case "assistant":     return "ASSISTANT";
      default:              return type.toUpperCase();
    }
  }
}

// ── Standalone exported functions (delegate to singleton) ───────────────────

/**
 * List all sessions (metadata only).
 * @returns {Array<Object>}
 */
export function listAllSessions() {
  return getSessionTracker().listAllSessions();
}

/**
 * Get full session with all messages.
 * @param {string} sessionId
 * @returns {Object|null}
 */
export function getSessionMessages(sessionId) {
  return getSessionTracker().getSessionMessages(sessionId);
}

/**
 * Create a new session.
 * @param {{ id: string, type?: string, taskId?: string, metadata?: Object }} opts
 * @returns {Object}
 */
export async function createSession(opts) {
  return getSessionTracker().createSession(opts);
}

/**
 * Update session status.
 * @param {string} sessionId
 * @param {string} status
 */
export function updateSessionStatus(sessionId, status) {
  return getSessionTracker().updateSessionStatus(sessionId, status);
}

/**
 * Get a session by id.
 * @param {string} sessionId
 * @returns {Object|null}
 */
export function getSessionById(sessionId) {
  return getSessionTracker().getSessionById(sessionId);
}

// ── Singleton ───────────────────────────────────────────────────────────────

/** @type {SessionTracker|null} */
let _instance = null;

/**
 * Get or create the singleton SessionTracker.
 * @param {Object} [options]
 * @returns {SessionTracker}
 */
export function getSessionTracker(options) {
  if (!_instance) {
    _instance = new SessionTracker({
      persistDir: SESSIONS_DIR,
      ...options,
    });
    console.log(`${TAG} initialized (maxMessages=${_instance.getStats ? DEFAULT_MAX_MESSAGES : "?"})`);
  }
  return _instance;
}

/**
 * Create a standalone SessionTracker (for testing).
 * @param {Object} [options]
 * @returns {SessionTracker}
 */
export function createSessionTracker(options) {
  return new SessionTracker(options);
}
