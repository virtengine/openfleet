export const TASK_COLUMNS = ["todo", "inprogress", "inreview", "blocked", "done"];
export const TASK_PRIORITY_OPTIONS = ["critical", "high", "medium", "low"];
export const TASK_FORM_FIELDS = ["title", "description", "priority"];

const TASK_FORM_LABELS = {
  title: "Title",
  description: "Description",
  priority: "Priority",
};

const TASK_FORM_PLACEHOLDERS = {
  title: "(required)",
  description: "(optional)",
  priority: "medium",
};

export function createEmptyTaskFormState() {
  return {
    title: "",
    description: "",
    priority: "medium",
  };
}

export function buildTaskFormRows(formState = {}, activeField = "title") {
  return TASK_FORM_FIELDS.map((field) => {
    const value = String(formState?.[field] || "");
    const fallbackValue = TASK_FORM_PLACEHOLDERS[field] || "";
    const displayValue = value || fallbackValue;
    return {
      field,
      label: TASK_FORM_LABELS[field] || field,
      value,
      displayValue,
      isActive: field === activeField,
      isPlaceholder: !value,
      inputPlaceholder: field === "priority" ? "critical, high, medium, low" : undefined,
    };
  });
}

export function formatTask(task) {
  const id = String(task?.id || "").slice(0, 8) || "--------";
  const title = String(task?.title || "Untitled");
  const priority = String(task?.priority || "").trim().toLowerCase();
  const priorityBadge = priority ? `[${priority[0]}] ` : "";
  return `${id}  ${priorityBadge}${title}`;
}

export function bucketTasksByStatus(tasks) {
  const buckets = new Map(TASK_COLUMNS.map((column) => [column, []]));
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const status = String(task?.status || "todo").toLowerCase();
    if (!buckets.has(status)) buckets.set(status, []);
    buckets.get(status).push(task);
  }
  return buckets;
}

export function normalizeTaskCreatePayload(formState = {}) {
  const title = String(formState.title || "").trim();
  if (!title) {
    return { ok: false, error: "Title is required." };
  }

  const description = String(formState.description || "").trim();
  const rawPriority = String(formState.priority || "medium").trim().toLowerCase();
  const priority = TASK_PRIORITY_OPTIONS.includes(rawPriority) ? rawPriority : "medium";

  return {
    ok: true,
    payload: {
      title,
      ...(description ? { description } : {}),
      priority,
    },
  };
}