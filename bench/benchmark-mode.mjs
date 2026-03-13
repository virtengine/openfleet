import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const DEFAULT_MODE_STATE = Object.freeze({
  enabled: false,
  providerId: "",
  workspaceId: "",
  workspaceDir: "",
  scopePaths: [],
  requiredTagsAll: [],
  requiredTagsAny: [],
  pauseOtherAgents: false,
  holdActiveNonBenchmarkTasks: false,
  maxParallel: null,
  previousMaxParallel: null,
  repoRoot: "",
  createdAt: null,
  updatedAt: null,
});

function normalizeProviderId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return resolve(text);
  } catch {
    return text;
  }
}

function normalizeComparablePath(value) {
  const resolved = normalizePath(value);
  if (!resolved) return "";
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function toStringArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function normalizeTagList(value) {
  const normalized = [];
  for (const entry of toStringArray(value)) {
    const tag = String(entry || "").trim().toLowerCase();
    if (!tag || normalized.includes(tag)) continue;
    normalized.push(tag);
  }
  return normalized;
}

function normalizeOptionalInt(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(20, Math.trunc(numeric)));
}

function normalizeScopePaths(value, workspaceDir = "") {
  const paths = [];
  const push = (candidate) => {
    const normalized = normalizePath(candidate);
    if (!normalized) return;
    const key = normalizeComparablePath(normalized);
    if (paths.some((entry) => normalizeComparablePath(entry) === key)) return;
    paths.push(normalized);
  };
  for (const entry of toStringArray(value)) push(entry);
  if (workspaceDir) push(workspaceDir);
  return paths;
}

function collectTaskTags(task) {
  const tags = normalizeTagList(task?.tags);
  const metaTags = normalizeTagList(task?.meta?.tags);
  const benchmarkType = normalizeProviderId(
    task?.meta?.benchmark?.type
      || task?.meta?.benchmark?.provider
      || task?.meta?.benchmarkType
      || task?.meta?.provider
      || (task?.meta?.swebench ? "swebench" : ""),
  );
  const collected = [...tags, ...metaTags];
  const push = (tag) => {
    const normalized = String(tag || "").trim().toLowerCase();
    if (!normalized || collected.includes(normalized)) return;
    collected.push(normalized);
  };
  if (benchmarkType) {
    push("benchmark");
    push(benchmarkType);
    push(`benchmark:${benchmarkType}`);
  }
  return collected;
}

function resolveTaskWorkspace(task) {
  return normalizePath(
    task?.workspace
      || task?.workspacePath
      || task?.meta?.workspace
      || task?.metadata?.workspace
      || "",
  );
}

function normalizeLifecycleStatus(status) {
  const raw = String(status || "").trim().toLowerCase();
  if (!raw) return "todo";
  if (raw === "in-progress" || raw === "running" || raw === "active") return "inprogress";
  if (raw === "in-review" || raw === "review") return "inreview";
  if (raw === "completed" || raw === "merged" || raw === "closed") return "done";
  if (raw === "canceled") return "cancelled";
  return raw;
}

export function resolveBenchmarkModePath(repoRoot = "") {
  const root = normalizePath(repoRoot || process.cwd());
  return resolve(root, ".bosun", ".cache", "benchmark-mode.json");
}

export function normalizeBenchmarkModeState(rawState = {}, options = {}) {
  const repoRoot = normalizePath(options.repoRoot || rawState?.repoRoot || process.cwd());
  const workspaceDir = normalizePath(rawState?.workspaceDir || options.workspaceDir || "");
  const nowIso = new Date().toISOString();
  const createdAt = String(rawState?.createdAt || "").trim() || null;
  const updatedAt = String(rawState?.updatedAt || "").trim() || nowIso;
  const state = {
    ...DEFAULT_MODE_STATE,
    enabled: Boolean(rawState?.enabled),
    providerId: normalizeProviderId(
      rawState?.providerId || rawState?.typeId || rawState?.type || rawState?.provider,
    ),
    workspaceId: String(rawState?.workspaceId || "").trim(),
    workspaceDir,
    scopePaths: normalizeScopePaths(rawState?.scopePaths || rawState?.workspacePaths || [], workspaceDir),
    requiredTagsAll: normalizeTagList(rawState?.requiredTagsAll || rawState?.tagsAll),
    requiredTagsAny: normalizeTagList(rawState?.requiredTagsAny || rawState?.tagsAny),
    pauseOtherAgents: Boolean(rawState?.pauseOtherAgents),
    holdActiveNonBenchmarkTasks: Boolean(rawState?.holdActiveNonBenchmarkTasks),
    maxParallel: normalizeOptionalInt(rawState?.maxParallel),
    previousMaxParallel: normalizeOptionalInt(rawState?.previousMaxParallel),
    repoRoot,
    createdAt: createdAt || (rawState?.enabled ? nowIso : null),
    updatedAt,
  };
  if (!state.enabled) {
    return {
      ...state,
      enabled: false,
      createdAt,
    };
  }
  return state;
}

export function readBenchmarkModeState(repoRoot = "") {
  const modePath = resolveBenchmarkModePath(repoRoot);
  if (!existsSync(modePath)) {
    return normalizeBenchmarkModeState({ enabled: false }, { repoRoot });
  }
  try {
    const raw = JSON.parse(readFileSync(modePath, "utf8"));
    return normalizeBenchmarkModeState(raw, { repoRoot });
  } catch {
    return normalizeBenchmarkModeState({ enabled: false }, { repoRoot });
  }
}

export function writeBenchmarkModeState(repoRoot = "", nextState = {}) {
  const modePath = resolveBenchmarkModePath(repoRoot);
  const normalized = normalizeBenchmarkModeState(nextState, { repoRoot });
  mkdirSync(dirname(modePath), { recursive: true });
  writeFileSync(modePath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

export function clearBenchmarkModeState(repoRoot = "") {
  const modePath = resolveBenchmarkModePath(repoRoot);
  if (existsSync(modePath)) {
    rmSync(modePath, { force: true });
  }
  return normalizeBenchmarkModeState({ enabled: false }, { repoRoot });
}

export function taskMatchesBenchmarkMode(task, modeState, options = {}) {
  const mode = normalizeBenchmarkModeState(modeState, {
    repoRoot: modeState?.repoRoot || options.repoRoot || process.cwd(),
  });
  if (!mode.enabled) return options.matchWhenDisabled !== false;
  if (!task || typeof task !== "object") return false;

  if (mode.scopePaths.length > 0) {
    const taskWorkspace = resolveTaskWorkspace(task);
    if (!taskWorkspace) return false;
    const taskWorkspaceKey = normalizeComparablePath(taskWorkspace);
    const matchesScope = mode.scopePaths.some(
      (scopePath) => normalizeComparablePath(scopePath) === taskWorkspaceKey,
    );
    if (!matchesScope) return false;
  }

  const taskTags = collectTaskTags(task);
  if (
    mode.requiredTagsAll.length > 0
    && !mode.requiredTagsAll.every((tag) => taskTags.includes(tag))
  ) {
    return false;
  }
  if (
    mode.requiredTagsAny.length > 0
    && !mode.requiredTagsAny.some((tag) => taskTags.includes(tag))
  ) {
    return false;
  }
  return true;
}

export function filterTasksForBenchmarkMode(tasks = [], modeState, options = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) return [];
  return tasks.filter((task) => taskMatchesBenchmarkMode(task, modeState, options));
}

export function summarizeBenchmarkTasks(tasks = [], modeState, options = {}) {
  const matching = filterTasksForBenchmarkMode(tasks, modeState, options);
  const summary = {
    total: matching.length,
    todo: 0,
    inprogress: 0,
    inreview: 0,
    done: 0,
    blocked: 0,
    cancelled: 0,
    other: 0,
  };
  for (const task of matching) {
    const status = normalizeLifecycleStatus(task?.status);
    if (Object.prototype.hasOwnProperty.call(summary, status)) {
      summary[status] += 1;
    } else {
      summary.other += 1;
    }
  }
  return summary;
}

export function collectBenchmarkTaskTags(task) {
  return collectTaskTags(task);
}
