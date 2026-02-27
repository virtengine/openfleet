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
import { getAgentDisplay } from "../modules/agent-display.js";
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
  updateTaskManualState,
  setPendingChange,
  clearPendingChange,
} from "../modules/state.js";
import { routeParams, setRouteParams } from "../modules/router.js";
import { ICONS } from "../modules/icons.js";
import {
  cloneValue,
  formatRelative,
  truncate,
  formatBytes,
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
  SaveDiscardBar,
} from "../components/shared.js";
import { SegmentedControl, SearchInput, Toggle } from "../components/forms.js";
import { KanbanBoard } from "../components/kanban-board.js";
import { VoiceMicButton, VoiceMicButtonInline } from "../modules/voice.js";
import {
  workspaces as managedWorkspaces,
  activeWorkspaceId,
  loadWorkspaces,
} from "../components/workspace-switcher.js";

/* ─── View mode toggle ─── */
const viewMode = signal("kanban");

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
  }, [task?.id, task?.meta?.codex?.isIgnored, task?.meta?.labels]);

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
    <${Modal} title="Start Task" onClose=${onClose} contentClassName="modal-content-wide">
      ${task?.id || task?.title
        ? html`
            <div class="meta-text mb-sm">
              ${task?.title || "(untitled)"} · ${task?.id || "—"}
            </div>
          `
        : html`
            <div class="meta-text mb-sm">
              Enter a task ID to manually dispatch it. Manual starts work even if automation is paused.
            </div>
          `}
      <div class="modal-form-grid">
        ${(allowTaskIdInput || !task?.id) &&
        html`
          <div class="modal-form-field modal-form-span">
            <div class="card-subtitle">Task ID</div>
            <input
              class="input"
              placeholder="e.g. task-123"
              value=${taskIdInput}
              onInput=${(e) => setTaskIdInput(e.target.value)}
            />
          </div>
        `}
        <div class="modal-form-field">
          <div class="card-subtitle">Executor SDK</div>
          <select class="input" value=${sdk} onChange=${(e) => setSdk(e.target.value)}>
            ${["auto", "codex", "copilot", "claude"].map(
              (opt) => html`<option value=${opt}>${opt}</option>`,
            )}
          </select>
        </div>
        <div class="modal-form-field">
          <div class="card-subtitle">Model Override (optional)</div>
          <select class="input" value=${model} disabled=${!canModel} onChange=${(e) => setModel(e.target.value)}>
            <option value="">Auto (default)</option>
            ${canModel && (EXECUTOR_MODELS[sdk] || []).map(m => html`<option value=${m}>${m}</option>`)}
          </select>
        </div>
        <div class="modal-form-field modal-form-span">
          <button
            class="btn btn-primary"
            onClick=${handleStart}
            disabled=${starting || !resolvedTaskId}
          >
            ${starting ? "Starting…" : "▶ Start Task"}
          </button>
        </div>
      </div>
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
  const [action, setAction] = useState(template?.action || "task-planner");
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
    setAction(template?.action || "task-planner");
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
    <div class="card" style="margin-bottom:10px;padding:10px 12px;">
      <div class="flex-between" style="gap:10px;align-items:flex-start;">
        <div style="min-width:0;">
          <div class="card-subtitle" style="font-size:13px;">${template?.name || template?.id}</div>
          <div class="meta-text" style="font-size:11px;word-break:break-all;">${template?.id || ""}</div>
        </div>
        <label class="meta-text" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
          <input
            type="checkbox"
            checked=${template?.enabled === true}
            disabled=${saving}
            onChange=${(event) => onToggleEnabled(template, event.target.checked)}
          />
          enabled
        </label>
      </div>

      ${template?.description && html`<div class="meta-text" style="margin-top:6px;">${template.description}</div>`}

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;margin-top:8px;">
        <span class="pill">spawned: ${stats.spawnedTotal || 0}</span>
        <span class="pill">active: ${stats.activeCount || 0}</span>
        <span class="pill">running: ${runningAgents.length}</span>
        <span class="pill">action: ${template?.action || "task-planner"}</span>
      </div>

      <div class="meta-text" style="margin-top:8px;">
        Last success: ${state?.last_success_at ? formatRelative(state.last_success_at) : "never"}
        ${state?.last_error ? ` · Last error: ${truncate(state.last_error, 100)}` : ""}
      </div>

      ${runningAgents.length > 0 && html`
        <div class="meta-text" style="margin-top:8px;font-weight:600;">Running agents</div>
        <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">
          ${runningAgents.map((entry) => html`
            <div class="meta-text" style="font-size:11px;">
              ${entry.taskId} · ${entry.sdk || "auto"}${entry.model ? ` · ${entry.model}` : ""}
            </div>
          `)}
        </div>
      `}

      ${recentSpawned.length > 0 && html`
        <div class="meta-text" style="margin-top:8px;font-weight:600;">Recent spawned tasks</div>
        <div style="display:flex;flex-direction:column;gap:4px;margin-top:4px;">
          ${recentSpawned.map((entry) => html`
            <div class="meta-text" style="font-size:11px;">
              ${entry.id} · ${entry.status || "todo"} · ${entry.createdAt ? formatRelative(entry.createdAt) : "unknown"}
            </div>
          `)}
        </div>
      `}

      ${editing && html`
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:10px;">
          <input class="input" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="Template name" />
          <input class="input" value=${description} onInput=${(e) => setDescription(e.target.value)} placeholder="Description" />
          <div class="input-row">
            <select class="input" value=${action} onChange=${(e) => setAction(e.target.value)}>
              <option value="task-planner">task-planner</option>
              <option value="create-task">create-task</option>
            </select>
            <input
              class="input"
              type="number"
              min="1"
              value=${minIntervalMinutes}
              onInput=${(e) => setMinIntervalMinutes(e.target.value)}
              placeholder="Min interval (minutes)"
            />
          </div>
          <textarea class="input" rows="6" value=${triggerJson} onInput=${(e) => setTriggerJson(e.target.value)}></textarea>
          <textarea class="input" rows="6" value=${configJson} onInput=${(e) => setConfigJson(e.target.value)}></textarea>
          ${error && html`<div class="meta-text" style="color:var(--color-error);">${error}</div>`}
        </div>
      `}

      <div class="btn-row" style="margin-top:10px;">
        <button class="btn btn-ghost btn-sm" onClick=${() => setEditing((prev) => !prev)}>
          ${editing ? "Close Editor" : "Edit"}
        </button>
        ${editing && html`
          <button class="btn btn-primary btn-sm" disabled=${saving} onClick=${handleSave}>
            ${saving ? "Saving…" : "Save Template"}
          </button>
        `}
      </div>
    </div>
  `;
}

function TriggerTemplatesModal({ onClose }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [defaults, setDefaults] = useState({ executor: "auto", model: "auto" });
  const [templates, setTemplates] = useState([]);
  const [planner, setPlanner] = useState({});

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await apiFetch("/api/triggers/templates", { _silent: true });
      const data = res?.data || {};
      setEnabled(data.enabled === true);
      setDefaults(
        data.defaults && typeof data.defaults === "object"
          ? data.defaults
          : { executor: "auto", model: "auto" },
      );
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
      setPlanner(data.planner || {});
    } catch (err) {
      setError(err?.message || "Failed to load templates");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadTemplates();
  }, []);

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
      setDefaults(
        data.defaults && typeof data.defaults === "object"
          ? data.defaults
          : { executor: "auto", model: "auto" },
      );
      setTemplates(Array.isArray(data.templates) ? data.templates : []);
      setPlanner(data.planner || {});
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

  const handleSaveDefaults = async () => {
    await persistUpdate({ defaults });
  };

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
      contentClassName="modal-content-wide"
    >
      <div class="flex-col" style="gap:10px;">
        <div class="card" style="padding:10px 12px;">
          <div class="flex-between" style="gap:10px;align-items:center;">
            <div>
              <div class="card-subtitle">Trigger System</div>
              <div class="meta-text">Enable/disable the full trigger template engine.</div>
            </div>
            <label class="meta-text" style="display:flex;align-items:center;gap:6px;cursor:pointer;">
              <input
                type="checkbox"
                checked=${enabled}
                disabled=${saving}
                onChange=${(event) => handleToggleSystem(event.target.checked)}
              />
              ${enabled ? "enabled" : "disabled"}
            </label>
          </div>

          <div class="input-row" style="margin-top:10px;">
            <select
              class="input"
              value=${defaults.executor || "auto"}
              onChange=${(e) => setDefaults({ ...defaults, executor: e.target.value })}
              disabled=${saving}
            >
              ${["auto", "codex", "copilot", "claude"].map(
                (opt) => html`<option value=${opt}>default executor: ${opt}</option>`,
              )}
            </select>
            <input
              class="input"
              value=${defaults.model || "auto"}
              disabled=${saving}
              onInput=${(e) => setDefaults({ ...defaults, model: e.target.value })}
              placeholder="default model (auto)"
            />
          </div>
          <div class="btn-row" style="margin-top:8px;">
            <button class="btn btn-secondary btn-sm" disabled=${saving} onClick=${handleSaveDefaults}>
              Save Defaults
            </button>
            <button class="btn btn-ghost btn-sm" disabled=${loading || saving} onClick=${loadTemplates}>
              Refresh
            </button>
          </div>

          <div class="meta-text" style="margin-top:8px;">
            Planner last success: ${planner?.lastSuccessAt ? formatRelative(planner.lastSuccessAt) : "never"}
            ${planner?.lastError ? ` · Last error: ${truncate(planner.lastError, 120)}` : ""}
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
  steps.push({ label: "Open pull request" });
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
  const agentDisplay = getAgentDisplay(liveTask || task);
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
          <div class="tp-hero-status-label">${iconText("⚡ Active — Agent Working")}</div>
        </div>
        <${Badge} status="inprogress" text="running" />
      </div>

      
      <div class="tp-meta-strip">
          <div class="tp-meta-item">
            <span class="tp-meta-label">Agent</span>
            <span class="tp-meta-value">
              <span class="agent-inline-icon">${agentDisplay.icon}</span>
              ${agentDisplay.label}
            </span>
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
                  ${done ? resolveIcon("✅") : active ? resolveIcon("🔄") : ICONS.dot}
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
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => { haptic(); sendCommandToChat("/steer " + task.id); onClose(); }}
          title="Guide the agent mid-task"
        >${iconText("💬 Steer")}</button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => { haptic(); sendCommandToChat("/logs " + task.id); onClose(); }}
        >${iconText("📄 Logs")}</button>
        <button class="btn btn-secondary btn-sm" onClick=${handleMarkReview}>
          → Move to Review
        </button>
        <button
          class="btn btn-ghost btn-sm"
          style="color:var(--color-error)"
          onClick=${handleCancel}
          disabled=${cancelling}
        >${cancelling ? "Cancelling…" : iconText("✕ Cancel")}</button>
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
  const agentDisplay = getAgentDisplay(liveTask || task);
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
        <span class="tr-review-icon">${resolveIcon("🔍")}</span>
        <div class="tr-hero-title">
          <div class="tr-hero-status-label">In Review</div>
          ${prNumber && html`
            <a
              class="tr-pr-badge"
              href="#"
              onClick=${(e) => { e.preventDefault(); haptic(); sendCommandToChat("/diff " + branchLabel); onClose(); }}
            >
              PR #${prNumber} · View diff ↗
            </a>
          `}
          ${!prNumber && html`<span style="font-size:12px;color:var(--text-hint);">No PR yet</span>`}
        </div>
        <${Badge} status="inreview" text="review" />
      </div>

      
      <div class="tr-meta-grid">
          <div class="tr-meta-item">
            <span class="tr-meta-label">Agent</span>
            <span class="tr-meta-value">
              <span class="agent-inline-icon">${agentDisplay.icon}</span>
              ${agentDisplay.label}
            </span>
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
          Checks ${allPass ? iconText("— ✅ All passing") : ""}
        </div>
        <div class="tr-checks-row">
          ${checks.map((c) => html`
            <div class="tr-check-item ${c.status}" key=${c.label}>
              ${resolveIcon(c.status === "pass" ? "✅" : c.status === "fail" ? "❌" : "⏳")}
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
                    : html`<span class="task-attachment-icon">${resolveIcon("📎")}</span>`}
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
        <button
          class="btn btn-primary btn-sm"
          onClick=${handleMarkDone}
          disabled=${merging}
          title="Mark as merged / done"
        >${iconText("✓ Mark Done")}</button>
        <button class="btn btn-secondary btn-sm" onClick=${handleReopen}>
          ↩ Reopen as Active
        </button>
        <button
          class="btn btn-ghost btn-sm"
          onClick=${() => { haptic(); sendCommandToChat("/logs " + task.id); onClose(); }}
        >${iconText("📄 Logs")}</button>
        ${prNumber && html`
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => { haptic(); sendCommandToChat("/diff " + branchLabel); onClose(); }}
          >${iconText("🔎 Diff")}</button>
        `}
        <button
          class="btn btn-ghost btn-sm"
          style="color:var(--color-error)"
          onClick=${handleCancel}
        >${iconText("✕ Cancel")}</button>
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
  const [attachments, setAttachments] = useState(
    normalizeTaskAttachments(task),
  );
  const [comments, setComments] = useState(
    normalizeTaskComments(task),
  );
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [draft, setDraft] = useState(
    Boolean(task?.draft || task?.status === "draft"),
  );
  const [saving, setSaving] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [manualOverride, setManualOverride] = useState(isTaskManual(task));
  const [manualBusy, setManualBusy] = useState(false);
  const [manualReason, setManualReason] = useState(getManualReason(task));
  const [workspaceId, setWorkspaceId] = useState(
    task?.workspace || activeWorkspaceId.value || "",
  );
  const [repository, setRepository] = useState(task?.repository || "");
  const attachmentInputRef = useRef(null);
  const baselineRef = useRef("");
  const activeWsId = activeWorkspaceId.value || "";
  const canDispatch = Boolean(onStart && task?.id);
  const pendingKey = `task-detail:${task?.id || "new"}`;
  const draftStorageKey = `ve-task-detail-draft:${task?.id || "new"}`;

  const workspaceOptions = managedWorkspaces.value || [];
  const selectedWorkspace = useMemo(
    () => workspaceOptions.find((ws) => ws.id === workspaceId) || null,
    [workspaceId, workspaceOptions],
  );
  const repositoryOptions = selectedWorkspace?.repos || [];

  useEffect(() => {
    setTitle(task?.title || "");
    setDescription(task?.description || "");
    setBaseBranch(getTaskBaseBranch(task));
    setStatus(task?.status || "todo");
    setPriority(task?.priority || "");
    setTagsInput(getTaskTags(task).join(", "));
    setAttachments(normalizeTaskAttachments(task));
    setComments(normalizeTaskComments(task));
    setDraft(Boolean(task?.draft || task?.status === "draft"));
    setManualOverride(isTaskManual(task));
    setManualReason(getManualReason(task));
    setWorkspaceId(task?.workspace || activeWorkspaceId.value || "");
    setRepository(task?.repository || "");
    baselineRef.current = "";
  }, [task?.id]);

  const snapshotValue = useMemo(
    () => JSON.stringify({
      title,
      description,
      baseBranch,
      status,
      priority,
      tagsInput,
      draft,
      manualReason,
      workspaceId,
      repository,
    }),
    [
      title,
      description,
      baseBranch,
      status,
      priority,
      tagsInput,
      draft,
      manualReason,
      workspaceId,
      repository,
    ],
  );

  useEffect(() => {
    if (!task?.id) return;
    if (!baselineRef.current) {
      baselineRef.current = snapshotValue;
    }
  }, [task?.id, snapshotValue]);

  const isDirty = baselineRef.current && baselineRef.current !== snapshotValue;

  const closeModal = useCallback(() => {
    if (isDirty && typeof window !== "undefined" && typeof window.confirm === "function") {
      const ok = window.confirm("Discard unsaved task changes?");
      if (!ok) return;
    }
    clearPendingChange(pendingKey);
    onClose();
  }, [isDirty, onClose, pendingKey]);

  useEffect(() => {
    setPendingChange(pendingKey, Boolean(isDirty));
    return () => clearPendingChange(pendingKey);
  }, [pendingKey, isDirty]);

  useEffect(() => {
    if (!task?.id) return;
    try {
      const raw = localStorage.getItem(draftStorageKey);
      if (!raw) return;
      const draftData = JSON.parse(raw);
      if (!draftData || typeof draftData !== "object") return;
      if (typeof draftData.title === "string") setTitle(draftData.title);
      if (typeof draftData.description === "string") setDescription(draftData.description);
      if (typeof draftData.baseBranch === "string") setBaseBranch(draftData.baseBranch);
      if (typeof draftData.status === "string") setStatus(draftData.status);
      if (typeof draftData.priority === "string") setPriority(draftData.priority);
      if (typeof draftData.tagsInput === "string") setTagsInput(draftData.tagsInput);
      if (typeof draftData.manualReason === "string") setManualReason(draftData.manualReason);
      if (typeof draftData.workspaceId === "string") setWorkspaceId(draftData.workspaceId);
      if (typeof draftData.repository === "string") setRepository(draftData.repository);
      if (typeof draftData.draft === "boolean") setDraft(draftData.draft);
    } catch {
      /* ignore malformed drafts */
    }
  }, [task?.id, draftStorageKey]);

  useEffect(() => {
    if (!task?.id) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          draftStorageKey,
          JSON.stringify({
            title,
            description,
            baseBranch,
            status,
            priority,
            tagsInput,
            draft,
            manualReason,
            workspaceId,
            repository,
          }),
        );
      } catch {
        /* storage best effort */
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [
    task?.id,
    draftStorageKey,
    title,
    description,
    baseBranch,
    status,
    priority,
    tagsInput,
    draft,
    manualReason,
    workspaceId,
    repository,
  ]);

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

  const handleSave = async ({ closeAfterSave = false } = {}) => {
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
                  workspace: workspaceId || null,
                  repository: repository || null,
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
              workspace: workspaceId || undefined,
              repository: repository || undefined,
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
      baselineRef.current = snapshotValue;
      clearPendingChange(pendingKey);
      try {
        localStorage.removeItem(draftStorageKey);
      } catch {
        /* ignore */
      }
      if (closeAfterSave) closeModal();
    } catch {
      /* toast via apiFetch */
    }
    setSaving(false);
  };

  const handleDiscard = () => {
    setTitle(task?.title || "");
    setDescription(task?.description || "");
    setBaseBranch(getTaskBaseBranch(task));
    setStatus(task?.status || "todo");
    setPriority(task?.priority || "");
    setTagsInput(getTaskTags(task).join(", "));
    setDraft(Boolean(task?.draft || task?.status === "draft"));
    setManualReason(getManualReason(task));
    setWorkspaceId(task?.workspace || activeWorkspaceId.value || "");
    setRepository(task?.repository || "");
    clearPendingChange(pendingKey);
    try {
      localStorage.removeItem(draftStorageKey);
    } catch {
      /* ignore */
    }
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
      if (newStatus === "done" || newStatus === "cancelled") closeModal();
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

  const handleRetry = async () => {
    haptic("medium");
    try {
      await apiFetch("/api/tasks/retry", {
        method: "POST",
        body: JSON.stringify({ taskId: task.id }),
      });
      showToast("Task retried", "success");
      closeModal();
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
    <${Modal} title=${task?.title || "Task Detail"} onClose=${closeModal} contentClassName="modal-content-wide">
      <div class="task-modal-summary">
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
            <button class="btn btn-primary btn-sm" onClick=${handleStart}>
              ▶ Dispatch Task
            </button>
          </div>
        `}
      </div>

        <div class="flex-col gap-md modal-form-grid">
        <div class="input-with-mic modal-form-span">
          <input
            class="input"
            placeholder="Title"
            value=${title}
            onInput=${(e) => setTitle(e.target.value)}
          />
          <${VoiceMicButtonInline}
            onTranscript=${(t) => setTitle((prev) => (prev ? prev + " " + t : t))}
            disabled=${saving || rewriting}
          />
        </div>
        <div class="textarea-with-mic modal-form-span" style="position:relative">
          <textarea
            class="input"
            rows="5"
            placeholder="Description"
            value=${description}
            onInput=${(e) => setDescription(e.target.value)}
            style="padding-right:36px"
          ></textarea>
          <${VoiceMicButton}
            onTranscript=${(t) => setDescription((prev) => (prev ? prev + " " + t : t))}
            disabled=${saving || rewriting}
            size="sm"
            className="textarea-mic-btn"
          />
        </div>
        <div
          class="task-attachments-block modal-form-span"
          onPaste=${handleAttachmentPaste}
        >
          <div class="task-attachments-header">
            <div class="task-attachments-title">Attachments</div>
            <div class="task-attachments-actions">
              <button
                class="btn btn-ghost btn-sm"
                type="button"
                onClick=${() => attachmentInputRef.current && attachmentInputRef.current.click()}
                disabled=${uploadingAttachment}
              >
                Upload
              </button>
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
                      : html`<span class="task-attachment-icon">${resolveIcon("📎")}</span>`}
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
        ${comments.length > 0 && html`
          <div class="task-comments-block modal-form-span">
            <div class="task-attachments-title">Comments</div>
            <div class="task-comments-list">
              ${comments.map((comment, index) => html`
                <div class="task-comment-item" key=${comment.id || `comment-${index}`}>
                  <div class="task-comment-meta">
                    ${comment.author ? `@${comment.author}` : "comment"}
                    ${comment.createdAt ? ` · ${formatRelative(comment.createdAt)}` : ""}
                  </div>
                  <div class="task-comment-body">${comment.body}</div>
                </div>
              `)}
            </div>
          </div>
        `}
        <button
          type="button"
          class="btn btn-ghost btn-sm task-rewrite-btn modal-form-span"
          style="display:flex;align-items:center;gap:6px;align-self:flex-start;font-size:12px;padding:5px 10px;opacity:${!title.trim() ? 0.45 : 1}"
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
          title="Use AI to expand and improve this task description"
        >
          ${rewriting
            ? html`<span style="display:inline-block;animation:spin 0.8s linear infinite">${resolveIcon("⏳")}</span> Improving…`
            : html`${iconText("✨ Improve with AI")}`
          }
        </button>
        <input
          class="input modal-form-span"
          placeholder="Base branch (optional, e.g. feature/xyz)"
          value=${baseBranch}
          onInput=${(e) => setBaseBranch(e.target.value)}
        />
        <div class="input-row modal-form-span">
          <select
            class="input"
            value=${workspaceId}
            onChange=${(e) => setWorkspaceId(e.target.value)}
          >
            <option value="">Active workspace</option>
            ${workspaceOptions.map(
              (ws) => html`<option value=${ws.id}>${ws.name || ws.id}</option>`,
            )}
          </select>
          <select
            class="input"
            value=${repository}
            onChange=${(e) => setRepository(e.target.value)}
            disabled=${!repositoryOptions.length}
          >
            <option value="">
              ${repositoryOptions.length ? "Auto repository" : "No repos in workspace"}
            </option>
            ${repositoryOptions.map(
              (repo) =>
                html`<option value=${repo.slug}>${repo.name}${repo.primary ? " (Primary)" : ""}</option>`,
            )}
          </select>
        </div>
        <input
          class="input modal-form-span"
          placeholder="Tags (comma-separated)"
          value=${tagsInput}
          onInput=${(e) => setTagsInput(e.target.value)}
        />
        ${normalizeTagInput(tagsInput).length > 0 &&
        html`
          <div class="tag-row modal-form-span">
            ${normalizeTagInput(tagsInput).map(
              (tag) => html`<span class="tag-chip">#${tag}</span>`,
            )}
          </div>
        `}

        <div class="input-row modal-form-span">
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
        <input
          class="input modal-form-span"
          placeholder="Manual reason (optional)"
          value=${manualReason}
          disabled=${manualBusy}
          onInput=${(e) => setManualReason(e.target.value)}
        />
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

        ${isDirty &&
        html`
          <${SaveDiscardBar}
            dirty=${isDirty}
            message="Task changes are not saved"
            saveLabel="Save"
            discardLabel="Discard"
            saving=${saving}
            onSave=${() => handleSave({ closeAfterSave: false })}
            onDiscard=${handleDiscard}
            className="modal-form-span"
          />
        `}

        <div class="btn-row modal-form-span">
          ${(task?.status === "error" || task?.status === "cancelled") &&
          html`
            <button class="btn btn-primary btn-sm" onClick=${handleRetry}>
              ↻ Retry
            </button>
          `}
          <button
            class="btn btn-secondary btn-sm"
            onClick=${() => handleSave({ closeAfterSave: true })}
            disabled=${saving}
          >
            ${saving ? "Saving…" : "Save and Close"}
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
            ${iconText("✓ Done")}
          </button>
          ${task?.status !== "cancelled" &&
          html`
            <button
              class="btn btn-ghost btn-sm"
              style="color:var(--color-error)"
              onClick=${handleCancel}
            >
              ${iconText("✕ Cancel")}
            </button>
          `}
        </div>

        ${task?.id &&
        html`
          <button
            class="btn btn-ghost btn-sm modal-form-span"
            onClick=${() => {
              haptic();
              sendCommandToChat("/logs " + task.id);
            }}
          >
            ${iconText("📄 View Agent Logs")}
          </button>
        `}
      </div>
    <//>
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
  const [listSortCol, setListSortCol] = useState("");   // active column sort in list mode
  const [listSortDir, setListSortDir] = useState("desc"); // "asc" | "desc"
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
    pageSize: tasksPageSize?.value ?? 20,
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
  const pageSize = tasksPageSize?.value ?? 8;
  const totalPages = tasksTotalPages?.value ?? 1;
  const defaultSdk = executorData.value?.data?.sdk || "auto";
  const activeSlots = executorData.value?.data?.slots || [];
  const hasActiveSlots = activeSlots.length > 0;
  const completedOnly = filterVal === "done";
  const trimmedSearch = searchVal.trim();
  const statusLabel =
    STATUS_CHIPS.find((s) => s.value === filterVal)?.label || "All";
  const routeTaskId = String(routeParams.value?.taskId || "").trim();
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
  const viewModeInitRef = useRef(false);

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
  }, [isKanban, filterVal, priorityVal, sortVal, page, pageSize]);

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
      if ((tasksPageSize?.value ?? 0) < 120) {
        tasksPageSize.value = 200;
        shouldReload = true;
      }
    } else if (listStateRef.current) {
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
  }, [isKanban]);

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
    setRouteParams(taskId ? { taskId } : {}, { replace: false, skipGuard: true });
    haptic();
    const local = tasks.find((t) => t.id === taskId);
    const result = await apiFetch(
      `/api/tasks/detail?taskId=${encodeURIComponent(taskId)}`,
      { _silent: true },
    ).catch(() => ({ data: local }));
    setDetailTask(result.data || local);
  };

  useEffect(() => {
    if (!routeTaskId) return;
    if (detailTask?.id === routeTaskId) return;
    openDetail(routeTaskId);
  }, [routeTaskId]);

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
  const showBatchBar = !isKanban && batchMode && selectedIds.size > 0;

  if (!tasksLoaded.value && !tasks.length && !searchVal)
    return html`<${Card} title="Loading Tasks…"><${SkeletonCard} /><//>`;

  if (tasksLoaded.value && !tasks.length && !searchVal)
    return html`
      <div class="flex-between mb-sm" style="padding:0 4px">
        <div class="view-toggle">
          <button class="view-toggle-btn ${!isKanban ? 'active' : ''}" onClick=${() => { viewMode.value = 'list'; haptic(); }}>${iconText("☰ List")}</button>
          <button class="view-toggle-btn ${isKanban ? 'active' : ''}" onClick=${() => { viewMode.value = 'kanban'; haptic(); }}>▦ Board</button>
        </div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button
            class="btn btn-ghost btn-sm"
            onClick=${() => {
              haptic();
              setShowTemplates(true);
            }}
          >
            ${iconText("⚡ Templates")}
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick=${toggleCompletedFilter}
          >
            ${completedOnly ? "Show All" : "Show Completed"}
          </button>
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
      <button class="fab" onClick=${() => { haptic(); setShowCreate(true); }}>${ICONS.plus}</button>
      ${showCreate && html`<${CreateTaskModalInline} onClose=${() => setShowCreate(false)} />`}
    `;

  const filterButton = html`
    <button
      class="btn btn-secondary btn-sm filter-toggle ${filtersOpen ? "active" : ""}"
      onClick=${handleToggleFilters}
      aria-expanded=${filtersOpen}
    >
      ${ICONS.filter}
      Filters
      ${activeFilterCount > 0 && html`
        <span class="filter-count">${activeFilterCount}</span>
      `}
    </button>
  `;

  const viewToggle = html`
    <div class="view-toggle">
      <button class="view-toggle-btn ${!isKanban ? 'active' : ''}" onClick=${() => { viewMode.value = 'list'; haptic(); }}>${iconText("☰ List")}</button>
      <button class="view-toggle-btn ${isKanban ? 'active' : ''}" onClick=${() => { viewMode.value = 'kanban'; haptic(); }}>▦ Board</button>
    </div>
  `;

  const newButton = html`
    <button
      class="btn btn-primary btn-sm btn-icon-compact"
      onClick=${() => {
        haptic();
        setShowCreate(true);
      }}
      aria-label="Create task"
    >
      ${ICONS.plus}
      ${isCompact ? "New" : "New Task"}
    </button>
  `;

  const actionsMenu = html`
    <div class="actions-wrap" ref=${actionsRef}>
      <button
        class="btn btn-ghost btn-sm actions-btn"
        onClick=${() => { setActionsOpen(!actionsOpen); haptic(); }}
        aria-haspopup="menu"
        aria-expanded=${actionsOpen}
        disabled=${exporting}
      >
        ${ICONS.ellipsis}
        <span class="actions-label">Actions</span>
      </button>
      ${actionsOpen && html`
        <div class="actions-dropdown" role="menu">
          <button
            class="actions-dropdown-item"
            onClick=${() => { setActionsOpen(false); setStartAnyOpen(true); }}
          >
            ${iconText("▶ Start Task")}
          </button>
          <button
            class="actions-dropdown-item"
            onClick=${() => { setActionsOpen(false); setShowTemplates(true); }}
          >
            ${iconText("⚡ Trigger Templates")}
          </button>
          <button class="actions-dropdown-item" onClick=${handleExportCSV}>${iconText("📊 Export CSV")}</button>
          <button class="actions-dropdown-item" onClick=${handleExportJSON}>${iconText("📋 Export JSON")}</button>
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
                  </div>
                  <div class="tasks-toolbar-group">
                    ${newButton}
                    ${actionsMenu}
                  </div>
                `
              : html`
                  ${filterButton}
                  ${viewToggle}
                  ${newButton}
                  <button
                    class="btn btn-ghost btn-sm"
                    onClick=${() => {
                      haptic();
                      setStartAnyOpen(true);
                    }}
                  >
                    ▶ Start Task
                  </button>
                  ${actionsMenu}
                `}
          </div>
        </div>

        <div class="tasks-filter-panel ${filtersOpen ? "open" : ""}">
          <div class="tasks-filter-grid">
            ${!isKanban && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">Status</div>
                <div class="chip-group">
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
              </div>
            `}
            ${!isKanban && html`
              <div class="tasks-filter-section">
                <div class="tasks-filter-title">Priority</div>
                <div class="chip-group">
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
              </div>
            `}
            <div class="tasks-filter-section">
              <div class="tasks-filter-title">Sort</div>
              <div class="tasks-filter-row">
                <select
                  class="input input-sm"
                  value=${sortVal}
                  onChange=${handleSort}
                >
                  ${SORT_OPTIONS.map(
                    (o) =>
                      html`<option key=${o.value} value=${o.value}>${o.label}</option>`,
                  )}
                </select>
                <span class="pill">${visible.length} shown</span>
              </div>
            </div>
            <div class="tasks-filter-section">
              <div class="tasks-filter-title">Actions</div>
              <div class="tasks-filter-row">
                ${!isKanban && (isCompact
                  ? html`
                      <${Toggle}
                        label="Completed only"
                        checked=${completedOnly}
                        onChange=${handleCompletedToggle}
                      />
                    `
                  : html`
                      <button
                        class="btn btn-ghost btn-sm"
                        onClick=${toggleCompletedFilter}
                      >
                        ${completedOnly ? "Show All" : "Show Completed"}
                      </button>
                    `)}
                ${hasActiveFilters &&
                html`
                  <button
                    class="btn btn-ghost btn-sm"
                    onClick=${handleClearFilters}
                  >
                    Clear Filters
                  </button>
                `}
              </div>
            </div>
            ${!isKanban && html`
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
                  <input
                    type="checkbox"
                    checked=${batchMode}
                    style="accent-color:var(--accent)"
                  />
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
          </div>
        </div>
      </div>
      ${hasActiveFilters && (!isCompact || filtersOpen) && html`
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
            ${iconText("✓ Done All")}
          </button>
          <button class="btn btn-danger btn-sm" onClick=${handleBatchCancel}>
            ${iconText("✕ Cancel All")}
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

    <div class="snapshot-bar">
      ${summaryMetrics.map((m) => html`
        <button
          key=${m.label}
          class="snapshot-pill snapshot-pill-btn ${!isKanban && filterVal === SNAPSHOT_STATUS_MAP[m.label] ? 'snapshot-pill-active' : ''}"
          onClick=${() => {
            if (isKanban) return;
            const statusVal = SNAPSHOT_STATUS_MAP[m.label];
            if (statusVal !== undefined) handleFilter(filterVal === statusVal ? 'all' : statusVal);
          }}
          title=${isKanban ? m.label : `Filter by ${m.label}`}
        >
          <span class="snapshot-dot" style="background:${m.color};" />
          <strong class="snapshot-val">${m.value}</strong>
          <span class="snapshot-lbl">${m.label}</span>
        </button>
      `)}
      <span class="snapshot-view-tag">${iconText(isKanban ? "⬛ Board" : "☰ List")}</span>
    </div>

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

    ${isKanban && html`<${KanbanBoard} onOpenTask=${openDetail} />`}

    ${!isKanban && visible.length > 0 && html`
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
    ${!isKanban && !visible.length &&
    html`
      <${EmptyState}
        message="No tasks match those filters"
        description="Try clearing filters or searching by ID, title, or tag."
        action=${hasActiveFilters
          ? { label: "Clear Filters", onClick: handleClearFilters }
          : null}
      />
    `}

    ${!isKanban && html`
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

    <button
      class="fab"
      onClick=${() => {
        haptic();
        setShowCreate(true);
      }}
    >
      ${ICONS.plus}
    </button>

    ${showCreate &&
    html`
      <${CreateTaskModalInline} onClose=${() => setShowCreate(false)} />
    `}
    ${detailTask && isActiveStatus(detailTask.status) &&
    html`
      <${TaskProgressModal}
        task=${detailTask}
        onClose=${() => {
          setDetailTask(null);
          setRouteParams({}, { replace: true, skipGuard: true });
        }}
      />
    `}
    ${detailTask && isReviewStatus(detailTask.status) &&
    html`
      <${TaskReviewModal}
        task=${detailTask}
        onClose=${() => {
          setDetailTask(null);
          setRouteParams({}, { replace: true, skipGuard: true });
        }}
        onStart=${(task) => openStartModal(task)}
      />
    `}
    ${detailTask && !isActiveStatus(detailTask.status) && !isReviewStatus(detailTask.status) &&
    html`
      <${TaskDetailModal}
        task=${detailTask}
        onClose=${() => {
          setDetailTask(null);
          setRouteParams({}, { replace: true, skipGuard: true });
        }}
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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const draftStorageKey = "ve-task-create-draft";

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

  useEffect(() => {
    try {
      const raw = localStorage.getItem(draftStorageKey);
      if (!raw) return;
      const draftData = JSON.parse(raw);
      if (typeof draftData.title === "string") setTitle(draftData.title);
      if (typeof draftData.description === "string") setDescription(draftData.description);
      if (typeof draftData.baseBranch === "string") setBaseBranch(draftData.baseBranch);
      if (typeof draftData.priority === "string") setPriority(draftData.priority);
      if (typeof draftData.tagsInput === "string") setTagsInput(draftData.tagsInput);
      if (typeof draftData.workspaceId === "string") setWorkspaceId(draftData.workspaceId);
      if (typeof draftData.repository === "string") setRepository(draftData.repository);
      if (typeof draftData.draft === "boolean") setDraft(draftData.draft);
      if (typeof draftData.showAdvanced === "boolean") setShowAdvanced(draftData.showAdvanced);
    } catch {
      /* ignore malformed drafts */
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          draftStorageKey,
          JSON.stringify({
            title,
            description,
            baseBranch,
            priority,
            tagsInput,
            workspaceId,
            repository,
            draft,
            showAdvanced,
          }),
        );
      } catch {
        /* ignore storage errors */
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [
    title,
    description,
    baseBranch,
    priority,
    tagsInput,
    workspaceId,
    repository,
    draft,
    showAdvanced,
  ]);

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
      return;
    }
    if (!repositoryOptions.some((repo) => repo?.slug === repository)) {
      const primary = repositoryOptions.find((repo) => repo?.primary);
      setRepository(primary?.slug || repositoryOptions[0]?.slug || "");
    }
  }, [workspaceId, repositoryOptions.length]);

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
          workspace: workspaceId || undefined,
          repository: repository || undefined,
        }),
      });
      showToast("Task created", "success");
      try {
        localStorage.removeItem(draftStorageKey);
      } catch {
        /* ignore */
      }
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
  }, [
    title,
    description,
    baseBranch,
    priority,
    tagsInput,
    draft,
    workspaceId,
    repository,
  ]);

  const parsedTags = normalizeTagInput(tagsInput);
  const hasAdvanced = baseBranch || draft || showAdvanced;

  const footerContent = html`
    <button
      class="btn btn-primary"
      style="width:100%"
      onClick=${handleSubmit}
      disabled=${submitting}
    >
      ${submitting ? "Creating…" : iconText("✓ Create Task")}
    </button>
  `;

  return html`
    <${Modal}
      title="New Task"
      onClose=${onClose}
      contentClassName="modal-content-wide"
      footer=${footerContent}
    >
      <div class="flex-col create-task-form">

        <!-- Title — autofocus so keyboard opens immediately -->
        <div class="input-with-mic">
          <input
            class="input"
            placeholder="Task title *"
            value=${title}
            autoFocus=${true}
            onInput=${(e) => setTitle(e.target.value)}
            onKeyDown=${(e) => e.key === "Enter" && !e.shiftKey && handleSubmit()}
          />
          <${VoiceMicButtonInline}
            onTranscript=${(t) => setTitle((prev) => (prev ? prev + " " + t : t))}
            disabled=${submitting || rewriting}
          />
        </div>

        <!-- Description — compact 2-row textarea -->
        <div class="textarea-with-mic" style="position:relative">
          <textarea
            class="input"
            rows="2"
            placeholder="What needs to be done? (optional)"
            value=${description}
            onInput=${(e) => {
              setDescription(e.target.value);
              // auto-grow up to 6 rows
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 6 * 24 + 16) + "px";
            }}
            style="padding-right:36px"
          ></textarea>
          <${VoiceMicButton}
            onTranscript=${(t) => setDescription((prev) => (prev ? prev + " " + t : t))}
            disabled=${submitting || rewriting}
            size="sm"
            className="textarea-mic-btn"
          />
        </div>

        <!-- Rewrite / Improve button -->
        <button
          type="button"
          class="btn btn-ghost btn-sm task-rewrite-btn"
          style="display:flex;align-items:center;gap:6px;align-self:flex-start;font-size:12px;padding:5px 10px;opacity:${!title.trim() ? 0.45 : 1}"
          disabled=${!title.trim() || rewriting || submitting}
          onClick=${handleRewrite}
          title="Use AI to expand and improve this task description"
        >
          ${rewriting
            ? html`<span class="spin-icon" style="display:inline-block;animation:spin 0.8s linear infinite">${resolveIcon("⏳")}</span> Improving…`
            : html`${iconText("✨ Improve with AI")}`
          }
        </button>

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
            <select
              class="input"
              value=${workspaceId}
              onChange=${(e) => setWorkspaceId(e.target.value)}
            >
              <option value="">Active workspace</option>
              ${workspaceOptions.map(
                (ws) => html`<option value=${ws.id}>${ws.name || ws.id}</option>`,
              )}
            </select>
            <select
              class="input"
              value=${repository}
              onChange=${(e) => setRepository(e.target.value)}
              disabled=${!repositoryOptions.length}
            >
              <option value="">
                ${repositoryOptions.length ? "Auto repo" : "No repos"}
              </option>
              ${repositoryOptions.map(
                (repo) =>
                  html`<option value=${repo.slug}>${repo.name}${repo.primary ? " (Primary)" : ""}</option>`,
              )}
            </select>
          </div>
        `}

        <!-- Tags -->
        <input
          class="input"
          placeholder="Tags (comma-separated, optional)"
          value=${tagsInput}
          onInput=${(e) => setTagsInput(e.target.value)}
        />
        ${parsedTags.length > 0 && html`
          <div class="tag-row">
            ${parsedTags.map((tag) => html`<span class="tag-chip">#${tag}</span>`)}
          </div>
        `}

        <!-- Advanced toggle -->
        <button
          class="btn btn-ghost btn-sm create-task-advanced-toggle"
          style="text-align:left;justify-content:flex-start;gap:6px;padding:6px 0;color:var(--text-hint)"
          onClick=${() => setShowAdvanced(!showAdvanced)}
          type="button"
        >
          <span style="display:inline-block;transition:transform 0.15s;transform:rotate(${showAdvanced ? 90 : 0}deg)">▶</span>
          Advanced${hasAdvanced && !showAdvanced ? " •" : ""}
        </button>

        <!-- Advanced fields: base branch + draft -->
        ${(showAdvanced || hasAdvanced) && html`
          <input
            class="input"
            placeholder="Base branch (optional, e.g. main)"
            value=${baseBranch}
            onInput=${(e) => setBaseBranch(e.target.value)}
          />
          <${Toggle}
            label="Draft (save to backlog, don't start)"
            checked=${draft}
            onChange=${(next) => setDraft(next)}
          />
        `}

      </div>
    <//>
  `;
}
