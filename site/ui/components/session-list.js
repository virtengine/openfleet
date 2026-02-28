/* ─────────────────────────────────────────────────────────────
 *  Component: Session List — ChatGPT-style sidebar for agent sessions
 *  With swipe-to-action, archive, delete, and duplicate prevention.
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import htm from "htm";
import { signal, computed } from "@preact/signals";
import { apiFetch, onWsMessage } from "../modules/api.js";
import { formatRelative, truncate } from "../modules/utils.js";
import { resolveIcon } from "../modules/icon-utils.js";

const html = htm.bind(h);

/* ─── Signals ─── */
export const sessionsData = signal([]);
export const selectedSessionId = signal(null);
export const sessionMessages = signal([]);
export const sessionsError = signal(null);
/** Pagination metadata from the last loadSessionMessages call */
export const sessionPagination = signal(null);

const DEFAULT_SESSION_PAGE_SIZE = 20;
const MAX_SESSION_PAGE_SIZE = 200;

let _wsListenerReady = false;

/** Track the last filter used so createSession can reload with the same filter */
let _lastLoadFilter = {};

function sessionPath(id, action = "") {
  const safeId = encodeURIComponent(String(id || "").trim());
  if (!safeId) return "";
  return action ? `/api/sessions/${safeId}/${action}` : `/api/sessions/${safeId}`;
}

/* ─── Data loaders ─── */
export async function loadSessions(filter = {}) {
  _lastLoadFilter = filter;
  try {
    const params = new URLSearchParams(filter);
    const res = await apiFetch(`/api/sessions?${params}`, { _silent: true });
    if (res?.sessions) sessionsData.value = res.sessions;
    sessionsError.value = null;
  } catch {
    sessionsError.value = "unavailable";
  }
}

export async function loadSessionMessages(id, opts = {}) {
  try {
    let url = sessionPath(id);
    if (!url) return { ok: false, error: "invalid" };
    const requestedLimit = opts.limit != null ? Number(opts.limit) : DEFAULT_SESSION_PAGE_SIZE;
    const limit =
      Number.isFinite(requestedLimit) && requestedLimit > 0
        ? Math.min(Math.floor(requestedLimit), MAX_SESSION_PAGE_SIZE)
        : DEFAULT_SESSION_PAGE_SIZE;
    const params = new URLSearchParams();
    params.set("limit", String(limit));
    if (opts.offset != null) params.set("offset", String(opts.offset));
    const qs = params.toString();
    if (qs) url += `?${qs}`;
    const res = await apiFetch(url, { _silent: true });
    if (res?.session) {
      const normalized = dedupeMessages(res.session.messages || []);
      if (opts.prepend && sessionMessages.value?.length) {
        const merged = dedupeMessages([...normalized, ...sessionMessages.value]);
        sessionMessages.value = merged;
      } else {
        sessionMessages.value = normalized;
      }
      sessionPagination.value = res.pagination || null;
      return { ok: true, messages: normalized, pagination: res.pagination || null };
    }
    sessionMessages.value = [];
    sessionPagination.value = null;
    return { ok: false, error: "empty" };
  } catch {
    sessionMessages.value = [];
    sessionPagination.value = null;
    return { ok: false, error: "unavailable" };
  }
}

function normalizePreview(content) {
  if (content == null) return "";
  const text =
    typeof content === "string" ? content : JSON.stringify(content);
  return text.slice(0, 100);
}

function canonicalMessageKind(msg) {
  const role = String(msg?.role || "").trim().toLowerCase();
  const type = String(msg?.type || "").trim().toLowerCase();
  if (
    role === "assistant" ||
    type === "agent_message" ||
    type === "assistant" ||
    type === "assistant_message"
  ) {
    return "assistant";
  }
  if (role === "user" || type === "user") return "user";
  if (type === "tool_call") return "tool_call";
  if (type === "tool_result" || type === "tool_output") return "tool_result";
  if (type === "error" || type === "stream_error") return "error";
  if (role === "system" || type === "system") return "system";
  return `${role || "unknown"}:${type || "message"}`;
}

function dedupeMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  const seenExact = new Set();
  const recentAssistantContentTs = new Map();
  for (const msg of list) {
    if (!msg) continue;
    const kind = canonicalMessageKind(msg);
    const content = String(msg.content || msg.text || "").trim();
    const ts = Date.parse(msg.timestamp || 0) || 0;
    const exactKey = `${kind}|${content}|${ts}`;
    if (seenExact.has(exactKey)) continue;
    if (kind === "assistant" && content) {
      const prevAssistantTs = recentAssistantContentTs.get(content);
      if (prevAssistantTs !== undefined) {
        const withinAssistantWindow =
          ts > 0 && prevAssistantTs > 0
            ? Math.abs(ts - prevAssistantTs) <= 5000
            : true;
        if (withinAssistantWindow) continue;
      }
    }
    const last = out[out.length - 1];
    if (last) {
      const lastKind = canonicalMessageKind(last);
      const lastContent = String(last.content || last.text || "").trim();
      const lastTs = Date.parse(last.timestamp || 0) || 0;
      const withinDuplicateWindow =
        ts > 0 && lastTs > 0 ? Math.abs(ts - lastTs) <= 5000 : true;
      if (
        content &&
        lastKind === kind &&
        lastContent === content &&
        withinDuplicateWindow
      ) {
        continue;
      }
    }
    seenExact.add(exactKey);
    out.push(msg);
    if (kind === "assistant" && content) {
      recentAssistantContentTs.set(content, ts);
    }
  }
  return out;
}

/**
 * Throttle sessionsData updates — the sidebar preview metadata
 * (lastActiveAt, preview) changes on every WS event, but the user
 * doesn't notice sub-second updates. Batch them to avoid triggering
 * cascading re-renders in the 5+ components that subscribe to
 * sessionsData. Messages (sessionMessages) are batched per-frame
 * so multiple WS events within a single animation frame cause only
 * one ChatView re-render.
 */
let _sessionUpdateTimer = null;
let _pendingSessionUpdates = new Map();

function _flushSessionUpdates() {
  _sessionUpdateTimer = null;
  if (_pendingSessionUpdates.size === 0) return;
  const sessions = sessionsData.value || [];
  const patches = _pendingSessionUpdates;
  _pendingSessionUpdates = new Map();
  const next = sessions.map((s) => {
    const patch = patches.get(s.id);
    return patch ? { ...s, ...patch } : s;
  });
  sessionsData.value = next;
}

/** Per-frame message batching for sessionMessages */
let _msgBatchBuffer = [];
let _msgBatchRaf = null;

function _flushMessageBatch() {
  _msgBatchRaf = null;
  if (_msgBatchBuffer.length === 0) return;
  const batch = _msgBatchBuffer;
  _msgBatchBuffer = [];
  const current = Array.isArray(sessionMessages.value) ? sessionMessages.value : [];
  const merged = dedupeMessages([...current, ...batch]);
  if (merged.length !== current.length) {
    sessionMessages.value = merged;
  }
}

function appendSessionMessage(sessionId, message, sessionMeta) {
  if (!sessionId || !message) return;

  // ── Batch sessionsData sidebar updates (throttled to ~500ms) ──
  const sessions = sessionsData.value || [];
  const existing = sessions.find((s) => s.id === sessionId);
  if (existing) {
    const preview = normalizePreview(message.content || message.text || "");
    const lastActiveAt = message.timestamp || sessionMeta?.lastActiveAt || new Date().toISOString();
    const turnCount = Math.max(existing.turnCount || 0, sessionMeta?.turnCount || 0);
    // Only schedule an update if something actually changed
    if (existing.preview !== preview || existing.turnCount !== turnCount) {
      _pendingSessionUpdates.set(sessionId, { preview, lastMessage: preview, lastActiveAt, turnCount });
      if (!_sessionUpdateTimer) {
        _sessionUpdateTimer = setTimeout(_flushSessionUpdates, 500);
      }
    }
  }

  // ── Batch sessionMessages per animation frame ──
  if (selectedSessionId.value === sessionId) {
    _msgBatchBuffer.push(message);
    if (!_msgBatchRaf) {
      _msgBatchRaf = typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(_flushMessageBatch)
        : setTimeout(_flushMessageBatch, 16);
    }
  }
}

export function initSessionWsListener() {
  if (_wsListenerReady) return;
  _wsListenerReady = true;
  onWsMessage((msg) => {
    if (msg?.type !== "session-message") return;
    const payload = msg.payload || {};
    const sessionId = payload.sessionId || payload.taskId;
    if (!sessionId) return;
    appendSessionMessage(sessionId, payload.message, payload.session);
  });
}

/**
 * Create a new session — but first check if there's already an empty/fresh
 * session of the same type. If so, just select it instead of creating a dupe.
 */
export async function createSession(options = {}) {
  const type = options?.type || "manual";

  // Duplicate prevention: if a fresh empty session of same type exists, reuse it
  const existing = sessionsData.value || [];
  const fresh = existing.find(
    (s) =>
      s.type === type &&
      s.status === "active" &&
      (s.turnCount || 0) === 0 &&
      (!s.preview || s.preview.trim() === ""),
  );
  if (fresh) {
    selectedSessionId.value = fresh.id;
    return { ok: true, session: fresh };
  }

  try {
    const body = options && Object.keys(options).length > 0 ? options : null;
    const res = await apiFetch("/api/sessions/create", {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res?.session?.id) {
      // Reload with the SAME filter the parent component uses
      await loadSessions(_lastLoadFilter);
      selectedSessionId.value = res.session.id;
    }
    return res;
  } catch {
    return null;
  }
}

/* ─── Session actions ─── */
export async function archiveSession(id) {
  try {
    const url = sessionPath(id, "archive");
    if (!url) return false;
    await apiFetch(url, { method: "POST" });
    if (selectedSessionId.value === id) selectedSessionId.value = null;
    await loadSessions(_lastLoadFilter);
    return true;
  } catch {
    return false;
  }
}

export async function deleteSession(id) {
  try {
    const url = sessionPath(id, "delete");
    if (!url) return false;
    await apiFetch(url, { method: "POST" });
    if (selectedSessionId.value === id) selectedSessionId.value = null;
    await loadSessions(_lastLoadFilter);
    return true;
  } catch {
    return false;
  }
}

export async function resumeSession(id) {
  try {
    const url = sessionPath(id, "resume");
    if (!url) return false;
    await apiFetch(url, { method: "POST" });
    await loadSessions(_lastLoadFilter);
    return true;
  } catch {
    return false;
  }
}

/* ─── Helpers ─── */
const STATUS_COLOR_MAP = {
  running: "var(--accent)",
  active: "var(--accent)",
  paused: "var(--text-hint)",
  completed: "var(--color-done)",
  done: "var(--color-done)",
  error: "var(--color-error)",
  archived: "var(--text-hint)",
};

/* ─── Swipeable Session Item ─── */
function SwipeableSessionItem({
  session: s,
  isSelected,
  isRenaming,
  onSelect,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onArchive,
  onDelete,
  onResume,
  showActions,
  onToggleActions,
}) {
  const dragRef = useRef(null);
  const startX = useRef(0);
  const currentX = useRef(0);
  const swiping = useRef(false);
  const [offset, setOffset] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const title = s.title || s.taskId || "Untitled";
  const isArchived = s.status === "archived";
  const isCompleted = s.status === "completed";
  const statusKey = String(s.status || "idle").toLowerCase().replace(/\s+/g, "-");
  const typeLabel = (s.type || "session").toUpperCase();
  const dotColor = STATUS_COLOR_MAP[statusKey] || "var(--text-hint)";

  /* ── Touch / pointer swipe handling ── */
  function onPointerDown(e) {
    // Don't capture on action buttons
    if (e.target.closest(".session-actions")) return;
    startX.current = e.clientX || e.touches?.[0]?.clientX || 0;
    currentX.current = startX.current;
    swiping.current = true;
  }

  function onPointerMove(e) {
    if (!swiping.current) return;
    const x = e.clientX || e.touches?.[0]?.clientX || 0;
    currentX.current = x;
    const dx = x - startX.current;
    // Only allow left swipe (negative), cap at -140
    if (dx < 0) {
      setOffset(Math.max(dx, -140));
    } else {
      setOffset(0);
    }
  }

  function onPointerUp() {
    swiping.current = false;
    if (offset < -50) {
      // Snap open to reveal actions
      setOffset(-140);
      if (onToggleActions) onToggleActions(s.id);
    } else {
      setOffset(0);
    }
  }

  // Close swipe if another item opened
  useEffect(() => {
    if (showActions !== s.id && offset !== 0) {
      setOffset(0);
    }
  }, [showActions]);

  // Close delete confirm when actions close
  useEffect(() => {
    if (showActions !== s.id) setConfirmDelete(false);
  }, [showActions]);

  function handleDelete(e) {
    e.stopPropagation();
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    onDelete(s.id);
    setOffset(0);
  }

  function handleArchive(e) {
    e.stopPropagation();
    onArchive(s.id);
    setOffset(0);
  }

  function handleResume(e) {
    e.stopPropagation();
    onResume(s.id);
    setOffset(0);
  }

  return html`
    <div
      key=${s.id}
      class="session-item-wrapper ${showActions === s.id ? "actions-revealed" : ""}"
    >
      <!-- Swipe-reveal action buttons behind the item -->
      <div class="session-item-behind">
        ${isArchived
          ? html`
              <button
                class="session-action-btn resume"
                onClick=${handleResume}
                title="Unarchive"
              >
                <span class="session-action-icon">↩</span>
                <span class="session-action-label">Restore</span>
              </button>
            `
          : html`
              <button
                class="session-action-btn archive"
                onClick=${handleArchive}
                title="Archive session"
              >
                <span class="session-action-icon">${resolveIcon("📦")}</span>
                <span class="session-action-label">Archive</span>
              </button>
            `}
        <button
          class="session-action-btn delete ${confirmDelete ? "confirm" : ""}"
          onClick=${handleDelete}
          title=${confirmDelete ? "Confirm delete" : "Delete session"}
        >
          <span class="session-action-icon">${resolveIcon(confirmDelete ? "⚠️" : "🗑")}</span>
          <span class="session-action-label">${confirmDelete ? "Sure?" : "Delete"}</span>
        </button>
      </div>

      <!-- The actual session item (slides left on swipe) -->
      <div
        class="session-item ${isSelected ? "active" : ""} ${isArchived ? "archived" : ""} status-${statusKey}"
        style="transform: translateX(${offset}px); transition: ${swiping.current ? "none" : "transform 0.2s ease"}"
        onClick=${() => {
          if (Math.abs(offset) > 10) return; // don't select during swipe
          if (showActions === s.id) {
            onToggleActions(null);
            setOffset(0);
            return;
          }
          onSelect(s.id);
        }}
        onPointerDown=${onPointerDown}
        onPointerMove=${onPointerMove}
        onPointerUp=${onPointerUp}
        onPointerCancel=${() => {
          swiping.current = false;
          setOffset(0);
        }}
        onDblClick=${(e) => {
          if (onStartRename) {
            e.stopPropagation();
            onStartRename(s.id);
          }
        }}
      >
        <div class="session-item-row">
          <span class="session-item-dot" style=${`background:${dotColor}`}></span>
          ${isRenaming && onSaveRename && onCancelRename
            ? html`
                <input
                  class="session-item-rename"
                  value=${title}
                  onClick=${(e) => e.stopPropagation()}
                  onKeyDown=${(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const v = e.target.value.trim();
                      if (v && v !== title) onSaveRename(s.id, v);
                      else onCancelRename();
                    }
                    if (e.key === "Escape") onCancelRename();
                  }}
                  onBlur=${(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== title) onSaveRename(s.id, v);
                    else onCancelRename();
                  }}
                  ref=${(el) => {
                    if (el) {
                      el.focus();
                      el.select();
                    }
                  }}
                />
              `
            : html`
                <span class="session-item-title">${truncate(title, 32)}</span>
              `}
          <span class="session-item-type">${typeLabel}</span>
          <span class="session-item-time">
            ${formatRelative(s.updatedAt || s.createdAt)}
          </span>
          <button
            class="session-item-menu"
            title="Actions"
            onClick=${(e) => {
              e.stopPropagation();
              if (onToggleActions) {
                onToggleActions(s.id);
                setOffset(-140);
              }
            }}
          >
            ⋯
          </button>
        </div>
        ${s.lastMessage && !isArchived &&
        html`
          <div class="session-item-preview">${truncate(s.lastMessage, 50)}</div>
        `}
      </div>
    </div>
  `;
}

/* ─── SessionList component ─── */
export function SessionList({
  onSelect,
  showArchived = true,
  onToggleArchived,
  defaultType = null,
  renamingSessionId = null,
  onStartRename,
  onSaveRename,
  onCancelRename,
}) {
  const [search, setSearch] = useState("");
  const [revealedActions, setRevealedActions] = useState(null);
  const allSessions = sessionsData.value || [];
  const error = sessionsError.value;
  const hasSearch = search.trim().length > 0;

  // Filter by defaultType to exclude ghost sessions (e.g. task sessions in Chat tab)
  const typeFiltered = defaultType
    ? allSessions.filter((s) => {
        const t = (s.type || "").toLowerCase();
        if (defaultType === "primary") {
          // Show primary, manual, and untyped sessions — exclude task/review
          return t !== "task" && t !== "review";
        }
        if (defaultType === "task") {
          return t === "task";
        }
        return t === defaultType.toLowerCase();
      })
    : allSessions;

  const base = showArchived
    ? typeFiltered
    : typeFiltered.filter((s) => s.status !== "archived");

  const filtered = search
    ? base.filter(
        (s) =>
          (s.title || "").toLowerCase().includes(search.toLowerCase()) ||
          (s.taskId || "").toLowerCase().includes(search.toLowerCase()),
      )
    : base;

  const active = filtered.filter(
    (s) => s.status === "active" || s.status === "running",
  );
  const archived = filtered.filter((s) => s.status === "archived");
  const recent = filtered.filter(
    (s) =>
      s.status !== "active" &&
      s.status !== "running" &&
      s.status !== "archived",
  );

  const archivedCount = typeFiltered.filter((s) => s.status === "archived").length;

  const handleSelect = useCallback(
    (id) => {
      selectedSessionId.value = id;
      setRevealedActions(null);
      if (onSelect) onSelect(id);
    },
    [onSelect],
  );

  const handleRetry = useCallback(() => {
    sessionsError.value = null;
    loadSessions(_lastLoadFilter);
  }, []);

  const handleArchive = useCallback(async (id) => {
    setRevealedActions(null);
    await archiveSession(id);
  }, []);

  const handleDelete = useCallback(async (id) => {
    setRevealedActions(null);
    await deleteSession(id);
  }, []);

  const handleResume = useCallback(async (id) => {
    setRevealedActions(null);
    await resumeSession(id);
  }, []);

  // Close revealed actions when clicking the list background
  const handleListClick = useCallback((e) => {
    if (e.target.closest(".session-item-wrapper")) return;
    setRevealedActions(null);
  }, []);

  /* ── Render session items ── */
  function renderSessionItem(s) {
    return html`
      <${SwipeableSessionItem}
        key=${s.id}
        session=${s}
        isSelected=${selectedSessionId.value === s.id}
        isRenaming=${renamingSessionId === s.id}
        onSelect=${handleSelect}
        onStartRename=${onStartRename}
        onSaveRename=${onSaveRename}
        onCancelRename=${onCancelRename}
        onArchive=${handleArchive}
        onDelete=${handleDelete}
        onResume=${handleResume}
        showActions=${revealedActions}
        onToggleActions=${setRevealedActions}
      />
    `;
  }

  if (error) {
    return html`
      <div class="session-list">
        <div class="session-list-header">
          <span class="session-list-title">Sessions</span>
        </div>
        <div class="session-empty">
          <div class="session-empty-icon">${resolveIcon("📡")}</div>
          <div class="session-empty-text">Sessions not available</div>
          <button class="btn btn-primary btn-sm" onClick=${handleRetry}>
            Retry
          </button>
        </div>
      </div>
    `;
  }

  return html`
    <div class="session-list" onClick=${handleListClick}>
      <div class="session-list-header">
        <span class="session-list-title">Sessions</span>
        <div style="display:flex;gap:6px;align-items:center">
          ${typeof onToggleArchived === "function" &&
          archivedCount > 0 &&
          html`
            <button
              class="btn btn-ghost btn-sm"
              onClick=${() => onToggleArchived(!showArchived)}
            >
              ${showArchived
                ? `Hide Archived (${archivedCount})`
                : `Show Archived (${archivedCount})`}
            </button>
          `}
          <button
            class="btn btn-primary btn-sm"
            onClick=${() =>
              createSession(defaultType ? { type: defaultType } : {})}
          >
            + New
          </button>
        </div>
      </div>

      <div class="session-search">
        <input
          class="input session-search-input"
          placeholder="Search sessions…"
          value=${search}
          onInput=${(e) => setSearch(e.target.value)}
        />
      </div>

      <div class="session-list-scroll">
        ${active.length > 0 &&
        html`
          <div class="session-group-label">Active Sessions</div>
          ${active.map(renderSessionItem)}
        `}
        ${recent.length > 0 &&
        html`
          <div class="session-group-label">Recent</div>
          ${recent.map(renderSessionItem)}
        `}
        ${archived.length > 0 &&
        html`
          <div class="session-group-label">Archived (${archived.length})</div>
          ${archived.map(renderSessionItem)}
        `}
        ${filtered.length === 0 &&
        html`
          <div class="session-empty">
            <div class="session-empty-icon">${resolveIcon("💬")}</div>
            <div class="session-empty-text">
              ${hasSearch ? "No matching sessions" : "No sessions yet"}
              <div class="session-empty-subtext">
                ${hasSearch
                  ? "Try a different keyword or clear the search."
                  : "Create a session to get started."}
              </div>
            </div>
            <div class="session-empty-actions">
              <button
                class="btn btn-primary btn-sm"
                onClick=${() =>
                  createSession(defaultType ? { type: defaultType } : {})}
              >
                + New Session
              </button>
              ${hasSearch &&
              html`
                <button
                  class="btn btn-ghost btn-sm"
                  onClick=${() => setSearch("")}
                >
                  Clear search
                </button>
              `}
            </div>
          </div>
        `}
      </div>

      <!-- Swipe hint for mobile (shown once) -->
      ${filtered.length > 0 &&
      html`
        <div class="session-swipe-hint">
          ← Swipe items for actions
        </div>
      `}
    </div>
  `;
}
