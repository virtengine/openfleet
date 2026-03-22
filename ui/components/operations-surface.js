import { h } from "preact";
import htm from "htm";
import { Chip } from "@mui/material";
import { formatDate, formatRelative, truncate } from "../modules/utils.js";

const html = htm.bind(h);

function normalizeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function pickRunId(run) {
  return String(run?.runId || run?.id || "").trim();
}

function pickTaskId(task) {
  return String(task?.id || task?.taskId || "").trim();
}

function pickTimestamp(entry) {
  const candidates = [entry?.timestamp, entry?.updatedAt, entry?.endedAt, entry?.startedAt, entry?.createdAt, entry?.ts];
  for (const candidate of candidates) {
    const value = Number(candidate || 0);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

export function buildOperationsActivityItems({ tasks = [], workflowRuns = [] } = {}) {
  const items = [];
  for (const task of normalizeArray(tasks)) {
    const taskId = pickTaskId(task);
    if (!taskId) continue;
    items.push({
      id: `task:${taskId}`,
      kind: "task",
      label: task?.title || taskId,
      detail: `${String(task?.status || "unknown")} task`,
      meta: task?.repository || task?.repo || "Task queue",
      timestamp: pickTimestamp(task),
      status: String(task?.status || "unknown"),
      taskId,
    });
  }
  for (const run of normalizeArray(workflowRuns)) {
    const runId = pickRunId(run);
    if (!runId) continue;
    items.push({
      id: `workflow:${runId}`,
      kind: "workflow",
      label: run?.workflowName || run?.workflowId || runId,
      detail: `${String(run?.status || "unknown")} workflow run`,
      meta: runId,
      timestamp: pickTimestamp(run),
      status: String(run?.status || "unknown"),
      runId,
      workflowId: String(run?.workflowId || "").trim() || null,
    });
  }
  return items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 18);
}

export function buildOperationsNotificationItems({ tasks = [], workflowRuns = [] } = {}) {
  const notices = [];
  for (const task of normalizeArray(tasks)) {
    const status = String(task?.status || "").toLowerCase();
    if (status === "blocked" || status === "error" || status === "failed") {
      notices.push({
        id: `task-alert:${pickTaskId(task)}`,
        severity: "error",
        title: task?.title || pickTaskId(task) || "Task alert",
        body: task?.blockedReason || task?.error || `Task is ${status}`,
        timestamp: pickTimestamp(task),
      });
    }
  }
  for (const run of normalizeArray(workflowRuns)) {
    const status = String(run?.status || "").toLowerCase();
    if (status === "failed" || status === "paused") {
      notices.push({
        id: `workflow-alert:${pickRunId(run)}`,
        severity: status === "failed" ? "error" : "warning",
        title: run?.workflowName || pickRunId(run) || "Workflow alert",
        body: run?.summary || `workflow run ${status}`,
        timestamp: pickTimestamp(run),
      });
    }
  }
  return notices.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 10);
}

function statusTone(status) {
  const value = String(status || "").toLowerCase();
  if (["failed", "error", "blocked"].includes(value)) return "error";
  if (["running", "inprogress", "active"].includes(value)) return "info";
  if (["paused", "review", "inreview"].includes(value)) return "warning";
  if (["done", "completed", "success"].includes(value)) return "success";
  return "default";
}

export function OperationsActivityFeed({ items = [], title = "Recent activity", emptyMessage = "No activity yet.", onOpenItem = null }) {
  return html`
    <section class="ops-panel ops-activity-feed">
      <div class="ops-panel-header">
        <div>
          <div class="ops-panel-kicker">Live activity</div>
          <h3>${title}</h3>
        </div>
      </div>
      <div class="ops-feed-list">
        ${items.length === 0
          ? html`<div class="ops-empty">${emptyMessage}</div>`
          : items.map((item) => html`
              <button type="button" class="ops-feed-item" onClick=${() => onOpenItem?.(item)}>
                <div class="ops-feed-topline">
                  <strong>${truncate(item.label || item.id, 44)}</strong>
                  <${Chip} size="small" label=${item.status || item.kind} color=${statusTone(item.status)} />
                </div>
                <div class="ops-feed-detail">${item.detail || item.meta || item.id}</div>
                <div class="ops-feed-meta">${item.meta || item.kind} · ${item.timestamp ? `${formatDate(item.timestamp)} (${formatRelative(item.timestamp)})` : "just now"}</div>
              </button>
            `)}
      </div>
    </section>
  `;
}

export function OperationsNotificationsRail({ items = [], title = "Notifications", emptyMessage = "No urgent notifications." }) {
  return html`
    <section class="ops-panel ops-notifications-rail">
      <div class="ops-panel-header">
        <div>
          <div class="ops-panel-kicker">Notifications</div>
          <h3>${title}</h3>
        </div>
      </div>
      <div class="ops-notification-list">
        ${items.length === 0
          ? html`<div class="ops-empty">${emptyMessage}</div>`
          : items.map((item) => html`
              <article class=${`ops-notification-card severity-${item.severity || "info"}`}>
                <div class="ops-feed-topline">
                  <strong>${truncate(item.title || item.id, 36)}</strong>
                  <span class="ops-severity-pill">${String(item.severity || "info").toUpperCase()}</span>
                </div>
                <div class="ops-feed-detail">${truncate(item.body || "", 120)}</div>
                <div class="ops-feed-meta">${item.timestamp ? `${formatDate(item.timestamp)} (${formatRelative(item.timestamp)})` : "recent"}</div>
              </article>
            `)}
      </div>
    </section>
  `;
}

export function PersistentRunDetailPanel({
  title = "Run detail",
  subtitle = "Persistent run detail panel",
  detail = null,
  emptyTitle = "Select a run",
  emptyDescription = "Choose a task or workflow run to inspect execution details.",
  sections = [],
  actions = [],
}) {
  return html`
    <aside class="ops-panel persistent-run-detail-panel">
      <div class="ops-panel-header">
        <div>
          <div class="ops-panel-kicker">Run timeline</div>
          <h3>${title}</h3>
          <div class="ops-panel-subtitle">${subtitle}</div>
        </div>
      </div>
      ${detail
        ? html`
            <div class="ops-detail-summary">
              <div class="ops-feed-topline">
                <strong>${truncate(detail.title || detail.id || title, 42)}</strong>
                <${Chip} size="small" label=${detail.status || "idle"} color=${statusTone(detail.status)} />
              </div>
              <div class="ops-feed-detail">${detail.description || detail.summary || "Execution details available."}</div>
              <div class="ops-feed-meta">${detail.meta || detail.id || ""}</div>
            </div>
            ${actions.length ? html`<div class="ops-detail-actions">${actions.map((action) => html`<button type="button" class="wf-btn wf-btn-sm" onClick=${action.onClick}>${action.label}</button>`)}</div>` : null}
            <div class="ops-detail-sections">
              ${sections.map((section) => html`
                <section class="ops-detail-section">
                  <div class="ops-detail-section-title">${section.title}</div>
                  <div class="ops-detail-section-body">${section.content}</div>
                </section>
              `)}
            </div>
          `
        : html`
            <div class="ops-empty-detail">
              <strong>${emptyTitle}</strong>
              <div>${emptyDescription}</div>
            </div>
          `}
    </aside>
  `;
}

export function renderOperationsSurfaceStyles() {
  return html`
    <style>
      .ops-surface-grid { display:grid; gap:12px; }
      .ops-surface-grid.tasks-layout { grid-template-columns: minmax(0, 2.1fr) minmax(300px, 0.9fr); align-items:start; }
      .ops-surface-grid.workflow-layout { grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.9fr); align-items:start; }
      .ops-surface-sidebar { display:grid; gap:12px; position:sticky; top:8px; }
      .ops-panel { background: var(--bg-card, #111827); border:1px solid var(--border, #334155); border-radius: 14px; padding: 14px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.14); }
      .ops-panel-header { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; margin-bottom:10px; }
      .ops-panel-header h3 { margin:0; font-size:15px; }
      .ops-panel-kicker { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color: var(--text-secondary, #94a3b8); margin-bottom:4px; }
      .ops-panel-subtitle, .ops-feed-meta, .ops-feed-detail { font-size:12px; color: var(--text-secondary, #94a3b8); }
      .ops-feed-list, .ops-notification-list, .ops-detail-sections { display:grid; gap:10px; }
      .ops-kanban-grid { display:grid; gap:10px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
      .ops-kanban-column { background: var(--bg-secondary, #0f172a); border:1px solid var(--border, #334155); border-radius:12px; padding:10px; min-height: 180px; display:grid; gap:10px; }
      .ops-kanban-column-header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .ops-kanban-column-body { display:grid; gap:8px; align-content:start; }
      .ops-kanban-card { width:100%; text-align:left; background: rgba(15,23,42,0.75); border:1px solid rgba(148,163,184,0.18); border-radius:10px; padding:10px; color:inherit; cursor:pointer; }
      .ops-kanban-card:hover { border-color: var(--accent, #3b82f6); }
      .ops-count-pill { font-size:11px; padding:4px 8px; border-radius:999px; background:#1e293b; color:#cbd5e1; }
      .ops-dag-list { display:grid; gap:8px; }
      .ops-dag-node-row { display:flex; align-items:flex-start; gap:10px; padding:10px; border-radius:10px; background: var(--bg-secondary, #0f172a); border:1px solid var(--border, #334155); }
      .ops-dag-node-dot { width:10px; height:10px; border-radius:999px; margin-top:4px; background:#64748b; flex:0 0 auto; }
      .ops-dag-node-dot.kind-task { background:#38bdf8; }
      .ops-dag-node-dot.kind-workflow { background:#a78bfa; }
      .ops-dag-node-dot.kind-workflow-template { background:#f59e0b; }
      .ops-feed-item { width:100%; text-align:left; background: var(--bg-secondary, #0f172a); border:1px solid var(--border, #334155); border-radius:12px; padding:12px; color:inherit; cursor:pointer; }
      .ops-feed-item:hover { border-color: var(--accent, #3b82f6); }
      .ops-feed-topline { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px; }
      .ops-severity-pill { font-size:10px; letter-spacing:0.08em; padding:4px 6px; border-radius:999px; background:#1e293b; color:#cbd5e1; }
      .ops-notification-card { background: var(--bg-secondary, #0f172a); border:1px solid var(--border, #334155); border-radius:12px; padding:12px; }
      .ops-notification-card.severity-error { border-color: rgba(239,68,68,0.6); }
      .ops-notification-card.severity-warning { border-color: rgba(245,158,11,0.6); }
      .ops-notification-card.severity-info { border-color: rgba(59,130,246,0.45); }
      .ops-empty, .ops-empty-detail { font-size:12px; color: var(--text-secondary, #94a3b8); border:1px dashed var(--border, #334155); border-radius:12px; padding:14px; background: rgba(15, 23, 42, 0.35); }
      .ops-detail-summary { display:grid; gap:6px; margin-bottom:12px; }
      .ops-detail-actions { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
      .ops-detail-section { background: var(--bg-secondary, #0f172a); border:1px solid var(--border, #334155); border-radius:12px; padding:12px; }
      .ops-detail-section-title { font-size:12px; font-weight:600; margin-bottom:6px; color: var(--text-primary, #e2e8f0); }
      .ops-detail-section-body { font-size:12px; color: var(--text-secondary, #cbd5e1); white-space:pre-wrap; word-break:break-word; }
      @media (max-width: 1100px) { .ops-surface-grid.tasks-layout, .ops-surface-grid.workflow-layout { grid-template-columns: 1fr; } .ops-surface-sidebar { position: static; } .ops-kanban-grid { grid-template-columns: 1fr 1fr; } }
      @media (max-width: 720px) { .ops-kanban-grid { grid-template-columns: 1fr; } }
    </style>
  `;
}


