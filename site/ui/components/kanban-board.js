/* ─────────────────────────────────────────────────────────────
 *  Kanban Board Component — GitHub Projects-style task board
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useRef, useEffect, useMemo } from "preact/hooks";
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

function matchTaskId(a, b) {
  return String(a) === String(b);
}

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

/* ─── Done tasks (closed GitHub issues) loaded separately ─── */
const doneTasksData = signal([]);

/* ─── Derived column data ─── */
const columnData = computed(() => {
  const tasks = tasksData.value || [];
  const doneTasks = doneTasksData.value || [];
  const cols = {};
  for (const col of COLUMNS) {
    cols[col.id] = [];
  }
  for (const task of tasks) {
    const col = getColumnForStatus(task.status);
    if (cols[col]) cols[col].push(task);
  }
  // Merge done tasks, deduplicating by id
  const seenIds = new Set(cols.done.map((t) => String(t.id)));
  for (const task of doneTasks) {
    if (!seenIds.has(String(task.id))) cols.done.push(task);
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
let _touchDragReady = false;
let _touchHoldTimer = null;
let _touchSuppressClickUntil = 0;

const TOUCH_DRAG_DELAY_MS = 180;
const TOUCH_DRAG_START_PX = 6;
const TOUCH_CANCEL_PX = 14;

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

function _clearTouchHoldTimer() {
  if (_touchHoldTimer) {
    clearTimeout(_touchHoldTimer);
    _touchHoldTimer = null;
  }
}

function _setTouchDragActive(active) {
  if (typeof document === "undefined") return;
  document.body.classList.toggle("kanban-dragging", active);
}

function _columnFromPoint(x, y) {
  const elements = document.elementsFromPoint
    ? document.elementsFromPoint(x, y)
    : [document.elementFromPoint(x, y)].filter(Boolean);
  for (const el of elements) {
    if (!el?.closest) continue;
    const colEl = el.closest(".kanban-column");
    if (!colEl) continue;
    for (const col of COLUMNS) {
      if (colEl.getAttribute("data-col") === col.id) return col.id;
    }
  }
  return null;
}

async function _handleTouchDrop(colId) {
  const taskId = touchDragId.value;
  touchDragId.value = null;
  touchOverCol.value = null;
  if (!taskId || !colId) return;

  const currentTask = (tasksData.value || []).find((t) => matchTaskId(t.id, taskId));
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
          matchTaskId(t.id, taskId) ? { ...t, status: newStatus } : t,
        );
      },
      async () => {
        const res = await apiFetch("/api/tasks/update", {
          method: "POST",
          body: JSON.stringify({ taskId, status: newStatus }),
        });
        if (res?.data) {
          tasksData.value = tasksData.value.map((t) =>
            matchTaskId(t.id, taskId) ? { ...t, ...res.data } : t,
          );
        }
        return res;
      },
      () => {
        tasksData.value = prev;
      },
    );
    showToast(`Moved to ${col ? col.title : colId}`, "success");
    // Force refresh from server to ensure consistency
    setTimeout(() => loadTasks(), 500);
  } catch (err) {
    showToast(err?.message || "Failed to move task", "error");
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
  }, [task.id]);

  /* ─ Touch drag handlers ─ */
  const onTouchStart = useCallback((e) => {
    const touch = e.touches[0];
    if (!touch || e.touches.length > 1) return;
    _touchStartX = touch.clientX;
    _touchStartY = touch.clientY;
    _touchMoved = false;
    _touchDragReady = false;
    _clearTouchHoldTimer();
    _touchHoldTimer = setTimeout(() => {
      _touchDragReady = true;
      _touchHoldTimer = null;
    }, TOUCH_DRAG_DELAY_MS);
  }, [task.id]);

  const onTouchMove = useCallback((e) => {
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - _touchStartX;
    const dy = touch.clientY - _touchStartY;

    // Only start drag after a small threshold to distinguish from scroll
    const movedFar = Math.abs(dx) > TOUCH_CANCEL_PX || Math.abs(dy) > TOUCH_CANCEL_PX;
    if (!_touchDragReady) {
      if (movedFar) {
        _clearTouchHoldTimer();
        touchDragId.value = null;
        touchOverCol.value = null;
      }
      return;
    }

    if (!_touchMoved && Math.abs(dx) < TOUCH_DRAG_START_PX && Math.abs(dy) < TOUCH_DRAG_START_PX) return;

    if (!_touchMoved) {
      _touchMoved = true;
      touchDragId.value = task.id;
      _removeTouchClone();
      _touchClone = _createTouchClone(e.currentTarget);
      _setTouchDragActive(true);
      haptic("medium");
    }

    e.preventDefault(); // prevent scroll during drag
    _moveTouchClone(_touchClone, touch.clientX, touch.clientY);

    const colId = _columnFromPoint(touch.clientX, touch.clientY);
    touchOverCol.value = colId;
  }, []);

  const onTouchEnd = useCallback((e) => {
    _clearTouchHoldTimer();
    const colId = touchOverCol.value;
    _removeTouchClone();
    if (_touchMoved) {
      _touchSuppressClickUntil = Date.now() + 350;
      if (e?.preventDefault) e.preventDefault();
    }
    if (_touchMoved && colId) {
      _handleTouchDrop(colId);
    } else {
      touchDragId.value = null;
      touchOverCol.value = null;
    }
    _touchMoved = false;
    _touchDragReady = false;
    _setTouchDragActive(false);
  }, []);

  const onTouchCancel = useCallback(() => {
    _clearTouchHoldTimer();
    _removeTouchClone();
    touchDragId.value = null;
    touchOverCol.value = null;
    _touchMoved = false;
    _touchDragReady = false;
    _setTouchDragActive(false);
  }, []);

  const priorityColor = PRIORITY_COLORS[task.priority] || null;
  const priorityLabel = PRIORITY_LABELS[task.priority] || null;
  const tags = getTaskTags(task);
  const baseBranch = getTaskBaseBranch(task);
  const repoName = task.repo || task.repository || "";
  const issueNum = task.issueNumber || task.issue_number || (typeof task.id === "string" && /^\d+$/.test(task.id) ? task.id : null);

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
      onClick=${() => {
        if (Date.now() < _touchSuppressClickUntil) return;
        onOpen(task.id);
      }}
    >
      <div class="kanban-card-header">
        ${repoName && html`
          <span class="kanban-card-repo">${repoName}</span>
        `}
        ${(issueNum || task.pr) && html`
          <span class="kanban-card-issue">${task.pr ? `#${task.pr}` : `#${issueNum}`}</span>
        `}
        ${priorityLabel && html`
          <span class="kanban-card-badge" style="background:${priorityColor}">${priorityLabel}</span>
        `}
      </div>
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
        ${task.assignee && html`<span class="kanban-card-assignee" title=${task.assignee}>${task.assignee.split("-")[0]}</span>`}
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

    const currentTask = (tasksData.value || []).find((t) => matchTaskId(t.id, taskId));
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
            matchTaskId(t.id, taskId) ? { ...t, status: newStatus } : t,
          );
        },
        async () => {
          const res = await apiFetch("/api/tasks/update", {
            method: "POST",
            body: JSON.stringify({ taskId, status: newStatus }),
          });
          if (res?.data) {
          tasksData.value = tasksData.value.map((t) =>
            matchTaskId(t.id, taskId) ? { ...t, ...res.data } : t,
          );
        }
          return res;
        },
        () => {
          tasksData.value = prev;
        },
      );
      showToast(`Moved to ${col.title}`, "success");
      // Force refresh from server to ensure consistency
      setTimeout(() => loadTasks(), 500);
    } catch (err) {
      showToast(err?.message || "Failed to move task", "error");
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

/* ─── KanbanFilter ─── */
function KanbanFilter({ tasks, filters, onFilterChange }) {
  const repos = useMemo(() => {
    const set = new Set();
    (tasks || []).forEach((t) => {
      if (t.repo || t.repository) set.add(t.repo || t.repository);
    });
    return [...set].sort();
  }, [tasks]);

  const assignees = useMemo(() => {
    const set = new Set();
    (tasks || []).forEach((t) => {
      if (t.assignee) set.add(t.assignee);
    });
    return [...set].sort();
  }, [tasks]);

  const priorities = ["critical", "high", "medium", "low"];

  const [showDropdown, setShowDropdown] = useState(null);

  const toggleDropdown = useCallback((name) => {
    setShowDropdown((prev) => (prev === name ? null : name));
  }, []);

  const setFilter = useCallback((key, value) => {
    onFilterChange({ ...filters, [key]: value });
    setShowDropdown(null);
  }, [filters, onFilterChange]);

  const clearAll = useCallback(() => {
    onFilterChange({ repo: "", assignee: "", priority: "", search: "" });
    setShowDropdown(null);
  }, [onFilterChange]);

  const hasFilters = filters.repo || filters.assignee || filters.priority || filters.search;

  return html`
    <div class="kanban-filter-bar">
      <div class="kanban-filter-search">
        <span class="kanban-filter-icon">🔍</span>
        <input
          type="text"
          class="kanban-filter-input"
          placeholder="Filter by keyword or field"
          value=${filters.search || ""}
          onInput=${(e) => onFilterChange({ ...filters, search: e.target.value })}
        />
      </div>
      <div class="kanban-filter-chips">
        ${repos.length > 1 && html`
          <div class="kanban-filter-dropdown-wrap">
            <button
              class="kanban-filter-chip ${filters.repo ? 'active' : ''}"
              onClick=${() => toggleDropdown("repo")}
            >
              📦 ${filters.repo || "Repository"}
            </button>
            ${showDropdown === "repo" && html`
              <div class="kanban-filter-dropdown">
                <button class="kanban-filter-option ${!filters.repo ? 'selected' : ''}" onClick=${() => setFilter("repo", "")}>All repositories</button>
                ${repos.map((r) => html`
                  <button class="kanban-filter-option ${filters.repo === r ? 'selected' : ''}" onClick=${() => setFilter("repo", r)}>${r}</button>
                `)}
              </div>
            `}
          </div>
        `}
        <div class="kanban-filter-dropdown-wrap">
          <button
            class="kanban-filter-chip ${filters.priority ? 'active' : ''}"
            onClick=${() => toggleDropdown("priority")}
          >
            ◉ ${filters.priority ? PRIORITY_LABELS[filters.priority] || filters.priority : "Priority"}
          </button>
          ${showDropdown === "priority" && html`
            <div class="kanban-filter-dropdown">
              <button class="kanban-filter-option ${!filters.priority ? 'selected' : ''}" onClick=${() => setFilter("priority", "")}>All priorities</button>
              ${priorities.map((p) => html`
                <button class="kanban-filter-option ${filters.priority === p ? 'selected' : ''}" onClick=${() => setFilter("priority", p)}>
                  <span class="kanban-card-priority" style="background:${PRIORITY_COLORS[p]}"></span>
                  ${p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              `)}
            </div>
          `}
        </div>
        ${assignees.length > 0 && html`
          <div class="kanban-filter-dropdown-wrap">
            <button
              class="kanban-filter-chip ${filters.assignee ? 'active' : ''}"
              onClick=${() => toggleDropdown("assignee")}
            >
              👤 ${filters.assignee || "Assignee"}
            </button>
            ${showDropdown === "assignee" && html`
              <div class="kanban-filter-dropdown">
                <button class="kanban-filter-option ${!filters.assignee ? 'selected' : ''}" onClick=${() => setFilter("assignee", "")}>All assignees</button>
                ${assignees.map((a) => html`
                  <button class="kanban-filter-option ${filters.assignee === a ? 'selected' : ''}" onClick=${() => setFilter("assignee", a)}>${a}</button>
                `)}
              </div>
            `}
          </div>
        `}
        ${hasFilters && html`
          <button class="kanban-filter-chip clear" onClick=${clearAll}>✕ Clear</button>
        `}
      </div>
    </div>
  `;
}

/* ─── KanbanBoard (main export) ─── */
export function KanbanBoard({ onOpenTask }) {
  const [filters, setFilters] = useState({ repo: "", assignee: "", priority: "", search: "" });
  const allTasks = tasksData.value || [];

  // Fetch recently-done (closed) tasks separately — GitHub Issues mode closes issues
  // instead of labelling them, so they never appear in the default open-issues fetch.
  useEffect(() => {
    let cancelled = false;
    const fetchDone = async () => {
      try {
        const res = await apiFetch("/api/tasks?status=done&pageSize=50", { _silent: true });
        if (!cancelled) {
          doneTasksData.value = Array.isArray(res?.data) ? res.data : [];
        }
      } catch {
        // non-critical — Done column just shows empty
      }
    };
    fetchDone().catch(() => {});
    // Re-fetch done tasks every 5 minutes while board is visible
    const timer = setInterval(() => { fetchDone().catch(() => {}); }, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const filteredTasks = useMemo(() => {
    let tasks = allTasks;
    if (filters.repo) tasks = tasks.filter((t) => (t.repo || t.repository) === filters.repo);
    if (filters.assignee) tasks = tasks.filter((t) => t.assignee === filters.assignee);
    if (filters.priority) tasks = tasks.filter((t) => t.priority === filters.priority);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      tasks = tasks.filter((t) =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.id || "").toString().toLowerCase().includes(q) ||
        (t.repo || "").toLowerCase().includes(q) ||
        (t.assignee || "").toLowerCase().includes(q)
      );
    }
    return tasks;
  }, [allTasks, filters]);

  const doneTasks = doneTasksData.value || [];

  const cols = useMemo(() => {
    const result = {};
    for (const col of COLUMNS) result[col.id] = [];
    for (const task of filteredTasks) {
      const col = getColumnForStatus(task.status);
      if (result[col]) result[col].push(task);
    }
    // Merge separately-fetched done/closed tasks into the Done column,
    // applying the same filters and deduplicating by id.
    const seenIds = new Set(result.done.map((t) => String(t.id)));
    let filteredDone = doneTasks;
    if (filters.repo) filteredDone = filteredDone.filter((t) => (t.repo || t.repository) === filters.repo);
    if (filters.assignee) filteredDone = filteredDone.filter((t) => t.assignee === filters.assignee);
    if (filters.priority) filteredDone = filteredDone.filter((t) => t.priority === filters.priority);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      filteredDone = filteredDone.filter((t) =>
        (t.title || "").toLowerCase().includes(q) ||
        (t.id || "").toString().toLowerCase().includes(q) ||
        (t.repo || "").toLowerCase().includes(q) ||
        (t.assignee || "").toLowerCase().includes(q)
      );
    }
    for (const task of filteredDone) {
      if (!seenIds.has(String(task.id))) result.done.push(task);
    }
    return result;
  }, [filteredTasks, doneTasks, filters]);

  return html`
    <div class="kanban-container">
      <${KanbanFilter} tasks=${allTasks} filters=${filters} onFilterChange=${setFilters} />
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
    </div>
  `;
}
