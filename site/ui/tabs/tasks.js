/* ─────────────────────────────────────────────────────────────
 *  Tab: Tasks — board, search, filters, task CRUD
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic, showConfirm } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import { signal } from "@preact/signals";
import {
  tasksData,
  tasksLoaded,
  tasksPage,
  tasksPageSize,
  tasksFilter,
  tasksPriority,
  tasksSearch,
  tasksSort,
  tasksTotalPages,
  tasksTotal,
  tasksStatusCounts,
  executorData,
  showToast,
  refreshTab,
  runOptimistic,
  scheduleRefresh,
  loadTasks,
  updateTaskManualState,
  setPendingChange,
  clearPendingChange,
  sanitizeTaskText,
} from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import {
  cloneValue,
  formatRelative,
  truncate,
  formatBytes,
  debounce,
  exportAsCSV,
  exportAsJSON,
  countChangedFields,
} from "../modules/utils.js";
import {
  Modal,
  SaveDiscardBar,
  Card,
  SkeletonCard,
  EmptyState
} from "../components/shared.js";
import {
  SegmentedControl,
  SearchInput,
  Toggle as ImportedToggle,
} from "../components/forms.js";
import { KanbanBoard } from "../components/kanban-board.js";
import { VoiceMicButton, VoiceMicButtonInline } from "../modules/voice.js";
import {
  workspaces as managedWorkspaces,
  activeWorkspaceId,
  loadWorkspaces,
} from "../components/workspace-switcher.js";
import {
  Card as MuiCard, CardContent, Typography, Box, Stack, Chip, TextField, Select,
  MenuItem, Button, IconButton, Tabs, Tab, Tooltip, Divider,
  Paper, CircularProgress, Skeleton, Alert, Switch, FormControlLabel,
  Menu as MuiMenu, Fab, Table, TableBody, TableCell, TableContainer,
  TableHead, TableRow, TableSortLabel, ToggleButton, ToggleButtonGroup, Badge,
} from "@mui/material";

/* ─── View mode toggle ─── */
const viewMode = signal("kanban");
const Toggle = typeof ImportedToggle === "function" ? ImportedToggle : () => null;
const DAG_SPRINT_ENDPOINT_CANDIDATES = [
  "/api/tasks/sprints",
  "/api/tasks/dag/sprints",
  "/api/tasks/dag/index",
];
const DAG_GRAPH_ENDPOINT_CANDIDATES = [
  "/api/tasks/dag",
  "/api/tasks/graph",
  "/api/tasks/dependencies",
];
const DAG_GLOBAL_ENDPOINT_CANDIDATES = [
  "/api/tasks/dag-of-dags",
  "/api/tasks/dag/global",
  "/api/tasks/graph/global",
];
const DAG_EPIC_DEPENDENCY_ENDPOINT_CANDIDATES = [
  "/api/tasks/epic-dependencies",
  "/api/tasks/epics/dependencies",
  "/api/tasks/dag/epics",
];
const EMPTY_DAG_GRAPH = {
  title: "",
  description: "",
  nodes: [],
  edges: [],
};
const DAG_EDGE_STYLES = {
  "depends-on": { color: "var(--accent)", dash: "" },
  dependency: { color: "var(--accent)", dash: "" },
  sequential: { color: "var(--color-warning)", dash: "7 4" },
  sequence: { color: "var(--color-warning)", dash: "7 4" },
  blocks: { color: "var(--color-error)", dash: "2 4" },
};
const DAG_MIN_ZOOM = 0.25;
const DAG_MAX_ZOOM = 2.4;

/* ─── Status/Priority → MUI Chip color ─── */
function statusChipColor(status) {
  const s = String(status || "").toLowerCase();
  if (["inprogress", "running", "working", "active", "assigned", "started"].includes(s)) return "info";
  if (["inreview", "review", "pr-open", "pr-review"].includes(s)) return "warning";
  if (["done", "completed", "merged", "closed"].includes(s)) return "success";
  if (["error", "blocked", "failed", "cancelled"].includes(s)) return "error";
  if (s === "critical") return "error";
  if (s === "high") return "warning";
  if (s === "medium") return "info";
  if (s === "warning" || s === "manual") return "warning";
  return "default";
}

/* ─── Status chip definitions ─── */
const STATUS_CHIPS = [
  { value: "all", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "todo", label: "Todo" },
  { value: "inprogress", label: "Active" },
  { value: "inreview", label: "Review" },
  { value: "done", label: "Done" },
  { value: "error", label: "Error" },
];

const PRIORITY_CHIPS = [
  { value: "", label: "Any" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];

const SORT_OPTIONS = [
  { value: "updated", label: "Updated" },
  { value: "created", label: "Created" },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Title" },
];

/* Maps snapshot-bar labels → tasksFilter values */
const SNAPSHOT_STATUS_MAP = {
  Backlog: "todo",
  Active: "inprogress",
  Review: "inreview",
  Done: "done",
  Errors: "error",
};

const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, "": 4 };

const SYSTEM_TAGS = new Set([
  "draft",
  "todo",
  "inprogress",
  "inreview",
  "done",
  "cancelled",
  "error",
  "blocked",
  "critical",
  "high",
  "medium",
  "low",
  "codex:ignore",
  "codex:claimed",
  "codex:working",
  "codex:stale",
  "bosun",
  "codex-mointor",
]);

const IGNORE_LABEL = "codex:ignore";

function labelMatchesIgnore(label) {
  const name = typeof label === "string" ? label : label?.name || "";
  return String(name || "").trim().toLowerCase() === IGNORE_LABEL;
}

function isTaskManual(task) {
  if (!task) return false;
  if (task.manual === true || task.isIgnored === true) return true;
  if (task.meta?.codex?.isIgnored) return true;
  if (Array.isArray(task?.meta?.labels) && task.meta.labels.some(labelMatchesIgnore))
    return true;
  if (Array.isArray(task?.labels) && task.labels.some(labelMatchesIgnore)) return true;
  return false;
}

function getManualReason(task) {
  return (
    task?.ignoreReason ||
    task?.meta?.codex?.ignoreReason ||
    ""
  );
}

function normalizeTagInput(input) {
  if (!input) return [];
  const values = Array.isArray(input)
    ? input
    : String(input || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const seen = new Set();
  const tags = [];
  for (const value of values) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase();
    if (!normalized || seen.has(normalized) || SYSTEM_TAGS.has(normalized)) continue;
    if (/^(?:upstream|base|target)(?:_branch)?[:=]/i.test(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function getTaskTags(task) {
  if (!task) return [];
  const direct = normalizeTagInput(task.tags || []);
  if (direct.length) return direct;
  const metaTags = normalizeTagInput(task?.meta?.tags || []);
  if (metaTags.length) return metaTags;
  const metaLabels = Array.isArray(task?.meta?.labels)
    ? task.meta.labels.map((label) =>
        typeof label === "string" ? label : label?.name || "",
      )
    : [];
  return normalizeTagInput(metaLabels);
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

function attachmentKey(att) {
  if (!att) return "";
  return att.url || att.filePath || att.relativePath || att.name || "";
}

function normalizeTaskAttachments(task) {
  if (!task) return [];
  const combined = []
    .concat(Array.isArray(task.attachments) ? task.attachments : [])
    .concat(Array.isArray(task.meta?.attachments) ? task.meta.attachments : []);
  const seen = new Set();
  const out = [];
  for (const att of combined) {
    const key = attachmentKey(att);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(att);
  }
  return out;
}

function isBosunStateComment(text) {
  const raw = String(text || "").toLowerCase();
  return raw.includes("bosun-state") || raw.includes("codex:ignore");
}

function normalizeTaskComments(task) {
  if (!task) return [];
  const raw = Array.isArray(task.comments)
    ? task.comments
    : Array.isArray(task.meta?.comments)
      ? task.meta.comments
      : [];
  return raw
    .map((comment) => {
      const body = typeof comment === "string"
        ? comment
        : comment.body || comment.text || comment.content || "";
      const trimmed = String(body || "").trim();
      if (!trimmed || isBosunStateComment(trimmed)) return null;
      return {
        id: comment?.id || null,
        author: comment?.author || comment?.user || comment?.by || null,
        createdAt: comment?.createdAt || comment?.created_at || null,
        body: trimmed,
      };
    })
    .filter(Boolean);
}

function isImageAttachment(att) {
  const kind = String(att?.kind || "").toLowerCase();
  if (kind === "image") return true;
  const type = String(att?.contentType || "").toLowerCase();
  if (type.startsWith("image/")) return true;
  const name = String(att?.name || att?.filename || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/.test(name);
}

function unsavedChangesMessage(changeCount) {
  const count = Math.max(0, Number(changeCount || 0));
  return `You have unsaved changes (${count})`;
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value);
  return [];
}

function toText(value, fallback = "") {
  if (value == null) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function normalizeDagDependencyList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return raw
    .map((item) => toText(item))
    .filter(Boolean);
}


function normalizeDependencyInput(value) {
  const source = Array.isArray(value)
    ? value
    : String(value || "")
        .split(/[\n,]/)
        .flatMap((entry) => String(entry || "").split(/\s+/));
  const seen = new Set();
  const out = [];
  for (const item of source) {
    const normalized = toText(item);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function getTaskDependencyIds(task) {
  const deps = [
    ...(Array.isArray(task?.dependencyTaskIds) ? task.dependencyTaskIds : []),
    ...(Array.isArray(task?.dependsOn) ? task.dependsOn : []),
    ...(Array.isArray(task?.meta?.dependencyTaskIds) ? task.meta.dependencyTaskIds : []),
    ...(Array.isArray(task?.meta?.dependsOn) ? task.meta.dependsOn : []),
  ];
  return normalizeDependencyInput(deps);
}

function getTaskSprintId(task) {
  return toText(task?.sprintId || task?.meta?.sprintId || "");
}

function getTaskSprintOrder(task) {
  const raw = task?.sprintOrder ?? task?.meta?.sprintOrder;
  if (raw == null || raw === "") return "";
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? String(numeric) : "";
}
function pickTaskField(task, keys = []) {
  for (const key of keys) {
    const direct = task?.[key];
    if (direct != null && String(direct).trim() !== "") return direct;
    const meta = task?.meta?.[key];
    if (meta != null && String(meta).trim() !== "") return meta;
  }
  return "";
}

function normalizeTaskAssigneesInput(task) {
  const value = pickTaskField(task, ["assignees"]);
  if (Array.isArray(value)) {
    return value
      .map((entry) => toText(entry?.name || entry))
      .filter(Boolean)
      .join(", ");
  }
  return toText(value);
}

function normalizeTaskDueDateInput(task) {
  const value = toText(pickTaskField(task, ["dueDate", "due", "due_at", "dueAt"]));
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function normalizeSubtasksPayload(raw) {
  const payload = extractDagPayload(raw);
  const rows = toArray(payload?.subtasks || payload?.items || payload?.tasks || payload);
  return rows
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      return {
        id: toText(entry.id || entry.taskId),
        title: toText(entry.title || entry.summary || entry.name, "(untitled subtask)"),
        status: toText(entry.status || entry.state),
        assignee: toText(entry.assignee || entry.owner),
        storyPoints: toText(entry.storyPoints || entry.points),
      };
    })
    .filter((entry) => entry && entry.id);
}

function extractDagPayload(raw) {
  if (raw && typeof raw === "object" && "data" in raw && raw.data != null) {
    return raw.data;
  }
  return raw || {};
}

function normalizeSprintOptions(raw) {
  const payload = extractDagPayload(raw);
  const candidates = [
    payload?.sprints,
    payload?.sprintList,
    payload?.items,
    payload?.data?.sprints,
  ];
  const source = candidates.find(
    (value) => Array.isArray(value) && value.length > 0,
  ) || toArray(payload);
  return source
    .map((entry, index) => {
      if (entry == null) return null;
      if (typeof entry === "string") {
        return { id: entry, label: entry, status: "", goal: "" };
      }
      const id = toText(entry.id || entry.slug || entry.name || `sprint-${index + 1}`);
      if (!id) return null;
      return {
        id,
        label: toText(entry.label || entry.title || entry.name, id),
        status: toText(entry.status),
        goal: toText(entry.goal),
        executionMode: toText(entry.executionMode || entry.taskOrderMode || entry.sprintOrderMode || "parallel", "parallel"),
        taskOrderMode: toText(entry.taskOrderMode || entry.executionMode || entry.sprintOrderMode || "parallel", "parallel"),
      };
    })
    .filter(Boolean);
}

function normalizeDagNode(node, index) {
  const id = toText(
    node?.id || node?.nodeId || node?.taskId || node?.key || `node-${index + 1}`,
  );
  const taskId = toText(node?.taskId || node?.id || node?.task?.id || "");
  const orderRaw =
    node?.sprintOrder ??
    node?.sequence ??
    node?.order ??
    node?.position ??
    node?.index;
  const order = Number.isFinite(Number(orderRaw)) ? Number(orderRaw) : null;
  return {
    id,
    taskId,
    title: toText(node?.title || node?.label || node?.name || taskId || id, "(untitled)"),
    description: toText(node?.description || node?.summary || ""),
    status: toText(node?.status || node?.state || ""),
    priority: toText(node?.priority),
    sprintId: toText(node?.sprintId || node?.sprint || ""),
    order,
    dependencies: normalizeDagDependencyList(
      node?.dependencies ||
        node?.dependsOn ||
        node?.requires ||
        node?.prerequisites,
    ),
  };
}

function normalizeDagGraph(raw, fallbackTitle = "") {
  const payload = extractDagPayload(raw);
  const graph =
    payload?.graph ||
    payload?.dag ||
    payload?.sprintDag ||
    payload?.sprintGraph ||
    payload?.globalDag ||
    payload?.globalGraph ||
    payload;

  const nodeSourceCandidates = [
    graph?.nodes,
    graph?.tasks,
    graph?.items,
    payload?.nodes,
    payload?.tasks,
    payload?.items,
  ];
  const edgeSourceCandidates = [
    graph?.edges,
    graph?.links,
    graph?.dependencies,
    payload?.edges,
    payload?.links,
    payload?.dependencies,
  ];

  const rawNodes =
    nodeSourceCandidates.find((value) => Array.isArray(value) && value.length > 0) || [];
  const nodes = rawNodes.map(normalizeDagNode).filter((node) => node && node.id);
  const idLookup = new Map();
  for (const node of nodes) {
    idLookup.set(node.id, node.id);
    if (node.taskId) idLookup.set(node.taskId, node.id);
  }

  const rawEdges =
    edgeSourceCandidates.find((value) => Array.isArray(value) && value.length > 0) || [];
  const edges = [];
  const seen = new Set();
  const pushEdge = (source, target, kind = "depends-on") => {
    const src = idLookup.get(source) || source;
    const dst = idLookup.get(target) || target;
    if (!src || !dst) return;
    const key = `${src}->${dst}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ source: src, target: dst, kind });
  };

  for (const edge of rawEdges) {
    if (!edge || typeof edge !== "object") continue;
    pushEdge(
      toText(edge.source || edge.from || edge.parent || edge.dependsOn),
      toText(edge.target || edge.to || edge.child || edge.taskId),
      toText(edge.kind || edge.type || "depends-on"),
    );
  }
  if (!edges.length) {
    for (const node of nodes) {
      for (const dep of node.dependencies) {
        pushEdge(dep, node.id, "depends-on");
      }
    }
  }

  return {
    title: toText(graph?.title || payload?.title || fallbackTitle, fallbackTitle),
    description: toText(graph?.description || payload?.description || ""),
    nodes,
    edges,
  };
}

function normalizeEpicDependenciesPayload(raw) {
  const payload = extractDagPayload(raw);
  const rows = toArray(payload?.data || payload?.items || payload);
  return rows
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const epicId = toText(entry.epicId || entry.id || entry.epic);
      if (!epicId) return null;
      return {
        epicId,
        dependencies: normalizeDependencyInput(entry.dependencies || entry.dependsOn || []),
      };
    })
    .filter(Boolean);
}

function buildEpicDagGraph(tasks = [], epicDependencies = []) {
  const epicMap = new Map();
  const pushEpicNode = (epicId) => {
    const id = toText(epicId);
    if (!id) return null;
    if (!epicMap.has(id)) {
      epicMap.set(id, { id, title: id, taskIds: [], statusCounts: new Map(), dependencies: [] });
    }
    return epicMap.get(id);
  };

  for (const task of tasks || []) {
    const epicId = toText(task?.epicId || task?.meta?.epicId);
    if (!epicId) continue;
    const node = pushEpicNode(epicId);
    node.taskIds.push(task.id);
    const status = toText(task?.status || "todo", "todo").toLowerCase();
    node.statusCounts.set(status, (node.statusCounts.get(status) || 0) + 1);
  }

  const depMap = new Map();
  const addEdge = (from, to, kind = "dependency") => {
    const src = toText(from);
    const dst = toText(to);
    if (!src || !dst || src === dst) return;
    pushEpicNode(src);
    const node = pushEpicNode(dst);
    if (node && !node.dependencies.includes(src)) node.dependencies.push(src);
    const key = `${src}->${dst}:${kind}`;
    if (!depMap.has(key)) depMap.set(key, { source: src, target: dst, kind });
  };

  for (const row of epicDependencies || []) {
    for (const dep of row.dependencies || []) addEdge(dep, row.epicId, "blocks");
  }

  const taskById = new Map((tasks || []).map((task) => [String(task?.id || ""), task]));
  for (const task of tasks || []) {
    const targetEpic = toText(task?.epicId || task?.meta?.epicId);
    if (!targetEpic) continue;
    for (const depId of normalizeDependencyInput(task?.dependencyTaskIds || task?.dependsOn || task?.meta?.dependencyTaskIds || [])) {
      const depTask = taskById.get(String(depId));
      const sourceEpic = toText(depTask?.epicId || depTask?.meta?.epicId);
      if (!sourceEpic || sourceEpic === targetEpic) continue;
      addEdge(sourceEpic, targetEpic, "dependency");
    }
  }

  const indegree = new Map();
  const outgoing = new Map();
  for (const epicId of epicMap.keys()) {
    indegree.set(epicId, 0);
    outgoing.set(epicId, []);
  }
  for (const edge of depMap.values()) {
    outgoing.get(edge.source)?.push(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) || 0) + 1);
  }

  const queue = [];
  for (const [id, degree] of indegree.entries()) if (degree === 0) queue.push(id);
  const level = new Map();
  for (const id of queue) level.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    const nextLevel = (level.get(id) || 0) + 1;
    for (const dst of outgoing.get(id) || []) {
      if (!level.has(dst) || (level.get(dst) || 0) < nextLevel) level.set(dst, nextLevel);
      const degree = (indegree.get(dst) || 0) - 1;
      indegree.set(dst, degree);
      if (degree === 0) queue.push(dst);
    }
  }

  const nodes = [...epicMap.values()].map((entry) => {
    const statuses = [...entry.statusCounts.entries()].sort((a, b) => b[1] - a[1]);
    const dominantStatus = statuses[0]?.[0] || "todo";
    return {
      id: entry.id,
      taskId: null,
      title: `Epic ${entry.title}`,
      status: dominantStatus,
      depth: level.get(entry.id) || 0,
      order: entry.taskIds.length,
      taskCount: entry.taskIds.length,
      dependencies: [...entry.dependencies],
      epicId: entry.id,
    };
  });

  const edges = [...depMap.values()];
  return {
    title: "Epic Dependency DAG",
    description: "Epic-level execution dependencies.",
    nodes,
    edges,
  };
}
function extractGlobalDagPayload(...sources) {
  for (const source of sources) {
    const payload = extractDagPayload(source);
    if (!payload || typeof payload !== "object") continue;
    const candidate =
      payload?.dagOfDags ||
      payload?.globalDag ||
      payload?.globalGraph ||
      payload?.overviewDag ||
      payload?.overviewGraph;
    if (candidate) return candidate;
  }
  return null;
}

function buildSprintPathCandidates(basePath, sprintId) {
  if (!sprintId || sprintId === "all") return [basePath];
  const encoded = encodeURIComponent(sprintId);
  const join = basePath.includes("?") ? "&" : "?";
  return [
    `${basePath}${join}sprintId=${encoded}`,
    `${basePath}${join}sprint=${encoded}`,
    `${basePath}${join}id=${encoded}`,
    basePath,
  ];
}

async function fetchFirstAvailableDagPath(paths = []) {
  const attempts = Array.from(new Set(paths)).filter(Boolean);
  for (const path of attempts) {
    try {
      const payload = await apiFetch(path, { _silent: true });
      return { path, payload };
    } catch {
      // Try next endpoint candidate.
    }
  }
  return null;
}

function buildTaskDescriptionFallback(rawTitle, rawDescription) {
  const title = sanitizeTaskText(rawTitle || "");
  const description = sanitizeTaskText(rawDescription || "");
  if (description) return description;
  if (!title) {
    return "No description provided yet. Add scope, key files, and acceptance checks before dispatch.";
  }
  return `Implementation notes for "${title}". Include scope, key files, risks, and acceptance checks before dispatch.`;
}


function getTaskCollectionValues(task, keys = []) {
  const out = [];
  const seen = new Set();
  for (const key of keys) {
    const value = task?.[key] ?? task?.meta?.[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item == null) continue;
        const marker = JSON.stringify(item);
        if (seen.has(marker)) continue;
        seen.add(marker);
        out.push(item);
      }
      continue;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) {
        if (item == null) continue;
        const marker = JSON.stringify(item);
        if (seen.has(marker)) continue;
        seen.add(marker);
        out.push(item);
      }
    }
  }
  return out;
}

function buildTaskHistoryEntries(task) {
  const rows = getTaskCollectionValues(task, [
    "statusHistory",
    "history",
    "timeline",
    "eventLog",
    "events",
    "activity",
  ]);
  return rows
    .map((entry) => {
      if (entry == null) return null;
      if (typeof entry === "string") {
        return {
          type: "event",
          label: entry,
          status: "",
          source: "",
          timestamp: null,
        };
      }
      const status = String(entry.status || entry.to || entry.nextStatus || "").trim();
      const fromStatus = String(entry.from || entry.previousStatus || "").trim();
      const eventName = String(entry.event || entry.type || entry.kind || "").trim();
      const source = String(entry.source || entry.by || entry.actor || "").trim();
      const timestamp =
        entry.timestamp ||
        entry.createdAt ||
        entry.updatedAt ||
        entry.at ||
        null;
      const label = eventName || (status ? `${fromStatus ? `${fromStatus} -> ` : ""}${status}` : "Task event");
      return {
        type: eventName || "status",
        label,
        status,
        source,
        timestamp,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 40);
}

function buildTaskWorkflowRuns(task) {
  const rows = getTaskCollectionValues(task, [
    "workflowRuns",
    "workflowHistory",
    "workflows",
  ]);
  return rows
    .map((entry) => {
      if (entry == null) return null;
      if (typeof entry === "string") {
        return { workflowId: entry, runId: "", status: "", result: "", timestamp: null };
      }
      return {
        workflowId: String(entry.workflowId || entry.id || entry.templateId || "").trim(),
        runId: String(entry.runId || entry.executionId || entry.attemptId || "").trim(),
        status: String(entry.status || entry.outcome || entry.result || "").trim(),
        result: String(entry.summary || entry.message || entry.reason || "").trim(),
        timestamp: entry.timestamp || entry.completedAt || entry.createdAt || null,
      };
    })
    .filter((entry) => entry && (entry.workflowId || entry.runId || entry.status || entry.result))
    .sort((a, b) => {
      const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tb - ta;
    })
    .slice(0, 30);
}

function buildTaskRelatedLinks(task) {
  const links = [];
  const branch =
    task?.branchName ||
    task?.branch ||
    task?.meta?.branch ||
    task?.meta?.branchName ||
    "";
  const prNumber =
    task?.prNumber ||
    task?.pr_number ||
    task?.meta?.prNumber ||
    task?.meta?.pr_number ||
    "";
  const prUrl =
    task?.prUrl ||
    task?.pr_url ||
    task?.meta?.prUrl ||
    task?.meta?.pr_url ||
    task?.meta?.pr?.url ||
    "";
  const baseBranch = getTaskBaseBranch(task);

  if (branch) links.push({ kind: "Branch", value: branch, url: "" });
  if (baseBranch) links.push({ kind: "Base", value: baseBranch, url: "" });
  if (prNumber) links.push({ kind: "PR", value: `#${prNumber}`, url: prUrl || "" });
  if (prUrl) links.push({ kind: "PR URL", value: prUrl, url: prUrl });
  return links;
}

function buildTaskAgentList(task) {
  const values = [];
  const pushValue = (value) => {
    const normalized = String(value || "").trim();
    if (!normalized || values.includes(normalized)) return;
    values.push(normalized);
  };

  pushValue(task?.assignee);
  const assignees = task?.assignees || task?.meta?.assignees;
  if (Array.isArray(assignees)) {
    for (const item of assignees) {
      if (typeof item === "string") pushValue(item);
      else pushValue(item?.name || item?.id || item?.agentId);
    }
  }

  pushValue(task?.meta?.execution?.sdk);
  pushValue(task?.meta?.execution?.model);
  pushValue(task?.meta?.executor);
  return values;
}

async function confirmTaskLifecycleTransition(task, newStatus) {
  const next = normalizeTaskLifecycleStatus(newStatus);
  const prev = normalizeTaskLifecycleStatus(task?.status || "todo");
  const action = classifyTaskLifecycleAction(prev, next);
  const taskLabel = sanitizeTaskText(task?.title || task?.id || "this task");

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

async function applyTaskLifecycleTransition(task, requestedStatus) {
  if (!task?.id) return { ok: false, cancelled: true, action: "noop" };
  const decision = await confirmTaskLifecycleTransition(task, requestedStatus);
  if (!decision.ok) return { ok: false, cancelled: true, action: decision.action };

  const wantsDraft = decision.nextStatus === "draft";
  const prevTasks = cloneValue(tasksData.value);
  const optimisticStatus = decision.action === "start" ? "inprogress" : decision.nextStatus;
  let apiResult = null;

  await runOptimistic(
    () => {
      tasksData.value = tasksData.value.map((row) =>
        row.id === task.id ? { ...row, status: optimisticStatus, draft: wantsDraft } : row,
      );
    },
    async () => {
      if (decision.action === "start") {
        apiResult = await apiFetch("/api/tasks/start", {
          method: "POST",
          body: JSON.stringify({ taskId: task.id }),
        });
        const detail = await apiFetch(
          `/api/tasks/detail?taskId=${encodeURIComponent(task.id)}`,
          { _silent: true },
        ).catch(() => null);
        const merged = detail?.data || apiResult?.data || null;
        if (merged) {
          tasksData.value = tasksData.value.map((row) =>
            row.id === task.id ? { ...row, ...merged } : row,
          );
        }
        return apiResult;
      }

      apiResult = await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({
          taskId: task.id,
          status: decision.nextStatus,
          draft: wantsDraft,
          lifecycleAction: decision.action,
          pauseExecution: decision.action === "pause",
        }),
      });
      if (apiResult?.data) {
        tasksData.value = tasksData.value.map((row) =>
          row.id === task.id ? { ...row, ...apiResult.data } : row,
        );
      }
      return apiResult;
    },
    () => {
      tasksData.value = prevTasks;
    },
  );

  return {
    ok: true,
    cancelled: false,
    action: decision.action,
    status: optimisticStatus,
    response: apiResult,
  };
}
export function StartTaskModal({
  task,
  defaultSdk = "auto",
  allowTaskIdInput = false,
  onClose,
  onStart,
}) {
  const [sdk, setSdk] = useState(defaultSdk || "auto");
  const [model, setModel] = useState("");
  const [taskIdInput, setTaskIdInput] = useState(task?.id || "");
  const [starting, setStarting] = useState(false);
  const initialSnapshotRef = useRef({
    sdk: defaultSdk || "auto",
    model: "",
    taskIdInput: task?.id || "",
  });
  const pendingKey = useMemo(
    () => `modal:start-task:${task?.id || "manual"}`,
    [task?.id],
  );

  useEffect(() => {
    const next = {
      sdk: defaultSdk || "auto",
      model: "",
      taskIdInput: task?.id || "",
    };
    initialSnapshotRef.current = next;
    setSdk(next.sdk);
    setModel(next.model);
    setTaskIdInput(next.taskIdInput);
  }, [defaultSdk, task?.id, task?.meta?.codex?.isIgnored, task?.meta?.labels]);

  const canModel = sdk && sdk !== "auto";

  const EXECUTOR_MODELS = {
    codex: [
      "gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex",
      "gpt-5.1-codex-mini", "gpt-5.1-codex-max",
      "gpt-5.2", "gpt-5.1", "gpt-5-mini",
    ],
    copilot: [
      "claude-opus-4.6", "claude-sonnet-4.6", "claude-opus-4.5", "claude-sonnet-4.5",
      "claude-sonnet-4", "claude-haiku-4.5",
      "gpt-5.2-codex", "gpt-5.3-codex", "gpt-5.1-codex", "gpt-5.1-codex-mini",
      "gpt-5.2", "gpt-5.1", "gpt-5-mini",
      "gemini-3.1-pro", "gemini-3-pro", "gemini-3-flash", "gemini-2.5-pro",
      "grok-code-fast-1",
    ],
    claude: [
      "claude-opus-4.6", "claude-sonnet-4.6", "claude-opus-4.5",
      "claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-4.5",
    ],
  };

  const resolvedTaskId = (task?.id || taskIdInput || "").trim();
  const currentSnapshot = useMemo(
    () => ({
      sdk: sdk || "auto",
      model: model || "",
      taskIdInput: taskIdInput || "",
    }),
    [model, sdk, taskIdInput],
  );
  const changeCount = useMemo(
    () => countChangedFields(initialSnapshotRef.current, currentSnapshot),
    [currentSnapshot],
  );
  const hasUnsaved = changeCount > 0;

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsaved);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsaved, pendingKey]);

  const resetToInitial = useCallback(() => {
    const base = initialSnapshotRef.current || {};
    setSdk(base.sdk || "auto");
    setModel(base.model || "");
    setTaskIdInput(base.taskIdInput || "");
    showToast("Changes discarded", "info");
  }, []);

  const handleStart = async ({ closeAfterStart = true } = {}) => {
    if (starting) return;
    if (!resolvedTaskId) {
      showToast("Task ID is required", "error");
      return false;
    }
    setStarting(true);
    try {
      await onStart?.({
        taskId: resolvedTaskId,
        sdk: sdk && sdk !== "auto" ? sdk : undefined,
        model: model.trim() ? model.trim() : undefined,
      });
      initialSnapshotRef.current = {
        sdk: sdk || "auto",
        model: model || "",
        taskIdInput: taskIdInput || "",
      };
      if (closeAfterStart) {
        onClose?.();
        return { closed: true };
      }
      return true;
    } catch {
      /* toast via apiFetch */
      return false;
    } finally {
      setStarting(false);
    }
  };

  return html`
    <${Modal}
      title="Start Task"
      onClose=${onClose}
      contentClassName="modal-content-wide task-detail-modal-jira"
      unsavedChanges=${changeCount}
      onSaveBeforeClose=${() => handleStart({ closeAfterStart: true })}
      onDiscardBeforeClose=${() => {
        resetToInitial();
        return true;
      }}
      activeOperationLabel=${starting ? "Task dispatch is still running" : ""}
    >
      ${task?.id || task?.title
        ? html`
            <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 1 }}>
              ${task?.title || "(untitled)"} · ${task?.id || "—"}
            <//>`
        : html`
            <${Typography} variant="body2" color="text.secondary" sx=${{ mb: 1 }}>
              Enter a task ID to manually dispatch it. Manual starts work even if automation is paused.
            <//>`}
      <${Stack} spacing=${2}>
        ${(allowTaskIdInput || !task?.id) &&
        html`
          <${TextField}
            label="Task ID"
            placeholder="e.g. task-123"
            size="small"
            fullWidth
            value=${taskIdInput}
            onChange=${(e) => setTaskIdInput(e.target.value)}
          />
        `}
        <${TextField}
          select
          label="Executor SDK"
          size="small"
          fullWidth
          value=${sdk}
          onChange=${(e) => setSdk(e.target.value)}
        >
          ${["auto", "codex", "copilot", "claude"].map(
            (opt) => html`<${MenuItem} key=${opt} value=${opt}>${opt}<//>`
          )}
        <//>
        <${TextField}
          select
          label="Model Override (optional)"
          size="small"
          fullWidth
          value=${model}
          disabled=${!canModel}
          onChange=${(e) => setModel(e.target.value)}
        >
          <${MenuItem} value="">Auto (default)<//>
          ${canModel && (EXECUTOR_MODELS[sdk] || []).map(m => html`<${MenuItem} key=${m} value=${m}>${m}<//>`)}
        <//>
        <${Button}
          variant="contained"
          fullWidth
          onClick=${() => {
            void handleStart({ closeAfterStart: true });
          }}
          disabled=${starting || !resolvedTaskId}
        >
          ${starting ? "Starting…" : iconText(":play: Start Task")}
        <//>
      <//>
      <${SaveDiscardBar}
        dirty=${hasUnsaved}
        message=${unsavedChangesMessage(changeCount)}
        saveLabel="Start Task"
        discardLabel="Discard"
        onSave=${() => {
          void handleStart({ closeAfterStart: false });
        }}
        onDiscard=${resetToInitial}
        saving=${starting}
      />
    <//>
  `;
}

function TriggerTemplateCard({
  template,
  saving,
  onToggleEnabled,
  onSaveTemplate,
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState(template?.name || "");
  const [description, setDescription] = useState(template?.description || "");
  const [action, setAction] = useState(template?.action || "create-task");
  const [minIntervalMinutes, setMinIntervalMinutes] = useState(
    template?.minIntervalMinutes || "",
  );
  const [triggerJson, setTriggerJson] = useState(
    JSON.stringify(template?.trigger || { anyOf: [] }, null, 2),
  );
  const [configJson, setConfigJson] = useState(
    JSON.stringify(template?.config || {}, null, 2),
  );

  useEffect(() => {
    setName(template?.name || "");
    setDescription(template?.description || "");
    setAction(template?.action || "create-task");
    setMinIntervalMinutes(template?.minIntervalMinutes || "");
    setTriggerJson(JSON.stringify(template?.trigger || { anyOf: [] }, null, 2));
    setConfigJson(JSON.stringify(template?.config || {}, null, 2));
    setError("");
  }, [template?.id, template?.name, template?.description, template?.action, template?.enabled]);

  const state = template?.state || {};
  const stats = template?.stats || {};
  const recentSpawned = Array.isArray(stats.recentSpawned)
    ? stats.recentSpawned
    : [];
  const runningAgents = Array.isArray(stats.runningAgents)
    ? stats.runningAgents
    : [];

  const handleSave = async () => {
    try {
      setError("");
      const parsedTrigger = JSON.parse(triggerJson || "{}");
      const parsedConfig = JSON.parse(configJson || "{}");
      await onSaveTemplate({
        ...template,
        name: String(name || "").trim() || template?.id,
        description: String(description || "").trim(),
        action,
        minIntervalMinutes:
          Number.isFinite(Number(minIntervalMinutes)) &&
          Number(minIntervalMinutes) > 0
            ? Number(minIntervalMinutes)
            : undefined,
        trigger: parsedTrigger,
        config: parsedConfig,
      });
      setEditing(false);
    } catch (err) {
      setError(err?.message || "Invalid JSON in template fields");
    }
  };

  return html`
    <${Paper} sx=${{ mb: 1.25, p: 1.5 }}>
      <${Stack} direction="row" justifyContent="space-between" alignItems="flex-start" spacing=${1.25}>
        <${Box} sx=${{ minWidth: 0 }}>
          <${Typography} variant="subtitle2" sx=${{ fontSize: 13 }}>${template?.name || template?.id}<//>
          <${Typography} variant="caption" color="text.secondary" sx=${{ wordBreak: 'break-all' }}>${template?.id || ""}<//>
        <//>
        <${FormControlLabel}
          control=${h(Switch, {
            checked: template?.enabled === true,
            disabled: saving,
            onChange: (event) => onToggleEnabled(template, event.target.checked),
            size: "small",
          })}
          label="enabled"
          sx=${{ '& .MuiFormControlLabel-label': { fontSize: 12, color: 'text.secondary' } }}
        />
      <//>

      ${template?.description && html`<${Typography} variant="caption" color="text.secondary" sx=${{ mt: 0.75 }}>${template.description}<//>`}

      <${Stack} direction="row" flexWrap="wrap" gap=${0.75} sx=${{ mt: 1 }}>
        <${Chip} label=${"spawned: " + (stats.spawnedTotal || 0)} size="small" variant="outlined" />
        <${Chip} label=${"active: " + (stats.activeCount || 0)} size="small" variant="outlined" />
        <${Chip} label=${"running: " + runningAgents.length} size="small" variant="outlined" />
        <${Chip} label=${"action: " + (template?.action || "create-task")} size="small" variant="outlined" />
      <//>

      <${Typography} variant="caption" color="text.secondary" sx=${{ mt: 1, display: 'block' }}>
        Last success: ${state?.last_success_at ? formatRelative(state.last_success_at) : "never"}
        ${state?.last_error ? ` · Last error: ${truncate(state.last_error, 100)}` : ""}
      <//>

      ${runningAgents.length > 0 && html`
        <${Typography} variant="caption" sx=${{ mt: 1, fontWeight: 600, display: 'block' }}>Running agents<//>
        <${Stack} spacing=${0.5} sx=${{ mt: 0.5 }}>
          ${runningAgents.map((entry) => html`
            <${Typography} variant="caption" color="text.secondary">
              ${entry.taskId} · ${entry.sdk || "auto"}${entry.model ? ` · ${entry.model}` : ""}
            <//>
          `)}
        <//>
      `}

      ${recentSpawned.length > 0 && html`
        <${Typography} variant="caption" sx=${{ mt: 1, fontWeight: 600, display: 'block' }}>Recent spawned tasks<//>
        <${Stack} spacing=${0.5} sx=${{ mt: 0.5 }}>
          ${recentSpawned.map((entry) => html`
            <${Typography} variant="caption" color="text.secondary">
              ${entry.id} · ${entry.status || "todo"} · ${entry.createdAt ? formatRelative(entry.createdAt) : "unknown"}
            <//>
          `)}
        <//>
      `}

      ${editing && html`
        <${Stack} spacing=${1} sx=${{ mt: 1.25 }}>
          <${TextField} size="small" fullWidth value=${name} onChange=${(e) => setName(e.target.value)} placeholder="Template name" />
          <${TextField} size="small" fullWidth value=${description} onChange=${(e) => setDescription(e.target.value)} placeholder="Description" />
          <${Stack} direction="row" spacing=${1}>
            <${TextField} select size="small" fullWidth value=${action} onChange=${(e) => setAction(e.target.value)}>
              <${MenuItem} value="create-task">create-task<//>
            <//>
            <${TextField}
              size="small"
              fullWidth
              type="number"
              inputProps=${{ min: 1 }}
              value=${minIntervalMinutes}
              onChange=${(e) => setMinIntervalMinutes(e.target.value)}
              placeholder="Min interval (minutes)"
            />
          <//>
          <${TextField} multiline rows=${6} fullWidth size="small" value=${triggerJson} onChange=${(e) => setTriggerJson(e.target.value)} />
          <${TextField} multiline rows=${6} fullWidth size="small" value=${configJson} onChange=${(e) => setConfigJson(e.target.value)} />
          ${error && html`<${Alert} severity="error" variant="outlined" sx=${{ py: 0 }}>${error}<//>`}
        <//>
      `}

      <${Stack} direction="row" spacing=${1} sx=${{ mt: 1.25 }}>
        <${Button} variant="text" size="small" onClick=${() => setEditing((prev) => !prev)}>
          ${editing ? "Close Editor" : "Edit"}
        <//>
        ${editing && html`
          <${Button} variant="contained" size="small" disabled=${saving} onClick=${handleSave}>
            ${saving ? "Saving…" : "Save Template"}
          <//>
        `}
      <//>
    <//>
  `;
}

function TriggerTemplatesModal({ onClose }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [defaults, setDefaults] = useState({ executor: "auto", model: "auto" });
  const [templates, setTemplates] = useState([]);

  const defaultsBaselineRef = useRef({ executor: "auto", model: "auto" });
  const pendingKey = "modal:trigger-templates";

  const defaultsSnapshot = useMemo(
    () => ({
      executor: String(defaults?.executor || "auto"),
      model: String(defaults?.model || "auto"),
    }),
    [defaults],
  );
  const defaultsDirtyCount = useMemo(
    () => countChangedFields(defaultsBaselineRef.current, defaultsSnapshot),
    [defaultsSnapshot],
  );
  const hasUnsavedDefaults = defaultsDirtyCount > 0;

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/triggers/templates", { _silent: true });
      const data = res?.data || {};
      setEnabled(data.enabled === true);
      const normalizedDefaults =
        data.defaults && typeof data.defaults === "object"
          ? data.defaults
          : { executor: "auto", model: "auto" };
      defaultsBaselineRef.current = {
        executor: String(normalizedDefaults.executor || "auto"),
        model: String(normalizedDefaults.model || "auto"),
      };
      setDefaults(normalizedDefaults);
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
    } catch (err) {
      setError(err?.message || "Failed to load templates");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTemplates();
  }, []);

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsavedDefaults);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsavedDefaults]);

  const persistUpdate = async (payload) => {
    setSaving(true);
    setError("");
    try {
      const res = await apiFetch("/api/triggers/templates/update", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const data = res?.data || {};
      setEnabled(data.enabled === true);
      const normalizedDefaults =
        data.defaults && typeof data.defaults === "object"
          ? data.defaults
          : { executor: "auto", model: "auto" };
      defaultsBaselineRef.current = {
        executor: String(normalizedDefaults.executor || "auto"),
        model: String(normalizedDefaults.model || "auto"),
      };
      setDefaults(normalizedDefaults);
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
      showToast("Template settings updated", "success");
      scheduleRefresh(200);
    } catch (err) {
      setError(err?.message || "Failed to update templates");
      throw err;
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSystem = async (nextEnabled) => {
    setEnabled(nextEnabled);
    try {
      await persistUpdate({ enabled: nextEnabled });
    } catch {
      setEnabled((prev) => !prev);
    }
  };

  const handleSaveDefaults = async ({ closeAfterSave = false } = {}) => {
    try {
      await persistUpdate({ defaults });
      if (closeAfterSave) {
        onClose?.();
        return { closed: true };
      }
      return true;
    } catch {
      return false;
    }
  };

  const handleDiscardDefaults = useCallback(() => {
    const base = defaultsBaselineRef.current || { executor: "auto", model: "auto" };
    setDefaults({
      executor: base.executor || "auto",
      model: base.model || "auto",
    });
    showToast("Changes discarded", "info");
  }, []);

  const handleToggleTemplate = async (template, nextEnabled) => {
    await persistUpdate({ template: { ...template, enabled: nextEnabled } });
  };

  const handleSaveTemplate = async (template) => {
    await persistUpdate({ template });
  };

  return html`
    <${Modal}
      title="Trigger Templates"
      onClose=${onClose}
      contentClassName="modal-content-wide task-detail-modal-jira"
      unsavedChanges=${defaultsDirtyCount}
      onSaveBeforeClose=${() => handleSaveDefaults({ closeAfterSave: true })}
      onDiscardBeforeClose=${() => {
        handleDiscardDefaults();
        return true;
      }}
      activeOperationLabel=${saving ? "Template update request is still running" : ""}
    >
      <div class="flex-col" style="gap:10px;">
        <div class="card" style="padding:10px 12px;">
          <div class="flex-between" style="gap:10px;align-items:center;">
            <div>
              <div class="card-subtitle">Trigger System</div>
              <div class="meta-text">Enable/disable the full trigger template engine.</div>
            </div>
            <label class="meta-text" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <${Switch} size="small" checked=${enabled} disabled=${saving} onChange=${(event) => handleToggleSystem(event.target.checked)} />
              ${enabled ? "enabled" : "disabled"}
            </label>
          </div>

          <div class="input-row" style="margin-top:10px;">
            <${Select}
              size="small"
              value=${defaults.executor || "auto"}
              onChange=${(e) => setDefaults({ ...defaults, executor: e.target.value })}
              disabled=${saving}
            >
              ${["auto", "codex", "copilot", "claude"].map(
                (opt) => html`<${MenuItem} value=${opt}>default executor: ${opt}</${MenuItem}>`,
              )}
            </${Select}>
            <${TextField} size="small" variant="outlined" value=${defaults.model || "auto"} disabled=${saving} onInput=${(e) => setDefaults({ ...defaults, model: e.target.value })} placeholder="default model (auto)" fullWidth />
          </div>
          <div class="btn-row" style="margin-top:8px;">
            <${Button} variant="outlined" size="small" disabled=${saving} onClick=${handleSaveDefaults}>
              Save Defaults
            <//>
            <${Button} variant="text" size="small" disabled=${loading || saving} onClick=${loadTemplates}>
              Refresh
            <//>
          </div>


        </div>

        ${error && html`<div class="meta-text" style="color:var(--color-error);">${error}</div>`}

        ${loading && html`<${SkeletonCard} />`}

        ${!loading && templates.length === 0 && html`
          <${EmptyState}
            message="No trigger templates found"
            description="Add templates in bosun.config.json under triggerSystem.templates."
          />
        `}

        ${!loading && templates.map((template) => html`
          <${TriggerTemplateCard}
            key=${template.id}
            template=${template}
            saving=${saving}
            onToggleEnabled=${handleToggleTemplate}
            onSaveTemplate=${handleSaveTemplate}
          />
        `)}
        <${SaveDiscardBar}
          dirty=${hasUnsavedDefaults}
          message=${unsavedChangesMessage(defaultsDirtyCount)}
          saveLabel="Save Defaults"
          discardLabel="Discard"
          onSave=${() => {
            void handleSaveDefaults({ closeAfterSave: false });
          }}
          onDiscard=${handleDiscardDefaults}
          saving=${saving}
        />
      </div>
    <//>
  `;
}

/* ─── Helper: is a task actively running / in review? ─── */
function isActiveStatus(s) {
  return ["inprogress", "running", "working", "active", "assigned", "started"].includes(String(s || ""));
}
function isReviewStatus(s) {
  return ["inreview", "review", "pr-open", "pr-review"].includes(String(s || ""));
}

async function reactivateTaskSession(taskId, options = {}) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return false;

  const askFirst = options?.askFirst !== false;
  const title = String(options?.title || "this task").trim();

  if (askFirst) {
    const ok = await showConfirm(
      `Task moved to review. Reactivate agent session for "${title}" now?`,
    );
    if (!ok) return false;
  }

  haptic("medium");
  const res = await apiFetch("/api/tasks/start", {
    method: "POST",
    body: JSON.stringify({ taskId: normalizedTaskId }),
  });
  if (res?.queued) {
    showToast("Agent reactivation queued (waiting for free slot)", "info");
  } else if (res?.wasPaused) {
    showToast("Agent reactivated (executor was paused)", "warning");
  } else {
    showToast("Agent session reactivated", "success");
  }

  tasksData.value = (tasksData.value || []).map((t) =>
    String(t?.id || "").trim() === normalizedTaskId
      ? { ...t, status: "inprogress" }
      : t,
  );
  scheduleRefresh(150);
  return true;
}

/* ─── Derive agent steps from task title/description ─── */
function deriveSteps(task) {
  const t = String(task?.title || "").toLowerCase();
  const steps = [];
  if (/feat|add|implement|build|create/.test(t)) steps.push({ label: "Understand requirements & read context" });
  if (/fix|bug|patch|resolve|repair/.test(t)) steps.push({ label: "Reproduce and diagnose issue" });
  if (/refactor|restructure|cleanup|reorganize/.test(t)) steps.push({ label: "Map current code structure" });
  if (/test|spec|coverage/.test(t)) steps.push({ label: "Write test cases" });
  if (/docs|document|readme/.test(t)) steps.push({ label: "Draft documentation content" });
  steps.push({ label: "Write implementation" });
  if (!/docs|readme/.test(t)) steps.push({ label: "Run tests & fix issues" });
  steps.push({ label: "Commit changes" });
  steps.push({ label: "Handoff PR lifecycle to Bosun" });
  return steps;
}

/* ─── Estimate step progress from timing ─── */
function estimateStep(task, steps) {
  const elapsed = task?.updated ? (Date.now() - new Date(task.updated).getTime()) : 0;
  const totalDur = task?.created ? (Date.now() - new Date(task.created).getTime()) : 60000;
  const pct = Math.min(0.85, totalDur > 0 ? (elapsed / totalDur) : 0);
  // Bias: show 40-75% through to look realistic
  const biasedPct = 0.35 + pct * 0.4;
  return Math.max(0, Math.min(steps.length - 1, Math.floor(biasedPct * steps.length)));
}

/* ─── TaskProgressModal — live view for in-progress tasks ─── */
export function TaskProgressModal({ task, onClose }) {
  const [liveTask, setLiveTask] = useState(task);
  const [health, setHealth] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const logEndRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const taskRes = await apiFetch(`/api/tasks/detail?taskId=${task.id}`, { _silent: true });
        if (!cancelled && taskRes?.data) setLiveTask(taskRes.data);

        const healthRes = await apiFetch(`/api/supervisor/task/${task.id}`, { _silent: true });
        if (!cancelled && healthRes?.taskId) setHealth(healthRes);

        const branch = task.branch || (taskRes?.data?.branch) || "";
        if (branch) {
          const logRes = await apiFetch(
            `/api/agent-logs/tail?file=${encodeURIComponent(branch)}&lines=40`,
            { _silent: true },
          );
          if (!cancelled && logRes?.data?.lines) {
            setLogs(logRes.data.lines);
            setLogsLoading(false);
          } else if (!cancelled) {
            setLogsLoading(false);
          }
        } else {
          if (!cancelled) setLogsLoading(false);
        }
      } catch {
        if (!cancelled) setLogsLoading(false);
      }
    };
    poll();
    const timer = setInterval(poll, 6000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [task.id]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const steps = useMemo(() => deriveSteps(liveTask || task), [liveTask?.id]);
  const currentStep = useMemo(() => estimateStep(liveTask || task, steps), [liveTask?.updated]);

  const healthScore = health?.currentHealthScore ?? health?.averageHealthScore ?? null;
  const healthColor =
    healthScore == null ? "var(--text-hint)"
    : healthScore >= 80 ? "var(--color-done)"
    : healthScore >= 50 ? "var(--color-inprogress)"
    : "var(--color-error)";

  const startedRelative = liveTask?.created ? formatRelative(liveTask.created) : "—";
  const agentLabel = liveTask?.assignee || task.assignee || "Agent";
  const branchLabel = liveTask?.branch || task.branch || "—";

  const handleCancel = async () => {
    const ok = await showConfirm("Cancel this task?");
    if (!ok) return;
    setCancelling(true);
    haptic("medium");
    try {
      await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "cancelled" }),
      });
      tasksData.value = tasksData.value.map((t) =>
        t.id === task.id ? { ...t, status: "cancelled" } : t,
      );
      showToast("Task cancelled", "success");
      scheduleRefresh(200);
      onClose();
    } catch { /* toast via apiFetch */ }
    setCancelling(false);
  };

  const handleMarkReview = async () => {
    haptic("medium");
    try {
      await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "inreview" }),
      });
      tasksData.value = tasksData.value.map((t) =>
        t.id === task.id ? { ...t, status: "inreview" } : t,
      );
      showToast("Task moved to review", "success");
      await reactivateTaskSession(task.id, {
        askFirst: true,
        title: task?.title || task?.id || "this task",
      }).catch(() => {});
      scheduleRefresh(200);
      onClose();
    } catch { /* toast via apiFetch */ }
  };

  return html`
    <${Modal}
      title=${liveTask?.title || task.title || "Task Progress"}
      onClose=${onClose}
      contentClassName="modal-content-wide task-progress-modal"
    >
      
      <div class="tp-hero">
        <div class="tp-pulse-dot"></div>
        <div class="tp-hero-title">
          <div class="tp-hero-status-label">${iconText(":zap: Active — Agent Working")}</div>
        </div>
        <${Badge} status="inprogress" text="running" />
      </div>

      
      <div class="tp-meta-strip">
        <div class="tp-meta-item">
          <span class="tp-meta-label">Agent</span>
          <span class="tp-meta-value">${agentLabel}</span>
        </div>
        <div class="tp-meta-item">
          <span class="tp-meta-label">Branch</span>
          <span class="tp-meta-value mono">${branchLabel}</span>
        </div>
        <div class="tp-meta-item">
          <span class="tp-meta-label">Started</span>
          <span class="tp-meta-value">${startedRelative}</span>
        </div>
        ${healthScore != null && html`
          <div class="tp-meta-item">
            <span class="tp-meta-label">Health</span>
            <span class="tp-meta-value" style="color:${healthColor};">${healthScore}%</span>
          </div>
        `}
        ${liveTask?.priority && html`
          <div class="tp-meta-item">
            <span class="tp-meta-label">Priority</span>
            <span class="tp-meta-value"><${Badge} status=${liveTask.priority} text=${liveTask.priority} /></span>
          </div>
        `}
      </div>

      
      <div class="tp-section">
        <div class="tp-section-title">Progress · step ${currentStep + 1} of ${steps.length}</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${steps.map((step, i) => {
            const done = i < currentStep;
            const active = i === currentStep;
            const pending = i > currentStep;
            return html`
              <div
                key=${i}
                style="display:flex;align-items:center;gap:10px;font-size:13px;
                       color:${done ? "var(--color-done)" : active ? "var(--text-bright)" : "var(--text-hint)"};
                       font-weight:${active ? "600" : "400"};"
              >
                <span style="font-size:14px;flex-shrink:0;">
                  ${done ? resolveIcon(":check:") : active ? resolveIcon(":refresh:") : ICONS.dot}
                </span>
                <span>${step.label}</span>
                ${active && html`
                  <span style="margin-left:auto;font-size:11px;color:var(--color-inprogress);
                                animation:fadeInOut 2s ease-in-out infinite;">working…</span>
                `}
              </div>
            `;
          })}
        </div>
      </div>

      
      <div class="tp-section" style="padding-top:0;">
        <div class="tp-section-title">Live Log Tail</div>
        <div class="tp-log-container">
          ${logsLoading && html`<div class="tp-log-loading">Fetching logs…</div>`}
          ${!logsLoading && logs.length === 0 && html`
            <div class="tp-log-empty">No log output yet for branch: ${branchLabel}</div>
          `}
          ${logs.map((line, i) => html`<div class="tp-log-line" key=${i}>${line}</div>`)}
          <div ref=${logEndRef}></div>
        </div>
      </div>

      
      <div class="btn-row tp-actions">
        <${Tooltip} title="Guide the agent mid-task"><${Button} variant="text" size="small" onClick=${() => { haptic(); sendCommandToChat("/steer " + task.id); onClose(); }}>${iconText(":chat: Steer")}<//><//>
        <${Button} variant="text" size="small" onClick=${() => { haptic(); sendCommandToChat("/logs " + task.id); onClose(); }}>${iconText(":file: Logs")}<//>
        <${Button} variant="outlined" size="small" onClick=${handleMarkReview}>→ Move to Review<//>
        <${Button} variant="text" size="small" style=${{ color: "var(--color-error)" }} onClick=${handleCancel} disabled=${cancelling}>${cancelling ? "Cancelling…" : iconText("✕ Cancel")}<//>
      </div>
    <//>
  `;
}

/* ─── TaskReviewModal — view for in-review tasks ─── */
export function TaskReviewModal({ task, onClose, onStart }) {
  const [liveTask, setLiveTask] = useState(task);
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const taskRes = await apiFetch(`/api/tasks/detail?taskId=${task.id}`, { _silent: true });
        if (!cancelled && taskRes?.data) setLiveTask(taskRes.data);

        const healthRes = await apiFetch(`/api/supervisor/task/${task.id}`, { _silent: true });
        if (!cancelled && healthRes?.taskId) setHealth(healthRes);
      } catch { /* silent */ }
      if (!cancelled) setLoading(false);
    };
    load();
    return () => { cancelled = true; };
  }, [task.id]);

  const healthScore = health?.currentHealthScore ?? health?.averageHealthScore ?? null;
  const reviewVerdict = health?.reviewVerdict ?? null;
  const qualityScore = health?.qualityScore ?? null;

  const prNumber = liveTask?.pr || task.pr;
  const branchLabel = liveTask?.branch || task.branch || "—";
  const agentLabel = liveTask?.assignee || task.assignee || "Agent";
  const updatedRelative = liveTask?.updated ? formatRelative(liveTask.updated) : "—";
  const reviewAttachments = normalizeTaskAttachments(liveTask || task);

  /* Derive simulated CI checks */
  const checks = useMemo(() => {
    const base = [
      { label: "Build", status: "pass" },
      { label: "Tests", status: prNumber ? "pass" : "pending" },
      { label: "Lint", status: "pass" },
      { label: "PR opened", status: prNumber ? "pass" : "pending" },
    ];
    if (reviewVerdict === "fail") base.push({ label: "Review", status: "fail" });
    else if (reviewVerdict) base.push({ label: "Review", status: "pass" });
    return base;
  }, [prNumber, reviewVerdict]);

  const handleMarkDone = async () => {
    haptic("medium");
    try {
      await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "done" }),
      });
      tasksData.value = tasksData.value.map((t) =>
        t.id === task.id ? { ...t, status: "done" } : t,
      );
      showToast("Task marked done", "success");
      scheduleRefresh(200);
      onClose();
    } catch { /* toast via apiFetch */ }
  };

  const handleReopen = async () => {
    haptic("light");
    try {
      await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "inprogress" }),
      });
      tasksData.value = tasksData.value.map((t) =>
        t.id === task.id ? { ...t, status: "inprogress" } : t,
      );
      showToast("Task reopened as active", "success");
      await reactivateTaskSession(task.id, {
        askFirst: false,
        title: task?.title || task?.id || "this task",
      }).catch(() => {});
      scheduleRefresh(200);
      onClose();
    } catch { /* toast via apiFetch */ }
  };

  const handleCancel = async () => {
    const ok = await showConfirm("Cancel this task?");
    if (!ok) return;
    haptic("medium");
    try {
      await apiFetch("/api/tasks/update", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id, status: "cancelled" }),
      });
      tasksData.value = tasksData.value.map((t) =>
        t.id === task.id ? { ...t, status: "cancelled" } : t,
      );
      showToast("Task cancelled", "success");
      scheduleRefresh(200);
      onClose();
    } catch { /* toast via apiFetch */ }
  };

  const allPass = checks.every((c) => c.status === "pass");

  return html`
    <${Modal}
      title=${liveTask?.title || task.title || "In Review"}
      onClose=${onClose}
      contentClassName="modal-content-wide task-review-modal"
    >
      
      <div class="tr-hero">
        <span class="tr-review-icon">${resolveIcon(":search:")}</span>
        <div class="tr-hero-title">
          <div class="tr-hero-status-label">In Review</div>
          ${prNumber && html`
            <a
              class="tr-pr-badge"
              href="#"
              onClick=${(e) => { e.preventDefault(); haptic(); sendCommandToChat("/diff " + branchLabel); onClose(); }}
            >
              ${iconText(`PR #${prNumber} · View diff :arrowRight:`)}
            </a>
          `}
          ${!prNumber && html`<span style="font-size:12px;color:var(--text-hint);">No PR yet</span>`}
        </div>
        <${Badge} status="inreview" text="review" />
      </div>

      
      <div class="tr-meta-grid">
        <div class="tr-meta-item">
          <span class="tr-meta-label">Agent</span>
          <span class="tr-meta-value">${agentLabel}</span>
        </div>
        <div class="tr-meta-item">
          <span class="tr-meta-label">Branch</span>
          <span class="tr-meta-value mono">${branchLabel}</span>
        </div>
        <div class="tr-meta-item">
          <span class="tr-meta-label">Last Updated</span>
          <span class="tr-meta-value">${updatedRelative}</span>
        </div>
        ${qualityScore != null && html`
          <div class="tr-meta-item">
            <span class="tr-meta-label">Quality</span>
            <span class="tr-meta-value" style="color:${qualityScore >= 75 ? "var(--color-done)" : "var(--color-error)"};">
              ${qualityScore}%
            </span>
          </div>
        `}
        ${healthScore != null && html`
          <div class="tr-meta-item">
            <span class="tr-meta-label">Agent Health</span>
            <span class="tr-meta-value">${healthScore}%</span>
          </div>
        `}
        ${liveTask?.priority && html`
          <div class="tr-meta-item">
            <span class="tr-meta-label">Priority</span>
            <span class="tr-meta-value"><${Badge} status=${liveTask.priority} text=${liveTask.priority} /></span>
          </div>
        `}
      </div>

      
      <div class="tr-section">
        <div class="tr-section-title">
          Checks ${allPass ? iconText("— :check: All passing") : ""}
        </div>
        <div class="tr-checks-row">
          ${checks.map((c) => html`
            <div class="tr-check-item ${c.status}" key=${c.label}>
              ${resolveIcon(c.status === "pass" ? ":check:" : c.status === "fail" ? ":close:" : ":clock:")}
              ${c.label}
            </div>
          `)}
        </div>
      </div>

      
      ${(liveTask?.description || task.description) && html`
        <div class="tr-section" style="padding-top:0;">
          <div class="tr-section-title">Description</div>
          <div class="meta-text" style="white-space:pre-wrap;line-height:1.6;max-height:120px;overflow-y:auto;">
            ${(liveTask?.description || task.description).slice(0, 600)}
          </div>
        </div>
      `}
      ${reviewAttachments.length > 0 && html`
        <div class="tr-section">
          <div class="tr-section-title">Attachments</div>
          <div class="task-attachments-list">
            ${reviewAttachments.map((att, index) => {
              const name = att.name || att.filename || "attachment";
              const url = att.url || att.filePath || att.path || "";
              const size = att.size ? formatBytes(att.size) : "";
              const isImage = isImageAttachment(att);
              return html`
                <div class="task-attachment-item" key=${att.id || `${name}-${index}`}>
                  ${isImage && url
                    ? html`<img class="task-attachment-thumb" src=${url} alt=${name} />`
                    : html`<span class="task-attachment-icon">${resolveIcon(":link:")}</span>`}
                  <div class="task-attachment-meta">
                    ${url
                      ? html`<a class="task-attachment-name" href=${url} target="_blank" rel="noopener">${name}</a>`
                      : html`<span class="task-attachment-name">${name}</span>`}
                    <div class="task-attachment-sub">
                      ${(att.kind || "file")}${size ? ` · ${size}` : ""}
                    </div>
                  </div>
                </div>
              `;
            })}
          </div>
        </div>
      `}

      
      <div class="btn-row tr-actions">
        <${Tooltip} title="Mark as merged / done"><${Button} variant="contained" size="small" onClick=${handleMarkDone} disabled=${merging}>${iconText("✓ Mark Done")}<//><//>
        <${Button} variant="outlined" size="small" onClick=${handleReopen}>${iconText(":workflow: Reopen as Active")}<//>
        <${Button} variant="text" size="small" onClick=${() => { haptic(); sendCommandToChat("/logs " + task.id); onClose(); }}>${iconText(":file: Logs")}<//>
        ${prNumber && html`
          <${Button} variant="text" size="small" onClick=${() => { haptic(); sendCommandToChat("/diff " + branchLabel); onClose(); }}>${iconText(":search: Diff")}<//>
        `}
        <${Button} variant="text" size="small" style=${{ color: "var(--color-error)" }} onClick=${handleCancel}>${iconText("✕ Cancel")}<//>
      </div>
    <//>
  `;
}

/* ─── TaskDetailModal ─── */
export function TaskDetailModal({ task, onClose, onStart }) {
  const [title, setTitle] = useState(sanitizeTaskText(task?.title || ""));
  const [description, setDescription] = useState(buildTaskDescriptionFallback(task?.title, task?.description));
  const [baseBranch, setBaseBranch] = useState(getTaskBaseBranch(task));
  const [status, setStatus] = useState(task?.status || "todo");
  const [priority, setPriority] = useState(task?.priority || "");
  const [tagsInput, setTagsInput] = useState(
    getTaskTags(task).join(", "),
  );
  const [attachments, setAttachments] = useState(
    normalizeTaskAttachments(task),
  );
  const [comments, setComments] = useState(
    normalizeTaskComments(task),
  );
  const [commentDraft, setCommentDraft] = useState("");
  const [postingComment, setPostingComment] = useState(false);
  const [dependenciesInput, setDependenciesInput] = useState(
    getTaskDependencyIds(task).join(", "),
  );
  const [savingDependencies, setSavingDependencies] = useState(false);
  const [dependencyFeedback, setDependencyFeedback] = useState("");
  const [sprintOptions, setSprintOptions] = useState([]);
  const [selectedSprintId, setSelectedSprintId] = useState(getTaskSprintId(task));
  const [sprintOrderInput, setSprintOrderInput] = useState(getTaskSprintOrder(task));
  const [savingSprint, setSavingSprint] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [draft, setDraft] = useState(
    Boolean(task?.draft || task?.status === "draft"),
  );
  const [saving, setSaving] = useState(false);
  const [baselineVersion, setBaselineVersion] = useState(0);
  const [rewriting, setRewriting] = useState(false);
  const [manualOverride, setManualOverride] = useState(isTaskManual(task));
  const [manualBusy, setManualBusy] = useState(false);
  const [manualReason, setManualReason] = useState(getManualReason(task));
  const [workspaceId, setWorkspaceId] = useState(
    task?.workspace || activeWorkspaceId.value || "",
  );
  const [repository, setRepository] = useState(task?.repository || "");
  const [assignee, setAssignee] = useState(
    toText(pickTaskField(task, ["assignee"])),
  );
  const [assigneesInput, setAssigneesInput] = useState(
    normalizeTaskAssigneesInput(task),
  );
  const [epicId, setEpicId] = useState(
    toText(pickTaskField(task, ["epicId", "epic", "epic_id"])),
  );
  const [storyPoints, setStoryPoints] = useState(
    toText(pickTaskField(task, ["storyPoints", "points", "story_points"])),
  );
  const [dueDate, setDueDate] = useState(normalizeTaskDueDateInput(task));
  const [parentTaskId, setParentTaskId] = useState(
    toText(pickTaskField(task, ["parentTaskId", "parentId", "parent_task_id"])),
  );
  const [subtasks, setSubtasks] = useState([]);
  const [subtasksLoading, setSubtasksLoading] = useState(false);
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [creatingSubtask, setCreatingSubtask] = useState(false);
  const attachmentInputRef = useRef(null);
  const initialSnapshotRef = useRef({
    title: sanitizeTaskText(task?.title || ""),
    description: buildTaskDescriptionFallback(task?.title, task?.description),
    baseBranch: getTaskBaseBranch(task),
    status: task?.status || "todo",
    priority: task?.priority || "",
    tagsInput: getTaskTags(task).join(", "),
    draft: Boolean(task?.draft || task?.status === "draft"),
    assignee: toText(pickTaskField(task, ["assignee"])),
    assigneesInput: normalizeTaskAssigneesInput(task),
    epicId: toText(pickTaskField(task, ["epicId", "epic", "epic_id"])),
    storyPoints: toText(pickTaskField(task, ["storyPoints", "points", "story_points"])),
    dueDate: normalizeTaskDueDateInput(task),
    parentTaskId: toText(pickTaskField(task, ["parentTaskId", "parentId", "parent_task_id"])),
  });
  const pendingKey = useMemo(
    () => `modal:task-detail:${task?.id || "unknown"}`,
    [task?.id],
  );
  const activeWsId = activeWorkspaceId.value || "";
  const canDispatch = Boolean(onStart && task?.id);

  const historyEntries = useMemo(() => buildTaskHistoryEntries(task), [
    task?.id,
    task?.status,
    task?.statusHistory,
    task?.history,
    task?.timeline,
    task?.eventLog,
    task?.events,
    task?.activity,
  ]);
  const workflowRuns = useMemo(() => buildTaskWorkflowRuns(task), [
    task?.id,
    task?.workflowRuns,
    task?.workflowHistory,
    task?.workflows,
  ]);
  const relatedLinks = useMemo(() => buildTaskRelatedLinks(task), [
    task?.id,
    task?.branch,
    task?.branchName,
    task?.prNumber,
    task?.prUrl,
    task?.meta,
  ]);
  const taskAgents = useMemo(() => buildTaskAgentList(task), [
    task?.id,
    task?.assignee,
    task?.assignees,
    task?.meta,
  ]);

  const editableSnapshot = useMemo(
    () => ({
      title: title || "",
      description: description || "",
      baseBranch: baseBranch || "",
      status: status || "todo",
      priority: priority || "",
      tagsInput: tagsInput || "",
      draft: Boolean(draft),
      assignee: assignee || "",
      assigneesInput: assigneesInput || "",
      epicId: epicId || "",
      storyPoints: storyPoints || "",
      dueDate: dueDate || "",
      parentTaskId: parentTaskId || "",
    }),
    [
      assignee,
      assigneesInput,
      baseBranch,
      description,
      draft,
      dueDate,
      epicId,
      parentTaskId,
      priority,
      status,
      storyPoints,
      tagsInput,
      title,
    ],
  );
  const changeCount = useMemo(
    () => countChangedFields(initialSnapshotRef.current, editableSnapshot),
    [baselineVersion, editableSnapshot],
  );
  const hasUnsaved = changeCount > 0;
  const activeOperationLabel = saving
    ? "Task save is in progress"
    : rewriting
      ? "Improve with AI is still running"
      : uploadingAttachment
        ? "Attachment upload is still running"
        : manualBusy
          ? "Manual takeover update is in progress"
          : "";

  const workspaceOptions = managedWorkspaces.value || [];
  const selectedWorkspace = useMemo(
    () => workspaceOptions.find((ws) => ws.id === workspaceId) || null,
    [workspaceId, workspaceOptions],
  );
  const repositoryOptions = selectedWorkspace?.repos || [];

  useEffect(() => {
    const nextTitle = sanitizeTaskText(task?.title || "");
    const nextDescription = buildTaskDescriptionFallback(task?.title, task?.description);
    const nextBaseBranch = getTaskBaseBranch(task);
    const nextStatus = task?.status || "todo";
    const nextPriority = task?.priority || "";
    const nextTags = getTaskTags(task).join(", ");
    const nextDraft = Boolean(task?.draft || task?.status === "draft");
    setTitle(nextTitle);
    setDescription(nextDescription);
    setBaseBranch(nextBaseBranch);
    setStatus(nextStatus);
    setPriority(nextPriority);
    setTagsInput(nextTags);
    setAttachments(normalizeTaskAttachments(task));
    setComments(normalizeTaskComments(task));
    setCommentDraft("");
    setDependenciesInput(getTaskDependencyIds(task).join(", "));
    setDependencyFeedback("");
    setSelectedSprintId(getTaskSprintId(task));
    setSprintOrderInput(getTaskSprintOrder(task));
    setDraft(nextDraft);
    setManualOverride(isTaskManual(task));
    setManualReason(getManualReason(task));
    setWorkspaceId(task?.workspace || activeWorkspaceId.value || "");
    setRepository(task?.repository || "");
    setAssignee(toText(pickTaskField(task, ["assignee"])));
    setAssigneesInput(normalizeTaskAssigneesInput(task));
    setEpicId(toText(pickTaskField(task, ["epicId", "epic", "epic_id"])));
    setStoryPoints(toText(pickTaskField(task, ["storyPoints", "points", "story_points"])));
    setDueDate(normalizeTaskDueDateInput(task));
    setParentTaskId(toText(pickTaskField(task, ["parentTaskId", "parentId", "parent_task_id"])));
    initialSnapshotRef.current = {
      title: nextTitle,
      description: nextDescription,
      baseBranch: nextBaseBranch,
      status: nextStatus,
      priority: nextPriority,
      tagsInput: nextTags,
      draft: nextDraft,
      assignee: toText(pickTaskField(task, ["assignee"])),
      assigneesInput: normalizeTaskAssigneesInput(task),
      epicId: toText(pickTaskField(task, ["epicId", "epic", "epic_id"])),
      storyPoints: toText(pickTaskField(task, ["storyPoints", "points", "story_points"])),
      dueDate: normalizeTaskDueDateInput(task),
      parentTaskId: toText(pickTaskField(task, ["parentTaskId", "parentId", "parent_task_id"])),
    };
    setBaselineVersion((v) => v + 1);
  }, [task?.id]);

  useEffect(() => {
    if (!workspaceOptions.length) {
      loadWorkspaces().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (workspaceId || !activeWsId) return;
    setWorkspaceId(activeWsId);
  }, [activeWsId, workspaceId]);

  useEffect(() => {
    if (!repositoryOptions.length) {
      if (repository) setRepository("");
      return;
    }
    if (!repositoryOptions.some((repo) => repo?.slug === repository)) {
      const primary = repositoryOptions.find((repo) => repo?.primary);
      setRepository(primary?.slug || repositoryOptions[0]?.slug || "");
    }
  }, [workspaceId, repositoryOptions.length]);

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsaved);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsaved, pendingKey]);

  const handleDiscardChanges = useCallback(() => {
    const base = initialSnapshotRef.current || {};
    setTitle(base.title || "");
    setDescription(base.description || "");
    setBaseBranch(base.baseBranch || "");
    setStatus(base.status || "todo");
    setPriority(base.priority || "");
    setTagsInput(base.tagsInput || "");
    setDraft(Boolean(base.draft));
    setAssignee(base.assignee || "");
    setAssigneesInput(base.assigneesInput || "");
    setEpicId(base.epicId || "");
    setStoryPoints(base.storyPoints || "");
    setDueDate(base.dueDate || "");
    setParentTaskId(base.parentTaskId || "");
    showToast("Changes discarded", "info");
  }, []);

  const handleSave = async ({ closeAfterSave = true } = {}) => {
    setSaving(true);
    haptic("medium");
    const prev = cloneValue(tasksData.value);
    const cleanTitle = sanitizeTaskText(title).trim();
    const cleanDescription = buildTaskDescriptionFallback(title, description);
    const cleanTagsInput = sanitizeTaskText(tagsInput || "");
    const tags = normalizeTagInput(cleanTagsInput);
    const wantsDraft = draft || status === "draft";
    const nextStatus = wantsDraft ? "draft" : status;
    const assigneeValue = toText(assignee);
    const assigneesValue = normalizeDependencyInput(assigneesInput);
    const epicValue = toText(epicId);
    const storyPointsValue = toText(storyPoints);
    const dueDateValue = toText(dueDate);
    const parentTaskValue = toText(parentTaskId);
    try {
      await runOptimistic(
        () => {
          tasksData.value = tasksData.value.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  title: cleanTitle,
                  description: cleanDescription,
                  baseBranch,
                  status: nextStatus,
                  priority: priority || null,
                  tags,
                  draft: wantsDraft,
                  workspace: workspaceId || null,
                  repository: repository || null,
                  assignee: assigneeValue || null,
                  assignees: assigneesValue,
                  epicId: epicValue || null,
                  storyPoints: storyPointsValue || null,
                  dueDate: dueDateValue || null,
                  parentTaskId: parentTaskValue || null,
                }
              : t,
          );
        },
        async () => {
          const res = await apiFetch("/api/tasks/edit", {
            method: "POST",
            body: JSON.stringify({
              taskId: task.id,
              title: cleanTitle,
              description: cleanDescription,
              baseBranch,
              status: nextStatus,
              priority,
              tags,
              draft: wantsDraft,
              workspace: workspaceId || undefined,
              repository: repository || undefined,
              assignee: assigneeValue || undefined,
              assignees: assigneesValue.length ? assigneesValue : undefined,
              epicId: epicValue || undefined,
              storyPoints: storyPointsValue || undefined,
              dueDate: dueDateValue || undefined,
              parentTaskId: parentTaskValue || undefined,
            }),
          });
          if (res?.data)
            tasksData.value = tasksData.value.map((t) =>
              t.id === task.id ? { ...t, ...res.data } : t,
            );
          return res;
        },
        () => {
          tasksData.value = prev;
        },
      );
      showToast("Task saved", "success");
      setTitle(cleanTitle);
      setDescription(cleanDescription);
      initialSnapshotRef.current = {
        title: cleanTitle,
        description: cleanDescription,
        baseBranch,
        status: nextStatus,
        priority: priority || "",
        tagsInput: cleanTagsInput,
        draft: wantsDraft,
        assignee: assigneeValue,
        assigneesInput: assigneesValue.join(", "),
        epicId: epicValue,
        storyPoints: storyPointsValue,
        dueDate: dueDateValue,
        parentTaskId: parentTaskValue,
      };
      setBaselineVersion((v) => v + 1);
      clearPendingChange(pendingKey);
      if (closeAfterSave) {
        onClose?.();
        return { closed: true };
      }
      return true;
    } catch {
      /* toast via apiFetch */
      return false;
    } finally {
      setSaving(false);
    }
  };
  const handleStatusUpdate = async (newStatus) => {
    haptic("medium");
    try {
      const result = await applyTaskLifecycleTransition(task, newStatus);
      if (!result?.ok || result?.cancelled) return;

      if (result.status === "done" || result.status === "cancelled") {
        onClose();
      } else {
        setStatus(result.status);
        setDraft(result.status === "draft");
      }

      if (result.status === "inreview") {
        await reactivateTaskSession(task.id, {
          askFirst: true,
          title: task?.title || task?.id || "this task",
        }).catch(() => {});
      }
    } catch {
      /* toast */
    }
  };
  const handleStart = () => {
    if (onStart) onStart(task);
  };

  const uploadAttachments = async (files) => {
    if (!task?.id || uploadingAttachment) return;
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    setUploadingAttachment(true);
    try {
      const form = new FormData();
      form.append("taskId", task.id);
      if (task?.backend) form.append("backend", task.backend);
      for (const file of list) {
        form.append("file", file, file.name || "attachment");
      }
      const res = await apiFetch("/api/tasks/attachments/upload", {
        method: "POST",
        body: form,
      });
      if (Array.isArray(res?.attachments)) {
        setAttachments(res.attachments);
      } else {
        showToast("Attachment upload failed", "error");
      }
    } catch {
      showToast("Attachment upload failed", "error");
    } finally {
      setUploadingAttachment(false);
    }
  };

  const handleAttachmentPick = (e) => {
    const files = e.target?.files;
    if (files && files.length) uploadAttachments(files);
    if (e.target) e.target.value = "";
  };

  const handleAttachmentPaste = (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length) {
      e.preventDefault();
      uploadAttachments(files);
    }
  };


  const loadSprintAssignments = useCallback(async () => {
    const sprintMeta = await fetchFirstAvailableDagPath(DAG_SPRINT_ENDPOINT_CANDIDATES);
    const options = normalizeSprintOptions(sprintMeta?.payload);
    setSprintOptions(options);
    if (!options.length) return;
    setSelectedSprintId((prev) => {
      if (prev && options.some((entry) => entry.id === prev)) return prev;
      const taskSprint = getTaskSprintId(task);
      if (taskSprint && options.some((entry) => entry.id === taskSprint)) return taskSprint;
      return options[0].id;
    });
  }, [task?.id]);
  const loadSubtasks = useCallback(async () => {
    if (!task?.id) return;
    setSubtasksLoading(true);
    try {
      const res = await apiFetch(`/api/tasks/subtasks?taskId=${encodeURIComponent(task.id)}`, {
        _silent: true,
      });
      setSubtasks(normalizeSubtasksPayload(res));
    } catch {
      setSubtasks([]);
    } finally {
      setSubtasksLoading(false);
    }
  }, [task?.id]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        await Promise.all([loadSprintAssignments(), loadSubtasks()]);
      } catch {
        if (!cancelled) {
          setSprintOptions([]);
          setSubtasks([]);
        }
      }
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [loadSprintAssignments, loadSubtasks]);

  const handlePostComment = async () => {
    if (!task?.id || postingComment) return;
    const body = sanitizeTaskText(commentDraft || "").trim();
    if (!body) return;
    setPostingComment(true);
    setDependencyFeedback("");
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks/comment", {
        method: "POST",
        body: JSON.stringify({
          taskId: task.id,
          comment: body,
          body,
          text: body,
        }),
      });
      const payload = res?.data || res || {};
      const nextComments = normalizeTaskComments(
        payload?.task ||
          (Array.isArray(payload?.comments)
            ? { comments: payload.comments }
            : Array.isArray(payload?.data?.comments)
              ? { comments: payload.data.comments }
              : null),
      );
      if (nextComments.length) {
        setComments(nextComments);
      } else {
        setComments((prev) => [
          ...prev,
          {
            id: `local-${Date.now()}`,
            author: "you",
            createdAt: new Date().toISOString(),
            body,
          },
        ]);
      }
      setCommentDraft("");
      scheduleRefresh(120);
      showToast("Comment posted", "success");
    } catch {
      /* toast via apiFetch */
    } finally {
      setPostingComment(false);
    }
  };

  const handleSaveDependencies = async () => {
    if (!task?.id || savingDependencies) return;
    const dependencies = normalizeDependencyInput(dependenciesInput);
    const payload = {
      taskId: task.id,
      dependencies,
    };
    if (selectedSprintId) payload.sprintId = selectedSprintId;
    if (sprintOrderInput !== "") {
      const sprintOrderNumber = Number(sprintOrderInput);
      if (Number.isFinite(sprintOrderNumber)) {
        payload.sprintOrder = sprintOrderNumber;
      }
    }

    setSavingDependencies(true);
    setDependencyFeedback("");
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks/dependencies", {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      const nextDeps = normalizeDependencyInput(
        res?.data?.dependencies ||
          res?.dependencies ||
          res?.data?.task?.dependencyTaskIds ||
          dependencies,
      );
      setDependenciesInput(nextDeps.join(", "));
      setDependencyFeedback(nextDeps.length ? "Dependencies saved." : "Dependencies cleared.");
      showToast("Dependencies updated", "success");
      scheduleRefresh(120);
    } catch {
      setDependencyFeedback("Failed to update dependencies.");
    } finally {
      setSavingDependencies(false);
    }
  };

  const handleSaveSprintAssignment = async () => {
    if (!task?.id || savingSprint) return;
    const sprintId = toText(selectedSprintId);
    if (!sprintId) {
      showToast("Select a sprint first", "warning");
      return;
    }
    const sprintOrderNumber = sprintOrderInput === ""
      ? null
      : Number(sprintOrderInput);
    const payload = {
      taskId: task.id,
      sprintOrder: Number.isFinite(sprintOrderNumber) ? sprintOrderNumber : null,
    };

    setSavingSprint(true);
    setDependencyFeedback("");
    haptic("medium");
    try {
      await apiFetch(`/api/tasks/sprints/${encodeURIComponent(sprintId)}/tasks`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      showToast("Sprint assignment updated", "success");
      scheduleRefresh(120);
      setDependencyFeedback("Sprint assignment saved.");
    } catch {
      setDependencyFeedback("Failed to save sprint assignment.");
    } finally {
      setSavingSprint(false);
    }
  };

  const handleCreateSubtask = async () => {
    if (!task?.id || creatingSubtask) return;
    const cleanTitle = sanitizeTaskText(subtaskTitle || "").trim();
    if (!cleanTitle) return;
    setCreatingSubtask(true);
    haptic("medium");
    try {
      await apiFetch("/api/tasks/subtasks", {
        method: "POST",
        body: JSON.stringify({
          taskId: task.id,
          parentTaskId: task.id,
          title: cleanTitle,
        }),
      });
      setSubtaskTitle("");
      showToast("Subtask created", "success");
      await loadSubtasks();
      scheduleRefresh(120);
    } catch {
      showToast("Failed to create subtask", "error");
    } finally {
      setCreatingSubtask(false);
    }
  };
  const handleRetry = async () => {
    haptic("medium");
    try {
      await apiFetch("/api/tasks/retry", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id }),
      });
      showToast("Task retried", "success");
      onClose();
      scheduleRefresh(150);
    } catch {
      /* toast */
    }
  };

  const handleManualToggle = async (next) => {
    if (!task?.id || manualBusy) return;
    if (next) {
      const ok = await showConfirm(
        "Mark this task for manual takeover? Automation will skip it.",
      );
      if (!ok) return;
    }
    haptic("medium");
    const prevTasks = cloneValue(tasksData.value);
    const prevManual = manualOverride;
    const reason = String(manualReason || "").trim();
    setManualBusy(true);
    try {
      await runOptimistic(
        () => {
          setManualOverride(next);
          updateTaskManualState(task.id, next, reason || "manual");
        },
        async () => {
          const res = await apiFetch(
            next ? "/api/tasks/ignore" : "/api/tasks/unignore",
            {
              method: "POST",
              body: JSON.stringify({
                taskId: task.id,
                ...(next && reason ? { reason } : {}),
              }),
            },
          );
          return res;
        },
        () => {
          tasksData.value = prevTasks;
          setManualOverride(prevManual);
        },
      );
      showToast(
        next
          ? "Task marked for manual takeover"
          : "Task returned to automation",
        "success",
      );
      scheduleRefresh(150);
    } catch {
      /* toast via apiFetch */
    }
    setManualBusy(false);
  };

  const handleCancel = async () => {
    const ok = await showConfirm("Cancel this task?");
    if (!ok) return;
    await handleStatusUpdate("cancelled");
  };

  return html`
    <${Modal}
      title=${task?.title || "Task Detail"}
      onClose=${onClose}
      contentClassName="modal-content-wide task-detail-modal-jira"
      unsavedChanges=${changeCount}
      onSaveBeforeClose=${() => handleSave({ closeAfterSave: true })}
      onDiscardBeforeClose=${() => {
        handleDiscardChanges();
        return true;
      }}
      activeOperationLabel=${activeOperationLabel}
    >
      <div class="task-modal-summary jira-task-summary">
        <div class="task-modal-id" style="user-select:all">ID: ${task?.id}</div>
        <div class="task-modal-badges">
          <${Badge} status=${task?.status} text=${task?.status} />
          ${task?.priority &&
          html`<${Badge} status=${task.priority} text=${task.priority} />`}
          ${manualOverride && html`<${Badge} status="warning" text="manual" />`}
        </div>
        ${canDispatch &&
        html`
          <div class="task-modal-actions">
            <${Button} variant="contained" size="small" onClick=${handleStart}>
              ${iconText(":play: Dispatch Task")}
            <//>
          </div>
        `}
      </div>


      <div class="modal-form-span">
        <div class="task-comments-block jira-panel" style="padding:12px;border:1px solid var(--border);border-radius:12px;background:var(--bg-surface)">
          <div class="task-attachments-title">Tracking Overview</div>
          <div class="task-comments-list" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;">
            <div class="task-comment-item">
              <div class="task-comment-meta">Assigned Agents</div>
              <div class="task-comment-body">${taskAgents.length ? taskAgents.join(" · ") : "No agent assignment recorded."}</div>
            </div>
            <div class="task-comment-item">
              <div class="task-comment-meta">Workflow Runs</div>
              <div class="task-comment-body">${workflowRuns.length ? `${workflowRuns.length} linked runs` : "No workflow runs linked yet."}</div>
            </div>
            <div class="task-comment-item">
              <div class="task-comment-meta">Timeline Events</div>
              <div class="task-comment-body">${historyEntries.length ? `${historyEntries.length} recorded entries` : "No timeline history yet."}</div>
            </div>
            <div class="task-comment-item">
              <div class="task-comment-meta">Branch / PR</div>
              <div class="task-comment-body">${relatedLinks.length ? relatedLinks.map((item) => `${item.kind}: ${item.value}`).join(" · ") : "No branch or PR links recorded."}</div>
            </div>
          </div>
        </div>
      </div>

      ${workflowRuns.length > 0 && html`
        <div class="task-comments-block modal-form-span jira-panel">
          <div class="task-attachments-title">Workflow Activity</div>
          <div class="task-comments-list">
            ${workflowRuns.map((run, index) => html`
              <div class="task-comment-item" key=${`workflow-${index}`}>
                <div class="task-comment-meta">
                  ${run.workflowId || "workflow"}
                  ${run.runId ? ` · run ${run.runId}` : ""}
                  ${run.timestamp ? ` · ${formatRelative(run.timestamp)}` : ""}
                </div>
                <div class="task-comment-body">${run.status || run.result || "No status summary"}</div>
                ${run.result && run.status && run.result !== run.status && html`
                  <div class="task-comment-body">${run.result}</div>
                `}
              </div>
            `)}
          </div>
        </div>
      `}

      ${historyEntries.length > 0 && html`
        <div class="task-comments-block modal-form-span jira-panel">
          <div class="task-attachments-title">History Timeline</div>
          <div class="task-comments-list">
            ${historyEntries.map((entry, index) => html`
              <div class="task-comment-item" key=${`history-${index}`}>
                <div class="task-comment-meta">
                  ${entry.timestamp ? formatRelative(entry.timestamp) : "Time unknown"}
                  ${entry.source ? ` · ${entry.source}` : ""}
                </div>
                <div class="task-comment-body">${entry.label}</div>
              </div>
            `)}
          </div>
        </div>
      `}

      ${relatedLinks.length > 0 && html`
        <div class="task-comments-block modal-form-span jira-panel">
          <div class="task-attachments-title">Branch and PR Links</div>
          <div class="task-comments-list">
            ${relatedLinks.map((item, index) => html`
              <div class="task-comment-item" key=${`link-${index}`}>
                <div class="task-comment-meta">${item.kind}</div>
                <div class="task-comment-body">
                  ${item.url
                    ? html`<a href=${item.url} target="_blank" rel="noopener">${item.value}</a>`
                    : item.value}
                </div>
              </div>
            `)}
          </div>
        </div>
      `}        <div class="flex-col gap-md modal-form-grid jira-task-layout">
        <div class="input-with-mic modal-form-span">
          <${TextField} size="small" variant="outlined" placeholder="Title" value=${title} onInput=${(e) => setTitle(e.target.value)} fullWidth />
          <${VoiceMicButtonInline}
            onTranscript=${(t) => setTitle((prev) => (prev ? prev + " " + t : t))}
            disabled=${saving || rewriting}
          />
        </div>
        <div class="textarea-with-mic modal-form-span" style="position:relative">
          <${TextField} multiline rows=${5} size="small" placeholder="Description" value=${description} onInput=${(e) => setDescription(e.target.value)} style=${{ paddingRight: "36px" }} fullWidth />
          <${VoiceMicButton}
            onTranscript=${(t) => setDescription((prev) => (prev ? prev + " " + t : t))}
            disabled=${saving || rewriting}
            size="sm"
            className="textarea-mic-btn"
          />
        </div>
        <div
          class="task-attachments-block modal-form-span jira-panel"
          onPaste=${handleAttachmentPaste}
        >
          <div class="task-attachments-header">
            <div class="task-attachments-title">Attachments</div>
            <div class="task-attachments-actions">
              <${Button}
                variant="text" size="small"
                type="button"
                onClick=${() => attachmentInputRef.current && attachmentInputRef.current.click()}
                disabled=${uploadingAttachment}
              >
                Upload
              <//>
            </div>
          </div>
          <input
            ref=${attachmentInputRef}
            type="file"
            multiple
            style="display:none"
            onChange=${handleAttachmentPick}
          />
          ${attachments.length === 0 && !uploadingAttachment && html`
            <div class="meta-text">No attachments uploaded.</div>
          `}
          ${uploadingAttachment && html`
            <div class="meta-text">Uploading attachments...</div>
          `}
          ${attachments.length > 0 && html`
            <div class="task-attachments-list">
              ${attachments.map((att, index) => {
                const name = att.name || att.filename || "attachment";
                const url = att.url || att.filePath || att.path || "";
                const size = att.size ? formatBytes(att.size) : "";
                const isImage = isImageAttachment(att);
                return html`
                  <div class="task-attachment-item" key=${att.id || `${name}-${index}`}>
                    ${isImage && url
                      ? html`<img class="task-attachment-thumb" src=${url} alt=${name} />`
                      : html`<span class="task-attachment-icon">${resolveIcon(":link:")}</span>`}
                    <div class="task-attachment-meta">
                      ${url
                        ? html`<a class="task-attachment-name" href=${url} target="_blank" rel="noopener">${name}</a>`
                        : html`<span class="task-attachment-name">${name}</span>`}
                      <div class="task-attachment-sub">
                        ${(att.kind || "file")}${size ? ` · ${size}` : ""}
                      </div>
                    </div>
                  </div>
                `;
              })}
            </div>
          `}
        </div>
                <div class="task-comments-block modal-form-span jira-panel">
          <div class="task-attachments-title">Comments & Updates</div>
          <div class="task-comments-list">
            ${comments.length > 0
              ? comments.map((comment, index) => html`
                <div class="task-comment-item" key=${comment.id || `comment-${index}`}>
                  <div class="task-comment-meta">
                    ${comment.author ? `@${comment.author}` : "comment"}
                    ${comment.createdAt ? ` · ${formatRelative(comment.createdAt)}` : ""}
                  </div>
                  <div class="task-comment-body">${comment.body}</div>
                </div>
              `)
              : html`<div class="meta-text">No comments yet. Add one below.</div>`}
          </div>
          <div class="task-comment-composer">
            <${TextField}
              multiline
              rows=${2}
              size="small"
              placeholder="Add a comment or status update..."
              value=${commentDraft}
              onInput=${(e) => setCommentDraft(e.target.value)}
              fullWidth
            />
            <${Button}
              variant="contained"
              size="small"
              disabled=${postingComment || !sanitizeTaskText(commentDraft || "").trim()}
              onClick=${handlePostComment}
            >
              ${postingComment ? "Posting…" : "Post Comment"}
            <//>
          </div>
        </div>
        <div class="task-comments-block modal-form-span jira-subtasks-panel">
          <div class="task-attachments-header">
            <div class="task-attachments-title">Subtasks</div>
            <div class="task-attachments-actions">
              <${Button}
                variant="text"
                size="small"
                onClick=${loadSubtasks}
                disabled=${subtasksLoading || creatingSubtask}
              >
                ${subtasksLoading ? "Refreshing…" : "Refresh"}
              <//>
            </div>
          </div>
          <div class="task-comment-composer" style=${{ marginTop: "8px" }}>
            <${TextField}
              size="small"
              placeholder="Create subtask summary"
              value=${subtaskTitle}
              onInput=${(e) => setSubtaskTitle(e.target.value)}
              fullWidth
            />
            <${Button}
              variant="contained"
              size="small"
              disabled=${creatingSubtask || !sanitizeTaskText(subtaskTitle || "").trim()}
              onClick=${handleCreateSubtask}
            >
              ${creatingSubtask ? "Creating…" : "Add"}
            <//>
          </div>
          <div class="task-comments-list" style=${{ marginTop: "8px" }}>
            ${!subtasksLoading && !subtasks.length && html`<div class="meta-text">No subtasks yet.</div>`}
            ${subtasks.map((subtask) => html`
              <div class="task-comment-item" key=${subtask.id}>
                <div class="task-comment-meta">
                  <span style="user-select:all">${subtask.id}</span>
                  ${subtask.status ? ` · ${subtask.status}` : ""}
                  ${subtask.storyPoints ? ` · ${subtask.storyPoints} pts` : ""}
                </div>
                <div class="task-comment-body">${subtask.title}</div>
                ${subtask.assignee && html`<div class="task-comment-meta">Assignee: ${subtask.assignee}</div>`}
              </div>
            `)}
          </div>
        </div>
        <div class="task-comments-block modal-form-span jira-panel">
          <div class="task-attachments-title">Dependencies & Sprint Wiring</div>
          <${TextField}
            multiline
            rows=${2}
            size="small"
            placeholder="Dependency task IDs (comma or newline separated)"
            value=${dependenciesInput}
            onInput=${(e) => setDependenciesInput(e.target.value)}
            fullWidth
          />
          <div class="input-row" style=${{ marginTop: "8px" }}>
            <${Select}
              size="small"
              value=${selectedSprintId}
              onChange=${(e) => setSelectedSprintId(e.target.value)}
            >
              <${MenuItem} value="">No sprint</${MenuItem}>
              ${sprintOptions.map((sprint) => html`
                <${MenuItem} key=${sprint.id} value=${sprint.id}>${sprint.label}</${MenuItem}>
              `)}
            </${Select}>
            <${TextField}
              size="small"
              type="number"
              placeholder="Sprint order"
              value=${sprintOrderInput}
              onInput=${(e) => setSprintOrderInput(e.target.value)}
              inputProps=${{ min: 1, step: 1 }}
            />
          </div>
          <div class="btn-row" style=${{ marginTop: "8px" }}>
            <${Button}
              variant="outlined"
              size="small"
              disabled=${savingDependencies}
              onClick=${handleSaveDependencies}
            >
              ${savingDependencies ? "Saving…" : "Save Dependencies"}
            <//>
            <${Button}
              variant="outlined"
              size="small"
              disabled=${savingSprint || !selectedSprintId}
              onClick=${handleSaveSprintAssignment}
            >
              ${savingSprint ? "Saving…" : "Save Sprint Assignment"}
            <//>
            ${dependencyFeedback && html`<span class="meta-text">${dependencyFeedback}</span>`}
          </div>
        </div>
        <${Tooltip} title="Use AI to expand and improve this task description"><${Button}
          variant="text" size="small"
          style=${{ display: "flex", alignItems: "center", gap: "6px", alignSelf: "flex-start", fontSize: "12px", padding: "5px 10px", opacity: !title.trim() ? 0.45 : 1 }}
          disabled=${!title.trim() || rewriting || saving}
          onClick=${async () => {
            if (!title.trim() || rewriting) return;
            setRewriting(true);
            haptic("medium");
            try {
              const res = await apiFetch("/api/tasks/rewrite", {
                method: "POST",
                body: JSON.stringify({ title: title.trim(), description: description.trim() }),
              });
              if (res?.data) {
                if (res.data.title) setTitle(res.data.title);
                if (res.data.description) setDescription(res.data.description);
                showToast("Task description improved", "success");
                haptic("medium");
              }
            } catch { /* toast via apiFetch */ }
            setRewriting(false);
          }}
        >
          ${rewriting
            ? html`<span style="display:inline-block;animation:spin 0.8s linear infinite">${resolveIcon(":clock:")}</span> Improving…`
            : html`${iconText(":star: Improve with AI")}`
          }
        <//><//> 
        <${TextField} size="small" variant="outlined" className="modal-form-span" placeholder="Base branch (optional, e.g. feature/xyz)" value=${baseBranch} onInput=${(e) => setBaseBranch(e.target.value)} fullWidth />        <div class="modal-form-span jira-meta-grid">
          <${TextField}
            size="small"
            variant="outlined"
            label="Assignee"
            value=${assignee}
            onInput=${(e) => setAssignee(e.target.value)}
            fullWidth
          />
          <${TextField}
            size="small"
            variant="outlined"
            label="Assignees"
            placeholder="alice, bob"
            value=${assigneesInput}
            onInput=${(e) => setAssigneesInput(e.target.value)}
            fullWidth
          />
          <${TextField}
            size="small"
            variant="outlined"
            label="Epic"
            value=${epicId}
            onInput=${(e) => setEpicId(e.target.value)}
            fullWidth
          />
          <${TextField}
            size="small"
            variant="outlined"
            type="number"
            label="Story Points"
            value=${storyPoints}
            onInput=${(e) => setStoryPoints(e.target.value)}
            fullWidth
          />
          <${TextField}
            size="small"
            variant="outlined"
            type="date"
            label="Due Date"
            value=${dueDate}
            onInput=${(e) => setDueDate(e.target.value)}
            InputLabelProps=${{ shrink: true }}
            fullWidth
          />
          <${TextField}
            size="small"
            variant="outlined"
            label="Parent Task"
            value=${parentTaskId}
            onInput=${(e) => setParentTaskId(e.target.value)}
            fullWidth
          />
        </div>
        <div class="input-row modal-form-span">
          <${Select}
            size="small"
            value=${workspaceId}
            onChange=${(e) => setWorkspaceId(e.target.value)}
          >
            <${MenuItem} value="">Active workspace</${MenuItem}>
            ${workspaceOptions.map(
              (ws) => html`<${MenuItem} value=${ws.id}>${ws.name || ws.id}</${MenuItem}>`,
            )}
          </${Select}>
          <${Select}
            size="small"
            value=${repository}
            onChange=${(e) => setRepository(e.target.value)}
            disabled=${!repositoryOptions.length}
          >
            <${MenuItem} value="">
              ${repositoryOptions.length ? "Auto repository" : "No repos in workspace"}
            </${MenuItem}>
            ${repositoryOptions.map(
              (repo) =>
                html`<${MenuItem} value=${repo.slug}>${repo.name}${repo.primary ? " (Primary)" : ""}</${MenuItem}>`,
            )}
          </${Select}>
        </div>
        <${TextField} size="small" variant="outlined" className="modal-form-span" placeholder="Tags (comma-separated)" value=${tagsInput} onInput=${(e) => setTagsInput(e.target.value)} fullWidth />
        ${normalizeTagInput(tagsInput).length > 0 &&
        html`
          <div class="tag-row modal-form-span">
            ${normalizeTagInput(tagsInput).map(
              (tag) => html`<span class="tag-chip">#${tag}</span>`,
            )}
          </div>
        `}

        <div class="input-row modal-form-span">
          <${Select}
            size="small"
            value=${status}
            onChange=${(e) => {
              const next = e.target.value;
              setStatus(next);
              if (next === "draft") setDraft(true);
              else if (draft) setDraft(false);
            }}
          >
            ${["draft", "todo", "inprogress", "inreview", "done", "cancelled"].map(
              (s) => html`<${MenuItem} value=${s}>${s}</${MenuItem}>`,
            )}
          </${Select}>
          <${Select}
            size="small"
            value=${priority}
            onChange=${(e) => setPriority(e.target.value)}
          >
            <${MenuItem} value="">No priority</${MenuItem}>
            ${["low", "medium", "high", "critical"].map(
              (p) => html`<${MenuItem} value=${p}>${p}</${MenuItem}>`,
            )}
          </${Select}>
        </div>
        <div class="modal-form-span">
          <${Toggle}
            label="Draft (keep in backlog)"
            checked=${draft}
            onChange=${(next) => {
              setDraft(next);
              if (next) setStatus("draft");
              else if (status === "draft") setStatus("todo");
            }}
          />
        </div>
        <div class="modal-form-span">
          <${Toggle}
            label="Manual takeover (exclude from automation)"
            checked=${manualOverride}
            disabled=${manualBusy || !task?.id}
            onChange=${handleManualToggle}
          />
        </div>
        <${TextField} size="small" variant="outlined" className="modal-form-span" placeholder="Manual reason (optional)" value=${manualReason} disabled=${manualBusy} onInput=${(e) => setManualReason(e.target.value)} fullWidth />
        ${manualOverride &&
        html`
          <div class="modal-form-span">
            <div class="meta-text">
              Bosun will skip this task until manual takeover is cleared.
            </div>
            ${manualReason &&
            html`<div class="meta-text">Reason: ${manualReason}</div>`}
          </div>
        `}

        ${task?.created_at &&
        html`
          <div class="meta-text modal-form-span">
            Created: ${new Date(task.created_at).toLocaleString()}
          </div>
        `}
        ${task?.updated_at &&
        html`
          <div class="meta-text modal-form-span">
            Updated: ${formatRelative(task.updated_at)}
          </div>
        `}
        ${task?.meta?.triggerTemplate?.id &&
        html`
          <div class="meta-text modal-form-span">
            Trigger Template: ${task.meta.triggerTemplate.id}
          </div>
        `}
        ${(task?.meta?.execution?.sdk || task?.meta?.execution?.model) &&
        html`
          <div class="meta-text modal-form-span">
            Execution Override:
            ${task?.meta?.execution?.sdk || "auto"}
            ${task?.meta?.execution?.model
              ? html` · ${task.meta.execution.model}`
              : ""}
          </div>
        `}
        ${task?.assignee &&
        html` <div class="meta-text modal-form-span">Assignee: ${task.assignee}</div> `}
        ${task?.branch &&
        html`
          <div class="meta-text modal-form-span" style="user-select:all">
            Branch: ${task.branch}
          </div>
        `}

        <${SaveDiscardBar}
          dirty=${hasUnsaved}
          message=${unsavedChangesMessage(changeCount)}
          saveLabel="Save Changes"
          discardLabel="Discard"
          onSave=${() => {
            void handleSave({ closeAfterSave: false });
          }}
          onDiscard=${handleDiscardChanges}
          saving=${saving}
          disabled=${Boolean(activeOperationLabel && !saving)}
        />

        <div class="btn-row modal-form-span">
          ${(task?.status === "error" || task?.status === "cancelled") &&
          html`
            <${Button} variant="contained" size="small" onClick=${handleRetry}>
              ↻ Retry
            <//>
          `}
          <${Button}
            variant="outlined" size="small"
            onClick=${() => {
              void handleSave({ closeAfterSave: true });
            }}
            disabled=${saving}
          >
            ${saving ? "Saving…" : iconText(":save: Save")}
          <//>
          <${Button}
            variant="text" size="small"
            onClick=${() => handleStatusUpdate("inreview")}
          >
            → Review
          <//>
          <${Button}
            variant="text" size="small"
            onClick=${() => handleStatusUpdate("done")}
          >
            ${iconText("✓ Done")}
          <//>
          ${task?.status !== "cancelled" &&
          html`
            <${Button}
              variant="text" size="small"
              style=${{ color: "var(--color-error)" }}
              onClick=${handleCancel}
            >
              ${iconText("✕ Cancel")}
            <//>
          `}
        </div>

        ${task?.id &&
        html`
          <${Button}
            variant="text" size="small"
            onClick=${() => {
              haptic();
              sendCommandToChat("/logs " + task.id);
            }}
          >
            ${iconText(":file: View Agent Logs")}
          <//>
        `}
      </div>
    <//>
  `;
}

function DagGraphSection({
  title,
  description = "",
  graph = EMPTY_DAG_GRAPH,
  onOpenTask,
  onCreateEdge,
  allowWiring = false,
  graphKey = "dag",
  emptyMessage = "No DAG nodes available for this view yet.",
}) {
  const stageRef = useRef(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 24, y: 24 });
  const [isPanning, setIsPanning] = useState(false);
  const [wireSourceId, setWireSourceId] = useState("");
  const [wiringBusy, setWiringBusy] = useState(false);

  const sortedNodes = useMemo(() => {
    const nodes = [...(graph?.nodes || [])];
    nodes.sort((a, b) => {
      const ad = Number.isFinite(a?.depth) ? Number(a.depth) : Number.MAX_SAFE_INTEGER;
      const bd = Number.isFinite(b?.depth) ? Number(b.depth) : Number.MAX_SAFE_INTEGER;
      if (ad !== bd) return ad - bd;
      const ao = Number.isFinite(a?.order) ? Number(a.order) : Number.MAX_SAFE_INTEGER;
      const bo = Number.isFinite(b?.order) ? Number(b.order) : Number.MAX_SAFE_INTEGER;
      if (ao !== bo) return ao - bo;
      return String(a?.title || a?.id || "").localeCompare(String(b?.title || b?.id || ""));
    });
    return nodes;
  }, [graph?.nodes]);

  const levels = useMemo(() => {
    const map = new Map();
    for (const node of sortedNodes) {
      const depth = Number.isFinite(node?.depth)
        ? Number(node.depth)
        : Number.isFinite(node?.order)
          ? Number(node.order)
          : 0;
      const key = Math.max(0, Math.trunc(depth));
      const list = map.get(key) || [];
      list.push(node);
      map.set(key, list);
    }
    if (!map.size && sortedNodes.length) map.set(0, [...sortedNodes]);
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [sortedNodes]);

  const layout = useMemo(() => {
    const nodeWidth = 250;
    const nodeHeight = 92;
    const colGap = 130;
    const rowGap = 34;
    const marginX = 40;
    const marginY = 28;

    const positions = new Map();
    let maxRows = 1;
    levels.forEach(([, nodes], colIdx) => {
      maxRows = Math.max(maxRows, nodes.length);
      nodes.forEach((node, rowIdx) => {
        const x = marginX + colIdx * (nodeWidth + colGap);
        const y = marginY + rowIdx * (nodeHeight + rowGap);
        positions.set(String(node.id), { x, y, width: nodeWidth, height: nodeHeight, node });
      });
    });

    const totalWidth = Math.max(720, marginX * 2 + Math.max(1, levels.length) * nodeWidth + Math.max(0, levels.length - 1) * colGap);
    const totalHeight = Math.max(360, marginY * 2 + maxRows * nodeHeight + Math.max(0, maxRows - 1) * rowGap);
    return { positions, totalWidth, totalHeight };
  }, [levels]);

  const edges = useMemo(() => {
    const raw = Array.isArray(graph?.edges) ? graph.edges : [];
    return raw
      .map((edge) => {
        const sourceId = String(edge?.source || edge?.from || "").trim();
        const targetId = String(edge?.target || edge?.to || "").trim();
        if (!sourceId || !targetId) return null;
        const source = layout.positions.get(sourceId);
        const target = layout.positions.get(targetId);
        if (!source || !target) return null;
        const kind = toText(edge?.kind || edge?.type || "depends-on", "depends-on").toLowerCase();
        return { source, target, kind };
      })
      .filter(Boolean);
  }, [graph?.edges, layout.positions]);

  const worldBounds = useMemo(() => ({ width: layout.totalWidth, height: layout.totalHeight }), [layout]);

  const fitToView = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const availableWidth = Math.max(320, rect.width - 24);
    const availableHeight = Math.max(240, rect.height - 24);
    const scaleX = availableWidth / Math.max(1, worldBounds.width);
    const scaleY = availableHeight / Math.max(1, worldBounds.height);
    const nextZoom = Math.max(DAG_MIN_ZOOM, Math.min(DAG_MAX_ZOOM, Math.min(scaleX, scaleY)));
    const nextPanX = (rect.width - worldBounds.width * nextZoom) / 2;
    const nextPanY = (rect.height - worldBounds.height * nextZoom) / 2;
    setZoom(nextZoom);
    setPan({ x: nextPanX, y: nextPanY });
  }, [worldBounds.width, worldBounds.height]);

  useEffect(() => {
    fitToView();
  }, [fitToView, graphKey, sortedNodes.length, edges.length]);

  const applyZoomAtPoint = useCallback((nextZoom, clientX, clientY) => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clamped = Math.max(DAG_MIN_ZOOM, Math.min(DAG_MAX_ZOOM, nextZoom));
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const worldX = (localX - pan.x) / zoom;
    const worldY = (localY - pan.y) / zoom;
    setZoom(clamped);
    setPan({ x: localX - worldX * clamped, y: localY - worldY * clamped });
  }, [pan.x, pan.y, zoom]);

  const handleWheel = useCallback((event) => {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 1.1 : 0.9;
    applyZoomAtPoint(zoom * delta, event.clientX, event.clientY);
  }, [applyZoomAtPoint, zoom]);

  const handlePanStart = useCallback((event) => {
    if (event.button !== 0) return;
    const targetEl = event.target;
    if (targetEl?.closest?.(".dag-node")) return;
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    setIsPanning(true);
    const onMove = (moveEvent) => {
      setPan({ x: start.panX + (moveEvent.clientX - start.x), y: start.panY + (moveEvent.clientY - start.y) });
    };
    const onUp = () => {
      setIsPanning(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [pan.x, pan.y]);

  const nodeById = useMemo(() => {
    const map = new Map();
    for (const node of sortedNodes) map.set(String(node.id), node);
    return map;
  }, [sortedNodes]);

  const handleNodeClick = useCallback(async (node, event) => {
    event?.stopPropagation?.();
    if (allowWiring && typeof onCreateEdge === "function") {
      const id = String(node?.id || "");
      if (!id || wiringBusy) return;
      if (!wireSourceId) {
        setWireSourceId(id);
        return;
      }
      if (wireSourceId === id) {
        setWireSourceId("");
        return;
      }
      const sourceNode = nodeById.get(wireSourceId) || null;
      const targetNode = nodeById.get(id) || null;
      if (!sourceNode || !targetNode) {
        setWireSourceId("");
        return;
      }
      setWiringBusy(true);
      try {
        await onCreateEdge({ sourceNode, targetNode });
      } finally {
        setWireSourceId("");
        setWiringBusy(false);
      }
      return;
    }
    if (node?.taskId) onOpenTask?.(node.taskId);
  }, [allowWiring, onCreateEdge, onOpenTask, wireSourceId, nodeById, wiringBusy]);

  if (!sortedNodes.length) {
    return html`
      <${Paper} variant="outlined" style=${{ padding: "12px", marginBottom: "10px" }}>
        <div class="meta-text">${emptyMessage}</div>
      <//>
    `;
  }

  return html`
    <div class="tasks-dag-section">
      <div class="task-dag-header-row">
        <div>
          <div style=${{ fontWeight: "700" }}>${title || "Task DAG"}</div>
          ${description ? html`<div class="meta-text">${description}</div>` : null}
          <div class="meta-text">Drag to pan · wheel to zoom · click node to ${allowWiring ? "wire edges" : "open task"}.</div>
        </div>
        <div class="task-dag-controls">
          <${Button} size="small" variant="outlined" onClick=${() => setZoom((z) => Math.max(DAG_MIN_ZOOM, z * 0.9))}>-</${Button}>
          <${Button} size="small" variant="outlined" onClick=${() => setZoom((z) => Math.min(DAG_MAX_ZOOM, z * 1.1))}>+</${Button}>
          <${Button} size="small" variant="outlined" onClick=${fitToView}>Fit</${Button}>
          <${Button} size="small" variant="text" onClick=${() => { setZoom(1); setPan({ x: 24, y: 24 }); }}>Reset</${Button}>
          <span class="task-dag-zoom-pill">${Math.round(zoom * 100)}%</span>
          ${allowWiring
            ? html`<span class="task-dag-wire-pill">${wireSourceId ? `Source: ${wireSourceId}` : wiringBusy ? "Saving edge…" : "Wiring: click source then target"}</span>`
            : null}
        </div>
      </div>
      <div class="task-dag-legend">
        <span class="task-dag-legend-item"><span class="task-dag-legend-line" style=${{ background: "var(--accent)" }}></span>depends-on</span>
        <span class="task-dag-legend-item"><span class="task-dag-legend-line task-dag-legend-line-dashed"></span>sequential</span>
        <span class="task-dag-legend-item"><span class="task-dag-legend-line task-dag-legend-line-block"></span>blocks</span>
      </div>
      <div class=${`task-dag-canvas-wrap ${isPanning ? "is-panning" : ""}`} ref=${stageRef} onWheel=${handleWheel} onPointerDown=${handlePanStart}>
        <svg class="task-dag-canvas" role="img" aria-label="Task dependency graph">
          <defs>
            <marker id=${`dag-arrow-${graphKey}`} markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto">
              <path d="M0,0 L10,4 L0,8 z" fill="var(--accent)" />
            </marker>
          </defs>
          <g transform=${`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
            <rect x="0" y="0" width=${worldBounds.width} height=${worldBounds.height} fill="transparent" />
            ${edges.map(({ source, target, kind }, idx) => {
              const x1 = source.x + source.width;
              const y1 = source.y + source.height / 2;
              const x2 = target.x;
              const y2 = target.y + target.height / 2;
              const c1 = x1 + Math.max(40, (x2 - x1) * 0.35);
              const c2 = x2 - Math.max(30, (x2 - x1) * 0.35);
              const style = DAG_EDGE_STYLES[kind] || DAG_EDGE_STYLES["depends-on"];
              return html`
                <path
                  key=${`edge-${idx}`}
                  d=${`M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke=${style.color}
                  stroke-dasharray=${style.dash || ""}
                  stroke-opacity="0.75"
                  stroke-width="2"
                  marker-end=${`url(#dag-arrow-${graphKey})`}
                />
              `;
            })}
            ${sortedNodes.map((node) => {
              const pos = layout.positions.get(String(node.id));
              if (!pos) return null;
              const selected = wireSourceId && String(node.id) === wireSourceId;
              return html`
                <g
                  key=${node.id}
                  class=${`dag-node ${selected ? "dag-node-selected" : ""}`}
                  onPointerDown=${(event) => event.stopPropagation()}
                  onClick=${(event) => handleNodeClick(node, event)}
                  style=${{ cursor: allowWiring || node.taskId ? "pointer" : "default" }}
                >
                  <rect
                    x=${pos.x}
                    y=${pos.y}
                    width=${pos.width}
                    height=${pos.height}
                    rx="14"
                    ry="14"
                    fill="var(--bg-surface)"
                    stroke=${selected ? "var(--accent)" : "var(--border)"}
                    stroke-width=${selected ? "2.2" : "1.5"}
                  />
                  <text x=${pos.x + 12} y=${pos.y + 24} fill="var(--text-primary)" font-size="13" font-weight="700">
                    ${truncate(node.title || "(untitled)", 34)}
                  </text>
                  <text x=${pos.x + 12} y=${pos.y + 44} fill="var(--text-muted)" font-size="11">
                    ${truncate(node.taskId || node.id, 38)}
                  </text>
                  <text x=${pos.x + 12} y=${pos.y + 64} fill="var(--accent)" font-size="11">
                    ${String(node.status || "todo")}
                  </text>
                  ${Number.isFinite(node.order) && html`<text x=${pos.x + pos.width - 16} y=${pos.y + 22} text-anchor="end" fill="var(--text-muted)" font-size="11">#${node.order}</text>`}
                </g>
              `;
            })}
          </g>
        </svg>
      </div>
    </div>
  `;
}
/* ─── TasksTab ─── */
export function TasksTab() {
  const [showCreate, setShowCreate] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [detailTask, setDetailTask] = useState(null);
  const [startTarget, setStartTarget] = useState(null);
  const [startAnyOpen, setStartAnyOpen] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [kanbanLoadingMore, setKanbanLoadingMore] = useState(false);
  const [listSortCol, setListSortCol] = useState("");   // active column sort in list mode
  const [listSortDir, setListSortDir] = useState("desc"); // "asc" | "desc"
  const [dagLoading, setDagLoading] = useState(false);
  const [dagError, setDagError] = useState("");
  const [dagSprints, setDagSprints] = useState([]);
  const [dagSelectedSprint, setDagSelectedSprint] = useState("all");
  const [dagSprintGraph, setDagSprintGraph] = useState(EMPTY_DAG_GRAPH);
  const [dagGlobalGraph, setDagGlobalGraph] = useState(EMPTY_DAG_GRAPH);
  const [dagEpicGraph, setDagEpicGraph] = useState(EMPTY_DAG_GRAPH);
  const [dagSources, setDagSources] = useState({ sprints: "", sprintGraph: "", globalGraph: "", epicDeps: "", tasks: "" });
  const [dagSprintOrderMode, setDagSprintOrderMode] = useState("parallel");
  const [isCompact, setIsCompact] = useState(() => {
    try { return globalThis.matchMedia?.("(max-width: 768px)")?.matches ?? false; }
    catch { return false; }
  });
  const searchRef = useRef(null);
  const actionsRef = useRef(null);
  const listStateRef = useRef({
    filter: tasksFilter?.value ?? "all",
    priority: tasksPriority?.value ?? "",
    sort: tasksSort?.value ?? "updated",
    page: tasksPage?.value ?? 0,
    pageSize: tasksPageSize?.value ?? 25,
  });

  /* Detect desktop for keyboard shortcut hint */
  const [showKbdHint] = useState(() => {
    try { return globalThis.matchMedia?.("(hover: hover)")?.matches ?? false; }
    catch { return false; }
  });
  const isMac = typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform || "");

  const tasks = tasksData.value || [];
  const filterVal = tasksFilter?.value ?? "todo";
  const priorityVal = tasksPriority?.value ?? "";
  const searchVal = tasksSearch?.value ?? "";
  const sortVal = tasksSort?.value ?? "updated";
  const page = tasksPage?.value ?? 0;
  const pageSize = tasksPageSize?.value ?? 25;
  const totalPages = tasksTotalPages?.value ?? 1;
  const defaultSdk = executorData.value?.data?.sdk || "auto";
  const activeSlots = executorData.value?.data?.slots || [];
  const hasActiveSlots = activeSlots.length > 0;
  const completedOnly = filterVal === "done";
  const trimmedSearch = searchVal.trim();
  const statusLabel =
    STATUS_CHIPS.find((s) => s.value === filterVal)?.label || "All";
  const priorityLabel =
    PRIORITY_CHIPS.find((p) => p.value === priorityVal)?.label || "Any";
  const sortLabel =
    SORT_OPTIONS.find((o) => o.value === sortVal)?.label || "Updated";
  const hasSearch = Boolean(trimmedSearch);
  const hasStatusFilter = filterVal && filterVal !== "all";
  const hasPriorityFilter = Boolean(priorityVal);
  const hasSortFilter = sortVal && sortVal !== "updated";
  const hasActiveFilters =
    hasSearch || hasStatusFilter || hasPriorityFilter || hasSortFilter;
  const activeFilterCount =
    [hasSearch, hasStatusFilter, hasPriorityFilter, hasSortFilter]
      .filter(Boolean).length;
  const filterSummaryParts = [];
  if (hasSearch)
    filterSummaryParts.push(`Search: "${truncate(trimmedSearch, 24)}"`);
  if (hasStatusFilter) filterSummaryParts.push(`Status: ${statusLabel}`);
  if (hasPriorityFilter) filterSummaryParts.push(`Priority: ${priorityLabel}`);
  if (hasSortFilter) filterSummaryParts.push(`Sort: ${sortLabel}`);
  const filterSummary = filterSummaryParts.join(" · ");
  const lastNonCompletedRef = useRef(
    filterVal && filterVal !== "done" ? filterVal : "all",
  );
  const isKanban = viewMode.value === "kanban";
  const isDag = viewMode.value === "dag";
  const isList = !isKanban && !isDag;
  const viewModeInitRef = useRef(false);
  const hasMoreKanbanPages = isKanban && page + 1 < totalPages;
  const boardColumnTotals = tasksStatusCounts?.value || { draft: 0, backlog: 0, inProgress: 0, inReview: 0, done: 0 };
  const boardTotalTasks = Number(tasksTotal?.value || 0);

  const loadMoreKanbanTasks = useCallback(async () => {
    if (!isKanban || kanbanLoadingMore || isSearching) return;
    if (!hasMoreKanbanPages) return;
    setKanbanLoadingMore(true);
    if (tasksPage) tasksPage.value = page + 1;
    try {
      await loadTasks({ append: true });
    } finally {
      setKanbanLoadingMore(false);
    }
  }, [hasMoreKanbanPages, isKanban, isSearching, kanbanLoadingMore, page]);

  const loadDagViews = useCallback(async () => {
    const sprintMeta = await fetchFirstAvailableDagPath(DAG_SPRINT_ENDPOINT_CANDIDATES);
    const sprintOptions = normalizeSprintOptions(sprintMeta?.payload);
    const resolvedSprint =
      dagSelectedSprint !== "all" && sprintOptions.some((entry) => entry.id === dagSelectedSprint)
        ? dagSelectedSprint
        : sprintOptions[0]?.id || "all";

    const sprintGraphCandidates = DAG_GRAPH_ENDPOINT_CANDIDATES.flatMap((basePath) =>
      buildSprintPathCandidates(basePath, resolvedSprint),
    );
    const globalGraphCandidates = DAG_GLOBAL_ENDPOINT_CANDIDATES.flatMap((basePath) =>
      buildSprintPathCandidates(basePath, resolvedSprint),
    );

    const sprintGraphMeta = await fetchFirstAvailableDagPath(sprintGraphCandidates);
    const globalGraphMeta = await fetchFirstAvailableDagPath(globalGraphCandidates);
    const epicDepsMeta = await fetchFirstAvailableDagPath(DAG_EPIC_DEPENDENCY_ENDPOINT_CANDIDATES);
    const tasksMeta = await fetchFirstAvailableDagPath(["/api/tasks?limit=1000", "/api/tasks?limit=500"]);

    const globalSource =
      extractGlobalDagPayload(
        globalGraphMeta?.payload,
        sprintGraphMeta?.payload,
        sprintMeta?.payload,
      ) || globalGraphMeta?.payload;

    const nextSprintGraph = normalizeDagGraph(
      sprintGraphMeta?.payload,
      resolvedSprint === "all" ? "All Sprint Task DAG" : `Sprint ${resolvedSprint} DAG`,
    );
    const nextGlobalGraph = normalizeDagGraph(globalSource, "DAG of DAGs");

    const allTasksPayload = extractDagPayload(tasksMeta?.payload);
    const allTasks = Array.isArray(allTasksPayload?.data)
      ? allTasksPayload.data
      : Array.isArray(allTasksPayload?.tasks)
        ? allTasksPayload.tasks
        : Array.isArray(allTasksPayload)
          ? allTasksPayload
          : tasks;
    const epicDeps = normalizeEpicDependenciesPayload(epicDepsMeta?.payload);
    const nextEpicGraph = buildEpicDagGraph(allTasks, epicDeps);

    const sprintMetaEntry = sprintOptions.find((entry) => entry.id === resolvedSprint) || null;
    setDagSprintOrderMode(toText(sprintMetaEntry?.executionMode || sprintMetaEntry?.taskOrderMode || sprintMetaEntry?.sprintOrderMode || "parallel", "parallel"));
    setDagSprints(sprintOptions);
    setDagSprintGraph(nextSprintGraph);
    setDagGlobalGraph(nextGlobalGraph);
    setDagEpicGraph(nextEpicGraph);
    setDagSources({
      sprints: sprintMeta?.path || "",
      sprintGraph: sprintGraphMeta?.path || "",
      globalGraph: globalGraphMeta?.path || "",
      epicDeps: epicDepsMeta?.path || "",
      tasks: tasksMeta?.path || "",
    });

    if (resolvedSprint !== dagSelectedSprint) {
      setDagSelectedSprint(resolvedSprint);
    }

    const hasAnyGraphData =
      nextSprintGraph.nodes.length > 0 ||
      nextGlobalGraph.nodes.length > 0 ||
      nextEpicGraph.nodes.length > 0;
    if (!hasAnyGraphData) {
      throw new Error("No DAG data was returned from DAG endpoints.");
    }
  }, [dagSelectedSprint, tasks]);

  useEffect(() => {
    if (!isDag) return;
    let cancelled = false;

    const run = async () => {
      setDagLoading(true);
      setDagError("");
      try {
        await loadDagViews();
      } catch (error) {
        if (!cancelled) {
          setDagError(error?.message || "Failed to load DAG views.");
        }
      } finally {
        if (!cancelled) setDagLoading(false);
      }
    };

    run();
    return () => {
      cancelled = true;
    };
  }, [isDag, dagSelectedSprint, loadDagViews]);

  // Add/remove body class so kanban.css can apply height-bounded flex layout
  // to main-content, enabling per-column vertical scroll on mobile.
  useEffect(() => {
    document.body.classList.toggle("tasks-board-view", isKanban);
    return () => { document.body.classList.remove("tasks-board-view"); };
  }, [isKanban, isList]);

  useEffect(() => {
    if (filterVal && filterVal !== "done") {
      lastNonCompletedRef.current = filterVal;
    }
  }, [filterVal]);

  useEffect(() => {
    if (viewModeInitRef.current) return;
    if (isCompact) {
      viewMode.value = "list";
    }
    viewModeInitRef.current = true;
  }, [isCompact]);

  useEffect(() => {
    if (isKanban) return;
    listStateRef.current = {
      filter: filterVal,
      priority: priorityVal,
      sort: sortVal,
      page,
      pageSize,
    };
  }, [isList, filterVal, priorityVal, sortVal, page, pageSize]);

  useEffect(() => {
    let shouldReload = false;
    if (isKanban) {
      if (tasksFilter?.value !== "all") {
        tasksFilter.value = "all";
        shouldReload = true;
      }
      if (tasksPriority?.value) {
        tasksPriority.value = "";
        shouldReload = true;
      }
      if (tasksPage?.value !== 0) {
        tasksPage.value = 0;
        shouldReload = true;
      }
      if ((tasksPageSize?.value ?? 0) !== 25) {
        tasksPageSize.value = 25;
        shouldReload = true;
      }
    } else if (isList && listStateRef.current) {
      const next = listStateRef.current;
      if (tasksFilter?.value !== (next.filter ?? "all")) {
        tasksFilter.value = next.filter ?? "all";
        shouldReload = true;
      }
      if (tasksPriority?.value !== (next.priority ?? "")) {
        tasksPriority.value = next.priority ?? "";
        shouldReload = true;
      }
      if (tasksSort?.value !== (next.sort ?? "updated")) {
        tasksSort.value = next.sort ?? "updated";
        shouldReload = true;
      }
      if (tasksPage?.value !== (next.page ?? 0)) {
        tasksPage.value = next.page ?? 0;
        shouldReload = true;
      }
      if (tasksPageSize?.value !== (next.pageSize ?? 20)) {
        tasksPageSize.value = next.pageSize ?? 20;
        shouldReload = true;
      }
    }
    if (shouldReload) loadTasks();
  }, [isKanban, isList]);

  useEffect(() => {
    let mq;
    try { mq = globalThis.matchMedia?.("(max-width: 768px)"); }
    catch { mq = null; }
    if (!mq) return undefined;
    const handler = (event) => setIsCompact(event.matches);
    handler(mq);
    if (mq.addEventListener) mq.addEventListener("change", handler);
    else mq.addListener(handler);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", handler);
      else mq.removeListener(handler);
    };
  }, []);

  useEffect(() => {
    if (isCompact) {
      setFiltersOpen(false);
      setActionsOpen(false);
    }
  }, [isCompact]);


  useEffect(() => {
    if (!actionsOpen || typeof document === "undefined") return undefined;
    const handlePointerDown = (event) => {
      if (!actionsRef.current) return;
      if (!actionsRef.current.contains(event.target)) {
        setActionsOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setActionsOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [actionsOpen]);

  /* Search (local fuzzy filter on already-loaded data) */
  const searchLower = trimmedSearch.toLowerCase();
  const visible = searchLower
    ? tasks.filter((t) =>
        `${t.title || ""} ${t.description || ""} ${t.id || ""} ${getTaskBaseBranch(t)} ${getTaskTags(t).join(" ")}`
          .toLowerCase()
          .includes(searchLower),
      )
    : tasks;

  const summaryMetrics = useMemo(() => {
    const counts = {
      backlog: 0,
      active: 0,
      review: 0,
      done: 0,
      error: 0,
      draft: 0,
    };
    for (const task of tasks) {
      const status = String(task?.status || "").toLowerCase();
      if (["inprogress", "in-progress", "working", "active", "assigned", "running"].includes(status)) {
        counts.active += 1;
      } else if (["inreview", "in-review", "review", "pr-open", "pr-review"].includes(status)) {
        counts.review += 1;
      } else if (["done", "completed", "closed", "merged", "cancelled"].includes(status)) {
        counts.done += 1;
      } else if (["error", "blocked", "failed"].includes(status)) {
        counts.error += 1;
      } else if (["draft"].includes(status)) {
        counts.draft += 1;
      } else {
        counts.backlog += 1;
      }
    }
    return [
      { label: "Backlog", value: counts.backlog, color: "var(--color-todo)" },
      { label: "Active", value: counts.active, color: "var(--color-inprogress)" },
      { label: "Review", value: counts.review, color: "var(--color-inreview)" },
      { label: "Done", value: counts.done, color: "var(--color-done)" },
      { label: "Errors", value: counts.error, color: "var(--color-error)" },
    ];
  }, [tasks]);

  /* ── Client-side table sort (list mode) ── */
  const sortedForTable = useMemo(() => {
    if (!listSortCol) return visible;
    return [...visible].sort((a, b) => {
      let av, bv;
      const dir = listSortDir === "asc" ? 1 : -1;
      if (listSortCol === "priority") {
        av = PRIORITY_ORDER[a.priority || ""] ?? 4;
        bv = PRIORITY_ORDER[b.priority || ""] ?? 4;
        return dir * (av - bv);
      }
      if (listSortCol === "updated") {
        const tsA = a.updated_at || a.updated;
        const tsB = b.updated_at || b.updated;
        av = tsA ? (typeof tsA === 'number' ? tsA : new Date(tsA).getTime()) : 0;
        bv = tsB ? (typeof tsB === 'number' ? tsB : new Date(tsB).getTime()) : 0;
        return dir * (av - bv);
      }
      if (listSortCol === "status") { av = a.status || ""; bv = b.status || ""; }
      else if (listSortCol === "title") { av = (a.title || "").toLowerCase(); bv = (b.title || "").toLowerCase(); }
      else if (listSortCol === "repo") { av = a.repository || a.workspace || ""; bv = b.repository || b.workspace || ""; }
      else if (listSortCol === "branch") { av = getTaskBaseBranch(a); bv = getTaskBaseBranch(b); }
      else { return 0; }
      return dir * String(av).localeCompare(String(bv));
    });
  }, [visible, listSortCol, listSortDir]);

  /* ── Handlers ── */
  const handleFilter = async (s) => {
    haptic();
    if (tasksFilter) tasksFilter.value = s;
    if (tasksPage) tasksPage.value = 0;
    await refreshTab("tasks");
  };

  const toggleCompletedFilter = async () => {
    const next = completedOnly
      ? lastNonCompletedRef.current || "all"
      : "done";
    await handleFilter(next);
  };

  const handleCompletedToggle = async (next) => {
    if (next === completedOnly) return;
    await toggleCompletedFilter();
  };

  const handlePriorityFilter = async (p) => {
    haptic();
    if (tasksPriority) tasksPriority.value = p;
    if (tasksPage) tasksPage.value = 0;
    await refreshTab("tasks");
  };

  const handleSort = async (e) => {
    haptic();
    if (tasksSort) tasksSort.value = e.target.value;
    if (tasksPage) tasksPage.value = 0;
    await refreshTab("tasks");
  };

  /* Server-side search: debounce 300ms then reload from server */
  const triggerServerSearch = useCallback(
    debounce(async () => {
      if (tasksPage) tasksPage.value = 0;
      setIsSearching(true);
      try { await loadTasks(); } finally { setIsSearching(false); }
    }, 300),
    [],
  );

  const handleSearch = useCallback(
    (val) => {
      if (tasksSearch) tasksSearch.value = val;
      triggerServerSearch();
    },
    [triggerServerSearch],
  );

  const handleClearSearch = useCallback(() => {
    if (tasksSearch) tasksSearch.value = "";
    triggerServerSearch.cancel();
    if (tasksPage) tasksPage.value = 0;
    setIsSearching(false);
    loadTasks();
  }, [triggerServerSearch]);

  const handleClearFilters = useCallback(async () => {
    haptic();
    if (tasksFilter) tasksFilter.value = "all";
    if (tasksPriority) tasksPriority.value = "";
    if (tasksSort) tasksSort.value = "updated";
    if (tasksSearch) tasksSearch.value = "";
    if (tasksPage) tasksPage.value = 0;
    triggerServerSearch.cancel();
    setIsSearching(false);
    await refreshTab("tasks");
  }, [triggerServerSearch]);

  const handleRefreshDag = useCallback(async () => {
    haptic("medium");
    setDagLoading(true);
    setDagError("");
    try {
      await loadDagViews();
      showToast("DAG data refreshed", "success");
    } catch (error) {
      setDagError(error?.message || "Failed to refresh DAG views.");
    } finally {
      setDagLoading(false);
    }
  }, [loadDagViews]);

  const handleCreateSprint = useCallback(async () => {
    const rawName = globalThis.prompt?.("Sprint name", "Sprint " + new Date().toISOString().slice(0, 10));
    const name = toText(rawName);
    if (!name) return;
    const rawId = globalThis.prompt?.("Sprint ID (optional)", name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    const id = toText(rawId);
    haptic("medium");
    try {
      await apiFetch("/api/tasks/sprints", {
        method: "POST",
        body: JSON.stringify({
          ...(id ? { id } : {}),
          name,
          status: "active",
        }),
      });
      showToast("Sprint created", "success");
      await loadDagViews();
      if (id) setDagSelectedSprint(id);
    } catch {
      /* toast via apiFetch */
    }
  }, [loadDagViews]);
  const handleDagSprintModeChange = useCallback(async (mode) => {
    const nextMode = toText(mode, "parallel").toLowerCase();
    if (!dagSelectedSprint || dagSelectedSprint === "all") {
      showToast("Select a sprint before changing execution mode", "warning");
      return;
    }
    if (nextMode !== "parallel" && nextMode !== "sequential") return;
    setDagSprintOrderMode(nextMode);
    haptic("medium");
    try {
      await apiFetch(`/api/tasks/sprints/${encodeURIComponent(dagSelectedSprint)}`, {
        method: "PATCH",
        body: JSON.stringify({ executionMode: nextMode, taskOrderMode: nextMode, sprintOrderMode: nextMode }),
      });
      showToast("Sprint execution mode updated", "success");
      await loadDagViews();
    } catch {
      setDagError("Failed to update sprint execution mode.");
    }
  }, [dagSelectedSprint, loadDagViews]);
  const handleCreateDagEdge = useCallback(async ({ sourceNode, targetNode, graphKind }) => {
    const srcTaskId = toText(sourceNode?.taskId || sourceNode?.id);
    const dstTaskId = toText(targetNode?.taskId || targetNode?.id);

    if (graphKind === "epic") {
      const srcEpic = toText(sourceNode?.epicId || sourceNode?.id);
      const dstEpic = toText(targetNode?.epicId || targetNode?.id);
      if (!srcEpic || !dstEpic || srcEpic === dstEpic) return;
      const existing = normalizeDependencyInput(targetNode?.dependencies || []);
      const dependencies = normalizeDependencyInput([...existing, srcEpic]);
      await apiFetch("/api/tasks/epic-dependencies", {
        method: "PUT",
        body: JSON.stringify({ epicId: dstEpic, dependencies }),
      });
      showToast(`Wired epic dependency: ${srcEpic} -> ${dstEpic}`, "success");
      await loadDagViews();
      return;
    }

    if (!srcTaskId || !dstTaskId || srcTaskId === dstTaskId) return;
    const existing = normalizeDependencyInput(
      targetNode?.dependencies ||
      targetNode?.dependencyTaskIds ||
      [],
    );
    const dependencies = normalizeDependencyInput([...existing, srcTaskId]);
    await apiFetch("/api/tasks/dependencies", {
      method: "PUT",
      body: JSON.stringify({
        taskId: dstTaskId,
        dependencies,
      }),
    });
    showToast(`Wired dependency: ${srcTaskId} -> ${dstTaskId}`, "success");
    await loadDagViews();
  }, [loadDagViews]);

  const handleSprintChange = useCallback((nextSprint) => {
    const sprintId = toText(nextSprint, "all");
    if (sprintId === dagSelectedSprint) return;
    haptic();
    setDagSelectedSprint(sprintId);
  }, [dagSelectedSprint]);

  const handleToggleFilters = () => {
    haptic();
    setFiltersOpen((prev) => {
      const next = !prev;
      if (!next) setActionsOpen(false);
      return next;
    });
  };

  /* Keyboard shortcuts (mount/unmount) */
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        searchRef.current?.focus?.();
      }
      if (e.key === "Escape" && searchRef.current &&
          document.activeElement === searchRef.current) {
        handleClearSearch();
        searchRef.current.blur();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [handleClearSearch]);

  const handlePrev = async () => {
    if (tasksPage) tasksPage.value = Math.max(0, page - 1);
    await refreshTab("tasks");
  };

  const handleNext = async () => {
    if (tasksPage) tasksPage.value = page + 1;
    await refreshTab("tasks");
  };

  const handleStatusUpdate = async (taskId, newStatus) => {
    haptic("medium");
    const currentTask = (tasksData.value || []).find((row) => String(row?.id) === String(taskId));
    if (!currentTask) return;

    try {
      const result = await applyTaskLifecycleTransition(currentTask, newStatus);
      if (!result?.ok || result?.cancelled) return;
      if (result.status === "inreview") {
        const nextTask = (tasksData.value || []).find((row) => String(row?.id) === String(taskId));
        await reactivateTaskSession(taskId, {
          askFirst: true,
          title: nextTask?.title || taskId,
        }).catch(() => {});
      }
    } catch {
      /* toast */
    }
  };
  const startTask = async ({ taskId, sdk, model }) => {
    haptic("medium");
    let res = null;
    try {
      res = await apiFetch("/api/tasks/start", {
        method: "POST",
        body: JSON.stringify({
          taskId,
          ...(sdk ? { sdk } : {}),
          ...(model ? { model } : {}),
        }),
      });
    } catch {
      return;
    }

    if (res?.queued) {
      showToast("Task queued (waiting for free slot)", "info");
    } else if (res?.wasPaused) {
      showToast("Task started (executor paused — force-dispatched)", "warning");
    } else if (res) {
      showToast("Task started", "success");
    }
    scheduleRefresh(150);
  };

  const openStartModal = (task) => {
    haptic("medium");
    setStartTarget(task);
  };

  const openDetail = async (taskId) => {
    haptic();
    const local = tasks.find((t) => t.id === taskId);
    const result = await apiFetch(
      `/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      { _silent: true },
    ).catch(() => ({ data: local }));
    setDetailTask(result.data || local);
  };

  /* ── Batch operations ── */
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleBatchDone = async () => {
    if (!selectedIds.size) return;
    const ok = await showConfirm(`Mark ${selectedIds.size} tasks as done?`);
    if (!ok) return;
    haptic("medium");
    for (const id of selectedIds) {
      await handleStatusUpdate(id, "done");
    }
    setSelectedIds(new Set());
    setBatchMode(false);
    scheduleRefresh(150);
  };

  const handleBatchCancel = async () => {
    if (!selectedIds.size) return;
    const ok = await showConfirm(`Cancel ${selectedIds.size} tasks?`);
    if (!ok) return;
    haptic("medium");
    for (const id of selectedIds) {
      await handleStatusUpdate(id, "cancelled");
    }
    setSelectedIds(new Set());
    setBatchMode(false);
    scheduleRefresh(150);
  };

  /* ── Export handlers ── */
  const handleExportCSV = async () => {
    setExporting(true);
    setActionsOpen(false);
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks?limit=1000", { _silent: true });
      const allTasks = res?.data || res?.tasks || tasks;
      const headers = [
        "ID",
        "Title",
        "Status",
        "Priority",
        "Base Branch",
        "Tags",
        "Draft",
        "Created",
        "Updated",
        "Description",
      ];
      const rows = allTasks.map((t) => [
        t.id || "",
        t.title || "",
        t.status || "",
        t.priority || "",
        getTaskBaseBranch(t),
        getTaskTags(t).join(", "),
        t.draft || t.status === "draft" ? "true" : "false",
        t.created_at || "",
        t.updated_at || "",
        truncate(t.description || "", 200),
      ]);
      const date = new Date().toISOString().slice(0, 10);
      exportAsCSV(headers, rows, `tasks-${date}.csv`);
      showToast(`Exported ${allTasks.length} tasks`, "success");
    } catch {
      showToast("Export failed", "error");
    }
    setExporting(false);
  };

  const handleExportJSON = async () => {
    setExporting(true);
    setActionsOpen(false);
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks?limit=1000", { _silent: true });
      const allTasks = res?.data || res?.tasks || tasks;
      const date = new Date().toISOString().slice(0, 10);
      exportAsJSON(allTasks, `tasks-${date}.json`);
      showToast(`Exported ${allTasks.length} tasks`, "success");
    } catch {
      showToast("Export failed", "error");
    }
    setExporting(false);
  };

  /* ── Render ── */
  const showBatchBar = isList && batchMode && selectedIds.size > 0;

  if (!isDag && !tasksLoaded.value && !tasks.length && !searchVal)
    return html`<${Card} title="Loading Tasks…"><${SkeletonCard} /><//>`;

  if (!isDag && tasksLoaded.value && !tasks.length && !searchVal)
    return html`
      <div class="flex-between mb-sm" style="padding:0 4px">
        <${ToggleButtonGroup} size="small" exclusive value=${isDag ? 'dag' : (isKanban ? 'kanban' : 'list')}>
          <${ToggleButton} value="list" onClick=${() => { viewMode.value = 'list'; haptic(); }}>${iconText(":menu: List")}<//>
          <${ToggleButton} value="kanban" onClick=${() => { viewMode.value = 'kanban'; haptic(); }}>▦ Board<//>
          <${ToggleButton} value="dag" onClick=${() => { viewMode.value = 'dag'; haptic(); }}>⛓ DAG<//>
        <//>
        <div style="display:flex;gap:8px;align-items:center;">
          <${Button}
            variant="text" size="small"
            onClick=${() => {
              haptic();
              setShowTemplates(true);
            }}
          >${iconText(":zap: Templates")}<//>
          <${Button}
            variant="text" size="small"
            onClick=${toggleCompletedFilter}
          >
            ${completedOnly ? "Show All" : "Show Completed"}
          <//>
        </div>
      </div>
      ${hasActiveSlots &&
      html`
        <${Card} title="Active Slots">
          ${activeSlots.map(
            (slot) => html`
              <div key=${slot.taskId} class="list-item">
                <div class="list-item-content">
                  <div class="list-item-title">
                    ${truncate(slot.taskTitle || "(untitled)", 50)}
                  </div>
                  <div class="meta-text">
                    ${slot.taskId} · ${slot.branch || "no branch"}
                  </div>
                </div>
                <${Badge} status="inprogress" text="running" />
              </div>
            `,
          )}
        <//>
      `}
      ${!hasActiveSlots &&
      html`
        <${EmptyState}
          message="No tasks yet"
          description="Create a task to start orchestrating agents."
          icon="clipboard"
          action=${{
            label: "Create Task",
            onClick: () => {
              haptic();
              setShowCreate(true);
            },
          }}
        />
      `}
      <${Fab} color="primary" size="small" onClick=${() => { haptic(); setShowCreate(true); }}>${ICONS.plus}<//>
      ${showCreate && html`<${CreateTaskModalInline} onClose=${() => setShowCreate(false)} />`}
    `;

  const filterButton = html`
    <${Button}
      variant="outlined" size="small"
      onClick=${handleToggleFilters}
      aria-expanded=${filtersOpen}
    >
      ${ICONS.filter}
      Filters
      ${activeFilterCount > 0 && html`
        <span class="filter-count">${activeFilterCount}</span>
      `}
    <//>
  `;

  const viewToggle = html`
    <${ToggleButtonGroup} size="small" exclusive value=${isDag ? 'dag' : (isKanban ? 'kanban' : 'list')}>
      <${ToggleButton} value="list" onClick=${() => { viewMode.value = 'list'; haptic(); }}>${iconText(":menu: List")}<//>
      <${ToggleButton} value="kanban" onClick=${() => { viewMode.value = 'kanban'; haptic(); }}>▦ Board<//>
      <${ToggleButton} value="dag" onClick=${() => { viewMode.value = 'dag'; haptic(); }}>⛓ DAG<//>
    <//>
  `;

  const dagSprintPicker = isDag && html`
    <div class="tasks-toolbar-group" style=${{ minWidth: isCompact ? "130px" : "180px" }}>
      <${Select}
        size="small"
        value=${dagSelectedSprint}
        onChange=${(event) => handleSprintChange(event.target.value)}
        disabled=${dagLoading}
        style=${{ minWidth: "100%" }}
      >
        <${MenuItem} value="all">All sprints</${MenuItem}>
        ${dagSprints.map((sprint) => html`
          <${MenuItem} key=${sprint.id} value=${sprint.id}>${sprint.label}</${MenuItem}>
        `)}
      </${Select}>
    </div>
  `;

  const newButton = html`
    <${Button}
      variant="contained" size="small"
      onClick=${() => {
        haptic();
        setShowCreate(true);
      }}
      aria-label="Create task"
    >
      ${ICONS.plus}
      ${isCompact ? "New" : "New Task"}
    <//>
  `;

  const actionsMenu = html`
    <div class="actions-wrap" ref=${actionsRef}>
      <${Button}
        variant="text" size="small"
        onClick=${() => { setActionsOpen(!actionsOpen); haptic(); }}
        aria-haspopup="menu"
        aria-expanded=${actionsOpen}
        disabled=${exporting}
      >
        ${ICONS.ellipsis}
        <span class="actions-label">Actions</span>
      <//>
      ${actionsOpen && html`
        <div class="actions-dropdown" role="menu">
          <${MenuItem}
            onClick=${() => { setActionsOpen(false); setStartAnyOpen(true); }}
          >
            ${iconText(":play: Start Task")}
          <//>
          <${MenuItem}
            onClick=${() => { setActionsOpen(false); setShowTemplates(true); }}
          >
            ${iconText(":zap: Trigger Templates")}
          <//>
          <${MenuItem} onClick=${handleExportCSV}>${iconText(":chart: Export CSV")}<//>
          <${MenuItem} onClick=${handleExportJSON}>${iconText(":clipboard: Export JSON")}<//>
        </div>
      `}
    </div>
  `;

  return html`
    <div class="sticky-search">
      <div class="tasks-toolbar">
        <div class="tasks-toolbar-row">
          <div class="sticky-search-main">
          <${SearchInput}
            inputRef=${searchRef}
            placeholder="Search title, ID, or tag…"
            value=${searchVal}
            onInput=${(e) => handleSearch(e.target.value)}
            onClear=${handleClearSearch}
          />
          ${showKbdHint && !searchVal && html`<span class="pill" style="font-size:10px;padding:2px 7px;opacity:0.55;white-space:nowrap;pointer-events:none">${isMac ? "⌘K" : "Ctrl+K"}</span>`}
          ${isSearching && html`<span class="pill" style="font-size:10px;padding:2px 7px;color:var(--accent);white-space:nowrap">Searching…</span>`}
          ${!isSearching && searchVal && html`<span class="pill" style="font-size:10px;padding:2px 7px;white-space:nowrap">${visible.length} result${visible.length !== 1 ? "s" : ""}</span>`}
          </div>
          <div class=${`tasks-toolbar-actions ${isCompact ? "compact" : ""}`}>
            ${isCompact
              ? html`
                  <div class="tasks-toolbar-group">
                    ${filterButton}
                    ${viewToggle}
                    ${dagSprintPicker}
                  </div>
                  <div class="tasks-toolbar-group">
                    ${newButton}
                    ${actionsMenu}
                  </div>
                `
              : html`
                  ${filterButton}
                  ${viewToggle}
                    ${dagSprintPicker}
                  ${newButton}
                  <${Button}
                    variant="text" size="small"
                    onClick=${() => {
                      haptic();
                      setStartAnyOpen(true);
                    }}
                  >
                    ${iconText(":play: Start Task")}
                  <//>
                  ${actionsMenu}
                `}
          </div>
        </div>

        <div class="tasks-filter-panel ${filtersOpen ? "open" : ""}">
          <div class="tasks-filter-grid">
            ${isList && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">Status</div>
                <div class="chip-group">
                  ${STATUS_CHIPS.map(
                    (s) => html`
                      <${Chip}
                        key=${s.value}
                        label=${s.label}
                        variant=${filterVal === s.value ? "filled" : "outlined"}
                        color=${filterVal === s.value ? "primary" : "default"}
                        size="small"
                        onClick=${() => handleFilter(s.value)}
                      />
                    `,
                  )}
                </div>
              </div>
            `}
            ${isList && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">Priority</div>
                <div class="chip-group">
                  ${PRIORITY_CHIPS.map(
                    (p) => html`
                      <${Chip}
                        key=${p.value}
                        label=${p.label}
                        variant=${priorityVal === p.value ? "filled" : "outlined"}
                        color=${priorityVal === p.value ? "primary" : "default"}
                        size="small"
                        onClick=${() => handlePriorityFilter(p.value)}
                      />
                    `,
                  )}
                </div>
              </div>
            `}
            <div class="tasks-filter-section">
              <div class="tasks-filter-title">Sort</div>
              <div class="tasks-filter-row">
                <${Select}
                  size="small"
                  value=${sortVal}
                  onChange=${handleSort}
                >
                  ${SORT_OPTIONS.map(
                    (o) =>
                      html`<${MenuItem} key=${o.value} value=${o.value}>${o.label}</${MenuItem}>`,
                  )}
                </${Select}>
                <span class="pill">${visible.length} shown</span>
              </div>
            </div>
            <div class="tasks-filter-section">
              <div class="tasks-filter-title">Actions</div>
              <div class="tasks-filter-row">
                ${isList && (isCompact
                  ? html`
                      <${Toggle}
                        label="Completed only"
                        checked=${completedOnly}
                        onChange=${handleCompletedToggle}
                      />
                    `
                  : html`
                      <${Button}
                        variant="text" size="small"
                        onClick=${toggleCompletedFilter}
                      >
                        ${completedOnly ? "Show All" : "Show Completed"}
                      <//>
                    `)}
                ${hasActiveFilters &&
                html`
                  <${Button}
                    variant="text" size="small"
                    onClick=${handleClearFilters}
                  >
                    Clear Filters
                  <//>
                `}
              </div>
            </div>
            ${isList && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">List Options</div>
                <label
                  class="meta-text toggle-label"
                  onClick=${() => {
                    setBatchMode(!batchMode);
                    haptic();
                    setSelectedIds(new Set());
                  }}
                >
                  <${Switch} size="small" checked=${batchMode} />
                  Batch Select
                </label>
              </div>
            `}
            ${isKanban && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">Board View</div>
                <div class="meta-text">
                  Board view shows every status in one place. Switch to List to filter by status or priority.
                </div>
              </div>
            `}
            ${isDag && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">DAG View</div>
                <div class="meta-text">
                  Sprint DAG = selected sprint execution plan. Global DAG = cross-sprint dependencies.
                </div>
                <div class="tasks-filter-row" style=${{ marginTop: "8px" }}>
                  <${Select}
                    size="small"
                    value=${dagSprintOrderMode}
                    disabled=${dagLoading || dagSelectedSprint === "all"}
                    onChange=${(e) => handleDagSprintModeChange(e.target.value)}
                  >
                    <${MenuItem} value="parallel">Mode: parallel</${MenuItem}>
                    <${MenuItem} value="sequential">Mode: sequential</${MenuItem}>
                  </${Select}>
                </div>
                <div class="tasks-filter-row" style=${{ marginTop: "8px" }}>
                  <${Button}
                    variant="text" size="small"
                    onClick=${handleRefreshDag}
                    disabled=${dagLoading}
                  >
                    ${dagLoading ? "Refreshing…" : "Refresh DAG"}
                  <//>
                  <${Button}
                    variant="text" size="small"
                    onClick=${handleCreateSprint}
                    disabled=${dagLoading}
                  >
                    + New Sprint
                  <//>
                </div>
                <div class="task-dag-legend" style=${{ marginTop: "8px" }}>
                  <span class="task-dag-legend-item"><span class="task-dag-legend-line" style=${{ background: "var(--accent)" }}></span>depends-on</span>
                  <span class="task-dag-legend-item"><span class="task-dag-legend-line task-dag-legend-line-dashed"></span>sequential</span>
                  <span class="task-dag-legend-item"><span class="task-dag-legend-line task-dag-legend-line-block"></span>blocks</span>
                </div>
                ${(dagSources.sprintGraph || dagSources.globalGraph) && html`
                  <div class="meta-text" style=${{ marginTop: "6px" }}>
                    Source: ${dagSources.sprintGraph || dagSources.globalGraph}
                  </div>
                `}
              </div>
            `}
          </div>
        </div>
      </div>
      ${isList && hasActiveFilters && (!isCompact || filtersOpen) && html`
        <div class="filter-summary">
          <div class="filter-summary-text">
            <span class="pill">Filters</span>
            <span>${filterSummary}</span>
          </div>
          <div class="filter-summary-actions">
            <${Button} variant="text" size="small" onClick=${handleClearFilters}>
              Clear Filters
            <//>
          </div>
        </div>
      `}
      ${showBatchBar &&
      html`
        <div class="btn-row batch-action-bar">
          <span class="pill">${selectedIds.size} selected</span>
          <${Button} variant="contained" size="small" onClick=${handleBatchDone}>
            ${iconText("✓ Done All")}
          <//>
          <${Button} variant="contained" color="error" size="small" onClick=${handleBatchCancel}>
            ${iconText("✕ Cancel All")}
          <//>
          <${Button}
            variant="text" size="small"
            onClick=${() => {
              setSelectedIds(new Set());
              haptic();
            }}
          >
            Clear
          <//>
        </div>
      `}
    </div>

    ${!isDag && html`
      <div class="snapshot-bar">
        ${summaryMetrics.map((m) => html`
          <${Tooltip} title=${isKanban ? m.label : `Filter by ${m.label}`}><${Button}
            key=${m.label}
            variant="text" size="small"
            style=${{ textTransform: "none" }}
            onClick=${() => {
              if (!isList) return;
              const statusVal = SNAPSHOT_STATUS_MAP[m.label];
              if (statusVal !== undefined) handleFilter(filterVal === statusVal ? 'all' : statusVal);
            }}
          >
            <span class="snapshot-dot" style="background:${m.color};" />
            <strong class="snapshot-val">${m.value}</strong>
            <span class="snapshot-lbl">${m.label}</span>
          <//><//>
        `)}
        <span class="snapshot-view-tag">${iconText(isKanban ? ":dot: Board" : ":menu: List")}</span>
      </div>
    `}

    ${isDag && html`
      <div class="snapshot-bar">
        <span class="snapshot-view-tag">${iconText(":link: DAG")}</span>
        <span class="pill">Sprint nodes: ${dagSprintGraph.nodes.length}</span>
        <span class="pill">Global nodes: ${dagGlobalGraph.nodes.length}</span>
        <span class="pill">Epic nodes: ${dagEpicGraph.nodes.length}</span>
        <span class="pill">Global edges: ${dagGlobalGraph.edges.length}</span>
      </div>
    `}

    <style>
      .actions-btn { display:inline-flex; align-items:center; gap:4px; }
      .actions-dropdown {
        position:absolute; right:0; top:100%; margin-top:4px; z-index:100;
        background:var(--card-bg, #1e1e2e); border:1px solid var(--border, #333);
        border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,.3); overflow:hidden;
        min-width:160px;
      }
      .actions-dropdown-item {
        display:block; width:100%; padding:10px 14px; border:none;
        background:none; color:inherit; text-align:left; font-size:13px;
        cursor:pointer;
      }
      .actions-dropdown-item:hover { background:var(--hover-bg, rgba(255,255,255,.08)); }
      .snapshot-pill-btn {
        background: none;
        border: 1px solid transparent;
        border-radius: 999px;
        cursor: pointer;
        padding: 2px 8px;
        transition: border-color 0.15s, background 0.15s;
        font: inherit;
      }
      .snapshot-pill-btn:hover {
        border-color: var(--border);
        background: var(--bg-card-hover, rgba(255,255,255,0.05));
      }
      .snapshot-pill-active {
        border-color: var(--accent) !important;
        background: rgba(59,130,246,0.12) !important;
      }
      @media (max-width: 640px) {
        .actions-label { display:none; }
      }
    </style>

    ${isKanban && html`<${KanbanBoard} onOpenTask=${openDetail} hasMoreTasks=${hasMoreKanbanPages} loadingMoreTasks=${kanbanLoadingMore} onLoadMoreTasks=${loadMoreKanbanTasks} columnTotals=${boardColumnTotals} totalTasks=${boardTotalTasks} />`}

    ${isDag && html`
      <div class="task-dag-wrap" style=${{ display: "grid", gap: "10px", marginTop: "8px" }}>
        ${dagError ? html`<${Alert} severity="warning">${dagError}</${Alert}>` : null}
        ${dagLoading ? html`<${Alert} severity="info">Loading DAG data…</${Alert}>` : null}
        <${DagGraphSection}
          title=${dagSprintGraph.title || (dagSelectedSprint === "all" ? "All Sprint DAG" : `Sprint ${dagSelectedSprint} DAG`)}
          description=${dagSprintGraph.description || "Task dependency order within the selected sprint."}
          graph=${dagSprintGraph}
          graphKey="sprint"
          onOpenTask=${openDetail}
          onCreateEdge={({ sourceNode, targetNode }) => handleCreateDagEdge({ sourceNode, targetNode, graphKind: "task" })}
          allowWiring=${true}
          emptyMessage="No sprint DAG data available yet."
        ><//>
        <${DagGraphSection}
          title=${dagGlobalGraph.title || "Global DAG of DAGs"}
          description=${dagGlobalGraph.description || "Cross-sprint dependency overview."}
          graph=${dagGlobalGraph}
          graphKey="global"
          onOpenTask=${openDetail}
          onCreateEdge={({ sourceNode, targetNode }) => handleCreateDagEdge({ sourceNode, targetNode, graphKind: "task" })}
          allowWiring=${true}
          emptyMessage="No global DAG data available yet."
        ><//>
        <${DagGraphSection}
          title=${dagEpicGraph.title || "Epic Dependency DAG"}
          description=${dagEpicGraph.description || "Epics and their run prerequisites."}
          graph=${dagEpicGraph}
          graphKey="epic"
          onCreateEdge={({ sourceNode, targetNode }) => handleCreateDagEdge({ sourceNode, targetNode, graphKind: "epic" })}
          allowWiring=${true}
          emptyMessage="No epic DAG data available yet."
        ><//>
      </div>
    `}

    ${isList && visible.length > 0 && html`
      <div class="task-table-wrap">
        <table class="task-table">
          <thead>
            <tr>
              ${[
                { col: "status", label: "Status" },
                { col: "priority", label: "Pri" },
                { col: "title", label: "Title", grow: true },
                { col: "branch", label: "Branch" },
                { col: "repo", label: "Repo" },
                { col: "updated", label: "Updated" },
              ].map(({ col, label, grow }) => {
                const active = listSortCol === col;
                const arrow = active ? (listSortDir === "asc" ? "▲" : "▼") : "⇅";
                return html`
                  <th
                    key=${col}
                    class="task-th ${active ? "task-th-active" : ""} ${grow ? "task-th-grow" : ""}"
                    onClick=${() => {
                      if (listSortCol === col) {
                        setListSortDir(listSortDir === "asc" ? "desc" : "asc");
                      } else {
                        setListSortCol(col);
                        setListSortDir("desc");
                      }
                    }}
                  >${label} <span class="task-th-arrow">${arrow}</span></th>
                `;
              })}
            </tr>
          </thead>
          <tbody>
            ${sortedForTable.map((task) => {
              const isManual = isTaskManual(task);
              const branch = getTaskBaseBranch(task);
              return html`
                <tr
                  key=${task.id}
                  class="task-tr ${batchMode && selectedIds.has(task.id) ? "task-tr-selected" : ""}"
                  data-status=${task.status || ""}
                  onClick=${() => batchMode ? toggleSelect(task.id) : openDetail(task.id)}
                >
                  <td class="task-td task-td-status">
                    <${Badge} status=${task.status} text=${task.status} />
                    ${isManual && html`<${Badge} status="warning" text="manual" />`}
                  </td>
                  <td class="task-td task-td-pri">
                    ${task.priority
                      ? html`<${Badge} status=${task.priority} text=${task.priority} />`
                      : html`<span class="task-td-empty">—</span>`}
                  </td>
                  <td class="task-td task-td-title">
                    <div class="task-td-title-text">${task.title || "(untitled)"}</div>
                    ${task.id && html`<div class="task-td-id">${task.id}</div>`}
                  </td>
                  <td class="task-td task-td-branch">
                    ${branch
                      ? html`<code class="task-td-code">${branch}</code>`
                      : html`<span class="task-td-empty">—</span>`}
                  </td>
                  <td class="task-td task-td-repo">
                    ${(task.repository || task.workspace)
                      ? html`<span>${task.repository || task.workspace}</span>`
                      : html`<span class="task-td-empty">—</span>`}
                  </td>
                  <td class="task-td task-td-updated">
                    ${(task.updated_at || task.updated)
                      ? html`<span class="task-td-date">${formatRelative(task.updated_at || task.updated)}</span>`
                      : html`<span class="task-td-empty">—</span>`}
                  </td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    `}
    ${isList && !visible.length &&
    html`
      <${EmptyState}
        message="No tasks match those filters"
        description="Try clearing filters or searching by ID, title, or tag."
        action=${hasActiveFilters
          ? { label: "Clear Filters", onClick: handleClearFilters }
          : null}
      />
    `}

    ${isList && html`
      <div class="pager">
        <${Button}
          variant="outlined" size="small"
          onClick=${handlePrev}
          disabled=${page <= 0}
        >
          ← Prev
        <//>
        <span class="pager-info">Page ${page + 1} / ${totalPages}</span>
        <${Button}
          variant="outlined" size="small"
          onClick=${handleNext}
          disabled=${page + 1 >= totalPages}
        >
          Next →
        <//>
      </div>
    `}

    <${Fab}
      color="primary" size="small"
      onClick=${() => {
        haptic();
        setShowCreate(true);
      }}
    >
      ${ICONS.plus}
    <//>

    ${showCreate &&
    html`
      <${CreateTaskModalInline} onClose=${() => setShowCreate(false)} />
    `}
    ${detailTask && isActiveStatus(detailTask.status) &&
    html`
      <${TaskProgressModal}
        task=${detailTask}
        onClose=${() => setDetailTask(null)}
      />
    `}
    ${detailTask && isReviewStatus(detailTask.status) &&
    html`
      <${TaskReviewModal}
        task=${detailTask}
        onClose=${() => setDetailTask(null)}
        onStart=${(task) => openStartModal(task)}
      />
    `}
    ${detailTask && !isActiveStatus(detailTask.status) && !isReviewStatus(detailTask.status) &&
    html`
      <${TaskDetailModal}
        task=${detailTask}
        onClose=${() => setDetailTask(null)}
        onStart=${(task) => openStartModal(task)}
      />
    `}
    ${startTarget &&
    html`
      <${StartTaskModal}
        task=${startTarget}
        defaultSdk=${defaultSdk}
        allowTaskIdInput=${false}
        onClose=${() => setStartTarget(null)}
        onStart=${startTask}
      />
    `}
    ${startAnyOpen &&
    html`
      <${StartTaskModal}
        task=${null}
        defaultSdk=${defaultSdk}
        allowTaskIdInput=${true}
        onClose=${() => setStartAnyOpen(false)}
        onStart=${startTask}
      />
    `}
    ${showTemplates &&
    html`
      <${TriggerTemplatesModal}
        onClose=${() => setShowTemplates(false)}
      />
    `}
  `;
}

/* ── Inline CreateTask (duplicated here to keep tasks.js self-contained) ── */
function CreateTaskModalInline({ onClose }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [priority, setPriority] = useState("medium");
  const [tagsInput, setTagsInput] = useState("");
  const [draft, setDraft] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(activeWorkspaceId.value || "");
  const [repository, setRepository] = useState("");
  const [repositories, setRepositories] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const initialSnapshotRef = useRef({
    title: "",
    description: "",
    baseBranch: "",
    priority: "medium",
    tagsInput: "",
    draft: false,
  });
  const pendingKey = "modal:create-task-inline";

  const handleRewrite = async () => {
    if (!title.trim() || rewriting) return;
    setRewriting(true);
    haptic("medium");
    try {
      const res = await apiFetch("/api/tasks/rewrite", {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), description: description.trim() }),
      });
      if (res?.data) {
        if (res.data.title) setTitle(res.data.title);
        if (res.data.description) setDescription(res.data.description);
        showToast("Task description improved", "success");
        haptic("medium");
      }
    } catch {
      /* toast via apiFetch */
    }
    setRewriting(false);
  };
  const activeWsId = activeWorkspaceId.value || "";

  const workspaceOptions = managedWorkspaces.value || [];
  const selectedWorkspace = useMemo(
    () => workspaceOptions.find((ws) => ws.id === workspaceId) || null,
    [workspaceId, workspaceOptions],
  );
  const repositoryOptions = selectedWorkspace?.repos || [];

  useEffect(() => {
    if (!workspaceOptions.length) {
      loadWorkspaces().catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (workspaceId || !activeWsId) return;
    setWorkspaceId(activeWsId);
  }, [activeWsId, workspaceId]);

  useEffect(() => {
    if (!repositoryOptions.length) {
      if (repository) setRepository("");
      if (repositories.length) setRepositories([]);
      return;
    }
    if (!repositoryOptions.some((repo) => repo?.slug === repository)) {
      const primary = repositoryOptions.find((repo) => repo?.primary);
      const defaultSlug = primary?.slug || repositoryOptions[0]?.slug || "";
      setRepository(defaultSlug);
      setRepositories(defaultSlug ? [defaultSlug] : []);
    }
  }, [workspaceId, repositoryOptions.length]);

  const unsavedSnapshot = useMemo(
    () => ({
      title: title || "",
      description: description || "",
      baseBranch: baseBranch || "",
      priority: priority || "medium",
      tagsInput: tagsInput || "",
      draft: Boolean(draft),
    }),
    [baseBranch, description, draft, priority, tagsInput, title],
  );
  const changeCount = useMemo(
    () => countChangedFields(initialSnapshotRef.current, unsavedSnapshot),
    [unsavedSnapshot],
  );
  const hasUnsaved = changeCount > 0;

  useEffect(() => {
    setPendingChange(pendingKey, hasUnsaved);
    return () => clearPendingChange(pendingKey);
  }, [hasUnsaved]);

  const resetToInitial = useCallback(() => {
    const base = initialSnapshotRef.current || {};
    setTitle(base.title || "");
    setDescription(base.description || "");
    setBaseBranch(base.baseBranch || "");
    setPriority(base.priority || "medium");
    setTagsInput(base.tagsInput || "");
    setDraft(Boolean(base.draft));
    showToast("Changes discarded", "info");
  }, []);

  const toggleRepo = (slug) => {
    setRepositories((prev) =>
      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
    );
    // Keep single-repo compat: repository = first selected
    setRepository((prev) => {
      if (repositories.includes(slug)) {
        const next = repositories.filter((s) => s !== slug);
        return next[0] || "";
      }
      return prev || slug;
    });
  };

  const handleSubmit = async ({ closeAfterSave = true } = {}) => {
    if (rewriting) {
      showToast("Wait for AI improvement to finish before saving.", "warning");
      return false;
    }
    if (!title.trim()) {
      showToast("Title is required", "error");
      return false;
    }
    setSubmitting(true);
    haptic("medium");
    const cleanTitle = sanitizeTaskText(title).trim();
    const cleanDescription = buildTaskDescriptionFallback(title, description);
    const cleanTagsInput = sanitizeTaskText(tagsInput || "");
    const tags = normalizeTagInput(cleanTagsInput);
    const effectiveRepos = repositories.length > 0 ? repositories : (repository ? [repository] : []);
    try {
      await apiFetch("/api/tasks/create", {
        method: "POST",
        body: JSON.stringify({
          title: cleanTitle,
          description: cleanDescription,
          baseBranch: baseBranch.trim() || undefined,
          priority,
          tags,
          draft,
          status: draft ? "draft" : "todo",
          workspace: workspaceId || undefined,
          repository: effectiveRepos[0] || undefined,
          repositories: effectiveRepos.length > 1 ? effectiveRepos : undefined,
        }),
      });
      showToast("Task created", "success");
      setTitle(cleanTitle);
      setDescription(cleanDescription);
      setTagsInput(cleanTagsInput);
      initialSnapshotRef.current = {
        title: cleanTitle,
        description: cleanDescription,
        baseBranch: baseBranch.trim(),
        priority,
        tagsInput: cleanTagsInput,
        draft: Boolean(draft),
      };
      if (closeAfterSave) {
        onClose?.();
      }
      await loadTasks();
      return closeAfterSave ? { closed: true } : true;
    } catch {
      /* toast */
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    const tg = globalThis.Telegram?.WebApp;
    if (tg?.MainButton) {
      tg.MainButton.setText("Create Task");
      tg.MainButton.show();
      tg.MainButton.onClick(handleSubmit);
      return () => {
        tg.MainButton.hide();
        tg.MainButton.offClick(handleSubmit);
      };
    }
  }, [
    title,
    description,
    baseBranch,
    priority,
    tagsInput,
    draft,
    rewriting,
    workspaceId,
    repository,
    repositories,
  ]);

  const parsedTags = normalizeTagInput(tagsInput);
  const hasAdvanced = baseBranch || draft || showAdvanced;

  const footerContent = html`
    <${Button}
      variant="contained" size="small"
      style=${{ width: "100%" }}
      onClick=${() => {
        void handleSubmit({ closeAfterSave: true });
      }}
      disabled=${submitting || rewriting}
    >
      ${submitting ? "Creating…" : iconText("✓ Create Task")}
    <//>
  `;

  return html`
    <${Modal}
      title="New Task"
      onClose=${onClose}
      contentClassName="modal-content-wide task-detail-modal-jira"
      footer=${footerContent}
      unsavedChanges=${changeCount}
      onSaveBeforeClose=${() => handleSubmit({ closeAfterSave: true })}
      onDiscardBeforeClose=${() => {
        resetToInitial();
        return true;
      }}
      activeOperationLabel=${rewriting ? "Improve with AI is still running" : ""}
    >
      <div class="flex-col create-task-form">

        <!-- Title — autofocus so keyboard opens immediately -->
        <div class="input-with-mic">
          <${TextField}
            size="small"
            variant="outlined"
            placeholder="Task title *"
            value=${title}
            autoFocus=${true}
            onInput=${(e) => setTitle(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit({ closeAfterSave: true });
              }
            }}
            fullWidth
          />
          <${VoiceMicButtonInline}
            onTranscript=${(t) => setTitle((prev) => (prev ? prev + " " + t : t))}
            disabled=${submitting || rewriting}
          />
        </div>

        <!-- Description — compact 2-row textarea -->
        <div class="textarea-with-mic" style="position:relative">
          <${TextField}
            multiline
            rows=${2}
            size="small"
            placeholder="What needs to be done? (optional)"
            value=${description}
            onInput=${(e) => {
              setDescription(e.target.value);
              // auto-grow up to 6 rows
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 6 * 24 + 16) + "px";
            }}
            style=${{ paddingRight: "36px" }}
            fullWidth
          />
          <${VoiceMicButton}
            onTranscript=${(t) => setDescription((prev) => (prev ? prev + " " + t : t))}
            disabled=${submitting || rewriting}
            size="sm"
            className="textarea-mic-btn"
          />
        </div>

        <!-- Rewrite / Improve button -->
        <${Tooltip} title="Use AI to expand and improve this task description"><${Button}
          variant="text" size="small"
          style=${{ display: "flex", alignItems: "center", gap: "6px", alignSelf: "flex-start", fontSize: "12px", padding: "5px 10px", opacity: !title.trim() ? 0.45 : 1 }}
          disabled=${!title.trim() || rewriting || submitting}
          onClick=${handleRewrite}
        >
          ${rewriting
            ? html`<span class="spin-icon" style="display:inline-block;animation:spin 0.8s linear infinite">${resolveIcon(":clock:")}</span> Improving…`
            : html`${iconText(":star: Improve with AI")}`
          }
        <//><//>

        <!-- Priority — always visible, most commonly changed -->
        <${SegmentedControl}
          options=${[
            { value: "low", label: "Low" },
            { value: "medium", label: "Med" },
            { value: "high", label: "High" },
            { value: "critical", label: "Critical" },
          ]}
          value=${priority}
          onChange=${(v) => { haptic(); setPriority(v); }}
        />

        <!-- Workspace + Repo row -->
        ${workspaceOptions.length > 0 && html`
          <div class="input-row">
            <${Select}
              size="small"
              value=${workspaceId}
              onChange=${(e) => setWorkspaceId(e.target.value)}
            >
              <${MenuItem} value="">Active workspace</${MenuItem}>
              ${workspaceOptions.map(
                (ws) => html`<${MenuItem} value=${ws.id}>${ws.name || ws.id}</${MenuItem}>`,
              )}
            </${Select}>
          </div>
          ${repositoryOptions.length > 0 && html`
            <div class="repo-select-group">
              ${repositoryOptions.length === 1
                ? html`<div class="repo-auto-label">
                    Repo: <strong>${repositoryOptions[0].name}</strong>
                    ${repositoryOptions[0].primary ? " (Primary)" : ""}
                  </div>`
                : html`<div class="repo-checkboxes">
                    <span class="repo-checkboxes-label">Repositories</span>
                    ${repositoryOptions.map((repo) => html`
                      <label class="repo-checkbox-item">
                        <${Switch} size="small" checked=${repositories.includes(repo.slug)} onChange=${() => toggleRepo(repo.slug)} />
                        ${repo.name}${repo.primary ? " (Primary)" : ""}
                      </label>
                    `)}
                  </div>`
              }
            </div>
          `}
        `}

        <!-- Tags -->
        <${TextField} size="small" variant="outlined" placeholder="Tags (comma-separated, optional)" value=${tagsInput} onInput=${(e) => setTagsInput(e.target.value)} fullWidth />
        ${parsedTags.length > 0 && html`
          <div class="tag-row">
            ${parsedTags.map((tag) => html`<span class="tag-chip">#${tag}</span>`)}
          </div>
        `}

        <!-- Advanced toggle -->
        <${Button}
          variant="text" size="small"
          style=${{ textAlign: "left", justifyContent: "flex-start", gap: "6px", padding: "6px 0", color: "var(--text-hint)" }}
          onClick=${() => setShowAdvanced(!showAdvanced)}
        >
          <span style="display:inline-block;transition:transform 0.15s;transform:rotate(${showAdvanced ? 90 : 0}deg)">${resolveIcon(":play:")}</span>
          Advanced${hasAdvanced && !showAdvanced ? " •" : ""}
        <//>

        <!-- Advanced fields: base branch + draft -->
        ${(showAdvanced || hasAdvanced) && html`
          <${TextField} size="small" variant="outlined" placeholder="Base branch (optional, e.g. main)" value=${baseBranch} onInput=${(e) => setBaseBranch(e.target.value)} fullWidth />
          <${Toggle}
            label="Draft (save to backlog, don't start)"
            checked=${draft}
            onChange=${(next) => setDraft(next)}
          />
        `}

        <${SaveDiscardBar}
          dirty=${hasUnsaved}
          message=${unsavedChangesMessage(changeCount)}
          saveLabel="Create Task"
          discardLabel="Discard"
          onSave=${() => {
            void handleSubmit({ closeAfterSave: false });
          }}
          onDiscard=${resetToInitial}
          saving=${submitting}
          disabled=${rewriting}
        />

      </div>
    <//>
  `;
}

































