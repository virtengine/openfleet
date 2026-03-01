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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
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
const MAX_SESSIONS = 100;

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

const SESSION_EVENT_LISTENERS = new Set();

export function addSessionEventListener(listener) {
  if (typeof listener !== "function") return () => {};
  SESSION_EVENT_LISTENERS.add(listener);
  return () => SESSION_EVENT_LISTENERS.delete(listener);
}

function emitSessionEvent(session, message) {
  if (!session || !message || SESSION_EVENT_LISTENERS.size === 0) return;
  const payload = {
    sessionId: session.id || session.taskId,
    taskId: session.taskId || session.id,
    message,
    session: {
      id: session.id || session.taskId,
      taskId: session.taskId || session.id,
      type: session.type || "task",
      status: session.status || "active",
      lastActiveAt: session.lastActiveAt || new Date().toISOString(),
      turnCount: session.turnCount || 0,
    },
  };
  for (const listener of SESSION_EVENT_LISTENERS) {
    try {
      listener(payload);
    } catch {
      // best-effort listeners
    }
  }
}

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

  /** @type {ReturnType<typeof setInterval>|null} */
  #reaperTimer = null;

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
      this.#purgeExcessFiles();
      this.#flushTimer = setInterval(() => this.#flushDirty(), FLUSH_INTERVAL_MS);
      if (this.#flushTimer.unref) this.#flushTimer.unref();
    }

    // Idle reaper — runs periodically to mark stale "active" sessions as "completed"
    const reaperInterval = Math.max(60_000, this.#idleThresholdMs);
    this.#reaperTimer = setInterval(() => this.#reapIdleSessions(), reaperInterval);
    if (this.#reaperTimer.unref) this.#reaperTimer.unref();
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
      this.#evictOldest();
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

    if (typeof event === "string" && event.trim()) {
      const msg = {
        type: "system",
        content: event.trim().slice(0, MAX_MESSAGE_CHARS),
        timestamp: new Date().toISOString(),
      };
      session.messages.push(msg);
      if (Number.isFinite(maxMessages) && maxMessages > 0) {
        while (session.messages.length > maxMessages) session.messages.shift();
      }
      this.#markDirty(taskId);
      emitSessionEvent(session, msg);
      return;
    }

    // Direct message format (role/content)
    if (event && event.role && event.content !== undefined) {
      const msg = {
        id: event.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: event.type || undefined,
        role: event.role,
        content: String(event.content).slice(0, MAX_MESSAGE_CHARS),
        timestamp: event.timestamp || new Date().toISOString(),
        turnIndex: event.turnIndex ?? session.turnCount,
        attachments: Array.isArray(event.attachments) ? event.attachments : undefined,
        meta:
          event.meta && typeof event.meta === "object"
            ? { ...event.meta }
            : undefined,
      };
      session.turnCount++;
      session.messages.push(msg);
      if (Number.isFinite(maxMessages) && maxMessages > 0) {
        while (session.messages.length > maxMessages) session.messages.shift();
      }
      this.#markDirty(taskId);
      emitSessionEvent(session, msg);
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
    emitSessionEvent(session, msg);
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
    this.#dirty.delete(taskId);
    // Remove persisted session file if it exists
    if (this.#persistDir) {
      try {
        const filePath = this.#sessionFilePath(taskId);
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch { /* best effort */ }
    }
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
    // Evict oldest non-active sessions if at capacity
    if (this.#sessions.size >= MAX_SESSIONS && !this.#sessions.has(id)) {
      this.#evictOldest();
    }

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
   * Rename a session (update its title).
   * @param {string} sessionId
   * @param {string} newTitle
   */
  renameSession(sessionId, newTitle) {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    session.taskTitle = newTitle;
    session.title = newTitle;
    this.#markDirty(sessionId);
  }

  /**
   * Edit a previously recorded user message in-place.
   * @param {string} sessionId
   * @param {Object} payload
   * @param {string} [payload.messageId]
   * @param {string} [payload.timestamp]
   * @param {string} [payload.previousContent]
   * @param {string} payload.content
   * @returns {{ok:boolean,error?:string,message?:object,index?:number}}
   */
  editUserMessage(sessionId, payload = {}) {
    const session = this.#sessions.get(sessionId);
    if (!session) return { ok: false, error: "Session not found" };

    const nextContent = String(payload?.content || "").trim();
    if (!nextContent) return { ok: false, error: "content is required" };

    const messageId = String(payload?.messageId || "").trim();
    const timestamp = String(payload?.timestamp || "").trim();
    const previousContent = payload?.previousContent != null
      ? String(payload.previousContent)
      : "";
    const messages = Array.isArray(session.messages) ? session.messages : [];

    let idx = -1;
    if (messageId) {
      idx = messages.findIndex((msg) => String(msg?.id || "") === messageId);
    }

    if (idx < 0 && timestamp) {
      idx = messages.findIndex((msg) => {
        if (String(msg?.role || "").toLowerCase() !== "user") return false;
        if (String(msg?.timestamp || "") !== timestamp) return false;
        if (!previousContent) return true;
        return String(msg?.content || "") === previousContent;
      });
    }

    if (idx < 0 && previousContent) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (String(msg?.role || "").toLowerCase() !== "user") continue;
        if (String(msg?.content || "") === previousContent) {
          idx = i;
          break;
        }
      }
    }

    if (idx < 0) return { ok: false, error: "Message not found" };

    const target = messages[idx];
    if (String(target?.role || "").toLowerCase() !== "user") {
      return { ok: false, error: "Only user messages can be edited" };
    }

    target.id = target.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    target.content = nextContent.slice(0, MAX_MESSAGE_CHARS);
    target.edited = true;
    target.editedAt = new Date().toISOString();
    session.lastActivityAt = Date.now();
    session.lastActiveAt = new Date().toISOString();
    this.#markDirty(sessionId);

    return { ok: true, message: { ...target }, index: idx };
  }

  /**
   * Flush all dirty sessions to disk immediately.
   */
  flush() {
    this.#flushDirty();
  }

  /**
   * Stop all timers and flush pending writes (for cleanup).
   */
  destroy() {
    if (this.#flushTimer) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }
    if (this.#reaperTimer) {
      clearInterval(this.#reaperTimer);
      this.#reaperTimer = null;
    }
    this.#flushDirty();
  }

  /**
   * Merge any on-disk session updates into memory.
   * Useful when another process writes session files.
   * Respects MAX_SESSIONS and heals stale "active" status.
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

    // Pre-parse for sorting
    /** @type {Array<{file: string, data: Object, lastActive: number}>} */
    const parsed = [];
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
        // Skip if already in memory and newer
        const existing = this.#sessions.get(sessionId);
        const existingLast =
          existing?.lastActivityAt ||
          Date.parse(existing?.lastActiveAt || "") ||
          0;
        if (existing && existingLast >= lastActiveAt) continue;
        parsed.push({ file, data, lastActive: lastActiveAt });
      } catch {
        /* ignore corrupt session file */
      }
    }

    // Sort by lastActive descending and limit to MAX_SESSIONS
    parsed.sort((a, b) => b.lastActive - a.lastActive);
    const available = MAX_SESSIONS - this.#sessions.size;
    const toLoad = parsed.slice(0, Math.max(0, available));

    for (const { data, lastActive } of toLoad) {
      const sessionId = String(data.id || data.taskId || "").trim();
      // Heal stale "active" sessions
      let status = data.status || "completed";
      let endedAt = data.endedAt || null;
      if (status === "active" && lastActive > 0) {
        const ageMs = Date.now() - lastActive;
        if (ageMs > this.#idleThresholdMs) {
          status = "completed";
          endedAt = endedAt || lastActive;
        }
      }
      this.#sessions.set(sessionId, {
        taskId: data.taskId || sessionId,
        taskTitle: data.title || data.taskTitle || null,
        id: sessionId,
        type: data.type || "task",
        startedAt: Date.parse(data.createdAt || "") || Date.now(),
        createdAt: data.createdAt || new Date().toISOString(),
        lastActiveAt: data.lastActiveAt || data.updatedAt || new Date().toISOString(),
        endedAt,
        messages: Array.isArray(data.messages) ? data.messages : [],
        totalEvents: Array.isArray(data.messages) ? data.messages.length : 0,
        turnCount: data.turnCount || 0,
        status,
        lastActivityAt: lastActive || Date.now(),
        metadata: data.metadata || {},
      });
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

  /**
   * Evict the oldest 25% of sessions, preferring completed/idle sessions first.
   * Active sessions are only evicted as a last resort.
   */
  #evictOldest() {
    const evictCount = Math.max(1, Math.ceil(MAX_SESSIONS / 4));
    // Prefer evicting completed/idle/failed sessions before active ones
    const sorted = [...this.#sessions.entries()]
      .sort((a, b) => {
        const aActive = a[1].status === "active" ? 1 : 0;
        const bActive = b[1].status === "active" ? 1 : 0;
        if (aActive !== bActive) return aActive - bActive; // non-active first
        return (a[1].lastActivityAt || a[1].startedAt) - (b[1].lastActivityAt || b[1].startedAt);
      });
    const toEvict = sorted.slice(0, evictCount);
    for (const [id] of toEvict) {
      this.#sessions.delete(id);
    }
  }

  /**
   * Reap idle sessions: mark sessions as "completed" if they have been
   * inactive for longer than the idle threshold.
   * Called periodically by the reaper interval.
   */
  #reapIdleSessions() {
    const now = Date.now();
    let reaped = 0;
    for (const [id, session] of this.#sessions) {
      if (session.status !== "active") continue;
      const idleMs = now - (session.lastActivityAt || session.startedAt || now);
      if (idleMs > this.#idleThresholdMs) {
        session.status = "completed";
        session.endedAt = now;
        this.#markDirty(id);
        reaped++;
      }
    }
    if (reaped > 0) {
      console.log(`${TAG} idle reaper: marked ${reaped} stale session(s) as completed`);
    }
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

  /** @type {Set<string>} filenames loaded during #loadFromDisk (for purge) */
  #loadedFiles = new Set();

  #loadFromDisk() {
    if (!this.#persistDir || !existsSync(this.#persistDir)) return;
    try {
      const files = readdirSync(this.#persistDir).filter((f) => f.endsWith(".json"));

      // Pre-parse all session files with their timestamps for sorting
      /** @type {Array<{file: string, data: Object, lastActive: number}>} */
      const parsed = [];
      for (const file of files) {
        try {
          const raw = readFileSync(resolve(this.#persistDir, file), "utf8");
          const data = JSON.parse(raw);
          if (!data.id && !data.taskId) continue;
          const id = data.id || data.taskId;
          if (this.#sessions.has(id)) continue; // don't overwrite in-memory
          const lastActive = data.lastActiveAt
            ? new Date(data.lastActiveAt).getTime()
            : data.createdAt
              ? new Date(data.createdAt).getTime()
              : 0;
          parsed.push({ file, data, lastActive });
        } catch {
          // Skip corrupt files
        }
      }

      // Sort by lastActive descending (newest first) and keep only MAX_SESSIONS
      parsed.sort((a, b) => b.lastActive - a.lastActive);
      const toLoad = parsed.slice(0, MAX_SESSIONS);

      // Track which files were loaded so #purgeExcessFiles can remove the rest
      this.#loadedFiles = new Set(toLoad.map((p) => p.file));

      for (const { data, lastActive } of toLoad) {
        const id = data.id || data.taskId;
        // Heal stale "active" sessions — if restored from disk and the last
        // activity was more than idleThresholdMs ago, mark as completed.
        let status = data.status || "completed";
        let endedAt = data.endedAt || null;
        if (status === "active" && lastActive > 0) {
          const ageMs = Date.now() - lastActive;
          if (ageMs > this.#idleThresholdMs) {
            status = "completed";
            endedAt = endedAt || lastActive;
          }
        }

        this.#sessions.set(id, {
          id,
          taskId: data.taskId || id,
          taskTitle: data.metadata?.title || id,
          type: data.type || "task",
          status,
          createdAt: data.createdAt || new Date().toISOString(),
          lastActiveAt: data.lastActiveAt || new Date().toISOString(),
          startedAt: data.createdAt ? new Date(data.createdAt).getTime() : Date.now(),
          endedAt,
          messages: data.messages || [],
          totalEvents: (data.messages || []).length,
          turnCount: data.turnCount || 0,
          lastActivityAt: lastActive || Date.now(),
          metadata: data.metadata || {},
        });
      }
    } catch {
      // Directory read failed — proceed without disk data
    }
  }

  /**
   * Remove session files that were NOT loaded into memory (excess beyond MAX_SESSIONS).
   * This runs once at startup to clean up historical bloat.
   */
  #purgeExcessFiles() {
    if (!this.#persistDir || !existsSync(this.#persistDir)) return;
    try {
      const files = readdirSync(this.#persistDir).filter((f) => f.endsWith(".json"));
      let purged = 0;
      for (const file of files) {
        if (!this.#loadedFiles.has(file)) {
          try {
            unlinkSync(resolve(this.#persistDir, file));
            purged++;
          } catch {
            // best-effort cleanup
          }
        }
      }
      if (purged > 0) {
        console.log(`${TAG} purged ${purged} excess session file(s) from disk`);
      }
      // Free the reference — only needed once at startup
      this.#loadedFiles.clear();
    } catch {
      // best-effort
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
    const toText = (value) => {
      if (value == null) return "";
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };

    // ── Codex SDK events ──
    if ((event.type === "item.completed" || event.type === "item.updated") && event.item) {
      const item = event.item;
      const itemType = String(item.type || "").toLowerCase();

      if (itemType === "agent_message" && item.text) {
        return {
          type: "agent_message",
          content: item.text.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (itemType === "function_call") {
        return {
          type: "tool_call",
          content: `${item.name}(${(item.arguments || "").slice(0, 500)})`,
          timestamp: ts,
          meta: { toolName: item.name },
        };
      }

      if (itemType === "function_call_output") {
        return {
          type: "tool_result",
          content: (item.output || "").slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (itemType === "command_execution" || itemType === "commandexecution") {
        const command = toText(item.command || item.input || "").trim();
        const exitCode = Number.isFinite(Number(item.exit_code)) ? Number(item.exit_code) : null;
        const status = toText(item.status || "").trim();
        const statusParts = [];
        if (status) statusParts.push(status);
        if (exitCode !== null) statusParts.push(`exit=${exitCode}`);
        const statusLabel = statusParts.length ? ` [${statusParts.join(", ")}]` : "";
        const output = toText(
          item.aggregated_output || item.output || item.stderr || item.stdout || "",
        ).trim();
        const content = output
          ? `${command || "(command)"}${statusLabel}
${output}`
          : `${command || "(command)"}${statusLabel}`;
        return {
          type: "tool_call",
          content: content.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
          meta: { toolName: "command_execution" },
        };
      }

      if (itemType === "reasoning") {
        const detail = toText(item.text || item.summary || "");
        if (!detail) return null;
        return {
          type: "system",
          content: detail.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (
        itemType === "agent_message" &&
        event.type === "item.updated" &&
        (item.text || item.delta)
      ) {
        const partial = toText(item.text || item.delta);
        if (!partial) return null;
        return {
          type: "agent_message",
          content: partial.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (itemType === "file_change") {
        const changes = Array.isArray(item.changes)
          ? item.changes
              .map((change) => {
                const kind = toText(change?.kind || "update").trim();
                const filePath = toText(change?.path || change?.file || "").trim();
                return filePath ? `${kind} ${filePath}` : kind;
              })
              .filter(Boolean)
          : [];
        const summary = changes.length
          ? `file changes: ${changes.slice(0, 5).join(", ")}`
          : "file changes detected";
        return {
          type: "system",
          content: summary.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (itemType === "todo_list") {
        const items = Array.isArray(item.items)
          ? item.items
              .map((entry) => {
                const detail = toText(entry?.text || "").trim();
                if (!detail) return "";
                return `${entry?.completed ? "[x]" : "[ ]"} ${detail}`;
              })
              .filter(Boolean)
          : [];
        const summary = items.length ? `todo:
${items.join("\n")}` : "todo updated";
        return {
          type: "system",
          content: summary.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      if (item.text || item.content) {
        const fallback = toText(item.text || item.content);
        if (fallback) {
          return {
            type: "system",
            content: fallback.slice(0, MAX_MESSAGE_CHARS),
            timestamp: ts,
          };
        }
      }

      return null; // Skip other item types
    }

    if (event.type === "item.started" && event.item) {
      const item = event.item;
      const itemType = String(item.type || "").toLowerCase();

      if (itemType === "command_execution") {
        const command = toText(item.command || item.input || "").trim();
        return {
          type: "tool_call",
          content: command || "(command)",
          timestamp: ts,
          meta: { toolName: "command_execution" },
        };
      }

      if (itemType === "reasoning") {
        const detail = toText(item.text || item.summary || "").trim();
        if (!detail) return null;
        return {
          type: "system",
          content: detail.slice(0, MAX_MESSAGE_CHARS),
          timestamp: ts,
        };
      }

      // ── Additional item.started subtypes ──────────────────────────────
      // Emit lifecycle events so the streaming module keeps the
      // "thinking / executing" indicator alive and the chat UI shows
      // real-time progress instead of going silent for minutes.
      if (itemType === "agent_message") {
        return {
          type: "system",
          content: "Agent is composing a response…",
          timestamp: ts,
          meta: { lifecycle: "started", itemType },
        };
      }

      if (itemType === "function_call") {
        const name = toText(item.name || "").trim();
        return {
          type: "tool_call",
          content: name ? `${name}(…)` : "(tool call starting)",
          timestamp: ts,
          meta: { toolName: name || "function_call", lifecycle: "started" },
        };
      }

      if (itemType === "mcp_tool_call") {
        const server = toText(item.server || "").trim();
        const tool = toText(item.tool || "").trim();
        return {
          type: "tool_call",
          content: `MCP [${server || "?"}]: ${tool || "(starting)"}`,
          timestamp: ts,
          meta: { toolName: tool || "mcp_tool_call", lifecycle: "started" },
        };
      }

      if (itemType === "web_search") {
        const query = toText(item.query || "").trim();
        return {
          type: "system",
          content: query ? `Searching: ${query}` : "Web search…",
          timestamp: ts,
          meta: { lifecycle: "started", itemType },
        };
      }

      if (itemType === "file_change") {
        return {
          type: "system",
          content: "Editing files…",
          timestamp: ts,
          meta: { lifecycle: "started", itemType },
        };
      }

      if (itemType === "todo_list") {
        return {
          type: "system",
          content: "Updating plan…",
          timestamp: ts,
          meta: { lifecycle: "started", itemType },
        };
      }
    }

    // ── Turn lifecycle events ──────────────────────────────────────────
    // Without these, the streaming module sees no events between the last
    // item.completed and the response finishing, causing the indicator
    // to flip between "thinking" and "idle".
    if (event.type === "turn.completed") {
      return {
        type: "system",
        content: "Turn completed",
        timestamp: ts,
        meta: { lifecycle: "turn_completed" },
      };
    }

    if (event.type === "session.idle" || event.type === "session.completed") {
      return {
        type: "system",
        content: "Session completed",
        timestamp: ts,
        meta: { lifecycle: "session_completed" },
      };
    }

    if (event.type === "turn.failed") {
      const detail = toText(event.error?.message || "unknown error");
      return {
        type: "error",
        content: `Turn failed: ${detail}`.slice(0, MAX_MESSAGE_CHARS),
        timestamp: ts,
      };
    }

    if (event.type === "assistant.message" && event.data?.content) {
      return {
        type: "agent_message",
        content: toText(event.data.content).slice(0, MAX_MESSAGE_CHARS),
        timestamp: ts,
      };
    }

    if (event.type === "assistant.message_delta" && event.data?.deltaContent) {
      return {
        type: "agent_message",
        content: toText(event.data.deltaContent).slice(0, MAX_MESSAGE_CHARS),
        timestamp: ts,
      };
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
      const lifecycle = event.type === "message_stop" ? "turn_completed" : undefined;
      return {
        type: "system",
        content: `${event.type}${event.delta?.stop_reason ? ` (${event.delta.stop_reason})` : ""}`,
        timestamp: ts,
        ...(lifecycle ? { meta: { lifecycle } } : {}),
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

    // ── Voice events ──
    if (event.type === "voice.start") {
      return {
        type: "system",
        content: `Voice session started (provider: ${event.provider || "unknown"}, tier: ${event.tier || "?"})`,
        timestamp: ts,
        meta: { voiceEvent: "start", provider: event.provider, tier: event.tier },
      };
    }
    if (event.type === "voice.end") {
      return {
        type: "system",
        content: `Voice session ended (duration: ${event.duration || 0}s)`,
        timestamp: ts,
        meta: { voiceEvent: "end", duration: event.duration },
      };
    }
    if (event.type === "voice.transcript") {
      return {
        type: "user",
        content: (event.text || event.transcript || "").slice(0, MAX_MESSAGE_CHARS),
        timestamp: ts,
        meta: { voiceEvent: "transcript" },
      };
    }
    if (event.type === "voice.response") {
      return {
        type: "agent_message",
        content: (event.text || event.response || "").slice(0, MAX_MESSAGE_CHARS),
        timestamp: ts,
        meta: { voiceEvent: "response" },
      };
    }
    if (event.type === "voice.tool_call") {
      return {
        type: "tool_call",
        content: `voice:${event.name || "tool"}(${(event.arguments || "").slice(0, 500)})`,
        timestamp: ts,
        meta: { voiceEvent: "tool_call", toolName: event.name },
      };
    }
    if (event.type === "voice.delegate") {
      return {
        type: "system",
        content: `Voice delegated to ${event.executor || "agent"}: ${(event.message || "").slice(0, 500)}`,
        timestamp: ts,
        meta: { voiceEvent: "delegate", executor: event.executor },
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
      case "voice":         return "VOICE";
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

/**
 * Reset the singleton so the next `getSessionTracker()` call creates a fresh
 * instance.  Intended **only** for tests — prevents test-created sessions from
 * leaking into the real `logs/sessions/` directory on disk.
 *
 * @param {Object} [nextOptions] — options forwarded to the *next* singleton
 *   creation.  Pass `{ persistDir: null }` to disable disk writes entirely.
 */
export function _resetSingleton(nextOptions) {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
  if (nextOptions) {
    // Pre-create with the supplied options so the next getSessionTracker()
    // call doesn't fall back to the default persistDir.
    _instance = new SessionTracker(nextOptions);
  }
}
