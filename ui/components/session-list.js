/* ─────────────────────────────────────────────────────────────
 *  Component: Session List — ChatGPT-style sidebar for agent sessions
 *  With swipe-to-action, archive, delete, and duplicate prevention.
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import htm from "htm";
import { signal, computed } from "@preact/signals";
import { apiFetch } from "../modules/api.js";
import { formatRelative, truncate } from "../modules/utils.js";

const html = htm.bind(h);

/* ─── Signals ─── */
export const sessionsData = signal([]);
export const selectedSessionId = signal(null);
export const sessionMessages = signal([]);
export const sessionsError = signal(null);

/** Track the last filter used so createSession can reload with the same filter */
let _lastLoadFilter = {};

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

export async function loadSessionMessages(id) {
  try {
    const res = await apiFetch(`/api/sessions/${id}`, { _silent: true });
    if (res?.session) sessionMessages.value = res.session.messages || [];
  } catch {
    sessionMessages.value = [];
  }
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
    await apiFetch(`/api/sessions/${id}/archive`, { method: "POST" });
    if (selectedSessionId.value === id) selectedSessionId.value = null;
    await loadSessions(_lastLoadFilter);
    return true;
  } catch {
    return false;
  }
}

export async function deleteSession(id) {
  try {
    await apiFetch(`/api/sessions/${id}/delete`, { method: "POST" });
    if (selectedSessionId.value === id) selectedSessionId.value = null;
    await loadSessions(_lastLoadFilter);
    return true;
  } catch {
    return false;
  }
}

export async function resumeSession(id) {
  try {
    await apiFetch(`/api/sessions/${id}/resume`, { method: "POST" });
    await loadSessions(_lastLoadFilter);
    return true;
  } catch {
    return false;
  }
}

/* ─── Helpers ─── */
const TYPE_ICONS = { primary: "🤖", task: "🔨", review: "👀", manual: "💬" };
const STATUS_ICONS = {
  active: "🟢",
  running: "🟢",
  paused: "⏸️",
  completed: "✅",
  error: "🔴",
  archived: "📦",
};

function sessionIcon(type) {
  return TYPE_ICONS[(type || "").toLowerCase()] || "💬";
}

function statusIcon(status) {
  return STATUS_ICONS[(status || "").toLowerCase()] || "";
}

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
    // Only allow left swipe (negative), cap at -120
    if (dx < 0) {
      setOffset(Math.max(dx, -120));
    } else {
      setOffset(0);
    }
  }

  function onPointerUp() {
    swiping.current = false;
    if (offset < -50) {
      // Snap open to reveal actions
      setOffset(-120);
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
                <span class="session-action-icon">📦</span>
                <span class="session-action-label">Archive</span>
              </button>
            `}
        <button
          class="session-action-btn delete ${confirmDelete ? "confirm" : ""}"
          onClick=${handleDelete}
          title=${confirmDelete ? "Confirm delete" : "Delete session"}
        >
          <span class="session-action-icon">${confirmDelete ? "⚠️" : "🗑"}</span>
          <span class="session-action-label">${confirmDelete ? "Sure?" : "Delete"}</span>
        </button>
      </div>

      <!-- The actual session item (slides left on swipe) -->
      <div
        class="session-item ${isSelected ? "active" : ""} ${isArchived ? "archived" : ""}"
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
          <span class="session-item-icon">${sessionIcon(s.type)}</span>
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
                <span class="session-item-title">${truncate(title, 28)}</span>
              `}
          <div class="session-item-end">
            <span class="session-item-status">${statusIcon(s.status)}</span>
            <!-- Inline action buttons (hover reveal on desktop) -->
            <div class="session-actions">
              ${onStartRename &&
              html`
                <button
                  class="session-inline-btn"
                  title="Rename"
                  onClick=${(e) => {
                    e.stopPropagation();
                    onStartRename(s.id);
                  }}
                >✏️</button>
              `}
              ${isArchived
                ? html`
                    <button
                      class="session-inline-btn"
                      title="Restore"
                      onClick=${(e) => {
                        e.stopPropagation();
                        onResume(s.id);
                      }}
                    >↩</button>
                  `
                : html`
                    <button
                      class="session-inline-btn"
                      title="Archive"
                      onClick=${(e) => {
                        e.stopPropagation();
                        onArchive(s.id);
                      }}
                    >📦</button>
                  `}
              <button
                class="session-inline-btn delete"
                title="Delete"
                onClick=${(e) => {
                  e.stopPropagation();
                  if (onToggleActions) {
                    onToggleActions(s.id);
                    setOffset(-120);
                  }
                }}
              >🗑</button>
            </div>
          </div>
        </div>
        ${s.lastMessage &&
        html`
          <div class="session-item-preview">${truncate(s.lastMessage, 50)}</div>
        `}
        <div class="session-item-time">
          ${formatRelative(s.updatedAt || s.createdAt)}
        </div>
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
          <div class="session-empty-icon">📡</div>
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
            <div class="session-empty-icon">💬</div>
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
