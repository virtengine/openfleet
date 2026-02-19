/* ─────────────────────────────────────────────────────────────
 *  Kanban Board Component — Trello-style drag-and-drop task board
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useRef, useEffect } from "preact/hooks";
import htm from "htm";
import { signal, computed } from "@preact/signals";
import { tasksData, tasksLoaded, showToast, runOptimistic, loadTasks } from "../modules/state.js";
import { apiFetch } from "../modules/api.js";
import { haptic } from "../modules/telegram.js";
import { formatRelative, truncate, cloneValue } from "../modules/utils.js";

const html = htm.bind(h);

/* ─── Column definitions ─── */
const COLUMN_MAP = {
  draft: ["draft"],
  backlog: ["backlog", "open", "new", "todo"],
  inProgress: ["in-progress", "inprogress", "working", "active", "assigned"],
  inReview: ["in-review", "inreview", "review", "pr-open", "pr-review"],
  done: ["done", "completed", "closed", "merged", "cancelled"],
};

const COLUMNS = [
  { id: "draft", title: "Drafts", icon: "\u{1F4DD}", color: "var(--color-warning, #f59e0b)" },
  { id: "backlog", title: "Backlog", icon: "\u{1F4CB}", color: "var(--text-secondary)" },
  { id: "inProgress", title: "In Progress", icon: "\u{1F528}", color: "var(--color-inprogress, #3b82f6)" },
  { id: "inReview", title: "In Review", icon: "\u{1F440}", color: "var(--color-inreview, #f59e0b)" },
  { id: "done", title: "Done", icon: "\u2705", color: "var(--color-done, #22c55e)" },
];

const COLUMN_TO_STATUS = {
  draft: "draft",
  backlog: "todo",
  inProgress: "inprogress",
  inReview: "inreview",
  done: "done",
};

const PRIORITY_COLORS = {
  critical: "var(--color-critical, #dc2626)",
  high: "var(--color-high, #f59e0b)",
  medium: "var(--color-medium, #3b82f6)",
  low: "var(--color-low, #8b95a2)",
};

const PRIORITY_LABELS = {
  critical: "CRIT",
  high: "HIGH",
  medium: "MED",
  low: "LOW",
};

function getColumnForStatus(status) {
  const s = (status || "").toLowerCase();
  for (const [col, statuses] of Object.entries(COLUMN_MAP)) {
    if (statuses.includes(s)) return col;
  }
  return "backlog";
}

function getTaskTags(task) {
  if (!task) return [];
  const raw = Array.isArray(task.tags) && task.tags.length
    ? task.tags
    : Array.isArray(task?.meta?.tags)
      ? task.meta.tags
      : [];
  return raw.filter((tag) => String(tag || "").trim().toLowerCase() !== "draft");
}

function getTaskBaseBranch(task) {
  if (!task) return "";
  return (
    task.baseBranch ||
    task.base_branch ||
    task.meta?.baseBranch ||
    task.meta?.base_branch ||
    ""
  );
}

/* ─── Derived column data ─── */
const columnData = computed(() => {
  const tasks = tasksData.value || [];
  const cols = {};
  for (const col of COLUMNS) {
    cols[col.id] = [];
  }
  for (const task of tasks) {
    const col = getColumnForStatus(task.status);
    if (cols[col]) cols[col].push(task);
  }
  return cols;
});

/* ─── Drag state (module-level signals) ─── */
const dragTaskId = signal(null);
const dragOverCol = signal(null);

/* ─── Touch drag state ─── */
const touchDragId = signal(null);
const touchOverCol = signal(null);
let _touchClone = null;
let _touchStartX = 0;
let _touchStartY = 0;
let _touchMoved = false;

/* ─── Touch drag helpers ─── */

function _createTouchClone(el) {
  const rect = el.getBoundingClientRect();
  const clone = el.cloneNode(true);
  clone.className = "kanban-card touch-drag-clone";
  clone.style.position = "fixed";
  clone.style.width = rect.width + "px";
  clone.style.left = rect.left + "px";
  clone.style.top = rect.top + "px";
  clone.style.zIndex = "9999";
  clone.style.pointerEvents = "none";
  document.body.appendChild(clone);
  return clone;
}

function _moveTouchClone(clone, x, y) {
  if (!clone) return;
  const w = parseFloat(clone.style.width) || 0;
  clone.style.left = (x - w / 2) + "px";
  clone.style.top = (y - 40) + "px";
}

function _removeTouchClone() {
  if (_touchClone && _touchClone.parentNode) {
    _touchClone.parentNode.removeChild(_touchClone);
  }
  _touchClone = null;
}

function _columnFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const colEl = el.closest(".kanban-column");
  if (!colEl) return null;
  for (const col of COLUMNS) {
    if (colEl.getAttribute("data-col") === col.id) return col.id;
  }
  return null;
}

async function _handleTouchDrop(colId) {
  const taskId = touchDragId.value;
  touchDragId.value = null;
  touchOverCol.value = null;
  if (!taskId || !colId) return;

  const currentTask = (tasksData.value || []).find((t) => t.id === taskId);
  if (!currentTask) return;
  const currentCol = getColumnForStatus(currentTask.status);
  if (currentCol === colId) return;

  const newStatus = COLUMN_TO_STATUS[colId] || "todo";
  const col = COLUMNS.find((c) => c.id === colId);
  haptic("medium");

  const prev = cloneValue(tasksData.value);
  try {
    await runOptimistic(
      () => {
        tasksData.value = tasksData.value.map((t) =>
          t.id === taskId ? { ...t, status: newStatus } : t,
        );
      },
      async () => {
        const res = await apiFetch("/api/tasks/update", {
          method: "POST",
          body: JSON.stringify({ taskId, status: newStatus }),
        });
        if (res?.data) {
          tasksData.value = tasksData.value.map((t) =>
            t.id === taskId ? { ...t, ...res.data } : t,
          );
        }
        return res;
      },
      () => {
        tasksData.value = prev;
      },
    );
    showToast(`Moved to ${col ? col.title : colId}`, "success");
  } catch {
    /* toast via apiFetch */
  }
}

/* ─── Inline create for a column ─── */
async function createTaskInColumn(columnStatus, title) {
  haptic("medium");
  try {
    await apiFetch("/api/tasks/create", {
      method: "POST",
      body: JSON.stringify({
        title,
        status: columnStatus,
        draft: columnStatus === "draft",
      }),
    });
    showToast("Task created", "success");
    await loadTasks();
  } catch {
    /* toast via apiFetch */
  }
}

/* ─── KanbanCard ─── */
function KanbanCard({ task, onOpen }) {
  const onDragStart = useCallback((e) => {
    dragTaskId.value = task.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", task.id);
    e.currentTarget.classList.add("dragging");
  }, [task.id]);

  const onDragEnd = useCallback((e) => {
    dragTaskId.value = null;
    e.currentTarget.classList.remove("dragging");
  }, []);

  /* ─ Touch drag handlers ─ */
  const onTouchStart = useCallback((e) => {
    const touch = e.touches[0];
    _touchStartX = touch.clientX;
    _touchStartY = touch.clientY;
    _touchMoved = false;
    touchDragId.value = task.id;
  }, [task.id]);

  const onTouchMove = useCallback((e) => {
    const touch = e.touches[0];
    const dx = touch.clientX - _touchStartX;
    const dy = touch.clientY - _touchStartY;

    // Only start drag after a small threshold to distinguish from scroll
    if (!_touchMoved && Math.abs(dx) < 10 && Math.abs(dy) < 10) return;

    if (!_touchMoved) {
      _touchMoved = true;
      _removeTouchClone();
      _touchClone = _createTouchClone(e.currentTarget);
      haptic("medium");
    }

    e.preventDefault(); // prevent scroll during drag
    _moveTouchClone(_touchClone, touch.clientX, touch.clientY);

    const colId = _columnFromPoint(touch.clientX, touch.clientY);
    touchOverCol.value = colId;
  }, []);

  const onTouchEnd = useCallback(() => {
    const colId = touchOverCol.value;
    _removeTouchClone();
    if (_touchMoved && colId) {
      _handleTouchDrop(colId);
    } else {
      touchDragId.value = null;
      touchOverCol.value = null;
    }
    _touchMoved = false;
  }, []);

  const onTouchCancel = useCallback(() => {
    _removeTouchClone();
    touchDragId.value = null;
    touchOverCol.value = null;
    _touchMoved = false;
  }, []);

  const priorityColor = PRIORITY_COLORS[task.priority] || null;
  const priorityLabel = PRIORITY_LABELS[task.priority] || null;
  const tags = getTaskTags(task);
  const baseBranch = getTaskBaseBranch(task);

  return html`
    <div
      class="kanban-card ${dragTaskId.value === task.id ? 'dragging' : ''} ${touchDragId.value === task.id && _touchMoved ? 'dragging' : ''}"
      draggable="true"
      onDragStart=${onDragStart}
      onDragEnd=${onDragEnd}
      onTouchStart=${onTouchStart}
      onTouchMove=${onTouchMove}
      onTouchEnd=${onTouchEnd}
      onTouchCancel=${onTouchCancel}
      onClick=${() => onOpen(task.id)}
    >
      ${priorityLabel && html`
        <span class="kanban-card-badge" style="background:${priorityColor}">${priorityLabel}</span>
      `}
      <div class="kanban-card-title">${truncate(task.title || "(untitled)", 80)}</div>
      ${task.description && html`
        <div class="kanban-card-desc">${truncate(task.description, 72)}</div>
      `}
      ${baseBranch && html`
        <div class="kanban-card-base">Base: <code>${truncate(baseBranch, 24)}</code></div>
      `}
      ${tags.length > 0 && html`
        <div class="kanban-card-tags">
          ${tags.map((tag) => html`<span class="tag-chip">#${tag}</span>`)}
        </div>
      `}
      <div class="kanban-card-meta">
        <span class="kanban-card-id">${typeof task.id === "string" ? truncate(task.id, 12) : task.id}</span>
        ${task.created_at && html`<span>${formatRelative(task.created_at)}</span>`}
      </div>
    </div>
  `;
}

/* ─── KanbanColumn ─── */
function KanbanColumn({ col, tasks, onOpen }) {
  const [showCreate, setShowCreate] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (showCreate && inputRef.current) inputRef.current.focus();
  }, [showCreate]);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    dragOverCol.value = col.id;
  }, [col.id]);

  const onDragLeave = useCallback(() => {
    if (dragOverCol.value === col.id) dragOverCol.value = null;
  }, [col.id]);

  const onDrop = useCallback(async (e) => {
    e.preventDefault();
    dragOverCol.value = null;
    const taskId = e.dataTransfer.getData("text/plain") || dragTaskId.value;
    dragTaskId.value = null;
    if (!taskId) return;

    const currentTask = (tasksData.value || []).find((t) => t.id === taskId);
    if (!currentTask) return;
    const currentCol = getColumnForStatus(currentTask.status);
    if (currentCol === col.id) return;

    const newStatus = COLUMN_TO_STATUS[col.id] || "todo";
    haptic("medium");

    const prev = cloneValue(tasksData.value);
    try {
      await runOptimistic(
        () => {
          tasksData.value = tasksData.value.map((t) =>
            t.id === taskId ? { ...t, status: newStatus } : t,
          );
        },
        async () => {
          const res = await apiFetch("/api/tasks/update", {
            method: "POST",
            body: JSON.stringify({ taskId, status: newStatus }),
          });
          if (res?.data) {
            tasksData.value = tasksData.value.map((t) =>
              t.id === taskId ? { ...t, ...res.data } : t,
            );
          }
          return res;
        },
        () => {
          tasksData.value = prev;
        },
      );
      showToast(`Moved to ${col.title}`, "success");
    } catch {
      /* toast via apiFetch */
    }
  }, [col.id, col.title]);

  const handleInlineKeyDown = useCallback((e) => {
    if (e.key === "Enter" && e.target.value.trim()) {
      createTaskInColumn(COLUMN_TO_STATUS[col.id] || "todo", e.target.value.trim());
      e.target.value = "";
      setShowCreate(false);
    }
    if (e.key === "Escape") {
      setShowCreate(false);
    }
  }, [col.id]);

  const isOver = dragOverCol.value === col.id || touchOverCol.value === col.id;

  return html`
    <div
      class="kanban-column ${isOver ? 'drag-over' : ''}"
      data-col=${col.id}
      onDragOver=${onDragOver}
      onDragLeave=${onDragLeave}
      onDrop=${onDrop}
    >
      <div class="kanban-column-header" style="border-bottom-color: ${col.color}">
        <span>${col.icon}</span>
        <span class="kanban-column-title">${col.title}</span>
        <span class="kanban-count">${tasks.length}</span>
        <button
          class="kanban-add-btn"
          onClick=${() => { setShowCreate(!showCreate); haptic(); }}
          title="Add task to ${col.title}"
        >+</button>
      </div>
      <div class="kanban-cards">
        ${showCreate && html`
          <input
            ref=${inputRef}
            class="kanban-inline-create"
            placeholder="Task title…"
            onKeyDown=${handleInlineKeyDown}
            onBlur=${() => setShowCreate(false)}
          />
        `}
        ${tasks.length
          ? tasks.map((task) => html`
              <${KanbanCard} key=${task.id} task=${task} onOpen=${onOpen} />
            `)
          : html`<div class="kanban-empty-col">Drop tasks here</div>`
        }
      </div>
      <div class="kanban-scroll-fade"></div>
    </div>
  `;
}

/* ─── KanbanBoard (main export) ─── */
export function KanbanBoard({ onOpenTask }) {
  const cols = columnData.value;

  return html`
    <div class="kanban-board">
      ${COLUMNS.map((col) => html`
        <${KanbanColumn}
          key=${col.id}
          col=${col}
          tasks=${cols[col.id] || []}
          onOpen=${onOpenTask}
        />
      `)}
    </div>
  `;
}
