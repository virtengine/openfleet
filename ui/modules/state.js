/* ─────────────────────────────────────────────────────────────
 *  VirtEngine Control Center – Reactive State Layer
 *  All signals, data loaders, toast system, and tab refresh logic
 * ────────────────────────────────────────────────────────────── */

import { signal } from "@preact/signals";
import { apiFetch, onWsMessage } from "./api.js";
import { cloneValue } from "./utils.js";
import { generateId } from "./utils.js";

/* ═══════════════════════════════════════════════════════════════
 *  CLOUD STORAGE HELPER — mirrors settings.js pattern
 * ═══════════════════════════════════════════════════════════════ */

/** @param {string} key @returns {Promise<any>} */
function _cloudGet(key) {
  return new Promise((resolve) => {
    const tg = globalThis.Telegram?.WebApp;
    if (tg?.CloudStorage) {
      tg.CloudStorage.getItem(key, (err, val) => {
        if (err || val == null) resolve(null);
        else {
          try { resolve(JSON.parse(val)); }
          catch { resolve(val); }
        }
      });
    } else {
      try {
        const v = localStorage.getItem("ve_settings_" + key);
        resolve(v != null ? JSON.parse(v) : null);
      } catch { resolve(null); }
    }
  });
}

/* ═══════════════════════════════════════════════════════════════
 *  API RESPONSE CACHE — stale-while-revalidate
 * ═══════════════════════════════════════════════════════════════ */

const _apiCache = new Map();
const CACHE_TTL = {
  status: 5000, executor: 5000, tasks: 10000, agents: 5000,
  threads: 5000, logs: 15000, worktrees: 30000, workspaces: 30000,
  presence: 30000, config: 60000, projects: 60000, git: 20000,
  infra: 30000,
};

function _cacheKey(url) { return url; }
function _cacheGet(url) { return _apiCache.get(url) || null; }
function _cacheSet(url, data) { _apiCache.set(url, { data, fetchedAt: Date.now() }); }
function _cacheFresh(url, group) {
  const e = _apiCache.get(url);
  return e ? (Date.now() - e.fetchedAt) < (CACHE_TTL[group] || 10000) : false;
}
function _cacheClearGroup(group) {
  for (const k of _apiCache.keys()) {
    if (k.includes(group) || group === '*') _apiCache.delete(k);
  }
}

/** Tracks last-fetch timestamps per data group for "Updated Xs ago" UI. */
export const dataFreshness = signal({});
function _markFresh(group) {
  dataFreshness.value = { ...dataFreshness.value, [group]: Date.now() };
}

/* ═══════════════════════════════════════════════════════════════
 *  SIGNALS — Single source of truth for UI state
 * ═══════════════════════════════════════════════════════════════ */

// ── Overall connectivity
export const connected = signal(false);

// ── Dashboard
export const statusData = signal(null);
export const executorData = signal(null);
export const projectSummary = signal(null);

// ── Tasks
export const tasksLoaded = signal(false);
export const tasksData = signal([]);
export const tasksPage = signal(0);
export const tasksPageSize = signal(20);
export const tasksFilter = signal("all");
export const tasksPriority = signal("all");
export const tasksSearch = signal("");
export const tasksSort = signal("updated");
export const tasksTotalPages = signal(1);

// ── Agents
export const agentsData = signal([]);
export const agentWorkspaceTarget = signal(null);

// ── Infra
export const worktreeData = signal([]);
export const sharedWorkspaces = signal([]);
export const presenceInstances = signal([]);
export const coordinatorInfo = signal(null);
export const infraData = signal(null);

// ── Logs
export const logsData = signal(null);
export const logsLines = signal(100);
export const gitDiff = signal(null);
export const gitBranches = signal([]);
export const agentLogFiles = signal([]);
export const agentLogFile = signal("");
export const agentLogTail = signal(null);
export const agentLogLines = signal(200);
export const agentLogQuery = signal("");
export const agentContext = signal(null);

// ── Config (routing, regions, etc.)
export const configData = signal(null);

// ── Toasts
export const toasts = signal([]);

// ── Notification Preferences (loaded from CloudStorage)
export const notificationPrefs = signal({
  notifyUpdates: true,
  notifyErrors: true,
  notifyCompletion: true,
});

/* ═══════════════════════════════════════════════════════════════
 *  NOTIFICATION PREFERENCES
 * ═══════════════════════════════════════════════════════════════ */

/** Load notification preferences from CloudStorage into signal */
export async function loadNotificationPrefs() {
  const [nu, ne, nc] = await Promise.all([
    _cloudGet("notifyUpdates"),
    _cloudGet("notifyErrors"),
    _cloudGet("notifyCompletion"),
  ]);
  notificationPrefs.value = {
    notifyUpdates: nu != null ? nu : true,
    notifyErrors: ne != null ? ne : true,
    notifyCompletion: nc != null ? nc : true,
  };
}

/** Critical message patterns that always show regardless of prefs */
const CRITICAL_PATTERNS = /\b(connection\s*lost|auth\s*(fail|error)|authentication\s*(fail|error)|unauthorized)\b/i;

/**
 * Determine if a toast should be rendered based on notification prefs.
 * Filtering happens at render time so toasts are still logged even if hidden.
 * @param {{ id: string, message: string, type: string }} toast
 * @returns {boolean}
 */
export function shouldShowToast(toast) {
  if (CRITICAL_PATTERNS.test(toast.message)) return true;

  const prefs = notificationPrefs.value;

  if (!prefs.notifyUpdates && (toast.type === "info" || toast.type === "success")) {
    return false;
  }
  if (!prefs.notifyErrors && toast.type === "error") {
    return false;
  }
  if (!prefs.notifyCompletion && /\b(complete[ds]?|done)\b/i.test(toast.message)) {
    return false;
  }

  return true;
}

/* ═══════════════════════════════════════════════════════════════
 *  EXECUTOR DEFAULTS — apply stored settings on first load
 * ═══════════════════════════════════════════════════════════════ */

let _defaultsApplied = false;

/**
 * Read stored executor defaults from CloudStorage and POST them to
 * the server if they differ from the current config.
 * Only runs once per app lifecycle (not on tab switches).
 */
export async function applyStoredDefaults() {
  if (_defaultsApplied) return;
  _defaultsApplied = true;

  const [maxP, sdk, region] = await Promise.all([
    _cloudGet("defaultMaxParallel"),
    _cloudGet("defaultSdk"),
    _cloudGet("defaultRegion"),
  ]);

  const promises = [];

  if (maxP != null) {
    const current = executorData.value;
    const currentMax =
      current?.data?.maxParallel ??
      current?.maxParallel ??
      null;
    const isPaused = Boolean(current?.paused || current?.data?.paused);
    if (!isPaused && currentMax !== maxP) {
      promises.push(
        apiFetch("/api/executor/maxparallel", {
          method: "POST",
          body: JSON.stringify({ maxParallel: maxP }),
          _silent: true,
        }).catch(() => {}),
      );
    }
  }

  const configUpdates = {};
  if (sdk && sdk !== "auto") configUpdates.sdk = sdk;
  if (region && region !== "auto") configUpdates.region = region;

  if (Object.keys(configUpdates).length) {
    promises.push(
      apiFetch("/api/config/update", {
        method: "POST",
        body: JSON.stringify(configUpdates),
        _silent: true,
      }).catch(() => {}),
    );
  }

  if (promises.length) await Promise.all(promises);
}

/* ═══════════════════════════════════════════════════════════════
 *  TOAST SYSTEM
 * ═══════════════════════════════════════════════════════════════ */

/**
 * Show a toast notification that auto-dismisses after 3 s.
 * @param {string} message
 * @param {'info'|'success'|'error'|'warning'} type
 */
export function showToast(message, type = "info") {
  const id = generateId();
  toasts.value = [...toasts.value, { id, message, type }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3000);
}

// Listen for api-error events dispatched by the api module
if (typeof globalThis !== "undefined") {
  try {
    globalThis.addEventListener("ve:api-error", (e) => {
      showToast(e.detail?.message || "Request failed", "error");
    });
  } catch {
    /* SSR guard */
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  DATA LOADERS — each calls apiFetch and updates its signal(s)
 * ═══════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════
 *  DASHBOARD HISTORY — localStorage-backed trend tracking
 * ═══════════════════════════════════════════════════════════════ */

const HISTORY_KEY = "ve-dashboard-history";
const HISTORY_MAX = 50;
const HISTORY_MIN_INTERVAL_MS = 30_000;

/** Read stored history from localStorage. */
export function getDashboardHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Compute trend delta between latest and previous snapshot for a metric.
 * Returns 0 when insufficient history.
 * @param {string} metric - one of: total, running, done, errors, successRate
 * @returns {number}
 */
export function getTrend(metric) {
  const hist = getDashboardHistory();
  if (hist.length < 2) return 0;
  const latest = hist[hist.length - 1];
  const prev = hist[hist.length - 2];
  return (latest[metric] ?? 0) - (prev[metric] ?? 0);
}

/** Save a dashboard snapshot after a successful status load. */
function _saveDashboardSnapshot() {
  try {
    const s = statusData.value;
    if (!s) return;
    const counts = s.counts || {};
    const running = Number(counts.running || counts.inprogress || 0);
    const review = Number(counts.review || counts.inreview || 0);
    const blocked = Number(counts.error || 0);
    const done = Number(counts.done || 0);
    const backlog = Number(s.backlog_remaining || counts.todo || 0);
    const total = running + review + blocked + backlog + done;
    const successRate = total > 0 ? +((done / total) * 100).toFixed(1) : 0;

    const snap = { ts: Date.now(), total, running, done, errors: blocked, successRate };

    const hist = getDashboardHistory();

    // Deduplicate: skip if too recent and values unchanged
    if (hist.length > 0) {
      const last = hist[hist.length - 1];
      const elapsed = snap.ts - (last.ts || 0);
      const same =
        last.total === snap.total &&
        last.running === snap.running &&
        last.done === snap.done &&
        last.errors === snap.errors;
      if (elapsed < HISTORY_MIN_INTERVAL_MS && same) return;
    }

    hist.push(snap);
    // Trim to max length
    while (hist.length > HISTORY_MAX) hist.shift();

    localStorage.setItem(HISTORY_KEY, JSON.stringify(hist));
  } catch {
    /* localStorage may be unavailable */
  }
}

/** Load system status → statusData */
export async function loadStatus() {
  const url = "/api/status";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "status")) return;
  if (cached) { statusData.value = cached.data; connected.value = true; }
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: null,
  }));
  statusData.value = res.data ?? res ?? null;
  connected.value = true;
  _cacheSet(url, statusData.value);
  _markFresh("status");
  _saveDashboardSnapshot();
}

/** Load executor state → executorData */
export async function loadExecutor() {
  const url = "/api/executor";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "executor")) return;
  if (cached) executorData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: null,
  }));
  executorData.value = res ?? null;
  _cacheSet(url, executorData.value);
  _markFresh("executor");
}

/** Load tasks with current filter/page/sort → tasksData + tasksTotalPages */
export async function loadTasks() {
  const params = new URLSearchParams({
    page: String(tasksPage.value),
    pageSize: String(tasksPageSize.value),
  });
  if (tasksFilter.value && tasksFilter.value !== "all")
    params.set("status", tasksFilter.value);
  if (tasksPriority.value && tasksPriority.value !== "all")
    params.set("priority", tasksPriority.value);
  if (tasksSearch.value) params.set("search", tasksSearch.value);
  if (tasksSort.value) params.set("sort", tasksSort.value);

  const res = await apiFetch(`/api/tasks?${params}`, { _silent: true }).catch(
    () => ({
      data: [],
      total: 0,
      totalPages: 1,
    }),
  );
  tasksData.value = res.data || [];
  tasksTotalPages.value =
    res.totalPages ||
    Math.max(1, Math.ceil((res.total || 0) / tasksPageSize.value));
  tasksLoaded.value = true;
  _cacheSet(`/api/tasks?${params}`, { data: tasksData.value, totalPages: tasksTotalPages.value });
  _markFresh("tasks");
}

/** Load active agents → agentsData */
export async function loadAgents() {
  const url = "/api/agents";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "agents")) return;
  if (cached) agentsData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: [],
  }));
  agentsData.value = res.data || [];
  _cacheSet(url, agentsData.value);
  _markFresh("agents");
}

/** Load worktrees → worktreeData */
export async function loadWorktrees() {
  const url = "/api/worktrees";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "worktrees")) return;
  if (cached) worktreeData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: [],
    stats: null,
  }));
  worktreeData.value = res.data || [];
  _cacheSet(url, worktreeData.value);
  _markFresh("worktrees");
}

/** Load infrastructure overview → infraData */
export async function loadInfra() {
  const url = "/api/infra";
  const cached = _cacheGet(url);
  if (_cacheFresh(url, "infra")) return;
  if (cached) infraData.value = cached.data;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: null,
  }));
  infraData.value = res.data ?? res ?? null;
  _cacheSet(url, infraData.value);
  _markFresh("infra");
}

/** Load system logs → logsData */
export async function loadLogs() {
  const url = `/api/logs?lines=${logsLines.value}`;
  if (_cacheFresh(url, "logs")) return;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({ data: null }));
  logsData.value = res.data ?? res ?? null;
  _cacheSet(url, logsData.value);
  _markFresh("logs");
}

/** Load git branches + diff → gitBranches, gitDiff */
export async function loadGit() {
  const [branches, diff] = await Promise.all([
    apiFetch("/api/git/branches", { _silent: true }).catch(() => ({
      data: [],
    })),
    apiFetch("/api/git/diff", { _silent: true }).catch(() => ({ data: "" })),
  ]);
  gitBranches.value = branches.data || [];
  gitDiff.value = diff.data || "";
}

/** Load agent log file list → agentLogFiles */
export async function loadAgentLogFileList() {
  const params = new URLSearchParams();
  if (agentLogQuery.value) params.set("query", agentLogQuery.value);
  const path = params.toString()
    ? `/api/agent-logs?${params}`
    : "/api/agent-logs";
  const res = await apiFetch(path, { _silent: true }).catch(() => ({
    data: [],
  }));
  agentLogFiles.value = res.data || [];
}

/** Load tail of the currently selected agent log → agentLogTail */
export async function loadAgentLogTailData() {
  if (!agentLogFile.value) {
    agentLogTail.value = null;
    return;
  }
  const params = new URLSearchParams({
    file: agentLogFile.value,
    lines: String(agentLogLines.value),
  });
  const res = await apiFetch(`/api/agent-logs/tail?${params}`, {
    _silent: true,
  }).catch(() => ({ data: null }));
  agentLogTail.value = res.data ?? res ?? null;
}

/**
 * Load worktree context for a branch/query → agentContext
 * @param {string} query
 */
export async function loadAgentContextData(query) {
  if (!query) {
    agentContext.value = null;
    return;
  }
  const res = await apiFetch(
    `/api/agent-context?query=${encodeURIComponent(query)}`,
    { _silent: true },
  ).catch(() => ({ data: null }));
  agentContext.value = res.data ?? res ?? null;
}

/** Load shared workspaces → sharedWorkspaces */
export async function loadSharedWorkspaces() {
  const url = "/api/shared-workspaces";
  if (_cacheFresh(url, "workspaces")) return;
  const res = await apiFetch(url, { _silent: true }).catch(
    () => ({
      data: [],
    }),
  );
  sharedWorkspaces.value = res.data || res.workspaces || [];
  _cacheSet(url, sharedWorkspaces.value);
  _markFresh("workspaces");
}

/** Load presence / coordinator → presenceInstances, coordinatorInfo */
export async function loadPresence() {
  const url = "/api/presence";
  if (_cacheFresh(url, "presence")) return;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    data: null,
  }));
  const data = res.data || res || {};
  presenceInstances.value = data.instances || [];
  coordinatorInfo.value = data.coordinator || null;
  _cacheSet(url, data);
  _markFresh("presence");
}

/** Load project summary → projectSummary */
export async function loadProjectSummary() {
  const url = "/api/project-summary";
  if (_cacheFresh(url, "projects")) return;
  const res = await apiFetch(url, { _silent: true }).catch(
    () => ({
      data: null,
    }),
  );
  projectSummary.value = res.data ?? res ?? null;
  _cacheSet(url, projectSummary.value);
  _markFresh("projects");
}

/** Load config (routing, regions, etc.) → configData */
export async function loadConfig() {
  const url = "/api/config";
  if (_cacheFresh(url, "config")) return;
  const res = await apiFetch(url, { _silent: true }).catch(() => ({
    ok: false,
  }));
  configData.value = res?.ok ? res : null;
  _cacheSet(url, configData.value);
  _markFresh("config");
}

/* ═══════════════════════════════════════════════════════════════
 *  TAB REFRESH — map tab names to their required loaders
 * ═══════════════════════════════════════════════════════════════ */

const TAB_LOADERS = {
  dashboard: () =>
    Promise.all([loadStatus(), loadExecutor(), loadProjectSummary()]),
  tasks: () => loadTasks(),
  agents: () => Promise.all([loadAgents(), loadExecutor(), import("../components/session-list.js").then((m) => m.loadSessions()).catch(() => {})]),
  infra: () =>
    Promise.all([
      loadWorktrees(),
      loadInfra(),
      loadSharedWorkspaces(),
      loadPresence(),
    ]),
  control: () => Promise.all([loadExecutor(), loadConfig()]),
  logs: () =>
    Promise.all([loadLogs(), loadAgentLogFileList(), loadAgentLogTailData()]),
  settings: () => Promise.all([loadStatus(), loadConfig()]),
};

/**
 * Refresh all data for a given tab.
 * @param {string} tabName
 * @param {{ force?: boolean }} [opts]
 */
export async function refreshTab(tabName, opts = {}) {
  if (opts.force) _apiCache.clear();
  const loader = TAB_LOADERS[tabName];
  if (loader) {
    try {
      await loader();
    } catch {
      /* errors handled by individual loaders */
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  HELPERS
 * ═══════════════════════════════════════════════════════════════ */

/**
 * Optimistic update pattern:
 * 1. Apply the optimistic change immediately
 * 2. Run the async fetch
 * 3. On error, revert via rollback
 *
 * @param {() => void} applyFn   – mutate signals optimistically
 * @param {() => Promise<any>} fetchFn  – the actual API call
 * @param {() => void} revertFn  – undo the optimistic change on error
 * @returns {Promise<any>}
 */
export async function runOptimistic(applyFn, fetchFn, revertFn) {
  try {
    applyFn();
    return await fetchFn();
  } catch (err) {
    if (typeof revertFn === "function") revertFn();
    throw err;
  }
}

/** @type {ReturnType<typeof setTimeout>|null} */
let _scheduleTimer = null;

/**
 * Schedule a tab refresh after a short delay (debounced).
 * Uses the the current activeTab from the router layer via import.
 * Falls back to refreshing 'dashboard'.
 *
 * @param {number} ms
 */
export function scheduleRefresh(ms = 5000) {
  if (_scheduleTimer) clearTimeout(_scheduleTimer);
  _scheduleTimer = setTimeout(async () => {
    _scheduleTimer = null;
    // Dynamic import to avoid circular dependency at module load time
    try {
      const { activeTab } = await import("./router.js");
      await refreshTab(activeTab.value);
    } catch {
      await refreshTab("dashboard");
    }
  }, ms);
}

/* ─── WebSocket invalidation listener ─── */

const WS_CHANNEL_MAP = {
  dashboard: ["overview", "executor", "tasks", "agents"],
  tasks: ["tasks"],
  agents: ["agents", "executor"],
  infra: ["worktrees", "workspaces", "presence"],
  control: ["executor", "overview"],
  logs: ["*"],
  settings: ["overview"],
};

/** Start listening for WS invalidation messages and auto-refreshing. */
export function initWsInvalidationListener() {
  onWsMessage((msg) => {
    if (msg?.type !== "invalidate") return;
    const channels = Array.isArray(msg.channels) ? msg.channels : [];
    // Clear cache for invalidated channels so next fetch is fresh
    channels.forEach((ch) => _cacheClearGroup(ch));

    // Determine interested channels based on active tab
    import("./router.js")
      .then(({ activeTab }) => {
        const interested = WS_CHANNEL_MAP[activeTab.value] || ["*"];
        if (
          channels.includes("*") ||
          channels.some((c) => interested.includes(c))
        ) {
          scheduleRefresh(150);
        }
      })
      .catch(() => {
        /* noop */
      });
  });
}
