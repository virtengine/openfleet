/* ─────────────────────────────────────────────────────────────
 *  Component: Session List — ChatGPT-style sidebar for agent sessions
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useEffect, useCallback } from "preact/hooks";
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

/* ─── Data loaders ─── */
export async function loadSessions(filter = {}) {
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

export async function createSession(options = {}) {
  try {
    const body = options && Object.keys(options).length > 0 ? options : null;
    const res = await apiFetch("/api/sessions/create", {
      method: "POST",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res?.session?.id) {
      await loadSessions();
      selectedSessionId.value = res.session.id;
    }
    return res;
  } catch {
    return null;
  }
}

/* ─── Helpers ─── */
const TYPE_ICONS = { primary: "🤖", task: "🔨", review: "👀", manual: "💬" };
const STATUS_ICONS = { active: "🟢", paused: "⏸️", completed: "✅", error: "🔴" };

function sessionIcon(type) {
  return TYPE_ICONS[(type || "").toLowerCase()] || "💬";
}

function statusIcon(status) {
  return STATUS_ICONS[(status || "").toLowerCase()] || "";
}

/* ─── SessionList component ─── */
export function SessionList({
  onSelect,
  showArchived = true,
  onToggleArchived,
  defaultType = null,
}) {
  const [search, setSearch] = useState("");
  const allSessions = sessionsData.value || [];
  const error = sessionsError.value;
  const hasSearch = search.trim().length > 0;

  const base = showArchived
    ? allSessions
    : allSessions.filter((s) => s.status !== "archived");

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

  const handleSelect = useCallback(
    (id) => {
      selectedSessionId.value = id;
      if (onSelect) onSelect(id);
    },
    [onSelect],
  );

  const handleRetry = useCallback(() => {
    sessionsError.value = null;
    loadSessions();
  }, []);

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
    <div class="session-list">
      <div class="session-list-header">
        <span class="session-list-title">Sessions</span>
        <div style="display:flex;gap:6px;align-items:center">
          ${typeof onToggleArchived === "function" &&
          html`
            <button
              class="btn btn-ghost btn-sm"
              onClick=${() => onToggleArchived(!showArchived)}
            >
              ${showArchived ? "Hide Archived" : "Show Archived"}
            </button>
          `}
          <button
            class="btn btn-primary btn-sm"
            onClick=${() =>
              createSession(defaultType ? { type: defaultType } : {})}
          >
            New Session
          </button>
        </div>
      </div>

      <div class="session-search">
        <input
          class="input session-search-input"
          placeholder="Search by title or task ID…"
          value=${search}
          onInput=${(e) => setSearch(e.target.value)}
        />
      </div>

      <div class="session-list-scroll">
        ${active.length > 0 &&
        html`
          <div class="session-group-label">Active Sessions</div>
          ${active.map(
            (s) => html`
              <div
                key=${s.id}
                class="session-item ${selectedSessionId.value === s.id
                  ? "active"
                  : ""}"
                onClick=${() => handleSelect(s.id)}
              >
                <div class="session-item-row">
                  <span class="session-item-icon"
                    >${sessionIcon(s.type)}</span
                  >
                  <span class="session-item-title"
                    >${truncate(s.title || s.taskId || "Untitled", 28)}</span
                  >
                  <span class="session-item-status"
                    >${statusIcon(s.status)}</span
                  >
                </div>
                ${s.lastMessage &&
                html`
                  <div class="session-item-preview">
                    ${truncate(s.lastMessage, 50)}
                  </div>
                `}
                <div class="session-item-time">${formatRelative(s.updatedAt || s.createdAt)}</div>
              </div>
            `,
          )}
        `}
        ${recent.length > 0 &&
        html`
          <div class="session-group-label">Recent Sessions</div>
          ${recent.map(
            (s) => html`
              <div
                key=${s.id}
                class="session-item ${selectedSessionId.value === s.id
                  ? "active"
                  : ""}"
                onClick=${() => handleSelect(s.id)}
              >
                <div class="session-item-row">
                  <span class="session-item-icon"
                    >${sessionIcon(s.type)}</span
                  >
                  <span class="session-item-title"
                    >${truncate(s.title || s.taskId || "Untitled", 28)}</span
                  >
                  <span class="session-item-status"
                    >${statusIcon(s.status)}</span
                  >
                </div>
                ${s.lastMessage &&
                html`
                  <div class="session-item-preview">
                    ${truncate(s.lastMessage, 50)}
                  </div>
                `}
                <div class="session-item-time">${formatRelative(s.updatedAt || s.createdAt)}</div>
              </div>
            `,
          )}
        `}
        ${archived.length > 0 &&
        html`
          <div class="session-group-label">Archived</div>
          ${archived.map(
            (s) => html`
              <div
                key=${s.id}
                class="session-item ${selectedSessionId.value === s.id
                  ? "active"
                  : ""}"
                onClick=${() => handleSelect(s.id)}
              >
                <div class="session-item-row">
                  <span class="session-item-icon"
                    >${sessionIcon(s.type)}</span
                  >
                  <span class="session-item-title"
                    >${truncate(s.title || s.taskId || "Untitled", 28)}</span
                  >
                  <span class="session-item-status"
                    >${statusIcon(s.status)}</span
                  >
                </div>
                ${s.lastMessage &&
                html`
                  <div class="session-item-preview">
                    ${truncate(s.lastMessage, 50)}
                  </div>
                `}
                <div class="session-item-time">${formatRelative(s.updatedAt || s.createdAt)}</div>
              </div>
            `,
          )}
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
                  : "Create a session to start streaming agent output."}
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
    </div>
  `;
}
