/* ─────────────────────────────────────────────────────────────
 *  Kanban Board Component — GitHub Projects-style task board
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useRef, useEffect, useMemo } from "preact/hooks";
import htm from "htm";
import { signal, computed } from "@preact/signals";
import {
  tasksData,
  tasksLoaded,
  showToast,
  runOptimistic,
  loadTasks,
  normalizeTaskLifecycleStatus,
  classifyTaskLifecycleAction,
} from "../modules/state.js";
import { apiFetch } from "../modules/api.js";
import { haptic, showConfirm } from "../modules/telegram.js";
import { formatRelative, truncate, cloneValue } from "../modules/utils.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import { getAgentDisplay } from "../modules/agent-display.js";
import { Card, CardContent, Chip, IconButton, TextField, InputAdornment, Typography, Box, Stack, Button, Menu, MenuItem, Paper, Tooltip, Badge } from "@mui/material";

const html = htm.bind(h);

/* ─── Column definitions ─── */
const COLUMN_MAP = {
  draft: ["draft"],
  backlog: ["backlog", "open", "new", "todo"],
  blocked: ["blocked", "error", "failed"],
  inProgress: ["in-progress", "inprogress", "working", "active", "assigned"],
  inReview: ["in-review", "inreview", "review", "pr-open", "pr-review"],
  done: ["done", "completed", "closed", "merged", "cancelled"],
};

const COLUMNS = [
  { id: "draft", title: "Drafts", icon: "\u{1F4DD}", color: "var(--color-warning, #f59e0b)" },
  { id: "backlog", title: "Backlog", icon: "\u{1F4CB}", color: "var(--text-secondary)" },
  { id: "blocked", title: "Blocked", icon: "\u26D4", color: "var(--color-error, #ef4444)" },
  { id: "inProgress", title: "In Progress", icon: "\u{1F528}", color: "var(--color-inprogress, #3b82f6)" },
  { id: "inReview", title: "In Review", icon: "\u{1F440}", color: "var(--color-inreview, #f59e0b)" },
  { id: "done", title: "Done", icon: "\u2705", color: "var(--color-done, #22c55e)" },
];

const COLUMN_TO_STATUS = {
  draft: "draft",
  backlog: "todo",
  blocked: "blocked",
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

const LOAD_MORE_THRESHOLD_PX = 140;
const KANBAN_BOARD_FILTER_SCHEMA_VERSION = 1;
const KANBAN_BOARD_FILTER_STORAGE_PREFIX = "ve-kanban-board-filters";
const KANBAN_BOARD_FILTER_LEGACY_KEY = "ve-kanban-board-filters";
const KANBAN_BOARD_GLOBAL_SCOPE = "global";
const DEFAULT_BOARD_FILTERS = Object.freeze({ repo: "", assignee: "", priority: "", search: "" });
const BOARD_FILTER_KEYS = ["repo", "assignee", "priority", "search"];
const ALLOWED_PRIORITIES = new Set(["critical", "high", "medium", "low"]);

function matchTaskId(a, b) {
  return String(a) === String(b);
}

function getBoardFilterStorage(storage) {
  if (storage && typeof storage.getItem === "function" && typeof storage.setItem === "function") return storage;
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

export function normalizeBoardWorkspaceScope(workspaceId) {
  const raw = String(workspaceId || "").trim();
  return raw || KANBAN_BOARD_GLOBAL_SCOPE;
}

export function buildBoardFilterStorageKey(workspaceId) {
  return `${KANBAN_BOARD_FILTER_STORAGE_PREFIX}:${normalizeBoardWorkspaceScope(workspaceId)}`;
}

function trimFilterValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function sanitizeBoardFilters(filters, options = {}) {
  const raw = filters && typeof filters === "object" ? filters : {};
  const result = { ...DEFAULT_BOARD_FILTERS };
  for (const key of BOARD_FILTER_KEYS) {
    result[key] = trimFilterValue(raw[key]);
  }

  if (!ALLOWED_PRIORITIES.has(result.priority)) result.priority = "";

  const repoSet = options?.allowedRepos instanceof Set ? options.allowedRepos : null;
  const assigneeSet = options?.allowedAssignees instanceof Set ? options.allowedAssignees : null;
  if (repoSet && result.repo && !repoSet.has(result.repo)) result.repo = "";
  if (assigneeSet && result.assignee && !assigneeSet.has(result.assignee)) result.assignee = "";
  return result;
}

function areBoardFiltersEqual(a, b) {
  return (
    String(a?.repo || "") === String(b?.repo || "") &&
    String(a?.assignee || "") === String(b?.assignee || "") &&
    String(a?.priority || "") === String(b?.priority || "") &&
    String(a?.search || "") === String(b?.search || "")
  );
}

function readRawPersistedBoardFilters(storage, key) {
  const raw = storage?.getItem?.(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== KANBAN_BOARD_FILTER_SCHEMA_VERSION) return null;
    if (!parsed.filters || typeof parsed.filters !== "object") return null;
    return parsed.filters;
  } catch {
    return null;
  }
}

export function readPersistedBoardFilters({ storage, workspaceId, validateWith } = {}) {
  const resolvedStorage = getBoardFilterStorage(storage);
  if (!resolvedStorage) return { ...DEFAULT_BOARD_FILTERS };

  const scopedKey = buildBoardFilterStorageKey(workspaceId);
  let rawFilters = readRawPersistedBoardFilters(resolvedStorage, scopedKey);
  if (!rawFilters) {
    rawFilters = readRawPersistedBoardFilters(resolvedStorage, KANBAN_BOARD_FILTER_LEGACY_KEY);
  }
  return sanitizeBoardFilters(rawFilters || DEFAULT_BOARD_FILTERS, validateWith);
}

export function persistBoardFilters({ storage, workspaceId, filters } = {}) {
  const resolvedStorage = getBoardFilterStorage(storage);
  if (!resolvedStorage) return false;
  const payload = {
    version: KANBAN_BOARD_FILTER_SCHEMA_VERSION,
    workspace: normalizeBoardWorkspaceScope(workspaceId),
    filters: sanitizeBoardFilters(filters),
  };
  try {
    resolvedStorage.setItem(buildBoardFilterStorageKey(workspaceId), JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
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

function getTaskBlockedPreview(task) {
  const direct = String(
    task?.blockedReason ||
    task?.meta?.worktreeFailure?.blockedReason ||
    task?.meta?.blockedContext?.summary ||
    "",
  ).trim();
  if (direct) return direct;
  const timeline = Array.isArray(task?.timeline) ? task.timeline : [];
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const message = String(
      timeline[index]?.message ||
      timeline[index]?.reason ||
      timeline[index]?.error ||
      "",
    ).trim();
    if (/worktree failed|pre-pr validation failed|blocked/i.test(message)) {
      return message;
    }
  }
  return "";
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


async function confirmBoardTaskTransition(task, newStatus) {
  const prev = normalizeTaskLifecycleStatus(task?.status || "todo");
  const next = normalizeTaskLifecycleStatus(newStatus);
  const action = classifyTaskLifecycleAction(prev, next);
  const taskLabel = String(task?.title || task?.id || "this task").trim();

  if (action === "start") {
    const ok = await showConfirm(
      `Start ${taskLabel} now? This dispatches or resumes execution immediately.`,
    );
    return { ok, action, nextStatus: "inprogress" };
  }

  if (action === "pause") {
    const ok = await showConfirm(
      `Pause ${taskLabel} and move it back to backlog? You can resume by moving it to In Progress again.`,
    );
    return { ok, action, nextStatus: next === "draft" ? "draft" : "todo" };
  }

  return { ok: true, action, nextStatus: next };
}

async function executeBoardTransition(task, newStatus, columnLabel) {
  if (!task?.id) return { ok: false, cancelled: true, action: "noop" };
  const decision = await confirmBoardTaskTransition(task, newStatus);
  if (!decision.ok) return { ok: false, cancelled: true, action: decision.action };

  const taskId = task.id;
  const wantsDraft = decision.nextStatus === "draft";
  const optimisticStatus = decision.action === "start" ? "inprogress" : decision.nextStatus;
  const prev = cloneValue(tasksData.value);

  await runOptimistic(
    () => {
      tasksData.value = tasksData.value.map((t) =>
        matchTaskId(t.id, taskId) ? { ...t, status: optimisticStatus, draft: wantsDraft } : t,
      );
    },
    async () => {
      if (decision.action === "start") {
        const startRes = await apiFetch("/api/tasks/start", {
          method: "POST",
          body: JSON.stringify({ taskId }),
        });
        const detail = await apiFetch(
          `/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
          { _silent: true },
        ).catch(() => null);
        const merged = detail?.data || startRes?.data || null;
        if (merged) {
          tasksData.value = tasksData.value.map((t) =>
            matchTaskId(t.id, taskId) ? { ...t, ...merged } : t,
          );
        }
        return startRes;
      }

      const res = await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({
          taskId,
          status: decision.nextStatus,
          draft: wantsDraft,
          lifecycleAction: decision.action,
          pauseExecution: decision.action === "pause",
        }),
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

  showToast(`Moved to ${columnLabel || "updated status"}`, "success");
  setTimeout(() => loadTasks(), 500);
  return { ok: true, cancelled: false, action: decision.action, status: optimisticStatus };
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

  try {
    await executeBoardTransition(currentTask, newStatus, col?.title || colId);
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
  const blockedPreview = getTaskBlockedPreview(task);
  const repoName = task.repo || task.repository || "";
  const issueNum = task.issueNumber || task.issue_number || (typeof task.id === "string" && /^\d+$/.test(task.id) ? task.id : null);
  const hasAgent = Boolean(
    task?.assignee ||
    task?.meta?.execution?.sdk ||
    task?.meta?.execution?.executor ||
    task?.sdk ||
    task?.executor ||
    task?.agent ||
    task?.agentName,
  );
  const agentDisplay = hasAgent ? getAgentDisplay(task) : null;

  const isDragging = dragTaskId.value === task.id || (touchDragId.value === task.id && _touchMoved);

  return html`
    <${Card}
      className=${`kanban-card ${isDragging ? "dragging" : ""}`}
      sx=${{
        cursor: 'pointer',
        mb: 1,
        opacity: isDragging ? 0.5 : 1,
        transition: 'box-shadow 0.2s, opacity 0.2s',
        '&:hover': { boxShadow: 3 },
      }}
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
      <${CardContent} sx=${{ p: '10px !important', '&:last-child': { pb: '10px !important' } }}>
        <${Stack} direction="row" spacing=${0.5} alignItems="center" flexWrap="wrap" sx=${{ mb: 0.5 }}>
          ${repoName && html`
            <${Typography} variant="caption" color="text.secondary">${repoName}</${Typography}>
          `}
          ${(issueNum || task.pr) && html`
            <${Typography} variant="caption" color="text.secondary">${task.pr ? '#' + task.pr : '#' + issueNum}</${Typography}>
          `}
          ${priorityLabel && html`
            <${Chip} label=${priorityLabel} size="small" sx=${{ backgroundColor: priorityColor, color: '#fff', height: 18, fontSize: '0.65rem' }} />
          `}
        </${Stack}>
        <${Typography} variant="body2" fontWeight=${500}>${truncate(task.title || "(untitled)", 80)}</${Typography}>
        ${task.description && html`
          <${Typography} variant="caption" color="text.secondary" sx=${{ display: 'block', mt: 0.5 }}>${truncate(task.description, 72)}</${Typography}>
        `}
        ${String(task?.status || "").toLowerCase() === "blocked" && html`
          <${Typography} variant="caption" sx=${{ display: 'block', mt: 0.5, color: 'var(--color-error, #ef4444)', fontWeight: 600 }}>
            ${truncate(blockedPreview || "Blocked task. Open details for diagnostics.", 96)}
          </${Typography}>
        `}
        ${baseBranch && html`
          <${Typography} variant="caption" color="text.secondary" sx=${{ display: 'block', mt: 0.5 }}>Base: ${truncate(baseBranch, 24)}</${Typography}>
        `}
        ${tags.length > 0 && html`
          <${Stack} direction="row" spacing=${0.5} flexWrap="wrap" sx=${{ mt: 0.5 }}>
            ${tags.map((tag) => html`<${Chip} key=${tag} label=${'#' + tag} size="small" variant="outlined" sx=${{ height: 20, fontSize: '0.65rem' }} />`)}
          </${Stack}>
        `}
        <${Stack} direction="row" spacing=${0.5} alignItems="center" sx=${{ mt: 0.5 }}>
          ${agentDisplay && html`
            <${Tooltip} title=${agentDisplay.label}>
              <span>${agentDisplay.icon}</span>
            </${Tooltip}>
          `}
          <${Typography} variant="caption" color="text.secondary">${typeof task.id === "string" ? truncate(task.id, 12) : task.id}</${Typography}>
          ${task.created_at && html`<${Typography} variant="caption" color="text.secondary">${formatRelative(task.created_at)}</${Typography}>`}
        </${Stack}>
      </${CardContent}>
    </${Card}>
  `;
}

/* ─── KanbanColumn ─── */
function KanbanColumn({
  col,
  tasks,
  onOpen,
  totalCount = 0,
  hasMoreTasks = false,
  loadingMoreTasks = false,
  onLoadMoreTasks = null,
}) {
  const [showCreate, setShowCreate] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (showCreate && inputRef.current) inputRef.current.focus();
  }, [showCreate]);

  const onCardsScroll = useCallback((event) => {
    const el = event?.currentTarget;
    if (!el) return;
    const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (remaining > LOAD_MORE_THRESHOLD_PX) return;
    if (!hasMoreTasks || loadingMoreTasks || typeof onLoadMoreTasks !== "function") return;
    void onLoadMoreTasks();
  }, [hasMoreTasks, loadingMoreTasks, onLoadMoreTasks]);

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
  const countLabel = Number.isFinite(Number(totalCount)) && Number(totalCount) > 0
    ? Number(totalCount)
    : (hasMoreTasks ? `${tasks.length}+` : tasks.length);

  return html`
    <div
      class="kanban-column ${isOver ? 'drag-over' : ''}"
      data-col=${col.id}
      onDragOver=${onDragOver}
      onDragLeave=${onDragLeave}
      onDrop=${onDrop}
    >
      <${Box} className="kanban-column-head" sx=${{ display: 'flex', alignItems: 'center', gap: 1, p: 1, borderBottom: '2px solid ' + col.color }}>
        <${Typography} variant="subtitle2">${col.icon} ${col.title}</${Typography}>
        <${Chip} label=${countLabel} size="small" />
        <${IconButton} size="small" onClick=${() => { setShowCreate(!showCreate); haptic(); }} title=${"Add task to " + col.title}>+</${IconButton}>
      </${Box}>
      <div class="kanban-cards" onScroll=${onCardsScroll}>
        ${showCreate && html`
          <${TextField}
            inputRef=${inputRef}
            fullWidth
            size="small"
            placeholder="Task title…"
            onKeyDown=${handleInlineKeyDown}
            onBlur=${() => setShowCreate(false)}
            sx=${{ mb: 1 }}
          />
        `}
        ${tasks.length
          ? tasks.map((task) => html`
              <${KanbanCard} key=${task.id} task=${task} onOpen=${onOpen} />
            `)
          : html`<${Typography} variant="body2" color="text.secondary" sx=${{ textAlign: 'center', py: 2 }}>Drop tasks here</${Typography}>`
        }
        ${hasMoreTasks && html`
          <div class="kanban-tail-sentinel"></div>
          <div class="kanban-load-more">${loadingMoreTasks ? "Loading more tasks..." : "Scroll down to load more"}</div>
        `}
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

  const setFilter = useCallback((key, value) => {
    onFilterChange({ ...filters, [key]: value });
    setShowDropdown(null);
    setAnchorEl(null);
  }, [filters, onFilterChange]);

  const clearAll = useCallback(() => {
    onFilterChange({ repo: "", assignee: "", priority: "", search: "" });
    setShowDropdown(null);
    setAnchorEl(null);
  }, [onFilterChange]);

  const hasFilters = filters.repo || filters.assignee || filters.priority || filters.search;

  const [anchorEl, setAnchorEl] = useState(null);

  const handleDropdownClick = useCallback((name, event) => {
    if (showDropdown === name) {
      setShowDropdown(null);
      setAnchorEl(null);
    } else {
      setShowDropdown(name);
      setAnchorEl(event.currentTarget);
    }
  }, [showDropdown]);

  const handleMenuClose = useCallback(() => {
    setShowDropdown(null);
    setAnchorEl(null);
  }, []);

  return html`
    <${Box} className="kanban-filter-bar" sx=${{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', p: 1 }}>
      <${TextField}
        size="small"
        placeholder="Filter by keyword or field"
        value=${filters.search || ""}
        onInput=${(e) => onFilterChange({ ...filters, search: e.target.value })}
        InputProps=${{
          startAdornment: html`<${InputAdornment} position="start">${resolveIcon(":search:")}</${InputAdornment}>`,
        }}
        sx=${{ minWidth: 220 }}
      />
      <${Stack} direction="row" spacing=${0.5} alignItems="center" flexWrap="wrap">
        ${repos.length > 1 && html`
          <${Chip}
            label=${iconText(':box: ' + (filters.repo || 'Repository'))}
            variant=${filters.repo ? 'filled' : 'outlined'}
            onClick=${(e) => handleDropdownClick("repo", e)}
            onDelete=${filters.repo ? () => setFilter("repo", "") : undefined}
            size="small"
          />
          <${Menu}
            anchorEl=${showDropdown === "repo" ? anchorEl : null}
            open=${showDropdown === "repo"}
            onClose=${handleMenuClose}
          >
            <${MenuItem} selected=${!filters.repo} onClick=${() => setFilter("repo", "")}>All repositories</${MenuItem}>
            ${repos.map((r) => html`
              <${MenuItem} key=${r} selected=${filters.repo === r} onClick=${() => setFilter("repo", r)}>${r}</${MenuItem}>
            `)}
          </${Menu}>
        `}
        <${Chip}
          label=${'◉ ' + (filters.priority ? (PRIORITY_LABELS[filters.priority] || filters.priority) : 'Priority')}
          variant=${filters.priority ? 'filled' : 'outlined'}
          onClick=${(e) => handleDropdownClick("priority", e)}
          onDelete=${filters.priority ? () => setFilter("priority", "") : undefined}
          size="small"
        />
        <${Menu}
          anchorEl=${showDropdown === "priority" ? anchorEl : null}
          open=${showDropdown === "priority"}
          onClose=${handleMenuClose}
        >
          <${MenuItem} selected=${!filters.priority} onClick=${() => setFilter("priority", "")}>All priorities</${MenuItem}>
          ${priorities.map((p) => html`
            <${MenuItem} key=${p} selected=${filters.priority === p} onClick=${() => setFilter("priority", p)}>
              <${Box} component="span" sx=${{ width: 10, height: 10, borderRadius: '50%', backgroundColor: PRIORITY_COLORS[p], display: 'inline-block', mr: 1 }} />
              ${p.charAt(0).toUpperCase() + p.slice(1)}
            </${MenuItem}>
          `)}
        </${Menu}>
        ${assignees.length > 0 && html`
          <${Chip}
            label=${iconText(':user: ' + (filters.assignee || 'Assignee'))}
            variant=${filters.assignee ? 'filled' : 'outlined'}
            onClick=${(e) => handleDropdownClick("assignee", e)}
            onDelete=${filters.assignee ? () => setFilter("assignee", "") : undefined}
            size="small"
          />
          <${Menu}
            anchorEl=${showDropdown === "assignee" ? anchorEl : null}
            open=${showDropdown === "assignee"}
            onClose=${handleMenuClose}
          >
            <${MenuItem} selected=${!filters.assignee} onClick=${() => setFilter("assignee", "")}>All assignees</${MenuItem}>
            ${assignees.map((a) => html`
              <${MenuItem} key=${a} selected=${filters.assignee === a} onClick=${() => setFilter("assignee", a)}>${a}</${MenuItem}>
            `)}
          </${Menu}>
        `}
        ${hasFilters && html`
          <${Chip} label="✕ Clear" size="small" onClick=${clearAll} onDelete=${clearAll} />
        `}
      </${Stack}>
    </${Box}>
  `;
}

/* ─── KanbanBoard (main export) ─── */
export function KanbanBoard({ onOpenTask, hasMoreTasks = false, loadingMoreTasks = false, onLoadMoreTasks = null, columnTotals = {}, totalTasks = 0, workspaceId = "" }) {
  const workspaceScope = normalizeBoardWorkspaceScope(workspaceId);
  const [filters, setFilters] = useState(() => readPersistedBoardFilters({ workspaceId: workspaceScope }));
  const allTasks = tasksData.value || [];
  const boardTasksLoaded = Boolean(tasksLoaded.value);
  const knownRepos = useMemo(() => {
    const repos = new Set();
    for (const task of allTasks) {
      const repoName = String(task?.repo || task?.repository || "").trim();
      if (repoName) repos.add(repoName);
    }
    return repos;
  }, [allTasks]);
  const knownAssignees = useMemo(() => {
    const assignees = new Set();
    for (const task of allTasks) {
      const assignee = String(task?.assignee || "").trim();
      if (assignee) assignees.add(assignee);
    }
    return assignees;
  }, [allTasks]);

  useEffect(() => {
    const hydrated = readPersistedBoardFilters({ workspaceId: workspaceScope });
    setFilters((prev) => (areBoardFiltersEqual(prev, hydrated) ? prev : hydrated));
  }, [workspaceScope]);

  useEffect(() => {
    if (!boardTasksLoaded) return;
    setFilters((prev) => {
      const sanitized = sanitizeBoardFilters(prev, {
        allowedRepos: knownRepos,
        allowedAssignees: knownAssignees,
      });
      return areBoardFiltersEqual(prev, sanitized) ? prev : sanitized;
    });
  }, [boardTasksLoaded, knownRepos, knownAssignees]);

  useEffect(() => {
    persistBoardFilters({ workspaceId: workspaceScope, filters });
  }, [workspaceScope, filters]);

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

  const cols = useMemo(() => {
    const result = {};
    for (const col of COLUMNS) result[col.id] = [];
    for (const task of filteredTasks) {
      const col = getColumnForStatus(task.status);
      if (result[col]) result[col].push(task);
    }
    return result;
  }, [filteredTasks]);

  return html`
    <${Box} className="kanban-container">
      <${KanbanFilter} tasks=${allTasks} filters=${filters} onFilterChange=${setFilters} />
      <${Box} sx=${{ px: 1, pb: 0.5, color: "text.secondary", fontSize: 12 }}>Total tasks: ${Number.isFinite(Number(totalTasks)) && Number(totalTasks) > 0 ? totalTasks : allTasks.length}</${Box}>
      <${Box} className="kanban-board" sx=${{ display: 'flex', gap: 2, overflowX: 'auto', pb: 1 }}>
        ${COLUMNS.map((col) => html`
          <${KanbanColumn}
            key=${col.id}
            col=${col}
            tasks=${cols[col.id] || []}
            totalCount=${columnTotals?.[col.id] ?? (cols[col.id] || []).length}
            hasMoreTasks=${hasMoreTasks}
            loadingMoreTasks=${loadingMoreTasks}
            onLoadMoreTasks=${onLoadMoreTasks}
            onOpen=${onOpenTask}
          />
        `)}
      </${Box}>
    </${Box}>
  `;
}




