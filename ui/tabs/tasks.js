/* ─────────────────────────────────────────────────────────────
 *  Tab: Tasks — board, search, filters, task CRUD
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "preact/hooks";
import htm from "htm";

const html = htm.bind(h);

import { haptic, showConfirm } from "../modules/telegram.js";
import { apiFetch, sendCommandToChat } from "../modules/api.js";
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
  executorData,
  showToast,
  refreshTab,
  runOptimistic,
  scheduleRefresh,
  loadTasks,
} from "../modules/state.js";
import { ICONS } from "../modules/icons.js";
import {
  cloneValue,
  formatRelative,
  truncate,
  debounce,
  exportAsCSV,
  exportAsJSON,
} from "../modules/utils.js";
import {
  Card,
  Badge,
  StatCard,
  SkeletonCard,
  Modal,
  EmptyState,
  ListItem,
} from "../components/shared.js";
import { SegmentedControl, SearchInput, Toggle } from "../components/forms.js";
import { KanbanBoard } from "../components/kanban-board.js";

/* ─── View mode toggle ─── */
const viewMode = signal("kanban");

/* ─── Export dropdown icon (inline SVG) ─── */
const DOWNLOAD_ICON = html`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>`;

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
  "openfleet",
  "codex-mointor",
]);

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

  useEffect(() => {
    setSdk(defaultSdk || "auto");
  }, [defaultSdk]);

  useEffect(() => {
    setTaskIdInput(task?.id || "");
  }, [task?.id]);

  const canModel = sdk && sdk !== "auto";
  const resolvedTaskId = (task?.id || taskIdInput || "").trim();

  const handleStart = async () => {
    if (starting) return;
    if (!resolvedTaskId) {
      showToast("Task ID is required", "error");
      return;
    }
    setStarting(true);
    try {
      await onStart?.({
        taskId: resolvedTaskId,
        sdk: sdk && sdk !== "auto" ? sdk : undefined,
        model: model.trim() ? model.trim() : undefined,
      });
      onClose();
    } catch {
      /* toast via apiFetch */
    }
    setStarting(false);
  };

  return html`
    <${Modal} title="Start Task" onClose=${onClose}>
      <div class="meta-text mb-sm">
        ${task?.title || "(untitled)"} · ${task?.id || "—"}
      </div>
      <div class="flex-col gap-md">
        ${(allowTaskIdInput || !task?.id) &&
        html`
          <div class="card-subtitle">Task ID</div>
          <input
            class="input"
            placeholder="e.g. task-123"
            value=${taskIdInput}
            onInput=${(e) => setTaskIdInput(e.target.value)}
          />
        `}
        <div class="card-subtitle">Executor SDK</div>
        <select class="input" value=${sdk} onChange=${(e) => setSdk(e.target.value)}>
          ${["auto", "codex", "copilot", "claude"].map(
            (opt) => html`<option value=${opt}>${opt}</option>`,
          )}
        </select>
        <div class="card-subtitle">Model Override (optional)</div>
        <input
          class="input"
          placeholder=${canModel ? "e.g. gpt-5.3-codex" : "Select SDK to enable"}
          value=${model}
          disabled=${!canModel}
          onInput=${(e) => setModel(e.target.value)}
        />
        <button
          class="btn btn-primary"
          onClick=${handleStart}
          disabled=${starting || !resolvedTaskId}
        >
          ${starting ? "Starting…" : "▶ Start Task"}
        </button>
      </div>
    <//>
  `;
}

/* ─── TaskDetailModal ─── */
export function TaskDetailModal({ task, onClose, onStart }) {
  const [title, setTitle] = useState(task?.title || "");
  const [description, setDescription] = useState(task?.description || "");
  const [baseBranch, setBaseBranch] = useState(getTaskBaseBranch(task));
  const [status, setStatus] = useState(task?.status || "todo");
  const [priority, setPriority] = useState(task?.priority || "");
  const [tagsInput, setTagsInput] = useState(
    getTaskTags(task).join(", "),
  );
  const [draft, setDraft] = useState(
    Boolean(task?.draft || task?.status === "draft"),
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(task?.title || "");
    setDescription(task?.description || "");
    setBaseBranch(getTaskBaseBranch(task));
    setStatus(task?.status || "todo");
    setPriority(task?.priority || "");
    setTagsInput(getTaskTags(task).join(", "));
    setDraft(Boolean(task?.draft || task?.status === "draft"));
  }, [task?.id]);

  const handleSave = async () => {
    setSaving(true);
    haptic("medium");
    const prev = cloneValue(tasksData.value);
    const tags = normalizeTagInput(tagsInput);
    const wantsDraft = draft || status === "draft";
    const nextStatus = wantsDraft ? "draft" : status;
    try {
      await runOptimistic(
        () => {
          tasksData.value = tasksData.value.map((t) =>
            t.id === task.id
              ? {
                  ...t,
                  title,
                  description,
                  baseBranch,
                  status: nextStatus,
                  priority: priority || null,
                  tags,
                  draft: wantsDraft,
                }
              : t,
          );
        },
        async () => {
          const res = await apiFetch("/api/tasks/edit", {
            method: "POST",
            body: JSON.stringify({
              taskId: task.id,
              title,
              description,
              baseBranch,
              status: nextStatus,
              priority,
              tags,
              draft: wantsDraft,
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
      onClose();
    } catch {
      /* toast via apiFetch */
    }
    setSaving(false);
  };

  const handleStatusUpdate = async (newStatus) => {
    haptic("medium");
    const prev = cloneValue(tasksData.value);
    const wantsDraft = newStatus === "draft";
    try {
      await runOptimistic(
        () => {
          tasksData.value = tasksData.value.map((t) =>
            t.id === task.id
              ? { ...t, status: newStatus, draft: wantsDraft }
              : t,
          );
        },
        async () => {
          const res = await apiFetch("/api/tasks/update", {
            method: "POST",
            body: JSON.stringify({
              taskId: task.id,
              status: newStatus,
              draft: wantsDraft,
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
      if (newStatus === "done" || newStatus === "cancelled") onClose();
      else {
        setStatus(newStatus);
        setDraft(wantsDraft);
      }
    } catch {
      /* toast */
    }
  };

  const handleStart = () => {
    if (onStart) onStart(task);
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

  const handleCancel = async () => {
    const ok = await showConfirm("Cancel this task?");
    if (!ok) return;
    await handleStatusUpdate("cancelled");
  };

  return html`
    <${Modal} title=${task?.title || "Task Detail"} onClose=${onClose}>
      <div class="meta-text mb-sm" style="user-select:all">ID: ${task?.id}</div>
      <div class="flex-row gap-sm mb-md">
        <${Badge} status=${task?.status} text=${task?.status} />
        ${task?.priority &&
        html`<${Badge} status=${task.priority} text=${task.priority} />`}
      </div>

      <div class="flex-col gap-md">
        <input
          class="input"
          placeholder="Title"
          value=${title}
          onInput=${(e) => setTitle(e.target.value)}
        />
        <textarea
          class="input"
          rows="5"
          placeholder="Description"
          value=${description}
          onInput=${(e) => setDescription(e.target.value)}
        ></textarea>
        <input
          class="input"
          placeholder="Base branch (optional, e.g. feature/xyz)"
          value=${baseBranch}
          onInput=${(e) => setBaseBranch(e.target.value)}
        />
        <input
          class="input"
          placeholder="Tags (comma-separated)"
          value=${tagsInput}
          onInput=${(e) => setTagsInput(e.target.value)}
        />
        ${normalizeTagInput(tagsInput).length > 0 &&
        html`
          <div class="tag-row">
            ${normalizeTagInput(tagsInput).map(
              (tag) => html`<span class="tag-chip">#${tag}</span>`,
            )}
          </div>
        `}

        <div class="input-row">
          <select
            class="input"
            value=${status}
            onChange=${(e) => {
              const next = e.target.value;
              setStatus(next);
              if (next === "draft") setDraft(true);
              else if (draft) setDraft(false);
            }}
          >
            ${["draft", "todo", "inprogress", "inreview", "done", "cancelled"].map(
              (s) => html`<option value=${s}>${s}</option>`,
            )}
          </select>
          <select
            class="input"
            value=${priority}
            onChange=${(e) => setPriority(e.target.value)}
          >
            <option value="">No priority</option>
            ${["low", "medium", "high", "critical"].map(
              (p) => html`<option value=${p}>${p}</option>`,
            )}
          </select>
        </div>
        <${Toggle}
          label="Draft (keep in backlog)"
          checked=${draft}
          onChange=${(next) => {
            setDraft(next);
            if (next) setStatus("draft");
            else if (status === "draft") setStatus("todo");
          }}
        />

        <!-- Metadata -->
        ${task?.created_at &&
        html`
          <div class="meta-text">
            Created: ${new Date(task.created_at).toLocaleString()}
          </div>
        `}
        ${task?.updated_at &&
        html`
          <div class="meta-text">
            Updated: ${formatRelative(task.updated_at)}
          </div>
        `}
        ${task?.assignee &&
        html` <div class="meta-text">Assignee: ${task.assignee}</div> `}
        ${task?.branch &&
        html`
          <div class="meta-text" style="user-select:all">
            Branch: ${task.branch}
          </div>
        `}

        <!-- Action buttons -->
        <div class="btn-row">
          ${task?.status === "todo" &&
          onStart &&
          html`
            <button class="btn btn-primary btn-sm" onClick=${handleStart}>
              ▶ Start
            </button>
          `}
          ${(task?.status === "error" || task?.status === "cancelled") &&
          html`
            <button class="btn btn-primary btn-sm" onClick=${handleRetry}>
              ↻ Retry
            </button>
          `}
          <button
            class="btn btn-secondary btn-sm"
            onClick=${handleSave}
            disabled=${saving}
          >
            ${saving ? "Saving…" : "💾 Save"}
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => handleStatusUpdate("inreview")}
          >
            → Review
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => handleStatusUpdate("done")}
          >
            ✓ Done
          </button>
          ${task?.status !== "cancelled" &&
          html`
            <button
              class="btn btn-ghost btn-sm"
              style="color:var(--color-error)"
              onClick=${handleCancel}
            >
              ✕ Cancel
            </button>
          `}
        </div>

        <!-- Agent log link -->
        ${task?.id &&
        html`
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => {
              haptic();
              sendCommandToChat("/logs " + task.id);
            }}
          >
            📄 View Agent Logs
          </button>
        `}
      </div>
    <//>
  `;
}

/* ─── TasksTab ─── */
export function TasksTab() {
  const [showCreate, setShowCreate] = useState(false);
  const [detailTask, setDetailTask] = useState(null);
  const [startTarget, setStartTarget] = useState(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [isSearching, setIsSearching] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const searchRef = useRef(null);

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
  const pageSize = tasksPageSize?.value ?? 8;
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

  useEffect(() => {
    if (filterVal && filterVal !== "done") {
      lastNonCompletedRef.current = filterVal;
    }
  }, [filterVal]);

  /* Search (local fuzzy filter on already-loaded data) */
  const searchLower = trimmedSearch.toLowerCase();
  const visible = searchLower
    ? tasks.filter((t) =>
        `${t.title || ""} ${t.description || ""} ${t.id || ""} ${getTaskBaseBranch(t)} ${getTaskTags(t).join(" ")}`
          .toLowerCase()
          .includes(searchLower),
      )
    : tasks;

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
    const prev = cloneValue(tasks);
    const wantsDraft = newStatus === "draft";
    await runOptimistic(
      () => {
        tasksData.value = tasksData.value.map((t) =>
          t.id === taskId
            ? { ...t, status: newStatus, draft: wantsDraft }
            : t,
        );
      },
      async () => {
        const res = await apiFetch("/api/tasks/update", {
          method: "POST",
          body: JSON.stringify({
            taskId,
            status: newStatus,
            draft: wantsDraft,
          }),
        });
        if (res?.data)
          tasksData.value = tasksData.value.map((t) =>
            t.id === taskId ? { ...t, ...res.data } : t,
          );
      },
      () => {
        tasksData.value = prev;
      },
    ).catch(() => {});
  };

  const startTask = async ({ taskId, sdk, model }) => {
    haptic("medium");
    const prev = cloneValue(tasks);
    await runOptimistic(
      () => {
        tasksData.value = tasksData.value.map((t) =>
          t.id === taskId ? { ...t, status: "inprogress" } : t,
        );
      },
      () =>
        apiFetch("/api/tasks/start", {
          method: "POST",
          body: JSON.stringify({
            taskId,
            ...(sdk ? { sdk } : {}),
            ...(model ? { model } : {}),
          }),
        }),
      () => {
        tasksData.value = prev;
      },
    ).catch(() => {});
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
    setExportOpen(false);
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
    setExportOpen(false);
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
  const isKanban = viewMode.value === "kanban";
  const showBatchBar = !isKanban && batchMode && selectedIds.size > 0;

  if (!tasksLoaded.value && !tasks.length && !searchVal)
    return html`<${Card} title="Loading Tasks…"><${SkeletonCard} /><//>`;

  if (tasksLoaded.value && !tasks.length && !searchVal)
    return html`
      <div class="flex-between mb-sm" style="padding:0 4px">
        <div class="view-toggle">
          <button class="view-toggle-btn ${!isKanban ? 'active' : ''}" onClick=${() => { viewMode.value = 'list'; haptic(); }}>☰ List</button>
          <button class="view-toggle-btn ${isKanban ? 'active' : ''}" onClick=${() => { viewMode.value = 'kanban'; haptic(); }}>▦ Board</button>
        </div>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${toggleCompletedFilter}
        >
          ${completedOnly ? "Show All" : "Show Completed"}
        </button>
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
          icon="\u{1F4CB}"
          action=${{
            label: "Create Task",
            onClick: () => {
              haptic();
              setShowCreate(true);
            },
          }}
        />
      `}
      <button class="fab" onClick=${() => { haptic(); setShowCreate(true); }}>${ICONS.plus}</button>
      ${showCreate && html`<${CreateTaskModalInline} onClose=${() => setShowCreate(false)} />`}
    `;

  return html`
    <!-- Sticky search bar + view toggle -->
    <div class="sticky-search">
      <div class="sticky-search-row">
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
        <div class="view-toggle">
          <button class="view-toggle-btn ${!isKanban ? 'active' : ''}" onClick=${() => { viewMode.value = 'list'; haptic(); }}>☰ List</button>
          <button class="view-toggle-btn ${isKanban ? 'active' : ''}" onClick=${() => { viewMode.value = 'kanban'; haptic(); }}>▦ Board</button>
        </div>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${toggleCompletedFilter}
        >
          ${completedOnly ? "Show All" : "Show Completed"}
        </button>
        <div class="export-wrap">
          <button
            class="btn btn-secondary btn-sm export-btn"
            disabled=${exporting}
            onClick=${() => { setExportOpen(!exportOpen); haptic(); }}
          >
            ${DOWNLOAD_ICON} ${exporting ? "…" : "Export"}
          </button>
          ${exportOpen && html`
            <div class="export-dropdown">
              <button class="export-dropdown-item" onClick=${handleExportCSV}>📊 Export as CSV</button>
              <button class="export-dropdown-item" onClick=${handleExportJSON}>📋 Export as JSON</button>
            </div>
          `}
        </div>
      </div>
      ${hasActiveFilters && html`
        <div class="filter-summary">
          <div class="filter-summary-text">
            <span class="pill">Filters</span>
            <span>${filterSummary}</span>
          </div>
          <div class="filter-summary-actions">
            <button class="btn btn-ghost btn-sm" onClick=${handleClearFilters}>
              Clear Filters
            </button>
          </div>
        </div>
      `}
      ${showBatchBar &&
      html`
        <div class="btn-row batch-action-bar">
          <span class="pill">${selectedIds.size} selected</span>
          <button class="btn btn-primary btn-sm" onClick=${handleBatchDone}>
            ✓ Done All
          </button>
          <button class="btn btn-danger btn-sm" onClick=${handleBatchCancel}>
            ✕ Cancel All
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => {
              setSelectedIds(new Set());
              haptic();
            }}
          >
            Clear
          </button>
        </div>
      `}
    </div>

    <style>
      .export-btn { display:inline-flex; align-items:center; gap:4px; }
      .export-dropdown {
        position:absolute; right:0; top:100%; margin-top:4px; z-index:100;
        background:var(--card-bg, #1e1e2e); border:1px solid var(--border, #333);
        border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,.3); overflow:hidden;
        min-width:160px;
      }
      .export-dropdown-item {
        display:block; width:100%; padding:10px 14px; border:none;
        background:none; color:inherit; text-align:left; font-size:13px;
        cursor:pointer;
      }
      .export-dropdown-item:hover { background:var(--hover-bg, rgba(255,255,255,.08)); }
    </style>

    <!-- Kanban board view -->
    ${isKanban && html`<${KanbanBoard} onOpenTask=${openDetail} />`}

    <!-- List view filters -->
    ${!isKanban && html`<${Card} title="Task Board">
      <div class="chip-group mb-sm">
        ${STATUS_CHIPS.map(
          (s) => html`
            <button
              key=${s.value}
              class="chip ${filterVal === s.value ? "active" : ""}"
              onClick=${() => handleFilter(s.value)}
            >
              ${s.label}
            </button>
          `,
        )}
      </div>
      <div class="chip-group mb-sm">
        ${PRIORITY_CHIPS.map(
          (p) => html`
            <button
              key=${p.value}
              class="chip chip-outline ${priorityVal === p.value
                ? "active"
                : ""}"
              onClick=${() => handlePriorityFilter(p.value)}
            >
              ${p.label}
            </button>
          `,
        )}
      </div>
      <div class="flex-between mb-sm">
        <select
          class="input input-sm"
          value=${sortVal}
          onChange=${handleSort}
          style="max-width:140px"
        >
          ${SORT_OPTIONS.map(
            (o) =>
              html`<option key=${o.value} value=${o.value}>${o.label}</option>`,
          )}
        </select>
        <span class="pill">${visible.length} shown</span>
      </div>

      <!-- Batch mode toggle -->
      <div class="flex-between mb-sm">
        <label
          class="meta-text toggle-label"
          onClick=${() => {
            setBatchMode(!batchMode);
            haptic();
            setSelectedIds(new Set());
          }}
        >
          <input
            type="checkbox"
            checked=${batchMode}
            style="accent-color:var(--accent)"
          />
          Batch Select
        </label>
      </div>

    <//>

    <!-- Task list -->
    ${visible.map(
      (task) => html`
        <div
          key=${task.id}
          class="task-card ${batchMode && selectedIds.has(task.id)
            ? "task-card-selected"
            : ""} task-card-enter"
          onClick=${() =>
            batchMode ? toggleSelect(task.id) : openDetail(task.id)}
        >
          ${batchMode &&
          html`
            <input
              type="checkbox"
              checked=${selectedIds.has(task.id)}
              class="task-checkbox"
              onClick=${(e) => {
                e.stopPropagation();
                toggleSelect(task.id);
              }}
              style="accent-color:var(--accent)"
            />
          `}
          <div class="task-card-header">
            <div>
              <div class="task-card-title">${task.title || "(untitled)"}</div>
              <div class="task-card-meta">
                ${task.id}${task.priority
                  ? html` ·
                      <${Badge}
                        status=${task.priority}
                        text=${task.priority}
                      />`
                  : ""}
                ${task.updated_at
                  ? html` · ${formatRelative(task.updated_at)}`
                  : ""}
              </div>
            </div>
            <${Badge} status=${task.status} text=${task.status} />
          </div>
          <div class="meta-text">
            ${task.description
              ? truncate(task.description, 120)
              : "No description."}
          </div>
          ${getTaskBaseBranch(task) &&
          html`
            <div class="meta-text">
              Base: <code>${getTaskBaseBranch(task)}</code>
            </div>
          `}
          ${getTaskTags(task).length > 0 &&
          html`
            <div class="tag-row">
              ${getTaskTags(task).map(
                (tag) => html`<span class="tag-chip">#${tag}</span>`,
              )}
            </div>
          `}
          ${!batchMode &&
          html`
            <div class="btn-row mt-sm" onClick=${(e) => e.stopPropagation()}>
              ${task.status === "todo" &&
              html`
                <button
                  class="btn btn-primary btn-sm"
                  onClick=${() => openStartModal(task)}
                >
                  ▶ Start
                </button>
              `}
              <button
                class="btn btn-secondary btn-sm"
                onClick=${() => handleStatusUpdate(task.id, "inreview")}
              >
                → Review
              </button>
              <button
                class="btn btn-ghost btn-sm"
                onClick=${() => handleStatusUpdate(task.id, "done")}
              >
                ✓ Done
              </button>
            </div>
          `}
        </div>
      `,
    )}
    ${!visible.length &&
    html`
      <${EmptyState}
        message="No tasks match those filters"
        description="Try clearing filters or searching by ID, title, or tag."
        action=${hasActiveFilters
          ? { label: "Clear Filters", onClick: handleClearFilters }
          : null}
      />
    `}

    <!-- Pagination -->
    <div class="pager">
      <button
        class="btn btn-secondary btn-sm"
        onClick=${handlePrev}
        disabled=${page <= 0}
      >
        ← Prev
      </button>
      <span class="pager-info">Page ${page + 1} / ${totalPages}</span>
      <button
        class="btn btn-secondary btn-sm"
        onClick=${handleNext}
        disabled=${page + 1 >= totalPages}
      >
        Next →
      </button>
    </div>
    `}

    <!-- FAB -->
    <button
      class="fab"
      onClick=${() => {
        haptic();
        setShowCreate(true);
      }}
    >
      ${ICONS.plus}
    </button>

    <!-- Modals -->
    ${showCreate &&
    html`
      <!-- re-use CreateTaskModal from dashboard.js -->
      <${CreateTaskModalInline} onClose=${() => setShowCreate(false)} />
    `}
    ${detailTask &&
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

  const handleSubmit = async () => {
    if (!title.trim()) {
      showToast("Title is required", "error");
      return;
    }
    setSubmitting(true);
    haptic("medium");
    const tags = normalizeTagInput(tagsInput);
    try {
      await apiFetch("/api/tasks/create", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          baseBranch: baseBranch.trim() || undefined,
          priority,
          tags,
          draft,
          status: draft ? "draft" : "todo",
        }),
      });
      showToast("Task created", "success");
      onClose();
      await loadTasks();
    } catch {
      /* toast */
    }
    setSubmitting(false);
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
  }, [title, description, baseBranch, priority, tagsInput, draft]);

  return html`
    <${Modal} title="New Task" onClose=${onClose}>
      <div class="flex-col gap-md">
        <input
          class="input"
          placeholder="Task title"
          value=${title}
          onInput=${(e) => setTitle(e.target.value)}
        />
        <textarea
          class="input"
          rows="4"
          placeholder="Description"
          value=${description}
          onInput=${(e) => setDescription(e.target.value)}
        ></textarea>
        <input
          class="input"
          placeholder="Base branch (optional, e.g. feature/xyz)"
          value=${baseBranch}
          onInput=${(e) => setBaseBranch(e.target.value)}
        />
        <input
          class="input"
          placeholder="Tags (comma-separated)"
          value=${tagsInput}
          onInput=${(e) => setTagsInput(e.target.value)}
        />
        ${normalizeTagInput(tagsInput).length > 0 &&
        html`
          <div class="tag-row">
            ${normalizeTagInput(tagsInput).map(
              (tag) => html`<span class="tag-chip">#${tag}</span>`,
            )}
          </div>
        `}
        <${Toggle}
          label="Draft (keep in backlog)"
          checked=${draft}
          onChange=${(next) => setDraft(next)}
        />
        <${SegmentedControl}
          options=${[
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "critical", label: "Critical" },
          ]}
          value=${priority}
          onChange=${(v) => {
            haptic();
            setPriority(v);
          }}
        />
        <button
          class="btn btn-primary"
          onClick=${handleSubmit}
          disabled=${submitting}
        >
          ${submitting ? "Creating…" : "Create Task"}
        </button>
      </div>
    <//>
  `;
}
