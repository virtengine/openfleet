import figures from "figures";

export const WORKFLOW_HISTORY_LIMIT = 50;
export const WORKFLOW_FLASH_DURATION_MS = 3000;
export const WORKFLOW_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function formatTime(value) {
  if (!value) return "-";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "-";
  }
}

function formatDuration(durationMs) {
  const total = Number(durationMs);
  if (!Number.isFinite(total) || total < 0) return "-";
  if (total < 1000) return `${Math.max(0, Math.round(total))}ms`;
  const seconds = Math.round(total / 100) / 10;
  return `${seconds}s`;
}

function normalizeRequiredInputs(schema = {}) {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) {
    return schema.map((entry, index) => ({
      id: String(entry?.id || entry?.name || `input${index + 1}`),
      label: String(entry?.label || entry?.id || entry?.name || `input${index + 1}`),
      required: entry?.required !== false,
      defaultValue: entry?.default ?? entry?.defaultValue ?? "",
      description: String(entry?.description || ""),
    }));
  }
  const requiredSet = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const properties = schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : schema;
  return Object.entries(properties)
    .filter(([key]) => key !== "required" && key !== "properties")
    .map(([key, value]) => ({
      id: String(key),
      label: String(value?.label || key),
      required: value?.required === true || requiredSet.has(key),
      defaultValue: value?.default ?? value?.defaultValue ?? "",
      description: String(value?.description || ""),
    }));
}

export function createWorkflowTriggerFormState(requiredInputs = {}) {
  const fields = normalizeRequiredInputs(requiredInputs).map((field) => ({
    id: field.id,
    label: field.label,
    required: field.required,
    value: String(field.defaultValue ?? ""),
    description: field.description,
  }));
  const values = Object.fromEntries(fields.map((field) => [field.id, field.value]));
  return { fields, values };
}

export function buildWorkflowTemplateRows(workflows, options = {}) {
  const activeRuns = options.activeRuns instanceof Map ? options.activeRuns : new Map();
  const flashByWorkflowId = options.flashByWorkflowId instanceof Map ? options.flashByWorkflowId : new Map();
  const now = Number(options.now) || Date.now();

  return (Array.isArray(workflows) ? workflows : []).map((workflow) => {
    const workflowId = String(workflow?.id || workflow?.name || "workflow");
    const activeRun = activeRuns.get(workflowId) || null;
    const flash = flashByWorkflowId.get(workflowId) || null;
    const requiredInputs = normalizeRequiredInputs(
      workflow?.requiredInputs || workflow?.required_inputs || workflow?.inputSchema || {},
    );
    const triggerSuffix = requiredInputs.length
      ? requiredInputs.map((field) => `${field.id}${field.required ? "*" : ""}`).join(", ")
      : "manual";

    let namePrefix = "  ";
    if (activeRun) {
      const spinnerFrame = WORKFLOW_SPINNER_FRAMES[(Number(activeRun.spinnerFrame) || 0) % WORKFLOW_SPINNER_FRAMES.length];
      namePrefix = `${spinnerFrame} `;
    } else if (flash && now - Number(flash.at || 0) <= WORKFLOW_FLASH_DURATION_MS) {
      namePrefix = flash.status === "completed" ? "✔ " : "✖ ";
    }

    return {
      id: workflowId,
      name: `${namePrefix}${workflow?.name || workflowId}`,
      type: String(workflow?.type || "workflow"),
      enabled: workflow?.enabled === false ? "no" : "yes",
      lastRun: formatTime(workflow?.lastRunAt || workflow?.lastRun || workflow?.lastRunStartAt || null),
      lastResult: String(workflow?.lastResult || workflow?.status || "-") || "-",
      scheduleOrTrigger: `${workflow?.schedule || workflow?.trigger || "manual"} · ${triggerSuffix}`,
    };
  });
}

export function buildWorkflowHistoryRows(history) {
  return (Array.isArray(history) ? [...history] : [])
    .sort((left, right) => Number(right?.startedAt || right?.timestamp || 0) - Number(left?.startedAt || left?.timestamp || 0))
    .slice(0, WORKFLOW_HISTORY_LIMIT)
    .map((entry) => ({
      runId: String(entry?.runId || ""),
      workflowId: String(entry?.workflowId || ""),
      workflowName: String(entry?.workflowName || entry?.workflowId || "workflow"),
      startedAt: formatTime(entry?.startedAt || entry?.timestamp || null),
      duration: formatDuration(entry?.durationMs || ((entry?.endedAt && entry?.startedAt) ? (Number(entry.endedAt) - Number(entry.startedAt)) : null)),
      result: String(entry?.status || "unknown"),
      trigger: String(entry?.triggerSource || entry?.trigger || "manual"),
      error: entry?.error ? String(entry.error) : "",
    }));
}

function createEmptyWorkflowStatusState() {
  return {
    activeRuns: new Map(),
    flashByWorkflowId: new Map(),
    history: [],
  };
}

function pruneExpiredFlashes(flashByWorkflowId, now) {
  const next = new Map();
  for (const [workflowId, flash] of flashByWorkflowId.entries()) {
    if (now - Number(flash?.at || 0) <= WORKFLOW_FLASH_DURATION_MS) next.set(workflowId, flash);
  }
  return next;
}

export function reduceWorkflowStatusEvent(prevState, payload, now = Date.now()) {
  const state = prevState || createEmptyWorkflowStatusState();
  const activeRuns = new Map(state.activeRuns);
  const flashByWorkflowId = pruneExpiredFlashes(state.flashByWorkflowId, now);
  const history = Array.isArray(state.history) ? [...state.history] : [];

  const workflowId = String(payload?.workflowId || "");
  const runId = String(payload?.runId || "");
  if (!workflowId || !runId) return { activeRuns, flashByWorkflowId, history };

  const eventType = String(payload?.eventType || "").toLowerCase();
  const status = String(payload?.status || "").toLowerCase();
  if (eventType === "run:start") {
    const previous = activeRuns.get(workflowId);
    activeRuns.set(workflowId, {
      runId,
      workflowName: payload?.workflowName || workflowId,
      spinnerFrame: ((previous?.spinnerFrame ?? -1) + 1) % WORKFLOW_SPINNER_FRAMES.length,
      startedAt: payload?.timestamp || now,
      status: payload?.status || "running",
    });
  } else if (eventType === "run:end" || eventType === "run:error") {
    activeRuns.delete(workflowId);
    flashByWorkflowId.set(workflowId, { status, at: now });
    history.unshift({
      runId,
      workflowId,
      workflowName: payload?.workflowName || workflowId,
      status: payload?.status || (eventType === "run:error" ? "failed" : "completed"),
      startedAt: payload?.meta?.startedAt || now,
      endedAt: payload?.timestamp || now,
      durationMs: payload?.durationMs ?? null,
      triggerSource: payload?.meta?.triggerSource || "manual",
      error: payload?.error || null,
    });
  } else if (eventType === "run:cancelled" || status === "cancelled") {
    activeRuns.delete(workflowId);
    flashByWorkflowId.set(workflowId, { status: "cancelled", at: now });
    history.unshift({
      runId,
      workflowId,
      workflowName: payload?.workflowName || workflowId,
      status: "cancelled",
      startedAt: payload?.meta?.startedAt || now,
      endedAt: payload?.timestamp || now,
      durationMs: payload?.durationMs ?? null,
      triggerSource: payload?.meta?.triggerSource || "manual",
      error: payload?.error || null,
    });
  }

  return {
    activeRuns,
    flashByWorkflowId,
    history: history.slice(0, WORKFLOW_HISTORY_LIMIT),
  };
}

export function tickWorkflowStatusState(prevState) {
  const state = prevState || createEmptyWorkflowStatusState();
  const activeRuns = new Map();
  for (const [workflowId, activeRun] of state.activeRuns.entries()) {
    activeRuns.set(workflowId, {
      ...activeRun,
      spinnerFrame: ((Number(activeRun?.spinnerFrame) || 0) + 1) % WORKFLOW_SPINNER_FRAMES.length,
    });
  }

  return {
    activeRuns,
    flashByWorkflowId: pruneExpiredFlashes(state.flashByWorkflowId, Date.now()),
    history: Array.isArray(state.history) ? [...state.history] : [],
  };
}

export function toggleWorkflowTreeNode(expandedPaths, path) {
  const next = new Set(expandedPaths instanceof Set ? expandedPaths : []);
  const key = String(path || "").trim();
  if (!key) return next;
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function workflowResultColor(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "completed" || normalized === "success") return "green";
  if (normalized === "failed" || normalized === "error") return "red";
  if (normalized === "running") return "yellow";
  if (normalized === "cancelled") return figures.cross ? "red" : "red";
  return "gray";
}