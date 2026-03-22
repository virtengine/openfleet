import { execSync, spawn, spawnSync } from "node:child_process";
import * as nodeCrypto from "node:crypto";
import { existsSync, mkdirSync, readFileSync, chmodSync, createWriteStream, createReadStream, writeFileSync, unlinkSync, watchFile, unwatchFile, readdirSync, statSync } from "node:fs";
import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { get as httpsGet } from "node:https";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces, homedir, userInfo as getOsUserInfo } from "node:os";
import { connect as netConnect } from "node:net";
import { resolve, extname, dirname, basename, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { arch as osArch, platform as osPlatform } from "node:os";
import Ajv2020 from "ajv/dist/2020.js";

const {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
  X509Certificate,
  argon2: nodeArgon2,
} = nodeCrypto;
const argon2 = typeof nodeArgon2 === "function" ? nodeArgon2 : null;

function getLocalLanIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}
import { WebSocketServer } from "ws";
import {
  getKanbanAdapter,
  getKanbanBackendName,
  setKanbanBackend,
  markTaskIgnored,
  unmarkTaskIgnored,
} from "../kanban/kanban-adapter.mjs";

import {
  getActiveThreads,
  launchEphemeralThread,
  launchOrResumeThread,
  execWithRetry,
  invalidateThread,
} from "../agent/agent-pool.mjs";
import { withTaskLifetimeTotals } from "../infra/runtime-accumulator.mjs";
import { resolveAgentPrompts } from "../agent/agent-prompts.mjs";
import {
  listActiveWorktrees,
  getWorktreeStats,
  pruneStaleWorktrees,
  releaseWorktree,
  releaseWorktreeByBranch,
} from "../workspace/worktree-manager.mjs";
import {
  listEntries,
  getEntry,
  getEntryContent,
  upsertEntry,
  deleteEntry,
  detectScopes,
  initLibrary,
  rebuildManifest,
  matchAgentProfile,
  matchAgentProfiles,
  resolveLibraryPlan,
  listWellKnownAgentSources,
  probeWellKnownAgentSources,
  importAgentProfilesFromRepository,
  scanRepositoryForImport,
  loadManifest,
  getManifestPath,
  scaffoldAgentProfiles,
  getBosunHomeDir,
  syncAutoDiscoveredLibraryEntries,
  resolveAgentProfileLibraryMetadata,
} from "../infra/library-manager.mjs";
import {
  getHookCatalog,
  getCoreHooks,
  getDefaultHooks,
  getHookById,
  getHookCategories,
  getSdkCompatibilityMatrix,
  SDK_CAPABILITIES,
  loadHookState,
  enableHook,
  disableHook,
  initializeHookState,
  getEnabledHookIds,
  getHooksAsLibraryEntries,
} from "../agent/hook-library.mjs";
import {
  listCatalog,
  getCatalogEntry,
  installMcpServer,
  uninstallMcpServer,
  listInstalledMcpServers,
  getInstalledMcpServer,
} from "../workflow/mcp-registry.mjs";
import {
  loadToolConfig,
  saveToolConfig,
  getAgentToolConfig,
  setAgentToolConfig,
  getEffectiveTools,
  listAvailableTools,
  DEFAULT_BUILTIN_TOOLS,
} from "../agent/agent-tool-config.mjs";
import {
  loadSharedWorkspaceRegistry,
  sweepExpiredLeases,
  getSharedAvailabilityMap,
  claimSharedWorkspace,
  releaseSharedWorkspace,
  renewSharedWorkspaceLease,
} from "../workspace/shared-workspace-registry.mjs";
import {
  getAllSharedStates,
  clearIgnoreFlag,
  setIgnoreFlag,
} from "../workspace/shared-state-manager.mjs";
import {
  initPresence,
  listActiveInstances,
  selectCoordinator,
} from "../infra/presence.mjs";
import {
  normalizeWorktreeRecoveryState,
  readWorktreeRecoveryState,
} from "../infra/worktree-recovery-state.mjs";
import {
  loadWorkspaceRegistry,
  getLocalWorkspace,
} from "../workspace/workspace-registry.mjs";
import {
  listWorkspaces as listManagedWorkspaces,
  getWorkspace as getManagedWorkspace,
  getActiveWorkspace as getActiveManagedWorkspace,
  createWorkspace as createManagedWorkspace,
  removeWorkspace as removeManagedWorkspace,
  setActiveWorkspace as setActiveManagedWorkspace,
  addRepoToWorkspace,
  removeRepoFromWorkspace,
  pullWorkspaceRepos,
  initializeWorkspaces,
  mergeDetectedWorkspaces,
  setWorkspaceState,
  getWorkspaceStateSummary,
  setWorkspaceExecutors,
} from "../workspace/workspace-manager.mjs";
import {
  getSessionTracker,
  addSessionEventListener,
} from "../infra/session-tracker.mjs";
import { ensureTestRuntimeSandbox } from "../infra/test-runtime.mjs";
import {
  addSessionAccumulationListener,
  getCompletedSessions,
  getRuntimeStats,
  getTaskLifetimeTotals,
} from "../infra/runtime-accumulator.mjs";
import {
  collectDiffStats,
  getCompactDiffSummary,
  getRecentCommits,
} from "../git/diff-stats.mjs";
import { resolveRepoRoot } from "../config/repo-root.mjs";
import {
  SETTINGS_SCHEMA,
  validateSetting,
} from "../ui/modules/settings-schema.js";
import { loadConfig } from "../config/config.mjs";
import {
  getAvailableAgents,
  getAgentMode,
  setAgentMode,
  execSdkCommand,
  getSdkCommands,
  getPrimaryAgentName,
  getPrimaryAgentSelection,
  switchPrimaryAgent,
  getPrimaryAgentInfo,
} from "../agent/primary-agent.mjs";
import {
  buildBenchmarkModePreset,
  getBenchmarkProvider,
  launchBenchmark,
  listBenchmarkProviders,
  prepareBenchmarkWorkspacePreset,
} from "../bench/benchmark-registry.mjs";
import {
  clearBenchmarkModeState,
  filterTasksForBenchmarkMode,
  readBenchmarkModeState,
  summarizeBenchmarkTasks,
  taskMatchesBenchmarkMode,
  writeBenchmarkModeState,
} from "../bench/benchmark-mode.mjs";
import {
  addTaskAttachment,
  listTaskAttachments,
  mergeTaskAttachments,
} from "../task/task-attachments.mjs";
import { getVisionSessionState } from "../voice/vision-session-state.mjs";

const TASK_STORE_MODULE_PATH = "../task/task-store.mjs";
const TASK_STORE_START_GUARD_EXPORTS = [
  "canStartTask",
  "checkTaskCanStart",
  "evaluateTaskCanStart",
  "getTaskStartGuard",
];
const TASK_STORE_SPRINT_EXPORTS = Object.freeze({
  list: ["listSprints", "getSprints", "listTaskSprints"],
  create: ["createSprint", "upsertSprint", "saveSprint", "setSprint"],
  get: ["getSprint", "readSprint"],
  update: ["updateSprint", "upsertSprint", "saveSprint", "setSprint"],
  remove: ["deleteSprint", "removeSprint"],
});
const TASK_STORE_DAG_EXPORTS = Object.freeze({
  sprint: ["getSprintDag", "getTaskDagForSprint", "buildSprintDag", "buildTaskDag"],
  global: ["getGlobalDagOfDags", "getDagOfDags", "buildGlobalDagOfDags"],
  organize: ["organizeTaskDag"],
});
const TASK_STORE_GET_TASK_EXPORTS = ["getTaskById", "getTask"];
const TASK_STORE_COMMENT_EXPORTS = ["getTaskComments", "listTaskComments"];
const TASK_STORE_DEPENDENCY_EXPORTS = {
  add: ["addTaskDependency"],
  remove: ["removeTaskDependency"],
  update: ["updateTask"],
};
const TASK_STORE_ASSIGN_SPRINT_EXPORTS = ["assignTaskToSprint", "setTaskSprint"];
const TASK_STORE_EPIC_DEPENDENCY_EXPORTS = Object.freeze({
  list: ["getEpicDependencies", "listEpicDependencies"],
  set: ["setEpicDependencies", "updateEpicDependencies"],
  add: ["addEpicDependency"],
  remove: ["removeEpicDependency"],
});
let taskStoreApi = null;
let taskStoreApiPromise = null;
let didLogTaskStoreLoadFailure = false;

function resolveInjectedTaskStoreApi() {
  if (uiDeps?.taskStoreApi && typeof uiDeps.taskStoreApi === "object") {
    return uiDeps.taskStoreApi;
  }
  if (typeof uiDeps?.getTaskStoreApi === "function") {
    try {
      const injected = uiDeps.getTaskStoreApi();
      if (injected && typeof injected === "object") return injected;
    } catch {
      // Ignore injected resolver failures and fall back to default loading.
    }
  }
  return null;
}

async function ensureTaskStoreApi() {
  const injected = resolveInjectedTaskStoreApi();
  if (injected) return injected;
  if (taskStoreApi) return taskStoreApi;
  if (taskStoreApiPromise) return taskStoreApiPromise;
  taskStoreApiPromise = import(TASK_STORE_MODULE_PATH)
    .then((mod) => {
      taskStoreApi = mod;
      return mod;
    })
    .catch((err) => {
      if (!didLogTaskStoreLoadFailure) {
        didLogTaskStoreLoadFailure = true;
        console.warn(`[ui-server] task-store unavailable: ${err?.message || err}`);
      }
      return null;
    })
    .finally(() => {
      taskStoreApiPromise = null;
    });
  return taskStoreApiPromise;
}

function getTaskStoreApiSync() {
  return resolveInjectedTaskStoreApi() || taskStoreApi;
}

function getAllInternalTasks() {
  try {
    const fn = getTaskStoreApiSync()?.getAllTasks;
    return typeof fn === "function" ? fn() : [];
  } catch {
    return [];
  }
}

function appendInternalTaskTimelineEvent(taskId, event = {}) {
  const fn = getTaskStoreApiSync()?.appendTaskTimelineEvent;
  if (typeof fn !== "function") return null;
  try {
    return fn(taskId, event);
  } catch {
    return null;
  }
}

function linkInternalTaskWorkflowRun(taskId, workflowRun = {}) {
  const fn = getTaskStoreApiSync()?.linkTaskWorkflowRun;
  if (typeof fn !== "function") return null;
  try {
    return fn(taskId, workflowRun);
  } catch {
    return null;
  }
}

function addInternalTaskComment(taskId, comment = {}) {
  const fn = getTaskStoreApiSync()?.addTaskComment;
  if (typeof fn !== "function") return null;
  try {
    return fn(taskId, comment);
  } catch {
    return null;
  }
}

function unblockInternalTask(taskId, options = {}) {
  const fn = getTaskStoreApiSync()?.unblockTask;
  if (typeof fn !== "function") return null;
  try {
    return fn(taskId, options);
  } catch {
    return null;
  }
}

function resetExecutorTaskThrottleState(taskId, options = {}) {
  const executor = uiDeps.getInternalExecutor?.() || null;
  const fn = executor?.resetTaskThrottleState;
  if (typeof fn !== "function") return false;
  try {
    return fn.call(executor, taskId, options) === true;
  } catch {
    return false;
  }
}

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolveRepoRoot();
const uiRootPreferred = resolve(__dirname, "..", "ui");
const uiRootFallback = resolve(__dirname, "..", "site", "ui");
const uiRoot = existsSync(uiRootPreferred) ? uiRootPreferred : uiRootFallback;
const sharedLibRoot = resolve(__dirname, "..", "lib");
const libraryInitAttemptedRoots = new Set();
const MAX_VISION_FRAME_BYTES = Math.max(
  128_000,
  Number.parseInt(process.env.VISION_FRAME_MAX_BYTES || "", 10) || 2_000_000,
);
const DEFAULT_VISION_ANALYSIS_INTERVAL_MS = Math.min(
  30_000,
  Math.max(
    500,
    Number.parseInt(process.env.VISION_ANALYSIS_INTERVAL_MS || "", 10) || 1500,
  ),
);
const VOICE_TRACE_MAX_EVENTS_PER_SESSION = Math.max(
  50,
  Number.parseInt(process.env.BOSUN_VOICE_TRACE_MAX_EVENTS_PER_SESSION || "", 10) || 250,
);
const VOICE_TRACE_MAX_SESSIONS = Math.max(
  10,
  Number.parseInt(process.env.BOSUN_VOICE_TRACE_MAX_SESSIONS || "", 10) || 200,
);
const VOICE_TRACE_MAX_QUERY_LIMIT = 500;
const voiceTraceStore = new Map();
let voiceTraceSequence = 0;

function parseVoiceTraceLimit(rawLimit, fallback = 50) {
  const parsed = Number.parseInt(String(rawLimit || "").trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(VOICE_TRACE_MAX_QUERY_LIMIT, Math.max(1, parsed));
}

function pruneVoiceTraceSessions() {
  while (voiceTraceStore.size > VOICE_TRACE_MAX_SESSIONS) {
    let oldestSessionId = null;
    let oldestUpdatedAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, state] of voiceTraceStore.entries()) {
      const updatedAt = Number(state?.updatedAt || 0);
      if (updatedAt < oldestUpdatedAt) {
        oldestUpdatedAt = updatedAt;
        oldestSessionId = sessionId;
      }
    }
    if (!oldestSessionId) break;
    voiceTraceStore.delete(oldestSessionId);
  }
}

function appendVoiceTraceEvent(rawEvent = {}) {
  const sessionId = String(rawEvent?.sessionId || "").trim();
  const eventType = String(rawEvent?.eventType || rawEvent?.type || "").trim();
  if (!sessionId || !eventType) return null;

  const nowMs = Date.now();
  voiceTraceSequence += 1;
  const traceEvent = {
    id: `${sessionId}:${nowMs}:${randomBytes(4).toString("hex")}`,
    sessionId,
    turnId: String(rawEvent?.turnId || "").trim() || null,
    eventType,
    transport: String(rawEvent?.transport || "").trim() || null,
    provider: String(rawEvent?.provider || "").trim() || null,
    role: String(rawEvent?.role || "").trim() || null,
    source: String(rawEvent?.source || "voice-client").trim() || "voice-client",
    reason: String(rawEvent?.reason || "").trim() || null,
    timestamp: String(rawEvent?.timestamp || "").trim() || new Date(nowMs).toISOString(),
    recordedAt: nowMs,
    sequence: voiceTraceSequence,
    meta: rawEvent?.meta && typeof rawEvent.meta === "object" ? rawEvent.meta : null,
  };

  const existing = voiceTraceStore.get(sessionId) || {
    sessionId,
    updatedAt: 0,
    events: [],
  };
  existing.events.push(traceEvent);
  if (existing.events.length > VOICE_TRACE_MAX_EVENTS_PER_SESSION) {
    existing.events.splice(0, existing.events.length - VOICE_TRACE_MAX_EVENTS_PER_SESSION);
  }
  existing.updatedAt = nowMs;
  voiceTraceStore.set(sessionId, existing);
  pruneVoiceTraceSessions();
  return traceEvent;
}

function queryVoiceTraceEvents({ sessionId = "", limit = 50, latestOnly = false } = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedLimit = parseVoiceTraceLimit(limit, latestOnly ? 1 : 50);

  let events = [];
  if (normalizedSessionId) {
    const state = voiceTraceStore.get(normalizedSessionId);
    events = Array.isArray(state?.events) ? [...state.events] : [];
  } else {
    for (const state of voiceTraceStore.values()) {
      if (!Array.isArray(state?.events)) continue;
      events.push(...state.events);
    }
  }

  events.sort((a, b) => {
    const byRecordedAt = Number(b?.recordedAt || 0) - Number(a?.recordedAt || 0);
    if (byRecordedAt !== 0) return byRecordedAt;
    return Number(b?.sequence || 0) - Number(a?.sequence || 0);
  });
  if (latestOnly) {
    return {
      latest: events[0] || null,
      total: events.length,
    };
  }
  return {
    events: events.slice(0, normalizedLimit),
    total: events.length,
  };
}

function sanitizeVisionSource(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "camera") return "camera";
  if (raw === "screen" || raw === "display") return "screen";
  return "screen";
}

function normalizeVisionInterval(rawValue) {
  const parsed = Number.parseInt(String(rawValue || ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_VISION_ANALYSIS_INTERVAL_MS;
  return Math.min(30_000, Math.max(300, parsed));
}

function parseVisionFrameDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  const match = raw.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) {
    return { ok: false, error: "frameDataUrl must be a base64 image data URL (jpeg/png/webp)" };
  }
  const mimeType = String(match[1] || "").toLowerCase();
  const base64Data = String(match[2] || "");
  const approxBytes = Math.floor((base64Data.length * 3) / 4);
  if (approxBytes <= 0) {
    return { ok: false, error: "frameDataUrl was empty" };
  }
  if (approxBytes > MAX_VISION_FRAME_BYTES) {
    return {
      ok: false,
      statusCode: 413,
      error: `frameDataUrl too large (${approxBytes} bytes > ${MAX_VISION_FRAME_BYTES} bytes limit)`,
    };
  }
  return { ok: true, mimeType, base64Data, approxBytes, raw };
}

function ensureLibraryInitialized(rootDir = repoRoot) {
  const normalizedRoot = normalizeCandidatePath(rootDir) || repoRoot;
  if (libraryInitAttemptedRoots.has(normalizedRoot)) return;
  libraryInitAttemptedRoots.add(normalizedRoot);
  try {
    const manifestPath = getManifestPath(normalizedRoot);
    const manifest = loadManifest(normalizedRoot);
    let rebuilt = false;
    if (!existsSync(manifestPath) || !Array.isArray(manifest?.entries) || manifest.entries.length === 0) {
      const result = initLibrary(normalizedRoot);
      const count = result?.manifest?.entries?.length ?? 0;
      if (count > 0) {
        console.log(`[ui] Library initialized (${count} entries) at ${normalizedRoot}.`);
      }
      rebuilt = true;
    }
    if (!rebuilt) {
      const scaffoldResult = scaffoldAgentProfiles(normalizedRoot);
      if (Array.isArray(scaffoldResult?.written) && scaffoldResult.written.length > 0) {
        rebuildManifest(normalizedRoot);
        rebuilt = true;
      }
    }
    if (!rebuilt) {
      const latestManifest = loadManifest(normalizedRoot);
      if (libraryManifestHasFilesystemDrift(normalizedRoot, latestManifest)) {
        const rebuiltManifest = rebuildManifest(normalizedRoot);
        const count = rebuiltManifest?.entries?.length ?? 0;
        console.log(`[ui] Library manifest auto-synced (${count} entries) at ${normalizedRoot}.`);
      }
    }

    const autoSynced = syncAutoDiscoveredLibraryEntries(normalizedRoot);
    if (Number(autoSynced?.totalUpserted || 0) > 0) {
      console.log(
        `[ui] Library auto-discovered ${autoSynced.totalUpserted} entry(s) ` +
          `(prompts=${autoSynced.promptEntriesUpserted || 0}, mcp=${autoSynced.mcpEntriesUpserted || 0}) at ${normalizedRoot}.`,
      );
    }
  } catch (err) {
    console.warn(`[ui] Library init failed for ${normalizedRoot}: ${err.message}`);
  }
}

const LIBRARY_FILE_LAYOUT = Object.freeze([
  { type: "prompt", dir: ".bosun/agents", ext: ".md" },
  { type: "skill", dir: ".bosun/skills", ext: ".md" },
  { type: "agent", dir: ".bosun/profiles", ext: ".json" },
  { type: "mcp", dir: ".bosun/mcp-servers", ext: ".json" },
]);

function listLibraryFilesByType(rootDir, relDir, ext) {
  const dir = resolve(rootDir, relDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => typeof name === "string" && name.endsWith(ext));
  } catch {
    return [];
  }
}

function libraryManifestHasFilesystemDrift(rootDir, manifest) {
  const entries = Array.isArray(manifest?.entries) ? manifest.entries : [];
  for (const layout of LIBRARY_FILE_LAYOUT) {
    const manifestFiles = new Set(
      entries
        .filter((entry) => entry?.type === layout.type)
        .map((entry) => String(entry?.filename || "").trim())
        .filter(Boolean),
    );
    const diskFiles = listLibraryFilesByType(rootDir, layout.dir, layout.ext);
    if (diskFiles.length !== manifestFiles.size) return true;
    for (const name of diskFiles) {
      if (!manifestFiles.has(name)) return true;
    }
  }
  return false;
}

const LIBRARY_STORAGE_SCOPES = Object.freeze(["repo", "workspace", "global"]);

function normalizeLibraryStorageScope(value, fallback = "repo") {
  const raw = String(value || "").trim().toLowerCase();
  if (LIBRARY_STORAGE_SCOPES.includes(raw)) return raw;
  return fallback;
}

function resolveGlobalLibraryRootDir() {
  const fromLibHome = normalizeCandidatePath(getBosunHomeDir());
  if (fromLibHome) return fromLibHome;
  const fromUiConfig = normalizeCandidatePath(resolveUiConfigDir());
  if (fromUiConfig) return fromUiConfig;
  return repoRoot;
}

function dedupeLibraryRoots(roots = []) {
  const seen = new Set();
  const deduped = [];
  for (const rootInfo of roots) {
    const rootDir = normalizeCandidatePath(rootInfo?.rootDir);
    if (!rootDir || seen.has(rootDir)) continue;
    seen.add(rootDir);
    deduped.push({
      scope: normalizeLibraryStorageScope(rootInfo?.scope, "repo"),
      rootDir,
    });
  }
  return deduped;
}

function resolveLibraryRootsForContext(workspaceContext = null) {
  const repoLibraryRoot = normalizeCandidatePath(workspaceContext?.workspaceDir) || repoRoot;
  const workspaceLibraryRoot = normalizeCandidatePath(workspaceContext?.workspaceRoot);
  const globalLibraryRoot = resolveGlobalLibraryRootDir();
  return dedupeLibraryRoots([
    { scope: "repo", rootDir: repoLibraryRoot },
    { scope: "workspace", rootDir: workspaceLibraryRoot },
    { scope: "global", rootDir: globalLibraryRoot },
  ]);
}

function ensureLibraryRootsInitialized(roots = []) {
  for (const rootInfo of roots) {
    ensureLibraryInitialized(rootInfo.rootDir);
  }
}

function orderLibraryRootsForLookup(roots, preferredScope = "") {
  const normalizedPreferred = normalizeLibraryStorageScope(preferredScope, "");
  if (!normalizedPreferred) return roots;
  const preferred = roots.find((rootInfo) => rootInfo.scope === normalizedPreferred);
  if (!preferred) return roots;
  return [preferred, ...roots.filter((rootInfo) => rootInfo !== preferred)];
}

function listLibraryEntriesAcrossRoots(workspaceContext, filters = {}) {
  const roots = resolveLibraryRootsForContext(workspaceContext);
  ensureLibraryRootsInitialized(roots);
  const seenIds = new Set();
  const entries = [];
  for (const rootInfo of roots) {
    const rootEntries = listEntries(rootInfo.rootDir, filters) || [];
    for (const entry of rootEntries) {
      const id = String(entry?.id || "").trim();
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      entries.push({
        entry,
        rootInfo,
      });
    }
  }
  return { entries, roots };
}

function resolveLibraryEntryAcrossRoots(workspaceContext, id, opts = {}) {
  const normalizedId = String(id || "").trim();
  if (!normalizedId) return null;
  const roots = resolveLibraryRootsForContext(workspaceContext);
  ensureLibraryRootsInitialized(roots);
  const orderedRoots = orderLibraryRootsForLookup(
    roots,
    opts.preferredScope || opts.storageScope || "",
  );
  for (const rootInfo of orderedRoots) {
    const entry = getEntry(rootInfo.rootDir, normalizedId);
    if (!entry) continue;
    return { entry, rootInfo };
  }
  return null;
}

function resolveLibraryTargetRoot(workspaceContext, storageScope = "", existing = null) {
  if (existing?.rootInfo?.rootDir) return existing.rootInfo;
  const roots = resolveLibraryRootsForContext(workspaceContext);
  ensureLibraryRootsInitialized(roots);
  const normalizedScope = normalizeLibraryStorageScope(storageScope, "");
  if (normalizedScope) {
    const matchingRoot = roots.find((rootInfo) => rootInfo.scope === normalizedScope);
    if (matchingRoot) return matchingRoot;
  }
  return roots[0] || { scope: "repo", rootDir: repoRoot };
}

const VOICE_TOOL_ID_MAP = Object.freeze({
  "search-files": ["search_code", "list_directory"],
  "read-file": ["read_file_content"],
  "edit-file": ["delegate_to_agent", "run_workspace_command"],
  "run-command": ["run_command", "run_workspace_command", "bosun_slash_command"],
  "web-search": ["ask_agent_context"],
  "code-search": ["search_code", "get_workspace_context", "warm_codebase_context"],
  "git-operations": ["run_workspace_command", "get_pr_status", "get_workspace_context"],
  "create-task": ["create_task", "list_tasks", "get_task", "update_task_status"],
  "delegate-task": ["delegate_to_agent", "ask_agent_context", "poll_background_session", "set_agent_mode"],
  "fetch-url": ["run_workspace_command"],
  "list-directory": ["list_directory"],
  "grep-search": ["search_code"],
  "task-management": [
    "list_tasks",
    "get_task",
    "create_task",
    "update_task_status",
    "search_tasks",
    "get_task_stats",
    "delete_task",
    "comment_on_task",
    "list_sessions",
    "get_session_history",
  ],
  "notifications": ["dispatch_action", "get_system_status", "get_fleet_status"],
  "vision-analysis": ["query_live_view"],
});

const BUILTIN_TOOL_ID_SET = new Set(
  (Array.isArray(DEFAULT_BUILTIN_TOOLS) ? DEFAULT_BUILTIN_TOOLS : [])
    .map((tool) => String(tool?.id || "").trim())
    .filter(Boolean),
);

function mapToolConfigIdsToVoiceToolNames(enabledIds = []) {
  const resolved = new Set();
  for (const rawId of Array.isArray(enabledIds) ? enabledIds : []) {
    const id = String(rawId || "").trim();
    if (!id) continue;
    const mapped = VOICE_TOOL_ID_MAP[id];
    if (Array.isArray(mapped) && mapped.length > 0) {
      for (const toolName of mapped) resolved.add(String(toolName || "").trim());
      continue;
    }
    // If this is a known built-in tool id without a runtime mapping, skip it
    // instead of treating the id as a voice runtime tool name.
    if (BUILTIN_TOOL_ID_SET.has(id)) {
      continue;
    }
    resolved.add(id);
  }
  return resolved;
}

function isVoiceAgentProfileEntry(entry, profile) {
  if (!entry || entry.type !== "agent") return false;
  const id = String(entry.id || "").trim().toLowerCase();
  const tags = Array.isArray(entry.tags) ? entry.tags.map((t) => String(t || "").trim().toLowerCase()) : [];
  const profileType = String(profile?.agentType || "").trim().toLowerCase();
  if (profileType === "voice") return true;
  if (id.startsWith("voice-agent")) return true;
  if (tags.includes("voice") || tags.includes("audio-agent") || tags.includes("realtime")) return true;
  if (profile && typeof profile === "object" && profile.voiceAgent === true) return true;
  return false;
}

function resolveAgentProfileType(entry, profile) {
  return resolveAgentProfileLibraryMetadata(entry, profile).agentType;
}

function resolveAgentProfileLibraryView(entry, profile, storageScope) {
  const metadata = resolveAgentProfileLibraryMetadata(entry, profile);
  return {
    ...entry,
    storageScope,
    ...metadata,
  };
}

function listManualAgentProfiles(workspaceContext) {
  const resolved = listLibraryEntriesAcrossRoots(workspaceContext, { type: "agent" });
  const profiles = [];
  for (const { entry, rootInfo } of resolved.entries) {
    const profile = getEntryContent(rootInfo.rootDir, entry);
    const metadata = resolveAgentProfileLibraryMetadata(entry, profile);
    if (metadata.agentCategory !== "interactive" || metadata.showInChatDropdown !== true) continue;
    const sectionLabel = metadata.interactiveLabel
      || (metadata.interactiveMode ? metadata.interactiveMode.charAt(0).toUpperCase() + metadata.interactiveMode.slice(1) : "Manual");
    profiles.push({
      id: entry.id,
      name: entry.name || entry.id,
      description: entry.description || "",
      storageScope: rootInfo.scope,
      model: String(profile?.model || "").trim() || null,
      sdk: String(profile?.sdk || "").trim() || null,
      sectionLabel,
      ...metadata,
    });
  }
  profiles.sort((a, b) => {
    const sectionCmp = String(a.sectionLabel || "").localeCompare(String(b.sectionLabel || ""));
    if (sectionCmp !== 0) return sectionCmp;
    return String(a.name || a.id).localeCompare(String(b.name || b.id));
  });
  return profiles;
}

function resolveVoiceLibraryRoot(callContext = {}) {
  const sessionId = String(callContext?.sessionId || "").trim();
  if (!sessionId) return repoRoot;
  try {
    const tracker = getSessionTracker();
    const session = tracker.getSessionById
      ? tracker.getSessionById(sessionId)
      : (tracker.getSession ? tracker.getSession(sessionId) : null);
    const workspaceDir = String(
      session?.workspaceDir
      || session?.metadata?.workspaceDir
      || "",
    ).trim();
    if (workspaceDir) return workspaceDir;
  } catch {
    // best effort
  }
  return repoRoot;
}

function listVoiceAgentProfiles(rootDir = repoRoot) {
  const libraryRoot = rootDir || repoRoot;
  const resolved = listLibraryEntriesAcrossRoots(
    { workspaceDir: libraryRoot, workspaceRoot: libraryRoot },
    { type: "agent" },
  );
  const profiles = [];
  for (const { entry, rootInfo } of resolved.entries) {
    const profile = getEntryContent(rootInfo.rootDir, entry);
    if (!isVoiceAgentProfileEntry(entry, profile)) continue;
    profiles.push({
      id: entry.id,
      name: entry.name || entry.id,
      description: entry.description || "",
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      storageScope: rootInfo.scope,
      model: String(profile?.model || "").trim() || null,
      voicePersona: String(profile?.voicePersona || "").trim() || "neutral",
      voiceInstructions: String(profile?.voiceInstructions || "").trim() || "",
      skills: Array.isArray(profile?.skills) ? profile.skills.map((s) => String(s || "").trim()).filter(Boolean) : [],
      promptOverride: String(profile?.promptOverride || "").trim() || null,
      agentType: resolveAgentProfileType(entry, profile),
    });
  }

  profiles.sort((a, b) => {
    const rank = (id) => {
      if (id === "voice-agent-female") return 0;
      if (id === "voice-agent-male") return 1;
      if (id === "voice-agent") return 2;
      return 3;
    };
    const ra = rank(a.id);
    const rb = rank(b.id);
    if (ra !== rb) return ra - rb;
    return String(a.name || a.id).localeCompare(String(b.name || b.id));
  });
  return profiles;
}

function resolveActiveVoiceAgent(rootDir = repoRoot, requestedAgentId = "") {
  const agents = listVoiceAgentProfiles(rootDir);
  if (agents.length === 0) return { agents: [], selected: null };
  const requested = String(requestedAgentId || "").trim();
  const selected = agents.find((a) => a.id === requested)
    || agents.find((a) => a.id === "voice-agent-female")
    || agents[0];
  return { agents, selected };
}

function applyVoiceAgentToolFilters(allTools, toolConfig = null) {
  const tools = Array.isArray(allTools) ? [...allTools] : [];
  if (!toolConfig || typeof toolConfig !== "object") return tools;

  const disabledBuiltinIds = Array.isArray(toolConfig.disabledBuiltinTools)
    ? toolConfig.disabledBuiltinTools
    : [];
  const enabledIds = Array.isArray(toolConfig.enabledTools) ? toolConfig.enabledTools : null;
  const enabledServers = Array.isArray(toolConfig.enabledMcpServers) ? toolConfig.enabledMcpServers : [];

  const disabledNames = mapToolConfigIdsToVoiceToolNames(disabledBuiltinIds);
  const enabledNames = enabledIds ? mapToolConfigIdsToVoiceToolNames(enabledIds) : null;
  const runtimeNames = new Set(
    tools.map((tool) => String(tool?.name || "").trim()).filter(Boolean),
  );
  const hasRuntimeAllowlist = Boolean(
    enabledIds && enabledIds.some((id) => runtimeNames.has(String(id || "").trim())),
  );

  return tools.filter((tool) => {
    const name = String(tool?.name || "").trim();
    if (!name) return false;
    if (name === "invoke_mcp_tool" && enabledServers.length === 0) return false;
    // Important: only apply strict allowlisting when explicit runtime tool names
    // were selected. Built-in tool ids alone should not hide Bosun JS tools.
    if (enabledNames && enabledNames.size > 0 && hasRuntimeAllowlist) {
      return enabledNames.has(name);
    }
    if (disabledNames.has(name)) return false;
    return true;
  });
}

function buildVoiceToolCapabilityPrompt(tools = [], toolConfig = null, selectedVoiceAgent = null) {
  const runtimeTools = Array.isArray(tools) ? tools : [];
  const enabledServers = Array.isArray(toolConfig?.enabledMcpServers)
    ? toolConfig.enabledMcpServers
    : [];
  const toolLines = runtimeTools
    .slice(0, 48)
    .map((tool) => {
      const name = String(tool?.name || "").trim();
      if (!name) return null;
      const description = String(tool?.description || "").replace(/\s+/g, " ").trim();
      return description ? `- ${name}: ${description}` : `- ${name}`;
    })
    .filter(Boolean);
  const skills = Array.isArray(selectedVoiceAgent?.skills)
    ? selectedVoiceAgent.skills.map((skill) => String(skill || "").trim()).filter(Boolean)
    : [];
  const agentName = String(selectedVoiceAgent?.name || selectedVoiceAgent?.id || "Voice Agent").trim();
  const toolManifest = runtimeTools
    .slice(0, 64)
    .map((tool) => {
      const name = String(tool?.name || "").trim();
      if (!name) return null;
      return {
        name,
        description: String(tool?.description || "").replace(/\s+/g, " ").trim(),
        inputSchema:
          tool?.parameters && typeof tool.parameters === "object"
            ? tool.parameters
            : { type: "object", properties: {} },
      };
    })
    .filter(Boolean);
  const manifestJson = JSON.stringify(toolManifest, null, 2);

  return [
    "",
    "## Active Voice Agent Capability Contract",
    `Agent profile: ${agentName}.`,
    "You have FULL tool-calling capability in this voice session. You MUST use tools when the user asks for information or actions.",
    "IMPORTANT: Do NOT respond conversationally when a tool call would answer the question. Call the tool FIRST, then speak the result.",
    "When the user asks about tasks, status, agents, code, or any operational question — call the relevant tool immediately.",
    toolLines.length > 0
      ? "Available tools (call these by name):\n" + toolLines.join("\n")
      : "Available tools: none (tool calls unavailable for this profile).",
    "Available tools JSON (name + input schema):",
    "```json",
    manifestJson,
    "```",
    enabledServers.length > 0
      ? `Enabled MCP servers (for invoke_mcp_tool): ${enabledServers.join(", ")}.`
      : "Enabled MCP servers: none.",
    skills.length > 0
      ? `Voice agent skills (${skills.length}): ${skills.join(", ")}. Full skill instructions are provided in the Voice Agent Skills section above.`
      : "Voice agent skills: none specified.",
    "",
    "TOOL USAGE RULES:",
    "1. When calling tools, use exact argument keys from the inputSchema JSON above.",
    "2. For questions about tasks, status, projects → call list_tasks or get_task.",
    "3. For code questions or codebase queries → call ask_agent_context with mode=instant.",
    "4. For running commands → call run_workspace_command.",
    "5. For delegating coding work → call delegate_to_agent with a specific message.",
    "6. Never say 'I cannot do that' if a matching tool exists — use it.",
    "7. If you need a complete tool/action reference, call get_admin_help.",
  ].join("\n");
}

async function listBosunRuntimeTools(context = {}) {
  try {
    const { getVoiceToolDefinitions } = await import("../voice/voice-relay.mjs");
    const defs = await getVoiceToolDefinitions({ delegateOnly: false, context });
    return (Array.isArray(defs) ? defs : [])
      .map((tool) => ({
        id: String(tool?.name || "").trim(),
        name: String(tool?.name || "").trim(),
        description: String(tool?.description || "").trim(),
        category: "Bosun",
      }))
      .filter((tool) => Boolean(tool.id))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch {
    return [];
  }
}

const VOICE_SIDE_EFFECT_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "run_workspace_command",
  "invoke_mcp_tool",
  "bosun_slash_command",
  "run_command",
  "dispatch_action",
  "create_task",
  "update_task_status",
  "delete_task",
  "comment_on_task",
  "create_workflow",
  "update_workflow_definition",
  "create_workflow_from_template",
  "generate_workflow_with_agent",
  "execute_workflow",
  "delete_workflow",
  "update_config",
  "switch_agent",
  "set_agent_mode",
  "retry_workflow_run",
  "warm_codebase_context",
]);

const VOICE_SIDE_EFFECT_ALLOWED_MODES = new Set(["agent", "code", "web"]);
const VOICE_POLICY_RATE_LIMIT_WINDOW_MS = 12_000;
const VOICE_POLICY_MAX_CALLS_PER_WINDOW = 18;
const VOICE_POLICY_MAX_SIDE_EFFECT_CALLS_PER_WINDOW = 4;
const VOICE_POLICY_MAX_SESSION_TRACKERS = 500;
const voiceToolPolicyRateCache = new Map();

function isVoiceToolExplicitConfirmation(args = {}) {
  if (!args || typeof args !== "object") return false;
  if (args.confirm === true) return true;
  const confirmation = String(args.confirmation || "").trim();
  if (!confirmation) return false;
  return /\b(yes|confirm|confirmed|confirmation|proceed|proceeding)\b/i.test(confirmation);
}

function detectVoiceToolCatalogPaste(intentText = "") {
  const text = String(intentText || "").trim();
  if (!text) return false;
  const useForCount = (text.match(/use\s+for/gi) || []).length;
  const toolLikeIdentifiers = text.match(/\b[a-z][a-z0-9]*(?:[_-][a-z0-9]+){1,}\b/g) || [];
  const uniqueToolLikeIds = new Set(toolLikeIdentifiers.map((value) => value.toLowerCase()));
  const lineCount = text.split(/\r?\n/).length;
  if (text.length >= 1200 && uniqueToolLikeIds.size >= 12) return true;
  if (useForCount >= 4 && uniqueToolLikeIds.size >= 8) return true;
  if (lineCount >= 24 && uniqueToolLikeIds.size >= 10) return true;
  return false;
}

function extractVoiceIntentText(args = {}) {
  if (!args || typeof args !== "object") return "";
  const candidates = [
    args.intent,
    args.intentText,
    args.prompt,
    args.query,
    args.request,
    args.instruction,
    args.instructions,
    args.text,
    args.message,
    args.description,
    args.task,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function pruneVoicePolicyRateCache() {
  if (voiceToolPolicyRateCache.size <= VOICE_POLICY_MAX_SESSION_TRACKERS) return;
  const entries = Array.from(voiceToolPolicyRateCache.entries())
    .sort((a, b) => Number(a[1]?.updatedAt || 0) - Number(b[1]?.updatedAt || 0));
  const toDelete = voiceToolPolicyRateCache.size - VOICE_POLICY_MAX_SESSION_TRACKERS;
  for (let index = 0; index < toDelete; index += 1) {
    const key = entries[index]?.[0];
    if (!key) continue;
    voiceToolPolicyRateCache.delete(key);
  }
}

function evaluateVoiceToolRateLimit({ sessionKey = "", isSideEffect = false } = {}) {
  const key = String(sessionKey || "").trim() || "anonymous";
  const nowMs = Date.now();
  const existing = voiceToolPolicyRateCache.get(key);
  let state = existing;
  if (!state || (nowMs - Number(state.windowStartedAt || 0)) >= VOICE_POLICY_RATE_LIMIT_WINDOW_MS) {
    state = {
      windowStartedAt: nowMs,
      totalCalls: 0,
      sideEffectCalls: 0,
      updatedAt: nowMs,
    };
  }

  state.totalCalls += 1;
  if (isSideEffect) state.sideEffectCalls += 1;
  state.updatedAt = nowMs;
  voiceToolPolicyRateCache.set(key, state);
  pruneVoicePolicyRateCache();

  if (state.totalCalls > VOICE_POLICY_MAX_CALLS_PER_WINDOW) {
    return {
      allow: false,
      statusCode: 429,
      message: "Voice tool burst limit reached. Please wait a moment before sending more tool calls.",
    };
  }
  if (isSideEffect && state.sideEffectCalls > VOICE_POLICY_MAX_SIDE_EFFECT_CALLS_PER_WINDOW) {
    return {
      allow: false,
      statusCode: 429,
      message: "Voice side-effect tool burst limit reached. Confirm fewer actions per turn.",
    };
  }
  return { allow: true };
}

function evaluateVoiceToolPolicy({
  toolName,
  args,
  context,
  intentText,
  transport,
} = {}) {
  const normalizedToolName = String(toolName || "").trim();
  const normalizedMode = String(context?.mode || "").trim().toLowerCase();
  const isSideEffectTool = VOICE_SIDE_EFFECT_TOOL_NAMES.has(normalizedToolName);
  const keyParts = [
    String(context?.sessionId || "").trim(),
    String(context?.authSource || "").trim(),
    String(context?.executor || "").trim(),
    String(transport || "").trim(),
  ].filter(Boolean);
  const sessionKey = keyParts.join("|") || "anonymous";

  const rateLimitDecision = evaluateVoiceToolRateLimit({
    sessionKey,
    isSideEffect: isSideEffectTool,
  });
  if (!rateLimitDecision.allow) return rateLimitDecision;

  if (!isSideEffectTool) {
    return { allow: true, statusCode: 200, message: "ok" };
  }

  if (!VOICE_SIDE_EFFECT_ALLOWED_MODES.has(normalizedMode)) {
    return {
      allow: false,
      statusCode: 403,
      message: `Tool "${normalizedToolName}" is side-effectful and only allowed in agent/code/web modes.`,
    };
  }

  const normalizedIntentText = String(intentText || "").trim();
  if (detectVoiceToolCatalogPaste(normalizedIntentText)) {
    return {
      allow: false,
      statusCode: 400,
      message: "Side-effect tool execution denied: input looks like pasted tool catalog/spec text. Provide a concise intent and explicit confirmation.",
    };
  }

  if (!isVoiceToolExplicitConfirmation(args || {})) {
    return {
      allow: false,
      statusCode: 400,
      message: `Tool "${normalizedToolName}" requires explicit confirmation (confirm=true or confirmation=\"yes/confirm/proceed\").`,
    };
  }

  return { allow: true, statusCode: 200, message: "ok" };
}

// ── Workflow engine lazy-loader (module-scope cache) ──────────────────────────
let _wfEngine;
let _wfNodes;
let _wfTemplates;
let _wfServicesReady = false;
let _wfServices = null;
let _wfRecommendedInstalled = false;
const _wfRecommendedInstalledByWorkspace = new Set();
const _wfEngineByWorkspace = new Map();
let _wfInitPromise = null;
let _wfInitDone = false;
let _wfLoadedBase = null;
let _wfTaskTraceHookRegistered = false;
let _workflowTelegramDigestPromise = null;
const workflowTelegramDedup = new Map();

async function getWorkflowTelegramDigest() {
  if (_workflowTelegramDigestPromise) {
    return _workflowTelegramDigestPromise;
  }
  _workflowTelegramDigestPromise = (async () => {
    try {
      const mod = await import("../telegram/telegram-bot.mjs");
      if (typeof mod.restoreLiveDigest === "function") {
        await mod.restoreLiveDigest().catch(() => {});
      }
      return mod;
    } catch (err) {
      console.warn("[workflows/telegram] live digest unavailable:", err?.message || err);
      return null;
    }
  })();
  return _workflowTelegramDigestPromise;
}

async function sendWorkflowTelegramMessage(chatId, text, options = {}) {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const defaultChatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  const target = String(chatId || defaultChatId || "").trim();
  if (!telegramToken || !target) return;

  const message = String(text || "");
  const dedupKey = `${target}:${message.trim()}`;
  const now = Date.now();
  const lastSentAt = workflowTelegramDedup.get(dedupKey) || 0;
  if (dedupKey && now - lastSentAt < 5 * 60 * 1000) {
    return;
  }
  workflowTelegramDedup.set(dedupKey, now);

  const parseMode = String(options?.parseMode || "").trim();
  if (!parseMode && defaultChatId && target === defaultChatId) {
    const digest = await getWorkflowTelegramDigest();
    if (typeof digest?.notify === "function") {
      await digest.notify(message, 4, {
        silent: Boolean(options?.silent),
        category: "workflow",
      });
      return;
    }
  }

  try {
    await fetch(
      `https://api.telegram.org/bot${telegramToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: target,
          text: message,
          parse_mode: parseMode || "HTML",
          disable_notification: Boolean(options?.silent),
        }),
      },
    );
  } catch (e) {
    console.warn("[workflows/telegram] sendMessage failed:", e.message);
  }
}

/**
 * Test-only: inject a mock workflow engine module and pre-seed the per-workspace
 * engine cache so that dispatchWorkflowEvent uses the specified mock.
 */
let _testDefaultEngine = null;
export function _testInjectWorkflowEngine(mockModule, mockEngine) {
  _wfEngine = mockModule;
  _wfInitDone = true;
  _wfInitPromise = null;
  _testDefaultEngine = mockEngine || null;
  _wfEngineByWorkspace.clear();
}

let workflowEventDedupWindowMs = (() => {
  const parsed = Number.parseInt(process.env.WORKFLOW_EVENT_DEDUP_WINDOW_MS || "15000", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 15_000;
  return Math.min(300_000, Math.max(250, parsed));
})();
const workflowEventDedup = new Map();

function parseBooleanEnv(rawValue, fallback = false) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallback;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "n"].includes(normalized)) return false;
  return fallback;
}

function parseTemplateIdList(rawValue) {
  return String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function shouldBootstrapDefaultWorkflowSingleton() {
  return !process.env.VITEST;
}

function resolveWorkflowBootstrapSelection(templatesModule) {
  let configWorkflowDefaults = {};
  try {
    const { configData } = readConfigDocument();
    configWorkflowDefaults =
      configData?.workflowDefaults && typeof configData.workflowDefaults === "object"
        ? configData.workflowDefaults
        : {};
  } catch {
    configWorkflowDefaults = {};
  }
  const autoInstallEnabled = parseBooleanEnv(
    process.env.WORKFLOW_DEFAULT_AUTOINSTALL ?? configWorkflowDefaults.autoInstall,
    configWorkflowDefaults.autoInstall ?? true,
  );
  if (!autoInstallEnabled) {
    return {
      enabled: false,
      source: "disabled",
      profileId: null,
      templateIds: [],
      overridesById: {},
    };
  }

  const hasTemplateEnv = Object.prototype.hasOwnProperty.call(
    process.env,
    "WORKFLOW_DEFAULT_TEMPLATES",
  );
  const rawTemplateEnv = String(process.env.WORKFLOW_DEFAULT_TEMPLATES || "").trim();
  if (hasTemplateEnv) {
    const lowered = rawTemplateEnv.toLowerCase();
    if (!rawTemplateEnv || ["none", "off", "disabled", "false"].includes(lowered)) {
      return {
        enabled: true,
        source: "custom:none",
        profileId: null,
        templateIds: [],
        overridesById: {},
      };
    }
    const templateIds = parseTemplateIdList(rawTemplateEnv);
    return {
      enabled: true,
      source: "custom:list",
      profileId: null,
      templateIds,
      overridesById: templatesModule?.normalizeTemplateOverridesById
        ? templatesModule.normalizeTemplateOverridesById(
            configWorkflowDefaults.templateOverridesById,
            templateIds,
          )
        : {},
    };
  }

  const profileId = String(
    process.env.WORKFLOW_DEFAULT_PROFILE || configWorkflowDefaults.profile || "balanced",
  ).trim().toLowerCase();

  if (typeof templatesModule?.resolveWorkflowTemplateIds === "function") {
    const templateIds = templatesModule.resolveWorkflowTemplateIds({ profileId });
    return {
      enabled: true,
      source: "profile",
      profileId,
      templateIds,
      overridesById: templatesModule?.normalizeTemplateOverridesById
        ? templatesModule.normalizeTemplateOverridesById(
            configWorkflowDefaults.templateOverridesById,
            templateIds,
          )
        : {},
    };
  }

  return {
    enabled: true,
    source: "recommended",
    profileId: null,
    templateIds: [],
    overridesById: {},
  };
}

async function getWorkflowEngineModule() {
  if (_wfEngine) return _wfEngine;
  if (_wfInitDone) return _wfEngine;          // failed previously → don't retry
  if (_wfInitPromise) {
    try { await _wfInitPromise; } catch { /* handled by originator */ }
    return _wfEngine;
  }

  _wfInitPromise = (async () => {
    const primaryBase = new URL(".", import.meta.url).href;
    const localBosunDir = resolve(repoRoot, "bosun");
    const fallbackBase = pathToFileURL(localBosunDir + "/").href;
    const bases = [primaryBase];
    if (fallbackBase !== primaryBase) bases.push(fallbackBase);

    for (const base of bases) {
      try {
        _wfEngine = await import(new URL("../workflow/workflow-engine.mjs", base).href);
        _wfNodes = await import(new URL("../workflow/workflow-nodes.mjs", base).href);
        _wfTemplates = await import(new URL("../workflow/workflow-templates.mjs", base).href);
        if (typeof _wfNodes?.ensureWorkflowNodeTypesLoaded === "function") {
          await _wfNodes.ensureWorkflowNodeTypesLoaded({ repoRoot });
        }
        if (_wfLoadedBase !== base) {
          console.log(`[workflows] Loaded workflow modules from: ${base}`);
          _wfLoadedBase = base;
        }
        break;
      } catch (err) {
        console.warn(`[workflows] Could not load from ${base}: ${err.message}`);
        _wfEngine = undefined;
      }
    }

    if (!_wfEngine) {
      console.error(
        "[workflows] Workflow engine unavailable. Run: npm install -g bosun@latest"
      );
      return;
    }

    if (!_wfServicesReady) {
      try {
        const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
        const telegramChatId = process.env.TELEGRAM_CHAT_ID;
        const telegramService = telegramToken
          ? {
              async sendMessage(chatId, text, options = {}) {
                await sendWorkflowTelegramMessage(
                  chatId || telegramChatId,
                  text,
                  options,
                );
              },
            }
          : null;

        let kanbanService = null;
        try {
          kanbanService = getKanbanAdapter();
        } catch (err) {
          console.warn("[workflows] kanban adapter unavailable:", err.message);
        }

        const agentPoolService = {
          launchEphemeralThread,
          launchOrResumeThread,
          execWithRetry,
          async continueSession(sessionId, prompt, opts = {}) {
            const timeout = Number(opts.timeout) || 60 * 60 * 1000;
            const cwd = opts.cwd || process.cwd();
            return launchEphemeralThread(prompt, cwd, timeout, {
              resumeThreadId: sessionId,
              sdk: opts.sdk,
            });
          },
          async killSession(sessionId) {
            if (!sessionId) return false;
            try {
              invalidateThread(sessionId);
              return true;
            } catch {
              return false;
            }
          },
        };

        let promptBundle = null;
        try {
          const { configData } = readConfigDocument();
          promptBundle = resolveAgentPrompts(
            resolveUiConfigDir(),
            repoRoot,
            configData,
          );
        } catch (err) {
          console.warn("[workflows] prompt resolver failed:", err.message);
        }

        let meetingService = null;
        try {
          const { createMeetingWorkflowService } = await import("../workflow/meeting-workflow-service.mjs");
          meetingService = createMeetingWorkflowService();
        } catch (err) {
          console.warn("[workflows] meeting service unavailable:", err.message);
        }

        const services = {
          telegram: telegramService,
          agentPool: agentPoolService,
          kanban: kanbanService,
          meeting: meetingService,
          prompts: promptBundle?.prompts || null,
          onTaskWorkflowEvent: handleTaskWorkflowTraceEvent,
        };
        _wfServices = services;
        _wfServicesReady = true;

        if (shouldBootstrapDefaultWorkflowSingleton()) {
          const engine = _wfEngine.getWorkflowEngine({ services });
          attachWorkflowEngineLiveBridge(engine);
          if (!_wfTaskTraceHookRegistered && typeof engine?.registerTaskTraceHook === "function") {
            engine.registerTaskTraceHook((event) => {
              handleTaskWorkflowTraceEvent(event);
            });
            _wfTaskTraceHookRegistered = true;
          }

          // Resume any runs that were interrupted by a previous shutdown.
          // This must happen AFTER services are wired so node executors work.
          if (typeof engine.resumeInterruptedRuns === "function") {
            engine.resumeInterruptedRuns().catch((err) => {
              console.warn("[workflows] Failed to resume interrupted runs:", err.message);
            });
          }
        } else {
          _wfRecommendedInstalled = true;
        }
      } catch (err) {
        console.warn("[workflows] services setup failed (engine still usable):", err.message);
      }
    }

    if (!_wfRecommendedInstalled && _wfTemplates && shouldBootstrapDefaultWorkflowSingleton()) {
      try {
        const engine = _wfEngine.getWorkflowEngine();
        attachWorkflowEngineLiveBridge(engine);
        const selection = resolveWorkflowBootstrapSelection(_wfTemplates);
        let result = { installed: [], skipped: [], errors: [] };

        if (selection.enabled) {
          if (
            Array.isArray(selection.templateIds) &&
            selection.templateIds.length > 0 &&
            typeof _wfTemplates.installTemplateSet === "function"
          ) {
            result = _wfTemplates.installTemplateSet(
              engine,
              selection.templateIds,
              selection.overridesById || {},
            );
          } else if (
            selection.source === "recommended" &&
            typeof _wfTemplates.installRecommendedTemplates === "function"
          ) {
            result = _wfTemplates.installRecommendedTemplates(engine);
          }
        }

        if (result.installed.length) {
          const suffix = selection.profileId ? ` (profile: ${selection.profileId})` : "";
          console.log(
            `[workflows] Installed ${result.installed.length} default workflow templates${suffix}`,
          );
        } else if (!selection.enabled) {
          console.log("[workflows] Default template auto-install disabled by WORKFLOW_DEFAULT_AUTOINSTALL=false");
        } else if (
          selection.source.startsWith("custom:") &&
          selection.templateIds.length === 0
        ) {
          console.log("[workflows] Default template selection is empty (custom:none)");
        }
        if (result.errors.length) {
          console.warn("[workflows] Default template install errors:", result.errors);
        }
        if (typeof _wfTemplates.reconcileInstalledTemplates === "function") {
          const reconcile = _wfTemplates.reconcileInstalledTemplates(engine, {
            autoUpdateUnmodified: true,
          });
          if (reconcile.autoUpdated > 0) {
            console.log(
              `[workflows] Auto-updated ${reconcile.autoUpdated} unmodified template workflow(s) to latest`,
            );
          }
          if (reconcile.customized.length > 0) {
            const pending = reconcile.customized.filter((entry) => entry.updateAvailable).length;
            if (pending > 0) {
              console.log(
                `[workflows] ${pending} customized template workflow(s) have updates available`,
              );
            }
          }
          if (reconcile.errors.length > 0) {
            console.warn("[workflows] Template reconcile errors:", reconcile.errors);
          }
        }
      } catch (err) {
        console.warn("[workflows] Default template install failed:", err.message);
      } finally {
        _wfRecommendedInstalled = true;
      }
    }
  })();

  try {
    await _wfInitPromise;
  } finally {
    _wfInitDone = true;
    _wfInitPromise = null;
  }

  return _wfEngine;
}

function getWorkflowWorkspaceKey(workspaceDir = "") {
  const normalized = normalizeCandidatePath(workspaceDir) || repoRoot;
  if (process.platform === "win32") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function getWorkflowStoragePaths(workspaceDir = "") {
  const root = normalizeCandidatePath(workspaceDir) || repoRoot;
  return {
    workspaceRoot: root,
    workflowDir: resolve(root, ".bosun", "workflows"),
    runsDir: resolve(root, ".bosun", "workflow-runs"),
  };
}


function mapWorkflowRunOutcome(eventType, status) {
  const normalizedType = String(eventType || "").trim().toLowerCase();
  const normalizedStatus = String(status || "").trim().toLowerCase();
  if (normalizedType.endsWith(".error")) return "failed";
  if (normalizedType.endsWith(".start") || normalizedStatus === "running") return "running";
  if (normalizedStatus) return normalizedStatus;
  return "completed";
}

function handleTaskWorkflowTraceEvent(event = {}) {
  const taskId = String(event?.taskId || "").trim();
  if (!taskId) return;

  const eventType = String(event?.eventType || "workflow.event").trim();
  const summary = String(event?.summary || eventType).trim();

  try {
    appendInternalTaskTimelineEvent(taskId, {
      type: eventType,
      source: "workflow",
      status: event?.status || null,
      message: summary,
      payload: {
        runId: event?.runId || null,
        workflowId: event?.workflowId || null,
        workflowName: event?.workflowName || null,
        nodeId: event?.nodeId || null,
        phase: event?.phase || null,
      },
    });

    if (String(eventType).startsWith("workflow.run.")) {
      linkInternalTaskWorkflowRun(taskId, {
        runId: event?.runId || null,
        workflowId: event?.workflowId || null,
        status: event?.status || null,
        outcome: mapWorkflowRunOutcome(eventType, event?.status),
        startedAt: event?.startedAt || null,
        endedAt: event?.endedAt || null,
        summary,
        source: "workflow",
        meta: {
          workflowName: event?.workflowName || null,
          taskTitle: event?.taskTitle || null,
          nodeId: event?.nodeId || null,
          phase: event?.phase || null,
        },
      });
    }
  } catch (err) {
    console.warn(`[workflows] failed to persist task workflow trace for ${taskId}: ${err.message}`);
  }
}

function mergeTaskWorkflowRuns(baseRuns = [], extraRuns = [], limit = 60) {
  const merged = [];
  const indexByKey = new Map();
  const resolveLinkedSessionId = (entry) => {
    const candidates = [
      entry?.sessionId,
      entry?.threadId,
      entry?.agentSessionId,
      entry?.meta?.sessionId,
      entry?.meta?.threadId,
      entry?.data?.sessionId,
      entry?.data?.threadId,
    ];
    for (const value of candidates) {
      const normalized = String(value || "").trim();
      if (normalized) return normalized;
    }
    return null;
  };
  const resolveSessionId = (entry) => {
    const directSessionId = resolveLinkedSessionId(entry);
    if (directSessionId) return directSessionId;
    const primarySessionId = String(entry?.primarySessionId || "").trim();
    return primarySessionId || null;
  };
  const mergeEntries = (current, incoming) => {
    const currentMeta = current?.meta && typeof current.meta === "object" ? current.meta : {};
    const incomingMeta = incoming?.meta && typeof incoming.meta === "object" ? incoming.meta : {};
    const mergedMeta = { ...currentMeta, ...incomingMeta };
    const currentMetaSessionId = String(currentMeta.sessionId || "").trim();
    const currentMetaThreadId = String(currentMeta.threadId || "").trim();
    if (currentMetaSessionId) mergedMeta.sessionId = currentMetaSessionId;
    if (currentMetaThreadId) mergedMeta.threadId = currentMetaThreadId;
    return {
      ...current,
      ...incoming,
      runId: incoming.runId || current.runId || null,
      workflowId: incoming.workflowId || current.workflowId || null,
      workflowName: incoming.workflowName || current.workflowName || null,
      status: incoming.status || current.status || null,
      outcome: incoming.outcome || current.outcome || null,
      summary: incoming.summary || current.summary || null,
      startedAt: incoming.startedAt || current.startedAt || null,
      endedAt: incoming.endedAt || current.endedAt || null,
      duration: incoming.duration ?? current.duration ?? null,
      url: incoming.url || current.url || null,
      nodeId: incoming.nodeId || current.nodeId || null,
      source: incoming.source || current.source || "workflow",
      sessionId: resolveLinkedSessionId(incoming) || resolveLinkedSessionId(current) || null,
      primarySessionId:
        String(incoming.primarySessionId || "").trim()
        || String(current.primarySessionId || "").trim()
        || resolveLinkedSessionId(incoming)
        || resolveLinkedSessionId(current),
      meta: mergedMeta,
    };
  };
  const push = (entry) => {
    if (!entry || typeof entry !== "object") return;
    const runId = String(entry.runId || "").trim();
    const workflowId = String(entry.workflowId || "").trim();
    const dedupKey = runId ? `run:${runId}` : `wf:${workflowId}:${entry.startedAt || entry.endedAt || ""}`;
    const normalized = {
      runId: runId || null,
      workflowId: workflowId || null,
      workflowName: entry.workflowName != null ? String(entry.workflowName) : null,
      status: entry.status != null ? String(entry.status) : null,
      outcome: entry.outcome != null ? String(entry.outcome) : null,
      summary: entry.summary != null ? String(entry.summary) : null,
      startedAt: entry.startedAt || null,
      endedAt: entry.endedAt || null,
      duration: Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null,
      url: entry.url != null ? String(entry.url) : null,
      nodeId: entry.nodeId != null ? String(entry.nodeId) : null,
      source: entry.source ? String(entry.source) : "workflow",
      sessionId: resolveLinkedSessionId(entry),
      primarySessionId:
        String(entry.primarySessionId || "").trim() || resolveSessionId(entry),
      meta: entry.meta && typeof entry.meta === "object" ? { ...entry.meta } : {},
    };
    const existingIndex = indexByKey.get(dedupKey);
    if (existingIndex == null) {
      indexByKey.set(dedupKey, merged.length);
      merged.push(normalized);
      return;
    }
    merged[existingIndex] = mergeEntries(merged[existingIndex], normalized);
  };

  for (const run of Array.isArray(baseRuns) ? baseRuns : []) push(run);
  for (const run of Array.isArray(extraRuns) ? extraRuns : []) push(run);

  merged.sort((a, b) => {
    const ta = Number(new Date(a.endedAt || a.startedAt || 0).getTime() || 0);
    const tb = Number(new Date(b.endedAt || b.startedAt || 0).getTime() || 0);
    return tb - ta;
  });

  if (Number.isFinite(limit) && limit > 0 && merged.length > limit) {
    return merged.slice(0, limit);
  }
  return merged;
}

async function collectWorkflowRunsForTask(taskId, reqUrl, limit = 40) {
  const normalizedTaskId = String(taskId || "").trim();
  if (!normalizedTaskId) return [];
  try {
    const wfCtx = await getWorkflowRequestContext(reqUrl);
    if (!wfCtx?.ok || !wfCtx.engine) return [];
    const engine = wfCtx.engine;
    const summaries = engine.getRunHistory ? engine.getRunHistory(null, 240) : [];
    const out = [];
    for (const summary of summaries) {
      if (!summary?.runId) continue;
      const detail = engine.getRunDetail ? engine.getRunDetail(summary.runId) : null;
      if (!detail?.detail) continue;
      const data = detail.detail?.data || {};
      const primaryTaskId = String(data.taskId || data.activeTaskId || data?.task?.id || "").trim();
      let matches = primaryTaskId === normalizedTaskId;
      if (!matches && typeof engine.getTaskTraceEvents === "function") {
        const traceEvents = engine.getTaskTraceEvents(summary.runId) || [];
        matches = traceEvents.some((event) => String(event?.taskId || "").trim() === normalizedTaskId);
      }
      if (!matches) continue;
      const primarySessionId = (() => {
        for (const value of [
          data.sessionId,
          data.threadId,
          data?.task?.sessionId,
          data?.task?.threadId,
        ]) {
          const normalized = String(value || "").trim();
          if (normalized) return normalized;
        }
        const traceEvents = typeof engine.getTaskTraceEvents === "function"
          ? engine.getTaskTraceEvents(summary.runId) || []
          : [];
        for (let index = traceEvents.length - 1; index >= 0; index -= 1) {
          const event = traceEvents[index];
          for (const value of [
            event?.sessionId,
            event?.threadId,
            event?.meta?.sessionId,
            event?.meta?.threadId,
          ]) {
            const normalized = String(value || "").trim();
            if (normalized) return normalized;
          }
        }
        return null;
      })();
      out.push({
        runId: detail.runId,
        workflowId: detail.workflowId,
        workflowName: detail.workflowName,
        status: detail.status,
        outcome: detail.status,
        summary: detail.status === "failed"
          ? `Workflow run failed (${detail.workflowName || detail.workflowId || detail.runId})`
          : `Workflow run ${detail.status || "completed"} (${detail.workflowName || detail.workflowId || detail.runId})`,
        startedAt: detail.startedAt || null,
        endedAt: detail.endedAt || null,
        duration: detail.duration || null,
        sessionId: null,
        primarySessionId,
        source: "workflow",
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

function sanitizeTaskDiagnosticText(value, maxLength = 240) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  if (!Number.isFinite(maxLength) || maxLength <= 0 || normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function collectTaskTimelineDiagnostics(task, limit = 8) {
  const timeline = Array.isArray(task?.timeline) ? task.timeline : [];
  const relevant = [];
  for (const entry of timeline) {
    const message = sanitizeTaskDiagnosticText(
      entry?.message || entry?.reason || entry?.error || "",
      280,
    );
    const status = String(entry?.status || "").trim().toLowerCase();
    if (
      !message &&
      status !== "blocked"
    ) {
      continue;
    }
    const isRelevant =
      status === "blocked" ||
      /worktree failed/i.test(message) ||
      /pre-pr validation failed/i.test(message) ||
      /claim was stolen/i.test(message) ||
      /blocked/i.test(message);
    if (!isRelevant) continue;
    relevant.push({
      source: String(entry?.source || entry?.type || "timeline").trim() || "timeline",
      message: message || `Task entered ${status || "blocked"} state`,
      timestamp: entry?.timestamp || entry?.createdAt || entry?.updatedAt || null,
      status: status || null,
      kind: "timeline",
    });
  }
  return relevant.slice(-Math.max(1, limit));
}

function collectTaskLogDiagnostics(task, workspaceDir = "", limit = 8) {
  const taskId = String(task?.id || task?.taskId || "").trim();
  if (!taskId) {
    return {
      counts: {
        prePrValidationFailed: 0,
        worktreeFailed: 0,
        blockedTransitions: 0,
        createPrFailed: 0,
      },
      entries: [],
    };
  }

  const taskBranch = String(task?.branch || task?.branchName || "").trim();
  const needles = [taskId, taskBranch].filter((value) => value && value.length >= 8);
  const logPaths = [];
  const pushLogPath = (candidate) => {
    if (!candidate || !existsSync(candidate) || logPaths.includes(candidate)) return;
    logPaths.push(candidate);
  };
  if (workspaceDir) {
    pushLogPath(resolve(workspaceDir, ".bosun", "logs", "monitor-error.log"));
    pushLogPath(resolve(workspaceDir, ".bosun", "logs", "monitor.log"));
  }
  pushLogPath(resolve(repoRoot, ".bosun", "logs", "monitor-error.log"));
  pushLogPath(resolve(repoRoot, ".bosun", "logs", "monitor.log"));

  const counts = {
    prePrValidationFailed: 0,
    worktreeFailed: 0,
    blockedTransitions: 0,
    createPrFailed: 0,
  };
  const entries = [];

  for (const logPath of logPaths) {
    let raw = "";
    try {
      raw = readFileSync(logPath, "utf8");
    } catch {
      continue;
    }
    const logName = /monitor-error\.log$/i.test(logPath) ? "monitor-error.log" : "monitor.log";
    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      if (!needles.some((needle) => line.includes(needle))) continue;
      const text = sanitizeTaskDiagnosticText(line, 320);
      let matched = false;
      if (/pre-PR validation failed/i.test(text)) {
        counts.prePrValidationFailed += 1;
        matched = true;
      }
      if (/Worktree failed for/i.test(text) || /Worktree acquisition failed/i.test(text)) {
        counts.worktreeFailed += 1;
        matched = true;
      }
      if (/-> blocked/i.test(text) || /status: .*blocked/i.test(text)) {
        counts.blockedTransitions += 1;
        matched = true;
      }
      if (/create-pr FAILED/i.test(text)) {
        counts.createPrFailed += 1;
        matched = true;
      }
      if (!matched) continue;
      entries.push({
        source: logName,
        message: text,
        kind: "log",
      });
      if (entries.length > limit) entries.shift();
    }
  }

  return { counts, entries };
}

function buildTaskBlockedContext(task, options = {}) {
  const currentTask = task && typeof task === "object" ? task : {};
  const canStart = options.canStart && typeof options.canStart === "object"
    ? options.canStart
    : null;
  const normalizedStatus = normalizeTaskStatusKey(currentTask?.status);
  const explicitReason = sanitizeTaskDiagnosticText(
    currentTask?.blockedReason
      || currentTask?.meta?.worktreeFailure?.blockedReason
      || currentTask?.meta?.autoRecovery?.error
      || currentTask?.meta?.worktreeFailure?.error
      || "",
    280,
  );
  const workflowRuns = Array.isArray(options.workflowRuns)
    ? options.workflowRuns
    : Array.isArray(currentTask?.workflowRuns)
      ? currentTask.workflowRuns
      : [];
  const timelineEvidence = collectTaskTimelineDiagnostics(currentTask, 6);
  const logDiagnostics = collectTaskLogDiagnostics(
    currentTask,
    normalizeCandidatePath(options.workspaceDir),
    6,
  );
  const hasPlannerCorruption = /planner payload corrupted/i.test(explicitReason);
  const hasWorktreeFailure =
    Boolean(currentTask?.meta?.worktreeFailure) ||
    logDiagnostics.counts.worktreeFailed > 0 ||
    timelineEvidence.some((entry) => /worktree failed/i.test(String(entry?.message || "")));
  const isDependencyBlocked = canStart?.canStart === false && String(canStart?.reason || "") === "dependency_blocked";

  let category = "";
  let headline = "";
  let summary = "";
  let recommendation = "";

  if (hasPlannerCorruption) {
    category = "planner_payload_corruption";
    headline = "Planner payload corruption quarantined this task.";
    summary = explicitReason;
    recommendation = "Do not requeue this task as-is. Recreate it from the fixed planner path or repair its payload first.";
  } else if (hasWorktreeFailure) {
    category = "worktree_failure";
    headline = "Task Lifecycle blocked this task after worktree acquisition failed.";
    summary = explicitReason
      || "Bosun could not acquire or refresh a clean managed worktree for this task.";
    recommendation = "If the worktree guard fix is now deployed, move the task back to todo to retry it on a fresh lifecycle run.";
  } else if (isDependencyBlocked) {
    category = "dependency_blocked";
    headline = "This task cannot start because one or more dependencies are not done yet.";
    summary = "Bosun will not dispatch this task until every blocking dependency below is resolved.";
    recommendation = "Complete or unblock the listed dependencies, then dispatch this task again.";
  } else if (normalizedStatus === "blocked") {
    category = "blocked";
    headline = "This task is blocked.";
    summary = explicitReason || "Bosun marked this task as blocked, but the original blocked reason was not persisted.";
    recommendation = "Review the recent workflow evidence below. After the underlying issue is fixed, move the task back to todo to clear the block and retry it.";
  } else if (canStart?.canStart === false) {
    category = "start_guard_blocked";
    headline = "This task is currently not startable.";
    summary = sanitizeTaskDiagnosticText(canStart?.reason || "Bosun start guards rejected dispatch for this task.");
    recommendation = "Resolve the blocking condition below before dispatching the task.";
  } else {
    return null;
  }

  return {
    status: normalizedStatus,
    category,
    headline,
    summary,
    recommendation,
    reason: explicitReason || sanitizeTaskDiagnosticText(canStart?.reason || ""),
    workflowRunCount: workflowRuns.length,
    prePrValidationFailureCount: logDiagnostics.counts.prePrValidationFailed,
    worktreeFailureCount: logDiagnostics.counts.worktreeFailed,
    blockedTransitionCount: logDiagnostics.counts.blockedTransitions,
    createPrFailureCount: logDiagnostics.counts.createPrFailed,
    blockedBy: Array.isArray(canStart?.blockedBy) ? canStart.blockedBy : [],
    blockingTaskIds: Array.isArray(canStart?.blockingTaskIds) ? canStart.blockingTaskIds : [],
    timelineEvidence,
    logEvidence: logDiagnostics.entries,
  };
}

function buildTaskMetaPatch(previousMeta, metadataPatchMeta, options = {}) {
  const clearBlockedState = options.clearBlockedState === true;
  const nextMeta = previousMeta && typeof previousMeta === "object"
    ? { ...previousMeta }
    : {};
  if (clearBlockedState) {
    delete nextMeta.autoRecovery;
    delete nextMeta.blockedReason;
  }
  if (metadataPatchMeta && typeof metadataPatchMeta === "object") {
    Object.assign(nextMeta, metadataPatchMeta);
  }
  return nextMeta;
}

function maybeBootstrapWorkspaceWorkflowTemplates(engine, workspaceKey, workspaceLabel) {
  if (!engine || !_wfTemplates) return;
  if (_wfRecommendedInstalledByWorkspace.has(workspaceKey)) return;
  try {
    const selection = resolveWorkflowBootstrapSelection(_wfTemplates);
    let result = { installed: [], skipped: [], errors: [] };
    if (selection.enabled) {
      if (
        Array.isArray(selection.templateIds) &&
        selection.templateIds.length > 0 &&
        typeof _wfTemplates.installTemplateSet === "function"
      ) {
        result = _wfTemplates.installTemplateSet(
          engine,
          selection.templateIds,
          selection.overridesById || {},
        );
      } else if (
        selection.source === "recommended" &&
        typeof _wfTemplates.installRecommendedTemplates === "function"
      ) {
        result = _wfTemplates.installRecommendedTemplates(engine);
      }
    }
    if (typeof _wfTemplates.reconcileInstalledTemplates === "function") {
      _wfTemplates.reconcileInstalledTemplates(engine, {
        autoUpdateUnmodified: true,
      });
    }
    if (result.installed.length) {
      console.log(
        `[workflows] Installed ${result.installed.length} default workflow templates for workspace ${workspaceLabel}`,
      );
    }
  } catch (err) {
    console.warn(
      `[workflows] Default template install failed for workspace ${workspaceLabel}: ${err.message}`,
    );
  } finally {
    _wfRecommendedInstalledByWorkspace.add(workspaceKey);
  }
}

async function getWorkflowRequestContext(reqUrl) {
  const workspaceContext = resolveWorkspaceContextFromRequest(reqUrl, { allowAll: false });
  if (!workspaceContext) {
    return { ok: false, status: 400, error: "Unknown workspace. Set a valid workspace query value." };
  }
  const wfMod = await getWorkflowEngineModule();
  if (!wfMod?.WorkflowEngine) {
    return { ok: false, status: 503, error: "Workflow engine not available" };
  }
  const paths = getWorkflowStoragePaths(workspaceContext.workspaceDir);
  const workspaceKey = getWorkflowWorkspaceKey(paths.workspaceRoot);
  let engine = _wfEngineByWorkspace.get(workspaceKey) || null;
  if (!engine) {
    if (_testDefaultEngine) {
      engine = _testDefaultEngine;
    } else {
      engine = new wfMod.WorkflowEngine({
        workflowDir: paths.workflowDir,
        runsDir: paths.runsDir,
        services: _wfServices || {},
        onTaskWorkflowEvent: handleTaskWorkflowTraceEvent,
      });
      attachWorkflowEngineLiveBridge(engine);
      if (typeof engine.registerTaskTraceHook === "function") {
        engine.registerTaskTraceHook((event) => {
          handleTaskWorkflowTraceEvent(event);
        });
      }
      engine.load();
    }
    attachWorkflowEngineLiveBridge(engine);
    _wfEngineByWorkspace.set(workspaceKey, engine);
  }
  maybeBootstrapWorkspaceWorkflowTemplates(
    engine,
    workspaceKey,
    workspaceContext.workspaceId || workspaceKey,
  );
  return {
    ok: true,
    wfMod,
    engine,
    workspaceContext: { ...workspaceContext, workspaceDir: paths.workspaceRoot },
  };
}

/**
 * Return the lowercase ID of the primary (first) workspace.
 * Used so that legacy tasks without a workspace stamp are visible only in
 * that workspace and not leaked into every workspace.
 */
function resolvePrimaryWorkspaceId() {
  try {
    const configDir = resolveUiConfigDir();
    const workspaces = listManagedWorkspaces(configDir);
    return String(workspaces[0]?.id || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function taskMatchesWorkspaceContext(task, workspaceContext) {
  const workspaceFilter = String(
    workspaceContext?.workspaceFilter || workspaceContext?.workspaceId || "",
  )
    .trim()
    .toLowerCase();
  if (!workspaceFilter) return true;

  const taskWorkspaceRaw = String(task?.workspace || task?.meta?.workspace || "").trim();
  const taskWorkspace = taskWorkspaceRaw.toLowerCase();
  if (taskWorkspace === workspaceFilter) return true;
  if (!taskWorkspaceRaw) {
    // Legacy tasks without workspace stamps are only visible in the
    // primary (first) workspace — not leaked into every workspace.
    const primaryId = resolvePrimaryWorkspaceId();
    return !primaryId || workspaceFilter === primaryId;
  }

  const taskWorkspacePath = normalizeCandidatePath(taskWorkspaceRaw);
  const workspaceDirFilter = normalizeCandidatePath(workspaceContext?.workspaceDir);
  return Boolean(taskWorkspacePath && workspaceDirFilter && taskWorkspacePath === workspaceDirFilter);
}

async function listTasksForWorkspaceContext(workspaceContext, { status = "", projectId = "" } = {}) {
  const adapter = getKanbanAdapter();
  const projects = await adapter.listProjects();
  const activeProject = projectId || projects[0]?.id || projects[0]?.project_id || "";
  if (!activeProject) {
    return { tasks: [], projectId: "" };
  }
  const rawTasks = await adapter.listTasks(activeProject, status ? { status } : {});
  const tasks = (Array.isArray(rawTasks) ? rawTasks : []).filter((task) =>
    taskMatchesWorkspaceContext(task, workspaceContext),
  );
  return { tasks, projectId: activeProject };
}

function sortTasksByRecency(tasks = []) {
  return [...tasks].sort((a, b) => {
    const aTs = Date.parse(a?.updatedAt || a?.createdAt || 0) || 0;
    const bTs = Date.parse(b?.updatedAt || b?.createdAt || 0) || 0;
    return bTs - aTs;
  });
}

async function collectBenchmarkWorkflowRuns(reqUrl, taskIds = new Set(), limit = 12) {
  if (!(taskIds instanceof Set) || taskIds.size === 0) return [];
  try {
    const wfCtx = await getWorkflowRequestContext(reqUrl);
    if (!wfCtx?.ok || !wfCtx.engine) return [];
    const summaries = wfCtx.engine.getRunHistory ? wfCtx.engine.getRunHistory(null, 240) : [];
    const runs = [];
    for (const summary of summaries) {
      if (!summary?.runId) continue;
      const detail = wfCtx.engine.getRunDetail ? wfCtx.engine.getRunDetail(summary.runId) : null;
      if (!detail?.detail) continue;
      const data = detail.detail?.data || {};
      const primaryTaskId = String(
        data.taskId || data.activeTaskId || data?.task?.id || "",
      ).trim();
      let matches = Boolean(primaryTaskId && taskIds.has(primaryTaskId));
      if (!matches && typeof wfCtx.engine.getTaskTraceEvents === "function") {
        const traceEvents = wfCtx.engine.getTaskTraceEvents(summary.runId) || [];
        matches = traceEvents.some((event) => taskIds.has(String(event?.taskId || "").trim()));
      }
      if (!matches) continue;
      runs.push({
        runId: detail.runId,
        workflowId: detail.workflowId,
        workflowName: detail.workflowName,
        status: detail.status,
        startedAt: detail.startedAt || null,
        endedAt: detail.endedAt || null,
        duration: detail.duration || null,
        summary:
          detail.status === "failed"
            ? `Workflow run failed (${detail.workflowName || detail.workflowId || detail.runId})`
            : `Workflow run ${detail.status || "completed"} (${detail.workflowName || detail.workflowId || detail.runId})`,
      });
      if (runs.length >= limit) break;
    }
    return runs;
  } catch {
    return [];
  }
}

async function collectBenchmarkExecutorActivity({
  executor,
  modeState,
  workspaceContext,
  tasks = [],
}) {
  if (!executor || typeof executor.getStatus !== "function") {
    return {
      activeSlots: 0,
      paused: false,
      maxParallel: 0,
      benchmarkSlots: [],
      competingSlots: [],
      unclassifiedSlots: [],
    };
  }

  const adapter = getKanbanAdapter();
  const status = executor.getStatus() || {};
  const slots = Array.isArray(status?.slots) ? status.slots : [];
  const taskMap = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const taskId = String(task?.id || task?.task_id || "").trim();
    if (!taskId) continue;
    taskMap.set(taskId, task);
  }

  const benchmarkSlots = [];
  const competingSlots = [];
  const unclassifiedSlots = [];
  for (const slot of slots) {
    const taskId = String(slot?.taskId || slot?.task_id || "").trim();
    if (!taskId) continue;
    let task = taskMap.get(taskId) || null;
    if (!task) {
      try {
        task = await adapter.getTask(taskId);
      } catch {
        task = null;
      }
    }
    if (task && !taskMatchesWorkspaceContext(task, workspaceContext)) {
      continue;
    }
    const entry = {
      taskId,
      taskTitle: String(slot?.taskTitle || task?.title || taskId).trim() || taskId,
      status: String(slot?.status || task?.status || "").trim() || null,
      runningFor: Number.isFinite(slot?.runningFor) ? Number(slot.runningFor) : null,
      sdk: String(slot?.sdk || task?.sdk || task?.executor || "").trim() || null,
      model: String(slot?.model || task?.model || task?.modelName || "").trim() || null,
      workspace: String(task?.workspace || task?.meta?.workspace || "").trim() || null,
      repository: String(task?.repository || task?.meta?.repository || "").trim() || null,
    };
    if (!task) {
      unclassifiedSlots.push(entry);
      continue;
    }
    if (
      taskMatchesBenchmarkMode(task, modeState, {
        repoRoot: modeState?.repoRoot || workspaceContext?.workspaceDir || repoRoot,
      })
    ) {
      benchmarkSlots.push(entry);
    } else {
      competingSlots.push(entry);
    }
  }

  return {
    activeSlots: Number(status?.activeSlots || slots.length || 0),
    paused: Boolean(status?.paused),
    maxParallel: Number.isFinite(status?.maxParallel) ? Number(status.maxParallel) : 0,
    benchmarkSlots,
    competingSlots,
    unclassifiedSlots,
  };
}

async function holdCompetingBenchmarkSlots({
  executor,
  modeState,
  workspaceContext,
  tasks = [],
}) {
  const activity = await collectBenchmarkExecutorActivity({
    executor,
    modeState,
    workspaceContext,
    tasks,
  });
  const aborted = [];
  if (!executor || typeof executor.abortTask !== "function") {
    return { activity, attempted: 0, aborted, unclassified: activity.unclassifiedSlots };
  }
  for (const slot of activity.competingSlots) {
    const result = executor.abortTask(String(slot.taskId), "benchmark_mode_focus");
    aborted.push({
      taskId: slot.taskId,
      taskTitle: slot.taskTitle,
      ok: Boolean(result?.ok),
      reason: result?.reason || null,
    });
  }
  return {
    activity,
    attempted: activity.competingSlots.length,
    aborted,
    unclassified: activity.unclassifiedSlots,
  };
}

async function applyBenchmarkModeChange({
  workspaceContext,
  providerId,
  body = {},
  enable = true,
}) {
  const targetRoot =
    normalizeCandidatePath(body?.repoRoot || body?.workspaceDir || workspaceContext?.workspaceDir)
    || repoRoot;
  const currentMode = readBenchmarkModeState(targetRoot);
  const executor = uiDeps.getInternalExecutor?.() || null;

  if (!enable) {
    let restoredMaxParallel = null;
    if (executor && Number.isFinite(currentMode.previousMaxParallel)) {
      executor.maxParallel = Number(currentMode.previousMaxParallel);
      if (currentMode.previousMaxParallel === 0) {
        executor.pause?.("benchmark-mode-disabled");
      } else if (executor.isPaused?.()) {
        executor.resume?.();
      }
      restoredMaxParallel = executor.maxParallel;
    }
    return {
      mode: clearBenchmarkModeState(targetRoot),
      targetRoot,
      restoredMaxParallel,
      appliedMaxParallel: null,
      holdResult: { attempted: 0, aborted: [], unclassified: [] },
    };
  }

  const resolvedWorkspaceDir =
    normalizeCandidatePath(body?.workspaceDir || workspaceContext?.workspaceDir || targetRoot)
    || targetRoot;
  const desiredMaxParallel = Number.isFinite(Number(body?.maxParallel))
    ? Number(body.maxParallel)
    : undefined;
  let nextMode = buildBenchmarkModePreset(providerId, {
    enabled: true,
    repoRoot: targetRoot,
    workspaceId: workspaceContext?.workspaceId || body?.workspaceId || "",
    workspaceDir: resolvedWorkspaceDir,
    pauseOtherAgents:
      typeof body?.pauseOtherAgents === "boolean" ? body.pauseOtherAgents : undefined,
    holdActiveNonBenchmarkTasks:
      typeof body?.holdActiveNonBenchmarkTasks === "boolean"
        ? body.holdActiveNonBenchmarkTasks
        : undefined,
    maxParallel: desiredMaxParallel,
    previousMaxParallel:
      currentMode.enabled && Number.isFinite(currentMode.previousMaxParallel)
        ? currentMode.previousMaxParallel
        : (executor && Number.isFinite(executor.maxParallel) ? executor.maxParallel : null),
  });

  let appliedMaxParallel = null;
  if (executor && Number.isFinite(nextMode.maxParallel)) {
    executor.maxParallel = Number(nextMode.maxParallel);
    if (nextMode.maxParallel === 0) {
      executor.pause?.("benchmark-mode");
    } else if (executor.isPaused?.()) {
      executor.resume?.();
    }
    appliedMaxParallel = executor.maxParallel;
  }

  nextMode = writeBenchmarkModeState(targetRoot, nextMode);
  let holdResult = { attempted: 0, aborted: [], unclassified: [] };
  if (executor && nextMode.holdActiveNonBenchmarkTasks) {
    const { tasks } = await listTasksForWorkspaceContext(workspaceContext);
    holdResult = await holdCompetingBenchmarkSlots({
      executor,
      modeState: nextMode,
      workspaceContext,
      tasks,
    });
  }

  return {
    mode: nextMode,
    targetRoot,
    restoredMaxParallel: null,
    appliedMaxParallel,
    holdResult,
  };
}

async function buildBenchmarkSnapshot(reqUrl, providerId = "") {
  const workspaceContext = resolveWorkspaceContextFromRequest(reqUrl, { allowAll: false });
  if (!workspaceContext) {
    return { ok: false, status: 400, error: "Unknown workspace. Set a valid workspace query value." };
  }

  const rawProviderId = String(providerId || "").trim().toLowerCase();
  const modeState = readBenchmarkModeState(workspaceContext.workspaceDir || repoRoot);
  const effectiveProviderId =
    rawProviderId
    || modeState.providerId
    || (listBenchmarkProviders().find((entry) => entry.supports?.launch)?.id || "swebench");
  const filterMode = modeState.enabled
    ? modeState
    : buildBenchmarkModePreset(effectiveProviderId, {
        enabled: true,
        workspaceId: workspaceContext.workspaceId,
        workspaceDir: workspaceContext.workspaceDir,
        repoRoot: workspaceContext.workspaceDir || repoRoot,
      });

  const { tasks, projectId } = await listTasksForWorkspaceContext(workspaceContext);
  const matchingTasks = filterTasksForBenchmarkMode(tasks, filterMode, {
    repoRoot: workspaceContext.workspaceDir || repoRoot,
  });
  const recentTasks = sortTasksByRecency(matchingTasks).slice(0, 12);
  const enrichedTasks = await applySharedStateToTasks(recentTasks);
  const recentWithRuntime = enrichedTasks.map((task) => withTaskRuntimeSnapshot(task));
  const workflowRuns = await collectBenchmarkWorkflowRuns(
    reqUrl,
    new Set(matchingTasks.map((task) => String(task?.id || task?.task_id || "").trim()).filter(Boolean)),
    12,
  );
  const executor = uiDeps.getInternalExecutor?.() || null;
  const executorActivity = await collectBenchmarkExecutorActivity({
    executor,
    modeState: filterMode,
    workspaceContext,
    tasks,
  });

  return {
    ok: true,
    data: {
      providers: listBenchmarkProviders(),
      provider: getBenchmarkProvider(effectiveProviderId) ? effectiveProviderId : "",
      workspace: {
        workspaceId: workspaceContext.workspaceId || "",
        workspaceDir: workspaceContext.workspaceDir || repoRoot,
        workspaceRoot: workspaceContext.workspaceRoot || workspaceContext.workspaceDir || repoRoot,
      },
      projectId,
      mode: modeState,
      filter: filterMode,
      summary: summarizeBenchmarkTasks(tasks, filterMode, {
        repoRoot: workspaceContext.workspaceDir || repoRoot,
      }),
      recentTasks: recentWithRuntime,
      workflowRuns,
      executor: executorActivity,
    },
  };
}

function allowWorkflowEvent(dedupKey, windowMs = workflowEventDedupWindowMs) {
  if (!dedupKey) return true;
  const now = Date.now();
  const lastSeen = workflowEventDedup.get(dedupKey) || 0;
  if (now - lastSeen < windowMs) {
    return false;
  }
  workflowEventDedup.set(dedupKey, now);
  if (workflowEventDedup.size > 1000) {
    const cutoff = now - windowMs * 2;
    for (const [key, ts] of workflowEventDedup.entries()) {
      if (ts < cutoff) workflowEventDedup.delete(key);
    }
  }
  return true;
}

function buildWorkflowEventPayload(eventType, eventData = {}, triggerSource = "ui-event") {
  const payload = eventData && typeof eventData === "object"
    ? { ...eventData }
    : {};
  payload.eventType = eventType;
  if (String(eventType || "").startsWith("pr.")) {
    const prEvent = String(eventType).slice(3).trim();
    if (prEvent) payload.prEvent = prEvent;
  }
  payload._triggerSource = triggerSource;
  payload._triggerEventType = eventType;
  payload._triggeredAt = new Date().toISOString();

  // Preserve _targetRepo if provided in event data
  if (eventData?._targetRepo) {
    payload._targetRepo = String(eventData._targetRepo).trim();
  }

  // Preserve _triggerVars for custom trigger variable passing
  if (eventData?._triggerVars && typeof eventData._triggerVars === "object") {
    payload._triggerVars = eventData._triggerVars;
  }

  return payload;
}

async function dispatchWorkflowEvent(eventType, eventData = {}, opts = {}) {
  try {
    if (!parseBooleanEnv(process.env.WORKFLOW_AUTOMATION_ENABLED, true)) {
      return false;
    }

    const dedupKey = String(opts?.dedupKey || "").trim();
    if (dedupKey && !allowWorkflowEvent(dedupKey)) {
      return false;
    }

    const wfCtx = await getWorkflowRequestContext(
      new URL(`http://localhost?workspace=active`),
    );
    if (!wfCtx?.ok) return false;
    const engine = wfCtx.engine;
    if (!engine?.evaluateTriggers || !engine?.execute) return false;

    const payload = buildWorkflowEventPayload(eventType, eventData, "ui-server");
    let triggered = [];
    try {
      triggered = await engine.evaluateTriggers(eventType, payload);
    } catch (err) {
      console.warn(
        `[workflows] trigger evaluation failed for ${eventType}: ${err?.message || err}`,
      );
      return false;
    }

    if (!Array.isArray(triggered) || triggered.length === 0) {
      return false;
    }

    for (const match of triggered) {
      const workflowId = String(match?.workflowId || "").trim();
      if (!workflowId) continue;

      const runPayload = {
        ...payload,
        _triggeredBy: match?.triggeredBy || null,
      };

      Promise.resolve()
        .then(() => engine.execute(workflowId, runPayload))
        .then((ctx) => {
          const runStatus =
            Array.isArray(ctx?.errors) && ctx.errors.length > 0
              ? "failed"
              : "completed";
          console.log(
            `[workflows] auto-run ${runStatus} workflow=${workflowId} runId=${ctx?.id || "unknown"} event=${eventType}`,
          );
        })
        .catch((err) => {
          console.warn(
            `[workflows] auto-run failed workflow=${workflowId} event=${eventType}: ${err?.message || err}`,
          );
        });
    }

    console.log(
      `[workflows] event "${eventType}" triggered ${triggered.length} workflow run(s)`,
    );
    return true;
  } catch (err) {
    console.warn(`[workflows] dispatchWorkflowEvent error for ${eventType}: ${err?.message || err}`);
    return false;
  }
}

function queueWorkflowEvent(eventType, eventData = {}, opts = {}) {
  dispatchWorkflowEvent(eventType, eventData, opts).catch((err) => {
    console.warn(`[workflows] queueWorkflowEvent failure for ${eventType}: ${err?.message || err}`);
  });
}

// ── Vendor module map ─────────────────────────────────────────────────────────
// Served at /vendor/<name>.js — no auth required (public browser libraries).
//
// Resolution order (most reliable → least reliable):
//   1. ui/vendor/<name>  — bundled static files shipped inside the npm package
//   2. node_modules      — createRequire resolution (handles npm hoisting)
//   3. CDN redirect      — last resort for airgap / first-run edge cases
const _require = createRequire(import.meta.url);
const BUNDLED_VENDOR_DIR = resolve(uiRoot, "vendor");

function resolveVendorPath(specifier) {
  // Direct resolution first (works when package exports allow the sub-path)
  try {
    return _require.resolve(specifier);
  } catch (e) {
    if (e.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") return null;
  }
  // ERR_PACKAGE_PATH_NOT_EXPORTED: resolve package root via main entry then locate file
  const isScoped = specifier.startsWith("@");
  const firstSlash = specifier.indexOf("/");
  const secondSlash = isScoped ? specifier.indexOf("/", firstSlash + 1) : firstSlash;
  if (secondSlash === -1) return null;
  const pkgName = specifier.slice(0, secondSlash);
  const filePath = specifier.slice(secondSlash + 1);
  try {
    const pkgMain = _require.resolve(pkgName);
    let dir = dirname(pkgMain);
    while (dir !== dirname(dir)) {
      if (existsSync(resolve(dir, "package.json"))) {
        const candidate = resolve(dir, filePath);
        return existsSync(candidate) ? candidate : null;
      }
      dir = dirname(dir);
    }
  } catch { /* not installed */ }
  return null;
}

const VENDOR_FILES = {
  "preact.js":                { specifier: "preact/dist/preact.module.js",                  cdn: "https://esm.sh/preact@10.25.4" },
  "preact-hooks.js":          { specifier: "preact/hooks/dist/hooks.module.js",              cdn: "https://esm.sh/preact@10.25.4/hooks" },
  "preact-compat.js":         { specifier: "preact/compat/dist/compat.module.js",            cdn: "https://esm.sh/preact@10.25.4/compat" },
  "htm.js":                   { specifier: "htm/dist/htm.module.js",                         cdn: "https://esm.sh/htm@3.1.1" },
  "preact-signals-core.js":   { specifier: "@preact/signals-core/dist/signals-core.module.js", cdn: "https://cdn.jsdelivr.net/npm/@preact/signals-core@1.8.0/dist/signals-core.module.js" },
  "preact-signals.js":        { specifier: "@preact/signals/dist/signals.module.js",         cdn: "https://esm.sh/@preact/signals@1.3.1?deps=preact@10.25.4" },
  "preact-jsx-runtime.js":    { specifier: "preact/jsx-runtime/dist/jsxRuntime.module.js",   cdn: "https://esm.sh/preact@10.25.4/jsx-runtime" },
  "es-module-shims.js":       { specifier: "es-module-shims/dist/es-module-shims.js",        cdn: "https://cdn.jsdelivr.net/npm/es-module-shims@1.10.0/dist/es-module-shims.min.js" },
  // MUI / Emotion — pre-bundled by build-vendor-mui.mjs into ui/vendor/
  "mui-material.js":          { specifier: null, cdn: "https://cdn.jsdelivr.net/npm/@mui/material@5/+esm" },
  "emotion-react.js":         { specifier: null, cdn: "https://cdn.jsdelivr.net/npm/@emotion/react@11/+esm" },
  "emotion-styled.js":        { specifier: null, cdn: "https://cdn.jsdelivr.net/npm/@emotion/styled@11/+esm" },
};

/**
 * Serve a front-end vendor file.
 * No authentication required — these are public browser libraries.
 *
 * Priority:
 *   1. ui/vendor/ bundled file (ships in the npm tarball — fully offline)
 *   2. node_modules via createRequire (global install, hoisted packages)
 *   3. 302 → CDN (last resort; first-run before vendor-sync has run)
 */
async function handleVendor(req, res, url) {
  const name = url.pathname.replace(/^\/vendor\//, "");
  const entry = VENDOR_FILES[name];
  if (!entry) {
    textResponse(res, 404, "Not Found");
    return;
  }

  const headers = {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };

  // ── 1. Bundled static file ──────────────────────────────────────────────────
  const bundledPath = resolve(BUNDLED_VENDOR_DIR, name);
  if (existsSync(bundledPath)) {
    try {
      const data = await readFile(bundledPath);
      res.writeHead(200, { ...headers, "X-Bosun-Vendor": "bundled" });
      res.end(data);
      return;
    } catch { /* fall through */ }
  }

  // ── 2. node_modules resolution ──────────────────────────────────────────────
  const localPath = entry.specifier ? resolveVendorPath(entry.specifier) : null;
  if (localPath && existsSync(localPath)) {
    try {
      const data = await readFile(localPath);
      res.writeHead(200, { ...headers, "X-Bosun-Vendor": "node_modules" });
      res.end(data);
      return;
    } catch (err) {
      textResponse(res, 500, `Vendor error: ${err.message}`);
      return;
    }
  }

  // ── 3. CDN fallback ─────────────────────────────────────────────────────────
  res.writeHead(302, { Location: entry.cdn, "Cache-Control": "no-store" });
  res.end();
}

// ── ESM CDN proxy / cache ─────────────────────────────────────────────────────
// Routes MUI and Emotion imports through the local server instead of requiring
// the browser to fetch directly from esm.sh.  The `?bundle` flag tells esm.sh
// to inline all sub-dependencies into a single file so no further cross-origin
// requests are needed (only bare `react`/`react-dom` remain as external
// imports, resolved by the page's import map to preact-compat).
//
// Resolution:
//   1. Local disk cache (.cache/esm-vendor/<name>)  — instant, fully offline
//   2. Fetch from esm.sh, cache the response, and serve
//   3. 502 if esm.sh is unreachable and no cache exists
const ESM_CACHE_DIR = resolve(repoRoot, ".cache", "esm-vendor");

const ESM_CDN_FILES = {
  "mui-material.js":
    "https://esm.sh/@mui/material@5.15.20?target=es2022&external=react,react-dom,react/jsx-runtime",
  "emotion-react.js": "https://esm.sh/@emotion/react@11?bundle&external=react",
  "emotion-styled.js": "https://esm.sh/@emotion/styled@11?bundle&external=react,react-dom",
};

function normalizeEsmProxyBody(bodyText = "") {
  let body = String(bodyText || "");
  // esm.sh module entrypoints often include absolute specifiers like:
  //   import "/react@..."; export * from "/@mui/material@.../..."
  // When proxied from our origin these incorrectly resolve to our server.
  // Rewrite to absolute esm.sh URLs so nested deps resolve correctly.
  body = body.replace(
    /(import\s+(?:[^"'`]*?\s+from\s+)?["'])\/(?!\/)/g,
    "$1https://esm.sh/",
  );
  body = body.replace(
    /(export\s+(?:\*|\{[^}]*\})\s+from\s+["'])\/(?!\/)/g,
    "$1https://esm.sh/",
  );
  return body;
}

function hasUnsupportedCjsRuntime(bodyText = "") {
  const body = String(bodyText || "");
  return (
    body.includes('Dynamic require of "react"') ||
    body.includes("require(\"react\")") ||
    body.includes("require('react')")
  );
}

function getEsmCachePath(name, cdnUrl) {
  const safeName = String(name || "module.js").replace(/[^a-z0-9_.-]/gi, "_");
  const urlHash = createHash("sha256")
    .update(String(cdnUrl || ""))
    .digest("hex")
    .slice(0, 12);
  const ext = extname(safeName) || ".js";
  const base = safeName.slice(0, safeName.length - ext.length) || "module";
  return resolve(ESM_CACHE_DIR, `${base}.${urlHash}${ext}`);
}

async function handleEsmProxy(req, res, url) {
  const name = url.pathname.replace(/^\/esm\//, "");
  const cdnUrl = ESM_CDN_FILES[name];
  if (!cdnUrl) {
    textResponse(res, 404, "Not Found");
    return;
  }

  const headers = {
    "Content-Type": "application/javascript; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  };

  // ── 1. Disk cache ──────────────────────────────────────────────────────────
  const cachePath = getEsmCachePath(name, cdnUrl);
  if (existsSync(cachePath)) {
    try {
      const cached = String(await readFile(cachePath, "utf8"));
      const normalized = normalizeEsmProxyBody(cached);
      const finalBody = normalized;
      if (cached !== normalized) {
        try {
          mkdirSync(ESM_CACHE_DIR, { recursive: true });
          writeFileSync(cachePath, normalized, "utf8");
        } catch {
          // best effort
        }
      }
      if (hasUnsupportedCjsRuntime(finalBody)) {
        throw new Error("cached ESM bundle contains unsupported dynamic require runtime");
      }
      res.writeHead(200, { ...headers, "X-Bosun-Esm": "cached" });
      res.end(finalBody);
      return;
    } catch { /* fall through to live fetch */ }
  }

  // ── 2. Fetch from esm.sh, cache, and serve ─────────────────────────────────
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const response = await fetch(cdnUrl, {
      signal: controller.signal,
      headers: { "User-Agent": "bosun-esm-proxy/1.0" },
    });
    clearTimeout(timeout);
    if (!response.ok) {
      throw new Error(`esm.sh returned HTTP ${response.status}`);
    }
    const rawBody = await response.text();
    const body = normalizeEsmProxyBody(rawBody);
    if (hasUnsupportedCjsRuntime(body)) {
      throw new Error("esm payload contains unsupported dynamic require runtime");
    }

    // Cache to disk (best-effort, don't fail the request)
    try {
      mkdirSync(ESM_CACHE_DIR, { recursive: true });
      writeFileSync(cachePath, body, "utf8");
    } catch (cacheErr) {
      console.warn(`[ui-server] esm cache write failed: ${cacheErr.message}`);
    }

    res.writeHead(200, { ...headers, "X-Bosun-Esm": "fetched" });
    res.end(body);
  } catch (err) {
    console.warn(`[ui-server] esm proxy failed for ${name}: ${err.message}`);
    textResponse(
      res,
      502,
      `Failed to fetch ${name} from esm.sh CDN: ${err.message}. ` +
        "Run the portal once while online to pre-cache MUI dependencies.",
    );
  }
}

function resolveStatusPath() {
  const moduleStatusPath = resolve(__dirname, "..", ".cache", "ve-orchestrator-status.json");
  const cwdStatusPath = resolve(process.cwd(), ".cache", "ve-orchestrator-status.json");
  return existsSync(moduleStatusPath)
    ? moduleStatusPath
    : existsSync(cwdStatusPath)
      ? cwdStatusPath
      : resolve(repoRoot, ".cache", "ve-orchestrator-status.json");
}
const logsDir = resolve(__dirname, "..", "logs");
const agentLogsDirCandidates = [
  resolve(__dirname, "..", "logs", "agents"),
  resolve(repoRoot, ".cache", "agent-logs"),
];
const CONFIG_SCHEMA_PATH = resolve(__dirname, "..", "bosun.schema.json");
let _configSchema = null;
let _configValidator = null;

function normalizeTriggerTemplateId(template = {}) {
  return String(template?.id || template?.name || "")
    .trim()
    .toLowerCase();
}

function sanitizeTriggerTemplateInput(template = {}) {
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    return {};
  }
  const sanitized = {};
  for (const key of [
    "id",
    "name",
    "description",
    "enabled",
    "action",
    "minIntervalMinutes",
    "trigger",
    "config",
  ]) {
    if (Object.prototype.hasOwnProperty.call(template, key)) {
      sanitized[key] = template[key];
    }
  }
  return sanitized;
}

function normalizeTriggerTemplate(template = {}) {
  const source = sanitizeTriggerTemplateInput(template);
  const id = normalizeTriggerTemplateId(source);
  if (!id) return null;
  return {
    id,
    name: String(source?.name || id).trim() || id,
    description: String(source?.description || "").trim(),
    enabled: source?.enabled === true,
    action: String(source?.action || "create-task").trim(),
    minIntervalMinutes:
      Number.isFinite(Number(source?.minIntervalMinutes)) &&
      Number(source?.minIntervalMinutes) > 0
        ? Number(source.minIntervalMinutes)
        : undefined,
    trigger:
      source?.trigger && typeof source.trigger === "object"
        ? source.trigger
        : { anyOf: [] },
    config:
      source?.config && typeof source.config === "object"
        ? source.config
        : {},
  };
}

function buildTaskStateExportPayload(tasks = [], backend = "unknown") {
  return {
    schemaVersion: 1,
    kind: "bosun-task-state-export",
    exportedAt: new Date().toISOString(),
    backend,
    tasks: Array.isArray(tasks) ? tasks : [],
  };
}

function extractImportedTaskList(body = null) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    if (Array.isArray(body.tasks)) return body.tasks;
    if (Array.isArray(body.backlog)) return body.backlog;
    if (body.data && typeof body.data === "object" && Array.isArray(body.data.tasks)) {
      return body.data.tasks;
    }
  }
  return null;
}

async function importInternalTaskStateSnapshot(body = {}) {
  const taskStore = await ensureTaskStoreApi();
  const addTaskFn = typeof taskStore?.addTask === "function" ? taskStore.addTask : null;
  const updateTaskFn = typeof taskStore?.updateTask === "function" ? taskStore.updateTask : null;
  if (!addTaskFn || !updateTaskFn) {
    throw new Error("Internal task store import is unavailable");
  }

  const tasks = extractImportedTaskList(body);
  if (!Array.isArray(tasks)) {
    throw new Error("JSON must contain an array of tasks (top-level or under 'tasks' key)");
  }

  const mode = String(body?.mode || "merge").trim().toLowerCase();
  if (!["merge", "upsert"].includes(mode)) {
    throw new Error("Only merge/upsert import mode is supported");
  }

  const existingById = new Map(
    getAllInternalTasks()
      .filter((task) => task && task.id)
      .map((task) => [String(task.id), task]),
  );
  const summary = {
    total: tasks.length,
    created: 0,
    updated: 0,
    failed: 0,
  };
  const results = [];

  for (const entry of tasks) {
    const task = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : null;
    const taskId = String(task?.id || "").trim();
    if (!task || !taskId) {
      summary.failed += 1;
      results.push({ id: taskId || null, status: "failed", error: "task.id is required" });
      continue;
    }
    if (!String(task.title || "").trim()) {
      summary.failed += 1;
      results.push({ id: taskId, status: "failed", error: "task.title is required" });
      continue;
    }

    try {
      if (existingById.has(taskId)) {
        updateTaskFn(taskId, task);
        summary.updated += 1;
        results.push({ id: taskId, status: "updated" });
      } else {
        addTaskFn(task);
        existingById.set(taskId, task);
        summary.created += 1;
        results.push({ id: taskId, status: "created" });
      }
    } catch (err) {
      summary.failed += 1;
      results.push({
        id: taskId,
        status: "failed",
        error: err?.message || "import failed",
      });
    }
  }

  if (summary.created > 0 || summary.updated > 0) {
    const waitForWritesFn = typeof taskStore?.waitForStoreWrites === "function"
      ? taskStore.waitForStoreWrites
      : null;
    if (waitForWritesFn) {
      await waitForWritesFn();
    }
  }

  return {
    backend: "internal",
    mode,
    summary,
    results,
  };
}

function readConfigDocument() {
  const configPath = resolveConfigPath();
  let configData = { $schema: "./bosun.schema.json" };
  if (existsSync(configPath)) {
    try {
      configData = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      configData = { $schema: "./bosun.schema.json" };
    }
  }
  if (!configData || typeof configData !== "object") {
    configData = { $schema: "./bosun.schema.json" };
  }
  if (!configData.$schema) {
    configData.$schema = "./bosun.schema.json";
  }
  return { configPath, configData };
}

function resolveUiTriggerSystem() {
  try {
    const cfg = loadConfig([
      "node",
      "bosun",
      "--repo-root",
      repoRoot,
      "--config-dir",
      resolveUiConfigDir(),
    ]);
    const triggerSystem =
      cfg?.triggerSystem && typeof cfg.triggerSystem === "object"
        ? cfg.triggerSystem
        : {};
    return {
      enabled: triggerSystem.enabled === true,
      defaults:
        triggerSystem.defaults && typeof triggerSystem.defaults === "object"
          ? {
              executor: String(triggerSystem.defaults.executor || "auto"),
              model: String(triggerSystem.defaults.model || "auto"),
            }
          : { executor: "auto", model: "auto" },
      templates: Array.isArray(triggerSystem.templates)
        ? triggerSystem.templates
            .map((template) => normalizeTriggerTemplate(template))
            .filter(Boolean)
        : [],
    };
  } catch {
    return {
      enabled: false,
      defaults: { executor: "auto", model: "auto" },
      templates: [],
    };
  }
}

function resolveTriggerStatsTimeoutMs() {
  const parsed = Number(process.env.TELEGRAM_UI_TRIGGER_STATS_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed >= 100) return parsed;
  return 1200;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getTemplateIdFromTask(task = {}) {
  return String(task?.meta?.triggerTemplate?.id || "")
    .trim()
    .toLowerCase();
}

async function collectTriggerTemplateTaskStats(templates = []) {
  const statsByTemplateId = {};
  for (const template of templates) {
    const id = normalizeTriggerTemplateId(template);
    if (!id) continue;
    statsByTemplateId[id] = {
      spawnedTotal: 0,
      activeCount: 0,
      doneCount: 0,
      runningAgents: [],
      recentSpawned: [],
    };
  }
  if (Object.keys(statsByTemplateId).length === 0) {
    return statsByTemplateId;
  }

  try {
    const adapter = getKanbanAdapter();
    const timeoutMs = resolveTriggerStatsTimeoutMs();
    const projects = await withTimeout(
      adapter.listProjects(),
      timeoutMs,
      "trigger stats listProjects",
    );
    const activeProject =
      projects?.[0]?.id || projects?.[0]?.project_id || "";
    if (!activeProject) return statsByTemplateId;

    const tasks = await withTimeout(
      adapter.listTasks(activeProject, {}),
      timeoutMs,
      "trigger stats listTasks",
    );
    const taskById = new Map();

    for (const task of tasks) {
      if (!task?.id) continue;
      const taskId = String(task.id);
      taskById.set(taskId, task);
      const templateId = getTemplateIdFromTask(task);
      if (!templateId || !statsByTemplateId[templateId]) continue;

      const bucket = statsByTemplateId[templateId];
      bucket.spawnedTotal += 1;

      const status = String(task?.status || "").toLowerCase();
      if (["todo", "draft", "inprogress", "inreview", "error"].includes(status)) {
        bucket.activeCount += 1;
      }
      if (["done", "cancelled"].includes(status)) {
        bucket.doneCount += 1;
      }

      const createdAt =
        task?.meta?.triggerTemplate?.createdAt ||
        task?.created_at ||
        task?.createdAt ||
        task?.updated_at ||
        task?.updatedAt ||
        null;

      bucket.recentSpawned.push({
        id: taskId,
        title: task?.title || "",
        status: task?.status || "",
        createdAt,
        executor:
          task?.meta?.execution?.sdk ||
          task?.meta?.execution?.executor ||
          task?.sdk ||
          task?.executor ||
          "",
        model: task?.meta?.execution?.model || task?.model || "",
      });
    }

    const runtimeExecutor = uiDeps.getInternalExecutor?.();
    const activeSlots = runtimeExecutor?.getStatus?.()?.slots || [];
    for (const slot of activeSlots) {
      const slotTaskId = String(slot?.taskId || slot?.task_id || "").trim();
      if (!slotTaskId) continue;
      const task = taskById.get(slotTaskId);
      if (!task) continue;
      const templateId = getTemplateIdFromTask(task);
      if (!templateId || !statsByTemplateId[templateId]) continue;
      statsByTemplateId[templateId].runningAgents.push({
        taskId: slotTaskId,
        taskTitle: slot?.taskTitle || task?.title || "",
        sdk: slot?.sdk || slot?.executor || "",
        model: slot?.model || "",
        startedAt: slot?.startedAt || slot?.started_at || null,
      });
    }

    for (const bucket of Object.values(statsByTemplateId)) {
      bucket.recentSpawned = bucket.recentSpawned
        .sort((a, b) => {
          const ta = Date.parse(a?.createdAt || 0) || 0;
          const tb = Date.parse(b?.createdAt || 0) || 0;
          return tb - ta;
        })
        .slice(0, 6);
    }
  } catch {
    return statsByTemplateId;
  }

  return statsByTemplateId;
}

async function getTriggerTemplatePayload() {
  const triggerSystem = resolveUiTriggerSystem();
  const statsByTemplateId = await collectTriggerTemplateTaskStats(
    triggerSystem.templates,
  );

  const templates = triggerSystem.templates.map((template) => {
    const templateId = normalizeTriggerTemplateId(template);
    return {
      ...template,
      state: {},
      stats: statsByTemplateId[templateId] || {
        spawnedTotal: 0,
        activeCount: 0,
        doneCount: 0,
        runningAgents: [],
        recentSpawned: [],
      },
    };
  });

  return {
    enabled: triggerSystem.enabled === true,
    defaults: triggerSystem.defaults || { executor: "auto", model: "auto" },
    templates,
  };
}

function persistTriggerTemplateUpdate(body = {}) {
  const { configPath, configData } = readConfigDocument();
  const current =
    configData?.triggerSystem && typeof configData.triggerSystem === "object"
      ? configData.triggerSystem
      : {};
  const runtime = resolveUiTriggerSystem();

  const nextTriggerSystem = {
    enabled:
      current.enabled === true ||
      (current.enabled == null && runtime.enabled === true),
    templates: Array.isArray(current.templates)
      ? current.templates
          .map((template) => normalizeTriggerTemplate(template))
          .filter(Boolean)
      : [...runtime.templates],
    defaults:
      current.defaults && typeof current.defaults === "object"
        ? {
            executor: String(current.defaults.executor || runtime.defaults.executor || "auto"),
            model: String(current.defaults.model || runtime.defaults.model || "auto"),
          }
        : { ...runtime.defaults },
  };

  if (typeof body.enabled === "boolean") {
    nextTriggerSystem.enabled = body.enabled;
    process.env.TASK_TRIGGER_SYSTEM_ENABLED = body.enabled ? "true" : "false";
  }

  if (body.defaults && typeof body.defaults === "object") {
    nextTriggerSystem.defaults = {
      executor: String(
        body.defaults.executor || nextTriggerSystem.defaults.executor || "auto",
      ),
      model: String(
        body.defaults.model || nextTriggerSystem.defaults.model || "auto",
      ),
    };
  }

  if (body.template && typeof body.template === "object") {
    const normalized = normalizeTriggerTemplate(body.template);
    if (!normalized) {
      throw new Error("template.id is required");
    }
    const index = nextTriggerSystem.templates.findIndex(
      (template) => normalizeTriggerTemplateId(template) === normalized.id,
    );
    if (index >= 0) {
      nextTriggerSystem.templates[index] = {
        ...nextTriggerSystem.templates[index],
        ...normalized,
      };
    } else {
      nextTriggerSystem.templates.push(normalized);
    }
  }

  configData.triggerSystem = nextTriggerSystem;
  const validator = getConfigValidator();
  if (typeof validator === "function" && !validator(configData)) {
    const firstError = validator.errors?.[0];
    const detail = firstError?.message || "Invalid trigger system config";
    throw new Error(`Schema validation failed: ${detail}`);
  }

  writeFileSync(configPath, JSON.stringify(configData, null, 2) + "\n", "utf8");
  return configPath;
}

function resolveConfigPath() {
  return process.env.BOSUN_CONFIG_PATH
    ? resolve(process.env.BOSUN_CONFIG_PATH)
    : resolve(resolveUiConfigDir(), "bosun.config.json");
}

function getConfigSchema() {
  if (_configSchema) return _configSchema;
  try {
    const raw = readFileSync(CONFIG_SCHEMA_PATH, "utf8");
    _configSchema = JSON.parse(raw);
  } catch {
    _configSchema = null;
  }
  return _configSchema;
}

function getConfigValidator() {
  if (_configValidator) return _configValidator;
  const schema = getConfigSchema();
  if (!schema) return null;
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
    _configValidator = ajv.compile(schema);
  } catch {
    _configValidator = null;
  }
  return _configValidator;
}

function isUnsetValue(value) {
  if (value == null) return true;
  if (Array.isArray(value)) return false;
  return typeof value === "string" && value === "";
}

function toCamelCaseFromEnv(key) {
  const parts = String(key || "").toLowerCase().split("_").filter(Boolean);
  return parts
    .map((part, idx) => (idx === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");
}

function parseExecutorsValue(value) {
  if (Array.isArray(value)) return value;
  const raw = String(value || "").trim();
  if (!raw) return [];
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : value;
    } catch {
      return value;
    }
  }
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  const roles = ["primary", "backup", "tertiary"];
  const executors = [];
  for (let i = 0; i < entries.length; i += 1) {
    const parts = entries[i].split(":").map((part) => part.trim());
    if (parts.length < 2) continue;
    const weight = parts[2] ? Number(parts[2]) : Math.floor(100 / entries.length);
    executors.push({
      name: `${parts[0].toLowerCase()}-${parts[1].toLowerCase()}`,
      executor: parts[0].toUpperCase(),
      variant: parts[1],
      weight: Number.isFinite(weight) ? weight : 0,
      role: roles[i] || `executor-${i + 1}`,
      enabled: true,
    });
  }
  return executors.length ? executors : value;
}

function coerceSettingValue(def, value, propSchema) {
  if (value == null) return value;
  const types = [];
  if (propSchema?.type) {
    if (Array.isArray(propSchema.type)) types.push(...propSchema.type);
    else types.push(propSchema.type);
  }

  if (types.includes("array")) {
    if (def?.key === "EXECUTORS") {
      return parseExecutorsValue(value);
    }
    if (Array.isArray(value)) return value;
    let parts = String(value)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (def?.key === "BOSUN_HOOK_TARGETS") {
      parts = parts.map((part) => part.toLowerCase());
      if (parts.includes("all")) {
        const allowed = Array.isArray(propSchema?.items?.enum)
          ? propSchema.items.enum
          : ["codex", "claude", "copilot"];
        parts = [...allowed];
      }
    }
    return parts;
  }

  if (types.includes("boolean")) {
    if (typeof value === "boolean") return value;
    const normalized = String(value).toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }

  if (types.includes("number") || types.includes("integer")) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }

  if (def?.type === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (def?.type === "boolean") {
    if (typeof value === "boolean") return value;
    const normalized = String(value).toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return value;
}

async function applySharedStateToTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return tasks;
  const states = await getAllSharedStates(repoRoot);
  if (!states || Object.keys(states).length === 0) return tasks;
  return tasks.map((task) => {
    if (!task?.id) return task;
    const state = states[task.id];
    if (!state?.ignoreReason) return task;
    const meta = { ...(task.meta || {}) };
    const codex = { ...(meta.codex || {}) };
    codex.isIgnored = true;
    codex.ignoreReason = state.ignoreReason;
    meta.codex = codex;
    return {
      ...task,
      meta,
      manual: true,
      ignoreReason: state.ignoreReason,
    };
  });
}


function mapTaskStatusToBoardColumn(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "draft") return "draft";
  if (["blocked", "error", "failed"].includes(normalized)) return "blocked";
  if (["inprogress", "in-progress", "working", "active", "assigned", "running"].includes(normalized)) return "inProgress";
  if (["inreview", "in-review", "review", "pr-open", "pr-review"].includes(normalized)) return "inReview";
  if (["done", "completed", "closed", "merged", "cancelled"].includes(normalized)) return "done";
  return "backlog";
}

function normalizeCandidatePath(input) {
  if (!input) return "";
  const raw = String(input).trim();
  if (!raw) return "";
  try {
    return resolve(raw);
  } catch {
    return "";
  }
}

function pickWorkspaceRepoDir(workspace) {
  if (!workspace || typeof workspace !== "object") return "";
  const repos = Array.isArray(workspace.repos) ? workspace.repos : [];
  const activeRepoName = String(workspace.activeRepo || "").trim();
  const selectedRepo =
    (activeRepoName
      ? repos.find((repo) => String(repo?.name || "").trim() === activeRepoName)
      : null) ||
    repos.find((repo) => repo?.primary) ||
    repos[0] ||
    null;

  const candidates = [];
  const selectedRepoPath = normalizeCandidatePath(selectedRepo?.path);
  if (selectedRepoPath) candidates.push(selectedRepoPath);
  const workspacePath = normalizeCandidatePath(workspace.path);
  if (workspacePath && selectedRepo?.name) {
    const joined = normalizeCandidatePath(resolve(workspacePath, String(selectedRepo.name)));
    if (joined) candidates.push(joined);
  }
  if (workspacePath) candidates.push(workspacePath);

  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    if (existsSync(resolve(candidate, ".git"))) return candidate;
  }
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "";
}

function resolveActiveWorkspaceExecutionContext() {
  const fallback = { workspaceId: "", workspaceDir: repoRoot, workspaceRoot: repoRoot };
  const configDir = resolveUiConfigDir();
  if (!configDir) return fallback;

  const explicitWorkspaceDirHint = normalizeCandidatePath(
    process.env.CODEX_MONITOR_HOME
    || process.env.CODEX_MONITOR_DIR
    || process.env.BOSUN_HOME
    || process.env.BOSUN_DIR,
  );

  const listed = listManagedWorkspaces(configDir, { repoRoot });
  const active = getActiveManagedWorkspace(configDir);
  const activeId = String(active?.id || "").trim();
  const workspace =
    (activeId
      ? listed.find((entry) => String(entry?.id || "") === activeId)
      : null) ||
    active ||
    listed[0] ||
    null;
  if (!workspace) {
    if (process.env.VITEST && explicitWorkspaceDirHint) {
      return {
        workspaceId: "",
        workspaceDir: explicitWorkspaceDirHint,
        workspaceRoot: explicitWorkspaceDirHint,
      };
    }
    return fallback;
  }

  const workspaceId = String(workspace.id || "").trim();
  const workspaceDir = pickWorkspaceRepoDir(workspace) || fallback.workspaceDir;
  const workspaceRoot = normalizeCandidatePath(workspace.path) || workspaceDir || fallback.workspaceRoot;
  return {
    workspaceId,
    workspaceDir,
    workspaceRoot,
  };
}

function resolveDefaultRepositoryForWorkspaceContext(workspaceContext = {}) {
  const configDir = resolveUiConfigDir();
  if (!configDir) return "";
  const listed = listManagedWorkspaces(configDir, { repoRoot });
  const workspaceId = String(workspaceContext?.workspaceId || "").trim().toLowerCase();
  const workspace =
    (workspaceId
      ? listed.find((entry) => String(entry?.id || "").trim().toLowerCase() === workspaceId)
      : null) ||
    getActiveManagedWorkspace(configDir) ||
    listed[0] ||
    null;
  if (!workspace) return "";
  return String(
    workspace?.activeRepo ||
      workspace?.repos?.find((repo) => repo?.primary)?.name ||
      workspace?.repos?.[0]?.name ||
      "",
  ).trim();
}

async function resolveDefaultKanbanProjectId(adapter, requestedProjectId = "") {
  const explicitProjectId = String(requestedProjectId || "").trim();
  if (explicitProjectId) return explicitProjectId;
  if (!adapter || typeof adapter.listProjects !== "function") return "";
  try {
    const projects = await adapter.listProjects();
    return String(projects?.[0]?.id || projects?.[0]?.project_id || "").trim();
  } catch {
    return "";
  }
}

function createManualFlowTaskManager(workspaceContext = {}, opts = {}) {
  return {
    async createTask(spec = {}) {
      const title = String(spec?.title || "").trim();
      if (!title) throw new Error("title is required");

      const adapter = getKanbanAdapter();
      const projectId = await resolveDefaultKanbanProjectId(
        adapter,
        opts?.projectId || spec?.projectId || spec?.project || "",
      );
      const labels = normalizeTagsInput(spec?.labels || spec?.tags);
      const workspace = String(
        spec?.workspace || opts?.workspaceId || workspaceContext?.workspaceId || "",
      ).trim();
      const repository = String(
        spec?.repository ||
          spec?.meta?.repository ||
          opts?.repository ||
          resolveDefaultRepositoryForWorkspaceContext(workspaceContext),
      ).trim();
      const repositories = Array.isArray(spec?.repositories)
        ? spec.repositories.filter((value) => typeof value === "string" && value.trim())
        : [];
      const taskPayload = {
        title,
        description: String(spec?.description || ""),
        status: String(spec?.status || "todo").trim() || "todo",
        priority: spec?.priority || undefined,
        ...(workspace ? { workspace } : {}),
        ...(repository ? { repository } : {}),
        ...(repositories.length ? { repositories } : {}),
        ...(labels.length ? { labels, tags: labels } : {}),
        meta: {
          ...(workspace ? { workspace } : {}),
          ...(repository ? { repository } : {}),
          ...(repositories.length ? { repositories } : {}),
          ...(labels.length ? { tags: labels } : {}),
          manualFlowTemplateId: String(opts?.templateId || "").trim() || undefined,
          ...(spec?.meta && typeof spec.meta === "object" ? spec.meta : {}),
        },
      };
      const createdRaw = await adapter.createTask(projectId, taskPayload);
      return withTaskMetadataTopLevel(createdRaw);
    },
  };
}

function resolveWorkspaceContextById(workspaceId = "") {
  const requestedId = String(workspaceId || "").trim().toLowerCase();
  if (!requestedId) return resolveActiveWorkspaceExecutionContext();
  const configDir = resolveUiConfigDir();
  if (!configDir) return null;
  const listed = listManagedWorkspaces(configDir, { repoRoot });
  const workspace = listed.find(
    (entry) => String(entry?.id || "").trim().toLowerCase() === requestedId,
  );
  if (!workspace) return null;
  const id = String(workspace.id || "").trim();
  const workspaceDir = pickWorkspaceRepoDir(workspace) || repoRoot;
  const workspaceRoot = normalizeCandidatePath(workspace.path) || workspaceDir || repoRoot;
  return {
    workspaceId: id,
    workspaceDir,
    workspaceRoot,
  };
}

function resolveWorkspaceContextFromRequest(reqUrl, opts = {}) {
  const allowAll = opts.allowAll !== false;
  const workspaceRaw = String(reqUrl?.searchParams?.get("workspace") || "").trim();
  const workspaceKey = workspaceRaw.toLowerCase();
  if (allowAll && (workspaceKey === "all" || workspaceKey === "*")) {
    return {
      allWorkspaces: true,
      workspaceId: "",
      workspaceDir: repoRoot,
      workspaceFilter: "",
    };
  }
  if (!workspaceKey || workspaceKey === "active") {
    const active = resolveActiveWorkspaceExecutionContext();
    return {
      allWorkspaces: false,
      workspaceId: String(active.workspaceId || "").trim(),
      workspaceDir: normalizeCandidatePath(active.workspaceDir) || repoRoot,
      workspaceRoot: normalizeCandidatePath(active.workspaceRoot) || normalizeCandidatePath(active.workspaceDir) || repoRoot,
      workspaceFilter: String(active.workspaceId || "").trim().toLowerCase(),
    };
  }
  const explicit = resolveWorkspaceContextById(workspaceKey);
  if (!explicit) return null;
  return {
    allWorkspaces: false,
    workspaceId: String(explicit.workspaceId || "").trim(),
    workspaceDir: normalizeCandidatePath(explicit.workspaceDir) || repoRoot,
    workspaceRoot: normalizeCandidatePath(explicit.workspaceRoot) || normalizeCandidatePath(explicit.workspaceDir) || repoRoot,
    workspaceFilter: String(explicit.workspaceId || "").trim().toLowerCase(),
  };
}

function resolveSessionWorkspaceMeta(session) {
  const metadata =
    session && typeof session.metadata === "object" && session.metadata
      ? session.metadata
      : null;
  return {
    workspaceId: String(metadata?.workspaceId || "").trim().toLowerCase(),
    workspaceDir: normalizeCandidatePath(metadata?.workspaceDir),
  };
}

function sessionMatchesWorkspaceContext(session, workspaceContext) {
  if (!session) return false;
  if (!workspaceContext || workspaceContext.allWorkspaces) return true;
  const sessionWorkspace = resolveSessionWorkspaceMeta(session);
  const hasWorkspaceMeta =
    Boolean(sessionWorkspace.workspaceId) || Boolean(sessionWorkspace.workspaceDir);
  if (!hasWorkspaceMeta) {
    // Legacy sessions without workspace metadata are only visible in the
    // primary (first) workspace — not leaked into every workspace.
    const filter = String(workspaceContext.workspaceFilter || "").trim().toLowerCase();
    const primaryId = resolvePrimaryWorkspaceId();
    return !filter || !primaryId || filter === primaryId;
  }
  if (sessionWorkspace.workspaceId) {
    return sessionWorkspace.workspaceId === String(workspaceContext.workspaceFilter || "").trim().toLowerCase();
  }
  const activeWorkspaceDir = normalizeCandidatePath(workspaceContext.workspaceDir);
  if (sessionWorkspace.workspaceDir && activeWorkspaceDir) {
    return sessionWorkspace.workspaceDir === activeWorkspaceDir;
  }
  return !workspaceContext.workspaceFilter;
}

function resolveSessionWorkspaceDir(session = null) {
  const metadata =
    session && typeof session.metadata === "object" && session.metadata
      ? session.metadata
      : null;
  const explicit = normalizeCandidatePath(metadata?.workspaceDir);
  if (explicit && existsSync(explicit)) return explicit;
  const context = resolveActiveWorkspaceExecutionContext();
  return context.workspaceDir || repoRoot;
}

const HIDDEN_GENERATED_WORKFLOW_NAME_SET = new Set([
  "Task trace workflow",
  "Dispatch workflow",
  "WF Dispatch Test",
  "Start alias workflow",
  "Start alias dispatch workflow",
  "Encoded id dispatch workflow",
  "Dispatch start regression",
]);

function shouldHideGeneratedWorkflowFromList(workflow = {}) {
  if (!workflow || typeof workflow !== "object") return false;
  const id = String(workflow.id || "").trim();
  const name = String(workflow.name || "").trim();
  if (
    id.startsWith("wf-task-trace-") ||
    id.startsWith("wf-run-page-") ||
    id.startsWith("wf+dispatch+") ||
    id.startsWith("wf-dispatch-start-") ||
    id.startsWith("wf dispatch ") ||
    id.startsWith("wf start alias ") ||
    id.startsWith("wf start dispatch ") ||
    id.startsWith("workflow dispatch ")
  ) {
    return true;
  }
  if (!workflow.metadata?.installedFrom && HIDDEN_GENERATED_WORKFLOW_NAME_SET.has(name)) {
    return true;
  }
  return false;
}

const WORKFLOW_COPILOT_PROMPT_MAX_CHARS = 6000;

function formatWorkflowCopilotBlock(value, maxChars = WORKFLOW_COPILOT_PROMPT_MAX_CHARS) {
  try {
    const json = JSON.stringify(value, null, 2);
    if (json.length <= maxChars) return json;
    const omitted = json.length - maxChars;
    return `${json.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
  } catch {
    const text = String(value ?? "");
    if (text.length <= maxChars) return text;
    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} chars]`;
  }
}

function formatWorkflowCopilotTimestamp(value) {
  const numeric = Number(value);
  const date =
    Number.isFinite(numeric) && numeric > 0
      ? new Date(numeric)
      : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "—";
}

function buildWorkflowNodeTypeMap(wfMod) {
  const map = new Map();
  try {
    const list = typeof wfMod?.listNodeTypes === "function" ? wfMod.listNodeTypes() : [];
    for (const entry of Array.isArray(list) ? list : []) {
      const type = String(entry?.type || "").trim();
      if (!type) continue;
      map.set(type, entry);
    }
  } catch {}
  return map;
}

function buildWorkflowNodeGraphIndex(workflow = {}) {
  const incoming = new Map();
  const outgoing = new Map();
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  for (const node of nodes) {
    const nodeId = String(node?.id || "").trim();
    if (!nodeId) continue;
    incoming.set(nodeId, []);
    outgoing.set(nodeId, []);
  }
  for (const edge of edges) {
    const sourceId = String(edge?.source || edge?.from || "").trim();
    const targetId = String(edge?.target || edge?.to || "").trim();
    const link = {
      source: sourceId,
      target: targetId,
      sourcePort: String(edge?.sourcePort || edge?.fromPort || "").trim() || "default",
      targetPort: String(edge?.targetPort || edge?.toPort || "").trim() || "default",
    };
    if (sourceId) {
      if (!outgoing.has(sourceId)) outgoing.set(sourceId, []);
      outgoing.get(sourceId).push(link);
    }
    if (targetId) {
      if (!incoming.has(targetId)) incoming.set(targetId, []);
      incoming.get(targetId).push(link);
    }
  }
  return { incoming, outgoing };
}

function summarizeWorkflowNodesForCopilot(workflow = {}, nodeTypeMap = new Map(), limit = 20) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  if (!nodes.length) return "No nodes defined.";
  const lines = nodes.slice(0, limit).map((node, index) => {
    const nodeId = String(node?.id || `node-${index + 1}`).trim();
    const nodeType = String(node?.type || "unknown").trim() || "unknown";
    const nodeName =
      String(node?.label || node?.name || node?.title || "").trim() || null;
    const typeInfo = nodeTypeMap.get(nodeType) || null;
    const configKeys = Object.keys(node?.config || {}).slice(0, 6);
    const schemaKeys = Object.keys(typeInfo?.schema?.properties || {}).slice(0, 6);
    const extras = [];
    if (configKeys.length) extras.push(`config keys: ${configKeys.join(", ")}`);
    if (schemaKeys.length) extras.push(`schema keys: ${schemaKeys.join(", ")}`);
    return `${index + 1}. ${nodeId} [${nodeType}]${nodeName ? ` - ${nodeName}` : ""}${extras.length ? ` (${extras.join(" | ")})` : ""}`;
  });
  if (nodes.length > limit) {
    lines.push(`... ${nodes.length - limit} more node(s) omitted`);
  }
  return lines.join("\n");
}

function summarizeWorkflowEdgesForCopilot(workflow = {}, limit = 24) {
  const edges = Array.isArray(workflow?.edges) ? workflow.edges : [];
  if (!edges.length) return "No edges defined.";
  const lines = edges.slice(0, limit).map((edge, index) => {
    const from = String(edge?.source || edge?.from || "?").trim() || "?";
    const to = String(edge?.target || edge?.to || "?").trim() || "?";
    const fromPort = String(edge?.sourcePort || edge?.fromPort || "").trim();
    const toPort = String(edge?.targetPort || edge?.toPort || "").trim();
    const portSummary = fromPort || toPort ? ` (${fromPort || "default"} -> ${toPort || "default"})` : "";
    return `${index + 1}. ${from} -> ${to}${portSummary}`;
  });
  if (edges.length > limit) {
    lines.push(`... ${edges.length - limit} more edge(s) omitted`);
  }
  return lines.join("\n");
}

function summarizeAdjacentWorkflowLinks(nodeId, graphIndex, direction = "incoming", limit = 10) {
  const collection = direction === "outgoing" ? graphIndex?.outgoing : graphIndex?.incoming;
  const links = Array.isArray(collection?.get(nodeId)) ? collection.get(nodeId) : [];
  if (!links.length) return direction === "outgoing" ? "No downstream edges." : "No upstream edges.";
  const lines = links.slice(0, limit).map((link, index) => {
    const from = String(link?.source || "?").trim() || "?";
    const to = String(link?.target || "?").trim() || "?";
    const fromPort = String(link?.sourcePort || "").trim() || "default";
    const toPort = String(link?.targetPort || "").trim() || "default";
    return `${index + 1}. ${from}:${fromPort} -> ${to}:${toPort}`;
  });
  if (links.length > limit) {
    lines.push(`... ${links.length - limit} more ${direction} edge(s) omitted`);
  }
  return lines.join("\n");
}

function buildWorkflowNodeCopilotPrompt(workflow = {}, node = null, wfMod = null) {
  if (!node) return "";
  const nodeTypeMap = buildWorkflowNodeTypeMap(wfMod);
  const graphIndex = buildWorkflowNodeGraphIndex(workflow);
  const nodeType = String(node?.type || "unknown").trim() || "unknown";
  const typeInfo = nodeTypeMap.get(nodeType) || null;
  const schemaKeys = Object.keys(typeInfo?.schema?.properties || {});
  const workflowName = String(workflow?.name || workflow?.id || "Unknown Workflow").trim();
  return [
    "You are helping inside Bosun with workflow node authoring.",
    "Explain what this node does, how it interacts with adjacent nodes, what is risky or underspecified, and which exact config edits Bosun should make next.",
    "",
    "Return:",
    "1. Node purpose",
    "2. Upstream/downstream interaction notes",
    "3. Risks, missing validation, or bad defaults",
    "4. Concrete config or graph edits",
    "",
    "Workflow Context",
    `- Workflow: ${workflowName}`,
    `- Workflow ID: ${String(workflow?.id || "").trim() || "(unknown)"}`,
    `- Node count: ${Array.isArray(workflow?.nodes) ? workflow.nodes.length : 0}`,
    `- Edge count: ${Array.isArray(workflow?.edges) ? workflow.edges.length : 0}`,
    "",
    "Node Context",
    `- Node ID: ${String(node?.id || "").trim() || "(unknown)"}`,
    `- Label: ${String(node?.label || node?.name || "").trim() || "(none)"}`,
    `- Type: ${nodeType}`,
    `- Category: ${nodeType.split(".")[0] || "unknown"}`,
    `- Description: ${String(typeInfo?.description || "").trim() || "None provided."}`,
    `- Schema keys: ${schemaKeys.length ? schemaKeys.join(", ") : "None"}`,
    "",
    "Upstream Edges",
    summarizeAdjacentWorkflowLinks(String(node?.id || "").trim(), graphIndex, "incoming"),
    "",
    "Downstream Edges",
    summarizeAdjacentWorkflowLinks(String(node?.id || "").trim(), graphIndex, "outgoing"),
    "",
    "Node Config",
    formatWorkflowCopilotBlock(node?.config || {}, 3500),
    "",
    "Raw Node Snapshot",
    formatWorkflowCopilotBlock(node, 3500),
  ].join("\n");
}

function buildWorkflowCopilotContextPayload(workflow = {}, opts = {}) {
  const workflowId = String(workflow?.id || "").trim() || "(unknown)";
  const workflowName = String(workflow?.name || workflowId).trim() || workflowId;
  const description = String(workflow?.description || "").trim() || "None provided.";
  const intent = String(opts?.intent || "explain").trim().toLowerCase();
  const nodeId = String(opts?.nodeId || "").trim();
  const node = nodeId
    ? (Array.isArray(workflow?.nodes) ? workflow.nodes.find((entry) => String(entry?.id || "").trim() === nodeId) : null)
    : null;
  if (nodeId && !node) {
    return null;
  }
  if (node) {
    return {
      prompt: buildWorkflowNodeCopilotPrompt(workflow, node, opts?.wfMod),
      context: {
        scope: "workflow-node",
        intent,
        workflowId,
        workflowName,
        nodeId,
        nodeType: String(node?.type || "").trim() || null,
      },
    };
  }
  const nodeTypeMap = buildWorkflowNodeTypeMap(opts?.wfMod);
  return {
    prompt: [
      "You are helping inside Bosun with a workflow authoring review.",
      "Explain this workflow in plain English, identify the riskiest nodes or missing guardrails, and suggest the smallest high-leverage improvements.",
      "",
      "Return:",
      "1. A concise summary of what the workflow is trying to do",
      "2. The critical nodes or transitions that matter most",
      "3. Failure risks, ambiguity, or missing validation/retry/observability",
      "4. Concrete next edits Bosun should make",
      "",
      "Workflow Context",
      `- Name: ${workflowName}`,
      `- ID: ${workflowId}`,
      `- Enabled: ${workflow?.enabled === false ? "no" : "yes"}`,
      `- Core workflow: ${workflow?.core === true ? "yes" : "no"}`,
      `- Description: ${description}`,
      `- Node count: ${Array.isArray(workflow?.nodes) ? workflow.nodes.length : 0}`,
      `- Edge count: ${Array.isArray(workflow?.edges) ? workflow.edges.length : 0}`,
      "",
      "Variables",
      formatWorkflowCopilotBlock(workflow?.variables || {}, 2500),
      "",
      "Node Summary",
      summarizeWorkflowNodesForCopilot(workflow, nodeTypeMap),
      "",
      "Edge Summary",
      summarizeWorkflowEdgesForCopilot(workflow),
      "",
      "Raw Workflow Snapshot",
      formatWorkflowCopilotBlock({
        id: workflow?.id,
        name: workflow?.name,
        description: workflow?.description,
        enabled: workflow?.enabled,
        core: workflow?.core,
        metadata: workflow?.metadata || {},
      }, 2500),
    ].join("\n"),
    context: {
      scope: "workflow",
      intent,
      workflowId,
      workflowName,
    },
  };
}

function summarizeRunNodeStatusesForCopilot(run = {}, limit = 25) {
  const statuses = run?.detail?.nodeStatuses && typeof run.detail.nodeStatuses === "object"
    ? run.detail.nodeStatuses
    : {};
  const entries = Object.entries(statuses);
  if (!entries.length) return "No node status data recorded.";
  const lines = entries.slice(0, limit).map(([nodeId, status], index) => (
    `${index + 1}. ${nodeId}: ${String(status || "unknown").trim() || "unknown"}`
  ));
  if (entries.length > limit) {
    lines.push(`... ${entries.length - limit} more node status entries omitted`);
  }
  return lines.join("\n");
}

function summarizeRunNodeOutputsForCopilot(run = {}, limit = 12) {
  const outputs = run?.detail?.nodeOutputs && typeof run.detail.nodeOutputs === "object"
    ? run.detail.nodeOutputs
    : {};
  const entries = Object.entries(outputs);
  if (!entries.length) return "No node outputs recorded.";
  const lines = entries.slice(0, limit).map(([nodeId, output], index) => {
    const summary = String(output?.summary || "").trim();
    const narrative = String(output?.narrative || "").trim();
    if (summary || narrative) {
      const parts = [summary, narrative].filter(Boolean);
      return `${index + 1}. ${nodeId}: ${parts.join(" | ")}`;
    }
    return `${index + 1}. ${nodeId}: ${formatWorkflowCopilotBlock(output, 500)}`;
  });
  if (entries.length > limit) {
    lines.push(`... ${entries.length - limit} more node output entries omitted`);
  }
  return lines.join("\n");
}

function summarizeRunExecutionInsightsForCopilot(run = {}, limit = 12) {
  const issueAdvisor =
    run?.detail?.issueAdvisor && typeof run.detail.issueAdvisor === "object"
      ? run.detail.issueAdvisor
      : null;
  const dagCounts =
    run?.detail?.dagState?.counts && typeof run.detail.dagState.counts === "object"
      ? run.detail.dagState.counts
      : null;
  const ledgerEvents = Array.isArray(run?.ledger?.events) ? run.ledger.events : [];
  const lines = [
    `- Root run: ${String(run?.rootRunId || run?.detail?.dagState?.rootRunId || "—")}`,
    `- Parent run: ${String(run?.parentRunId || run?.detail?.dagState?.parentRunId || "—")}`,
    `- Retry of: ${String(run?.retryOf || run?.detail?.dagState?.retryOf || "—")}`,
    `- Retry mode: ${String(run?.retryMode || run?.detail?.dagState?.retryMode || "—")}`,
    `- Retry decision reason: ${String(run?.retryDecisionReason || "—")}`,
    `- Issue advisor action: ${String(issueAdvisor?.recommendedAction || "—")}`,
    `- Issue advisor summary: ${String(issueAdvisor?.summary || "None recorded.")}`,
  ];
  if (dagCounts) {
    lines.push(`- DAG counts: completed=${Number(dagCounts.completed ?? 0) || 0}, failed=${Number(dagCounts.failed ?? 0) || 0}, skipped=${Number(dagCounts.skipped ?? 0) || 0}, active=${Number(dagCounts.active ?? 0) || 0}`);
  }
  if (ledgerEvents.length) {
    lines.push("");
    lines.push("Recent Ledger Events");
    for (const event of ledgerEvents.slice(-limit)) {
      const eventParts = [String(event?.eventType || "event").trim() || "event"];
      if (event?.nodeId) eventParts.push(`node=${String(event.nodeId).trim()}`);
      if (event?.status) eventParts.push(`status=${String(event.status).trim()}`);
      if (event?.retryMode) eventParts.push(`mode=${String(event.retryMode).trim()}`);
      if (event?.error) eventParts.push(`error=${String(event.error).trim()}`);
      lines.push(`- ${event?.timestamp ? formatWorkflowCopilotTimestamp(event.timestamp) : "unknown time"} · ${eventParts.join(" · ")}`);
    }
  }
  return lines.join("\n");
}

function summarizeRetryOptionsForCopilot(retryOptions = {}) {
  const options = Array.isArray(retryOptions?.options) ? retryOptions.options : [];
  if (!options.length) return "No retry options available.";
  const lines = [
    `Recommended mode: ${String(retryOptions?.recommendedMode || "—")}`,
    `Recommended reason: ${String(retryOptions?.recommendedReason || "—")}`,
    retryOptions?.summary ? `Summary: ${String(retryOptions.summary)}` : null,
    "Options:",
    ...options.map((option) => {
      const mode = String(option?.mode || "").trim() || "(unknown)";
      const label = String(option?.label || mode).trim() || mode;
      const description = String(option?.description || "").trim();
      const suffix = option?.recommended ? " [recommended]" : "";
      return `- ${mode}: ${label}${suffix}${description ? ` — ${description}` : ""}`;
    }),
  ].filter(Boolean);
  return lines.join("\n");
}

function buildRunNodeCopilotPrompt(run = {}, workflow = {}, nodeId = "", opts = {}) {
  const safeNodeId = String(nodeId || "").trim();
  if (!safeNodeId) return "";
  const workflowNode = Array.isArray(workflow?.nodes)
    ? workflow.nodes.find((node) => String(node?.id || "").trim() === safeNodeId) || null
    : null;
  const nodeStatuses = run?.detail?.nodeStatuses && typeof run.detail.nodeStatuses === "object"
    ? run.detail.nodeStatuses
    : {};
  const nodeOutputs = run?.detail?.nodeOutputs && typeof run.detail.nodeOutputs === "object"
    ? run.detail.nodeOutputs
    : {};
  const rawErrors = Array.isArray(run?.detail?.errors) ? run.detail.errors : [];
  const relatedErrors = rawErrors.filter((entry) => formatWorkflowCopilotBlock(entry, 500).includes(safeNodeId));
  const failed = String(opts?.intent || "").trim().toLowerCase() === "fix"
    || String(nodeStatuses[safeNodeId] || "").trim().toLowerCase() === "failed";
  return [
    "You are helping inside Bosun with workflow run node analysis.",
    failed
      ? "Diagnose why this node failed or behaved incorrectly, identify the root cause, and propose the smallest concrete fix Bosun should make."
      : "Explain what happened in this node during the run, what inputs or outputs matter, and what Bosun should inspect next.",
    "",
    "Return:",
    "1. Short diagnosis",
    "2. Evidence from this node",
    failed ? "3. Concrete fix plan" : "3. Recommended next checks",
    failed ? "4. Retry advice for this node or run" : "4. Risks or follow-up notes",
    "",
    "Run Context",
    `- Workflow ID: ${String(run?.workflowId || "").trim() || "(unknown)"}`,
    `- Run ID: ${String(run?.runId || "").trim() || "(unknown)"}`,
    `- Run status: ${String(run?.status || "unknown").trim() || "unknown"}`,
    `- Started: ${formatWorkflowCopilotTimestamp(run?.startedAt)}`,
    `- Finished: ${run?.endedAt ? formatWorkflowCopilotTimestamp(run.endedAt) : "Running"}`,
    "",
    "Node Context",
    `- Node ID: ${safeNodeId}`,
    `- Node label: ${String(workflowNode?.label || workflowNode?.name || "").trim() || "(none)"}`,
    `- Node type: ${String(workflowNode?.type || "").trim() || "(unknown)"}`,
    `- Node status: ${String(nodeStatuses[safeNodeId] || "unknown").trim() || "unknown"}`,
    "",
    "Node Config",
    formatWorkflowCopilotBlock(workflowNode?.config || {}, 2500),
    "",
    "Node Output",
    formatWorkflowCopilotBlock(nodeOutputs[safeNodeId] ?? null, 3500),
    "",
    "Node Errors",
    formatWorkflowCopilotBlock(relatedErrors.length ? relatedErrors : rawErrors.slice(0, 8), 3000),
    "",
    "Execution Insights",
    summarizeRunExecutionInsightsForCopilot(run, 8),
    "",
    "Retry Guidance",
    summarizeRetryOptionsForCopilot(opts?.retryOptions || null),
    "",
    "Remediation",
    formatWorkflowCopilotBlock(opts?.evaluation?.remediation || null, 3500),
    "",
    "Node Forensics",
    formatWorkflowCopilotBlock(opts?.forensics || null, 3500),
  ].join("\n");
}

function buildRunCopilotContextPayload(run = {}, opts = {}) {
  const workflow = opts?.workflow || {};
  const workflowId = String(run?.workflowId || workflow?.id || "").trim() || "(unknown)";
  const workflowName = String(run?.workflowName || workflow?.name || workflowId).trim() || workflowId;
  const intent = String(opts?.intent || "ask").trim().toLowerCase();
  const nodeId = String(opts?.nodeId || "").trim();
  if (nodeId) {
    const evaluation = opts?.evaluation || null;
    const retryOptions = opts?.retryOptions || null;
    return {
      prompt: buildRunNodeCopilotPrompt(run, workflow, nodeId, {
        intent,
        forensics: opts?.nodeForensics || null,
        evaluation,
        retryOptions,
      }),
      context: {
        scope: "run-node",
        intent,
        runId: String(run?.runId || "").trim() || "(unknown)",
        workflowId,
        workflowName,
        nodeId,
        issueAdvisor: run?.detail?.issueAdvisor || null,
        retryOptions,
        evaluation,
        actions: Array.isArray(evaluation?.remediation?.fixActions)
          ? evaluation.remediation.fixActions.filter((action) => String(action?.nodeId || "").trim() === nodeId)
          : [],
      },
    };
  }
  const errors = Array.isArray(run?.detail?.errors) ? run.detail.errors : [];
  const logs = Array.isArray(run?.detail?.logs) ? run.detail.logs : [];
  const failed = intent === "fix" || String(run?.status || "").trim().toLowerCase() === "failed";
  const evaluation = opts?.evaluation || null;
  const retryOptions = opts?.retryOptions || null;
  return {
    prompt: [
      "You are helping inside Bosun with workflow run analysis.",
      failed
        ? "Analyze why this workflow run failed. Identify the root cause, name the most likely failing node or nodes, propose the smallest concrete fix, and say whether Bosun should retry from failed state or rerun from the beginning."
        : "Explain what happened in this workflow run, call out unusual or risky behavior, and suggest the next debugging or hardening steps.",
      "",
      "Return:",
      "1. Short diagnosis",
      "2. Evidence from the run",
      failed ? "3. Concrete fix plan" : "3. Recommended next steps",
      failed ? "4. Retry advice: retry from failed, rerun from start, or do not retry yet" : "4. Risks or follow-up checks",
      "",
      "Run Context",
      `- Workflow: ${workflowName}`,
      `- Workflow ID: ${workflowId}`,
      `- Run ID: ${String(run?.runId || "").trim() || "(unknown)"}`,
      `- Status: ${String(run?.status || "unknown").trim() || "unknown"}`,
      `- Started: ${formatWorkflowCopilotTimestamp(run?.startedAt)}`,
      `- Finished: ${run?.endedAt ? formatWorkflowCopilotTimestamp(run.endedAt) : "Running"}`,
      `- Duration (ms): ${Number.isFinite(Number(run?.duration)) ? Number(run.duration) : 0}`,
      `- Active nodes: ${Number(run?.activeNodeCount || 0)}`,
      `- Error count: ${Number(run?.errorCount || errors.length)}`,
      `- Log count: ${Number(run?.logCount || logs.length)}`,
      "",
      "Execution Insights",
      summarizeRunExecutionInsightsForCopilot(run),
      "",
      "Retry Guidance",
      summarizeRetryOptionsForCopilot(retryOptions),
      "",
      "Node Statuses",
      summarizeRunNodeStatusesForCopilot(run),
      "",
      "Node Output Summaries",
      summarizeRunNodeOutputsForCopilot(run),
      "",
      "Errors",
      formatWorkflowCopilotBlock(errors.slice(0, 8), 3500),
      "",
      "Recent Logs",
      formatWorkflowCopilotBlock(logs.slice(-40), 4000),
      "",
      "Run Forensics",
      formatWorkflowCopilotBlock(opts?.runForensics || null, 3000),
      "",
      "Evaluation",
      formatWorkflowCopilotBlock(evaluation || null, 3500),
    ].join("\n"),
    context: {
      scope: "run",
      intent,
      runId: String(run?.runId || "").trim() || "(unknown)",
      workflowId,
      workflowName,
      issueAdvisor: run?.detail?.issueAdvisor || null,
      retryOptions,
      evaluation,
      actions: Array.isArray(evaluation?.remediation?.fixActions)
        ? evaluation.remediation.fixActions
        : [],
    },
  };
}

function normalizeWorktreePath(input) {
  if (!input) return "";
  try {
    return resolve(String(input));
  } catch {
    return String(input);
  }
}

function findWorktreeMatch(worktrees, { path, branch, taskKey }) {
  const normalizedPath = normalizeWorktreePath(path);
  if (normalizedPath) {
    const byPath = worktrees.find((wt) => normalizeWorktreePath(wt.path) === normalizedPath);
    if (byPath) return byPath;
  }
  if (taskKey) {
    const byKey = worktrees.find((wt) => String(wt.taskKey || "") === String(taskKey));
    if (byKey) return byKey;
  }
  if (branch) {
    const normalizedBranch = String(branch || "").replace(/^refs\/heads\//, "");
    const byBranch = worktrees.find((wt) => String(wt.branch || "") === normalizedBranch);
    if (byBranch) return byBranch;
  }
  return null;
}

async function buildWorktreePeek(wt) {
  const cwd = wt?.path;
  if (!cwd) return null;
  let gitStatus = "";
  let filesChanged = 0;
  try {
    const status = spawnSync("git", ["status", "--short"], {
      cwd,
      encoding: "utf8",
      timeout: 10_000,
    });
    if (status.status === 0 && status.stdout) {
      gitStatus = status.stdout.trim();
      filesChanged = gitStatus ? gitStatus.split("\n").filter(Boolean).length : 0;
    }
  } catch {
    // best effort
  }

  const diffStats = collectDiffStats(cwd);
  const diffSummary = diffStats?.formatted || "";
  const recentCommits = getRecentCommits(cwd, 6);
  const lastCommit = recentCommits[0] || "";

  const tracker = getSessionTracker();
  const sessions = tracker
    .listAllSessions()
    .filter((s) => s.taskId === wt.taskKey || s.id === wt.taskKey);

  return {
    ...wt,
    gitStatus,
    filesChanged,
    diffSummary,
    diffStats,
    recentCommits,
    lastCommit,
    sessions,
  };
}

function getSchemaProperty(schema, pathParts) {
  let current = schema;
  for (const part of pathParts) {
    if (!current || !current.properties) return null;
    current = current.properties[part];
  }
  return current || null;
}

const ROOT_SKIP_ENV_KEYS = new Set([]);
const ROOT_OVERRIDE_MAP = {
  BOSUN_MODE: "mode",
  EXECUTOR_DISTRIBUTION: "distribution",
};
const INTERNAL_EXECUTOR_MAP = {
  PARALLEL: ["internalExecutor", "maxParallel"],
  SDK: ["internalExecutor", "sdk"],
  TIMEOUT_MS: ["internalExecutor", "taskTimeoutMs"],
  MAX_RETRIES: ["internalExecutor", "maxRetries"],
  POLL_MS: ["internalExecutor", "pollIntervalMs"],
  REVIEW_AGENT_ENABLED: ["internalExecutor", "reviewAgentEnabled"],
  REPLENISH_ENABLED: ["internalExecutor", "backlogReplenishment", "enabled"],
  STREAM_MAX_RETRIES: ["internalExecutor", "stream", "maxRetries"],
  STREAM_RETRY_BASE_MS: ["internalExecutor", "stream", "retryBaseMs"],
  STREAM_RETRY_MAX_MS: ["internalExecutor", "stream", "retryMaxMs"],
  STREAM_FIRST_EVENT_TIMEOUT_MS: [
    "internalExecutor",
    "stream",
    "firstEventTimeoutMs",
  ],
  STREAM_MAX_ITEMS_PER_TURN: ["internalExecutor", "stream", "maxItemsPerTurn"],
  STREAM_MAX_ITEM_CHARS: ["internalExecutor", "stream", "maxItemChars"],
};
const CONFIG_PATH_OVERRIDES = {
  EXECUTOR_MODE: ["internalExecutor", "mode"],
  PROJECT_REQUIREMENTS_PROFILE: ["projectRequirements", "profile"],

};
const ROOT_PREFIX_ALLOWLIST = [
  "TELEGRAM_",
  "FLEET_",
  "VE_",
];

const AUTH_ENV_PREFIX_MAP = {
  CODEX: "codex",
  CLAUDE: "claude",
  COPILOT: "copilot",
};

function buildConfigPath(pathParts, allowUnknownSchema = false) {
  return { pathParts, allowUnknownSchema };
}

function mapEnvKeyToConfigPath(key, schema) {
  if (!schema?.properties) return null;
  const envKey = String(key || "").toUpperCase();

  if (ROOT_SKIP_ENV_KEYS.has(envKey)) return null;

  const overridePath = CONFIG_PATH_OVERRIDES[envKey];
  if (overridePath) {
    return buildConfigPath(overridePath, true);
  }

  if (envKey.startsWith("INTERNAL_EXECUTOR_")) {
    const rest = envKey.slice("INTERNAL_EXECUTOR_".length);
    const internalPath = INTERNAL_EXECUTOR_MAP[rest];
    if (internalPath) {
      return buildConfigPath(internalPath, true);
    }
  }

  if (ROOT_OVERRIDE_MAP[envKey] && schema.properties[ROOT_OVERRIDE_MAP[envKey]]) {
    return buildConfigPath([ROOT_OVERRIDE_MAP[envKey]]);
  }
  if (envKey.startsWith("FAILOVER_") && schema.properties.failover?.properties) {
    const rest = envKey.slice("FAILOVER_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (schema.properties.failover.properties[sub]) return buildConfigPath(["failover", sub]);
  }
  if (envKey.startsWith("BOSUN_PROMPT_") && schema.properties.agentPrompts?.properties) {
    const rest = envKey.slice("BOSUN_PROMPT_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (schema.properties.agentPrompts.properties[sub]) {
      return buildConfigPath(["agentPrompts", sub]);
    }
  }
  if (envKey.endsWith("_AUTH_SOURCES") || envKey.endsWith("_AUTH_FALLBACK_INTERACTIVE")) {
    const match = envKey.match(/^(CODEX|CLAUDE|COPILOT)_AUTH_(SOURCES|FALLBACK_INTERACTIVE)$/);
    if (match && schema.properties.auth?.properties) {
      const provider = AUTH_ENV_PREFIX_MAP[match[1]];
      const sub = match[2] === "SOURCES" ? "sources" : "fallbackToInteractive";
      const propSchema = schema.properties.auth?.properties?.[provider]?.properties;
      if (propSchema?.[sub]) {
        return buildConfigPath(["auth", provider, sub]);
      }
    }
  }
  const hookProfileMap = {
    BOSUN_HOOK_PROFILE: ["hookProfiles", "profile"],
    BOSUN_HOOK_TARGETS: ["hookProfiles", "targets"],
    BOSUN_HOOKS_ENABLED: ["hookProfiles", "enabled"],
    BOSUN_HOOKS_OVERWRITE: ["hookProfiles", "overwriteExisting"],
  };
  if (hookProfileMap[envKey]) {
    const pathParts = hookProfileMap[envKey];
    const propSchema = getSchemaProperty(schema, pathParts);
    if (propSchema) return buildConfigPath(pathParts);
  }
  const rootKey = toCamelCaseFromEnv(envKey);
  if (schema.properties[rootKey]) return buildConfigPath([rootKey]);
  if (ROOT_PREFIX_ALLOWLIST.some((prefix) => envKey.startsWith(prefix))) {
    return buildConfigPath([rootKey], true);
  }
  if (envKey.startsWith("KANBAN_") && schema.properties.kanban?.properties) {
    const rest = envKey.slice("KANBAN_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (schema.properties.kanban.properties[sub]) return buildConfigPath(["kanban", sub]);
  }
  if (envKey.startsWith("JIRA_STATUS_")) {
    const jiraSchema = schema.properties.kanban?.properties?.jira?.properties?.statusMapping?.properties;
    const rest = envKey.slice("JIRA_STATUS_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (jiraSchema?.[sub]) return buildConfigPath(["kanban", "jira", "statusMapping", sub]);
  }
  if (envKey.startsWith("JIRA_LABEL_")) {
    const jiraSchema = schema.properties.kanban?.properties?.jira?.properties?.labels?.properties;
    const rest = envKey.slice("JIRA_LABEL_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (jiraSchema?.[sub]) return buildConfigPath(["kanban", "jira", "labels", sub]);
  }
  if (envKey.startsWith("JIRA_")) {
    const jiraSchema = schema.properties.kanban?.properties?.jira?.properties;
    const rest = envKey.slice("JIRA_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (jiraSchema?.[sub]) return buildConfigPath(["kanban", "jira", sub]);
  }
  if (envKey.startsWith("GITHUB_PROJECT_")) {
    const projectSchema = schema.properties.kanban?.properties?.github?.properties?.project?.properties;
    const rest = envKey.slice("GITHUB_PROJECT_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (projectSchema?.[sub]) return buildConfigPath(["kanban", "github", "project", sub]);
  }
  if (envKey.startsWith("GITHUB_PROJECT_WEBHOOK_")) {
    const webhookSchema = schema.properties.kanban?.properties?.github?.properties?.project?.properties?.webhook?.properties;
    const rest = envKey.slice("GITHUB_PROJECT_WEBHOOK_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (webhookSchema?.[sub]) return buildConfigPath(["kanban", "github", "project", "webhook", sub]);
  }
  if (envKey.startsWith("GITHUB_PROJECT_SYNC_")) {
    const syncSchema = schema.properties.kanban?.properties?.github?.properties?.project?.properties?.syncMonitoring?.properties;
    const rest = envKey.slice("GITHUB_PROJECT_SYNC_".length);
    const sub = toCamelCaseFromEnv(rest);
    if (syncSchema?.[sub]) return buildConfigPath(["kanban", "github", "project", "syncMonitoring", sub]);
  }
  return null;
}

function setConfigPathValue(obj, pathParts, value) {
  let cursor = obj;
  for (let i = 0; i < pathParts.length; i += 1) {
    const part = pathParts[i];
    if (i === pathParts.length - 1) {
      cursor[part] = value;
      return;
    }
    if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part];
  }
}

function unsetConfigPathValue(obj, pathParts) {
  let cursor = obj;
  const stack = [];
  for (let i = 0; i < pathParts.length; i += 1) {
    const part = pathParts[i];
    if (!cursor || typeof cursor !== "object") return;
    if (i === pathParts.length - 1) {
      delete cursor[part];
      break;
    }
    stack.push({ parent: cursor, key: part });
    cursor = cursor[part];
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const { parent, key } = stack[i];
    if (
      parent[key] &&
      typeof parent[key] === "object" &&
      Object.keys(parent[key]).length === 0
    ) {
      delete parent[key];
    } else {
      break;
    }
  }
}

const DEFAULT_TELEGRAM_UI_PORT = 3080;

// Read port lazily — .env may not be loaded at module import time
function getDefaultPort() {
  const raw = Number(process.env.TELEGRAM_UI_PORT || "");
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_TELEGRAM_UI_PORT;
}
const DEFAULT_HOST = process.env.TELEGRAM_UI_HOST || "0.0.0.0";
// Lazy evaluation — .env may not be loaded yet when this module is first imported
function isAllowUnsafe() {
  return ["1", "true", "yes"].includes(
    String(process.env.TELEGRAM_UI_ALLOW_UNSAFE || "").toLowerCase(),
  );
}
const AUTH_MAX_AGE_SEC = Number(
  process.env.TELEGRAM_UI_AUTH_MAX_AGE_SEC || "86400",
);
const PRESENCE_TTL_MS =
  Number(process.env.TELEGRAM_PRESENCE_TTL_SEC || "180") * 1000;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".zip": "application/zip",
};

let uiServer = null;
let uiServerUrl = null;
let uiServerTls = false;
let wsServer = null;
/** Auto-open browser: only once per process, never during tests */
let _browserOpened = false;
const AUTO_OPEN_MARKER_FILE = "ui-auto-open.json";
const UI_INSTANCE_LOCK_FILE = "ui-server.instance.lock.json";
const UI_SESSION_TOKEN_FILE = "ui-session-token.json";
const UI_LAST_PORT_FILE = "ui-last-port.json";
const DEFAULT_AUTO_OPEN_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12h
const DEFAULT_SESSION_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const wsClients = new Set();
let sessionListenerAttached = false;
let sessionAccumulatorListenerAttached = false;
/** @type {ReturnType<typeof setInterval>|null} */
let wsHeartbeatTimer = null;
const WORKFLOW_WS_BATCH_MS = 80;
const workflowWsBatchByKey = new Map();
const workflowEngineListenerCleanup = new WeakMap();
let workflowWsSeq = 0;
let uiInstanceLockPath = "";
let uiInstanceLockHeld = false;

// ── Unified setup state (entrypoint integration) ────────────────────────────
// When running via entrypoint.mjs, `_setupMode` starts true and flips to false
// once the wizard completes.  In standalone ui-server mode, it's always false.
let _setupMode = false;
/** @type {(() => void)|null} */
let _setupOnComplete = null;
let _sessionTokenLastTouchedAt = 0;
let _localRequestAddressCache = {
  loadedAt: 0,
  addresses: new Set(["127.0.0.1", "::1"]),
};

/* ─── Log Streaming State ─── */
/** Map<string, { sockets: Set<WebSocket>, offset: number, pollTimer }> keyed by filePath */
const logStreamers = new Map();
let uiDeps = {};

async function resolveVoiceRelay() {
  const moduleRelay = await import("../voice/voice-relay.mjs");
  let injectedRelay = null;
  if (uiDeps?.voiceRelay && typeof uiDeps.voiceRelay === "object") {
    injectedRelay = uiDeps.voiceRelay;
  } else if (typeof uiDeps?.getVoiceRelay === "function") {
    try {
      const resolved = await Promise.resolve(uiDeps.getVoiceRelay());
      if (resolved && typeof resolved === "object") {
        injectedRelay = resolved;
      }
    } catch {
      // best effort
    }
  }

  // Preserve support for partial test doubles by falling back to module methods
  // whenever an injected relay does not define an API used by a route.
  if (!injectedRelay) return moduleRelay;
  return {
    ...moduleRelay,
    ...injectedRelay,
  };
}

/**
 * Resolve the execPrimaryPrompt function. Prefers the injected dependency,
 * falls back to importing directly from primary-agent.mjs so the chat
 * agent works even when the UI server starts standalone.
 */
let _fallbackExecPrimaryPrompt = null;
/** Track in-flight chat turns so /api/sessions/:id/stop can abort them. */
const sessionRunAbortControllers = new Map();
let _activeSessions = [];

function getLiveSessionSnapshot({ includeHidden = false } = {}) {
  const tracker = getSessionTracker();
  let sessions = tracker.listAllSessions();
  if (!includeHidden) {
    sessions = sessions.filter((session) => {
      const detailed = tracker.getSessionById(session.id) || session;
      return !shouldHideSessionFromDefaultList(detailed);
    });
  }
  return sessions;
}

function broadcastSessionsSnapshot(sessions = getLiveSessionSnapshot()) {
  const normalized = Array.isArray(sessions) ? sessions : [];
  broadcastUiEvent(["sessions", "tui"], "sessions:update", {
    sessions: normalized,
  });
}

function updateActiveSessions(sessions) {
  _activeSessions = Array.isArray(sessions) ? sessions : [];
  broadcastSessionsSnapshot(_activeSessions);
  for (const session of _activeSessions) {
    broadcastUiEvent(["sessions", "tui"], "session:update", session);
  }
}

async function resolveExecPrimaryPrompt() {
  if (typeof uiDeps.execPrimaryPrompt === "function") return uiDeps.execPrimaryPrompt;
  if (_fallbackExecPrimaryPrompt) return _fallbackExecPrimaryPrompt;
  try {
    const mod = await import("../agent/primary-agent.mjs");
    if (typeof mod.execPrimaryPrompt === "function") {
      _fallbackExecPrimaryPrompt = mod.execPrimaryPrompt;
      console.log("[ui-server] loaded execPrimaryPrompt fallback from primary-agent.mjs");
      return _fallbackExecPrimaryPrompt;
    }
  } catch (err) {
    console.warn("[ui-server] failed to load execPrimaryPrompt fallback:", err.message);
  }
  return null;
}

/**
 * Resolve the bosun config directory. Falls back through:
 *   1. uiDeps.configDir (explicitly injected at server start)
 *   2. BOSUN_CONFIG_PATH parent directory
 *   3. repo-local config when REPO_ROOT explicitly points at a managed repo
 *   4. BOSUN_HOME/BOSUN_DIR/test sandbox/default home dir
 * Ensures the directory exists.
 */
function resolveUiConfigDir() {
  const sandbox = ensureTestRuntimeSandbox();
  if (uiDeps.configDir) {
    const injectedDir = resolve(String(uiDeps.configDir));
    try { mkdirSync(injectedDir, { recursive: true }); } catch { /* ok */ }
    return injectedDir;
  }
  if (process.env.BOSUN_CONFIG_PATH) {
    const fromConfigPath = dirname(resolve(process.env.BOSUN_CONFIG_PATH));
    try { mkdirSync(fromConfigPath, { recursive: true }); } catch { /* ok */ }
    return fromConfigPath;
  }
  if (String(process.env.REPO_ROOT || "").trim()) {
    const repoLocalConfigDirCandidates = [
      resolve(repoRoot, ".bosun"),
      repoRoot,
    ];
    for (const candidate of repoLocalConfigDirCandidates) {
      try {
        if (!existsSync(resolve(candidate, "bosun.config.json"))) continue;
        mkdirSync(candidate, { recursive: true });
        return candidate;
      } catch {
        // Fall through to the next candidate.
      }
    }
  }
  const isWslInteropRuntime = Boolean(
    process.env.WSL_DISTRO_NAME
    || process.env.WSL_INTEROP
    || (process.platform === "win32"
      && String(process.env.HOME || "")
        .trim()
        .startsWith("/home/")),
  );
  const preferWindowsDirs = process.platform === "win32" && !isWslInteropRuntime;
  const baseDir = preferWindowsDirs
    ? process.env.APPDATA
      || process.env.LOCALAPPDATA
      || process.env.USERPROFILE
      || process.env.HOME
      || homedir()
    : process.env.HOME
      || process.env.XDG_CONFIG_HOME
      || process.env.USERPROFILE
      || process.env.APPDATA
      || process.env.LOCALAPPDATA
      || homedir();

  const dir = uiDeps.configDir
    || process.env.BOSUN_HOME
    || process.env.BOSUN_DIR
    || sandbox?.configDir
    || resolve(baseDir, "bosun");
  if (dir) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
  }
  return dir;
}

function getAutoOpenCooldownMs() {
  const raw = Number(process.env.BOSUN_UI_AUTO_OPEN_COOLDOWN_MS || "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AUTO_OPEN_COOLDOWN_MS;
  return Math.max(60_000, Math.trunc(raw));
}

function getBrowserOpenMode() {
  const mode = String(process.env.BOSUN_UI_BROWSER_OPEN_MODE || "manual")
    .trim()
    .toLowerCase();
  if (mode === "auto") return "auto";
  return "manual";
}

function shouldAutoOpenBrowser() {
  const autoOpenRequested = parseBooleanEnv(
    process.env.BOSUN_UI_AUTO_OPEN_BROWSER,
    false,
  );
  return getBrowserOpenMode() === "auto" && autoOpenRequested;
}

function shouldLogTokenizedBrowserUrl() {
  return parseBooleanEnv(process.env.BOSUN_UI_LOG_TOKENIZED_BROWSER_URL, false);
}

function isPidRunning(pid) {
  const parsed = Number(pid);
  if (!Number.isFinite(parsed) || parsed <= 0) return false;
  try {
    process.kill(parsed, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveUiInstanceLockPath() {
  const cacheDir = resolve(resolveUiConfigDir(), ".cache");
  mkdirSync(cacheDir, { recursive: true });
  return resolve(cacheDir, UI_INSTANCE_LOCK_FILE);
}

function readUiInstanceLock(path) {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const pid = Number(parsed.pid || 0);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return {
      pid,
      port: Number(parsed.port || 0) || 0,
      url: String(parsed.url || ""),
      protocol: String(parsed.protocol || ""),
      host: String(parsed.host || ""),
      startedAt: Number(parsed.startedAt || 0) || 0,
    };
  } catch {
    return null;
  }
}

function writeUiInstanceLock(path, payload = {}) {
  try {
    writeFileSync(path, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // best effort
  }
}

function tryAcquireUiInstanceLock({ preferredPort = 0 } = {}) {
  const lockPath = resolveUiInstanceLockPath();
  uiInstanceLockPath = lockPath;
  const payload = {
    pid: process.pid,
    preferredPort: Number(preferredPort || 0) || 0,
    port: 0,
    host: "",
    protocol: "",
    url: "",
    startedAt: Date.now(),
  };

  const tryCreateLock = () => {
    writeFileSync(lockPath, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    uiInstanceLockHeld = true;
    return { ok: true };
  };

  try {
    return tryCreateLock();
  } catch (err) {
    if (err?.code !== "EEXIST") {
      return { ok: false, existing: null };
    }
  }

  const current = readUiInstanceLock(lockPath);
  if (current && current.pid !== process.pid && isPidRunning(current.pid)) {
    return { ok: false, existing: current };
  }

  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch {
    // best effort
  }

  try {
    return tryCreateLock();
  } catch {
    const existing = readUiInstanceLock(lockPath);
    return { ok: false, existing };
  }
}

function updateUiInstanceLock(payload = {}) {
  if (!uiInstanceLockHeld || !uiInstanceLockPath) return;
  writeUiInstanceLock(uiInstanceLockPath, {
    pid: process.pid,
    preferredPort: Number(payload.preferredPort || 0) || 0,
    port: Number(payload.port || 0) || 0,
    host: String(payload.host || ""),
    protocol: String(payload.protocol || ""),
    url: String(payload.url || ""),
    startedAt: Number(payload.startedAt || Date.now()) || Date.now(),
  });
}

function releaseUiInstanceLock() {
  if (!uiInstanceLockPath) return;
  try {
    const current = readUiInstanceLock(uiInstanceLockPath);
    if (!current || current.pid === process.pid || !isPidRunning(current.pid)) {
      if (existsSync(uiInstanceLockPath)) unlinkSync(uiInstanceLockPath);
    }
  } catch {
    // best effort
  }
  uiInstanceLockHeld = false;
  uiInstanceLockPath = "";
}

function readAutoOpenMarker() {
  try {
    const cacheDir = resolve(resolveUiConfigDir(), ".cache");
    const markerPath = resolve(cacheDir, AUTO_OPEN_MARKER_FILE);
    if (!existsSync(markerPath)) return null;
    const payload = JSON.parse(readFileSync(markerPath, "utf8"));
    const openedAt = Number(payload?.openedAt || 0);
    if (!Number.isFinite(openedAt) || openedAt <= 0) return null;
    return { openedAt, markerPath };
  } catch {
    return null;
  }
}

function writeAutoOpenMarker(data = {}) {
  try {
    const cacheDir = resolve(resolveUiConfigDir(), ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const markerPath = resolve(cacheDir, AUTO_OPEN_MARKER_FILE);
    writeFileSync(
      markerPath,
      JSON.stringify(
        {
          openedAt: Date.now(),
          url: String(data.url || ""),
          pid: process.pid,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    /* best effort */
  }
}

function shouldAutoOpenBrowserNow() {
  const marker = readAutoOpenMarker();
  if (!marker?.openedAt) return true;
  const cooldownMs = getAutoOpenCooldownMs();
  return Date.now() - marker.openedAt >= cooldownMs;
}

function getSessionTokenTtlMs() {
  const raw = Number(process.env.BOSUN_UI_SESSION_TOKEN_TTL_MS || "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SESSION_TOKEN_TTL_MS;
  return Math.max(5 * 60 * 1000, Math.trunc(raw));
}

function getSessionCookieMaxAgeSec() {
  const raw = Number(process.env.BOSUN_UI_SESSION_COOKIE_MAX_AGE_SEC || "");
  if (Number.isFinite(raw) && raw > 0) {
    return Math.max(60, Math.trunc(raw));
  }
  return Math.max(60, Math.floor(getSessionTokenTtlMs() / 1000));
}

function resolveUiCachePath(fileName) {
  const cacheDir = resolve(resolveUiConfigDir(), ".cache");
  mkdirSync(cacheDir, { recursive: true });
  return resolve(cacheDir, fileName);
}

function isValidSessionToken(token) {
  return /^[a-f0-9]{64}$/i.test(String(token || ""));
}

function readPersistedSessionToken() {
  try {
    const tokenPath = resolveUiCachePath(UI_SESSION_TOKEN_FILE);
    if (!existsSync(tokenPath)) return "";
    const payload = JSON.parse(readFileSync(tokenPath, "utf8"));
    const token = String(payload?.token || "").trim();
    const createdAt = Number(payload?.createdAt || 0);
    if (!isValidSessionToken(token)) return "";
    if (!Number.isFinite(createdAt) || createdAt <= 0) return "";
    if (Date.now() - createdAt > getSessionTokenTtlMs()) return "";
    return token;
  } catch {
    return "";
  }
}

function persistSessionToken(token) {
  if (!isValidSessionToken(token)) return;
  try {
    const tokenPath = resolveUiCachePath(UI_SESSION_TOKEN_FILE);
    writeFileSync(
      tokenPath,
      JSON.stringify(
        {
          token,
          createdAt: Date.now(),
          pid: process.pid,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // best effort
  }
}

function touchSessionToken() {
  if (!isValidSessionToken(sessionToken)) return;
  const now = Date.now();
  // Avoid churning the cache file on every static/API request.
  if (now - _sessionTokenLastTouchedAt < 5 * 60 * 1000) return;
  _sessionTokenLastTouchedAt = now;
  persistSessionToken(sessionToken);
}

function ensureSessionToken() {
  if (isValidSessionToken(sessionToken)) return sessionToken;
  const persisted = readPersistedSessionToken();
  if (persisted) {
    sessionToken = persisted;
    return sessionToken;
  }
  sessionToken = randomBytes(32).toString("hex");
  persistSessionToken(sessionToken);
  return sessionToken;
}

function readLastUiPort() {
  try {
    const portPath = resolveUiCachePath(UI_LAST_PORT_FILE);
    if (!existsSync(portPath)) return 0;
    const payload = JSON.parse(readFileSync(portPath, "utf8"));
    const port = Number(payload?.port || 0);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return 0;
    return Math.trunc(port);
  } catch {
    return 0;
  }
}

function persistLastUiPort(port) {
  const normalized = Number(port || 0);
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 65535) {
    return;
  }
  try {
    const portPath = resolveUiCachePath(UI_LAST_PORT_FILE);
    writeFileSync(
      portPath,
      JSON.stringify(
        {
          port: Math.trunc(normalized),
          updatedAt: Date.now(),
          pid: process.pid,
        },
        null,
        2,
      ),
      "utf8",
    );
  } catch {
    // best effort
  }
}

const FALLBACK_AUTH_STATE_FILE = "ui-fallback-auth.json";
const FALLBACK_AUTH_ALGORITHM = "argon2id";
const FALLBACK_AUTH_SALT_BYTES = 16;
const FALLBACK_AUTH_TAG_LENGTH = 32;
const FALLBACK_AUTH_MEMORY_KIB = 64 * 1024;
const FALLBACK_AUTH_PASSES = 3;
const FALLBACK_AUTH_PARALLELISM = 1;
const FALLBACK_AUTH_MIN_PASSWORD_LENGTH = 10;
const FALLBACK_AUTH_MIN_PIN_LENGTH = 6;

let fallbackAuthRecordCache = null;
const fallbackAuthRateLimitByIp = new Map();
let fallbackAuthGlobalWindow = { windowStart: 0, count: 0 };
const fallbackAuthRuntime = {
  failedAttempts: 0,
  lockoutUntil: 0,
  transientCooldownUntil: 0,
  lastFailureAt: 0,
  lastSuccessAt: 0,
};

function getFallbackAuthConfig() {
  const enabled = parseBooleanEnv(
    process.env.TELEGRAM_UI_FALLBACK_AUTH_ENABLED,
    true,
  );
  const perIpPerMin = Math.max(
    1,
    Number(process.env.TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_IP_PER_MIN || "10"),
  );
  const globalPerMin = Math.max(
    1,
    Number(process.env.TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_GLOBAL_PER_MIN || "60"),
  );
  const maxFailures = Math.max(
    1,
    Number(process.env.TELEGRAM_UI_FALLBACK_AUTH_MAX_FAILURES || "5"),
  );
  const lockoutMs = Math.max(
    10_000,
    Number(process.env.TELEGRAM_UI_FALLBACK_AUTH_LOCKOUT_MS || "600000"),
  );
  const transientCooldownMs = Math.max(
    1000,
    Number(process.env.TELEGRAM_UI_FALLBACK_AUTH_TRANSIENT_COOLDOWN_MS || "5000"),
  );
  const rotateDays = Math.max(
    1,
    Number(process.env.TELEGRAM_UI_FALLBACK_AUTH_ROTATE_DAYS || "30"),
  );
  return {
    enabled,
    perIpPerMin,
    globalPerMin,
    maxFailures,
    lockoutMs,
    transientCooldownMs,
    rotateDays,
  };
}

function getFallbackAuthStatePath() {
  return resolveUiCachePath(FALLBACK_AUTH_STATE_FILE);
}

function readFallbackAuthRecord() {
  if (fallbackAuthRecordCache && typeof fallbackAuthRecordCache === "object") {
    return fallbackAuthRecordCache;
  }
  try {
    const statePath = getFallbackAuthStatePath();
    if (!existsSync(statePath)) return null;
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    if (
      typeof parsed.hash !== "string"
      || typeof parsed.salt !== "string"
      || parsed.algorithm !== FALLBACK_AUTH_ALGORITHM
    ) {
      return null;
    }
    fallbackAuthRecordCache = parsed;
    return parsed;
  } catch {
    return null;
  }
}

function writeFallbackAuthRecord(record) {
  fallbackAuthRecordCache = record;
  try {
    const statePath = getFallbackAuthStatePath();
    writeFileSync(statePath, JSON.stringify(record, null, 2), "utf8");
  } catch {
    // best effort
  }
}

function clearFallbackAuthRecord() {
  fallbackAuthRecordCache = null;
  try {
    const statePath = getFallbackAuthStatePath();
    if (existsSync(statePath)) unlinkSync(statePath);
  } catch {
    // best effort
  }
}

function isFallbackSecretStrong(secret) {
  const normalized = String(secret || "").trim();
  if (!normalized) return false;
  if (/^\d+$/.test(normalized)) {
    return normalized.length >= FALLBACK_AUTH_MIN_PIN_LENGTH;
  }
  return normalized.length >= FALLBACK_AUTH_MIN_PASSWORD_LENGTH;
}

async function deriveFallbackAuthHash(secret, saltBuffer) {
  return new Promise((resolveHash, rejectHash) => {
    argon2(
      FALLBACK_AUTH_ALGORITHM,
      {
        message: Buffer.from(String(secret || ""), "utf8"),
        nonce: saltBuffer,
        parallelism: FALLBACK_AUTH_PARALLELISM,
        tagLength: FALLBACK_AUTH_TAG_LENGTH,
        memory: FALLBACK_AUTH_MEMORY_KIB,
        passes: FALLBACK_AUTH_PASSES,
      },
      (err, hash) => {
        if (err) return rejectHash(err);
        resolveHash(hash);
      },
    );
  });
}

async function setFallbackAuthSecret(secret, { actor = "api" } = {}) {
  if (!isFallbackSecretStrong(secret)) {
    throw new Error(
      `Fallback secret must be >= ${FALLBACK_AUTH_MIN_PIN_LENGTH} digits (PIN) or >= ${FALLBACK_AUTH_MIN_PASSWORD_LENGTH} chars (password)`,
    );
  }
  const salt = randomBytes(FALLBACK_AUTH_SALT_BYTES);
  const hash = await deriveFallbackAuthHash(secret, salt);
  const existing = readFallbackAuthRecord();
  const now = Date.now();
  writeFallbackAuthRecord({
    version: 1,
    algorithm: FALLBACK_AUTH_ALGORITHM,
    hash: hash.toString("base64"),
    salt: salt.toString("base64"),
    tagLength: FALLBACK_AUTH_TAG_LENGTH,
    memoryKiB: FALLBACK_AUTH_MEMORY_KIB,
    passes: FALLBACK_AUTH_PASSES,
    parallelism: FALLBACK_AUTH_PARALLELISM,
    createdAt: Number(existing?.createdAt || now),
    updatedAt: now,
    rotatedAt: now,
    updatedBy: String(actor || "api"),
  });
  fallbackAuthRuntime.failedAttempts = 0;
  fallbackAuthRuntime.lockoutUntil = 0;
  fallbackAuthRuntime.transientCooldownUntil = 0;
}

function resetFallbackAuthSecret() {
  clearFallbackAuthRecord();
  fallbackAuthRuntime.failedAttempts = 0;
  fallbackAuthRuntime.lockoutUntil = 0;
  fallbackAuthRuntime.transientCooldownUntil = 0;
}

function getRequestIp(req) {
  return String(
    req?.headers?.["x-forwarded-for"]
    || req?.socket?.remoteAddress
    || "unknown",
  ).split(",")[0].trim().toLowerCase();
}

function consumeFallbackRateLimits(req, config) {
  const now = Date.now();
  const windowMs = 60_000;
  const ip = getRequestIp(req);

  const globalBucket = fallbackAuthGlobalWindow;
  if (!globalBucket.windowStart || now - globalBucket.windowStart > windowMs) {
    fallbackAuthGlobalWindow = { windowStart: now, count: 0 };
  }
  fallbackAuthGlobalWindow.count += 1;
  if (fallbackAuthGlobalWindow.count > config.globalPerMin) {
    return { ok: false, reason: "global_rate_limited" };
  }

  let bucket = fallbackAuthRateLimitByIp.get(ip);
  if (!bucket || now - bucket.windowStart > windowMs) {
    bucket = { windowStart: now, count: 0 };
    fallbackAuthRateLimitByIp.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > config.perIpPerMin) {
    return { ok: false, reason: "ip_rate_limited" };
  }
  return { ok: true };
}

async function verifyFallbackAuthSecret(secret) {
  const record = readFallbackAuthRecord();
  if (!record?.hash || !record?.salt) return false;
  const storedHash = Buffer.from(String(record.hash || ""), "base64");
  const salt = Buffer.from(String(record.salt || ""), "base64");
  const derived = await deriveFallbackAuthHash(secret, salt);
  if (derived.length !== storedHash.length) return false;
  return timingSafeEqual(derived, storedHash);
}

async function attemptFallbackAuth(req, secret) {
  const cfg = getFallbackAuthConfig();
  const now = Date.now();
  if (!cfg.enabled) return { ok: false, reason: "disabled" };
  if (isAllowUnsafe()) return { ok: false, reason: "unsafe_mode_enabled" };
  if (!readFallbackAuthRecord()) return { ok: false, reason: "missing_credential" };

  if (fallbackAuthRuntime.transientCooldownUntil > now) {
    return { ok: false, reason: "transient_cooldown" };
  }
  if (fallbackAuthRuntime.lockoutUntil > now) {
    return { ok: false, reason: "locked" };
  }
  const rateCheck = consumeFallbackRateLimits(req, cfg);
  if (!rateCheck.ok) return { ok: false, reason: rateCheck.reason };

  try {
    const valid = await verifyFallbackAuthSecret(secret);
    if (valid) {
      fallbackAuthRuntime.failedAttempts = 0;
      fallbackAuthRuntime.lockoutUntil = 0;
      fallbackAuthRuntime.lastSuccessAt = now;
      ensureSessionToken();
      return { ok: true, reason: "success" };
    }
  } catch {
    fallbackAuthRuntime.transientCooldownUntil = now + cfg.transientCooldownMs;
    return { ok: false, reason: "transient_verify_error" };
  }

  fallbackAuthRuntime.failedAttempts += 1;
  fallbackAuthRuntime.lastFailureAt = now;
  if (fallbackAuthRuntime.failedAttempts >= cfg.maxFailures) {
    fallbackAuthRuntime.lockoutUntil = now + cfg.lockoutMs;
    fallbackAuthRuntime.failedAttempts = 0;
  }
  return { ok: false, reason: "invalid_secret" };
}

function getFallbackAuthStatus() {
  const cfg = getFallbackAuthConfig();
  const record = readFallbackAuthRecord();
  const now = Date.now();
  const rotationDueAt = record?.updatedAt
    ? Number(record.updatedAt) + cfg.rotateDays * 24 * 60 * 60 * 1000
    : 0;
  const rotationDue = rotationDueAt > 0 && now >= rotationDueAt;
  const locked = fallbackAuthRuntime.lockoutUntil > now;
  const remediation = [];
  if (!record) remediation.push("missing_credential");
  if (!cfg.enabled) remediation.push("disabled_by_env");
  if (isAllowUnsafe()) remediation.push("unsafe_mode_enabled");
  if (locked) remediation.push("locked_temporarily");
  if (rotationDue) remediation.push("rotation_due");
  return {
    configured: Boolean(record?.hash),
    enabled: cfg.enabled,
    active: cfg.enabled && Boolean(record?.hash) && !isAllowUnsafe(),
    locked,
    lockoutUntil: locked ? fallbackAuthRuntime.lockoutUntil : 0,
    transientCooldownUntil:
      fallbackAuthRuntime.transientCooldownUntil > now
        ? fallbackAuthRuntime.transientCooldownUntil
        : 0,
    rotationDue,
    rotationDueAt,
    rotateDays: cfg.rotateDays,
    updatedAt: Number(record?.updatedAt || 0) || 0,
    updatedBy: String(record?.updatedBy || ""),
    rateLimits: {
      perIpPerMin: cfg.perIpPerMin,
      globalPerMin: cfg.globalPerMin,
      maxFailures: cfg.maxFailures,
      lockoutMs: cfg.lockoutMs,
    },
    remediation,
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of fallbackAuthRateLimitByIp) {
    if (now - bucket.windowStart > 120_000) {
      fallbackAuthRateLimitByIp.delete(ip);
    }
  }
  if (now - fallbackAuthGlobalWindow.windowStart > 120_000) {
    fallbackAuthGlobalWindow = { windowStart: 0, count: 0 };
  }
}, 300_000).unref();

const projectSyncWebhookMetrics = {
  received: 0,
  processed: 0,
  ignored: 0,
  failed: 0,
  invalidSignature: 0,
  syncTriggered: 0,
  syncSuccess: 0,
  syncFailure: 0,
  rateLimitObserved: 0,
  alertsTriggered: 0,
  consecutiveFailures: 0,
  lastEventAt: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  lastError: null,
};

// ── Settings API: Known env keys from settings schema ──
const SETTINGS_KNOWN_KEYS = [
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALLOWED_CHAT_IDS",
  "TELEGRAM_INTERVAL_MIN", "TELEGRAM_COMMAND_POLL_TIMEOUT_SEC", "TELEGRAM_AGENT_TIMEOUT_MIN",
  "TELEGRAM_COMMAND_CONCURRENCY", "TELEGRAM_VERBOSITY", "TELEGRAM_BATCH_NOTIFICATIONS",
  "TELEGRAM_BATCH_INTERVAL_SEC", "TELEGRAM_BATCH_MAX_SIZE", "TELEGRAM_IMMEDIATE_PRIORITY",
  "TELEGRAM_API_BASE_URL", "TELEGRAM_HTTP_TIMEOUT_MS", "TELEGRAM_RETRY_ATTEMPTS",
  "TELEGRAM_HISTORY_RETENTION_DAYS",
  "PROJECT_NAME", "TELEGRAM_MINIAPP_ENABLED", "TELEGRAM_UI_PORT", "TELEGRAM_UI_HOST",
  "TELEGRAM_UI_PUBLIC_HOST", "TELEGRAM_UI_BASE_URL", "TELEGRAM_UI_ALLOW_UNSAFE",
  "TELEGRAM_UI_AUTH_MAX_AGE_SEC", "TELEGRAM_UI_TUNNEL", "TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK",
  "TELEGRAM_UI_FALLBACK_AUTH_ENABLED", "TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_IP_PER_MIN",
  "TELEGRAM_UI_FALLBACK_AUTH_RATE_LIMIT_GLOBAL_PER_MIN", "TELEGRAM_UI_FALLBACK_AUTH_MAX_FAILURES",
  "TELEGRAM_UI_FALLBACK_AUTH_LOCKOUT_MS", "TELEGRAM_UI_FALLBACK_AUTH_ROTATE_DAYS",
  "TELEGRAM_UI_FALLBACK_AUTH_TRANSIENT_COOLDOWN_MS",
  "EXECUTOR_MODE", "INTERNAL_EXECUTOR_PARALLEL", "INTERNAL_EXECUTOR_SDK",
  "INTERNAL_EXECUTOR_TIMEOUT_MS", "INTERNAL_EXECUTOR_MAX_RETRIES", "INTERNAL_EXECUTOR_POLL_MS",
  "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED", "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
  "INTERNAL_EXECUTOR_STREAM_MAX_RETRIES", "INTERNAL_EXECUTOR_STREAM_RETRY_BASE_MS",
  "INTERNAL_EXECUTOR_STREAM_RETRY_MAX_MS", "INTERNAL_EXECUTOR_STREAM_FIRST_EVENT_TIMEOUT_MS",
  "INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN", "INTERNAL_EXECUTOR_STREAM_MAX_ITEM_CHARS",
  "CODEX_SDK_DISABLED", "COPILOT_SDK_DISABLED", "CLAUDE_SDK_DISABLED",
  "PRIMARY_AGENT", "EXECUTORS", "EXECUTOR_DISTRIBUTION", "FAILOVER_STRATEGY",
  "COMPLEXITY_ROUTING_ENABLED", "PROJECT_REQUIREMENTS_PROFILE",
  "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "CODEX_MODEL",
  "CODEX_MODEL_PROFILE", "CODEX_MODEL_PROFILE_SUBAGENT",
  "CODEX_MODEL_PROFILE_XL_PROVIDER", "CODEX_MODEL_PROFILE_XL_MODEL", "CODEX_MODEL_PROFILE_XL_BASE_URL", "CODEX_MODEL_PROFILE_XL_API_KEY",
  "CODEX_MODEL_PROFILE_M_PROVIDER", "CODEX_MODEL_PROFILE_M_MODEL", "CODEX_MODEL_PROFILE_M_BASE_URL", "CODEX_MODEL_PROFILE_M_API_KEY",
  "CODEX_SUBAGENT_MODEL", "ANTHROPIC_API_KEY", "CLAUDE_MODEL",
  "COPILOT_MODEL", "COPILOT_CLI_TOKEN",
  "KANBAN_BACKEND", "KANBAN_SYNC_POLICY", "BOSUN_TASK_LABEL",
  "BOSUN_ENFORCE_TASK_LABEL", "STALE_TASK_AGE_HOURS",
  "TASK_TRIGGER_SYSTEM_ENABLED",
  "TASK_BRANCH_MODE", "TASK_BRANCH_AUTO_MODULE", "TASK_UPSTREAM_SYNC_MAIN",
  "MODULE_BRANCH_PREFIX", "DEFAULT_TARGET_BRANCH",

  "GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_PROJECT_MODE",
  "GITHUB_PROJECT_NUMBER", "GITHUB_DEFAULT_ASSIGNEE", "GITHUB_AUTO_ASSIGN_CREATOR",
  "BOSUN_GITHUB_APP_ID", "BOSUN_GITHUB_PRIVATE_KEY_PATH", "BOSUN_GITHUB_CLIENT_ID", "BOSUN_GITHUB_CLIENT_SECRET",
  "BOSUN_GITHUB_WEBHOOK_SECRET", "BOSUN_GITHUB_USER_TOKEN",
  "GITHUB_PROJECT_WEBHOOK_PATH", "GITHUB_PROJECT_WEBHOOK_SECRET", "GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE",
  "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD", "GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD",
  "VK_TARGET_BRANCH", "CODEX_ANALYZE_MERGE_STRATEGY", "DEPENDABOT_AUTO_MERGE",
  "GH_RECONCILE_ENABLED",
  "CLOUDFLARE_TUNNEL_NAME", "CLOUDFLARE_TUNNEL_CREDENTIALS", "CLOUDFLARE_BASE_DOMAIN",
  "CLOUDFLARE_TUNNEL_HOSTNAME", "CLOUDFLARE_USERNAME_HOSTNAME_POLICY",
  "CLOUDFLARE_ZONE_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_DNS_SYNC_ENABLED",
  "CLOUDFLARE_DNS_MAX_RETRIES", "CLOUDFLARE_DNS_RETRY_BASE_MS",
  "TELEGRAM_PRESENCE_INTERVAL_SEC", "TELEGRAM_PRESENCE_DISABLED",
  "VE_INSTANCE_LABEL", "VE_COORDINATOR_ELIGIBLE", "VE_COORDINATOR_PRIORITY",
  "FLEET_ENABLED", "FLEET_BUFFER_MULTIPLIER", "FLEET_SYNC_INTERVAL_MS",
  "FLEET_PRESENCE_TTL_MS", "FLEET_KNOWLEDGE_ENABLED", "FLEET_KNOWLEDGE_FILE",
  "CODEX_SANDBOX", "CODEX_FEATURES_BWRAP", "CODEX_SANDBOX_PERMISSIONS", "CODEX_SANDBOX_WRITABLE_ROOTS",
  "CONTAINER_ENABLED", "CONTAINER_RUNTIME", "CONTAINER_IMAGE",
  "CONTAINER_TIMEOUT_MS", "MAX_CONCURRENT_CONTAINERS", "CONTAINER_MEMORY_LIMIT", "CONTAINER_CPU_LIMIT",
  "BOSUN_SENTINEL_AUTO_START", "SENTINEL_AUTO_RESTART_MONITOR",
  "SENTINEL_CRASH_LOOP_THRESHOLD", "SENTINEL_CRASH_LOOP_WINDOW_MIN",
  "SENTINEL_REPAIR_AGENT_ENABLED", "SENTINEL_REPAIR_TIMEOUT_MIN",
  "BOSUN_HOOK_PROFILE", "BOSUN_HOOK_TARGETS",
  "BOSUN_HOOKS_ENABLED", "BOSUN_HOOKS_OVERWRITE",
  "BOSUN_HOOKS_BUILTINS_MODE",
  "AGENT_WORK_LOGGING_ENABLED", "AGENT_WORK_ANALYZER_ENABLED",
  "AGENT_WORK_STREAM_RETENTION_DAYS", "AGENT_WORK_ERROR_RETENTION_DAYS",
  "AGENT_WORK_SESSION_RETENTION_COUNT", "AGENT_WORK_ARCHIVE_RETENTION_DAYS",
  "AGENT_WORK_METRICS_ROTATION_ENABLED",
  "AGENT_SESSION_LOG_RETENTION", "AGENT_ERROR_LOOP_THRESHOLD",
  "AGENT_STUCK_THRESHOLD_MS", "LOG_MAX_SIZE_MB", "BOSUN_TELEMETRY_SAMPLE_RATE",
  "DEVMODE", "SELF_RESTART_WATCH_ENABLED", "MAX_PARALLEL",
  "RESTART_DELAY_MS", "SHARED_STATE_ENABLED", "WORKFLOW_AUTOMATION_ENABLED",
  "SHARED_STATE_STALE_THRESHOLD_MS",
  "VE_CI_SWEEP_EVERY",
];

const SETTINGS_SENSITIVE_KEYS = new Set([
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GITHUB_TOKEN",
  "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "CODEX_MODEL_PROFILE_XL_API_KEY", "CODEX_MODEL_PROFILE_M_API_KEY",
  "ANTHROPIC_API_KEY", "COPILOT_CLI_TOKEN", "GITHUB_PROJECT_WEBHOOK_SECRET",
  "BOSUN_GITHUB_CLIENT_SECRET", "BOSUN_GITHUB_WEBHOOK_SECRET", "BOSUN_GITHUB_USER_TOKEN",
  "CLOUDFLARE_TUNNEL_CREDENTIALS", "CLOUDFLARE_API_TOKEN",
]);

const SETTINGS_SCHEMA_KEYS = SETTINGS_SCHEMA
  .map((def) => String(def?.key || "").trim())
  .filter((key) => key && !key.startsWith("_"));
const SETTINGS_KNOWN_SET = new Set([...SETTINGS_KNOWN_KEYS, ...SETTINGS_SCHEMA_KEYS]);
const SETTINGS_EFFECTIVE_KEYS = Array.from(SETTINGS_KNOWN_SET);
let _settingsLastUpdateTime = 0;
const ASYNC_UI_COMMAND_BASES = new Set(["/plan"]);

function hasSettingValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function getConfigValueAtPath(obj, pathParts = []) {
  let cursor = obj;
  for (const part of pathParts) {
    if (!cursor || typeof cursor !== "object" || !Object.prototype.hasOwnProperty.call(cursor, part)) {
      return undefined;
    }
    cursor = cursor[part];
  }
  return cursor;
}

function toSettingsDisplayValue(def, rawValue) {
  if (!hasSettingValue(rawValue)) return "";
  if (def?.type === "boolean") {
    if (typeof rawValue === "boolean") return rawValue ? "true" : "false";
    const normalized = String(rawValue).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return "true";
    if (["0", "false", "no", "off"].includes(normalized)) return "false";
  }
  if (Array.isArray(rawValue)) {
    return rawValue.map((entry) => String(entry ?? "")).join(",");
  }
  return String(rawValue);
}

function resolveDerivedSettingsValue(key) {
  if (key === "TELEGRAM_MINIAPP_ENABLED") {
    const rawPort = Number(process.env.TELEGRAM_UI_PORT || "0");
    if (Number.isFinite(rawPort) && rawPort > 0) {
      return { value: true, source: "derived" };
    }
  }
  return null;
}

function buildSettingsResponseData() {
  const data = {};
  const sources = {};
  const schema = getConfigSchema();
  const defsByKey = new Map(
    SETTINGS_SCHEMA.map((def) => [String(def?.key || ""), def]),
  );
  const { configData } = readConfigDocument();

  for (const key of SETTINGS_EFFECTIVE_KEYS) {
    const def = defsByKey.get(key);
    let rawValue = process.env[key];
    let source = hasSettingValue(rawValue) ? "env" : "unset";

    if (source === "unset") {
      const derived = resolveDerivedSettingsValue(key);
      if (derived && hasSettingValue(derived.value)) {
        rawValue = derived.value;
        source = derived.source || "derived";
      }
    }

    if (source === "unset" && schema) {
      const pathInfo = mapEnvKeyToConfigPath(key, schema);
      if (pathInfo) {
        const configValue = getConfigValueAtPath(configData, pathInfo.pathParts);
        if (hasSettingValue(configValue)) {
          rawValue = configValue;
          source = "config";
        } else {
          const propSchema = getSchemaProperty(schema, pathInfo.pathParts);
          if (propSchema && Object.prototype.hasOwnProperty.call(propSchema, "default")) {
            rawValue = propSchema.default;
            source = "default";
          }
        }
      }
    }

    if (source === "unset" && def && Object.prototype.hasOwnProperty.call(def, "defaultVal")) {
      rawValue = def.defaultVal;
      source = "default";
    }

    const displayValue = toSettingsDisplayValue(def, rawValue);
    if (SETTINGS_SENSITIVE_KEYS.has(key) || def?.sensitive) {
      data[key] = displayValue ? "••••••" : "";
    } else {
      data[key] = displayValue;
    }
    sources[key] = source;
  }

  return { data, sources };
}

function updateEnvFile(changes) {
  const envPath = resolve(resolveUiConfigDir(), '.env');
  let content = '';
  try { content = readFileSync(envPath, 'utf8'); } catch { content = ''; }

  const lines = content.split('\n');
  const updated = new Set();

  for (const [key, value] of Object.entries(changes)) {
    const pattern = new RegExp(`^(#\\s*)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`);
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        lines[i] = `${key}=${value}`;
        found = true;
        updated.add(key);
        break;
      }
    }
    if (!found) {
      lines.push(`${key}=${value}`);
      updated.add(key);
    }
  }

  writeFileSync(envPath, lines.join('\n'), 'utf8');
  return Array.from(updated);
}

/**
 * Disable unsafe UI access mode by writing TELEGRAM_UI_ALLOW_UNSAFE=false
 * into the .env file and updating process.env immediately.
 * Returns true on success, false if the write failed.
 */
export function disableUnsafeMode() {
  try {
    updateEnvFile({ TELEGRAM_UI_ALLOW_UNSAFE: 'false' });
    process.env.TELEGRAM_UI_ALLOW_UNSAFE = 'false';
    return true;
  } catch (err) {
    console.warn(`[telegram-ui] disableUnsafeMode: could not update .env: ${err.message}`);
    return false;
  }
}

function updateConfigFile(changes) {
  const schema = getConfigSchema();
  const configPath = resolveConfigPath();
  if (!schema) return { updated: [], path: configPath };
  let configData = { $schema: "./bosun.schema.json" };
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, "utf8");
      configData = JSON.parse(raw);
    } catch {
      configData = { $schema: "./bosun.schema.json" };
    }
  }

  const updated = new Set();
  for (const [key, value] of Object.entries(changes)) {
    const pathInfo = mapEnvKeyToConfigPath(key, schema);
    if (!pathInfo) continue;
    const { pathParts, allowUnknownSchema } = pathInfo;
    const propSchema = getSchemaProperty(schema, pathParts);
    if (!propSchema && !allowUnknownSchema) continue;
    if (isUnsetValue(value)) {
      unsetConfigPathValue(configData, pathParts);
      updated.add(key);
      continue;
    }
    const def = SETTINGS_SCHEMA.find((s) => s.key === key);
    const coerced = coerceSettingValue(def, value, propSchema);
    setConfigPathValue(configData, pathParts, coerced);
    updated.add(key);
  }

  if (updated.size === 0) {
    return { updated: [], path: configPath };
  }

  if (!configData.$schema) {
    configData.$schema = "./bosun.schema.json";
  }
  writeFileSync(configPath, JSON.stringify(configData, null, 2) + "\n", "utf8");
  return { updated: Array.from(updated), path: configPath };
}

function validateConfigSchemaChanges(changes) {
  try {
    const schema = getConfigSchema();
    const validator = getConfigValidator();
    if (!schema || !validator) return {};

    const configPath = resolveConfigPath();
    let configData = {};
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf8");
        configData = JSON.parse(raw);
      } catch {
        configData = {};
      }
    }

    const candidate = JSON.parse(JSON.stringify(configData || {}));
    const pathMap = new Map();
    for (const [key, value] of Object.entries(changes)) {
      const pathInfo = mapEnvKeyToConfigPath(key, schema);
      if (!pathInfo) continue;
      const { pathParts, allowUnknownSchema } = pathInfo;
      const propSchema = getSchemaProperty(schema, pathParts);
      if (!propSchema && !allowUnknownSchema) continue;
      if (isUnsetValue(value)) {
        unsetConfigPathValue(candidate, pathParts);
        pathMap.set(pathParts.join("."), key);
        continue;
      }
      const def = SETTINGS_SCHEMA.find((s) => s.key === key);
      const coerced = coerceSettingValue(def, value, propSchema);
      setConfigPathValue(candidate, pathParts, coerced);
      pathMap.set(pathParts.join("."), key);
    }

    if (pathMap.size === 0) return {};
    const valid = validator(candidate);
    if (valid) return {};

    const fieldErrors = {};
    const errors = validator.errors || [];
    for (const err of errors) {
      let path = String(err.instancePath || "").replace(/^\//, "");
      if (!path && err.params?.missingProperty) {
        const missing = String(err.params.missingProperty);
        path = path ? `${path}/${missing}` : missing;
      }
      if (!path && err.params?.additionalProperty) {
        const extra = String(err.params.additionalProperty);
        path = path ? `${path}/${extra}` : extra;
      }
      if (!path) continue;
      const parts = path.split("/").filter(Boolean);
      let envKey = pathMap.get(parts.join("."));
      if (!envKey) {
        for (let i = parts.length; i > 0; i -= 1) {
          const candidatePath = parts.slice(0, i).join(".");
          if (pathMap.has(candidatePath)) {
            envKey = pathMap.get(candidatePath);
            break;
          }
        }
      }
      if (envKey && !fieldErrors[envKey]) {
        fieldErrors[envKey] = err.message || "Invalid value";
      }
    }
    if (Object.keys(fieldErrors).length === 0) return {};
    return fieldErrors;
  } catch {
    return {};
  }
}

// ── Simple rate limiter for mutation endpoints ──
const _rateLimitMap = new Map();
function isPrivilegedAuthSource(source) {
  const normalized = String(source || "").trim().toLowerCase();
  return normalized === "desktop-api-key" || normalized === "fallback" || normalized === "unsafe";
}

function isAuthenticatedSessionAuthSource(source) {
  const normalized = String(source || "").trim().toLowerCase();
  return normalized === "session" || normalized === "telegram";
}

function getMutationRateLimitPerMin(authResult = null) {
  const standardRaw = Number(process.env.BOSUN_UI_RATE_LIMIT_PER_MIN || "30");
  const standard = Number.isFinite(standardRaw) && standardRaw > 0 ? standardRaw : 30;
  if (!authResult?.ok) return standard;
  if (isAuthenticatedSessionAuthSource(authResult.source)) {
    const authenticatedRaw = Number(process.env.BOSUN_UI_RATE_LIMIT_AUTHENTICATED_PER_MIN || "120");
    return Number.isFinite(authenticatedRaw) && authenticatedRaw > 0 ? authenticatedRaw : 120;
  }
  // Owner/admin-controlled contexts should be less constrained:
  // - desktop-api-key: local Electron owner session
  // - fallback: explicit local secret auth
  // - unsafe: auth disabled for trusted local environment
  if (isPrivilegedAuthSource(authResult.source)) {
    const privilegedRaw = Number(process.env.BOSUN_UI_RATE_LIMIT_PRIVILEGED_PER_MIN || "600");
    return Number.isFinite(privilegedRaw) && privilegedRaw > 0 ? privilegedRaw : 600;
  }
  return standard;
}

function shouldHideSessionFromDefaultList(session) {
  if (!session || typeof session !== "object") return false;
  const metadata =
    session.metadata && typeof session.metadata === "object"
      ? session.metadata
      : {};
  if (
    metadata.hiddenInLists === true
    || metadata.hidden === true
    || metadata.testSession === true
    || String(metadata.visibility || "").trim().toLowerCase() === "hidden"
  ) {
    return true;
  }
  const identifiers = [
    session.id,
    session.taskId,
    session.title,
    session.taskTitle,
  ];
  return identifiers.some((value) => /^smoke(?:-vision)?-/i.test(String(value || "").trim()));
}

function checkRateLimit(req, maxPerMin = 30, scope = "global") {
  const keyParts = [
    scope,
    req.headers["x-telegram-initdata"] || req.socket?.remoteAddress || "unknown",
  ];
  const key = keyParts.join(":");
  const now = Date.now();
  let bucket = _rateLimitMap.get(key);
  if (!bucket || now - bucket.windowStart > 60000) {
    bucket = { windowStart: now, count: 0 };
    _rateLimitMap.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > maxPerMin) return false;
  return true;
}
// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateLimitMap) {
    if (now - v.windowStart > 120000) _rateLimitMap.delete(k);
  }
}, 300000).unref();

// ── Session token (auto-generated per startup for browser access) ────
let sessionToken = "";

/** Return the current session token (for logging the browser URL). */
export function getSessionToken() {
  return sessionToken;
}

// ── Auto-TLS self-signed certificate generation ──────────────────────
function isTlsDisabled() {
  return ["1", "true", "yes"].includes(
    String(process.env.TELEGRAM_UI_TLS_DISABLE || "").toLowerCase(),
  );
}

function resolveUiSubCachePath(...segments) {
  const path = resolve(resolveUiConfigDir(), ".cache", ...segments);
  try { mkdirSync(dirname(path), { recursive: true }); } catch { /* best effort */ }
  return path;
}

/**
 * Locate the openssl binary.
 * On Windows, Git for Windows bundles openssl but doesn't add it to PATH by
 * default. We probe several well-known install locations as a fallback.
 * Returns the resolved path or "openssl" (rely on PATH) as a last resort.
 */
function findOpenssl() {
  // 1. Check system PATH first
  try {
    const cmd = osPlatform() === "win32" ? "where openssl 2>nul" : "which openssl 2>/dev/null";
    const found = execSync(cmd, { encoding: "utf8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (found) return found.split(/\r?\n/)[0];
  } catch { /* not on PATH */ }

  // 2. Windows-specific fallbacks (Git for Windows, standalone OpenSSL installers)
  if (osPlatform() === "win32") {
    const candidates = [
      "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe",
      "C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe",
      "C:\\Program Files\\OpenSSL\\bin\\openssl.exe",
      // Chocolatey
      "C:\\ProgramData\\chocolatey\\bin\\openssl.exe",
      // Scoop
      `${process.env.USERPROFILE || "C:\\Users\\user"}\\scoop\\apps\\openssl\\current\\bin\\openssl.exe`,
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
  }

  // 3. Last resort — let the OS resolve it (will fail with a clear error)
  return "openssl";
}

/**
 * Ensures a self-signed TLS certificate exists in .cache/tls/.
 * Generates one via openssl if missing or expired (valid for 825 days).
 * Returns { key, cert } buffers or null if generation fails.
 */
function ensureSelfSignedCert() {
  try {
    const tlsDir = dirname(resolveUiSubCachePath("tls", ".keep"));
    const tlsCertPath = resolve(tlsDir, "server.crt");
    const tlsKeyPath = resolve(tlsDir, "server.key");
    if (!existsSync(tlsDir)) {
      mkdirSync(tlsDir, { recursive: true });
    }

    // Reuse existing cert if still valid
    if (existsSync(tlsCertPath) && existsSync(tlsKeyPath)) {
      try {
        const certPem = readFileSync(tlsCertPath, "utf8");
        const cert = new X509Certificate(certPem);
        const notAfter = new Date(cert.validTo);
        if (notAfter > new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)) {
          return {
            key: readFileSync(tlsKeyPath),
            cert: readFileSync(tlsCertPath),
          };
        }
      } catch {
        // Cert parse failed or expired — regenerate
      }
    }

    // Locate openssl — checks PATH then Windows-specific fallback locations
    const opensslBin = findOpenssl();
    const lanIp = getLocalLanIp();
    const subjectAltName = `DNS:localhost,IP:127.0.0.1,IP:${lanIp}`;
    const opensslRes = spawnSync(
      opensslBin,
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-keyout",
        tlsKeyPath,
        "-out",
        tlsCertPath,
        "-days",
        "825",
        "-nodes",
        "-batch",
        "-subj",
        "/CN=bosun",
        "-addext",
        `subjectAltName=${subjectAltName}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, encoding: "utf8" },
    );
    if (opensslRes.error || opensslRes.status !== 0) {
      throw new Error(
        String(opensslRes.stderr || opensslRes.stdout || "openssl failed").trim(),
      );
    }

    console.log(
      `[telegram-ui] auto-generated self-signed TLS cert (SAN: ${subjectAltName})`,
    );
    return {
      key: readFileSync(tlsKeyPath),
      cert: readFileSync(tlsCertPath),
    };
  } catch (err) {
    const hint = osPlatform() === "win32"
      ? " Install Git for Windows (https://git-scm.com) to get openssl, or set TELEGRAM_UI_TLS_DISABLE=true and let Cloudflare provide HTTPS."
      : " Install openssl (e.g. `apt install openssl` / `brew install openssl`).";
    console.warn(
      `[telegram-ui] TLS cert generation failed — falling back to HTTP.${hint}\n  Error: ${err.message}`,
    );
    return null;
  }
}

// ── Firewall detection and management ────────────────────────────────

/** Detected firewall state — populated by checkFirewall() */
let firewallState = null;

/** Return the last firewall check result (or null). */
export function getFirewallState() {
  return firewallState;
}

/**
 * Detect the active firewall and check if a given TCP port is allowed.
 * Uses a TCP self-connect probe as the ground truth, then identifies the
 * firewall for the fix command.
 * Returns { firewall, blocked, allowCmd, status } or null if no firewall.
 */
async function checkFirewall(port) {
  const lanIp = getLocalLanIp();
  if (!lanIp) return null;

  // Ground truth: try connecting to ourselves on the LAN IP
  const reachable = await new Promise((resolve) => {
    const sock = netConnect({ host: lanIp, port, timeout: 3000 });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
    sock.once("timeout", () => { sock.destroy(); resolve(false); });
  });

  // Detect which firewall is active (for the fix command)
  const fwInfo = detectFirewallType(port);

  if (reachable) {
    return fwInfo
      ? { ...fwInfo, blocked: false, status: "allowed" }
      : null;
  }

  // Port is not reachable — report as blocked
  return fwInfo
    ? { ...fwInfo, blocked: true, status: "blocked" }
    : { firewall: "unknown", blocked: true, allowCmd: `# Check your firewall settings for port ${port}/tcp`, status: "blocked" };
}

/**
 * Identify the active firewall and build the fix command (without needing root).
 */
function detectFirewallType(port) {
  const platform = process.platform;
  try {
    if (platform === "linux") {
      // Check ufw
      try {
        const active = execSync("systemctl is-active ufw 2>/dev/null", { encoding: "utf8", timeout: 3000 }).trim();
        if (active === "active") {
          return {
            firewall: "ufw",
            allowCmd: `sudo ufw allow ${port}/tcp comment "bosun UI"`,
          };
        }
      } catch { /* not active */ }

      // Check firewalld
      try {
        const active = execSync("systemctl is-active firewalld 2>/dev/null", { encoding: "utf8", timeout: 3000 }).trim();
        if (active === "active") {
          return {
            firewall: "firewalld",
            allowCmd: `sudo firewall-cmd --add-port=${port}/tcp --permanent && sudo firewall-cmd --reload`,
          };
        }
      } catch { /* not active */ }

      // Fallback: iptables
      return {
        firewall: "iptables",
        allowCmd: `sudo iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`,
      };
    }

    if (platform === "win32") {
      return {
        firewall: "windows",
        allowCmd: `netsh advfirewall firewall add rule name="bosun UI" dir=in action=allow protocol=tcp localport=${port}`,
      };
    }

    if (platform === "darwin") {
      return {
        firewall: "pf",
        allowCmd: `echo 'pass in proto tcp from any to any port ${port}' | sudo pfctl -ef -`,
      };
    }
  } catch { /* detection failed */ }
  return null;
}

/**
 * Attempt to open a firewall port. Uses pkexec for GUI prompt, falls back to sudo.
 * Returns { success, message }.
 */
export async function openFirewallPort(port) {
  const state = firewallState || await checkFirewall(port);
  if (!state || !state.blocked) {
    return { success: true, message: "Port already allowed or no firewall detected." };
  }

  const { firewall, allowCmd } = state;

  // Try pkexec first (GUI sudo prompt — works on Linux desktop)
  if (process.platform === "linux") {
    const safePort = Number.parseInt(String(port), 10);
    if (!Number.isInteger(safePort) || safePort <= 0 || safePort > 65535) {
      return { success: false, message: "Invalid port." };
    }

    try {
      if (firewall === "ufw") {
        const res = spawnSync(
          "pkexec",
          ["ufw", "allow", `${safePort}/tcp`, "comment", "bosun UI"],
          { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
        );
        if (res.error || res.status !== 0) {
          throw new Error(String(res.stderr || res.stdout || "pkexec ufw failed").trim());
        }
      } else if (firewall === "firewalld") {
        const addRes = spawnSync(
          "pkexec",
          ["firewall-cmd", `--add-port=${safePort}/tcp`, "--permanent"],
          { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
        );
        if (addRes.error || addRes.status !== 0) {
          throw new Error(
            String(addRes.stderr || addRes.stdout || "pkexec firewall-cmd add failed").trim(),
          );
        }
        const reloadRes = spawnSync("pkexec", ["firewall-cmd", "--reload"], {
          encoding: "utf8",
          timeout: 60000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (reloadRes.error || reloadRes.status !== 0) {
          throw new Error(
            String(reloadRes.stderr || reloadRes.stdout || "pkexec firewall-cmd reload failed").trim(),
          );
        }
      } else {
        const res = spawnSync(
          "pkexec",
          ["iptables", "-I", "INPUT", "-p", "tcp", "--dport", String(safePort), "-j", "ACCEPT"],
          { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] },
        );
        if (res.error || res.status !== 0) {
          throw new Error(String(res.stderr || res.stdout || "pkexec iptables failed").trim());
        }
      }
      // Re-check after opening
      firewallState = await checkFirewall(port);
      return { success: true, message: `Firewall rule added via ${firewall}.` };
    } catch (err) {
      // pkexec failed (user dismissed, not available, etc.)
      return {
        success: false,
        message: `Could not auto-open port. Run manually:\n\`${allowCmd}\``,
      };
    }
  }

  if (process.platform === "win32") {
    try {
      execSync(allowCmd, { encoding: "utf8", timeout: 30000, stdio: "pipe" });
      firewallState = await checkFirewall(port);
      return { success: true, message: "Windows firewall rule added." };
    } catch {
      return {
        success: false,
        message: `Could not auto-open port. Run as admin:\n\`${allowCmd}\``,
      };
    }
  }

  return {
    success: false,
    message: `Run manually:\n\`${allowCmd}\``,
  };
}

// ── Cloudflared tunnel for trusted TLS ──────────────────────────────

const TUNNEL_MODE_NAMED = "named";
const TUNNEL_MODE_QUICK = "quick";
const TUNNEL_MODE_DISABLED = "disabled";
const DEFAULT_TUNNEL_MODE = TUNNEL_MODE_NAMED;
const DEFAULT_CLOUDFLARE_DNS_RETRY_MAX = 3;
const DEFAULT_CLOUDFLARE_DNS_RETRY_BASE_MS = 750;
const DEFAULT_QUICK_TUNNEL_RESTART_COOLDOWN_MS = 15 * 60 * 1000;
const RESERVED_HOSTNAME_LABELS = new Set([
  "www",
  "api",
  "admin",
  "root",
  "mail",
  "ftp",
  "smtp",
  "autodiscover",
  "localhost",
]);

let tunnelUrl = null;
let tunnelProcess = null;
let tunnelPublicHostname = "";
let tunnelRuntimeState = {
  mode: TUNNEL_MODE_DISABLED,
  tunnelName: "",
  tunnelId: "",
  hostname: "",
  dnsAction: "none",
  dnsStatus: "not_configured",
  fallbackToQuick: false,
  lastError: "",
  outputTail: "",
};
let quickTunnelRestartTimer = null;
let quickTunnelRestartAttempts = 0;
let quickTunnelRestartSuppressed = false;
let tunnelStopRequested = false;

/** Return the active tunnel URL (named or quick) or null. */
export function getTunnelUrl() {
  return tunnelUrl;
}

export function getTunnelStatus() {
  return {
    mode: tunnelRuntimeState.mode,
    tunnelName: tunnelRuntimeState.tunnelName || null,
    tunnelId: tunnelRuntimeState.tunnelId || null,
    hostname: tunnelRuntimeState.hostname || tunnelPublicHostname || null,
    publicUrl: tunnelUrl || null,
    dns: {
      status: tunnelRuntimeState.dnsStatus || "unknown",
      action: tunnelRuntimeState.dnsAction || "none",
    },
    fallbackToQuick: Boolean(tunnelRuntimeState.fallbackToQuick),
    active: Boolean(tunnelProcess && tunnelUrl),
    lastError: tunnelRuntimeState.lastError || null,
    outputTail: tunnelRuntimeState.outputTail || "",
  };
}

let _tunnelReadyCallbacks = [];

/** Register a callback to be called whenever the tunnel URL changes. */
export function onTunnelUrlChange(cb) {
  if (typeof cb === "function") _tunnelReadyCallbacks.push(cb);
}

function setTunnelRuntimeState(next = {}) {
  tunnelRuntimeState = {
    ...tunnelRuntimeState,
    ...next,
  };
}

function appendOutputTail(existing, chunk, maxBytes = 64 * 1024) {
  const merged = `${String(existing || "")}${String(chunk || "")}`;
  if (merged.length <= maxBytes) return merged;
  return merged.slice(-maxBytes);
}

function formatTunnelOutputHint(rawTail, maxChars = 180) {
  const singleLine = String(rawTail || "").replace(/\s+/g, " ").trim();
  if (!singleLine) return "";
  if (singleLine.length <= maxChars) return singleLine;
  return `...${singleLine.slice(-maxChars)}`;
}

function shouldRestartForProcessExit(code, signal) {
  if (typeof code === "number") return code !== 0;
  const codeText = String(code ?? "").trim();
  const parsedCode = Number.parseInt(codeText, 10);
  if (!Number.isFinite(parsedCode) && codeText) {
    const embeddedMatch = codeText.match(/-?\d+/);
    if (embeddedMatch) {
      const embeddedCode = Number.parseInt(embeddedMatch[0], 10);
      if (Number.isFinite(embeddedCode)) return embeddedCode !== 0;
    }
    // Some wrappers emit non-empty textual statuses (for example "exit status 1").
    // Treat non-zero/unknown textual codes as restartable to avoid false terminal classification.
    if (!["0", "null", "undefined"].includes(codeText.toLowerCase())) return true;
  }
  if (Number.isFinite(parsedCode)) return parsedCode !== 0;
  return typeof signal === "string" && signal.length > 0;
}

export function normalizeTunnelMode(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) return DEFAULT_TUNNEL_MODE;
  if (["disabled", "off", "false", "0"].includes(value)) return TUNNEL_MODE_DISABLED;
  if (["quick", "quick-tunnel", "ephemeral", "trycloudflare"].includes(value)) {
    return TUNNEL_MODE_QUICK;
  }
  if (["cloudflared", "auto", "named", "permanent"].includes(value)) {
    return TUNNEL_MODE_NAMED;
  }
  return DEFAULT_TUNNEL_MODE;
}

function parseBooleanEnvValue(rawValue, fallback = false) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallback;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseBoundedInt(rawValue, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeDomainName(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) return "";
  let withoutScheme = value;
  if (withoutScheme.startsWith("http://")) withoutScheme = withoutScheme.slice(7);
  else if (withoutScheme.startsWith("https://")) withoutScheme = withoutScheme.slice(8);
  const slashIndex = withoutScheme.indexOf("/");
  const withoutPath = slashIndex >= 0 ? withoutScheme.slice(0, slashIndex) : withoutScheme;
  const colonIndex = withoutPath.lastIndexOf(":");
  const hostOnly = colonIndex > 0 ? withoutPath.slice(0, colonIndex) : withoutPath;
  let end = hostOnly.length;
  while (end > 0 && hostOnly[end - 1] === ".") end -= 1;
  return hostOnly.slice(0, end);
}

export function sanitizeHostnameLabel(rawValue, fallback = "operator") {
  const input = String(rawValue || "").trim().toLowerCase();
  if (!input) return fallback;
  let out = "";
  let prevDash = false;
  for (const ch of input) {
    const isAlphaNum =
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9");
    if (isAlphaNum) {
      out += ch;
      prevDash = false;
      continue;
    }
    if (ch === "-") {
      if (!prevDash) {
        out += "-";
        prevDash = true;
      }
      continue;
    }
    if (!prevDash) {
      out += "-";
      prevDash = true;
    }
  }
  while (out.startsWith("-")) out = out.slice(1);
  while (out.endsWith("-")) out = out.slice(0, -1);
  if (!out) return fallback;
  const bounded = out.slice(0, 63);
  return bounded.endsWith("-") ? bounded.slice(0, -1) || fallback : bounded;
}

function getTunnelIdentity() {
  const candidates = [
    process.env.CLOUDFLARE_TUNNEL_USERNAME,
    process.env.CLOUDFLARE_HOSTNAME_USER,
    process.env.BOSUN_OPERATOR_ID,
    process.env.USERNAME,
    process.env.USER,
  ];
  for (const value of candidates) {
    const trimmed = String(value || "").trim();
    if (trimmed) return trimmed;
  }
  try {
    const info = getOsUserInfo();
    if (info?.username) return info.username;
  } catch {
    // best effort
  }
  return "operator";
}

const HOSTNAME_MAP_FILE = "cloudflare-hostname-map.json";
let _hostnameMapCache = null;

function readHostnameMapStore() {
  if (_hostnameMapCache && typeof _hostnameMapCache === "object") {
    return _hostnameMapCache;
  }
  const fallback = { version: 1, domains: {} };
  try {
    const mapPath = resolveUiCachePath(HOSTNAME_MAP_FILE);
    if (!existsSync(mapPath)) {
      _hostnameMapCache = fallback;
      return fallback;
    }
    const parsed = JSON.parse(readFileSync(mapPath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      _hostnameMapCache = fallback;
      return fallback;
    }
    if (!parsed.domains || typeof parsed.domains !== "object") {
      parsed.domains = {};
    }
    _hostnameMapCache = parsed;
    return parsed;
  } catch {
    _hostnameMapCache = fallback;
    return fallback;
  }
}

function writeHostnameMapStore(data) {
  try {
    const mapPath = resolveUiCachePath(HOSTNAME_MAP_FILE);
    writeFileSync(mapPath, JSON.stringify(data, null, 2), "utf8");
  } catch {
    // best effort
  }
}

function getDomainMap(store, baseDomain) {
  const normalizedBaseDomain = normalizeDomainName(baseDomain);
  if (!normalizedBaseDomain) {
    return { normalizedBaseDomain: "", map: { byIdentity: {}, byLabel: {} } };
  }
  if (!store.domains[normalizedBaseDomain] || typeof store.domains[normalizedBaseDomain] !== "object") {
    store.domains[normalizedBaseDomain] = {
      byIdentity: {},
      byLabel: {},
    };
  }
  const domainMap = store.domains[normalizedBaseDomain];
  if (!domainMap.byIdentity || typeof domainMap.byIdentity !== "object") {
    domainMap.byIdentity = {};
  }
  if (!domainMap.byLabel || typeof domainMap.byLabel !== "object") {
    domainMap.byLabel = {};
  }
  return { normalizedBaseDomain, map: domainMap };
}

function allocateStableHostnameLabel(domainMap, identity, preferredLabel) {
  const normalizedIdentity = String(identity || "").trim().toLowerCase();
  const existing = String(domainMap.byIdentity?.[normalizedIdentity] || "").trim().toLowerCase();
  if (existing && domainMap.byLabel?.[existing] === normalizedIdentity) {
    return existing;
  }

  const safeBaseLabel = sanitizeHostnameLabel(preferredLabel, "operator");
  let baseLabel = RESERVED_HOSTNAME_LABELS.has(safeBaseLabel)
    ? `${safeBaseLabel}-user`
    : safeBaseLabel;
  baseLabel = sanitizeHostnameLabel(baseLabel, "operator");
  let candidate = baseLabel;
  let suffix = 1;

  while (true) {
    const owner = String(domainMap.byLabel?.[candidate] || "").trim().toLowerCase();
    const reserved = RESERVED_HOSTNAME_LABELS.has(candidate);
    if ((!owner || owner === normalizedIdentity) && !reserved) {
      domainMap.byLabel[candidate] = normalizedIdentity;
      domainMap.byIdentity[normalizedIdentity] = candidate;
      return candidate;
    }
    suffix += 1;
    candidate = sanitizeHostnameLabel(`${baseLabel}-${suffix}`, baseLabel);
  }
}

export function resolveDeterministicTunnelHostname({
  baseDomain,
  explicitHostname,
  username,
  policy,
} = {}) {
  const normalizedBaseDomain = normalizeDomainName(
    baseDomain || process.env.CLOUDFLARE_BASE_DOMAIN || process.env.CF_BASE_DOMAIN,
  );
  const explicit = normalizeDomainName(
    explicitHostname || process.env.CLOUDFLARE_TUNNEL_HOSTNAME || process.env.CF_TUNNEL_HOSTNAME,
  );
  if (explicit) {
    return {
      hostname: explicit,
      baseDomain: explicit.split(".").slice(1).join("."),
      label: explicit.split(".")[0] || "operator",
      identity: "",
      policy: "explicit",
      source: "explicit",
    };
  }
  if (!normalizedBaseDomain) {
    throw new Error(
      "Missing CLOUDFLARE_BASE_DOMAIN (or CLOUDFLARE_TUNNEL_HOSTNAME) for named tunnel hostname resolution",
    );
  }
  const resolvedPolicy = String(
    policy || process.env.CLOUDFLARE_USERNAME_HOSTNAME_POLICY || "per-user-fixed",
  )
    .trim()
    .toLowerCase();
  const perUserFixed = resolvedPolicy !== "fixed";
  const identityRaw = username || getTunnelIdentity();
  const identity = sanitizeHostnameLabel(identityRaw, "operator");

  if (!perUserFixed) {
    const fixedLabel = sanitizeHostnameLabel(
      process.env.CLOUDFLARE_FIXED_HOST_LABEL || process.env.CF_FIXED_HOST_LABEL || "bosun",
      "bosun",
    );
    const label = RESERVED_HOSTNAME_LABELS.has(fixedLabel)
      ? sanitizeHostnameLabel(`${fixedLabel}-app`, "bosun")
      : fixedLabel;
    return {
      hostname: `${label}.${normalizedBaseDomain}`,
      baseDomain: normalizedBaseDomain,
      label,
      identity,
      policy: "fixed",
      source: "fixed",
    };
  }

  const store = readHostnameMapStore();
  const { map } = getDomainMap(store, normalizedBaseDomain);
  const label = allocateStableHostnameLabel(map, identity, identity);
  writeHostnameMapStore(store);
  return {
    hostname: `${label}.${normalizedBaseDomain}`,
    baseDomain: normalizedBaseDomain,
    label,
    identity,
    policy: "per-user-fixed",
    source: "map",
  };
}

function _notifyTunnelChange(url) {
  for (const cb of _tunnelReadyCallbacks) {
    try {
      cb(url);
    } catch (err) {
      console.warn(`[telegram-ui] tunnel change callback error: ${err.message}`);
    }
  }
}

function getCloudflareApiConfig() {
  const token = String(
    process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "",
  ).trim();
  const zoneId = String(
    process.env.CLOUDFLARE_ZONE_ID || process.env.CF_ZONE_ID || "",
  ).trim();
  const enabled = parseBooleanEnvValue(process.env.CLOUDFLARE_DNS_SYNC_ENABLED, true);
  return {
    enabled,
    token,
    zoneId,
    baseUrl: "https://api.cloudflare.com/client/v4",
  };
}

function getCloudflareDnsRetryConfig() {
  const maxRetries = parseBoundedInt(
    process.env.CLOUDFLARE_DNS_MAX_RETRIES,
    DEFAULT_CLOUDFLARE_DNS_RETRY_MAX,
    { min: 1, max: 8 },
  );
  const retryBaseMs = parseBoundedInt(
    process.env.CLOUDFLARE_DNS_RETRY_BASE_MS,
    DEFAULT_CLOUDFLARE_DNS_RETRY_BASE_MS,
    { min: 100, max: 5000 },
  );
  return { maxRetries, retryBaseMs };
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function cloudflareApiRequest(api, path, { method = "GET", body = undefined } = {}) {
  const { maxRetries, retryBaseMs } = getCloudflareDnsRetryConfig();
  if (!api?.token || !api?.zoneId) {
    throw new Error("Cloudflare API token/zone not configured");
  }
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetch(`${api.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${api.token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.success === false) {
        const errMessage = Array.isArray(payload?.errors)
          ? payload.errors.map((entry) => entry?.message).filter(Boolean).join("; ")
          : `${res.status} ${res.statusText || ""}`.trim();
        const err = new Error(`Cloudflare API ${method} ${path} failed: ${errMessage}`);
        err.status = res.status;
        throw err;
      }
      return payload;
    } catch (err) {
      lastError = err;
      const status = Number(err?.status || 0);
      const retryable = status === 429 || status >= 500 || status === 0;
      if (!retryable || attempt >= maxRetries) break;
      const backoff = retryBaseMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * Math.min(500, Math.max(100, backoff / 3)));
      await sleep(backoff + jitter);
    }
  }
  throw lastError || new Error(`Cloudflare API ${method} ${path} failed`);
}

export async function ensureCloudflareDnsCname({
  hostname,
  target,
  proxied = true,
  api = getCloudflareApiConfig(),
} = {}) {
  const normalizedHostname = normalizeDomainName(hostname);
  const normalizedTarget = normalizeDomainName(target);
  if (!normalizedHostname || !normalizedTarget) {
    throw new Error("Missing hostname/target for Cloudflare DNS sync");
  }
  if (!api?.enabled) {
    return { ok: true, changed: false, action: "disabled" };
  }
  if (!api.token || !api.zoneId) {
    return { ok: false, changed: false, action: "missing_credentials" };
  }

  const query = `/zones/${encodeURIComponent(api.zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(normalizedHostname)}&per_page=100`;
  const listed = await cloudflareApiRequest(api, query, { method: "GET" });
  const records = Array.isArray(listed?.result) ? listed.result : [];
  const existing = records.find(
    (record) => String(record?.type || "").toUpperCase() === "CNAME"
      && String(record?.name || "").toLowerCase() === normalizedHostname,
  );
  const payload = {
    type: "CNAME",
    name: normalizedHostname,
    content: normalizedTarget,
    proxied: Boolean(proxied),
    ttl: 1,
  };

  if (existing) {
    const sameTarget = String(existing.content || "").toLowerCase() === normalizedTarget;
    const sameProxy = Boolean(existing.proxied) === Boolean(payload.proxied);
    if (sameTarget && sameProxy) {
      return { ok: true, changed: false, action: "noop", id: existing.id };
    }
    const updated = await cloudflareApiRequest(
      api,
      `/zones/${encodeURIComponent(api.zoneId)}/dns_records/${encodeURIComponent(existing.id)}`,
      { method: "PUT", body: payload },
    );
    return {
      ok: true,
      changed: true,
      action: "updated",
      id: updated?.result?.id || existing.id,
    };
  }

  const created = await cloudflareApiRequest(
    api,
    `/zones/${encodeURIComponent(api.zoneId)}/dns_records`,
    { method: "POST", body: payload },
  );
  return {
    ok: true,
    changed: true,
    action: "created",
    id: created?.result?.id || null,
  };
}

function getTunnelStartupConfig() {
  return {
    mode: normalizeTunnelMode(process.env.TELEGRAM_UI_TUNNEL || DEFAULT_TUNNEL_MODE),
    namedTunnel: String(
      process.env.CLOUDFLARE_TUNNEL_NAME || process.env.CF_TUNNEL_NAME || "",
    ).trim(),
    credentialsPath: String(
      process.env.CLOUDFLARE_TUNNEL_CREDENTIALS || process.env.CF_TUNNEL_CREDENTIALS || "",
    ).trim(),
    allowQuickFallback: parseBooleanEnvValue(
      process.env.TELEGRAM_UI_ALLOW_QUICK_TUNNEL_FALLBACK,
      false,
    ),
  };
}

// ── Cloudflared binary auto-download ─────────────────────────────────

const CF_BIN_NAME = osPlatform() === "win32" ? "cloudflared.exe" : "cloudflared";

/**
 * Get the cloudflared download URL for the current platform+arch.
 * Uses GitHub releases (no account needed).
 */
function getCloudflaredDownloadUrl() {
  const plat = osPlatform();
  const ar = osArch();
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  if (plat === "linux") {
    if (ar === "arm64" || ar === "aarch64") return `${base}/cloudflared-linux-arm64`;
    return `${base}/cloudflared-linux-amd64`;
  }
  if (plat === "win32") {
    return `${base}/cloudflared-windows-amd64.exe`;
  }
  if (plat === "darwin") {
    if (ar === "arm64") return `${base}/cloudflared-darwin-arm64.tgz`;
    return `${base}/cloudflared-darwin-amd64.tgz`;
  }
  return null;
}

/**
 * Download a file from URL, following redirects (GitHub releases use 302).
 * Returns a promise that resolves when the file is fully written and closed.
 */
function downloadFile(url, destPath, maxRedirects = 5) {
  return new Promise((res, rej) => {
    if (maxRedirects <= 0) return rej(new Error("Too many redirects"));
    httpsGet(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return downloadFile(response.headers.location, destPath, maxRedirects - 1).then(res, rej);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return rej(new Error(`HTTP ${response.statusCode}`));
      }
      const stream = createWriteStream(destPath);
      response.pipe(stream);
      // Wait for 'close' not 'finish' — ensures file descriptor is fully released
      stream.on("close", () => res());
      stream.on("error", (err) => {
        stream.close();
        rej(err);
      });
    }).on("error", rej);
  });
}

/**
 * Find cloudflared binary — checks system PATH first, then cached download.
 * If not found anywhere and mode=auto, auto-downloads to .cache/bin/.
 */
async function findCloudflared() {
  const cfCacheDir = dirname(resolveUiSubCachePath("bin", ".keep"));
  const cfCachedPath = resolve(cfCacheDir, CF_BIN_NAME);
  // 1. Check system PATH
  try {
    const cmd = osPlatform() === "win32"
      ? "where cloudflared 2>nul"
      : "which cloudflared 2>/dev/null";
    const found = execSync(cmd, { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (found) return found.split(/\r?\n/)[0]; // `where` may return multiple lines
  } catch { /* not on PATH */ }

  // 2. Check cached binary
  if (existsSync(cfCachedPath)) {
    return cfCachedPath;
  }

  // 3. Auto-download
  const dlUrl = getCloudflaredDownloadUrl();
  if (!dlUrl) {
    console.warn("[telegram-ui] cloudflared: unsupported platform/arch for auto-download");
    return null;
  }

  console.log("[telegram-ui] cloudflared not found — auto-downloading...");
  try {
    mkdirSync(cfCacheDir, { recursive: true });
    await downloadFile(dlUrl, cfCachedPath);
    if (osPlatform() !== "win32") {
      chmodSync(cfCachedPath, 0o755);
      // Small delay to ensure OS fully releases file locks after chmod
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`[telegram-ui] cloudflared downloaded to ${cfCachedPath}`);
    return cfCachedPath;
  } catch (err) {
    console.warn(`[telegram-ui] cloudflared auto-download failed: ${err.message}`);
    return null;
  }
}

/**
 * Start a cloudflared tunnel for the given local URL.
 *
 * Modes:
 * - named (default): persistent per-user hostname + DNS orchestration
 * - quick: random trycloudflare hostname (explicit fallback mode)
 * - disabled: no tunnel
 *
 * Returns the assigned public URL or null on failure.
 */
async function startTunnel(localPort) {
  tunnelStopRequested = false;
  // Prevent stale quick-restart timers from previous tunnel sessions from racing this startup.
  quickTunnelRestartSuppressed = true;
  clearQuickTunnelRestartTimer();
  quickTunnelRestartAttempts = 0;
  const tunnelCfg = getTunnelStartupConfig();
  setTunnelRuntimeState({
    mode: tunnelCfg.mode,
    tunnelName: tunnelCfg.namedTunnel || "",
    tunnelId: "",
    hostname: "",
    dnsAction: "none",
    dnsStatus: "not_configured",
    fallbackToQuick: false,
    lastError: "",
    outputTail: "",
  });

  if (tunnelCfg.mode === TUNNEL_MODE_DISABLED) {
    console.log("[telegram-ui] tunnel disabled via TELEGRAM_UI_TUNNEL=disabled");
    return null;
  }

  // ── SECURITY: Block tunnel when auth is disabled ─────────────────────
  if (isAllowUnsafe()) {
    console.error(
      "[telegram-ui] :ban: REFUSING to start Cloudflare tunnel — TELEGRAM_UI_ALLOW_UNSAFE=true\n" +
      "  A public tunnel with no authentication lets ANYONE on the internet\n" +
      "  control your agents, read secrets, and execute commands.\n" +
      "\n" +
      "  To get the tunnel working, choose one option:\n" +
      "    Option A (recommended): Remove TELEGRAM_UI_ALLOW_UNSAFE from your .env\n" +
      "      and configure Telegram bot auth (set TELEGRAM_BOT_TOKEN).\n" +
      "    Option B: Keep ALLOW_UNSAFE=true but disable the tunnel:\n" +
      "      Set TELEGRAM_UI_TUNNEL=disabled in your .env (LAN-only access).",
    );
    return null;
  }

  const cfBin = await findCloudflared();
  if (!cfBin) {
    setTunnelRuntimeState({ lastError: "cloudflared_not_found" });
    console.warn("[telegram-ui] cloudflared unavailable; tunnel not started");
    return null;
  }

  if (tunnelCfg.mode === TUNNEL_MODE_QUICK) {
    return startQuickTunnel(cfBin, localPort);
  }

  const namedTunnelResult = await startNamedTunnel(
    cfBin,
    {
      tunnelName: tunnelCfg.namedTunnel,
      credentialsPath: tunnelCfg.credentialsPath,
    },
    localPort,
  );
  if (namedTunnelResult) return namedTunnelResult;

  if (tunnelCfg.allowQuickFallback) {
    console.warn("[telegram-ui] named tunnel failed; falling back to quick tunnel (explicitly allowed)");
    setTunnelRuntimeState({
      fallbackToQuick: true,
      mode: TUNNEL_MODE_QUICK,
    });
    return startQuickTunnel(cfBin, localPort);
  }

  setTunnelRuntimeState({
    fallbackToQuick: false,
    lastError: tunnelRuntimeState.lastError || "named_tunnel_failed",
  });
  return null;
}

/**
 * Spawn cloudflared with ETXTBSY retry (race condition after fresh download).
 * Returns the child process or throws after max retries.
 */
async function spawnCloudflared(cfBin, args, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return spawn(cfBin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
      });
    } catch (err) {
      if (err.code === "ETXTBSY" && attempt < maxRetries) {
        // File still locked from download — wait and retry
        const delayMs = attempt * 100;
        console.warn(`[telegram-ui] spawn ETXTBSY (attempt ${attempt}/${maxRetries}) — retrying in ${delayMs}ms`);
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error("spawn failed after retries");
}

/**
 * Start a cloudflared **named tunnel** with persistent URL.
 * Requires tunnel credentials + DNS hostname (explicit or deterministic per-user mapping).
 */
function parseNamedTunnelCredentials(credentialsPath) {
  if (!existsSync(credentialsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, "utf8"));
    const tunnelId = String(parsed?.TunnelID || parsed?.tunnel_id || "").trim();
    if (!tunnelId) return null;
    return {
      tunnelId,
      credentialsPath,
    };
  } catch {
    return null;
  }
}

async function startNamedTunnel(cfBin, { tunnelName, credentialsPath }, localPort) {
  tunnelStopRequested = false;
  setTunnelRuntimeState({
    mode: TUNNEL_MODE_NAMED,
    outputTail: "",
  });
  const normalizedTunnelName = String(tunnelName || "").trim();
  const normalizedCredsPath = String(credentialsPath || "").trim();
  if (!normalizedTunnelName || !normalizedCredsPath) {
    setTunnelRuntimeState({
      lastError: "missing_named_tunnel_config",
      mode: TUNNEL_MODE_NAMED,
    });
    console.warn(
      "[telegram-ui] named tunnel requires CLOUDFLARE_TUNNEL_NAME + CLOUDFLARE_TUNNEL_CREDENTIALS.\n" +
      "[telegram-ui] Run \"bosun --setup\" and choose \"Named tunnel\" to configure Cloudflare credentials,\n" +
      "[telegram-ui] or set TELEGRAM_UI_TUNNEL=quick for an ephemeral trycloudflare.com URL.",
    );
    return null;
  }

  const parsedCreds = parseNamedTunnelCredentials(normalizedCredsPath);
  if (!parsedCreds) {
    setTunnelRuntimeState({
      lastError: "invalid_named_tunnel_credentials",
      mode: TUNNEL_MODE_NAMED,
      tunnelName: normalizedTunnelName,
    });
    console.warn(
      `[telegram-ui] named tunnel credentials not found or invalid: ${normalizedCredsPath}\n` +
      `[telegram-ui] Ensure the path is correct and the file exists.\n` +
      `[telegram-ui] Re-run "bosun --setup" to reconfigure Cloudflare tunnel credentials.`,
    );
    return null;
  }

  let hostnameInfo;
  try {
    hostnameInfo = resolveDeterministicTunnelHostname();
  } catch (err) {
    setTunnelRuntimeState({
      lastError: "hostname_resolution_failed",
      mode: TUNNEL_MODE_NAMED,
      tunnelName: normalizedTunnelName,
      tunnelId: parsedCreds.tunnelId,
    });
    console.warn(`[telegram-ui] named tunnel hostname resolution failed: ${err.message}`);
    return null;
  }

  const dnsTarget = `${parsedCreds.tunnelId}.cfargotunnel.com`;
  const cfApi = getCloudflareApiConfig();
  let dnsSync = { ok: false, changed: false, action: "missing_credentials" };
  try {
    dnsSync = await ensureCloudflareDnsCname({
      hostname: hostnameInfo.hostname,
      target: dnsTarget,
      proxied: true,
      api: cfApi,
    });
    if (dnsSync.ok) {
      console.log(
        `[telegram-ui] cloudflare DNS ${dnsSync.action}: ${hostnameInfo.hostname} -> ${dnsTarget}`,
      );
    } else if (dnsSync.action === "missing_credentials") {
      console.warn(
        "[telegram-ui] Cloudflare DNS sync skipped (missing CLOUDFLARE_API_TOKEN/CLOUDFLARE_ZONE_ID)",
      );
    }
  } catch (err) {
    setTunnelRuntimeState({
      lastError: "dns_sync_failed",
      mode: TUNNEL_MODE_NAMED,
      tunnelName: normalizedTunnelName,
      tunnelId: parsedCreds.tunnelId,
      hostname: hostnameInfo.hostname,
      dnsAction: "error",
      dnsStatus: "error",
    });
    console.warn(`[telegram-ui] Cloudflare DNS sync failed: ${err.message}`);
    return null;
  }

  // Named tunnels require config file with ingress rules.
  const configPath = resolveUiCachePath("cloudflared-config.yml");
  const credsPathYaml = normalizedCredsPath.replace(/\\/g, "/");
  const configYaml = `
tunnel: ${normalizedTunnelName}
credentials-file: ${credsPathYaml}

ingress:
  - hostname: "${hostnameInfo.hostname}"
    service: https://localhost:${localPort}
    originRequest:
      noTLSVerify: true
  - service: http_status:404
`.trim();

  writeFileSync(configPath, configYaml, "utf8");

  const args = ["tunnel", "--config", configPath, "run"];
  const publicUrl = `https://${hostnameInfo.hostname}`;
  console.log(
    `[telegram-ui] starting named tunnel: ${normalizedTunnelName} -> ${publicUrl} -> https://localhost:${localPort}`,
  );

  let child;
  try {
    child = await spawnCloudflared(cfBin, args);
  } catch (err) {
    setTunnelRuntimeState({
      lastError: "named_tunnel_spawn_failed",
      mode: TUNNEL_MODE_NAMED,
      tunnelName: normalizedTunnelName,
      tunnelId: parsedCreds.tunnelId,
      hostname: hostnameInfo.hostname,
    });
    console.warn(`[telegram-ui] named tunnel spawn failed: ${err.message}`);
    return null;
  }
  // Track startup child so stopTunnel() can terminate it even before readiness.
  tunnelProcess = child;
  if (tunnelStopRequested) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    tunnelProcess = null;
    return null;
  }

  return new Promise((resolvePromise) => {

    let resolved = false;
    let namedTimeoutTriggeredTermination = false;
    let output = "";
    // Named tunnels emit "Connection <UUID> registered" (or "Registered tunnel connection")
    const readyPattern = /Connection [a-f0-9-]+ registered|Registered tunnel connection/i;
    const namedTunnelTimeoutMs = parseBoundedInt(
      process.env.TELEGRAM_UI_NAMED_TUNNEL_TIMEOUT_MS,
      60_000,
      { min: 10_000, max: 300_000 },
    );
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        setTunnelRuntimeState({
          lastError: "named_tunnel_timeout",
          mode: TUNNEL_MODE_NAMED,
          tunnelName: normalizedTunnelName,
          tunnelId: parsedCreds.tunnelId,
          hostname: hostnameInfo.hostname,
        });
        console.warn(`[telegram-ui] named tunnel timed out after ${namedTunnelTimeoutMs}ms`);
        namedTimeoutTriggeredTermination = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolvePromise(null);
      }
    }, namedTunnelTimeoutMs);

    function parseOutput(chunk) {
      if (tunnelStopRequested) return;
      output = appendOutputTail(output, chunk);
      setTunnelRuntimeState({ outputTail: output });
      if (readyPattern.test(output) && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        tunnelUrl = publicUrl;
        tunnelPublicHostname = hostnameInfo.hostname;
        tunnelProcess = child;
        quickTunnelRestartAttempts = 0;
        setTunnelRuntimeState({
          mode: TUNNEL_MODE_NAMED,
          tunnelName: normalizedTunnelName,
          tunnelId: parsedCreds.tunnelId,
          hostname: hostnameInfo.hostname,
          dnsAction: dnsSync.action || "none",
          dnsStatus: dnsSync.ok ? "ok" : "not_configured",
          fallbackToQuick: false,
          lastError: "",
        });
        _notifyTunnelChange(publicUrl);
        console.log(`[telegram-ui] named tunnel active: ${publicUrl}`);
        resolvePromise(publicUrl);
      }
    }

    child.stdout.on("data", (d) => parseOutput(d.toString()));
    child.stderr.on("data", (d) => parseOutput(d.toString()));

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        if (tunnelStopRequested) {
          resolvePromise(null);
          return;
        }
        setTunnelRuntimeState({
          lastError: "named_tunnel_runtime_error",
          mode: TUNNEL_MODE_NAMED,
          tunnelName: normalizedTunnelName,
          tunnelId: parsedCreds.tunnelId,
          hostname: hostnameInfo.hostname,
        });
        const outputHint = formatTunnelOutputHint(output);
        console.warn(
          `[telegram-ui] named tunnel failed: ${err.message}${outputHint ? ` (tail: ${outputHint})` : ""}`,
        );
        resolvePromise(null);
      }
    });

    child.on("exit", (code, signal) => {
      tunnelProcess = null;
      tunnelUrl = null;
      tunnelPublicHostname = "";
      _notifyTunnelChange(null);
      if (tunnelStopRequested) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolvePromise(null);
        }
        return;
      }
      if (namedTimeoutTriggeredTermination) {
        namedTimeoutTriggeredTermination = false;
        return;
      }
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        setTunnelRuntimeState({
          lastError: "named_tunnel_exited_early",
          mode: TUNNEL_MODE_NAMED,
          tunnelName: normalizedTunnelName,
          tunnelId: parsedCreds.tunnelId,
          hostname: hostnameInfo.hostname,
        });
        const outputHint = formatTunnelOutputHint(output);
        console.warn(
          `[telegram-ui] named tunnel exited with code ${code}${signal ? ` signal ${signal}` : ""}${outputHint ? ` (tail: ${outputHint})` : ""}`,
        );
        resolvePromise(null);
      } else if (shouldRestartForProcessExit(code, signal)) {
        setTunnelRuntimeState({
          lastError: "named_tunnel_exited",
        });
        const outputHint = formatTunnelOutputHint(output);
        console.warn(
          `[telegram-ui] named tunnel exited (code ${code}${signal ? `, signal ${signal}` : ""})${outputHint ? ` (tail: ${outputHint})` : ""}`,
        );
      }
    });
  });
}

/**
 * Start a cloudflared **quick tunnel** (random *.trycloudflare.com URL).
 * Quick tunnels are free, require no account, but the URL changes on each restart.
 */
function clearQuickTunnelRestartTimer() {
  if (quickTunnelRestartTimer) {
    clearTimeout(quickTunnelRestartTimer);
    quickTunnelRestartTimer = null;
  }
}

function getQuickTunnelRestartConfig() {
  const maxAttempts = parseBoundedInt(
    process.env.TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_ATTEMPTS,
    6,
    { min: 1, max: 50 },
  );
  const baseDelayMs = parseBoundedInt(
    process.env.TELEGRAM_UI_QUICK_TUNNEL_RESTART_BASE_DELAY_MS
      || process.env.TELEGRAM_UI_QUICK_TUNNEL_RESTART_BASE_MS,
    5000,
    { min: 250, max: 60_000 },
  );
  const maxDelayMs = parseBoundedInt(
    process.env.TELEGRAM_UI_QUICK_TUNNEL_RESTART_MAX_DELAY_MS,
    120_000,
    { min: 1000, max: 900_000 },
  );
  const continueAfterExhaustion = parseBooleanEnvValue(
    process.env.TELEGRAM_UI_QUICK_TUNNEL_RESTART_FOREVER,
    true,
  );
  const cooldownMs = parseBoundedInt(
    process.env.TELEGRAM_UI_QUICK_TUNNEL_RESTART_COOLDOWN_MS,
    DEFAULT_QUICK_TUNNEL_RESTART_COOLDOWN_MS,
    { min: 5000, max: 24 * 60 * 60 * 1000 },
  );
  return { maxAttempts, baseDelayMs, maxDelayMs, continueAfterExhaustion, cooldownMs };
}

function scheduleQuickTunnelRestart(cfBin, localPort) {
  if (quickTunnelRestartSuppressed) return;
  const cfg = getQuickTunnelRestartConfig();
  if (quickTunnelRestartAttempts >= cfg.maxAttempts) {
    if (!cfg.continueAfterExhaustion) {
      setTunnelRuntimeState({
        mode: TUNNEL_MODE_QUICK,
        lastError: "quick_tunnel_restart_exhausted",
      });
      console.warn(
        `[telegram-ui] quick tunnel restart exhausted after ${quickTunnelRestartAttempts} attempts (max ${cfg.maxAttempts})`,
      );
      return;
    }
    setTunnelRuntimeState({
      mode: TUNNEL_MODE_QUICK,
      lastError: "quick_tunnel_restart_cooldown",
    });
    const cooldownMs = cfg.cooldownMs;
    quickTunnelRestartAttempts = 0;
    clearQuickTunnelRestartTimer();
    console.warn(
      `[telegram-ui] quick tunnel restart exhausted after ${cfg.maxAttempts} attempts; retrying again after cooldown (${cooldownMs}ms)`,
    );
    quickTunnelRestartTimer = setTimeout(() => {
      if (quickTunnelRestartSuppressed || tunnelStopRequested) return;
      startQuickTunnel(cfBin, localPort).catch((err) => {
        console.warn(`[telegram-ui] quick tunnel restart failed after cooldown: ${err.message}`);
      });
    }, cooldownMs);
    quickTunnelRestartTimer.unref?.();
    return;
  }
  quickTunnelRestartAttempts += 1;
  const backoff = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (quickTunnelRestartAttempts - 1));
  const jitter = Math.floor(Math.random() * Math.max(200, Math.floor(backoff * 0.2)));
  const restartDelayMs = Math.min(cfg.maxDelayMs, backoff + jitter);
  clearQuickTunnelRestartTimer();
  console.log(
    `[telegram-ui] quick tunnel restart scheduled (${quickTunnelRestartAttempts}/${cfg.maxAttempts}) in ${restartDelayMs}ms`,
  );
  quickTunnelRestartTimer = setTimeout(() => {
    if (quickTunnelRestartSuppressed || tunnelStopRequested) return;
    startQuickTunnel(cfBin, localPort).catch((err) => {
      console.warn(`[telegram-ui] quick tunnel restart failed: ${err.message}`);
    });
  }, restartDelayMs);
  quickTunnelRestartTimer.unref?.();
}

async function startQuickTunnel(cfBin, localPort) {
  tunnelStopRequested = false;
  quickTunnelRestartSuppressed = false;
  clearQuickTunnelRestartTimer();
  setTunnelRuntimeState({
    mode: TUNNEL_MODE_QUICK,
    outputTail: "",
  });
  const localUrl = `https://localhost:${localPort}`;
  const args = ["tunnel", "--url", localUrl, "--no-autoupdate", "--no-tls-verify"];
  console.log(`[telegram-ui] starting quick tunnel -> ${localUrl}`);

  let child;
  try {
    child = await spawnCloudflared(cfBin, args);
  } catch (err) {
    setTunnelRuntimeState({
      mode: TUNNEL_MODE_QUICK,
      lastError: "quick_tunnel_spawn_failed",
    });
    console.warn(`[telegram-ui] quick tunnel spawn failed: ${err.message}`);
    scheduleQuickTunnelRestart(cfBin, localPort);
    return null;
  }
  // Track startup child so stopTunnel() can terminate it even before URL discovery.
  tunnelProcess = child;
  if (tunnelStopRequested) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    tunnelProcess = null;
    return null;
  }

  return new Promise((resolvePromise) => {
    let resolved = false;
    let restartScheduled = false;
    let output = "";
    const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
    function scheduleRestartOnce() {
      if (restartScheduled) return;
      restartScheduled = true;
      scheduleQuickTunnelRestart(cfBin, localPort);
    }
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        setTunnelRuntimeState({
          mode: TUNNEL_MODE_QUICK,
          lastError: "quick_tunnel_timeout",
        });
        console.warn("[telegram-ui] quick tunnel timed out after 30s");
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        scheduleRestartOnce();
        resolvePromise(null);
      }
    }, 30_000);

    function parseOutput(chunk) {
      if (tunnelStopRequested) return;
      output = appendOutputTail(output, chunk);
      setTunnelRuntimeState({ outputTail: output });
      const match = output.match(urlPattern);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        tunnelUrl = String(match[0]).toLowerCase();
        tunnelPublicHostname = "";
        tunnelProcess = child;
        quickTunnelRestartAttempts = 0;
        setTunnelRuntimeState({
          mode: TUNNEL_MODE_QUICK,
          tunnelName: "",
          tunnelId: "",
          hostname: "",
          dnsAction: "none",
          dnsStatus: "disabled",
          fallbackToQuick: true,
          lastError: "",
        });
        _notifyTunnelChange(tunnelUrl);
        console.log(`[telegram-ui] quick tunnel active: ${tunnelUrl}`);
        resolvePromise(tunnelUrl);
      }
    }

    child.stdout.on("data", (d) => parseOutput(d.toString()));
    child.stderr.on("data", (d) => parseOutput(d.toString()));

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        if (tunnelStopRequested) {
          resolvePromise(null);
          return;
        }
        setTunnelRuntimeState({
          mode: TUNNEL_MODE_QUICK,
          lastError: "quick_tunnel_runtime_error",
        });
        const outputHint = formatTunnelOutputHint(output);
        console.warn(
          `[telegram-ui] quick tunnel failed: ${err.message}${outputHint ? ` (tail: ${outputHint})` : ""}`,
        );
        scheduleRestartOnce();
        resolvePromise(null);
      }
    });

    child.on("exit", (code, signal) => {
      tunnelProcess = null;
      tunnelUrl = null;
      tunnelPublicHostname = "";
      _notifyTunnelChange(null);
      if (tunnelStopRequested) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolvePromise(null);
        }
        return;
      }
      const restartableExit = shouldRestartForProcessExit(code, signal);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        // Exiting before URL acquisition always means tunnel startup failed; retry regardless of exit code.
        const earlyExitShouldRestart = true;
        setTunnelRuntimeState({
          mode: TUNNEL_MODE_QUICK,
          lastError: earlyExitShouldRestart ? "" : "quick_tunnel_exited_early",
        });
        const outputHint = formatTunnelOutputHint(output);
        const earlyExitMsg = `[telegram-ui] quick tunnel exited with code ${code}${signal ? ` signal ${signal}` : ""}${earlyExitShouldRestart ? "; restart scheduled" : ""}${outputHint ? ` (tail: ${outputHint})` : ""}`;
        if (earlyExitShouldRestart) {
          // Expected during transient Cloudflare/network churn; avoid noisy warning loops.
          console.log(earlyExitMsg);
          scheduleRestartOnce();
        } else {
          console.warn(earlyExitMsg);
        }
        resolvePromise(null);
      } else if (restartableExit) {
        setTunnelRuntimeState({
          mode: TUNNEL_MODE_QUICK,
          lastError: "",
        });
        const outputHint = formatTunnelOutputHint(output);
        console.log(
          `[telegram-ui] quick tunnel exited (code ${code}${signal ? `, signal ${signal}` : ""}); restart scheduled${outputHint ? ` (tail: ${outputHint})` : ""}`,
        );
        scheduleRestartOnce();
      }
    });
  });
}

/** Stop the tunnel if running. */
export function stopTunnel() {
  tunnelStopRequested = true;
  quickTunnelRestartSuppressed = true;
  clearQuickTunnelRestartTimer();
  quickTunnelRestartAttempts = 0;
  if (tunnelProcess) {
    try {
      tunnelProcess.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    tunnelProcess = null;
    tunnelUrl = null;
    tunnelPublicHostname = "";
    _notifyTunnelChange(null);
  }
  setTunnelRuntimeState({
    mode: TUNNEL_MODE_DISABLED,
    tunnelName: "",
    tunnelId: "",
    hostname: "",
    dnsAction: "none",
    dnsStatus: "not_configured",
    fallbackToQuick: false,
    lastError: "",
    outputTail: "",
  });
}

export function injectUiDependencies(deps = {}) {
  uiDeps = { ...uiDeps, ...deps };

  // Auto-wire broadcastUiEvent into the agent event bus when available
  if (typeof deps.getAgentEventBus === "function") {
    try {
      const bus = deps.getAgentEventBus();
      if (bus && !bus._broadcastUiEvent) {
        bus._broadcastUiEvent = broadcastUiEvent;
        console.log("[ui-server] wired broadcastUiEvent into agent event bus");
      }
    } catch {
      /* bus not ready yet — will be wired on first API access */
    }
  }
}

/**
 * Lazily resolve the agent event bus, wiring broadcastUiEvent on first access.
 * Returns the bus instance or null if unavailable.
 */
function _resolveEventBus() {
  if (typeof uiDeps.getAgentEventBus !== "function") return null;
  try {
    const bus = uiDeps.getAgentEventBus();
    if (!bus) return null;
    // Late-wire broadcastUiEvent if it wasn't available during injection
    if (!bus._broadcastUiEvent) {
      bus._broadcastUiEvent = broadcastUiEvent;
    }
    return bus;
  } catch {
    return null;
  }
}

export function getTelegramUiUrl() {
  const explicit =
    process.env.TELEGRAM_UI_BASE_URL || process.env.TELEGRAM_WEBAPP_URL;
  if (explicit) {
    // Auto-upgrade explicit HTTP URL to HTTPS when the server is running TLS
    if (uiServerTls && explicit.startsWith("http://")) {
      let upgraded = explicit.replace(/^http:\/\//, "https://");
      // Ensure the port is present (the explicit URL may omit it)
      try {
        const parsed = new URL(upgraded);
        if (!parsed.port && uiServer) {
          const actualPort = uiServer.address()?.port;
          if (actualPort) parsed.port = String(actualPort);
          upgraded = parsed.href;
        }
      } catch {
        // URL parse failed — use as-is
      }
      return upgraded.replace(/\/+$/, "");
    }
    return explicit.replace(/\/+$/, "");
  }
  return uiServerUrl;
}

function isStackLikeErrorText(value) {
  if (typeof value !== "string") return false;
  const lower = value.toLowerCase();
  return (value.includes("\n") && lower.includes(" at ")) || lower.includes("error:\n    at ");
}

function scrubStackTraces(payload) {
  if (payload == null) return payload;
  if (payload instanceof Error) {
    const safeMessage = String(payload.message || "Internal server error");
    return scrubStackTraces({ error: safeMessage });
  }
  if (typeof payload === "string") {
    return isStackLikeErrorText(payload) ? "Internal server error" : payload;
  }
  if (Array.isArray(payload)) return payload.map((item) => scrubStackTraces(item));
  if (typeof payload !== "object") return payload;
  const out = {};
  for (const [key, value] of Object.entries(payload)) {
    const keyLower = key.toLowerCase();
    if (keyLower === "stack") continue;
    out[key] = scrubStackTraces(value);
  }
  return out;
}
function normalizeJsonResponsePayload(payload) {
  return scrubStackTraces(payload);
}

function makeJsonSafe(value, options = {}) {
  const depth = Number.isFinite(options.depth) ? options.depth : 0;
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : 5;
  const seen = options.seen instanceof WeakSet ? options.seen : new WeakSet();

  if (value == null) return value;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return String(value);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : String(value);
  }
  if (value instanceof Error) {
    const errorValue = {
      name: String(value.name || "Error"),
      message: String(value.message || ""),
    };
    if (value.code != null) errorValue.code = String(value.code);
    return errorValue;
  }
  if (depth >= maxDepth) return "[Truncated]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[Circular]";

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        const normalized = makeJsonSafe(entry, { depth: depth + 1, maxDepth, seen });
        return normalized === undefined ? null : normalized;
      });
    }

    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalized = makeJsonSafe(entry, { depth: depth + 1, maxDepth, seen });
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function extractSafeErrorMessage(payload) {
  return "Internal server error";
}

function createRequestDiagnosticId() {
  return `req_${randomBytes(6).toString("hex")}`;
}

function ensureResponseDiagnosticId(res) {
  if (!res || typeof res !== "object") return createRequestDiagnosticId();
  if (!res.__bosunDiagnosticId) {
    res.__bosunDiagnosticId = createRequestDiagnosticId();
  }
  return res.__bosunDiagnosticId;
}

function describePayloadForErrorLog(payload, depth = 0) {
  if (payload instanceof Error) {
    const described = {
      name: String(payload.name || "Error"),
      message: String(payload.message || ""),
    };
    if (payload.stack) described.stack = String(payload.stack);
    if (payload.code != null) described.code = String(payload.code);
    if (depth < 3 && payload.cause) {
      described.cause = describePayloadForErrorLog(payload.cause, depth + 1);
    }
    return described;
  }
  return makeJsonSafe(payload, { maxDepth: 6 });
}

function logJsonFailure(res, statusCode, payload, diagnosticId) {
  const requestContext = res?.__bosunRequestContext || {};
  console.error("[ui-server] request failed", {
    diagnosticId,
    statusCode,
    method: requestContext.method || null,
    path: requestContext.path || null,
    query: requestContext.query || "",
    payload: describePayloadForErrorLog(payload),
  });
}

function jsonResponse(res, statusCode, payload) {
  const diagnosticId = statusCode >= 500 ? ensureResponseDiagnosticId(res) : null;
  if (statusCode >= 500) {
    logJsonFailure(res, statusCode, payload, diagnosticId);
  }
  const normalizedPayload = normalizeJsonResponsePayload(payload);
  const safePayload =
    statusCode >= 500
      ? {
          ok: false,
          error: extractSafeErrorMessage(normalizedPayload),
          diagnosticId,
        }
      : normalizedPayload;
  const body = JSON.stringify(safePayload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function textResponse(res, statusCode, body, contentType = "text/plain") {
  res.writeHead(statusCode, {
    "Content-Type": `${contentType}; charset=utf-8`,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

async function callTaskStoreFunction(candidates = [], args = [], resolveArgs = null) {
  const api = await ensureTaskStoreApi();
  if (!api) return { found: null, value: null, available: false };
  for (const name of candidates) {
    const fn = api?.[name];
    if (typeof fn !== "function") continue;
    const effectiveArgs =
      typeof resolveArgs === "function"
        ? resolveArgs(name, args)
        : args;
    const argList = Array.isArray(effectiveArgs) ? effectiveArgs : [];
    return { found: name, value: await fn(...argList), available: true };
  }
  return { found: null, value: null, available: true };
}

function normalizeCanStartResult(result, { override = false } = {}) {
  if (override) {
    return {
      available: true,
      canStart: true,
      override: true,
      reason: "manual_override",
      blockedBy: [],
    };
  }
  if (typeof result === "boolean") {
    return {
      available: true,
      canStart: result,
      reason: result ? "allowed" : "blocked",
      blockedBy: [],
    };
  }
  const raw = result && typeof result === "object" ? result : {};
  const canStart =
    raw.canStart === true || raw.allowed === true || raw.startable === true
      ? true
      : raw.canStart === false || raw.allowed === false || raw.startable === false
        ? false
        : true;
  const normalizeIdList = (value) => {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const ids = [];
    for (const entry of value) {
      const id = String(entry || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  };
  const blockingTaskIds = normalizeIdList(raw.blockingTaskIds);
  const missingDependencyTaskIds = normalizeIdList(raw.missingDependencyTaskIds);
  const blockingSprintIds = normalizeIdList(raw.blockingSprintIds);
  const blockingEpicIds = normalizeIdList(raw.blockingEpicIds);
  const blockedByRaw = Array.isArray(raw.blockedBy)
    ? raw.blockedBy
    : Array.isArray(raw.blockers)
      ? raw.blockers
      : Array.isArray(raw.dependencies)
        ? raw.dependencies.filter((entry) => entry && entry.ready === false)
        : blockingTaskIds.length > 0
          ? blockingTaskIds
          : [];
  const blockedBy = blockedByRaw
    .map((entry) => {
      if (typeof entry === "string") return { taskId: entry };
      const taskId = String(entry?.taskId || entry?.id || "").trim();
      const reason = String(entry?.reason || entry?.status || "").trim();
      if (!taskId && !reason) return null;
      return {
        ...(taskId ? { taskId } : {}),
        ...(reason ? { reason } : {}),
      };
    })
    .filter(Boolean);
  const blockedByTaskIds = normalizeIdList(blockedBy.map((entry) => entry?.taskId).filter(Boolean));
  const reason = String(raw.reason || raw.message || "").trim() || (canStart ? "allowed" : "blocked");
  return {
    available: true,
    canStart,
    reason,
    blockedBy,
    blockingTaskIds: blockingTaskIds.length > 0 ? blockingTaskIds : blockedByTaskIds,
    missingDependencyTaskIds,
    blockingSprintIds,
    blockingEpicIds,
    raw: makeJsonSafe(raw),
  };
}

function normalizeDependencyIds(task = {}) {
  const ids = [];
  const add = (value) => {
    const id = String(value || "").trim();
    if (!id || ids.includes(id)) return;
    ids.push(id);
  };
  const sources = [
    task?.dependencyTaskIds,
    task?.dependsOn,
    task?.dependencies,
    task?.meta?.dependencyTaskIds,
    task?.meta?.dependsOn,
    task?.meta?.dependencies,
  ];
  for (const source of sources) {
    if (!Array.isArray(source)) continue;
    for (const entry of source) {
      if (typeof entry === "string") {
        add(entry);
      } else if (entry && typeof entry === "object") {
        add(entry.taskId || entry.id);
      }
    }
  }
  return ids;
}

function isTerminalTaskStatus(status) {
  const normalized = normalizeTaskStatusKey(status);
  return normalized === "done" || normalized === "cancelled";
}

async function evaluateTaskCanStart({
  taskId,
  task,
  adapter,
  forceStart = false,
  manualOverride = false,
}) {
  const override = forceStart === true || manualOverride === true;
  if (override) return normalizeCanStartResult(null, { override: true });

  const storeGuard = await callTaskStoreFunction(TASK_STORE_START_GUARD_EXPORTS, [
    taskId,
    {
      task,
      adapter,
      source: "ui-server",
      actor: "ui",
    },
  ]);
  if (storeGuard.found) {
    const normalized = normalizeCanStartResult(storeGuard.value);
    return {
      ...normalized,
      source: `task-store.${storeGuard.found}`,
    };
  }

  let taskRecord = task;
  if (!taskRecord?.id && typeof adapter?.getTask === "function") {
    try {
      taskRecord = await adapter.getTask(taskId);
    } catch {
      taskRecord = null;
    }
  }
  if (!taskRecord) {
    return {
      available: false,
      canStart: false,
      reason: "task_not_found",
      blockedBy: [],
      source: "fallback",
    };
  }

  const dependencyIds = normalizeDependencyIds(taskRecord);
  const blockedBy = [];
  for (const dependencyId of dependencyIds) {
    if (!dependencyId || typeof adapter?.getTask !== "function") continue;
    let dependencyTask = null;
    try {
      dependencyTask = await adapter.getTask(dependencyId);
    } catch {
      dependencyTask = null;
    }
    if (!dependencyTask) {
      blockedBy.push({ taskId: dependencyId, reason: "dependency_not_found" });
      continue;
    }
    if (!isTerminalTaskStatus(dependencyTask?.status)) {
      blockedBy.push({
        taskId: dependencyId,
        reason: String(dependencyTask?.status || "not_ready").trim() || "not_ready",
      });
    }
  }

  return {
    available: false,
    canStart: blockedBy.length === 0,
    reason: blockedBy.length === 0 ? "allowed" : "dependency_blocked",
    blockedBy,
    source: "fallback",
  };
}

function resolveTaskSprintId(task = {}) {
  return String(
    task?.sprintId
      || task?.sprint
      || task?.meta?.sprintId
      || task?.meta?.sprint
      || "",
  ).trim();
}

async function getSprintDagData(sprintId) {
  const normalizedSprintId = String(sprintId || "").trim();
  const argsByExport = {
    getSprintDag: normalizedSprintId ? [normalizedSprintId] : [],
    getTaskDagForSprint: normalizedSprintId ? [normalizedSprintId] : [],
    buildSprintDag: normalizedSprintId ? [normalizedSprintId] : [],
    buildTaskDag: normalizedSprintId ? [{ sprintId: normalizedSprintId }] : [{}],
  };
  const dagResult = await callTaskStoreFunction(
    TASK_STORE_DAG_EXPORTS.sprint,
    [],
    (name) => argsByExport[name] || [],
  );
  if (!dagResult.found) return null;
  return {
    sprintId: normalizedSprintId || null,
    source: `task-store.${dagResult.found}`,
    data: dagResult.value,
  };
}

async function getGlobalDagData() {
  const dagResult = await callTaskStoreFunction(TASK_STORE_DAG_EXPORTS.global, []);
  if (!dagResult.found) return null;
  return {
    source: `task-store.${dagResult.found}`,
    data: dagResult.value,
  };
}

async function organizeDagData(options = {}) {
  const organizeResult = await callTaskStoreFunction(TASK_STORE_DAG_EXPORTS.organize, [options]);
  if (!organizeResult.found) return null;
  return {
    source: `task-store.${organizeResult.found}`,
    data: organizeResult.value,
  };
}

function normalizeTaskComments(comments = []) {
  if (!Array.isArray(comments)) return [];
  return comments
    .map((entry, index) => {
      const id = String(entry?.id || entry?.commentId || `comment-${index + 1}`).trim();
      const body = String(entry?.body || entry?.text || entry?.message || "").trim();
      if (!body) return null;
      const author = String(entry?.author || entry?.createdBy || entry?.actor || "unknown").trim() || "unknown";
      const createdAt = String(entry?.createdAt || entry?.timestamp || entry?.time || "").trim() || new Date(0).toISOString();
      return {
        id,
        body,
        author,
        createdAt,
        raw: entry,
      };
    })
    .filter(Boolean);
}

async function getTaskByIdForApi(taskId, adapter = null) {
  const result = await callTaskStoreFunction(TASK_STORE_GET_TASK_EXPORTS, [taskId]);
  if (result.found && result.value) return result.value;
  const fallbackAdapter = adapter || getKanbanAdapter();
  if (typeof fallbackAdapter?.getTask === "function") {
    return fallbackAdapter.getTask(taskId).catch(() => null);
  }
  return null;
}

async function buildDagSnapshotsForTask(task = null, sprintId = "") {
  const resolvedSprintId = String(sprintId || resolveTaskSprintId(task)).trim();
  const sprintDag = resolvedSprintId ? await getSprintDagData(resolvedSprintId) : null;
  const globalDag = await getGlobalDagData();
  return {
    sprintId: resolvedSprintId || null,
    sprint: sprintDag,
    global: globalDag,
  };
}

function normalizeTaskIdList(values = [], { exclude = "" } = {}) {
  const excluded = String(exclude || "").trim();
  const seen = new Set();
  const list = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = String(value || "").trim();
    if (!id || id === excluded || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
  }
  return list;
}

async function assignTaskToSprintForApi({ taskId, sprintId, sprintOrder, adapter = null }) {
  const resolvedSprintId = String(sprintId || "").trim();
  if (!resolvedSprintId) {
    return { ok: false, error: "sprintId required" };
  }

  const normalizedOrder = Number.isFinite(Number(sprintOrder)) ? Number(sprintOrder) : null;
  const sprintPayload = {
    id: resolvedSprintId,
    name: resolvedSprintId,
    status: "planned",
  };
  try {
    await callTaskStoreFunction(["upsertSprint"], [sprintPayload], (name, args) => {
      if (name === "upsertSprint") return [resolvedSprintId, sprintPayload];
      return args;
    });
  } catch {
    // Sprint bootstrap is best-effort; assignment/update fallback still runs.
  }

  const assignResult = await callTaskStoreFunction(
    TASK_STORE_ASSIGN_SPRINT_EXPORTS,
    [taskId, resolvedSprintId, { sprintOrder: normalizedOrder }],
  );

  await callTaskStoreFunction(TASK_STORE_DEPENDENCY_EXPORTS.update, [taskId, {
    sprintId: resolvedSprintId,
    sprint: resolvedSprintId,
    ...(normalizedOrder != null ? { sprintOrder: normalizedOrder } : {}),
  }]);

  const fallbackAdapter = adapter || getKanbanAdapter();
  const updatedTask = await getTaskByIdForApi(taskId, fallbackAdapter);
  const dag = await buildDagSnapshotsForTask(updatedTask, resolvedSprintId);

  return {
    ok: true,
    assignedVia: assignResult.found || null,
    data: updatedTask,
    dag,
  };
}

async function setTaskDependenciesForApi({
  taskId,
  dependencies,
  sprintId,
  sprintOrder,
  adapter = null,
}) {
  const fallbackAdapter = adapter || getKanbanAdapter();
  const task = await getTaskByIdForApi(taskId, fallbackAdapter);
  if (!task) {
    return { ok: false, status: 404, error: "Task not found." };
  }

  const normalizedDependencies = normalizeTaskIdList(dependencies, { exclude: taskId });
  const currentDependencies = normalizeDependencyIds(task);
  const toAdd = normalizedDependencies.filter((depId) => !currentDependencies.includes(depId));
  const toRemove = currentDependencies.filter((depId) => !normalizedDependencies.includes(depId));

  for (const depId of toRemove) {
    await callTaskStoreFunction(TASK_STORE_DEPENDENCY_EXPORTS.remove, [taskId, depId]);
  }
  for (const depId of toAdd) {
    await callTaskStoreFunction(TASK_STORE_DEPENDENCY_EXPORTS.add, [taskId, depId]);
  }

  const normalizedSprintId = String(sprintId || "").trim();
  const normalizedOrder = Number.isFinite(Number(sprintOrder)) ? Number(sprintOrder) : null;
  const updatePatch = {
    dependencyTaskIds: normalizedDependencies,
    dependsOn: normalizedDependencies,
    dependencies: normalizedDependencies,
    ...(normalizedSprintId ? { sprintId: normalizedSprintId, sprint: normalizedSprintId } : {}),
    ...(normalizedOrder != null ? { sprintOrder: normalizedOrder } : {}),
  };
  await callTaskStoreFunction(TASK_STORE_DEPENDENCY_EXPORTS.update, [taskId, updatePatch]);

  if (normalizedSprintId) {
    await assignTaskToSprintForApi({
      taskId,
      sprintId: normalizedSprintId,
      sprintOrder: normalizedOrder,
      adapter: fallbackAdapter,
    });
  }

  const updatedTask = await getTaskByIdForApi(taskId, fallbackAdapter);
  const dag = await buildDagSnapshotsForTask(updatedTask, normalizedSprintId || resolveTaskSprintId(updatedTask));

  return {
    ok: true,
    data: updatedTask,
    dependencies: normalizedDependencies,
    added: toAdd,
    removed: toRemove,
    dag,
  };
}

async function listEpicDependenciesForApi() {
  const listed = await callTaskStoreFunction(TASK_STORE_EPIC_DEPENDENCY_EXPORTS.list, []);
  if (listed.found && Array.isArray(listed.value)) {
    return {
      ok: true,
      source: `task-store.${listed.found}`,
      data: listed.value
        .map((entry) => ({
          epicId: String(entry?.epicId || entry?.id || "").trim(),
          dependencies: normalizeTaskIdList(entry?.dependencies || entry?.dependsOn || []),
        }))
        .filter((entry) => entry.epicId),
    };
  }
  return { ok: false, source: null, data: [] };
}

async function setEpicDependenciesForApi({ epicId, dependencies }) {
  const normalizedEpicId = String(epicId || "").trim();
  if (!normalizedEpicId) return { ok: false, status: 400, error: "epicId required" };
  const normalizedDependencies = normalizeTaskIdList(dependencies, { exclude: normalizedEpicId });

  const setResult = await callTaskStoreFunction(
    TASK_STORE_EPIC_DEPENDENCY_EXPORTS.set,
    [normalizedEpicId, normalizedDependencies],
  );
  if (setResult.found) {
    return {
      ok: true,
      source: `task-store.${setResult.found}`,
      data: {
        epicId: normalizedEpicId,
        dependencies: normalizeTaskIdList(setResult.value?.dependencies || normalizedDependencies),
      },
    };
  }

  const listed = await listEpicDependenciesForApi();
  const current = listed.ok
    ? normalizeTaskIdList((listed.data.find((entry) => entry.epicId === normalizedEpicId) || {}).dependencies || [])
    : [];

  const toRemove = current.filter((entry) => !normalizedDependencies.includes(entry));
  const toAdd = normalizedDependencies.filter((entry) => !current.includes(entry));

  for (const dep of toRemove) {
    await callTaskStoreFunction(TASK_STORE_EPIC_DEPENDENCY_EXPORTS.remove, [normalizedEpicId, dep]);
  }
  for (const dep of toAdd) {
    await callTaskStoreFunction(TASK_STORE_EPIC_DEPENDENCY_EXPORTS.add, [normalizedEpicId, dep]);
  }

  const refreshed = await listEpicDependenciesForApi();
  const row = refreshed.ok
    ? refreshed.data.find((entry) => entry.epicId === normalizedEpicId)
    : null;
  return {
    ok: true,
    source: refreshed.source || "task-store.fallback",
    data: { epicId: normalizedEpicId, dependencies: normalizeTaskIdList(row?.dependencies || []) },
  };
}
async function getTaskCommentsForApi(taskId, adapter = null) {
  const storeComments = await callTaskStoreFunction(TASK_STORE_COMMENT_EXPORTS, [taskId]);
  if (storeComments.found && Array.isArray(storeComments.value)) {
    return normalizeTaskComments(storeComments.value);
  }

  const task = await getTaskByIdForApi(taskId, adapter || getKanbanAdapter());
  const comments = Array.isArray(task?.comments)
    ? task.comments
    : Array.isArray(task?.meta?.comments)
      ? task.meta.comments
      : [];
  return normalizeTaskComments(comments);
}

async function listAllTasksForApi(adapter = null) {
  const fallbackAdapter = adapter || getKanbanAdapter();
  if (typeof fallbackAdapter?.listTasks === "function") {
    try {
      let projectId = activeProjectId.value || "";
      if (!projectId && typeof fallbackAdapter?.listProjects === "function") {
        const projects = await fallbackAdapter.listProjects();
        projectId = projects?.[0]?.id || projects?.[0]?.project_id || "";
      }
      const tasks = await fallbackAdapter.listTasks(projectId, {});
      if (Array.isArray(tasks) && tasks.length > 0) return tasks;
      if (projectId) {
        const unscopedTasks = await fallbackAdapter.listTasks("", {});
        if (Array.isArray(unscopedTasks) && unscopedTasks.length > 0) {
          return unscopedTasks;
        }
      }
    } catch {
      // Fall through to broader adapter/task-store snapshots.
    }
  }
  if (typeof fallbackAdapter?.getAllTasks === "function") {
    try {
      const tasks = await fallbackAdapter.getAllTasks();
      if (Array.isArray(tasks)) return tasks;
    } catch {
      // Fall through to internal task-store snapshot.
    }
  }
  const tasks = getAllInternalTasks();
  return Array.isArray(tasks) ? tasks : [];
}
function normalizeTaskStatusKey(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function shouldRestartTaskAfterStatusUpdate(previousStatus, nextStatus) {
  const prev = normalizeTaskStatusKey(previousStatus);
  const next = normalizeTaskStatusKey(nextStatus);
  return prev === "inreview" && next === "inprogress";
}

async function maybeRestartTaskOnReopen({
  taskId,
  previousStatus,
  nextStatus,
  updatedTask,
  adapter,
  executor,
  forceStart = false,
  manualOverride = false,
}) {
  if (!taskId) {
    return { attempted: false, started: false, reason: "missing_task_id" };
  }
  if (!shouldRestartTaskAfterStatusUpdate(previousStatus, nextStatus)) {
    return { attempted: false, started: false, reason: "transition_not_eligible" };
  }
  if (!executor) {
    return { attempted: true, started: false, reason: "executor_unavailable" };
  }

  let taskToRun = updatedTask && typeof updatedTask === "object" ? updatedTask : null;
  if (!taskToRun?.id && typeof adapter?.getTask === "function") {
    try {
      taskToRun = await adapter.getTask(taskId);
    } catch (err) {
      return {
        attempted: true,
        started: false,
        reason: "task_lookup_failed",
        error: "Task lookup failed",
      };
    }
  }
  if (!taskToRun) {
    return { attempted: true, started: false, reason: "task_not_found" };
  }

  const canStart = await evaluateTaskCanStart({
    taskId,
    task: taskToRun,
    adapter,
    forceStart,
    manualOverride,
  });
  if (!canStart.canStart) {
    return {
      attempted: true,
      started: false,
      reason: "start_guard_blocked",
      canStart,
    };
  }

  const status = executor.getStatus?.() || {};
  const activeSlots = Array.isArray(status?.slots) ? status.slots : [];
  const alreadyRunning = activeSlots.some(
    (slot) => String(slot?.taskId || "").trim() === String(taskId).trim(),
  );
  if (alreadyRunning) {
    return { attempted: true, started: false, reason: "already_running", canStart };
  }

  const maxParallel = Number(status?.maxParallel || 0);
  const activeCount = Number(status?.activeSlots || activeSlots.length || 0);
  const hasFreeSlot = maxParallel <= 0 || activeCount < maxParallel;
  if (!hasFreeSlot) {
    return { attempted: true, started: false, reason: "no_free_slots", canStart };
  }

  executor.executeTask(taskToRun, {
    force: forceStart === true || manualOverride === true,
    recoveredFromInProgress: true,
  }).catch((error) => {
    console.warn(
      `[telegram-ui] failed to restart reopened task ${taskId}: ${error.message}`,
    );
  });

  return { attempted: true, started: true, reason: "restarted", canStart };
}


function normalizeLifecycleAction(action) {
  const value = String(action || "").trim().toLowerCase();
  if (value === "start" || value === "resume" || value === "pause" || value === "complete" || value === "cancel" || value === "block") {
    return value;
  }
  return "update";
}

function inferLifecycleAction(previousStatus, nextStatus, requestedAction) {
  const requested = normalizeLifecycleAction(requestedAction);
  if (requested !== "update") return requested;
  const prev = normalizeTaskStatusKey(previousStatus);
  const next = normalizeTaskStatusKey(nextStatus);
  if (next === "inprogress" && prev !== "inprogress") {
    return prev === "todo" || prev === "backlog" || prev === "draft" ? "start" : "resume";
  }
  if (prev === "inprogress" && (next === "todo" || next === "backlog" || next === "draft")) {
    return "pause";
  }
  if (next === "done") return "complete";
  if (next === "cancelled") return "cancel";
  if (next === "blocked") return "block";
  return "update";
}

function applyInternalLifecycleTransition(taskId, action, options = {}) {
  const normalizedAction = normalizeLifecycleAction(action);
  const lifecycleOptions = {
    source: options.source || "ui-server",
    actor: options.actor || "ui",
    reason: options.reason || null,
    force: options.force === true,
    payload: options.payload && typeof options.payload === "object" ? options.payload : null,
  };

  const api = getTaskStoreApiSync();
  if (!api) return null;
  if (normalizedAction === "start" && typeof api.startTask === "function") {
    return api.startTask(taskId, lifecycleOptions);
  }
  if (normalizedAction === "resume" && typeof api.resumeTask === "function") {
    return api.resumeTask(taskId, lifecycleOptions);
  }
  if (normalizedAction === "pause" && typeof api.pauseTask === "function") {
    return api.pauseTask(taskId, lifecycleOptions);
  }
  if (normalizedAction === "complete" && typeof api.completeTask === "function") {
    return api.completeTask(taskId, lifecycleOptions);
  }
  if (normalizedAction === "cancel" && typeof api.cancelTask === "function") {
    return api.cancelTask(taskId, lifecycleOptions);
  }
  if (normalizedAction === "block" && typeof api.blockTask === "function") {
    return api.blockTask(taskId, lifecycleOptions);
  }
  return null;
}

async function persistTaskStatusForExecution(adapter, taskId, nextStatus, source) {
  if (!taskId || !nextStatus || !adapter) return null;
  const normalized = String(nextStatus || "").trim();
  if (!normalized) return null;
  let updated = null;
  if (typeof adapter.updateTaskStatus === "function") {
    updated = await adapter.updateTaskStatus(taskId, normalized, { source });
  } else if (typeof adapter.updateTask === "function") {
    updated = await adapter.updateTask(taskId, { status: normalized });
  }
  return withTaskMetadataTopLevel(updated);
}

async function persistTaskExecutionMeta(adapter, taskId, executionPatch = {}) {
  if (!taskId || !adapter || typeof adapter.updateTask !== "function") return null;
  const current = typeof adapter.getTask === "function"
    ? await adapter.getTask(taskId).catch(() => null)
    : null;
  const currentMeta = current?.meta && typeof current.meta === "object" ? current.meta : {};
  const currentExecution = currentMeta.execution && typeof currentMeta.execution === "object"
    ? currentMeta.execution
    : {};
  const nextExecution = {
    ...currentExecution,
    ...executionPatch,
  };
  if (nextExecution.queueState == null) delete nextExecution.queueState;
  return withTaskMetadataTopLevel(await adapter.updateTask(taskId, {
    meta: {
      ...currentMeta,
      execution: nextExecution,
    },
  }));
}

function resolveFallbackStatusAfterFailedDispatch(previousStatus, startDispatch) {
  if (startDispatch?.reason === "no_free_slots") return "queued";
  const previous = String(previousStatus || "").trim();
  return previous || "todo";
}

async function reconcileTaskAfterDispatchAttempt({
  adapter,
  taskId,
  previousStatus,
  requestedStatus,
  lifecycleAction,
  startDispatch,
  source,
}) {
  const action = normalizeLifecycleAction(lifecycleAction);
  if (action !== "start" && action !== "resume") return null;
  const requested = normalizeTaskStatusKey(requestedStatus);
  if (requested !== "inprogress") return null;
  const targetStatus = startDispatch?.started
    ? "inprogress"
    : resolveFallbackStatusAfterFailedDispatch(previousStatus, startDispatch);
  return persistTaskStatusForExecution(adapter, taskId, targetStatus, source);
}

function enrichTaskLifetimeTotals(task) {
  if (!task || typeof task !== "object") return task;
  const taskId = String(task?.id || task?.taskId || "").trim();
  const lifetimeTotals = taskId ? getTaskLifetimeTotals(taskId) : null;
  return {
    ...task,
    lifetimeTotals,
    meta: {
      ...(task.meta || {}),
      lifetimeTotals,
    },
  };
}

function buildTaskRuntimeSnapshot(task) {
  const runtimeExecutor = uiDeps.getInternalExecutor?.() || null;
  const status = runtimeExecutor?.getStatus?.() || {};
  const activeSlots = Array.isArray(status?.slots) ? status.slots : [];
  const taskId = String(task?.id || task?.taskId || "").trim();
  const slot = taskId
    ? activeSlots.find((entry) => String(entry?.taskId || entry?.task_id || "").trim() === taskId)
    : null;
  const normalizedStatus = normalizeTaskStatusKey(task?.status);
  const queuedFlag = task?.meta?.execution?.queued === true
    || normalizeTaskStatusKey(task?.meta?.execution?.queueState) === "queued";
  if (slot) {
    return {
      state: "running",
      isLive: true,
      taskId,
      taskStatus: task?.status || null,
      statusLabel: "Live execution",
      lifetimeTotals: task?.lifetimeTotals || task?.meta?.lifetimeTotals || null,
      slot: {
        taskId,
        branch: slot?.branch || slot?.branchName || null,
        sdk: slot?.sdk || slot?.executor || null,
        model: slot?.model || null,
        startedAt: slot?.startedAt || slot?.started_at || null,
        completedCount: slot?.completedCount || 0,
      },
      executor: {
        activeSlots: Number(status?.activeSlots || activeSlots.length || 0),
        maxParallel: Number(status?.maxParallel || 0),
        paused: runtimeExecutor?.isPaused?.() === true,
      },
    };
  }
  if (queuedFlag || normalizedStatus === "queued") {
    return {
      state: "queued",
      isLive: false,
      taskId,
      taskStatus: task?.status || null,
      statusLabel: "Queued for execution",
      reason: "no_free_slots",
      lifetimeTotals: task?.lifetimeTotals || task?.meta?.lifetimeTotals || null,
    };
  }
  if (normalizedStatus === "inprogress") {
    return {
      state: "pending",
      isLive: false,
      taskId,
      taskStatus: task?.status || null,
      statusLabel: "No live execution detected",
      reason: "no_active_executor_slot",
      lifetimeTotals: task?.lifetimeTotals || task?.meta?.lifetimeTotals || null,
    };
  }
  if (normalizedStatus === "inreview") {
    return {
      state: "review",
      isLive: false,
      taskId,
      taskStatus: task?.status || null,
      statusLabel: "Awaiting review",
      lifetimeTotals: task?.lifetimeTotals || task?.meta?.lifetimeTotals || null,
    };
  }
  return {
    state: "idle",
    isLive: false,
    taskId,
    taskStatus: task?.status || null,
    statusLabel: "No active execution",
    lifetimeTotals: task?.lifetimeTotals || task?.meta?.lifetimeTotals || null,
  };
}

function withTaskRuntimeSnapshot(task) {
  if (!task || typeof task !== "object") return task;
  const withLifetimeTotals = enrichTaskLifetimeTotals(task);
  const runtimeSnapshot = buildTaskRuntimeSnapshot(withLifetimeTotals);
  return {
    ...withLifetimeTotals,
    runtimeSnapshot,
    meta: {
      ...(withLifetimeTotals.meta || {}),
      runtimeSnapshot,
    },
  };
}

function normalizeTaskDiagnosticText(value) {
  const text = String(value || "").trim();
  return text ? text.replace(/\s+/g, " ") : "";
}

function buildTaskStableCause(task, supervisorDiagnostics = null) {
  const lastError = normalizeTaskDiagnosticText(task?.lastError || "");
  const blockedReason = normalizeTaskDiagnosticText(task?.blockedReason || "");
  const errorPattern = String(task?.errorPattern || "").trim().toLowerCase();
  const apiErrorRecovery = supervisorDiagnostics?.apiErrorRecovery || null;
  const apiSignature = normalizeTaskDiagnosticText(apiErrorRecovery?.signature || "");
  const lastErrorLower = lastError.toLowerCase();
  const blockedReasonLower = blockedReason.toLowerCase();

  if (lastErrorLower.includes("codex resume timeout")) {
    return {
      code: "codex_resume_timeout",
      title: "Codex resume timed out",
      severity: "warning",
      summary: "Bosun timed out while resuming a cached Codex thread and will start fresh on the next attempt.",
    };
  }
  if (
    lastErrorLower.includes("invalid_encrypted_content") ||
    lastErrorLower.includes("state db missing rollout path") ||
    lastErrorLower.includes("could not be verified") ||
    lastErrorLower.includes("tool_call_id")
  ) {
    return {
      code: "codex_resume_corrupted_state",
      title: "Codex resume state is corrupted",
      severity: "error",
      summary: "Bosun detected poisoned Codex thread metadata and will discard the cached resume state.",
    };
  }
  if (errorPattern === "rate_limit") {
    return {
      code: "agent_rate_limit",
      title: "Agent is rate limited",
      severity: "warning",
      summary: "The assigned agent hit a rate limit and Bosun is waiting before retrying.",
    };
  }
  if (errorPattern === "token_overflow") {
    return {
      code: "token_overflow",
      title: "Context window exhausted",
      severity: "error",
      summary: "The current task exceeded the model context budget and needs a smaller prompt or a fresh session.",
    };
  }
  if (errorPattern === "api_error" || apiErrorRecovery) {
    return {
      code: Number(apiErrorRecovery?.cooldownUntil || 0) > Date.now()
        ? "api_error_cooldown"
        : "api_error_recovery",
      title: "Transient API failure",
      severity: "warning",
      summary: "Bosun detected a backend API failure and is applying the task-level recovery ladder before escalating.",
    };
  }
  if (blockedReason && blockedReasonLower.includes("dependency")) {
    return {
      code: "dependency_blocked",
      title: "Dependency is still blocked",
      severity: "warning",
      summary: "Bosun is holding this task until one or more dependencies finish.",
    };
  }
  if (blockedReason) {
    return {
      code: "task_blocked",
      title: "Task is blocked",
      severity: "warning",
      summary: "Bosun recorded a blocking condition for this task and will not dispatch it until the condition clears.",
    };
  }
  if (lastError || apiSignature) {
    return {
      code: "agent_runtime_error",
      title: "Agent runtime error",
      severity: "error",
      summary: "Bosun recorded an agent-side runtime failure for this task.",
    };
  }
  return null;
}

function buildTaskDiagnostics(task, supervisorDiagnostics = null) {
  if (!task || typeof task !== "object") return null;
  const apiErrorRecovery = supervisorDiagnostics?.apiErrorRecovery
    ? makeJsonSafe(supervisorDiagnostics.apiErrorRecovery, { maxDepth: 4 })
    : null;
  const diagnostics = {
    stableCause: buildTaskStableCause(task, supervisorDiagnostics),
    lastError: normalizeTaskDiagnosticText(task?.lastError || "") || null,
    errorPattern: normalizeTaskDiagnosticText(task?.errorPattern || "") || null,
    blockedReason: normalizeTaskDiagnosticText(task?.blockedReason || "") || null,
    cooldownUntil: task?.cooldownUntil || apiErrorRecovery?.cooldownUntil || null,
    supervisor: supervisorDiagnostics
      ? {
          interventionCount: Number(supervisorDiagnostics.interventionCount || 0),
          lastIntervention: supervisorDiagnostics.lastIntervention || null,
          lastDecision: supervisorDiagnostics.lastDecision
            ? makeJsonSafe(supervisorDiagnostics.lastDecision, { maxDepth: 3 })
            : null,
          apiErrorRecovery,
        }
      : null,
  };
  if (
    !diagnostics.stableCause &&
    !diagnostics.lastError &&
    !diagnostics.errorPattern &&
    !diagnostics.blockedReason &&
    !diagnostics.cooldownUntil &&
    !diagnostics.supervisor
  ) {
    return null;
  }
  return diagnostics;
}

async function maybeStartTaskFromLifecycleAction({
  taskId,
  updatedTask,
  adapter,
  executor,
  lifecycleAction,
  sdk,
  model,
  forceStart = false,
  manualOverride = false,
}) {
  if (!taskId) {
    return { attempted: false, started: false, reason: "missing_task_id" };
  }
  if (!executor) {
    return { attempted: false, started: false, reason: "executor_unavailable" };
  }

  const action = normalizeLifecycleAction(lifecycleAction);
  const shouldStart = action === "start" || action === "resume";
  if (!shouldStart) {
    return { attempted: false, started: false, reason: "action_not_start" };
  }

  let taskToRun = updatedTask && typeof updatedTask === "object" ? updatedTask : null;
  if (!taskToRun?.id && typeof adapter?.getTask === "function") {
    try {
      taskToRun = await adapter.getTask(taskId);
    } catch {
      taskToRun = null;
    }
  }
  if (!taskToRun) {
    return { attempted: true, started: false, reason: "task_not_found" };
  }

  const canStart = await evaluateTaskCanStart({
    taskId,
    task: taskToRun,
    adapter,
    forceStart,
    manualOverride,
  });
  if (!canStart.canStart) {
    return {
      attempted: true,
      started: false,
      reason: "start_guard_blocked",
      canStart,
    };
  }

  const status = executor.getStatus?.() || {};
  const activeSlots = Array.isArray(status?.slots) ? status.slots : [];
  const alreadyRunning = activeSlots.some(
    (slot) => String(slot?.taskId || "").trim() === String(taskId).trim(),
  );
  if (alreadyRunning) {
    return { attempted: true, started: false, reason: "already_running", canStart };
  }

  const maxParallel = Number(status?.maxParallel || 0);
  const activeCount = Number(status?.activeSlots || activeSlots.length || 0);
  const hasFreeSlot = maxParallel <= 0 || activeCount < maxParallel;
  if (!hasFreeSlot) {
    return { attempted: true, started: false, reason: "no_free_slots", canStart };
  }

  executor.executeTask(taskToRun, {
    force: forceStart === true || manualOverride === true,
    recoveredFromInProgress: action === "resume",
    ...(sdk ? { sdk } : {}),
    ...(model ? { model } : {}),
  }).catch((error) => {
    console.warn(`[telegram-ui] failed to dispatch lifecycle start for ${taskId}: ${error.message}`);
  });

  return {
    attempted: true,
    started: true,
    reason: action === "resume" ? "resumed" : "started",
    canStart,
  };
}
function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const data = {};
  for (const [key, value] of params.entries()) {
    data[key] = value;
  }
  return data;
}

function validateInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;
  params.delete("hash");
  const entries = Array.from(params.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const signature = createHmac("sha256", secret)
    .update(dataCheckString)
    .digest("hex");
  if (signature !== hash) return false;
  const authDate = Number(params.get("auth_date") || 0);
  if (Number.isFinite(authDate) && authDate > 0 && AUTH_MAX_AGE_SEC > 0) {
    const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - authDate);
    if (ageSec > AUTH_MAX_AGE_SEC) return false;
  }
  return true;
}

function parseCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...rest] = part.split("=");
    if (k.trim() === name) return rest.join("=").trim();
  }
  return "";
}

function checkSessionToken(req) {
  if (!sessionToken) return false;
  // Bearer header
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const provided = Buffer.from(authHeader.slice(7));
    const expected = Buffer.from(sessionToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      touchSessionToken();
      return true;
    }
  }
  // Cookie
  const cookieVal = parseCookie(req, "ve_session");
  if (cookieVal) {
    const provided = Buffer.from(cookieVal);
    const expected = Buffer.from(sessionToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      touchSessionToken();
      return true;
    }
  }
  return false;
}

/**
 * Check whether the request carries a valid desktop API key.
 *
 * Primary source is BOSUN_DESKTOP_API_KEY from process.env. If that is missing
 * (for example when connecting to an already-running daemon), we also load
 * {configDir}/desktop-api-key.json so long-lived desktop auth still works.
 * Any request bearing the matching Bearer token is treated as fully
 * authenticated — no session cookie or Telegram initData required.
 *
 * This allows the desktop app to connect to a separately-running daemon server
 * without needing to share the TTL-based session token.
 */
function checkDesktopApiKey(req) {
  const expected = getExpectedDesktopApiKey();
  if (!expected) return false;
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return false;
  const provided = authHeader.slice(7).trim();
  if (!provided) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function getTelegramInitData(req, url = null) {
  return String(
    req.headers["x-telegram-initdata"] ||
    req.headers["x-telegram-init-data"] ||
    req.headers["x-telegram-init"] ||
    req.headers["x-telegram-webapp"] ||
    req.headers["x-telegram-webapp-data"] ||
    url?.searchParams?.get("initData") ||
    "",
  );
}

function buildSessionCookieHeader() {
  const secure = uiServerTls ? "; Secure" : "";
  const token = ensureSessionToken();
  const maxAgeSec = getSessionCookieMaxAgeSec();
  return `ve_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${secure}`;
}

function getHeaderString(value) {
  if (Array.isArray(value)) return String(value[0] || "");
  return String(value || "");
}

function normalizeRemoteAddress(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("::ffff:")) return value.slice(7);
  return value;
}

function getLocalRequestAddressSet() {
  const now = Date.now();
  if (now - Number(_localRequestAddressCache.loadedAt || 0) < 60_000) {
    return _localRequestAddressCache.addresses;
  }
  const addresses = new Set(["127.0.0.1", "::1"]);
  try {
    const nets = networkInterfaces();
    for (const entries of Object.values(nets || {})) {
      for (const info of entries || []) {
        const addr = normalizeRemoteAddress(info?.address);
        if (!addr) continue;
        addresses.add(addr);
      }
    }
  } catch {
    // best effort
  }
  _localRequestAddressCache = { loadedAt: now, addresses };
  return addresses;
}

function isSameMachineRequest(req) {
  const remote = normalizeRemoteAddress(req?.socket?.remoteAddress);
  if (!remote) return false;
  return getLocalRequestAddressSet().has(remote);
}

function shouldAllowLocalSessionBootstrap(req, url) {
  if (!parseBooleanEnv(process.env.BOSUN_UI_LOCAL_BOOTSTRAP, false)) return false;
  if (isAllowUnsafe()) return false;
  if (String(req?.method || "").toUpperCase() !== "GET") return false;
  if (!isSameMachineRequest(req)) return false;
  if (checkDesktopApiKey(req) || checkSessionToken(req)) return false;
  if (url?.searchParams?.get("token")) return false;
  if (url?.searchParams?.get("desktopKey")) return false;
  if (url?.searchParams?.get("localBootstrap") === "1") return false;
  return true;
}

function tryLocalSessionBootstrap(req, res, url) {
  if (!shouldAllowLocalSessionBootstrap(req, url)) return false;
  const redirectUrl = new URL(url.toString());
  redirectUrl.searchParams.set("localBootstrap", "1");
  const redirectPath =
    redirectUrl.pathname +
    (redirectUrl.searchParams.toString()
      ? `?${redirectUrl.searchParams.toString()}`
      : "");
  res.writeHead(302, {
    "Set-Cookie": buildSessionCookieHeader(),
    Location: redirectPath || "/",
  });
  res.end();
  return true;
}

const DESKTOP_API_KEY_FILE = "desktop-api-key.json";
const DESKTOP_API_KEY_CACHE_TTL_MS = 5_000;
let _desktopApiKeyCache = {
  key: "",
  configDir: "",
  loadedAt: 0,
};

function readDesktopApiKeyFromConfig(configDir) {
  const dir = String(configDir || "").trim();
  if (!dir) return "";
  const filePath = resolve(dir, DESKTOP_API_KEY_FILE);
  if (!existsSync(filePath)) return "";
  try {
    const payload = JSON.parse(readFileSync(filePath, "utf8"));
    const key = String(payload?.key || "").trim();
    if (!key.startsWith("bosun_desktop_")) return "";
    return key;
  } catch {
    return "";
  }
}

function getExpectedDesktopApiKey() {
  const configDir = resolveUiConfigDir();
  const fromEnv = String(process.env.BOSUN_DESKTOP_API_KEY || "").trim();
  if (!configDir) return fromEnv;

  const now = Date.now();
  if (
    _desktopApiKeyCache.key
    && _desktopApiKeyCache.configDir === configDir
    && (now - _desktopApiKeyCache.loadedAt) < DESKTOP_API_KEY_CACHE_TTL_MS
  ) {
    return _desktopApiKeyCache.key;
  }

  const keyFromFile = readDesktopApiKeyFromConfig(configDir);
  _desktopApiKeyCache = {
    key: keyFromFile,
    configDir,
    loadedAt: now,
  };
  if (keyFromFile) {
    // Keep env aligned with the canonical persisted key to avoid stale
    // long-running daemon state rejecting fresh desktop sessions.
    if (fromEnv !== keyFromFile) {
      process.env.BOSUN_DESKTOP_API_KEY = keyFromFile;
    }
    return keyFromFile;
  }
  return fromEnv;
}

/**
 * Check whether the request carries a valid user-configured API key.
 * Set via BOSUN_API_KEY env var — intended for external clients (Electron app
 * connecting to a remote/Docker instance, CLI tools, third-party integrations).
 * Unlike the desktop API key (auto-generated per install), this is a
 * user-chosen secret that can be set in .env, docker-compose.yml, etc.
 */
function checkApiKey(req) {
  const expected = String(process.env.BOSUN_API_KEY || "").trim();
  if (!expected || expected.length < 8) return false;
  const authHeader = req.headers.authorization || "";
  // Accept as Bearer token
  if (authHeader.startsWith("Bearer ")) {
    const provided = authHeader.slice(7).trim();
    if (!provided) return false;
    try {
      const a = Buffer.from(provided);
      const b = Buffer.from(expected);
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch { return false; }
  }
  // Accept as X-API-Key header
  const apiKeyHeader = String(req.headers["x-api-key"] || "").trim();
  if (apiKeyHeader) {
    try {
      const a = Buffer.from(apiKeyHeader);
      const b = Buffer.from(expected);
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    } catch { return false; }
  }
  return false;
}

async function requireAuth(req) {
  if (isAllowUnsafe()) return { ok: true, source: "unsafe", issueSessionCookie: false };
  // User-configured API key (BOSUN_API_KEY env) — external clients, Docker
  // Issue a session cookie so the browser can authenticate WebSocket upgrades
  // (the WS constructor doesn't support custom headers).
  if (checkApiKey(req)) return { ok: true, source: "api-key", issueSessionCookie: true };
  // Desktop Electron API key — non-expiring, set via BOSUN_DESKTOP_API_KEY env
  if (checkDesktopApiKey(req)) return { ok: true, source: "desktop-api-key", issueSessionCookie: true };
  // Session token (browser access)
  if (checkSessionToken(req)) return { ok: true, source: "session", issueSessionCookie: false };
  // Telegram initData HMAC
  const initData = getTelegramInitData(req);
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (initData && validateInitData(initData, token)) {
    return { ok: true, source: "telegram", issueSessionCookie: false };
  }
  // Fallback auth header is only evaluated after session + Telegram auth fails.
  const fallbackSecret = getHeaderString(
    req.headers["x-bosun-fallback-auth"] || req.headers["x-admin-fallback-auth"],
  ).trim();
  if (fallbackSecret) {
    const result = await attemptFallbackAuth(req, fallbackSecret);
    if (result.ok) {
      return { ok: true, source: "fallback", issueSessionCookie: true };
    }
  }
  return { ok: false, source: "unauthorized", issueSessionCookie: false };
}

function resolveWsAuthSource(req, url) {
  if (isAllowUnsafe()) return "unsafe";
  // User-configured API key (BOSUN_API_KEY) — check Bearer header and query param
  if (checkApiKey(req)) return "api-key";
  const qApiKey = url.searchParams.get("apiKey") || "";
  if (qApiKey) {
    const expected = String(process.env.BOSUN_API_KEY || "").trim();
    if (expected && expected.length >= 8) {
      try {
        const a = Buffer.from(qApiKey);
        const b = Buffer.from(expected);
        if (a.length === b.length && timingSafeEqual(a, b)) return "api-key";
      } catch { /* ignore */ }
    }
  }
  // Desktop Electron API key (query param: desktopKey=...)
  const desktopKey = getExpectedDesktopApiKey();
  if (desktopKey) {
    const qDesktopKey = url.searchParams.get("desktopKey") || "";
    if (qDesktopKey) {
      try {
        const a = Buffer.from(qDesktopKey);
        const b = Buffer.from(desktopKey);
        if (a.length === b.length && timingSafeEqual(a, b)) return "desktop-api-key";
      } catch {
        /* ignore */
      }
    }
    // Also accept via Authorization header (for WS upgrade requests that support it)
    if (checkDesktopApiKey(req)) return "desktop-api-key";
  }
  // Session token (query param or cookie)
  if (checkSessionToken(req)) return "session";
  if (sessionToken) {
    const qTokenVal = url.searchParams.get("token") || "";
    if (qTokenVal) {
      const provided = Buffer.from(qTokenVal);
      const expected = Buffer.from(sessionToken);
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) return "session";
    }
  }
  // Telegram initData HMAC
  const initData = getTelegramInitData(req, url);
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!initData) return "";
  return validateInitData(String(initData), token) ? "telegram" : "";
}

function requireWsAuth(req, url) {
  return Boolean(resolveWsAuthSource(req, url));
}

function sendWsMessage(socket, payload) {
  try {
    if (socket?.readyState === 1) {
      socket.send(JSON.stringify(payload));
    }
  } catch {
    // best effort
  }
}

function normalizeWorkflowNodeStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "completed" || normalized === "success") return "success";
  if (normalized === "failed" || normalized === "error" || normalized === "fail") return "fail";
  if (normalized === "running") return "running";
  if (normalized === "skipped" || normalized === "skip") return "skipped";
  if (normalized === "waiting") return "waiting";
  return normalized || "unknown";
}

function pickTokenCount(payload = {}) {
  const candidates = [
    payload?.tokenCount,
    payload?.totalTokens,
    payload?.usage?.total_tokens,
    payload?.usage?.totalTokens,
    payload?.summary?.tokenCount,
    payload?.summary?.totalTokens,
    payload?.metrics?.total_tokens,
    payload?.metrics?.totalTokens,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.max(0, Math.round(parsed));
  }
  return null;
}

function summarizeOutputLines(value, maxLines = 3, maxChars = 140) {
  const text = String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!text) return [];
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .map((line) => (line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line));
  return lines;
}

function buildWorkflowNodeOutputPreview(nodeType, output = null) {
  if (output == null) return { lines: [] };
  const type = String(nodeType || "").trim().toLowerCase();
  const out = output && typeof output === "object" ? output : { value: output };
  const lines = [];

  if (type.startsWith("agent.") || type === "action.run_agent") {
    const text = out.summary || out.output || out.message || "";
    lines.push(...summarizeOutputLines(text, 3, 120));
    const tokenCount = pickTokenCount(out);
    return { lines: lines.slice(0, 3), tokenCount };
  }

  if (type.startsWith("condition.")) {
    const branch =
      String(out.matchedPort || out.port || "").trim() ||
      (typeof out.result === "boolean" ? (out.result ? "true" : "false") : "");
    if (branch) lines.push(`Branch: ${branch}`);
    if (Object.prototype.hasOwnProperty.call(out, "value")) lines.push(`Value: ${String(out.value)}`);
    return { lines: lines.slice(0, 3) };
  }

  if (type.startsWith("git.") || type.startsWith("github.")) {
    const shaRaw = String(out.commitSha || out.sha || out.head || "").trim();
    const sha = /^[0-9a-f]{7,40}$/i.test(shaRaw) ? shaRaw.slice(0, 12) : "";
    const prUrlRaw = String(out.prUrl || out.url || out.htmlUrl || "").trim();
    if (sha) lines.push(`Commit: ${sha}`);
    if (prUrlRaw) lines.push(`PR: ${prUrlRaw}`);
    if (!lines.length && out.output) lines.push(...summarizeOutputLines(out.output, 2, 120));
    return { lines: lines.slice(0, 3) };
  }

  if (typeof out === "object") {
    const text = out.message || out.summary || out.output || out.error || "";
    if (text) lines.push(...summarizeOutputLines(text, 3, 120));
    if (!lines.length) {
      const keys = Object.keys(out).slice(0, 3);
      if (keys.length) lines.push(`Keys: ${keys.join(", ")}`);
    }
    return { lines: lines.slice(0, 3) };
  }

  return { lines: summarizeOutputLines(out, 3, 120) };
}

function queueWorkflowWsEvent(event = {}) {
  const runId = String(event.runId || "").trim();
  const workflowId = String(event.workflowId || "").trim();
  if (!runId || !workflowId) return;
  const key = `${workflowId}:${runId}`;
  let bucket = workflowWsBatchByKey.get(key);
  if (!bucket) {
    bucket = { workflowId, runId, events: [], timer: null };
    workflowWsBatchByKey.set(key, bucket);
  }
  const seq = ++workflowWsSeq;
  bucket.events.push({
    ...event,
    seq,
    timestamp: Number(event.timestamp) || Date.now(),
  });
  if (bucket.timer) return;
  bucket.timer = setTimeout(() => {
    bucket.timer = null;
    const pending = bucket.events.splice(0, bucket.events.length);
    if (!pending.length) {
      workflowWsBatchByKey.delete(key);
      return;
    }
    const runEvents = new Map();
    const nodeTransitionEvents = [];
    const edgeEvents = new Map();
    for (const entry of pending) {
      const kind = String(entry.kind || "").trim();
      if (kind === "run") {
        runEvents.set(String(entry.runId || ""), entry);
      } else if (kind === "node") {
        nodeTransitionEvents.push(entry);
      } else if (kind === "edge") {
        edgeEvents.set(String(entry.edgeId || ""), entry);
      }
    }
    nodeTransitionEvents.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    const nodeEventsById = new Map();
    for (const entry of nodeTransitionEvents) {
      const nodeId = String(entry.nodeId || "").trim();
      if (!nodeId) continue;
      const current = nodeEventsById.get(nodeId) || { running: null, latest: null };
      const status = String(entry.status || "").trim().toLowerCase();
      if (status === "running" || String(entry.eventType || "").trim() === "node:start") {
        current.running = entry;
      }
      current.latest = entry;
      nodeEventsById.set(nodeId, current);
    }
    const nodeEvents = [];
    for (const state of nodeEventsById.values()) {
      if (state.running) nodeEvents.push(state.running);
      if (state.latest && (!state.running || state.latest.seq !== state.running.seq)) {
        nodeEvents.push(state.latest);
      }
    }
    const events = [
      ...Array.from(runEvents.values()),
      ...nodeEvents,
      ...Array.from(edgeEvents.values()),
    ].sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    if (events.length) {
      broadcastUiEvent(["workflows"], "workflow-run-events", {
        workflowId: bucket.workflowId,
        runId: bucket.runId,
        events,
      });
    }
    if (!bucket.events.length) workflowWsBatchByKey.delete(key);
  }, WORKFLOW_WS_BATCH_MS);
}

function attachWorkflowEngineLiveBridge(engine) {
  if (!engine || typeof engine.on !== "function" || workflowEngineListenerCleanup.has(engine)) {
    return;
  }
  const unsubs = [];
  const listen = (eventName, handler) => {
    const wrapped = (payload = {}) => {
      try {
        handler(payload);
      } catch {
        // best effort
      }
    };
    engine.on(eventName, wrapped);
    unsubs.push(() => {
      try {
        engine.off(eventName, wrapped);
      } catch {}
    });
  };

  listen("run:start", (payload) => {
    queueWorkflowWsEvent({
      kind: "run",
      workflowId: payload.workflowId,
      workflowName: payload.name || payload.workflowName || null,
      runId: payload.runId,
      status: "running",
      eventType: "run:start",
      timestamp: Date.now(),
    });
  });
  listen("run:end", (payload) => {
    queueWorkflowWsEvent({
      kind: "run",
      workflowId: payload.workflowId,
      workflowName: payload.workflowName || payload.name || null,
      runId: payload.runId,
      status: String(payload.status || "").trim().toLowerCase() || "completed",
      duration: Number(payload.duration) || null,
      eventType: "run:end",
      timestamp: Date.now(),
    });
  });
  listen("run:error", (payload) => {
    queueWorkflowWsEvent({
      kind: "run",
      workflowId: payload.workflowId,
      workflowName: payload.workflowName || payload.name || null,
      runId: payload.runId,
      status: "failed",
      error: String(payload.error || "").trim() || null,
      eventType: "run:error",
      timestamp: Date.now(),
    });
  });
  listen("run:cancel:requested", (payload) => {
    queueWorkflowWsEvent({
      kind: "run",
      workflowId: payload.workflowId,
      workflowName: payload.workflowName || null,
      runId: payload.runId,
      status: "cancelled",
      eventType: "run:cancel",
      timestamp: Number(payload.requestedAt) || Date.now(),
    });
  });
  listen("node:start", (payload) => {
    queueWorkflowWsEvent({
      kind: "node",
      workflowId: payload.workflowId,
      workflowName: payload.workflowName || null,
      runId: payload.runId,
      nodeId: payload.nodeId,
      nodeType: payload.nodeType,
      nodeLabel: payload.nodeLabel,
      status: "running",
      eventType: "node:start",
      timestamp: Date.now(),
    });
  });
  listen("node:complete", (payload) => {
    const preview = buildWorkflowNodeOutputPreview(payload.nodeType, payload.output);
    queueWorkflowWsEvent({
      kind: "node",
      workflowId: payload.workflowId,
      workflowName: payload.workflowName || null,
      runId: payload.runId,
      nodeId: payload.nodeId,
      nodeType: payload.nodeType,
      nodeLabel: payload.nodeLabel,
      status: "success",
      outputPreview: preview,
      eventType: "node:complete",
      timestamp: Date.now(),
    });
  });
  listen("node:error", (payload) => {
    queueWorkflowWsEvent({
      kind: "node",
      workflowId: payload.workflowId,
      workflowName: payload.workflowName || null,
      runId: payload.runId,
      nodeId: payload.nodeId,
      nodeType: payload.nodeType,
      nodeLabel: payload.nodeLabel,
      status: "fail",
      error: String(payload.error || "").trim() || null,
      retries: Number(payload.retries) || 0,
      eventType: "node:error",
      timestamp: Date.now(),
    });
  });
  listen("node:skip", (payload) => {
    queueWorkflowWsEvent({
      kind: "node",
      workflowId: payload.workflowId,
      workflowName: payload.workflowName || null,
      runId: payload.runId,
      nodeId: payload.nodeId,
      nodeType: payload.nodeType,
      nodeLabel: payload.nodeLabel,
      status: normalizeWorkflowNodeStatus(payload.status || "skipped"),
      reason: payload.reason || "skipped",
      eventType: "node:skip",
      timestamp: Date.now(),
    });
  });
  listen("edge:flow", (payload) => {
    queueWorkflowWsEvent({
      kind: "edge",
      workflowId: payload.workflowId,
      workflowName: payload.workflowName || null,
      runId: payload.runId,
      edgeId: payload.edgeId,
      source: payload.source,
      target: payload.target,
      sourcePort: payload.sourcePort || "default",
      backEdge: payload.backEdge === true,
      reason: payload.reason || "flow",
      iteration: Number(payload.iteration) || null,
      eventType: "edge:flow",
      timestamp: Date.now(),
    });
  });

  workflowEngineListenerCleanup.set(engine, () => {
    for (const unsub of unsubs) unsub();
  });
}

function broadcastUiEvent(channels, type, payload = {}) {
  const required = new Set(Array.isArray(channels) ? channels : [channels]);
  const message = {
    type,
    channels: Array.from(required),
    payload,
    ts: Date.now(),
  };
  for (const socket of wsClients) {
    const subscribed = socket.__channels || new Set(["*"]);
    const shouldSend =
      subscribed.has("*") ||
      Array.from(required).some((channel) => subscribed.has(channel));
    if (shouldSend) {
      sendWsMessage(socket, message);
    }
  }
}

function broadcastSessionMessage(payload) {
  const required = new Set(["sessions", "chat", "tui"]);
  const message = {
    type: "session-message",
    channels: Array.from(required),
    payload,
    ts: Date.now(),
  };
  for (const socket of wsClients) {
    const subscribed = socket.__channels || new Set(["*"]);
    const shouldSend =
      subscribed.has("*") ||
      Array.from(required).some((channel) => subscribed.has(channel));
    if (shouldSend) {
      sendWsMessage(socket, message);
    }
  }
}

async function collectUiStats() {
  const os = await import("node:os");
  const memUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  // Try to read status from the monitor's status file first
  let orchestratorStatus = null;
  try {
    if (existsSync(statusPath)) {
      const raw = await readFile(resolveStatusPath(), "utf8");
      orchestratorStatus = JSON.parse(raw);
    }
  } catch { /* best effort */ }

  let taskStats = {
    total: 0,
    active: 0,
    completed: 0,
    failed: 0,
    queued: 0,
  };
  
  // Use orchestrator status if available, otherwise try task store
  if (orchestratorStatus?.counts) {
    taskStats = {
      total: (orchestratorStatus.counts.todo || 0) + (orchestratorStatus.counts.inprogress || 0) + 
             (orchestratorStatus.counts.done || 0) + (orchestratorStatus.counts.inreview || 0) +
             (orchestratorStatus.counts.blocked || 0),
      active: orchestratorStatus.counts.inprogress || 0,
      completed: orchestratorStatus.counts.done || 0,
      failed: orchestratorStatus.counts.error || 0,
      queued: orchestratorStatus.counts.todo || 0,
    };
  } else {
    try {
      const taskStoreModule = await import("../task/task-store.mjs").catch(() => ({}));
      const getStats = taskStoreModule?.getStats;
      if (typeof getStats === "function") {
        const stats = getStats();
        taskStats = {
          total: stats?.total || 0,
          active: (stats?.inprogress || 0) + (stats?.todo || 0),
          completed: stats?.done || 0,
          failed: stats?.failed || 0,
          queued: stats?.todo || 0,
        };
      }
    } catch { /* best effort */ }
  }

  let sessionStats = {
    total: 0,
    active: 0,
    completed: 0,
    failed: 0,
  };

  // Use orchestrator status for session/attempt info
  if (orchestratorStatus?.attempts) {
    const attempts = Object.values(orchestratorStatus.attempts);
    sessionStats = {
      total: attempts.length,
      active: attempts.filter((a) => a.status === "running" || a.status === "active").length,
      completed: attempts.filter((a) => a.status === "done" || a.status === "completed").length,
      failed: attempts.filter((a) => a.status === "failed" || a.status === "error").length,
    };
  } else if (typeof getActiveThreads === "function") {
    try {
      const activeThreads = getActiveThreads() || [];
      sessionStats = {
        total: activeThreads.length,
        active: activeThreads.filter((t) => t.status === "active").length,
        completed: activeThreads.filter((t) => t.status === "completed").length,
        failed: activeThreads.filter((t) => t.status === "failed").length,
      };
    } catch { /* best effort */ }
  }

  const runtimeStats = getRuntimeStats();

  return {
    uptimeMs: process.uptime() * 1000,
    runtimeMs: runtimeStats.runtimeMs || 0,
    totalCostUsd: runtimeStats.totalCostUsd || 0,
    totalSessions: sessionStats.total,
    activeSessions: sessionStats.active,
    completedSessions: sessionStats.completed,
    failedSessions: sessionStats.failed,
    totalTasks: taskStats.total,
    activeTasks: taskStats.active,
    completedTasks: taskStats.completed,
    failedTasks: taskStats.failed,
    queuedTasks: taskStats.queued,
    activeSlots: orchestratorStatus?.active_slots || "0/0",
    executorMode: orchestratorStatus?.executor_mode || "unknown",
    retryQueue: (() => {
      const bus = _resolveEventBus();
      if (bus && typeof bus.getRetryQueue === "function") {
        try {
          const snapshot = bus.getRetryQueue();
          if (snapshot && typeof snapshot === "object") return snapshot;
        } catch {
          /* best effort */
        }
      }
      return globalThis.__bosun_setRetryQueueData
        ? _retryQueue
        : {
            count: 0,
            items: [],
            stats: { totalRetriesToday: 0, peakRetryDepth: 0, exhaustedTaskIds: [] },
          };
    })(),
    workflows: {
      active: globalThis.__bosun_activeWorkflows || [],
      total: globalThis.__bosun_totalWorkflows || 0,
    },
    agents: {
      online: sessionStats.active,
      total: 5,
    },
    memory: {
      used: usedMem,
      total: totalMem,
    },
    cpu: {
      usage: ((cpuUsage.user + cpuUsage.system) / 1000000) * 100,
    },
    ts: Date.now(),
  };
}

/* ─── Log Streaming Helpers ─── */

async function resolveAgentLogsDir() {
  for (const dir of agentLogsDirCandidates) {
    const files = await readdir(dir).catch(() => null);
    if (files?.some((f) => f.endsWith(".log"))) return dir;
  }
  for (const dir of agentLogsDirCandidates) {
    if (existsSync(dir)) return dir;
  }
  return agentLogsDirCandidates[0];
}

function normalizeAgentLogName(name) {
  return basename(String(name || "")).trim();
}

async function listDirFilesWithMtime(dir, predicate = () => true) {
  const names = await readdir(dir).catch(() => []);
  const entries = await Promise.all(
    names
      .filter((name) => predicate(name))
      .map(async (name) => {
        const fullPath = resolve(dir, name);
        const info = await stat(fullPath).catch(() => null);
        if (!info?.isFile?.()) return null;
        return {
          name,
          path: fullPath,
          mtimeMs: Number(info.mtimeMs || 0),
        };
      }),
  );
  return entries.filter(Boolean);
}

const SYSTEM_LOG_PRIORITY = Object.freeze({
  "monitor.log": 300,
  "monitor-error.log": 250,
  "daemon.log": 200,
});

async function listPreferredSystemLogEntries(limit = 4) {
  const rootLogEntries = await listDirFilesWithMtime(
    logsDir,
    (name) => name.endsWith(".log"),
  );
  return rootLogEntries
    .sort((a, b) => {
      const priorityDelta =
        (SYSTEM_LOG_PRIORITY[b.name] || 0) - (SYSTEM_LOG_PRIORITY[a.name] || 0);
      if (priorityDelta !== 0) return priorityDelta;
      return b.mtimeMs - a.mtimeMs;
    })
    .slice(0, Math.max(1, limit));
}

async function resolvePreferredSystemLogPath() {
  const preferredEntries = await listPreferredSystemLogEntries(1);
  return preferredEntries[0]?.path || null;
}

/**
 * Resolve the log file path for a given logType and optional query.
 * Returns null if no matching file found.
 */
async function resolveLogPath(logType, query) {
  if (logType === "system") {
    return resolvePreferredSystemLogPath();
  }
  if (logType === "agent") {
    const matches = await listAgentLogFiles(query, 1);
    if (matches.length > 0) {
      return resolve(matches[0].source, matches[0].name);
    }
    const agentLogsDir = await resolveAgentLogsDir();
    const files = await readdir(agentLogsDir).catch(() => []);
    const candidates = files.filter((f) => f.endsWith(".log")).sort().reverse();
    return candidates.length ? resolve(agentLogsDir, candidates[0]) : null;
  }
  return null;
}

/**
 * Start streaming a log file to a socket. Uses polling (every 2s) to detect
 * new content. Handles file rotation and missing files gracefully.
 */
function startLogStream(socket, logType, query) {
  // Clean up any previous stream for this socket
  stopLogStream(socket);

  const streamState = { logType, query, filePath: null, offset: 0, pollTimer: null, active: true };
  socket.__logStream = streamState;

  async function poll() {
    if (!streamState.active) return;
    try {
      const filePath = await resolveLogPath(logType, query);
      if (!filePath || !existsSync(filePath)) return;

      // Detect file rotation (path changed or file shrank)
      const info = await stat(filePath).catch(() => null);
      if (!info) return;
      const size = info.size || 0;

      if (filePath !== streamState.filePath) {
        // New file or first poll — start from end to avoid dumping history
        streamState.filePath = filePath;
        streamState.offset = size;
        return;
      }

      if (size < streamState.offset) {
        // File was truncated/rotated — reset
        streamState.offset = 0;
      }

      if (size <= streamState.offset) return;

      // Read only new bytes
      const readLen = Math.min(size - streamState.offset, 512_000);
      const handle = await open(filePath, "r");
      try {
        const buffer = Buffer.alloc(readLen);
        await handle.read(buffer, 0, readLen, streamState.offset);
        streamState.offset += readLen;
        const text = buffer.toString("utf8");
        const lines = text.split("\n").filter(Boolean);
        if (lines.length > 0) {
          sendWsMessage(socket, { type: "log-lines", lines });
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Ignore transient errors — next poll will retry
    }
  }

  // First poll immediately, then every 2 seconds
  poll();
  streamState.pollTimer = setInterval(poll, 2000);
}

/**
 * Stop streaming logs for a given socket.
 */
function stopLogStream(socket) {
  const stream = socket.__logStream;
  if (stream) {
    stream.active = false;
    if (stream.pollTimer) clearInterval(stream.pollTimer);
    socket.__logStream = null;
  }
}

/* ─── Server-side Heartbeat ─── */

function startWsHeartbeat() {
  if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer);
  wsHeartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const socket of wsClients) {
      // Check for missed pongs (2 consecutive pings = 60s)
      if (socket.__lastPing && !socket.__lastPong) {
        socket.__missedPongs = (socket.__missedPongs || 0) + 1;
      } else if (socket.__lastPing && socket.__lastPong && socket.__lastPong < socket.__lastPing) {
        socket.__missedPongs = (socket.__missedPongs || 0) + 1;
      } else {
        socket.__missedPongs = 0;
      }

      if ((socket.__missedPongs || 0) >= 2) {
        try { socket.close(); } catch { /* noop */ }
        wsClients.delete(socket);
        stopLogStream(socket);
        continue;
      }

      // Send ping
      socket.__lastPing = now;
      sendWsMessage(socket, { type: "ping", ts: now });
    }
  }, 30_000);
}

function stopWsHeartbeat() {
  if (wsHeartbeatTimer) {
    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = null;
  }
}

function getGitHubWebhookPath() {
  return (
    process.env.GITHUB_PROJECT_WEBHOOK_PATH ||
    "/api/webhooks/github/project-sync"
  );
}

function getGitHubWebhookSecret() {
  return (
    process.env.GITHUB_PROJECT_WEBHOOK_SECRET ||
    process.env.GITHUB_WEBHOOK_SECRET ||
    ""
  );
}

function shouldRequireGitHubWebhookSignature() {
  const secret = getGitHubWebhookSecret();
  return parseBooleanEnv(
    process.env.GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE,
    Boolean(secret),
  );
}

function getWebhookFailureAlertThreshold() {
  return Math.max(
    1,
    Number(process.env.GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD || 3),
  );
}

async function emitProjectSyncAlert(message, context = {}) {
  projectSyncWebhookMetrics.alertsTriggered++;
  console.warn(
    `[project-sync-webhook] alert: ${message} ${JSON.stringify(context)}`,
  );
  if (typeof uiDeps.onProjectSyncAlert === "function") {
    try {
      await uiDeps.onProjectSyncAlert({
        message,
        context,
        timestamp: new Date().toISOString(),
      });
    } catch {
      // best effort
    }
  }
}

function verifyGitHubWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret) return false;
  const expectedDigest = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const providedRaw = String(signatureHeader || "");
  if (!providedRaw.startsWith("sha256=")) return false;
  const providedDigest = providedRaw.slice("sha256=".length).trim();
  if (!providedDigest || providedDigest.length !== expectedDigest.length) {
    return false;
  }
  const expected = Buffer.from(expectedDigest, "utf8");
  const provided = Buffer.from(providedDigest, "utf8");
  return timingSafeEqual(expected, provided);
}

function extractIssueNumberFromWebhook(payload) {
  const item = payload?.projects_v2_item || {};
  const content = item.content || payload?.content || {};
  const candidates = [
    item.content_number,
    item.issue_number,
    content.number,
    content.issue?.number,
    payload?.issue?.number,
  ];
  for (const candidate of candidates) {
    const numeric = Number(candidate);
    if (Number.isInteger(numeric) && numeric > 0) {
      return String(numeric);
    }
  }
  const urlCandidates = [
    item.content_url,
    item.url,
    content.url,
    payload?.issue?.html_url,
    payload?.issue?.url,
  ];
  for (const value of urlCandidates) {
    const match = String(value || "").match(/\/issues\/(\d+)(?:$|[/?#])/);
    if (match) return match[1];
  }
  return null;
}

export function getProjectSyncWebhookMetrics() {
  return { ...projectSyncWebhookMetrics };
}

export function resetProjectSyncWebhookMetrics() {
  for (const key of Object.keys(projectSyncWebhookMetrics)) {
    if (
      key === "lastEventAt" ||
      key === "lastSuccessAt" ||
      key === "lastFailureAt" ||
      key === "lastError"
    ) {
      projectSyncWebhookMetrics[key] = null;
      continue;
    }
    projectSyncWebhookMetrics[key] = 0;
  }
}

async function readRawBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      size += buf.length;
      if (size > 1_000_000) {
        rejectBody(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", rejectBody);
  });
}

async function handleGitHubProjectWebhook(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type,X-GitHub-Event,X-Hub-Signature-256,X-GitHub-Delivery",
    });
    res.end();
    return;
  }
  if (req.method !== "POST") {
    jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  projectSyncWebhookMetrics.received++;
  projectSyncWebhookMetrics.lastEventAt = new Date().toISOString();

  const deliveryId = String(req.headers["x-github-delivery"] || "");
  const eventType = String(req.headers["x-github-event"] || "").toLowerCase();
  const secret = getGitHubWebhookSecret();
  const requireSignature = shouldRequireGitHubWebhookSignature();

  try {
    const rawBody = await readRawBody(req);
    if (requireSignature) {
      const signature = req.headers["x-hub-signature-256"];
      if (
        !verifyGitHubWebhookSignature(rawBody, signature, secret)
      ) {
        projectSyncWebhookMetrics.invalidSignature++;
        projectSyncWebhookMetrics.failed++;
        projectSyncWebhookMetrics.consecutiveFailures++;
        projectSyncWebhookMetrics.lastFailureAt = new Date().toISOString();
        projectSyncWebhookMetrics.lastError = "invalid webhook signature";
        const threshold = getWebhookFailureAlertThreshold();
        if (
          projectSyncWebhookMetrics.consecutiveFailures % threshold ===
          0
        ) {
          await emitProjectSyncAlert(
            `GitHub project webhook signature failures: ${projectSyncWebhookMetrics.consecutiveFailures}`,
            { deliveryId, eventType },
          );
        }
        jsonResponse(res, 401, { ok: false, error: "Invalid webhook signature" });
        return;
      }
    }

    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      projectSyncWebhookMetrics.failed++;
      projectSyncWebhookMetrics.consecutiveFailures++;
      projectSyncWebhookMetrics.lastFailureAt = new Date().toISOString();
      projectSyncWebhookMetrics.lastError = "invalid JSON payload";
      jsonResponse(res, 400, { ok: false, error: "Invalid JSON payload" });
      return;
    }

    if (eventType !== "projects_v2_item") {
      projectSyncWebhookMetrics.ignored++;
      projectSyncWebhookMetrics.processed++;
      jsonResponse(res, 202, {
        ok: true,
        ignored: true,
        reason: `Unsupported event: ${eventType || "unknown"}`,
      });
      return;
    }

    const syncEngine = uiDeps.getSyncEngine?.() || null;
    if (!syncEngine) {
      projectSyncWebhookMetrics.failed++;
      projectSyncWebhookMetrics.consecutiveFailures++;
      projectSyncWebhookMetrics.lastFailureAt = new Date().toISOString();
      projectSyncWebhookMetrics.lastError = "sync engine unavailable";
      const threshold = getWebhookFailureAlertThreshold();
      if (
        projectSyncWebhookMetrics.consecutiveFailures % threshold ===
        0
      ) {
        await emitProjectSyncAlert(
          `GitHub project webhook sync failures: ${projectSyncWebhookMetrics.consecutiveFailures}`,
          { deliveryId, reason: "sync engine unavailable" },
        );
      }
      jsonResponse(res, 503, { ok: false, error: "Sync engine unavailable" });
      return;
    }

    const beforeRateLimitEvents =
      Number(syncEngine.getStatus?.()?.metrics?.rateLimitEvents || 0);
    const issueNumber = extractIssueNumberFromWebhook(payload);
    const action = String(payload?.action || "");

    projectSyncWebhookMetrics.syncTriggered++;
    if (issueNumber && typeof syncEngine.syncTask === "function") {
      await syncEngine.syncTask(issueNumber);
      console.log(
        `[project-sync-webhook] delivery=${deliveryId} action=${action} task=${issueNumber} synced`,
      );
    } else if (typeof syncEngine.fullSync === "function") {
      await syncEngine.fullSync();
      console.log(
        `[project-sync-webhook] delivery=${deliveryId} action=${action} full-sync triggered`,
      );
    } else {
      throw new Error("sync engine does not expose syncTask/fullSync");
    }

    const afterRateLimitEvents =
      Number(syncEngine.getStatus?.()?.metrics?.rateLimitEvents || 0);
    if (afterRateLimitEvents > beforeRateLimitEvents) {
      projectSyncWebhookMetrics.rateLimitObserved +=
        afterRateLimitEvents - beforeRateLimitEvents;
    }
    projectSyncWebhookMetrics.processed++;
    projectSyncWebhookMetrics.syncSuccess++;
    projectSyncWebhookMetrics.consecutiveFailures = 0;
    projectSyncWebhookMetrics.lastSuccessAt = new Date().toISOString();
    projectSyncWebhookMetrics.lastError = null;
    jsonResponse(res, 202, {
      ok: true,
      deliveryId,
      eventType,
      action,
      issueNumber,
      synced: true,
    });
  } catch (err) {
    projectSyncWebhookMetrics.failed++;
    projectSyncWebhookMetrics.syncFailure++;
    projectSyncWebhookMetrics.consecutiveFailures++;
    projectSyncWebhookMetrics.lastFailureAt = new Date().toISOString();
    projectSyncWebhookMetrics.lastError = err.message;
    const threshold = getWebhookFailureAlertThreshold();
    if (
      projectSyncWebhookMetrics.consecutiveFailures % threshold === 0
    ) {
      await emitProjectSyncAlert(
        `GitHub project webhook sync failures: ${projectSyncWebhookMetrics.consecutiveFailures}`,
        { deliveryId, eventType, error: err.message },
      );
    }
    console.warn(
      `[project-sync-webhook] delivery=${deliveryId} failed: ${err.message}`,
    );
    jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

// ─── GitHub App webhook ──────────────────────────────────────────────────────

function getAppWebhookPath() {
  return (
    process.env.BOSUN_GITHUB_APP_WEBHOOK_PATH ||
    "/api/webhooks/github/app"
  );
}

/**
 * Handles App-level webhook deliveries from GitHub.
 * Events: installation, installation_repositories, ping, pull_request, push…
 * Validates HMAC-SHA256 signature using BOSUN_GITHUB_WEBHOOK_SECRET.
 */
async function handleGitHubAppWebhook(req, res) {
  if (req.method !== "POST") {
    jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const deliveryId = String(req.headers["x-github-delivery"] || "");
  const eventType = String(req.headers["x-github-event"] || "").toLowerCase();

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    jsonResponse(res, 400, { ok: false, error: "Failed to read body" });
    return;
  }

  // Validate HMAC signature if secret is configured
  const webhookSecret = process.env.BOSUN_GITHUB_WEBHOOK_SECRET || "";
  if (webhookSecret) {
    const sigHeader = req.headers["x-hub-signature-256"] || "";
    if (!verifyGitHubWebhookSignature(rawBody, sigHeader, webhookSecret)) {
      console.warn(
        `[app-webhook] delivery=${deliveryId} invalid signature — check BOSUN_GITHUB_WEBHOOK_SECRET`,
      );
      jsonResponse(res, 401, { ok: false, error: "Invalid webhook signature" });
      return;
    }
  }

  let payload = {};
  try {
    payload = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    jsonResponse(res, 400, { ok: false, error: "Invalid JSON payload" });
    return;
  }

  // Acknowledge immediately — GitHub requires a fast response
  jsonResponse(res, 202, { ok: true, deliveryId, eventType });

  // Process asynchronously
  setImmediate(() => {
    try {
      _processAppWebhookEvent(eventType, payload, deliveryId);
    } catch (err) {
      console.warn(`[app-webhook] processing error delivery=${deliveryId}: ${err.message}`);
    }
  });
}

function _processAppWebhookEvent(eventType, payload, deliveryId) {
  switch (eventType) {
    case "ping":
      console.log(
        `[app-webhook] ping delivery=${deliveryId} zen="${payload.zen || ""}"`,
      );
      break;

    case "installation": {
      const action = payload.action || "";
      const login = payload.installation?.account?.login || "unknown";
      const repos = (payload.repositories || []).map((r) => r.full_name);
      console.log(
        `[app-webhook] installation ${action} account=${login} repos=${repos.join(",") || "(all)"}`,
      );
      broadcastUiEvent(["overview"], "invalidate", {
        reason: `github-app-installation-${action}`,
        account: login,
      });
      break;
    }

    case "installation_repositories": {
      const action = payload.action || "";
      const added = (payload.repositories_added || []).map((r) => r.full_name);
      const removed = (payload.repositories_removed || []).map((r) => r.full_name);
      console.log(
        `[app-webhook] installation_repositories ${action} added=${added.join(",")} removed=${removed.join(",")}`,
      );
      break;
    }

    default:
      console.log(
        `[app-webhook] delivery=${deliveryId} event=${eventType} action=${payload.action || ""} (unhandled, ack'd)`,
      );
  }
}

// ─── GitHub OAuth callback ────────────────────────────────────────────────────

/**
 * Handles the OAuth redirect from GitHub after a user installs/authorizes
 * the Bosun[VE] GitHub App.
 *
 * Flow:
 *   1. GitHub redirects: GET /api/github/callback?code=xxx&installation_id=yyy
 *   2. We exchange `code` for a user access token
 *   3. We fetch the user's GitHub login for confirmation
 *   4. We redirect the user to the main app UI with a success banner
 *
 * The token is surfaced in the response so the operator can copy it;
 * it is also written to .env as GH_TOKEN if GH_TOKEN is currently unset.
 */
async function handleGitHubOAuthCallback(req, res) {
  if (req.method !== "GET") {
    jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const code = urlObj.searchParams.get("code") || "";
  const installationId = urlObj.searchParams.get("installation_id") || "";
  const setupAction = urlObj.searchParams.get("setup_action") || "";

  // If no code, this might be a test ping — just return 200
  if (!code) {
    jsonResponse(res, 400, { ok: false, error: "Missing code parameter" });
    return;
  }

  const clientId = process.env.BOSUN_GITHUB_CLIENT_ID || "";
  const clientSecret = process.env.BOSUN_GITHUB_CLIENT_SECRET || "";

  if (!clientId || !clientSecret) {
    console.warn("[oauth-callback] BOSUN_GITHUB_CLIENT_ID/CLIENT_SECRET not set — cannot exchange code");
    res.writeHead(302, { Location: "/?oauth=error&reason=not_configured" });
    res.end();
    return;
  }

  try {
    // Exchange code for user access token
    const tokenBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
    });
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "bosun-ve",
      },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      throw new Error(`Token exchange HTTP ${tokenRes.status}`);
    }
    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      throw new Error(`${tokenData.error}: ${tokenData.error_description || ""}`);
    }

    const accessToken = tokenData.access_token;

    // Fetch the user identity for logging / display
    let login = "unknown";
    try {
      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "bosun-ve",
        },
      });
      if (userRes.ok) {
        const u = await userRes.json();
        login = u.login || "unknown";
      }
    } catch {
      // non-fatal
    }

    console.log(
      `[oauth-callback] authorized user=${login} installation_id=${installationId} setup_action=${setupAction}`,
    );

    // If GH_TOKEN is not already set, write the token to .env so Bosun can use it.
    if (!process.env.GH_TOKEN && accessToken) {
      try {
        updateEnvFile({ GH_TOKEN: accessToken });
        process.env.GH_TOKEN = accessToken;
        console.log(`[oauth-callback] wrote GH_TOKEN to .env for user=${login}`);
      } catch (err) {
        console.warn(`[oauth-callback] could not write GH_TOKEN to .env: ${err.message}`);
      }
    }

    broadcastUiEvent(["overview"], "invalidate", {
      reason: "github-oauth-authorized",
      login,
      installationId,
    });

    // Redirect to the main UI with success indication
    const redirectUrl = `/?oauth=success&gh_user=${encodeURIComponent(login)}${installationId ? `&installation_id=${encodeURIComponent(installationId)}` : ""}`;
    res.writeHead(302, { Location: redirectUrl });
    res.end();
  } catch (err) {
    console.warn(`[oauth-callback] error: ${err.message}`);
    res.writeHead(302, {
      Location: `/?oauth=error&reason=${encodeURIComponent(err.message.slice(0, 100))}`,
    });
    res.end();
  }
}

// ─── GitHub Device Flow ───────────────────────────────────────────────────────

/**
 * POST /api/github/device/start
 * Kicks off the OAuth Device Flow — returns a user code + verification URL.
 * No public URL, no callback, no client secret needed.
 * User visits github.com/login/device, enters the code, done.
 */
async function handleDeviceFlowStart(req, res) {
  if (req.method !== "POST") {
    jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const clientId = (process.env.BOSUN_GITHUB_CLIENT_ID || "").trim();
  if (!clientId) {
    jsonResponse(res, 400, {
      ok: false,
      error: "BOSUN_GITHUB_CLIENT_ID is not set. Configure it in Settings → GitHub.",
    });
    return;
  }

  try {
    const body = new URLSearchParams({ client_id: clientId, scope: "repo" });
    const ghRes = await fetch("https://github.com/login/device/code", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "bosun-ve",
      },
      body: body.toString(),
    });

    if (!ghRes.ok) {
      const text = await ghRes.text();
      throw new Error(`GitHub device/code ${ghRes.status}: ${text}`);
    }

    const data = await ghRes.json();
    if (data.error) {
      throw new Error(`${data.error}: ${data.error_description || ""}`);
    }

    console.log(`[device-flow] started — user code: ${data.user_code}`);

    jsonResponse(res, 200, {
      ok: true,
      data: {
        deviceCode: data.device_code,
        userCode: data.user_code,
        verificationUri: data.verification_uri,
        expiresIn: data.expires_in,
        interval: data.interval || 5,
      },
    });
  } catch (err) {
    console.warn(`[device-flow] start error: ${err.message}`);
    jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

/**
 * POST /api/github/device/poll
 * Polls GitHub to check if the user has entered the device code.
 * Body: { deviceCode: "..." }
 *
 * Returns:
 *   { status: "pending" }        — still waiting
 *   { status: "complete", login } — done, token saved
 *   { status: "expired" }        — code expired, restart
 *   { status: "error", error }   — something went wrong
 */
async function handleDeviceFlowPoll(req, res) {
  if (req.method !== "POST") {
    jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    return;
  }

  const clientId = (process.env.BOSUN_GITHUB_CLIENT_ID || "").trim();
  if (!clientId) {
    jsonResponse(res, 400, { ok: false, error: "BOSUN_GITHUB_CLIENT_ID not set" });
    return;
  }

  let deviceCode;
  try {
    const body = await readJsonBody(req);
    deviceCode = body?.deviceCode;
  } catch {
    jsonResponse(res, 400, { ok: false, error: "Invalid JSON body" });
    return;
  }

  if (!deviceCode) {
    jsonResponse(res, 400, { ok: false, error: "deviceCode is required" });
    return;
  }

  try {
    const body = new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });

    const ghRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "bosun-ve",
      },
      body: body.toString(),
    });

    if (!ghRes.ok) {
      throw new Error(`Token poll HTTP ${ghRes.status}`);
    }

    const data = await ghRes.json();

    // Success — got a token
    if (data.access_token) {
      const accessToken = data.access_token;

      // Fetch user identity
      let login = "unknown";
      try {
        const userRes = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "bosun-ve",
          },
        });
        if (userRes.ok) {
          const u = await userRes.json();
          login = u.login || "unknown";
        }
      } catch {
        // non-fatal
      }

      console.log(`[device-flow] authorized user=${login}`);

      // Save token to .env and process.env
      if (accessToken) {
        try {
          updateEnvFile({ GH_TOKEN: accessToken });
          process.env.GH_TOKEN = accessToken;
          console.log(`[device-flow] wrote GH_TOKEN to .env for user=${login}`);
        } catch (err) {
          console.warn(`[device-flow] could not write GH_TOKEN to .env: ${err.message}`);
        }
      }

      broadcastUiEvent(["overview"], "invalidate", {
        reason: "github-device-flow-authorized",
        login,
      });

      jsonResponse(res, 200, { ok: true, data: { status: "complete", login } });
      return;
    }

    // Still pending or error
    switch (data.error) {
      case "authorization_pending":
        jsonResponse(res, 200, { ok: true, data: { status: "pending" } });
        return;
      case "slow_down":
        jsonResponse(res, 200, {
          ok: true,
          data: { status: "slow_down", interval: data.interval },
        });
        return;
      case "expired_token":
        jsonResponse(res, 200, { ok: true, data: { status: "expired" } });
        return;
      default:
        jsonResponse(res, 200, {
          ok: true,
          data: {
            status: "error",
            error: data.error,
            description: data.error_description || "",
          },
        });
    }
  } catch (err) {
    console.warn(`[device-flow] poll error: ${err.message}`);
    jsonResponse(res, 500, { ok: false, error: err.message });
  }
}

async function readStatusSnapshot() {
  const worktreeRecovery = await readWorktreeRecoveryState(repoRoot);
  try {
    const raw = await readFile(resolveStatusPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      parsed.worktreeRecovery = worktreeRecovery;
    }
    return parsed;
  } catch {
    return { worktreeRecovery };
  }
}

function runGit(args, timeoutMs = 10000) {
  const argList = Array.isArray(args)
    ? args
    : String(args || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  const res = spawnSync("git", argList, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(String(res.stderr || res.stdout || "git command failed").trim());
  }
  return String(res.stdout || "").trim();
}

async function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) {
        rejectBody(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolveBody(null);
      try {
        resolveBody(JSON.parse(data));
      } catch (err) {
        rejectBody(err);
      }
    });
  });
}

const ATTACHMENTS_ROOT = resolve(repoRoot, ".bosun", ".cache", "attachments");
const _maxAttachMb = Number(process.env.BOSUN_ATTACHMENT_MAX_MB || "25");
const MAX_ATTACHMENT_BYTES =
  (Number.isFinite(_maxAttachMb) ? _maxAttachMb : 25) * 1024 * 1024;

function sanitizePathSegment(value) {
  return String(value || "").replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function resolveAttachmentUrl(relPath) {
  return `/api/attachments/${String(relPath || "").replace(/\\/g, "/")}`;
}

async function readMultipartForm(req, maxBytes = MAX_ATTACHMENT_BYTES) {
  const contentType = String(req.headers["content-type"] || "");
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  if (!boundaryMatch) {
    throw new Error("Missing multipart boundary");
  }
  const boundary = `--${boundaryMatch[1]}`;
  const chunks = [];
  let total = 0;
  await new Promise((resolveBody, rejectBody) => {
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        rejectBody(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", resolveBody);
    req.on("error", rejectBody);
  });

  const buffer = Buffer.concat(chunks);
  const body = buffer.toString("latin1");
  const parts = body.split(boundary).slice(1, -1);
  const fields = {};
  const files = [];

  for (const part of parts) {
    const trimmed = part.startsWith("\r\n") ? part.slice(2) : part;
    const headerEnd = trimmed.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerText = trimmed.slice(0, headerEnd);
    let contentText = trimmed.slice(headerEnd + 4);
    if (contentText.endsWith("\r\n")) contentText = contentText.slice(0, -2);
    const headers = {};
    for (const line of headerText.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      headers[key] = value;
    }
    const disposition = headers["content-disposition"] || "";
    const nameMatch = disposition.match(/name=\"([^\"]+)\"/i);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    const filenameMatch = disposition.match(/filename=\"([^\"]*)\"/i);
    if (filenameMatch && filenameMatch[1]) {
      const filename = filenameMatch[1];
      const contentTypeHeader = headers["content-type"] || "";
      const data = Buffer.from(contentText, "latin1");
      files.push({
        fieldName,
        filename,
        contentType: contentTypeHeader,
        data,
      });
    } else {
      fields[fieldName] = contentText;
    }
  }

  return { fields, files };
}

function normalizeTagsInput(input) {
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
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function normalizeBranchInput(input) {
  const trimmed = String(input ?? "").trim();
  return trimmed ? trimmed : null;
}

function hasOwn(obj, key) {
  return Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeOptionalStringInput(input) {
  const trimmed = String(input ?? "").trim();
  return trimmed || null;
}

function normalizeAssigneesInput(input) {
  if (!input) return [];
  const values = Array.isArray(input)
    ? input
    : String(input || "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
  const seen = new Set();
  const assignees = [];
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    assignees.push(normalized);
  }
  return assignees;
}

function buildTaskMetadataPatch(input = {}) {
  const topLevel = {};
  const meta = {};
  const assigneesProvided = hasOwn(input, "assignees");

  if (hasOwn(input, "assignee")) {
    const assignee = normalizeOptionalStringInput(input?.assignee);
    if (assignee) {
      topLevel.assignee = assignee;
      meta.assignee = assignee;
      if (!assigneesProvided) {
        topLevel.assignees = [assignee];
        meta.assignees = [assignee];
      }
    }
  }

  if (assigneesProvided) {
    const assignees = normalizeAssigneesInput(input?.assignees);
    if (assignees.length > 0) {
      topLevel.assignees = assignees;
      meta.assignees = assignees;
      if (!hasOwn(topLevel, "assignee")) {
        topLevel.assignee = assignees[0];
      }
      if (!hasOwn(meta, "assignee")) {
        meta.assignee = assignees[0];
      }
    }
  }

  if (hasOwn(input, "type")) {
    const type = normalizeTaskTypeInput(input?.type);
    if (type) {
      topLevel.type = type;
    }
  }

  if (hasOwn(input, "epicId")) {
    const epicId = normalizeOptionalStringInput(input?.epicId);
    if (epicId) {
      topLevel.epicId = epicId;
      meta.epicId = epicId;
    }
  }

  if (hasOwn(input, "storyPoints")) {
    const numeric = Number(input?.storyPoints);
    if (Number.isFinite(numeric)) {
      topLevel.storyPoints = numeric;
      meta.storyPoints = numeric;
    }
  }

  if (hasOwn(input, "parentTaskId")) {
    const parentTaskId = normalizeOptionalStringInput(input?.parentTaskId);
    if (parentTaskId) {
      topLevel.parentTaskId = parentTaskId;
      meta.parentTaskId = parentTaskId;
    }
  }

  if (hasOwn(input, "dueDate")) {
    const dueDate = normalizeOptionalStringInput(input?.dueDate);
    if (dueDate) {
      topLevel.dueDate = dueDate;
      meta.dueDate = dueDate;
    }
  }

  if (hasOwn(input, "blockedReason")) {
    const blockedReason = normalizeOptionalStringInput(input?.blockedReason);
    if (blockedReason) {
      topLevel.blockedReason = blockedReason;
      meta.blockedReason = blockedReason;
    }
  }

  return { topLevel, meta };
}

const TASK_TYPE_VALUES = new Set(["epic", "task", "subtask"]);

function normalizeTaskTypeInput(input) {
  const normalized = String(input ?? "").trim().toLowerCase();
  return TASK_TYPE_VALUES.has(normalized) ? normalized : null;
}

const SPRINT_EXECUTION_MODES = new Set(["sequential", "parallel"]);

function normalizeSprintExecutionMode(input) {
  const normalized = String(input ?? "").trim().toLowerCase();
  return SPRINT_EXECUTION_MODES.has(normalized) ? normalized : null;
}

function normalizeSprintPayloadForApi(input = {}) {
  if (!input || typeof input !== "object") return {};
  const payload = { ...input };
  const rawMode = payload.executionMode ?? payload.taskOrderMode ?? payload.mode;
  if (rawMode != null) {
    const mode = normalizeSprintExecutionMode(rawMode);
    if (!mode) {
      return { error: "executionMode must be one of: sequential, parallel" };
    }
    payload.executionMode = mode;
    payload.taskOrderMode = mode;
  }
  return { payload };
}

function normalizeSprintResponseForApi(sprint) {
  if (!sprint || typeof sprint !== "object") return sprint ?? null;
  const normalized = { ...sprint };
  const mode = normalizeSprintExecutionMode(
    normalized.executionMode ?? normalized.taskOrderMode ?? normalized.mode,
  );
  if (mode) {
    normalized.executionMode = mode;
    normalized.taskOrderMode = mode;
  }
  return normalized;
}

function normalizeSprintListResponseForApi(list) {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => normalizeSprintResponseForApi(entry));
}

function hasTaskPatchValues(patch = {}) {
  for (const value of Object.values(patch)) {
    if (typeof value === "string" && value.trim()) return true;
    if (typeof value === "number" && Number.isFinite(value)) return true;
    if (typeof value === "boolean") return true;
    if (Array.isArray(value) && value.length > 0) return true;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) return true;
  }
  return false;
}

function withTaskMetadataTopLevel(task) {
  if (!task || typeof task !== "object") return task;
  const meta = task?.meta && typeof task.meta === "object" ? task.meta : null;
  if (!meta) return task;

  let next = task;
  const keys = ["assignee", "assignees", "epicId", "storyPoints", "parentTaskId", "dueDate"];
  for (const key of keys) {
    if (meta[key] != null && next[key] !== meta[key]) {
      next = { ...next, [key]: meta[key] };
    }
  }
  if (!next.assignee && Array.isArray(next.assignees) && next.assignees.length > 0) {
    next = { ...next, assignee: next.assignees[0] };
  }
  return next;
}

async function getLatestLogTail(lineCount) {
  return getMergedSystemLogTail(lineCount);
}

function parseSystemLogTimestamp(line) {
  const match = String(line || "").match(/^\s*(\d{4}-\d{2}-\d{2}T[^\s]+)/);
  if (!match?.[1]) return Number.NaN;
  const parsed = Date.parse(match[1]);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

async function getMergedSystemLogTail(
  lineCount,
  {
    fileLimit = 4,
    maxBytesPerFile = 350_000,
  } = {},
) {
  const entries = await listPreferredSystemLogEntries(fileLimit);
  if (!entries.length) {
    return { file: null, files: [], lines: [], truncated: false };
  }

  const perFileLineBudget = Math.max(lineCount * 2, 160);
  const tails = await Promise.all(
    entries.map((entry) => tailFile(entry.path, perFileLineBudget, maxBytesPerFile).catch(() => null)),
  );

  const merged = [];
  let truncated = false;
  tails.forEach((tail, sourceIndex) => {
    if (!tail) return;
    truncated = truncated || tail.truncated === true;
    const lines = Array.isArray(tail.lines) ? tail.lines : [];
    lines.forEach((line, lineIndex) => {
      merged.push({
        line,
        timestamp: parseSystemLogTimestamp(line),
        sourceIndex,
        lineIndex,
      });
    });
  });

  merged.sort((a, b) => {
    const aHasTs = Number.isFinite(a.timestamp);
    const bHasTs = Number.isFinite(b.timestamp);
    if (aHasTs && bHasTs && a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    if (aHasTs !== bHasTs) {
      return aHasTs ? -1 : 1;
    }
    if (a.sourceIndex !== b.sourceIndex) {
      return a.sourceIndex - b.sourceIndex;
    }
    return a.lineIndex - b.lineIndex;
  });

  return {
    file: entries[0]?.name || null,
    files: entries.map((entry) => entry.name),
    lines: merged.slice(-lineCount).map((entry) => entry.line),
    truncated,
  };
}

async function tailFile(filePath, lineCount, maxBytes = 1_000_000) {
  const info = await stat(filePath);
  const size = info.size || 0;
  const start = Math.max(0, size - maxBytes);
  const length = Math.max(0, size - start);
  const handle = await open(filePath, "r");
  const buffer = Buffer.alloc(length);
  try {
    if (length > 0) {
      await handle.read(buffer, 0, length, start);
    }
  } finally {
    await handle.close();
  }
  const text = buffer.toString("utf8");
  const lines = text.split("\n").filter(Boolean);
  const tail = lines.slice(-lineCount);
  return {
    file: filePath,
    lines: tail,
    size,
    truncated: size > maxBytes,
  };
}

async function readJsonlTail(filePath, maxLines = 2000, maxBytes = 1_000_000) {
  if (!existsSync(filePath)) return [];
  const tail = await tailFile(filePath, maxLines, maxBytes);
  return (tail.lines || [])
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getEntryTimestamp(entry) {
  const numericCandidates = [
    entry?.endedAt,
    entry?.startedAt,
  ];
  for (const candidate of numericCandidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const isoCandidates = [
    entry?.timestamp,
    entry?.recordedAt,
    entry?.updatedAt,
    entry?.createdAt,
  ];
  for (const candidate of isoCandidates) {
    const parsed = Date.parse(candidate || "");
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function getEntryDayKey(entry, fallbackTs = Number.NaN) {
  const isoCandidates = [
    entry?.timestamp,
    entry?.recordedAt,
    entry?.updatedAt,
    entry?.createdAt,
  ];
  for (const candidate of isoCandidates) {
    const value = String(candidate || "").trim();
    if (value.length >= 10) return value.slice(0, 10);
  }
  const ts = Number.isFinite(fallbackTs) ? fallbackTs : getEntryTimestamp(entry);
  if (!Number.isFinite(ts)) return "";
  return new Date(ts).toISOString().slice(0, 10);
}

function withinDays(entry, days) {
  if (!days) return true;
  const ts = getEntryTimestamp(entry);
  if (!Number.isFinite(ts)) return true;
  return ts >= Date.now() - days * 24 * 60 * 60 * 1000;
}

async function readCompletedSessionEntries(maxLines = 100_000) {
  // Check multiple candidate paths — repoRoot may be the monorepo root
  // while data lives under the bosun subdirectory.
  const candidates = [
    resolve(repoRoot, ".cache", "session-accumulator.jsonl"),
    resolve(repoRoot, "bosun", ".cache", "session-accumulator.jsonl"),
  ];
  let sessionLogPath = candidates[0];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).size > 0) {
        sessionLogPath = candidate;
        break;
      }
    } catch { /* stat failed, skip */ }
  }
  const entries = await readJsonlTail(sessionLogPath, maxLines, 50_000_000);
  return {
    sessionLogPath,
    entries: entries.filter((entry) => String(entry?.type || "completed_session") === "completed_session"),
  };
}

function roundMetric(value, precision = 6) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Number(numeric.toFixed(precision));
}

const SHREDDING_ESTIMATED_CHARS_PER_TOKEN = 4;

function estimateTokensFromChars(chars) {
  const numeric = Number(chars);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.max(0, Math.round(numeric / SHREDDING_ESTIMATED_CHARS_PER_TOKEN));
}

function summarizeObservedSessionCostModel(entries = []) {
  let totalCostUsd = 0;
  let totalTokens = 0;
  let totalInputTokens = 0;
  let pricedSessions = 0;
  for (const entry of entries) {
    const costUsd = numberOrZero(entry?.costUsd);
    const tokenCount = numberOrZero(entry?.tokenCount);
    const inputTokens = numberOrZero(entry?.inputTokens);
    if (costUsd <= 0 || tokenCount <= 0) continue;
    totalCostUsd += costUsd;
    totalTokens += tokenCount;
    totalInputTokens += inputTokens;
    pricedSessions += 1;
  }
  const blendedCostPerToken = totalCostUsd > 0 && totalTokens > 0
    ? totalCostUsd / totalTokens
    : null;
  return {
    pricedSessions,
    totalCostUsd: roundMetric(totalCostUsd),
    totalTokens,
    totalInputTokens,
    blendedCostPerToken,
    blendedCostPerMillionTokensUsd: blendedCostPerToken != null
      ? roundMetric(blendedCostPerToken * 1_000_000, 4)
      : null,
  };
}

function summarizeTelemetry(metrics, days) {
  const filtered = metrics.filter((m) => withinDays(m, days));
  if (filtered.length === 0) return null;
  const total = filtered.length;
  const success = filtered.filter(
    (m) => m.outcome?.status === "completed" || m.metrics?.success === true,
  ).length;
  const durations = filtered.map((m) => m.metrics?.duration_ms || 0);
  const avgDuration =
    durations.length > 0
      ? Math.round(
          durations.reduce((a, b) => a + b, 0) / durations.length / 1000,
        )
      : 0;
  const totalErrors = filtered.reduce(
    (sum, m) => sum + (m.error_summary?.total_errors || m.metrics?.errors || 0),
    0,
  );
  const executors = {};
  for (const m of filtered) {
    const exec = m.executor || "unknown";
    executors[exec] = (executors[exec] || 0) + 1;
  }
  return {
    total,
    success,
    successRate: total > 0 ? Math.round((success / total) * 100) : 0,
    avgDuration,
    totalErrors,
    executors,
  };
}

const SHREDDING_AGENT_TYPE_LABELS = Object.freeze({
  "codex-sdk": "codex",
  "copilot-sdk": "copilot",
  "claude-sdk": "claude",
});

function normalizeShreddingAgentType(rawType) {
  const normalized = String(rawType || "").trim().toLowerCase();
  if (!normalized) return "unspecified";
  if (SHREDDING_AGENT_TYPE_LABELS[normalized]) {
    return SHREDDING_AGENT_TYPE_LABELS[normalized];
  }
  return normalized;
}

function numberOrZero(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isLikelySyntheticShreddingEvent(event) {
  if (!event || typeof event !== "object") return false;
  const hasContextIds = Boolean(
    String(event.attemptId || "").trim() || String(event.taskId || "").trim(),
  );
  const originalChars = numberOrZero(event.originalChars);
  const compressedChars = numberOrZero(event.compressedChars);
  const savedChars = numberOrZero(event.savedChars);
  const savedPct = numberOrZero(event.savedPct);
  const normalizedAgent = normalizeShreddingAgentType(event.agentType);
  const looksLikeFixturePayload =
    originalChars === 100
    && compressedChars === 50
    && savedChars === 50
    && savedPct === 50;
  const fixtureAgentLabel = normalizedAgent === "first" || normalizedAgent === "latest";
  return !hasContextIds && (looksLikeFixturePayload || fixtureAgentLabel);
}

function isEffectiveShreddingEvent(event) {
  const originalChars = numberOrZero(event?.originalChars);
  const compressedChars = numberOrZero(event?.compressedChars);
  const savedChars = numberOrZero(event?.savedChars);
  return savedChars > 0 && originalChars > compressedChars;
}

// ── Usage Analytics ─────────────────────────────────────────────────────────

/**
 * Build comprehensive usage analytics from agent-work-stream.jsonl.
 * Aggregates agent runs, skill invocations, MCP tool calls, and daily trends.
 *
 * @param {number} [days]  - Look-back window in days; 0 = all time.
 * @returns {Promise<Object>}
 */
async function buildUsageAnalytics(days) {
  const logDir = resolveAgentWorkLogDir();
  const streamPath = resolve(logDir, "agent-work-stream.jsonl");
  const [{ entries: completedSessions }, events] = await Promise.all([
    readCompletedSessionEntries(100_000),
    readJsonlTail(streamPath, 100_000, 50_000_000),
  ]);

  const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;

  let agentRuns = 0;
  let skillInvocations = 0;
  let mcpToolCalls = 0;
  let oldestTs = Infinity;
  let newestTs = 0;

  /** @type {Map<string,number>} */
  const agents = new Map();
  /** @type {Map<string,number>} */
  const skills = new Map();
  /** @type {Map<string,number>} */
  const mcpTools = new Map();

  /** dailyAgents[date][executor] = count */
  const dailyAgents = {};
  /** dailySkills[date][skill] = count */
  const dailySkills = {};
  /** dailyMcp[date][tool] = count */
  const dailyMcp = {};

  const allDates = new Set();

  const sessionWindow = completedSessions.filter((session) => {
    const ts = getEntryTimestamp(session);
    return !cutoff || (Number.isFinite(ts) && ts >= cutoff);
  });

  if (sessionWindow.length > 0) {
    for (const session of sessionWindow) {
      const ts = getEntryTimestamp(session);
      if (!Number.isFinite(ts)) continue;
      if (ts < oldestTs) oldestTs = ts;
      if (ts > newestTs) newestTs = ts;
      const day = getEntryDayKey(session, ts);
      if (day) allDates.add(day);

      agentRuns += 1;
      const exec = String(session.executor || session.model || "unknown").trim() || "unknown";
      agents.set(exec, (agents.get(exec) || 0) + 1);
      if (day) {
        (dailyAgents[day] = dailyAgents[day] || {})[exec] =
          (dailyAgents[day][exec] || 0) + 1;
      }
    }
  }

  let streamSessionStarts = 0;
  for (const e of events) {
    const ts = getEntryTimestamp(e);
    if (!Number.isFinite(ts)) continue;
    if (cutoff && ts < cutoff) continue;
    if (ts < oldestTs) oldestTs = ts;
    if (ts > newestTs) newestTs = ts;
    const day = getEntryDayKey(e, ts);
    if (day) allDates.add(day);

    if (e.event_type === "session_start") {
      streamSessionStarts += 1;
      if (sessionWindow.length === 0) {
        agentRuns++;
        const exec = e.executor || "unknown";
        agents.set(exec, (agents.get(exec) || 0) + 1);
        if (day) {
          (dailyAgents[day] = dailyAgents[day] || {})[exec] =
            (dailyAgents[day][exec] || 0) + 1;
        }
      }
    } else if (e.event_type === "skill_invoke") {
      skillInvocations++;
      const skill = e.data?.skill_name || e.skill_name || "unknown";
      skills.set(skill, (skills.get(skill) || 0) + 1);
      if (day) {
        (dailySkills[day] = dailySkills[day] || {})[skill] =
          (dailySkills[day][skill] || 0) + 1;
      }
    } else if (e.event_type === "tool_call") {
      mcpToolCalls++;
      const tool = e.data?.tool_name || e.tool_name || "unknown";
      mcpTools.set(tool, (mcpTools.get(tool) || 0) + 1);
      if (day) {
        (dailyMcp[day] = dailyMcp[day] || {})[tool] =
          (dailyMcp[day][tool] || 0) + 1;
      }
    }
  }

  const sortedDates = [...allDates].sort();
  const dayCount = sortedDates.length || 1;
  const total = agentRuns + skillInvocations + mcpToolCalls;
  const avgPerDay = Math.round(total / dayCount);

  const topAgents = [...agents.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
  const topSkills = [...skills.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
  const topMcpTools = [...mcpTools.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));

  // Build trend series for top-6 items per category
  const topAgentNames = topAgents.slice(0, 6).map((a) => a.name);
  const topSkillNames = topSkills.slice(0, 6).map((s) => s.name);
  const topMcpNames = topMcpTools.slice(0, 6).map((t) => t.name);

  const trend = { dates: sortedDates, agents: {}, skills: {}, mcpTools: {} };
  for (const name of topAgentNames) {
    trend.agents[name] = sortedDates.map((d) => dailyAgents[d]?.[name] || 0);
  }
  for (const name of topSkillNames) {
    trend.skills[name] = sortedDates.map((d) => dailySkills[d]?.[name] || 0);
  }
  for (const name of topMcpNames) {
    trend.mcpTools[name] = sortedDates.map((d) => dailyMcp[d]?.[name] || 0);
  }

  return {
    agentRuns,
    skillInvocations,
    mcpToolCalls,
    avgPerDay,
    lastActiveAt: newestTs < Infinity && newestTs > 0 ? new Date(newestTs).toISOString() : null,
    sinceAt: oldestTs < Infinity ? new Date(oldestTs).toISOString() : null,
    topAgents,
    topSkills,
    topMcpTools,
    trend,
    diagnostics: {
      agentRunSource: sessionWindow.length > 0 ? "completed_sessions" : "session_start_events",
      completedSessions: sessionWindow.length,
      sessionStarts: streamSessionStarts,
    },
  };
}

function resolveAgentWorkLogDir() {
  const candidates = [
    resolve(repoRoot, ".cache", "agent-work-logs"),
    // When repoRoot is the monorepo root, data lives under bosun/.cache
    resolve(repoRoot, "bosun", ".cache", "agent-work-logs"),
    // Legacy path used by older task-executor builds.
    resolve(repoRoot, "..", "..", ".cache", "agent-work-logs"),
    resolve(repoRoot, "..", ".cache", "agent-work-logs"),
  ];
  // Prefer directories that actually contain data (non-empty stream file).
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const streamFile = resolve(dir, "agent-work-stream.jsonl");
    try {
      if (existsSync(streamFile) && statSync(streamFile).size > 0) return dir;
    } catch { /* stat failed, skip */ }
  }
  // Fall back to first existing directory, then first candidate.
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

async function listAgentLogFiles(query = "", limit = 60) {
  const entries = [];
  const agentLogsDir = await resolveAgentLogsDir();
  const files = await readdir(agentLogsDir).catch(() => []);
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const queryTerms = Array.from(new Set([
    normalizedQuery,
    ...normalizedQuery
      .split(/[^a-z0-9]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3),
  ].filter(Boolean)));

  const scoreAgentLogMatch = (name, lines = []) => {
    if (!queryTerms.length) return 0;
    const fileName = String(name || "").toLowerCase();
    const joined = lines.join("\n").toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (fileName.includes(term)) score += 120;
      if (joined.includes(term)) score += 80;
    }
    if (joined.includes("task id:")) score += 8;
    if (/(error|warn|failed|exception|timeout|anomal)/i.test(joined)) score += 6;
    return score;
  };

  for (const name of files) {
    if (!name.endsWith(".log")) continue;
    try {
      const filePath = resolve(agentLogsDir, name);
      const info = await stat(filePath);
      let score = 0;
      if (queryTerms.length) {
        const sample = await tailFile(filePath, 160, 250_000).catch(() => ({ lines: [] }));
        score = scoreAgentLogMatch(name, sample?.lines || []);
        if (score <= 0) continue;
      }
      entries.push({
        name,
        source: agentLogsDir,
        size: info.size,
        mtime:
          info.mtime?.toISOString?.() || new Date(info.mtime).toISOString(),
        mtimeMs: info.mtimeMs,
        score,
      });
    } catch {
      // ignore
    }
  }
  entries.sort((a, b) => (b.score || 0) - (a.score || 0) || b.mtimeMs - a.mtimeMs);
  return entries.slice(0, limit);
}

function buildLogQueryTerms(query = "") {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return [];
  return Array.from(new Set([
    normalized,
    ...normalized
      .split(/[^a-z0-9]+/i)
      .map((part) => part.trim())
      .filter((part) => part.length >= 3),
  ].filter(Boolean)));
}

function isHighSignalLogLine(line = "") {
  return /(error|warn|failed|exception|timeout|anomal|retry|blocked|fatal)/i.test(String(line || ""));
}

function filterRelevantLogLines(lines = [], query = "", limit = 200) {
  const sourceLines = Array.isArray(lines)
    ? lines.map((line) => String(line || "")).filter(Boolean)
    : [];
  if (!sourceLines.length) return [];

  const terms = buildLogQueryTerms(query);
  if (!terms.length) return sourceLines.slice(-limit);

  const picked = new Set();
  const addWithContext = (index, radius = 1) => {
    for (let cursor = Math.max(0, index - radius); cursor <= Math.min(sourceLines.length - 1, index + radius); cursor += 1) {
      picked.add(cursor);
    }
  };

  sourceLines.forEach((line, index) => {
    const lower = line.toLowerCase();
    const termHit = terms.some((term) => lower.includes(term));
    if (termHit) {
      addWithContext(index, isHighSignalLogLine(line) ? 2 : 1);
      return;
    }
    if (isHighSignalLogLine(line)) {
      addWithContext(index, 1);
    }
  });

  if (!picked.size) {
    return sourceLines.slice(-limit);
  }

  const filtered = [...picked]
    .sort((a, b) => a - b)
    .map((index) => sourceLines[index]);
  return filtered.slice(-limit);
}

async function resolveSessionWorktreePath(session) {
  if (!session || typeof session !== "object") return null;
  const directCandidates = [
    session?.metadata?.worktreePath,
    session?.metadata?.workspaceDir,
    session?.metadata?.workspacePath,
    session?.metadata?.cwd,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  for (const candidate of directCandidates) {
    if (existsSync(candidate)) return candidate;
  }

  const branchHints = [
    session?.metadata?.branch,
    session?.metadata?.branchName,
    session?.branch,
  ]
    .map((value) => String(value || "").trim().replace(/^refs\/heads\//, ""))
    .filter(Boolean);
  const taskHints = [session?.taskId, session?.id]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  try {
    const active = await listActiveWorktrees(repoRoot);
    const matched = (active || []).find((worktree) => {
      const worktreePath = String(worktree?.path || "").trim();
      const worktreeTaskKey = String(worktree?.taskKey || "").trim().toLowerCase();
      const worktreeBranch = String(worktree?.branch || "")
        .trim()
        .replace(/^refs\/heads\//, "");
      if (worktreePath && directCandidates.includes(worktreePath)) return true;
      if (worktreeTaskKey && taskHints.includes(worktreeTaskKey)) return true;
      return branchHints.some((hint) =>
        hint && (worktreeBranch === hint || worktreeBranch.endsWith(`/${hint}`)),
      );
    });
    return matched?.path || null;
  } catch {
    return null;
  }
}

async function ensurePresenceLoaded() {
  const loaded = await loadWorkspaceRegistry().catch(() => null);
  const registry = loaded?.registry || loaded || null;
  const localWorkspace = registry
    ? getLocalWorkspace(registry, process.env.VE_WORKSPACE_ID || "")
    : null;
  await initPresence({ repoRoot, localWorkspace });
}

async function handleApi(req, res, url) {
  const path = url.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Telegram-InitData,X-Bosun-Fallback-Auth",
    });
    res.end();
    return;
  }

  if (path === "/api/auth/fallback/status" && req.method === "GET") {
    jsonResponse(res, 200, {
      ok: true,
      data: {
        fallbackAuth: getFallbackAuthStatus(),
        tunnel: getTunnelStatus(),
      },
    });
    return;
  }

  if (path === "/api/auth/fallback/login" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const secret = String(body?.secret || body?.password || body?.pin || "").trim();
      const attempt = await attemptFallbackAuth(req, secret);
      if (!attempt.ok) {
        jsonResponse(res, 401, {
          ok: false,
          error: "Authentication failed.",
        });
        return;
      }
      res.setHeader("Set-Cookie", buildSessionCookieHeader());
      jsonResponse(res, 200, {
        ok: true,
        tokenIssued: true,
        auth: "fallback",
      });
    } catch {
      jsonResponse(res, 401, {
        ok: false,
        error: "Authentication failed.",
      });
    }
    return;
  }

  const authResult = await requireAuth(req);
  if (!authResult?.ok) {
    jsonResponse(res, 401, {
      ok: false,
      error: "Unauthorized.",
    });
    return;
  }
  if (authResult.issueSessionCookie) {
    res.setHeader("Set-Cookie", buildSessionCookieHeader());
  }

  if (req.method === "POST") {
    // Voice telemetry endpoints (trace, transcript) fire rapidly during active
    // calls and must not be throttled by the standard mutation rate limiter.
    const isVoiceTelemetry =
      path === "/api/voice/trace" || path === "/api/voice/transcript";
    if (isVoiceTelemetry) {
      const voiceTelemetryLimit = isPrivilegedAuthSource(authResult?.source) ? 600 : 120;
      if (!checkRateLimit(req, voiceTelemetryLimit, `voice-telemetry:${authResult?.source || "unknown"}`)) {
        jsonResponse(res, 429, { ok: false, error: "Rate limit exceeded. Try again later." });
        return;
      }
    } else {
      const maxPerMin = getMutationRateLimitPerMin(authResult);
      const rateScope = `post:${authResult?.source || "unknown"}`;
      if (!checkRateLimit(req, maxPerMin, rateScope)) {
        jsonResponse(res, 429, { ok: false, error: "Rate limit exceeded. Try again later." });
        return;
      }
    }
  }
  if (path.startsWith("/api/attachments/") && req.method === "GET") {
    const rel = decodeURIComponent(path.slice("/api/attachments/".length));
    const root = ATTACHMENTS_ROOT;
    const filePath = resolve(root, rel);
    if (!filePath.startsWith(root)) {
      textResponse(res, 403, "Forbidden");
      return;
    }
    if (!existsSync(filePath)) {
      textResponse(res, 404, "Not Found");
      return;
    }
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    try {
      createReadStream(filePath).pipe(res);
    } catch (err) {
      textResponse(res, 500, `Failed to read attachment: ${err.message}`);
    }
    return;
  }
  if (path === "/api/status") {
    const data = await readStatusSnapshot();
    jsonResponse(res, 200, { ok: true, data });
    return;
  }

  if (
    (path === "/api/auth/fallback/set" || path === "/api/auth/fallback/rotate")
    && req.method === "POST"
  ) {
    try {
      const body = await readJsonBody(req);
      const secret = String(body?.secret || body?.password || body?.pin || "").trim();
      const confirm = String(body?.confirm || "").trim();
      if (!secret || (confirm && confirm !== secret)) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Invalid fallback credential payload.",
        });
        return;
      }
      await setFallbackAuthSecret(secret, { actor: "api" });
      jsonResponse(res, 200, {
        ok: true,
        data: getFallbackAuthStatus(),
      });
    } catch (err) {
      jsonResponse(res, 400, {
        ok: false,
        error: err?.message || "Failed to set fallback credential.",
      });
    }
    return;
  }

  if (path === "/api/auth/fallback/reset" && req.method === "POST") {
    resetFallbackAuthSecret();
    jsonResponse(res, 200, {
      ok: true,
      data: getFallbackAuthStatus(),
    });
    return;
  }

  if (path === "/api/executor") {
    const executor = uiDeps.getInternalExecutor?.();
    const mode = uiDeps.getExecutorMode?.() || "internal";
    jsonResponse(res, 200, {
      ok: true,
      data: executor?.getStatus?.() || null,
      mode,
      paused: executor?.isPaused?.() || false,
    });
    return;
  }

  if (path === "/api/triggers/templates") {
    try {
      const data = await getTriggerTemplatePayload();
      jsonResponse(res, 200, { ok: true, data });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/triggers/templates/update") {
    try {
      const body = await readJsonBody(req);
      persistTriggerTemplateUpdate(body || {});
      const data = await getTriggerTemplatePayload();
      jsonResponse(res, 200, { ok: true, data });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "trigger-template-updated",
      });
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/executor/pause") {
    const executor = uiDeps.getInternalExecutor?.();
    if (!executor) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Internal executor not enabled.",
      });
      return;
    }
    executor.pause();
    jsonResponse(res, 200, { ok: true, paused: true });
    broadcastUiEvent(["executor", "overview", "agents"], "invalidate", {
      reason: "executor-paused",
    });
    return;
  }

  if (path === "/api/executor/resume") {
    const executor = uiDeps.getInternalExecutor?.();
    if (!executor) {
      jsonResponse(res, 400, {
        ok: false,
        error: "Internal executor not enabled.",
      });
      return;
    }
    executor.resume();
    jsonResponse(res, 200, { ok: true, paused: false });
    broadcastUiEvent(["executor", "overview", "agents"], "invalidate", {
      reason: "executor-resumed",
    });
    return;
  }

  if (path === "/api/executor/maxparallel") {
    try {
      const executor = uiDeps.getInternalExecutor?.();
      if (!executor) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Internal executor not enabled.",
        });
        return;
      }
      const body = await readJsonBody(req);
      const value = Number(body?.value ?? body?.maxParallel);
      if (!Number.isFinite(value) || value < 0 || value > 20) {
        jsonResponse(res, 400, {
          ok: false,
          error: "value must be between 0 and 20",
        });
        return;
      }
      executor.maxParallel = value;
      if (value === 0) {
        executor.pause();
      } else if (executor.isPaused?.()) {
        executor.resume();
      }
      jsonResponse(res, 200, { ok: true, maxParallel: executor.maxParallel });
      broadcastUiEvent(["executor", "overview", "agents"], "invalidate", {
        reason: "executor-maxparallel",
        maxParallel: executor.maxParallel,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/projects") {
    try {
      const adapter = getKanbanAdapter();
      const projects = await adapter.listProjects();
      jsonResponse(res, 200, { ok: true, data: projects });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/benchmarks" && req.method === "GET") {
    try {
      const providerId = String(
        url.searchParams.get("provider") || url.searchParams.get("type") || "",
      )
        .trim()
        .toLowerCase();
      const snapshot = await buildBenchmarkSnapshot(url, providerId);
      if (!snapshot?.ok) {
        jsonResponse(res, snapshot?.status || 400, {
          ok: false,
          error: snapshot?.error || "Failed to load benchmark status",
        });
        return;
      }
      jsonResponse(res, 200, { ok: true, data: snapshot.data });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/benchmarks/mode" && req.method === "POST") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const requestedWorkspaceId = String(
        body?.workspaceId || url.searchParams.get("workspace") || "",
      ).trim();
      const workspaceContext = requestedWorkspaceId
        ? resolveWorkspaceContextById(requestedWorkspaceId)
        : resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }

      const providerId = String(
        body?.providerId || body?.type || url.searchParams.get("provider") || "",
      )
        .trim()
        .toLowerCase();
      if (body?.enabled !== false && providerId && !getBenchmarkProvider(providerId)) {
        jsonResponse(res, 400, { ok: false, error: `Unknown benchmark provider: ${providerId}` });
        return;
      }

      const modeChange = await applyBenchmarkModeChange({
        workspaceContext,
        providerId,
        body,
        enable: body?.enabled !== false,
      });

      const snapshotUrl = new URL(url.toString());
      if (workspaceContext.workspaceId) {
        snapshotUrl.searchParams.set("workspace", workspaceContext.workspaceId);
      }
      if (providerId) {
        snapshotUrl.searchParams.set("provider", providerId);
      }
      const snapshot = await buildBenchmarkSnapshot(snapshotUrl, providerId);

      jsonResponse(res, 200, {
        ok: true,
        data: {
          mode: modeChange.mode,
          targetRoot: modeChange.targetRoot,
          appliedMaxParallel: modeChange.appliedMaxParallel,
          restoredMaxParallel: modeChange.restoredMaxParallel,
          hold: modeChange.holdResult,
          snapshot: snapshot?.ok ? snapshot.data : null,
        },
      });
      broadcastUiEvent(["benchmarks", "tasks", "executor", "overview", "workflows"], "invalidate", {
        reason: body?.enabled === false ? "benchmark-mode-disabled" : "benchmark-mode-enabled",
        providerId: providerId || modeChange.mode?.providerId || "",
        workspaceId: workspaceContext.workspaceId || "",
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/benchmarks/workspace" && req.method === "POST") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const providerId = String(body?.providerId || body?.type || "").trim().toLowerCase();
      const provider = providerId ? getBenchmarkProvider(providerId) : null;
      if (providerId && !provider) {
        jsonResponse(res, 400, { ok: false, error: `Unknown benchmark provider: ${providerId}` });
        return;
      }

      const configDir = resolveUiConfigDir();
      const workspaceName = String(
        body?.name
          || provider?.workspacePreset?.recommendedWorkspaceName
          || (providerId ? `bench-${providerId}` : "bench"),
      ).trim();
      if (!workspaceName) {
        jsonResponse(res, 400, { ok: false, error: "Workspace name is required" });
        return;
      }

      const reuseExisting = body?.reuseExisting !== false;
      let workspace = null;
      let created = false;
      try {
        workspace = createManagedWorkspace(configDir, {
          name: workspaceName,
          id: body?.id,
        });
        created = true;
      } catch (err) {
        if (!reuseExisting || !String(err?.message || "").includes("already exists")) {
          throw err;
        }
        const existingId = String(body?.id || workspaceName).trim().toLowerCase();
        workspace = listManagedWorkspaces(configDir, { repoRoot }).find((entry) => {
          const entryId = String(entry?.id || "").trim().toLowerCase();
          const entryName = String(entry?.name || "").trim().toLowerCase();
          return entryId === existingId || entryName === workspaceName.toLowerCase();
        }) || null;
        if (!workspace) throw err;
      }

      let repo = null;
      if (body?.repoUrl) {
        repo = addRepoToWorkspace(configDir, workspace.id, {
          url: String(body.repoUrl).trim(),
          name: String(body?.repoName || "").trim() || undefined,
          branch: String(body?.repoBranch || body?.branch || "").trim() || undefined,
          primary: body?.primary !== false,
        });
      }

      if (body?.switchActive !== false) {
        setActiveManagedWorkspace(configDir, workspace.id);
      }

      const resolvedWorkspace = listManagedWorkspaces(configDir, { repoRoot }).find(
        (entry) => String(entry?.id || "").trim() === String(workspace?.id || "").trim(),
      ) || workspace;

      const presetRoot = normalizeCandidatePath(
        body?.repoRoot || repo?.path || resolvedWorkspace?.path || workspace?.path || "",
      );
      const preset =
        provider?.supports?.workspacePreset === true && presetRoot
          ? prepareBenchmarkWorkspacePreset(presetRoot, {
              providerId,
              ensureRuntime: body?.ensureRuntime !== false,
            })
          : null;

      let mode = null;
      if (body?.activateMode === true) {
        const workspaceContext = resolveWorkspaceContextById(workspace.id);
        if (workspaceContext) {
          const modeChange = await applyBenchmarkModeChange({
            workspaceContext,
            providerId,
            body: {
              ...body,
              workspaceId: workspace.id,
              workspaceDir: presetRoot || workspaceContext.workspaceDir,
            },
            enable: true,
          });
          mode = modeChange.mode;
        }
      }

      jsonResponse(res, 200, {
        ok: true,
        data: {
          workspace: resolvedWorkspace,
          created,
          reused: !created,
          switchedActive: body?.switchActive !== false,
          repo,
          preset,
          mode,
        },
      });
      broadcastUiEvent(["workspaces", "library", "workflows", "benchmarks"], "invalidate", {
        reason: "benchmark-workspace-prepared",
        providerId,
        workspaceId: workspace.id,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/benchmarks/run" && req.method === "POST") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const providerId = String(body?.providerId || body?.type || "").trim().toLowerCase();
      if (!providerId) {
        jsonResponse(res, 400, { ok: false, error: "providerId is required" });
        return;
      }
      const provider = getBenchmarkProvider(providerId);
      if (!provider) {
        jsonResponse(res, 400, { ok: false, error: `Unknown benchmark provider: ${providerId}` });
        return;
      }

      const requestedWorkspaceId = String(
        body?.workspaceId || url.searchParams.get("workspace") || "",
      ).trim();
      const workspaceContext = requestedWorkspaceId
        ? resolveWorkspaceContextById(requestedWorkspaceId)
        : resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }

      let preset = null;
      if (body?.prepareWorkspace === true && provider.supports?.workspacePreset === true) {
        preset = prepareBenchmarkWorkspacePreset(workspaceContext.workspaceDir, {
          providerId,
          ensureRuntime: body?.ensureRuntime !== false,
        });
      }

      const launchResult = await launchBenchmark(providerId, body || {});
      let mode = null;
      if (body?.activateMode === true) {
        const modeChange = await applyBenchmarkModeChange({
          workspaceContext,
          providerId,
          body: {
            ...body,
            workspaceId: workspaceContext.workspaceId,
            workspaceDir: workspaceContext.workspaceDir,
          },
          enable: true,
        });
        mode = modeChange.mode;
      }

      const snapshotUrl = new URL(url.toString());
      if (workspaceContext.workspaceId) {
        snapshotUrl.searchParams.set("workspace", workspaceContext.workspaceId);
      }
      snapshotUrl.searchParams.set("provider", providerId);
      const snapshot = await buildBenchmarkSnapshot(snapshotUrl, providerId);

      jsonResponse(res, 200, {
        ok: true,
        data: {
          launch: launchResult,
          preset,
          mode,
          snapshot: snapshot?.ok ? snapshot.data : null,
        },
      });
      broadcastUiEvent(["benchmarks", "tasks", "workflows", "executor"], "invalidate", {
        reason: "benchmark-run-started",
        providerId,
        workspaceId: workspaceContext.workspaceId || "",
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/export") {
    try {
      const adapter = getKanbanAdapter();
      const tasks = await listAllTasksForApi(adapter);
      jsonResponse(res, 200, {
        ok: true,
        data: buildTaskStateExportPayload(tasks, getKanbanBackendName()),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/import" && req.method === "POST") {
    try {
      const backend = getKanbanBackendName();
      if (backend !== "internal") {
        jsonResponse(res, 400, {
          ok: false,
          error: "Task state import is only supported for the internal backend.",
        });
        return;
      }
      const body = await readJsonBody(req, 10_000_000);
      const imported = await importInternalTaskStateSnapshot(body || {});
      jsonResponse(res, 200, { ok: true, data: imported });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-state-imported",
        created: imported.summary?.created || 0,
        updated: imported.summary?.updated || 0,
      });
    } catch (err) {
      jsonResponse(res, 400, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks") {
    const status = url.searchParams.get("status") || "";
    const projectId = url.searchParams.get("project") || "";
    const workspaceQueryRaw = String(url.searchParams.get("workspace") || "").trim();
    let workspaceFilter = workspaceQueryRaw.toLowerCase();
    if (!workspaceFilter || workspaceFilter === "active") {
      const activeWorkspace = getActiveManagedWorkspace(resolveUiConfigDir());
      workspaceFilter = String(activeWorkspace?.id || "").trim().toLowerCase();
    }
    if (workspaceFilter === "*" || workspaceFilter === "all") {
      workspaceFilter = "";
    }
    const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
    const workspaceDirFilter = normalizeCandidatePath(workspaceContext?.workspaceDir);
    const repositoryFilter = (url.searchParams.get("repository") || "").trim().toLowerCase();
    const page = Math.max(0, Number(url.searchParams.get("page") || "0"));
    const pageSize = Math.min(
      50,
      Math.max(5, Number(url.searchParams.get("pageSize") || "15")),
    );
    try {
      const adapter = getKanbanAdapter();
      const projects = await adapter.listProjects();
      const activeProject =
        projectId || projects[0]?.id || projects[0]?.project_id || "";
      if (!activeProject) {
        jsonResponse(res, 200, {
          ok: true,
          data: [],
          page,
          pageSize,
          total: 0,
        });
        return;
      }
      const tasks = await adapter.listTasks(
        activeProject,
        status ? { status } : {},
      );
      const search = (url.searchParams.get("search") || "").trim().toLowerCase();
      const filtered = tasks.filter((task) => {
        const taskWorkspaceRaw = String(
          task.workspace || task.meta?.workspace || "",
        ).trim();
        const taskWorkspace = taskWorkspaceRaw.toLowerCase();
        const taskRepository = String(
          task.repository || task.meta?.repository || "",
        ).trim().toLowerCase();
        if (workspaceFilter && taskWorkspace !== workspaceFilter) {
          // Legacy tasks without workspace stamps are only visible in the
          // primary (first) workspace — not leaked into every workspace.
          if (!taskWorkspaceRaw) {
            const primaryId = resolvePrimaryWorkspaceId();
            if (!primaryId || workspaceFilter === primaryId) {
              return true;
            }
            return false;
          }
          const taskWorkspacePath = normalizeCandidatePath(taskWorkspaceRaw);
          const workspaceMatchByPath =
            Boolean(taskWorkspacePath) &&
            Boolean(workspaceDirFilter) &&
            taskWorkspacePath === workspaceDirFilter;
          if (!workspaceMatchByPath) {
            return false;
          }
        }
        if (repositoryFilter && taskRepository !== repositoryFilter) {
          return false;
        }
        if (!search) return true;
        const hay = [
          task.title || "",
          task.description || "",
          task.id || "",
          taskWorkspace,
          taskRepository,
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(search);
      });
      const total = filtered.length;
      const statusCounts = {
        draft: 0,
        backlog: 0,
        blocked: 0,
        inProgress: 0,
        inReview: 0,
        done: 0,
      };
      for (const task of filtered) {
        const bucket = mapTaskStatusToBoardColumn(task?.status);
        statusCounts[bucket] = (statusCounts[bucket] || 0) + 1;
      }
      const start = page * pageSize;
      const slice = filtered.slice(start, start + pageSize);
      const enriched = await applySharedStateToTasks(slice);
      const withRuntime = enriched.map((task) => withTaskRuntimeSnapshot(task));
      jsonResponse(res, 200, {
        ok: true,
        data: withRuntime,
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        hasMore: start + slice.length < total,
        statusCounts,
        projectId: activeProject,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/detail") {
    try {
      const taskId =
        url.searchParams.get("taskId") || url.searchParams.get("id") || "";
      const includeDagParam = String(url.searchParams.get("includeDag") || "").trim().toLowerCase();
      const includeWorkflowRunsParam = String(url.searchParams.get("includeWorkflowRuns") || "").trim().toLowerCase();
      const includeDag = !["0", "false", "no"].includes(includeDagParam);
      const includeWorkflowRuns = !["0", "false", "no"].includes(includeWorkflowRunsParam);
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const adapter = getKanbanAdapter();
      const task = await adapter.getTask(taskId);
      const enriched = await applySharedStateToTasks(task ? [task] : []);
      let detailTask = enriched[0] || null;
      if (detailTask) {
        const workflowRuns = includeWorkflowRuns
          ? await collectWorkflowRunsForTask(detailTask.id, url, 40)
          : [];
        const mergedWorkflowRuns = includeWorkflowRuns
          ? mergeTaskWorkflowRuns(detailTask.workflowRuns, workflowRuns, 80)
          : Array.isArray(detailTask.workflowRuns)
            ? detailTask.workflowRuns
            : [];
        detailTask.workflowRuns = mergedWorkflowRuns;
        const canStart = await evaluateTaskCanStart({
          taskId: detailTask.id,
          task: detailTask,
          reqUrl: url,
          adapter,
        });
        const supervisor = typeof uiDeps.getAgentSupervisor === "function"
          ? uiDeps.getAgentSupervisor()
          : null;
        const supervisorDiagnostics = typeof supervisor?.getTaskDiagnostics === "function"
          ? supervisor.getTaskDiagnostics(detailTask.id)
          : null;

        const sprintId = resolveTaskSprintId(detailTask);
        const sprintDag = includeDag && sprintId ? await getSprintDagData(sprintId) : null;
        const globalDag = includeDag ? await getGlobalDagData() : null;
        const blockedContext = buildTaskBlockedContext(detailTask, {
          canStart,
          workflowRuns: mergedWorkflowRuns,
          workspaceDir: workspaceContext?.workspaceDir || repoRoot,
        });
        const diagnostics = buildTaskDiagnostics(detailTask, supervisorDiagnostics);

        detailTask.meta = {
          ...(detailTask.meta || {}),
          workflowRuns: mergedWorkflowRuns,
          historyCount: Array.isArray(detailTask.statusHistory) ? detailTask.statusHistory.length : 0,
          timelineCount: Array.isArray(detailTask.timeline) ? detailTask.timeline.length : 0,
          canStart,
          blockedContext,
          ...(diagnostics ? { diagnostics } : {}),
          ...(sprintId ? { sprintId } : {}),
          ...(sprintDag ? { sprintDag: sprintDag.data } : {}),
          ...(globalDag ? { dagOfDags: globalDag.data } : {}),
        };
        if (sprintDag) detailTask.sprintDag = sprintDag.data;
        if (globalDag) detailTask.dagOfDags = globalDag.data;
        detailTask.canStart = canStart;
        detailTask.blockedContext = blockedContext;
        if (diagnostics) detailTask.diagnostics = diagnostics;
        detailTask = withTaskRuntimeSnapshot(detailTask);
      }
      jsonResponse(res, 200, { ok: true, data: detailTask });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Task Execution Plan (resolve + dry-run) ─────────────────────────────
  if (path === "/api/tasks/execution-plan") {
    try {
      const taskId = url.searchParams.get("taskId") || url.searchParams.get("id") || "";
      const adHocTitle = url.searchParams.get("title") || "";
      const adHocDescription = url.searchParams.get("description") || "";

      let task;
      if (taskId) {
        const adapter = getKanbanAdapter();
        task = await adapter.getTask(taskId);
        if (!task) { jsonResponse(res, 404, { ok: false, error: "Task not found" }); return; }
      } else if (adHocTitle) {
        // Ad-hoc mode: create a virtual task from query params for Library resolver
        task = { id: `adhoc-${Date.now()}`, title: adHocTitle, description: adHocDescription, tags: [], status: "todo" };
      } else {
        jsonResponse(res, 400, { ok: false, error: "taskId or title required" }); return;
      }

      const mode = url.searchParams.get("mode") || "resolve"; // "resolve" | "dry-run"
      const wfCtx = await getWorkflowRequestContext(url);
      const engine = wfCtx.ok ? wfCtx.engine : null;

      // Resolve library roots for skill resolution
      let libraryRoots = [];
      let wsCtx = null;
      try {
        wsCtx = resolveWorkspaceContextFromRequest(url, { allowAll: false });
        if (wsCtx) {
          libraryRoots = resolveLibraryRootsForContext(wsCtx);
          ensureLibraryRootsInitialized(libraryRoots);
        }
      } catch { /* best-effort */ }

      let evaluateTaskAssignedTriggerConfig;
      let getNodeType;
      try {
        const wfNodes = await import("../workflow/workflow-nodes.mjs");
        evaluateTaskAssignedTriggerConfig = wfNodes.evaluateTaskAssignedTriggerConfig;
        const wfEngine = await import("../workflow/workflow-engine.mjs");
        getNodeType = wfEngine.getNodeType;
      } catch { /* fallback */ }

      if (!engine) {
        jsonResponse(res, 500, { ok: false, error: "Workflow engine not available" });
        return;
      }

      // ── Build event context ─────────────────────────────────────────────
      const eventData = {
        eventType: "task.assigned",
        taskId: task.id,
        taskTitle: task.title || "",
        task: {
          id: task.id, title: task.title || "",
          description: task.description || "",
          tags: task.tags || [],
          agentType: task.agentType || task.assignedAgentType || "",
          assignedAgentType: task.assignedAgentType || task.agentType || "",
          agentProfile: task.agentProfile || "",
        },
      };

      const allWorkflows = engine.list();
      const fullWorkflows = allWorkflows.map((w) => engine.get(w.id)).filter(Boolean);

      // ── Helper: resolve variables in a config object ──────────────────
      const resolveVarsInConfig = (config, variables, taskCtx) => {
        const merged = { ...variables, ...taskCtx };
        const resolveStr = (s) => {
          if (typeof s !== "string") return s;
          // Exact match preserves type
          const exact = s.match(/^\{\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\}$/);
          if (exact) {
            const v = merged[exact[1]];
            return v != null ? v : s;
          }
          return s.replace(/\{\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\}/g, (match, key) => {
            const v = merged[key];
            return v != null ? String(v) : match;
          });
        };
        const walk = (obj) => {
          if (typeof obj === "string") return resolveStr(obj);
          if (Array.isArray(obj)) return obj.map(walk);
          if (obj && typeof obj === "object") {
            const out = {};
            for (const [k, v] of Object.entries(obj)) out[k] = walk(v);
            return out;
          }
          return obj;
        };
        return walk(config);
      };

      // ── Helper: validate an expression compiles ───────────────────────
      const validateExpression = (expr) => {
        if (!expr || typeof expr !== "string") return { valid: true };
        try {
          // Use safe syntax validation without code compilation.
          // Wrap as arrow-function body and parse with Function.prototype.toString
          // pattern check — no actual compilation of user input.
          const trimmed = expr.trim();
          // Block obviously dangerous patterns
          if (/\b(require|import|process|child_process|eval|Function)\b/.test(trimmed)) {
            return { valid: false, error: "Expression contains disallowed keyword" };
          }
          // Validate it's a syntactically valid JS expression by attempting JSON parse
          // for simple values, or checking balanced parens/brackets for complex ones
          const balanced = (s) => {
            let depth = 0;
            for (const ch of s) {
              if (ch === "(" || ch === "[" || ch === "{") depth++;
              if (ch === ")" || ch === "]" || ch === "}") depth--;
              if (depth < 0) return false;
            }
            return depth === 0;
          };
          if (!balanced(trimmed)) {
            return { valid: false, error: "Unbalanced brackets/parentheses" };
          }
          return { valid: true };
        } catch (e) {
          return { valid: false, error: e.message };
        }
      };

      // ── Helper: find unresolved {{vars}} ──────────────────────────────
      const findUnresolvedVars = (config, variables, wellKnown) => {
        const configStr = JSON.stringify(config ?? {});
        const unresolvedArr = [];
        const rxp = /\{\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\}/g;
        let m;
        while ((m = rxp.exec(configStr)) !== null) {
          const v = m[1];
          if (!variables[v] && variables[v] !== 0 && !wellKnown.has(v)) {
            unresolvedArr.push(v);
          }
        }
        return [...new Set(unresolvedArr)];
      };

      // ── Well-known runtime variables (set by engine/lifecycle) ────────
      const WELL_KNOWN_RUNTIME = new Set([
        "taskId", "taskTitle", "taskDescription", "worktreePath", "branch",
        "baseBranch", "prNumber", "sessionId", "agentId", "resolvedSdk",
        "resolvedModel", "agentProfile", "resolvedSkillIds", "executor",
        "prompt", "ctx", "data", "node", "commitSha", "environment",
        "toStatus", "batchSize", "maxConcurrent",
      ]);

      // ── Helper: resolve library plan for a node ───────────────────────
      const resolveLibraryForNode = async (nd, wf) => {
        const resolveMode = nd.config?.resolveMode || wf.metadata?.resolveMode || "manual";
        if (resolveMode !== "library" || libraryRoots.length === 0) return null;
        try {
          const libMgr = await import("../infra/library-manager.mjs");
          if (typeof libMgr.resolveLibraryPlan !== "function") return null;
          const promptText = nd.config?.prompt || "";
          const criteria = {
            title: (task.title || "") + " " + (nd.label || ""),
            description: (task.description || "") + "\n" + promptText,
            tags: task.tags || [],
          };
          let bestPlan = null;
          for (const rootInfo of libraryRoots) {
            const result = libMgr.resolveLibraryPlan(rootInfo.rootDir, criteria, { topN: 3, skillTopN: 5 });
            if (!result?.best) continue;
            if (!bestPlan || Number(result.best?.score || 0) > Number(bestPlan.best?.score || 0)) {
              bestPlan = result;
            }
          }
          return bestPlan;
        } catch { return null; }
      };

      // ── Helper: build detailed node info ──────────────────────────────
      const buildNodeDetail = async (nd, wf, taskCtx) => {
        const resolvedConfig = resolveVarsInConfig(nd.config || {}, wf.variables || {}, taskCtx);
        const unresolvedVars = findUnresolvedVars(nd.config || {}, { ...(wf.variables || {}), ...taskCtx }, WELL_KNOWN_RUNTIME);

        const detail = {
          id: nd.id,
          type: nd.type,
          label: nd.label || nd.id,
          category: nd.type.split(".")[0],
          typeRegistered: getNodeType ? !!getNodeType(nd.type) : true,
          unresolvedVars: unresolvedVars.length > 0 ? unresolvedVars : undefined,
        };

        // Position info
        if (nd.position) detail.position = nd.position;

        // ── Context flow: what feeds into this node ───────────────────
        const incomingEdges = (wf.edges || []).filter((e) => e.target === nd.id);
        if (incomingEdges.length > 0) {
          detail.inputsFrom = incomingEdges.map((e) => {
            const srcNode = (wf.nodes || []).find((n) => n.id === e.source);
            return {
              nodeId: e.source,
              nodeLabel: srcNode?.label || e.source,
              nodeType: srcNode?.type || "unknown",
              port: e.sourcePort || undefined,
              condition: e.condition || undefined,
            };
          });
        }

        // ── Trigger-specific info ─────────────────────────────────────
        if (nd.type === "trigger.pr_event") {
          detail.isTrigger = true;
          detail.triggerSubtype = "pr_event";
          detail.prEvents = nd.config?.events || ["opened"];
        }
        if (nd.type === "trigger.event") {
          detail.isTrigger = true;
          detail.triggerSubtype = "event";
          detail.eventTypes = nd.config?.eventTypes || nd.config?.events || [];
        }
        if (nd.type === "trigger.schedule") {
          detail.isTrigger = true;
          detail.triggerSubtype = "schedule";
          detail.intervalMs = nd.config?.intervalMs;
        }
        if (nd.type === "trigger.anomaly") {
          detail.isTrigger = true;
          detail.triggerSubtype = "anomaly";
          detail.anomalyTypes = nd.config?.types || [];
        }
        if (nd.type === "trigger.webhook") {
          detail.isTrigger = true;
          detail.triggerSubtype = "webhook";
        }
        if (nd.type === "trigger.workflow_call") {
          detail.isTrigger = true;
          detail.triggerSubtype = "workflow_call";
        }
        if (nd.type === "trigger.manual") {
          detail.isTrigger = true;
          detail.triggerSubtype = "manual";
        }
        // task_assigned / task_available pattern matching
        if (nd.type.startsWith("trigger.") && !detail.isTrigger) {
          detail.isTrigger = true;
        }
        if (nd.config?.taskPattern) {
          detail.taskPattern = nd.config.taskPattern;
          try {
            const rx = new RegExp(nd.config.taskPattern, "i");
            const text = [task.title || "", ...(task.tags || [])].join(" ");
            detail.patternMatches = rx.test(text);
          } catch (e) { detail.patternError = e.message; }
        }

        // ── Condition nodes ───────────────────────────────────────────
        if (nd.type.startsWith("condition.")) {
          detail.isCondition = true;
          if (nd.type === "condition.expression" && nd.config?.expression) {
            const exprCheck = validateExpression(nd.config.expression);
            detail.expression = nd.config.expression;
            detail.expressionValid = exprCheck.valid;
            if (!exprCheck.valid) detail.expressionError = exprCheck.error;
          }
          if (nd.type === "condition.switch" && nd.config?.expression) {
            const swCheck = validateExpression(nd.config.expression);
            detail.expression = nd.config.expression;
            detail.expressionValid = swCheck.valid;
            if (!swCheck.valid) detail.expressionError = swCheck.error;
            detail.cases = nd.config.cases ? Object.keys(nd.config.cases) : [];
          }
        }

        // ── Agent run nodes ───────────────────────────────────────────
        if (nd.type === "action.run_agent") {
          const promptRaw = nd.config?.prompt || "";
          const promptResolved = typeof resolvedConfig.prompt === "string" ? resolvedConfig.prompt : promptRaw;
          const resolveMode = nd.config?.resolveMode || wf.metadata?.resolveMode || "manual";
          detail.isAgentRun = true;
          detail.resolveMode = resolveMode;
          detail.promptRaw = promptRaw;
          detail.promptResolved = promptResolved;
          detail.sdk = resolvedConfig.sdk || "auto";
          detail.model = resolvedConfig.model || "auto";
          detail.timeoutMs = resolvedConfig.timeoutMs || 3600000;
          detail.maxRetries = resolvedConfig.maxRetries ?? 2;
          detail.maxContinues = resolvedConfig.maxContinues ?? 2;
          detail.cwd = resolvedConfig.cwd || "{{worktreePath}}";
          detail.includeTaskContext = resolvedConfig.includeTaskContext !== false;
          // Resolve mode indicator
          detail.resolveMode = nd.config?.resolveMode || "manual";
          // Library resolution
          const libResult = await resolveLibraryForNode(nd, wf);
          if (libResult) {
            detail.resolvedAgent = libResult.plan?.agentName || libResult.best?.name || null;
            detail.resolvedAgentId = libResult.plan?.agentProfileId || libResult.best?.id || null;
            detail.resolvedSkills = (libResult.plan?.selectedSkills || []).map((s) => ({
              id: s.id || s.skillId, name: s.name || s.id || s.skillId,
              score: s.score, source: s.source,
              description: s.description || s.reasons?.join("; ") || "",
              reasons: s.reasons || [],
            }));
            detail.resolvedPromptId = libResult.plan?.prompt?.id || null;
            detail.resolvedPromptName = libResult.plan?.prompt?.name || null;
            detail.resolvedTools = {
              builtin: libResult.plan?.builtinToolIds || [],
              recommended: libResult.plan?.recommendedToolIds || [],
              mcp: libResult.plan?.enabledMcpServers || [],
            };
            detail.confidence = libResult.plan?.confidence || libResult.best?.confidence || 0;
            detail.alternatives = (libResult.alternatives || []).slice(0, 3).map((a) => ({
              id: a.id, name: a.name, confidence: a.confidence,
            }));
          }
          // Context preview: what this agent node will receive
          detail.contextPreview = {
            hasTaskPrompt: (promptRaw || "").includes("{{TaskPrompt}}") || (promptRaw || "").includes("{{taskPrompt}}"),
            hasPreviousOutput: (promptRaw || "").includes("{{previousOutput}}") || (promptRaw || "").includes("{{agentOutput}}"),
            hasWorktreePath: (promptRaw || "").includes("{{worktreePath}}"),
            hasBranchName: (promptRaw || "").includes("{{branchName}}"),
            hasPrUrl: (promptRaw || "").includes("{{prUrl}}") || (promptRaw || "").includes("{{prNumber}}"),
            injectedVariables: unresolvedVars.filter((v) => WELL_KNOWN_RUNTIME.has(v)),
            customVariables: unresolvedVars.filter((v) => !WELL_KNOWN_RUNTIME.has(v)),
          };
        }

        // ── Task prompt builder ───────────────────────────────────────
        if (nd.type === "action.build_task_prompt") {
          detail.isPromptBuilder = true;
          detail.outputVariable = "TaskPrompt";
          detail.includeSkills = resolvedConfig.includeSkills !== false;
          detail.includeAgentInstructions = resolvedConfig.includeAgentInstructions !== false;
        }

        // ── Task status update ────────────────────────────────────────
        if (nd.type === "action.update_task_status") {
          detail.isStatusUpdate = true;
          detail.targetStatus = resolvedConfig.status || resolvedConfig.targetStatus;
        }

        // ── Create PR ─────────────────────────────────────────────────
        if (nd.type === "action.create_pr") {
          detail.isCreatePr = true;
          detail.prTitle = resolvedConfig.title || "{{taskTitle}}";
          detail.prBaseBranch = resolvedConfig.baseBranch || "main";
        }

        // ── Push Branch ───────────────────────────────────────────────
        if (nd.type === "action.push_branch") {
          detail.isPushBranch = true;
        }

        // ── Command nodes ─────────────────────────────────────────────
        if (nd.type === "action.run_command") {
          detail.isCommand = true;
          detail.commandRaw = nd.config?.command || "";
          detail.commandResolved = resolvedConfig.command || "";
          detail.commandCwd = resolvedConfig.cwd || "{{worktreePath}}";
          detail.commandTimeout = resolvedConfig.timeoutMs || 300000;
          detail.failOnError = resolvedConfig.failOnError || false;
        }

        // ── Executor resolver ─────────────────────────────────────────
        if (nd.type === "action.resolve_executor") {
          detail.isResolveExecutor = true;
          detail.sdkOverride = resolvedConfig.sdkOverride || "auto";
          detail.modelOverride = resolvedConfig.modelOverride || "auto";
        }

        // ── Build/test/lint validation nodes ───────────────────────────
        if (nd.type === "validation.build" || nd.type === "validation.tests" || nd.type === "validation.lint") {
          detail.isValidation = true;
          detail.validationType = nd.type.split(".")[1];
          detail.commandRaw = nd.config?.command || "";
          detail.commandResolved = resolvedConfig.command || "";
        }

        // ── Sub-workflow calls ─────────────────────────────────────────
        if (nd.type === "action.execute_workflow" || nd.type === "flow.universal") {
          detail.isSubWorkflow = true;
          detail.targetWorkflowId = resolvedConfig.workflowId || resolvedConfig.childWorkflowId || "";
          detail.inheritContext = resolvedConfig.inheritContext !== false;
        }

        // ── Slot/claim/worktree management ────────────────────────────
        if (["action.allocate_slot", "action.release_slot"].includes(nd.type)) detail.isSlotMgmt = true;
        if (["action.claim_task", "action.release_claim"].includes(nd.type)) detail.isClaimMgmt = true;
        if (["action.acquire_worktree", "action.release_worktree"].includes(nd.type)) detail.isWorktreeMgmt = true;
        if (nd.type === "action.push_branch") detail.isPushBranch = true;
        if (nd.type === "action.create_pr") detail.isCreatePR = true;
        if (nd.type === "action.detect_new_commits") detail.isDetectCommits = true;

        // ── Notification nodes ────────────────────────────────────────
        if (nd.type.startsWith("notify.")) {
          detail.isNotify = true;
          if (nd.type === "notify.log") detail.logMessage = resolvedConfig.message || resolvedConfig.text || "";
        }

        // ── Flow control ──────────────────────────────────────────────
        if (nd.type === "flow.join") detail.joinMode = resolvedConfig.mode || "all";
        if (nd.type === "flow.end") detail.isFlowEnd = true;
        if (nd.type === "flow.gate") detail.isGate = true;

        return detail;
      };

      // ── Helper: build edge details with validation ────────────────────
      const buildEdgeDetail = (edge) => {
        const detail = {
          id: edge.id || `${edge.source}->${edge.target}`,
          source: edge.source,
          target: edge.target,
        };
        if (edge.sourcePort) detail.sourcePort = edge.sourcePort;
        if (edge.backEdge) detail.isBackEdge = true;
        if (edge.condition) {
          detail.condition = edge.condition;
          const check = validateExpression(edge.condition);
          detail.conditionValid = check.valid;
          if (!check.valid) detail.conditionError = check.error;
        }
        return detail;
      };

      // ── Build stages from matching workflows ──────────────────────────
      const stages = [];
      const validationIssues = [];

      // Task context for variable resolution preview
      const taskCtx = {
        taskId: task.id, taskTitle: task.title || "", taskDescription: task.description || "",
        worktreePath: `<worktree>/${task.id}`, branch: `feat/${task.id}`,
        baseBranch: "main", resolvedSdk: "auto", resolvedModel: "auto",
        agentProfile: "", sessionId: `session-${task.id}`,
      };

      // ── Phase 1: task_assigned workflows ──────────────────────────────
      for (const wf of fullWorkflows) {
        if (wf.enabled === false) continue;
        const triggerNodes = (wf.nodes || []).filter((n) => n.type === "trigger.task_assigned");
        if (triggerNodes.length === 0) continue;

        let matched = false;
        let matchedTrigger = null;
        for (const tNode of triggerNodes) {
          if (evaluateTaskAssignedTriggerConfig) {
            matched = evaluateTaskAssignedTriggerConfig(tNode.config || {}, eventData);
          } else {
            const pattern = tNode.config?.taskPattern;
            if (pattern) {
              try { matched = new RegExp(pattern, "i").test([task.title || "", ...(task.tags || [])].join(" ")); }
              catch { matched = false; }
            } else { matched = true; }
          }
          if (matched) { matchedTrigger = tNode; break; }
        }
        if (!matched) continue;

        // Build node map and edge adjacency
        const nodeMap = new Map((wf.nodes || []).map((n) => [n.id, n]));
        const edgesBySource = new Map();
        const edgesByTarget = new Map();
        for (const e of (wf.edges || [])) {
          if (!edgesBySource.has(e.source)) edgesBySource.set(e.source, []);
          edgesBySource.get(e.source).push(e);
          if (!edgesByTarget.has(e.target)) edgesByTarget.set(e.target, []);
          edgesByTarget.get(e.target).push(e);
        }

        // BFS from trigger to build ordered node list
        const orderedNodes = [];
        const visited = new Set();
        const queue = matchedTrigger?.id ? [matchedTrigger.id] : [];
        while (queue.length > 0) {
          const nid = queue.shift();
          if (visited.has(nid)) continue;
          visited.add(nid);
          const nd = nodeMap.get(nid);
          if (!nd) continue;
          orderedNodes.push(await buildNodeDetail(nd, wf, taskCtx));
          for (const e of (edgesBySource.get(nid) || [])) {
            if (!visited.has(e.target) && !e.backEdge) queue.push(e.target);
          }
        }

        // Build edge details
        const edgeDetails = (wf.edges || []).map(buildEdgeDetail);

        // Validate: orphan nodes (not reachable from trigger)
        const orphanNodes = (wf.nodes || [])
          .filter((n) => !visited.has(n.id))
          .map((n) => n.id);
        if (orphanNodes.length > 0) {
          validationIssues.push({
            workflowId: wf.id, workflowName: wf.name, level: "warning",
            message: `${orphanNodes.length} node(s) not reachable from trigger: ${orphanNodes.join(", ")}`,
          });
        }

        // Validate: edge condition syntax
        for (const ed of edgeDetails) {
          if (ed.conditionValid === false) {
            validationIssues.push({
              workflowId: wf.id, workflowName: wf.name, level: "error",
              message: `Edge ${ed.source}→${ed.target} has invalid condition: ${ed.conditionError}`,
            });
          }
        }

        // Validate: expression nodes
        for (const nd of orderedNodes) {
          if (nd.expressionValid === false) {
            validationIssues.push({
              workflowId: wf.id, workflowName: wf.name, level: "error",
              message: `Node "${nd.id}" has invalid expression: ${nd.expressionError}`,
            });
          }
          if (!nd.typeRegistered) {
            validationIssues.push({
              workflowId: wf.id, workflowName: wf.name, level: "error",
              message: `Node "${nd.id}" uses unregistered type: "${nd.type}"`,
            });
          }
          if (nd.unresolvedVars?.length > 0) {
            validationIssues.push({
              workflowId: wf.id, workflowName: wf.name, level: "warning",
              message: `Node "${nd.id}" has unresolved variables: ${nd.unresolvedVars.join(", ")}`,
            });
          }
        }

        stages.push({
          workflowId: wf.id, workflowName: wf.name, category: wf.category,
          core: wf.core === true, trigger: wf.trigger, matchType: "task_assigned",
          description: wf.description || "",
          variables: wf.variables || {},
          nodeCount: orderedNodes.length, edgeCount: edgeDetails.length,
          agentRunCount: orderedNodes.filter((n) => n.isAgentRun).length,
          nodes: orderedNodes, edges: edgeDetails,
        });
      }

      // ── Phase 2: task_available workflows (polling/lifecycle) ──────────
      for (const wf of fullWorkflows) {
        if (wf.enabled === false) continue;
        if ((wf.nodes || []).every((n) => n.type !== "trigger.task_available")) continue;
        if (stages.some((s) => s.workflowId === wf.id)) continue;

        const nodeMap = new Map((wf.nodes || []).map((n) => [n.id, n]));
        const edgesBySource = new Map();
        for (const e of (wf.edges || [])) {
          if (!edgesBySource.has(e.source)) edgesBySource.set(e.source, []);
          edgesBySource.get(e.source).push(e);
        }

        // BFS from trigger(s)
        const triggerIds = (wf.nodes || []).filter((n) => n.type.startsWith("trigger.")).map((n) => n.id);
        const orderedNodes = [];
        const visited = new Set();
        const queue = [...triggerIds];
        while (queue.length > 0) {
          const nid = queue.shift();
          if (visited.has(nid)) continue;
          visited.add(nid);
          const nd = nodeMap.get(nid);
          if (!nd) continue;
          orderedNodes.push(await buildNodeDetail(nd, wf, taskCtx));
          for (const e of (edgesBySource.get(nid) || [])) {
            if (!visited.has(e.target) && !e.backEdge) queue.push(e.target);
          }
        }

        const edgeDetails = (wf.edges || []).map(buildEdgeDetail);

        stages.push({
          workflowId: wf.id, workflowName: wf.name, category: wf.category,
          core: wf.core === true, trigger: wf.trigger || "trigger.task_available",
          matchType: "polling",
          description: wf.description || "",
          variables: wf.variables || {},
          nodeCount: orderedNodes.length, edgeCount: edgeDetails.length,
          agentRunCount: orderedNodes.filter((n) => n.isAgentRun).length,
          nodes: orderedNodes, edges: edgeDetails,
        });
      }

      // ── Phase 3: related workflows triggered by task lifecycle events ──
      // Only include workflows whose triggers can ACTUALLY fire as a direct
      // or indirect result of a task's lifecycle (not schedules/manual/cron).
      const TASK_LIFECYCLE_EVENT_TYPES = new Set([
        "task.failed", "task.completed", "task.status_changed",
        "task.transition.requested", "task.finalization_failed",
        "pr.conflict_detected",
      ]);
      for (const wf of fullWorkflows) {
        if (wf.enabled === false) continue;
        if (stages.some((s) => s.workflowId === wf.id)) continue;
        const allNodes = wf.nodes || [];

        // Filter to triggers that genuinely fire during task lifecycle
        const relatedTriggers = allNodes.filter((n) => {
          if (n.type === "trigger.pr_event") return true; // PR events from task PRs
          if (n.type === "trigger.event") {
            const evType = n.config?.eventType;
            return evType && TASK_LIFECYCLE_EVENT_TYPES.has(evType);
          }
          if (n.type === "trigger.anomaly") return true; // agent anomalies during task
          return false;
        });
        if (relatedTriggers.length === 0) continue;

        // Secondary check: workflow must contain task-related action nodes
        const hasTaskNodes = allNodes.some((n) =>
          n.type === "action.run_agent" || n.type === "action.update_task_status" ||
          n.type === "action.claim_task" || n.type === "action.build_task_prompt" ||
          n.type === "action.create_pr" || n.type === "action.push_branch" ||
          n.type === "action.run_command" || n.type === "validation.build" ||
          n.type === "validation.tests" || n.type === "validation.lint"
        );
        if (!hasTaskNodes) continue;

        const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
        const edgesBySource = new Map();
        for (const e of (wf.edges || [])) {
          if (!edgesBySource.has(e.source)) edgesBySource.set(e.source, []);
          edgesBySource.get(e.source).push(e);
        }

        const triggerIds = relatedTriggers.map((n) => n.id);
        const orderedNodes = [];
        const visited = new Set();
        const queue = [...triggerIds];
        while (queue.length > 0) {
          const nid = queue.shift();
          if (visited.has(nid)) continue;
          visited.add(nid);
          const nd = nodeMap.get(nid);
          if (!nd) continue;
          orderedNodes.push(await buildNodeDetail(nd, wf, taskCtx));
          for (const e of (edgesBySource.get(nid) || [])) {
            if (!visited.has(e.target) && !e.backEdge) queue.push(e.target);
          }
        }

        const edgeDetails = (wf.edges || []).map(buildEdgeDetail);
        const triggerType = relatedTriggers[0]?.type || "related";

        stages.push({
          workflowId: wf.id, workflowName: wf.name, category: wf.category,
          core: wf.core === true, trigger: wf.trigger || triggerType,
          matchType: triggerType.replace("trigger.", ""),
          description: wf.description || "",
          variables: wf.variables || {},
          nodeCount: orderedNodes.length, edgeCount: edgeDetails.length,
          agentRunCount: orderedNodes.filter((n) => n.isAgentRun).length,
          nodes: orderedNodes, edges: edgeDetails,
        });
      }

      // ── Dry-run simulation ────────────────────────────────────────────
      let dryRunResults = null;
      if (mode === "dry-run") {
        dryRunResults = [];
        for (const stage of stages) {
          const wf = engine.get(stage.workflowId);
          if (!wf) continue;
          const simResult = { workflowId: stage.workflowId, workflowName: stage.workflowName, nodes: [] };
          try {
            // Use the engine's dryRun mode
            const ctx = await engine.execute(stage.workflowId, {
              ...taskCtx,
              ...(wf.variables || {}),
              _dryRunSimulation: true,
            }, { dryRun: true, force: true });

            // Extract per-node results from context
            const nodeStatuses = ctx?.nodeStatuses || ctx?.data?._nodeStatuses || new Map();
            const nodeOutputs = ctx?.nodeOutputs || ctx?.data?._nodeOutputs || new Map();
            for (const nd of stage.nodes) {
              const status = nodeStatuses instanceof Map ? nodeStatuses.get(nd.id) : nodeStatuses?.[nd.id];
              const output = nodeOutputs instanceof Map ? nodeOutputs.get(nd.id) : nodeOutputs?.[nd.id];
              simResult.nodes.push({
                id: nd.id, status: status || "simulated",
                output: output?._dryRun ? { dryRun: true, type: output.type } : undefined,
              });
            }
            simResult.status = "completed";
          } catch (err) {
            simResult.status = "error";
            simResult.error = err.message;
            // Even partial results are useful
            if (err.message?.includes("Missing capability")) {
              simResult.missingCapability = err.message;
            }
          }
          dryRunResults.push(simResult);
        }
      }

      // ── Sort and respond ──────────────────────────────────────────────
      stages.sort((a, b) => {
        if (a.core !== b.core) return a.core ? -1 : 1;
        const matchOrder = { polling: 0, task_assigned: 1 };
        const aOrd = matchOrder[a.matchType] ?? 1;
        const bOrd = matchOrder[b.matchType] ?? 1;
        if (aOrd !== bOrd) return aOrd - bOrd;
        return (a.workflowName || "").localeCompare(b.workflowName || "");
      });

      jsonResponse(res, 200, {
        ok: true,
        mode,
        taskId: task.id,
        taskTitle: task.title || "",
        taskDescription: (task.description || "").slice(0, 500),
        taskTags: task.tags || [],
        stages,
        stageCount: stages.length,
        agentRunTotal: stages.reduce((sum, s) => sum + (s.agentRunCount || 0), 0),
        validationIssues: validationIssues.length > 0 ? validationIssues : undefined,
        dryRunResults: dryRunResults || undefined,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/sprints" && req.method === "GET") {
    try {
      const list = await callTaskStoreFunction(TASK_STORE_SPRINT_EXPORTS.list, []);
      if (!list.found) {
        jsonResponse(res, 501, { ok: false, error: "Sprint APIs are unavailable." });
        return;
      }
      const sprintList = normalizeSprintListResponseForApi(list.value || []);
      jsonResponse(res, 200, { ok: true, source: `task-store.${list.found}`, data: sprintList });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/sprints" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const normalized = normalizeSprintPayloadForApi(body || {});
      if (normalized.error) {
        jsonResponse(res, 400, { ok: false, error: normalized.error });
        return;
      }
      const create = await callTaskStoreFunction(TASK_STORE_SPRINT_EXPORTS.create, [normalized.payload || {}]);
      if (!create.found) {
        jsonResponse(res, 501, { ok: false, error: "Sprint create API is unavailable." });
        return;
      }
      const sprint = normalizeSprintResponseForApi(create.value || null);
      jsonResponse(res, 200, { ok: true, source: `task-store.${create.found}`, data: sprint });
      broadcastUiEvent(["tasks", "overview"], "invalidate", { reason: "sprint-created" });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/tasks/sprints/") && path.endsWith("/dag") && req.method === "GET") {
    try {
      const sprintId = decodeURIComponent(path.slice("/api/tasks/sprints/".length, -"/dag".length));
      if (!sprintId) {
        jsonResponse(res, 400, { ok: false, error: "sprintId required" });
        return;
      }
      const sprintDag = await getSprintDagData(sprintId);
      if (!sprintDag) {
        jsonResponse(res, 501, { ok: false, error: "Sprint DAG API is unavailable." });
        return;
      }
      const sprintResult = await callTaskStoreFunction(TASK_STORE_SPRINT_EXPORTS.get, [sprintId]);
      const sprint = sprintResult.found ? normalizeSprintResponseForApi(sprintResult.value || null) : null;
      jsonResponse(res, 200, { ok: true, sprintId, source: sprintDag.source, sprint, data: sprintDag.data });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/tasks/sprints/") && path.endsWith("/tasks") && req.method === "POST") {
    try {
      const sprintId = decodeURIComponent(path.slice("/api/tasks/sprints/".length, -"/tasks".length));
      const body = await readJsonBody(req);
      const taskId = String(body?.taskId || body?.id || "").trim();
      if (!sprintId) {
        jsonResponse(res, 400, { ok: false, error: "sprintId required" });
        return;
      }
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }

      const adapter = getKanbanAdapter();
      const assigned = await assignTaskToSprintForApi({
        taskId,
        sprintId,
        sprintOrder: body?.sprintOrder,
        adapter,
      });
      if (!assigned.ok) {
        jsonResponse(res, 400, { ok: false, error: assigned.error || "Unable to assign task to sprint" });
        return;
      }

      jsonResponse(res, 200, {
        ok: true,
        taskId,
        sprintId,
        assignedVia: assigned.assignedVia,
        data: assigned.data,
        dag: {
          sprint: assigned.dag?.sprint?.data || null,
          global: assigned.dag?.global?.data || null,
        },
      });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-sprint-assigned",
        taskId,
        sprintId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/tasks/sprints/") && req.method === "GET") {
    try {
      const sprintId = decodeURIComponent(path.slice("/api/tasks/sprints/".length));
      if (!sprintId) {
        jsonResponse(res, 400, { ok: false, error: "sprintId required" });
        return;
      }
      const getResult = await callTaskStoreFunction(TASK_STORE_SPRINT_EXPORTS.get, [sprintId]);
      if (!getResult.found) {
        jsonResponse(res, 501, { ok: false, error: "Sprint get API is unavailable." });
        return;
      }
      const sprint = normalizeSprintResponseForApi(getResult.value || null);
      jsonResponse(res, 200, { ok: true, source: `task-store.${getResult.found}`, data: sprint });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/tasks/sprints/") && (req.method === "PATCH" || req.method === "PUT")) {
    try {
      const sprintId = decodeURIComponent(path.slice("/api/tasks/sprints/".length));
      const body = await readJsonBody(req);
      if (!sprintId) {
        jsonResponse(res, 400, { ok: false, error: "sprintId required" });
        return;
      }
      const normalized = normalizeSprintPayloadForApi(body || {});
      if (normalized.error) {
        jsonResponse(res, 400, { ok: false, error: normalized.error });
        return;
      }
      const update = await callTaskStoreFunction(TASK_STORE_SPRINT_EXPORTS.update, [sprintId, normalized.payload || {}]);
      if (!update.found) {
        jsonResponse(res, 501, { ok: false, error: "Sprint update API is unavailable." });
        return;
      }
      const sprint = normalizeSprintResponseForApi(update.value || null);
      jsonResponse(res, 200, { ok: true, source: `task-store.${update.found}`, data: sprint });
      broadcastUiEvent(["tasks", "overview"], "invalidate", { reason: "sprint-updated", sprintId });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/tasks/sprints/") && req.method === "DELETE") {
    try {
      const sprintId = decodeURIComponent(path.slice("/api/tasks/sprints/".length));
      if (!sprintId) {
        jsonResponse(res, 400, { ok: false, error: "sprintId required" });
        return;
      }
      const removed = await callTaskStoreFunction(TASK_STORE_SPRINT_EXPORTS.remove, [sprintId]);
      if (!removed.found) {
        jsonResponse(res, 501, { ok: false, error: "Sprint delete API is unavailable." });
        return;
      }
      jsonResponse(res, 200, { ok: true, source: `task-store.${removed.found}`, data: removed.value ?? true });
      broadcastUiEvent(["tasks", "overview"], "invalidate", { reason: "sprint-deleted", sprintId });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/dag" && req.method === "GET") {
    try {
      const sprintId = String(
        url.searchParams.get("sprintId")
          || url.searchParams.get("sprint")
          || "",
      ).trim();
      const sprintDag = await getSprintDagData(sprintId || null);
      if (!sprintDag) {
        jsonResponse(res, 501, { ok: false, error: "Sprint DAG API is unavailable." });
        return;
      }
      const sprint = sprintDag.sprintId
        ? await callTaskStoreFunction(TASK_STORE_SPRINT_EXPORTS.get, [sprintDag.sprintId])
        : { found: null, value: null };
      jsonResponse(res, 200, {
        ok: true,
        sprintId: sprintDag.sprintId,
        source: sprintDag.source,
        sprint: sprint.found ? normalizeSprintResponseForApi(sprint.value || null) : null,
        data: sprintDag.data,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/dag-of-dags" && req.method === "GET") {
    try {
      const globalDag = await getGlobalDagData();
      if (!globalDag) {
        jsonResponse(res, 501, { ok: false, error: "Global DAG API is unavailable." });
        return;
      }
      jsonResponse(res, 200, { ok: true, source: globalDag.source, data: globalDag.data });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/dag/organize" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const sprintId = String(body?.sprintId || body?.sprint || "").trim();
      const organizeOptions = {
        ...(sprintId ? { sprintId } : {}),
        ...(body?.applyDependencySuggestions != null
          ? { applyDependencySuggestions: Boolean(body.applyDependencySuggestions) }
          : {}),
        ...(body?.syncEpicDependencies != null
          ? { syncEpicDependencies: Boolean(body.syncEpicDependencies) }
          : {}),
      };
      const organized = await organizeDagData(organizeOptions);
      if (!organized) {
        jsonResponse(res, 501, { ok: false, error: "DAG organize API is unavailable." });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        sprintId: sprintId || null,
        source: organized.source,
        data: organized.data,
        suggestions: Array.isArray(organized.data?.suggestions) ? organized.data.suggestions : [],
      });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "dag-organized",
        sprintId: sprintId || null,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }
  if (path === "/api/tasks/attachments/upload" && req.method === "POST") {
    try {
      const { fields, files } = await readMultipartForm(req);
      const taskId = String(fields?.taskId || fields?.id || "").trim();
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      if (!files.length) {
        jsonResponse(res, 400, { ok: false, error: "file required" });
        return;
      }

      const adapter = getKanbanAdapter();
      let task = null;
      try {
        task = await adapter.getTask(taskId);
      } catch {
        task = null;
      }
      const backend =
        String(fields?.backend || task?.backend || adapter?.name || "internal")
          .trim()
          .toLowerCase();

      const safeTask = sanitizePathSegment(taskId);
      const safeBackend = sanitizePathSegment(backend || "internal");
      const targetDir = resolve(ATTACHMENTS_ROOT, "tasks", safeBackend, safeTask);
      mkdirSync(targetDir, { recursive: true });

      const added = [];
      for (const file of files) {
        const originalName = file.filename || "attachment";
        const ext = extname(originalName).toLowerCase();
        const base = sanitizePathSegment(basename(originalName, ext)) || "attachment";
        const unique = `${Date.now()}-${randomBytes(4).toString("hex")}`;
        const storedName = `${base}-${unique}${ext}`;
        const filePath = resolve(targetDir, storedName);
        writeFileSync(filePath, file.data);
        const relPath = relative(ATTACHMENTS_ROOT, filePath);
        const contentType =
          file.contentType || MIME_TYPES[ext] || "application/octet-stream";
        const kind =
          contentType.startsWith("image/") ||
          [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)
            ? "image"
            : "file";
        const attachment = {
          name: originalName,
          filePath,
          relativePath: relPath,
          url: resolveAttachmentUrl(relPath),
          size: file.data.length,
          contentType,
          kind,
          source: "upload",
          sourceType: "task",
          createdAt: new Date().toISOString(),
        };
        const stored = addTaskAttachment(taskId, backend, attachment);
        if (stored) added.push(stored);
      }

      let taskAfter = null;
      try {
        taskAfter = await adapter.getTask(taskId);
      } catch {
        taskAfter = null;
      }
      const existing = []
        .concat(Array.isArray(taskAfter?.attachments) ? taskAfter.attachments : [])
        .concat(Array.isArray(taskAfter?.meta?.attachments) ? taskAfter.meta.attachments : []);
      const merged = mergeTaskAttachments(
        existing,
        listTaskAttachments(taskId, backend),
      );
      jsonResponse(res, 200, { ok: true, taskId, backend, added, attachments: merged });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-attachment-upload",
        taskId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/dependencies" && req.method === "PUT") {
    try {
      const body = await readJsonBody(req);
      const taskId = String(body?.taskId || body?.id || "").trim();
      const dependencies = Array.isArray(body?.dependencies) ? body.dependencies : [];
      const sprintId = String(body?.sprintId || body?.sprint || "").trim();
      const sprintOrder = body?.sprintOrder;

      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }

      const adapter = getKanbanAdapter();
      const result = await setTaskDependenciesForApi({
        taskId,
        dependencies,
        sprintId,
        sprintOrder,
        adapter,
      });
      if (!result.ok) {
        jsonResponse(res, result.status || 400, { ok: false, error: result.error || "Failed to set dependencies." });
        return;
      }

      jsonResponse(res, 200, {
        ok: true,
        taskId,
        dependencies: result.dependencies,
        added: result.added,
        removed: result.removed,
        data: result.data,
        dag: {
          sprintId: result.dag?.sprintId || null,
          sprint: result.dag?.sprint?.data || null,
          global: result.dag?.global?.data || null,
        },
      });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-dependencies-updated",
        taskId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }
  if (path === "/api/tasks/epic-dependencies" && req.method === "GET") {
    try {
      const listed = await listEpicDependenciesForApi();
      if (!listed.ok) {
        jsonResponse(res, 501, { ok: false, error: "Epic dependency APIs are unavailable." });
        return;
      }
      jsonResponse(res, 200, { ok: true, source: listed.source, data: listed.data });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/epic-dependencies" && req.method === "PUT") {
    try {
      const body = await readJsonBody(req);
      const epicId = String(body?.epicId || body?.id || "").trim();
      const dependencies = Array.isArray(body?.dependencies)
        ? body.dependencies
        : Array.isArray(body?.dependsOn)
          ? body.dependsOn
          : [];
      if (!epicId) {
        jsonResponse(res, 400, { ok: false, error: "epicId required" });
        return;
      }
      const updated = await setEpicDependenciesForApi({ epicId, dependencies });
      if (!updated.ok) {
        jsonResponse(res, updated.status || 400, { ok: false, error: updated.error || "Failed to update epic dependencies" });
        return;
      }
      const globalDag = await getGlobalDagData();
      jsonResponse(res, 200, {
        ok: true,
        source: updated.source,
        data: updated.data,
        dag: globalDag?.data || null,
      });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "epic-dependencies-updated",
        epicId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/start") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      const sdk = typeof body?.sdk === "string" ? body.sdk.trim() : "";
      const model = typeof body?.model === "string" ? body.model.trim() : "";
      const forceStart = body?.force === true || body?.forceStart === true;
      const manualOverride = body?.manualOverride === true || body?.overrideStartGuard === true;
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId is required" });
        return;
      }
      const executor = uiDeps.getInternalExecutor?.();
      if (!executor) {
        jsonResponse(res, 400, {
          ok: false,
          error:
            "Internal executor not enabled. Set EXECUTOR_MODE=internal or hybrid.",
        });
        return;
      }
      const adapter = getKanbanAdapter();
      const task = await adapter.getTask(taskId);
      if (!task) {
        jsonResponse(res, 404, { ok: false, error: "Task not found." });
        return;
      }

      const canStart = await evaluateTaskCanStart({
        taskId,
        task,
        adapter,
        forceStart,
        manualOverride,
      });
      if (!canStart.canStart) {
        jsonResponse(res, 409, {
          ok: false,
          taskId,
          error: "Task cannot be started",
          canStart,
        });
        return;
      }

      const status = executor.getStatus?.() || {};
      const freeSlots =
        (status.maxParallel || 0) - (status.activeSlots || 0);

      if (freeSlots <= 0) {
        const queuedTask = await persistTaskExecutionMeta(adapter, taskId, {
          queued: true,
          queueState: "queued",
          requestedAt: new Date().toISOString(),
        });
        jsonResponse(res, 202, {
          ok: true,
          taskId,
          queued: true,
          started: false,
          reason: "No free slots",
          canStart,
          data: withTaskRuntimeSnapshot(queuedTask || task),
        });
        broadcastUiEvent(
          ["tasks", "overview", "executor", "agents"],
          "invalidate",
          {
            reason: "task-queued",
            taskId,
          },
        );
        return;
      }
      let startedTask = task;
      try {
        startedTask = await persistTaskStatusForExecution(adapter, taskId, "inprogress", "api.tasks.start") || task;
        startedTask = await persistTaskExecutionMeta(adapter, taskId, {
          queued: false,
          queueState: null,
        }) || startedTask;
        applyInternalLifecycleTransition(taskId, "start", {
          source: "api.tasks.start",
          actor: "ui",
          force: forceStart || manualOverride,
          reason: "manual start",
        });
      } catch (err) {
        console.warn(
          `[telegram-ui] failed to mark task ${taskId} inprogress: ${err.message}`,
        );
      }

      const wasPaused = executor.isPaused?.();
      executor.executeTask(startedTask, {
        ...(sdk ? { sdk } : {}),
        ...(model ? { model } : {}),
        force: forceStart || manualOverride,
      }).catch((error) => {
        console.warn(
          `[telegram-ui] failed to execute task ${taskId}: ${error.message}`,
        );
        void persistTaskStatusForExecution(
          adapter,
          taskId,
          resolveFallbackStatusAfterFailedDispatch(task?.status, { started: false }),
          "api.tasks.start.failed",
        );
        broadcastUiEvent(["tasks", "overview", "executor", "agents"], "invalidate", {
          reason: "task-start-failed",
          taskId,
        });
      });
      jsonResponse(res, 200, {
        ok: true,
        taskId,
        queued: false,
        started: true,
        wasPaused,
        canStart,
        data: withTaskRuntimeSnapshot(startedTask),
      });
      broadcastUiEvent(
        ["tasks", "overview", "executor", "agents"],
        "invalidate",
        {
          reason: "task-started",
          taskId,
        },
      );
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/update") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const forceStart = body?.force === true || body?.forceStart === true;
      const manualOverride = body?.manualOverride === true || body?.overrideStartGuard === true;
      const adapter = getKanbanAdapter();
      const previousTask = typeof adapter.getTask === "function"
        ? await adapter.getTask(taskId).catch(() => null)
        : null;
      const tagsProvided = hasOwn(body, "tags");
      const tags = tagsProvided ? normalizeTagsInput(body?.tags) : undefined;
      const draftProvided = hasOwn(body, "draft");
      const blockedReasonProvided = hasOwn(body, "blockedReason");
      const blockedReason = blockedReasonProvided
        ? String(body?.blockedReason || "").trim() || null
        : undefined;
      const baseBranchProvided = hasOwn(body, "baseBranch") || hasOwn(body, "base_branch");
      const baseBranch = baseBranchProvided
        ? normalizeBranchInput(body?.baseBranch ?? body?.base_branch)
        : undefined;
      const metadataPatch = buildTaskMetadataPatch(body || {});
      const requestedStatus = normalizeTaskStatusKey(body?.status);
      const currentLooksBlocked =
        normalizeTaskStatusKey(previousTask?.status) === "blocked" ||
        Boolean(previousTask?.blockedReason) ||
        Boolean(previousTask?.cooldownUntil) ||
        Boolean(previousTask?.meta?.autoRecovery) ||
        Boolean(previousTask?.meta?.worktreeFailure?.blockedReason);
      const clearsBlockedState =
        currentLooksBlocked && Boolean(requestedStatus) && requestedStatus !== "blocked";
      const nextMeta = (Object.keys(metadataPatch.meta).length > 0 || clearsBlockedState)
        ? buildTaskMetaPatch(previousTask?.meta, metadataPatch.meta, { clearBlockedState: clearsBlockedState })
        : null;
      const patch = {
        status: body?.status,
        title: body?.title,
        description: body?.description,
        priority: body?.priority,
        workspace: body?.workspace,
        repository: body?.repository,
        repositories: Array.isArray(body?.repositories) ? body.repositories : undefined,
        ...(tagsProvided ? { tags } : {}),
        ...(draftProvided ? { draft: Boolean(body?.draft) } : {}),
        ...(clearsBlockedState
          ? { cooldownUntil: null, blockedReason: null }
          : (blockedReasonProvided ? { blockedReason } : {})),
        ...(clearsBlockedState ? { replaceMeta: true } : {}),
        ...(baseBranchProvided ? { baseBranch } : {}),
        ...metadataPatch.topLevel,
        ...(nextMeta ? { meta: nextMeta } : {}),
      };
      if (!hasTaskPatchValues(patch) && !baseBranchProvided && !draftProvided && !tagsProvided) {
        jsonResponse(res, 400, {
          ok: false,
          error: "No update fields provided",
        });
        return;
      }
      const updatedRaw =
        typeof adapter.updateTask === "function"
          ? await adapter.updateTask(taskId, patch)
          : await adapter.updateTaskStatus(taskId, patch.status);
      const updated = withTaskMetadataTopLevel(updatedRaw);
      if (clearsBlockedState) {
        resetExecutorTaskThrottleState(taskId);
      }
      const nextStatus = updated?.status || patch.status || null;
      const lifecycleAction = inferLifecycleAction(
        previousTask?.status || null,
        nextStatus,
        body?.lifecycleAction,
      );
      applyInternalLifecycleTransition(taskId, lifecycleAction, {
        source: "api.tasks.update",
        actor: "ui",
        force: forceStart || manualOverride,
        reason: body?.reason || null,
        payload: {
          previousStatus: previousTask?.status || null,
          nextStatus,
        },
      });

      const executor = uiDeps.getInternalExecutor?.() || null;
      const startDispatch = await maybeStartTaskFromLifecycleAction({
        taskId,
        updatedTask: updated,
        adapter,
        executor,
        lifecycleAction,
        forceStart,
        manualOverride,
      });
      const reconciled = await reconcileTaskAfterDispatchAttempt({
        adapter,
        taskId,
        previousStatus: previousTask?.status || null,
        requestedStatus: nextStatus,
        lifecycleAction,
        startDispatch,
        source: "api.tasks.update",
      });
      const responseTask = withTaskRuntimeSnapshot(reconciled || updated);
      const responseStatus = responseTask?.status || nextStatus;
      if (body?.pauseExecution === true && lifecycleAction === "pause" && executor && typeof executor.abortTask === "function") {
        executor.abortTask(taskId, "task_lifecycle_pause");
      }

      const restart = await maybeRestartTaskOnReopen({
        taskId,
        previousStatus: previousTask?.status || null,
        nextStatus,
        updatedTask: updated,
        adapter,
        executor,
        forceStart,
        manualOverride,
      });
      jsonResponse(res, 200, {
        ok: true,
        data: responseTask,
        restart,
        lifecycle: {
          action: lifecycleAction,
          previousStatus: previousTask?.status || null,
          nextStatus: responseStatus,
          startDispatch,
        },
      });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-updated",
        taskId,
        status: responseStatus,
      });
      if (restart?.started || startDispatch?.started) {
        broadcastUiEvent(["tasks", "overview", "executor", "agents"], "invalidate", {
          reason: restart?.started ? "task-restarted" : "task-started",
          taskId,
        });
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/edit") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const forceStart = body?.force === true || body?.forceStart === true;
      const manualOverride = body?.manualOverride === true || body?.overrideStartGuard === true;
      const adapter = getKanbanAdapter();
      const previousTask = typeof adapter.getTask === "function"
        ? await adapter.getTask(taskId).catch(() => null)
        : null;
      const tagsProvided = hasOwn(body, "tags");
      const tags = tagsProvided ? normalizeTagsInput(body?.tags) : undefined;
      const draftProvided = hasOwn(body, "draft");
      const blockedReasonProvided = hasOwn(body, "blockedReason");
      const blockedReason = blockedReasonProvided
        ? String(body?.blockedReason || "").trim() || null
        : undefined;
      const baseBranchProvided = hasOwn(body, "baseBranch") || hasOwn(body, "base_branch");
      const baseBranch = baseBranchProvided
        ? normalizeBranchInput(body?.baseBranch ?? body?.base_branch)
        : undefined;
      const metadataPatch = buildTaskMetadataPatch(body || {});
      const requestedStatus = normalizeTaskStatusKey(body?.status);
      const currentLooksBlocked =
        normalizeTaskStatusKey(previousTask?.status) === "blocked" ||
        Boolean(previousTask?.blockedReason) ||
        Boolean(previousTask?.cooldownUntil) ||
        Boolean(previousTask?.meta?.autoRecovery) ||
        Boolean(previousTask?.meta?.worktreeFailure?.blockedReason);
      const clearsBlockedState =
        currentLooksBlocked && Boolean(requestedStatus) && requestedStatus !== "blocked";
      const nextMeta = (Object.keys(metadataPatch.meta).length > 0 || clearsBlockedState)
        ? buildTaskMetaPatch(previousTask?.meta, metadataPatch.meta, { clearBlockedState: clearsBlockedState })
        : null;
      const patch = {
        title: body?.title,
        description: body?.description,
        priority: body?.priority,
        status: body?.status,
        workspace: body?.workspace,
        repository: body?.repository,
        repositories: Array.isArray(body?.repositories) ? body.repositories : undefined,
        ...(tagsProvided ? { tags } : {}),
        ...(draftProvided ? { draft: Boolean(body?.draft) } : {}),
        ...(clearsBlockedState
          ? { cooldownUntil: null, blockedReason: null }
          : (blockedReasonProvided ? { blockedReason } : {})),
        ...(clearsBlockedState ? { replaceMeta: true } : {}),
        ...(baseBranchProvided ? { baseBranch } : {}),
        ...metadataPatch.topLevel,
        ...(nextMeta ? { meta: nextMeta } : {}),
      };
      if (!hasTaskPatchValues(patch) && !baseBranchProvided && !draftProvided && !tagsProvided) {
        jsonResponse(res, 400, {
          ok: false,
          error: "No edit fields provided",
        });
        return;
      }
      const updatedRaw =
        typeof adapter.updateTask === "function"
          ? await adapter.updateTask(taskId, patch)
          : await adapter.updateTaskStatus(taskId, patch.status);
      const updated = withTaskMetadataTopLevel(updatedRaw);
      if (clearsBlockedState) {
        resetExecutorTaskThrottleState(taskId);
      }
      const nextStatus = updated?.status || patch.status || null;
      const lifecycleAction = inferLifecycleAction(
        previousTask?.status || null,
        nextStatus,
        body?.lifecycleAction,
      );
      applyInternalLifecycleTransition(taskId, lifecycleAction, {
        source: "api.tasks.edit",
        actor: "ui",
        force: forceStart || manualOverride,
        reason: body?.reason || null,
        payload: {
          previousStatus: previousTask?.status || null,
          nextStatus,
        },
      });

      const executor = uiDeps.getInternalExecutor?.() || null;
      const startDispatch = await maybeStartTaskFromLifecycleAction({
        taskId,
        updatedTask: updated,
        adapter,
        executor,
        lifecycleAction,
        forceStart,
        manualOverride,
      });
      const reconciled = await reconcileTaskAfterDispatchAttempt({
        adapter,
        taskId,
        previousStatus: previousTask?.status || null,
        requestedStatus: nextStatus,
        lifecycleAction,
        startDispatch,
        source: "api.tasks.edit",
      });
      const responseTask = withTaskRuntimeSnapshot(reconciled || updated);
      const responseStatus = responseTask?.status || nextStatus;
      if (body?.pauseExecution === true && lifecycleAction === "pause" && executor && typeof executor.abortTask === "function") {
        executor.abortTask(taskId, "task_lifecycle_pause");
      }

      const restart = await maybeRestartTaskOnReopen({
        taskId,
        previousStatus: previousTask?.status || null,
        nextStatus,
        updatedTask: updated,
        adapter,
        executor,
        forceStart,
        manualOverride,
      });
      jsonResponse(res, 200, {
        ok: true,
        data: responseTask,
        restart,
        lifecycle: {
          action: lifecycleAction,
          previousStatus: previousTask?.status || null,
          nextStatus: responseStatus,
          startDispatch,
        },
      });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-edited",
        taskId,
        status: responseStatus,
      });
      if (restart?.started || startDispatch?.started) {
        broadcastUiEvent(["tasks", "overview", "executor", "agents"], "invalidate", {
          reason: restart?.started ? "task-restarted" : "task-started",
          taskId,
        });
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }


  if (path === "/api/tasks/comment" && req.method === "GET") {
    try {
      const taskId = String(url.searchParams.get("taskId") || url.searchParams.get("id") || url.searchParams.get("parentTaskId") || "").trim();
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }

      const adapter = getKanbanAdapter();
      const comments = await getTaskCommentsForApi(taskId, adapter);
      jsonResponse(res, 200, {
        ok: true,
        taskId,
        comments,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }
  if (path === "/api/tasks/comment" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const taskId = String(body?.taskId || body?.id || "").trim();
      const commentBody = String(body?.body || body?.comment || body?.text || "").trim();
      const author = String(body?.author || "ui").trim() || "ui";
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      if (!commentBody) {
        jsonResponse(res, 400, { ok: false, error: "comment body required" });
        return;
      }

      const adapter = getKanbanAdapter();
      const storeComment = addInternalTaskComment(taskId, {
        body: commentBody,
        text: commentBody,
        author,
        source: "ui",
      });
      const commented = typeof adapter.addComment === "function"
        ? await adapter.addComment(taskId, commentBody)
        : Boolean(storeComment);

      appendInternalTaskTimelineEvent(taskId, {
        type: "task.comment",
        source: "ui",
        actor: author,
        message: commentBody,
      });

      const task = typeof adapter.getTask === "function"
        ? await adapter.getTask(taskId).catch(() => null)
        : null;
      jsonResponse(res, 200, { ok: true, commented, stored: Boolean(storeComment), data: task });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-commented",
        taskId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }
  if (path === "/api/tasks/create") {
    try {
      const body = await readJsonBody(req);
      const title = body?.title;
      if (!title || !String(title).trim()) {
        jsonResponse(res, 400, { ok: false, error: "title is required" });
        return;
      }
      const projectId = body?.project || "";
      const adapter = getKanbanAdapter();
      const tags = normalizeTagsInput(body?.tags);
      const wantsDraft = Boolean(body?.draft) || body?.status === "draft";
      const blockedReasonProvided = hasOwn(body, "blockedReason");
      const blockedReason = blockedReasonProvided
        ? String(body?.blockedReason || "").trim() || null
        : undefined;
      const baseBranch = normalizeBranchInput(body?.baseBranch ?? body?.base_branch);
      const activeWorkspace = getActiveManagedWorkspace(resolveUiConfigDir());
      const defaultRepository =
        activeWorkspace?.activeRepo ||
        activeWorkspace?.repos?.find((repo) => repo.primary)?.name ||
        activeWorkspace?.repos?.[0]?.name ||
        "";
      const workspace = String(body?.workspace || activeWorkspace?.id || "").trim();
      const repository = String(body?.repository || defaultRepository || "").trim();
      const repositories = Array.isArray(body?.repositories)
        ? body.repositories.filter((value) => typeof value === "string" && value.trim())
        : [];
      const metadataFields = buildTaskMetadataPatch(body || {});
      const taskData = {
        title: String(title).trim(),
        description: body?.description || "",
        status: body?.status || (wantsDraft ? "draft" : "todo"),
        priority: body?.priority || undefined,
        ...(blockedReasonProvided ? { blockedReason } : {}),
        ...(workspace ? { workspace } : {}),
        ...(repository ? { repository } : {}),
        ...(repositories.length ? { repositories } : {}),
        ...(tags.length ? { tags } : {}),
        ...(tags.length ? { labels: tags } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        ...metadataFields.topLevel,
        meta: {
          ...(workspace ? { workspace } : {}),
          ...(repository ? { repository } : {}),
          ...(repositories.length ? { repositories } : {}),
          ...(tags.length ? { tags } : {}),
          ...(wantsDraft ? { draft: true } : {}),
          ...(baseBranch ? { base_branch: baseBranch, baseBranch } : {}),
          ...metadataFields.meta,
        },
      };
      const createdRaw = await adapter.createTask(projectId, taskData);
      const created = withTaskMetadataTopLevel(createdRaw);
      jsonResponse(res, 200, { ok: true, data: created });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-created",
        taskId: created?.id || null,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/subtasks" && req.method === "GET") {
    try {
      const taskId = String(url.searchParams.get("taskId") || url.searchParams.get("id") || url.searchParams.get("parentTaskId") || "").trim();
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const adapter = getKanbanAdapter();
      const tasks = await listAllTasksForApi(adapter);
      const subtasks = tasks.filter((entry) => {
        const parent = String(entry?.parentTaskId || entry?.meta?.parentTaskId || "").trim();
        return parent === taskId;
      });
      jsonResponse(res, 200, { ok: true, taskId, data: subtasks });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/subtasks" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const parentTaskId = String(body?.parentTaskId || body?.taskId || body?.parentId || "").trim();
      const title = String(body?.title || "").trim();
      if (!parentTaskId) {
        jsonResponse(res, 400, { ok: false, error: "parentTaskId required" });
        return;
      }
      if (!title) {
        jsonResponse(res, 400, { ok: false, error: "title required" });
        return;
      }
      const adapter = getKanbanAdapter();
      const parentTask = typeof adapter.getTask === "function"
        ? await adapter.getTask(parentTaskId).catch(() => null)
        : null;
      if (typeof adapter.getTask === "function" && !parentTask) {
        jsonResponse(res, 404, { ok: false, error: "parent task not found" });
        return;
      }
      const projectId = body?.project || "";
      const metadataFields = buildTaskMetadataPatch({ ...(body || {}), parentTaskId });
      const subtaskPayload = {
        title,
        description: body?.description || "",
        status: body?.status || "todo",
        priority: body?.priority || parentTask?.priority || undefined,
        parentTaskId,
        workspace: body?.workspace || parentTask?.workspace || parentTask?.meta?.workspace || undefined,
        repository: body?.repository || parentTask?.repository || parentTask?.meta?.repository || undefined,
        ...metadataFields.topLevel,
        meta: {
          parentTaskId,
          workspace: body?.workspace || parentTask?.workspace || parentTask?.meta?.workspace || undefined,
          repository: body?.repository || parentTask?.repository || parentTask?.meta?.repository || undefined,
          ...metadataFields.meta,
        },
      };
      const createdRaw = await adapter.createTask(projectId, subtaskPayload);
      const created = withTaskMetadataTopLevel(createdRaw);
      jsonResponse(res, 200, { ok: true, parentTaskId, data: created });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "subtask-created",
        taskId: created?.id || null,
        parentTaskId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/rewrite") {
    // POST { title, description } → AI enriches the task description synchronously.
    try {
      const body = await readJsonBody(req);
      const title = String(body?.title || "").trim();
      const description = String(body?.description || "").trim();
      if (!title) {
        jsonResponse(res, 400, { ok: false, error: "title is required" });
        return;
      }
      const exec = uiDeps.execPrimaryPrompt;
      if (typeof exec !== "function") {
        jsonResponse(res, 503, { ok: false, error: "Primary agent not available. Start bosun first." });
        return;
      }
      const prompt =
        `You are a software project assistant helping write backlog tasks for an autonomous coding agent.\n` +
        `Rewrite and expand the following task so it is clear, actionable, and self-contained.\n` +
        `Include:\n` +
        `- Concise one-line title (kept on the TITLE: line)\n` +
        `- Background / motivation (why this task matters)\n` +
        `- Acceptance criteria (bullet list)\n` +
        `- Implementation steps (numbered list)\n` +
        `- Relevant files, modules, or directories likely involved (if inferable)\n` +
        `- Edge cases or caveats\n\n` +
        `TASK TITLE: ${title}\n` +
        `CURRENT DESCRIPTION: ${description || "(none)"}\n\n` +
        `Return exactly two sections:\n` +
        `TITLE: <rewritten one-line title>\n` +
        `DESCRIPTION:\n<full markdown description>`;

      const result = await exec(prompt, { sessionType: "ephemeral", mode: "ask" });
      const text =
        typeof result === "string"
          ? result
          : result?.finalResponse || result?.text || result?.message || JSON.stringify(result);

      // Parse structured output
      const titleMatch = text.match(/^TITLE:\s*(.+)$/im);
      const descMatch = text.match(/DESCRIPTION:\s*\n([\s\S]+)/im);
      const newTitle = (titleMatch ? titleMatch[1] : title).trim().replace(/^["'`]|["'`]$/g, "");
      const newDescription = (descMatch ? descMatch[1] : text).trim();

      jsonResponse(res, 200, { ok: true, data: { title: newTitle, description: newDescription } });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/ignore") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      const reason = String(body?.reason || "manual").trim() || "manual";
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const shared = await setIgnoreFlag(String(taskId), reason, repoRoot);
      let adapterMarked = false;
      try {
        adapterMarked = await markTaskIgnored(String(taskId), reason);
      } catch (err) {
        console.warn(`[ui] markTaskIgnored failed: ${err.message}`);
      }
      let aborted = null;
      const executor = uiDeps.getInternalExecutor?.();
      if (executor && typeof executor.abortTask === "function") {
        aborted = executor.abortTask(String(taskId), "manual_takeover");
      }
      jsonResponse(res, 200, {
        ok: shared.success,
        shared,
        adapterMarked,
        aborted,
      });
      broadcastUiEvent(["tasks", "overview", "executor", "agents"], "invalidate", {
        reason: "task-ignored",
        taskId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/unignore") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const shared = await clearIgnoreFlag(String(taskId), repoRoot);
      let adapterUnmarked = false;
      try {
        adapterUnmarked = await unmarkTaskIgnored(String(taskId));
      } catch (err) {
        console.warn(`[ui] unmarkTaskIgnored failed: ${err.message}`);
      }
      jsonResponse(res, 200, {
        ok: shared.success,
        shared,
        adapterUnmarked,
      });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-unignored",
        taskId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }
      const typeRaw = (url.searchParams.get("type") || "").trim();
      const agentTypeRaw = String(url.searchParams.get("agentType") || "").trim().toLowerCase();
      const search = (url.searchParams.get("search") || "").trim();
      const type = typeRaw && typeRaw !== "all" ? typeRaw : "";
      const resolved = listLibraryEntriesAcrossRoots(workspaceContext, {
        type: type || undefined,
        search: search || undefined,
      });
      let data = resolved.entries.map(({ entry, rootInfo }) => {
        if (entry?.type !== "agent") {
          return {
            ...entry,
            storageScope: rootInfo.scope,
          };
        }
        const profile = getEntryContent(rootInfo.rootDir, entry);
        return resolveAgentProfileLibraryView(entry, profile, rootInfo.scope);
      });
      if (type === "agent" && (agentTypeRaw === "voice" || agentTypeRaw === "task" || agentTypeRaw === "chat")) {
        data = data.filter((entry) => {
          return String(entry?.agentType || "").trim().toLowerCase() === agentTypeRaw;
        });
      }
      jsonResponse(res, 200, { ok: true, data });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/entry") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }
      if (req.method === "GET") {
        const id = (url.searchParams.get("id") || "").trim();
        const preferredScope = normalizeLibraryStorageScope(url.searchParams.get("source"), "");
        if (!id) {
          jsonResponse(res, 400, { ok: false, error: "id required" });
          return;
        }
        const resolved = resolveLibraryEntryAcrossRoots(workspaceContext, id, { preferredScope });
        if (!resolved) {
          jsonResponse(res, 404, { ok: false, error: "not found" });
          return;
        }
        const content = getEntryContent(resolved.rootInfo.rootDir, resolved.entry);
        jsonResponse(res, 200, {
          ok: true,
          data: {
            ...resolved.entry,
            storageScope: resolved.rootInfo.scope,
            content,
          },
        });
        return;
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const { content, storageScope, source, ...entryData } = body || {};
        const preferredScope = normalizeLibraryStorageScope(storageScope || source, "");
        const existing = entryData?.id
          ? resolveLibraryEntryAcrossRoots(workspaceContext, entryData.id, { preferredScope })
          : null;
        const targetRoot = resolveLibraryTargetRoot(workspaceContext, preferredScope, existing);
        const entry = upsertEntry(targetRoot.rootDir, entryData, content);
        jsonResponse(res, 200, {
          ok: true,
          data: {
            ...entry,
            storageScope: targetRoot.scope,
          },
        });
        return;
      }

      if (req.method === "DELETE") {
        const body = await readJsonBody(req);
        const id = body?.id;
        const preferredScope = normalizeLibraryStorageScope(body?.storageScope || body?.source, "");
        if (!id) {
          jsonResponse(res, 400, { ok: false, error: "id required" });
          return;
        }
        const resolved = resolveLibraryEntryAcrossRoots(workspaceContext, id, { preferredScope });
        if (!resolved) {
          jsonResponse(res, 404, { ok: false, error: "not found" });
          return;
        }
        const deleted = deleteEntry(resolved.rootInfo.rootDir, id, {
          deleteFile: Boolean(body?.deleteFile),
        });
        if (!deleted) {
          jsonResponse(res, 404, { ok: false, error: "not found" });
          return;
        }
        jsonResponse(res, 200, {
          ok: true,
          data: { storageScope: resolved.rootInfo.scope },
        });
        return;
      }

      jsonResponse(res, 405, { ok: false, error: "method not allowed" });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/scopes") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }
      const libraryRoot = workspaceContext.workspaceDir || repoRoot;
      ensureLibraryInitialized(libraryRoot);
      const result = detectScopes(libraryRoot);
      jsonResponse(res, 200, { ok: true, data: result?.scopes || [] });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/init" && req.method === "POST") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }
      const requestedScope = normalizeLibraryStorageScope(url.searchParams.get("scope"), "");
      const roots = resolveLibraryRootsForContext(workspaceContext);
      const selectedRoots = requestedScope
        ? roots.filter((rootInfo) => rootInfo.scope === requestedScope)
        : roots;
      if (selectedRoots.length === 0) {
        jsonResponse(res, 400, { ok: false, error: "No matching library scope to initialize" });
        return;
      }
      const byScope = [];
      let entriesCount = 0;
      let scaffoldedCount = 0;
      for (const rootInfo of selectedRoots) {
        const result = initLibrary(rootInfo.rootDir);
        const count = result?.manifest?.entries?.length ?? 0;
        const scaffolded = result?.scaffolded?.written?.length ?? 0;
        byScope.push({ scope: rootInfo.scope, entries: count, scaffolded });
        entriesCount += count;
        scaffoldedCount += scaffolded;
      }
      jsonResponse(res, 200, {
        ok: true,
        data: { entries: entriesCount, scaffolded: scaffoldedCount, byScope },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/rebuild" && req.method === "POST") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }
      const requestedScope = normalizeLibraryStorageScope(url.searchParams.get("scope"), "");
      const roots = resolveLibraryRootsForContext(workspaceContext);
      const selectedRoots = requestedScope
        ? roots.filter((rootInfo) => rootInfo.scope === requestedScope)
        : roots;
      if (selectedRoots.length === 0) {
        jsonResponse(res, 400, { ok: false, error: "No matching library scope to rebuild" });
        return;
      }
      const byScope = [];
      let totalCount = 0;
      let totalAdded = 0;
      let totalRemoved = 0;
      for (const rootInfo of selectedRoots) {
        const result = rebuildManifest(rootInfo.rootDir);
        const count = result?.entries?.length ?? 0;
        const added = result?.added ?? 0;
        const removed = result?.removed ?? 0;
        byScope.push({ scope: rootInfo.scope, count, added, removed });
        totalCount += count;
        totalAdded += added;
        totalRemoved += removed;
      }
      jsonResponse(res, 200, {
        ok: true,
        data: {
          count: totalCount,
          added: totalAdded,
          removed: totalRemoved,
          byScope,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/resolve") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }

      const getCriteriaFromQuery = () => ({
        title: (url.searchParams.get("title") || "").trim(),
        description: (url.searchParams.get("description") || "").trim(),
        agentType: (url.searchParams.get("agentType") || "").trim(),
        tags: String(url.searchParams.get("tags") || "").split(",").map((t) => t.trim()).filter(Boolean),
        changedFiles: String(url.searchParams.get("changedFiles") || "").split(",").map((t) => t.trim()).filter(Boolean),
        topN: Number.parseInt(String(url.searchParams.get("topN") || ""), 10) || 5,
        skillTopN: Number.parseInt(String(url.searchParams.get("skillTopN") || ""), 10) || 6,
      });

      const bodyCriteria = req.method === "POST" ? await readJsonBody(req).catch(() => ({})) : null;
      const criteria = req.method === "POST"
        ? {
            ...(bodyCriteria || {}),
            topN: Number.parseInt(String(bodyCriteria?.topN || ""), 10) || 5,
            skillTopN: Number.parseInt(String(bodyCriteria?.skillTopN || ""), 10) || 6,
          }
        : getCriteriaFromQuery();

      // Inject workspace repo root for repo-context-aware resolution
      if (!criteria.repoRoot) {
        criteria.repoRoot = workspaceContext.workspaceDir || workspaceContext.workspaceRoot || repoRoot;
      }

      const roots = resolveLibraryRootsForContext(workspaceContext);
      ensureLibraryRootsInitialized(roots);

      let bestResult = null;
      for (const rootInfo of roots) {
        const result = resolveLibraryPlan(rootInfo.rootDir, criteria, {
          topN: criteria?.topN || 5,
          skillTopN: criteria?.skillTopN || 6,
        });
        if (!result?.best) continue;
        const withScope = {
          ...result,
          best: { ...result.best, storageScope: rootInfo.scope },
          candidates: (result.candidates || []).map((candidate) => ({ ...candidate, storageScope: rootInfo.scope })),
          plan: result.plan ? { ...result.plan, storageScope: rootInfo.scope } : null,
        };
        if (!bestResult || Number(withScope.best?.score || 0) > Number(bestResult.best?.score || 0)) {
          bestResult = withScope;
        }
      }

      const verbose = req.method === "POST"
        || ["1", "true", "yes"].includes(String(url.searchParams.get("verbose") || "").trim().toLowerCase());
      const payload = bestResult || {
        best: null,
        candidates: [],
        alternatives: [],
        plan: null,
        auto: { shouldAutoApply: false, reason: "no-match" },
        context: {
          title: String(criteria?.title || ""),
          description: String(criteria?.description || ""),
          requestedAgentType: String(criteria?.agentType || ""),
          taskScope: null,
          changedFilesCount: Array.isArray(criteria?.changedFiles) ? criteria.changedFiles.length : 0,
        },
      };

      jsonResponse(res, 200, {
        ok: true,
        data: verbose ? payload : (payload.plan || null),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/match-profile") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }

      const getCriteriaFromQuery = () => ({
        title: (url.searchParams.get("title") || "").trim(),
        description: (url.searchParams.get("description") || "").trim(),
        agentType: (url.searchParams.get("agentType") || "").trim(),
        tags: String(url.searchParams.get("tags") || "").split(",").map((t) => t.trim()).filter(Boolean),
        changedFiles: String(url.searchParams.get("changedFiles") || "").split(",").map((t) => t.trim()).filter(Boolean),
        topN: Number.parseInt(String(url.searchParams.get("topN") || ""), 10) || 5,
      });

      const bodyCriteria = req.method === "POST" ? await readJsonBody(req).catch(() => ({})) : null;
      const criteria = req.method === "POST"
        ? {
            ...(bodyCriteria || {}),
            topN: Number.parseInt(String(bodyCriteria?.topN || ""), 10) || 5,
          }
        : getCriteriaFromQuery();

      // Inject workspace repo root for repo-context-aware matching
      if (!criteria.repoRoot) {
        criteria.repoRoot = workspaceContext.workspaceDir || workspaceContext.workspaceRoot || repoRoot;
      }

      const roots = resolveLibraryRootsForContext(workspaceContext);
      ensureLibraryRootsInitialized(roots);

      let bestResult = null;
      for (const rootInfo of roots) {
        const result = matchAgentProfiles(rootInfo.rootDir, criteria, { topN: criteria?.topN || 5 });
        if (!result?.best) continue;
        const withScope = {
          ...result,
          best: { ...result.best, storageScope: rootInfo.scope },
          candidates: (result.candidates || []).map((candidate) => ({ ...candidate, storageScope: rootInfo.scope })),
        };
        if (!bestResult || Number(withScope.best?.score || 0) > Number(bestResult.best?.score || 0)) {
          bestResult = withScope;
        }
      }

      const verbose = req.method === "POST"
        || ["1", "true", "yes"].includes(String(url.searchParams.get("verbose") || "").trim().toLowerCase());
      const payload = bestResult || {
        best: null,
        candidates: [],
        auto: { shouldAutoApply: false, reason: "no-match" },
        context: {
          title: String(criteria?.title || ""),
          description: String(criteria?.description || ""),
          requestedAgentType: String(criteria?.agentType || ""),
          taskScope: null,
          changedFilesCount: Array.isArray(criteria?.changedFiles) ? criteria.changedFiles.length : 0,
        },
      };

      jsonResponse(res, 200, {
        ok: true,
        data: verbose ? payload : (payload.best || null),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/sources" && req.method === "GET") {
    try {
      const probe = String(url.searchParams.get("probe") || "").trim().toLowerCase();
      const refresh = String(url.searchParams.get("refresh") || "").trim().toLowerCase();
      const sourceId = String(url.searchParams.get("sourceId") || "").trim().toLowerCase() || undefined;
      const useProbe = probe === "1" || probe === "true" || refresh === "1" || refresh === "true";
      const data = useProbe
        ? await probeWellKnownAgentSources({
          sourceId,
          refresh: refresh === "1" || refresh === "true",
        })
        : listWellKnownAgentSources();
      jsonResponse(res, 200, { ok: true, data });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/preview" && req.method === "POST") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      const body = await readJsonBody(req).catch(() => ({}));
      // Resolve library root for duplicate detection (optional — works without workspace)
      let libraryRoot = null;
      if (workspaceContext) {
        try {
          const targetRoot = resolveLibraryTargetRoot(workspaceContext, "repo", null);
          libraryRoot = targetRoot?.rootDir || null;
        } catch { /* skip — dedup is best-effort */ }
      }
      const result = scanRepositoryForImport({
        sourceId: String(body?.sourceId || "").trim() || undefined,
        repoUrl: String(body?.repoUrl || "").trim() || undefined,
        branch: String(body?.branch || "").trim() || undefined,
        maxEntries: Number.parseInt(String(body?.maxEntries ?? ""), 10) || undefined,
        rootDir: libraryRoot,
      });
      jsonResponse(res, 200, { ok: true, data: result });
    } catch (err) {
      console.error("[library-preview] Preview failed:", err);
      const msg = String(err?.message || "Preview failed").split("\n")[0].trim() || "Preview failed";
      jsonResponse(res, 500, { ok: false, error: msg });
    }
    return;
  }

  if (path === "/api/library/import" && req.method === "POST") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }
      const body = await readJsonBody(req).catch((bodyErr) => {
        console.error("[library-import] Failed to parse request body:", bodyErr?.message);
        return {};
      });
      const requestedScope = normalizeLibraryStorageScope(body?.storageScope || body?.source, "repo");
      const targetRoot = resolveLibraryTargetRoot(workspaceContext, requestedScope, null);
      const includeEntries = Array.isArray(body?.includeEntries) ? body.includeEntries : null;
      const result = importAgentProfilesFromRepository(targetRoot.rootDir, {
        sourceId: String(body?.sourceId || "").trim() || undefined,
        repoUrl: String(body?.repoUrl || "").trim() || undefined,
        branch: String(body?.branch || "").trim() || undefined,
        maxEntries: Number.parseInt(String(body?.maxEntries ?? body?.maxProfiles ?? ""), 10) || undefined,
        importAgents: body?.importAgents !== false,
        importSkills: body?.importSkills !== false,
        importPrompts: body?.importPrompts !== false,
        importTools: body?.importTools !== false,
        includeEntries,
      });

      broadcastUiEvent(["library"], "invalidate", {
        reason: "library-imported",
        sourceId: String(body?.sourceId || "custom").trim() || "custom",
      });

      jsonResponse(res, 200, {
        ok: true,
        data: {
          ...result,
          storageScope: targetRoot.scope,
        },
      });
    } catch (err) {
      console.error("[library-import] Import failed:", err);
      // Take first line only to avoid stack-trace scrubbing by jsonResponse
      const msg = String(err?.message || "Import failed").split("\n")[0].trim() || "Import failed";
      jsonResponse(res, 500, { ok: false, error: msg });
    }
    return;
  }

  // ── Hook Library API ───────────────────────────────────────────────────────

  if (path === "/api/hooks/catalog") {
    try {
      const category = url.searchParams.get("category") || undefined;
      const sdk = url.searchParams.get("sdk") || undefined;
      const coreOnly = url.searchParams.get("core") === "true";
      const defaultOnly = url.searchParams.get("default") === "true";
      const search = url.searchParams.get("search") || undefined;
      const hooks = getHookCatalog({ category, sdk, coreOnly, defaultOnly, search });
      jsonResponse(res, 200, { ok: true, data: hooks });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/hooks/categories") {
    try {
      const categories = getHookCategories();
      jsonResponse(res, 200, { ok: true, data: categories });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/hooks/sdk-matrix") {
    try {
      const matrix = getSdkCompatibilityMatrix();
      const sdks = SDK_CAPABILITIES;
      jsonResponse(res, 200, { ok: true, data: { matrix, sdks } });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/hooks/entry") {
    try {
      const hookId = url.searchParams.get("id");
      if (!hookId) {
        jsonResponse(res, 400, { ok: false, error: "Missing id parameter" });
        return;
      }
      const hook = getHookById(hookId);
      if (!hook) {
        jsonResponse(res, 404, { ok: false, error: `Hook not found: ${hookId}` });
        return;
      }
      jsonResponse(res, 200, { ok: true, data: hook });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/hooks/state") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }
      const rootDir = workspaceContext.repoRoot || workspaceContext.workspaceRoot || process.cwd();

      if (req.method === "GET") {
        const state = loadHookState(rootDir);
        const enabledIds = getEnabledHookIds(rootDir);
        jsonResponse(res, 200, { ok: true, data: { state, enabledIds } });
        return;
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req).catch(() => ({}));
        const action = body?.action;
        const hookId = body?.hookId;
        if (!hookId) {
          jsonResponse(res, 400, { ok: false, error: "Missing hookId" });
          return;
        }
        if (action === "enable") {
          const result = enableHook(rootDir, hookId);
          jsonResponse(res, result.success ? 200 : 400, { ok: result.success, ...result });
        } else if (action === "disable") {
          const force = body?.force === true;
          const result = disableHook(rootDir, hookId, force);
          jsonResponse(res, result.success ? 200 : 400, { ok: result.success, ...result });
        } else if (action === "initialize") {
          const state = initializeHookState(rootDir);
          jsonResponse(res, 200, { ok: true, data: state });
        } else {
          jsonResponse(res, 400, { ok: false, error: `Unknown action: ${action}. Use enable, disable, or initialize.` });
        }
        return;
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/hooks/core") {
    try {
      const hooks = getCoreHooks();
      jsonResponse(res, 200, { ok: true, data: hooks });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/hooks/defaults") {
    try {
      const hooks = getDefaultHooks();
      jsonResponse(res, 200, { ok: true, data: hooks });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── MCP Server Management API ─────────────────────────────────────────────

  if (path === "/api/mcp/catalog") {
    try {
      const tagsRaw = (url.searchParams.get("tags") || "").trim();
      const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()) : undefined;
      const catalog = listCatalog({ tags });
      jsonResponse(res, 200, { ok: true, data: catalog });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/mcp/installed") {
    try {
      const servers = await listInstalledMcpServers(repoRoot);
      jsonResponse(res, 200, { ok: true, data: servers });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/mcp/install" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body?.id && !body?.serverDef) {
        jsonResponse(res, 400, { ok: false, error: "id (catalog) or serverDef (custom) required" });
        return;
      }
      const result = await installMcpServer(
        repoRoot,
        body.serverDef || body.id,
        { envOverrides: body.envOverrides },
      );
      jsonResponse(res, 200, { ok: true, data: result });
      broadcastUiEvent(["library"], "invalidate", { reason: "mcp-installed", id: result?.id });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/mcp/uninstall" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body?.id) {
        jsonResponse(res, 400, { ok: false, error: "id required" });
        return;
      }
      const removed = await uninstallMcpServer(repoRoot, body.id);
      jsonResponse(res, 200, { ok: true, removed });
      broadcastUiEvent(["library"], "invalidate", { reason: "mcp-uninstalled", id: body.id });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/mcp/configure" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body?.id) {
        jsonResponse(res, 400, { ok: false, error: "id required" });
        return;
      }
      const existing = await getInstalledMcpServer(repoRoot, body.id);
      if (!existing) {
        jsonResponse(res, 404, { ok: false, error: "MCP server not installed" });
        return;
      }
      // Re-install with updated env
      const updated = await installMcpServer(repoRoot, {
        ...existing.serverConfig,
        id: body.id,
        name: existing.name,
        description: existing.description,
        tags: existing.tags,
      }, { envOverrides: body.env });
      jsonResponse(res, 200, { ok: true, data: updated });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Agent Tool Configuration API ──────────────────────────────────────────

  if (path === "/api/agent-tools/available") {
    try {
      const available = await listAvailableTools(repoRoot);
      const bosunTools = await listBosunRuntimeTools({});
      jsonResponse(res, 200, {
        ok: true,
        data: {
          ...available,
          bosunTools,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agent-tools/config") {
    try {
      if (req.method === "GET") {
        const agentId = (url.searchParams.get("agentId") || "").trim();
        if (!agentId) {
          // Return full config
          const config = loadToolConfig(repoRoot);
          jsonResponse(res, 200, { ok: true, data: config });
          return;
        }
        const effective = getEffectiveTools(repoRoot, agentId);
        const bosunTools = await listBosunRuntimeTools({});
        const raw = getAgentToolConfig(repoRoot, agentId);
        const enabledSet = Array.isArray(raw?.enabledTools) && raw.enabledTools.length > 0
          ? new Set(raw.enabledTools.map((id) => String(id || "").trim()).filter(Boolean))
          : null;
        const bosunToolIdSet = new Set(
          bosunTools.map((tool) => String(tool?.id || "").trim()).filter(Boolean),
        );
        const hasBosunAllowlist = Boolean(
          enabledSet && [...enabledSet].some((id) => bosunToolIdSet.has(id)),
        );
        const effectiveBosunTools = bosunTools.map((tool) => ({
          ...tool,
          enabled: hasBosunAllowlist ? enabledSet.has(tool.id) : true,
        }));
        jsonResponse(res, 200, {
          ok: true,
          data: {
            ...effective,
            bosunTools: effectiveBosunTools,
            enabledTools: raw?.enabledTools ?? null,
          },
        });
        return;
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        if (!body?.agentId) {
          jsonResponse(res, 400, { ok: false, error: "agentId required" });
          return;
        }
        const result = setAgentToolConfig(repoRoot, body.agentId, {
          enabledTools: body.enabledTools,
          enabledMcpServers: body.enabledMcpServers,
          disabledBuiltinTools: body.disabledBuiltinTools,
        });
        jsonResponse(res, 200, { ok: true, ...result });
        broadcastUiEvent(["library"], "invalidate", { reason: "agent-tools-updated", agentId: body.agentId });
        return;
      }

      jsonResponse(res, 405, { ok: false, error: "method not allowed" });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agent-tools/defaults") {
    try {
      jsonResponse(res, 200, {
        ok: true,
        data: {
          builtinTools: [...DEFAULT_BUILTIN_TOOLS],
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/logs") {
    const lines = Math.min(
      1000,
      Math.max(10, Number(url.searchParams.get("lines") || "200")),
    );
    try {
      const tail = await getLatestLogTail(lines);
      jsonResponse(res, 200, { ok: true, data: tail });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/threads") {
    try {
      const threads = getActiveThreads();
      jsonResponse(res, 200, { ok: true, data: threads });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Workspace Management API ──────────────────────────────────────────────
  if (path === "/api/workspaces") {
    try {
      const configDir = resolveUiConfigDir();
      // Auto-initialize workspaces from disk if config has none yet
      const { workspaces: initialized } = initializeWorkspaces(configDir, { repoRoot });
      const workspaces = initialized.length > 0 ? initialized : listManagedWorkspaces(configDir, { repoRoot });
      const active = getActiveManagedWorkspace(configDir);
      jsonResponse(res, 200, { ok: true, data: workspaces, activeId: active?.id || null });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // Re-scan the $BOSUN_DIR/workspaces/ directory for newly cloned repos / workspaces
  if (path === "/api/workspaces/scan") {
    try {
      const configDir = resolveUiConfigDir();
      const merged = mergeDetectedWorkspaces(configDir);
      jsonResponse(res, 200, {
        ok: true,
        data: merged.workspaces,
        scanned: merged.scanned,
        added: merged.added,
        updated: merged.updated,
      });
      if (merged.added > 0 || merged.updated > 0) {
        broadcastUiEvent(["workspaces"], "invalidate", { reason: "workspace-scan" });
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workspaces/active") {
    try {
      const configDir = resolveUiConfigDir();
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const wsId = String(body?.workspaceId || body?.id || "").trim();
        if (!wsId) {
          jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
          return;
        }
        setActiveManagedWorkspace(configDir, wsId);
        const active = getActiveManagedWorkspace(configDir);
        jsonResponse(res, 200, {
          ok: true,
          activeId: String(active?.id || wsId),
        });
        broadcastUiEvent(["workspaces", "tasks", "overview", "sessions", "workflows", "library"], "invalidate", {
          reason: "workspace-switched",
          workspaceId: wsId,
        });
      } else {
        const active = getActiveManagedWorkspace(configDir);
        jsonResponse(res, 200, { ok: true, data: active });
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workspaces/active/repos") {
    try {
      const configDir = resolveUiConfigDir();
      const active = getActiveManagedWorkspace(configDir);
      if (!active) {
        jsonResponse(res, 200, { ok: true, repos: [] });
        return;
      }
      const repos = Array.isArray(active.repos)
        ? active.repos.map((r) => ({
            name: r.name || r.path || "",
            path: r.path || "",
            primary: Boolean(r.primary),
          }))
        : [];
      jsonResponse(res, 200, { ok: true, repos });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workspaces/create") {
    try {
      const configDir = resolveUiConfigDir();
      const body = await readJsonBody(req);
      const name = body?.name;
      if (!name || !String(name).trim()) {
        jsonResponse(res, 400, { ok: false, error: "name is required" });
        return;
      }
      const ws = createManagedWorkspace(configDir, { name: String(name).trim(), id: body?.id });
      jsonResponse(res, 200, { ok: true, data: ws });
      broadcastUiEvent(["workspaces"], "invalidate", { reason: "workspace-created", workspaceId: ws.id });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workspaces/delete") {
    try {
      const configDir = resolveUiConfigDir();
      const body = await readJsonBody(req);
      const wsId = body?.workspaceId || body?.id;
      if (!wsId) {
        jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
        return;
      }
      const deleted = removeManagedWorkspace(configDir, wsId, { deleteFiles: Boolean(body?.deleteFiles) });
      jsonResponse(res, 200, { ok: true, deleted });
      broadcastUiEvent(["workspaces"], "invalidate", { reason: "workspace-deleted" });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workspaces/repos/add") {
    try {
      const configDir = resolveUiConfigDir();
      const body = await readJsonBody(req);
      const wsId = body?.workspaceId;
      const repoUrl = body?.url;
      if (!wsId || !repoUrl) {
        jsonResponse(res, 400, { ok: false, error: "workspaceId and url required" });
        return;
      }
      const repo = addRepoToWorkspace(configDir, wsId, {
        url: repoUrl,
        name: body?.name,
        branch: body?.branch,
        primary: Boolean(body?.primary),
      });
      jsonResponse(res, 200, { ok: true, data: repo });
      broadcastUiEvent(["workspaces"], "invalidate", { reason: "repo-added", workspaceId: wsId });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workspaces/repos/remove") {
    try {
      const configDir = resolveUiConfigDir();
      const body = await readJsonBody(req);
      const wsId = body?.workspaceId;
      const repoName = body?.repoName || body?.name;
      if (!wsId || !repoName) {
        jsonResponse(res, 400, { ok: false, error: "workspaceId and repoName required" });
        return;
      }
      const removed = removeRepoFromWorkspace(configDir, wsId, repoName, {
        deleteFiles: Boolean(body?.deleteFiles),
      });
      jsonResponse(res, 200, { ok: true, removed });
      broadcastUiEvent(["workspaces"], "invalidate", { reason: "repo-removed", workspaceId: wsId });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workspaces/pull") {
    try {
      const configDir = resolveUiConfigDir();
      const body = await readJsonBody(req);
      const wsId = body?.workspaceId || body?.id;
      if (!wsId) {
        jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
        return;
      }
      const results = pullWorkspaceRepos(configDir, wsId);
      jsonResponse(res, 200, { ok: true, data: results });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workspace-health") {
    try {
      const { runWorkspaceHealthCheck } = await import("../config/config-doctor.mjs");
      const configDir = resolveUiConfigDir();
      const result = runWorkspaceHealthCheck({ configDir });
      jsonResponse(res, 200, { ok: result.ok, data: result });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Workspace State Management API ─────────────────────────────────────────

  if (path === "/api/workspaces/state") {
    try {
      const configDir = resolveUiConfigDir();
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const wsId = body?.workspaceId || body?.id;
        const state = body?.state;
        if (!wsId || !state) {
          jsonResponse(res, 400, { ok: false, error: "workspaceId and state required" });
          return;
        }
        if (!["active", "paused", "disabled"].includes(state)) {
          jsonResponse(res, 400, { ok: false, error: "state must be active, paused, or disabled" });
          return;
        }
        setWorkspaceState(configDir, wsId, state);
        const summary = getWorkspaceStateSummary(configDir);
        jsonResponse(res, 200, { ok: true, data: summary });
        broadcastUiEvent(["workspaces"], "invalidate", { reason: "state-changed", workspaceId: wsId, state });
      } else {
        const summary = getWorkspaceStateSummary(configDir);
        jsonResponse(res, 200, { ok: true, data: summary });
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workspaces/executors") {
    try {
      const configDir = resolveUiConfigDir();
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const wsId = body?.workspaceId || body?.id;
        if (!wsId) {
          jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
          return;
        }
        const opts = {};
        if (body?.maxConcurrent !== undefined) opts.maxConcurrent = Number(body.maxConcurrent);
        if (body?.pool !== undefined) opts.pool = String(body.pool);
        if (body?.weight !== undefined) opts.weight = Number(body.weight);
        const result = setWorkspaceExecutors(configDir, wsId, opts);
        jsonResponse(res, 200, { ok: true, data: result });
        broadcastUiEvent(["workspaces"], "invalidate", { reason: "executors-changed", workspaceId: wsId });
      } else {
        const wsId = url.searchParams.get("workspaceId") || url.searchParams.get("id");
        if (!wsId) {
          jsonResponse(res, 400, { ok: false, error: "workspaceId query param required" });
          return;
        }
        const ws = getManagedWorkspace(configDir, wsId);
        jsonResponse(res, 200, { ok: true, data: ws?.executors || null });
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workspaces/workflows") {
    try {
      const configDir = resolveUiConfigDir();
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const wsId = body?.workspaceId || body?.id;
        if (!wsId) {
          jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
          return;
        }
        const ws = getManagedWorkspace(configDir, wsId);
        if (!ws) {
          jsonResponse(res, 404, { ok: false, error: "Workspace not found" });
          return;
        }
        // Update enabledWorkflows / disabledWorkflows in workspace config
        const { configPath, configData: config } = readConfigDocument();
        const workspaces = Array.isArray(config.workspaces) ? config.workspaces : [];
        const target = workspaces.find((w) => (w.id || "").toLowerCase() === wsId.toLowerCase());
        if (target) {
          if (body.enabledWorkflows !== undefined) target.enabledWorkflows = body.enabledWorkflows;
          if (body.disabledWorkflows !== undefined) target.disabledWorkflows = body.disabledWorkflows;
          writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
        }
        jsonResponse(res, 200, { ok: true });
        broadcastUiEvent(["workspaces"], "invalidate", { reason: "workflows-changed", workspaceId: wsId });
      } else {
        const wsId = url.searchParams.get("workspaceId") || url.searchParams.get("id");
        if (!wsId) {
          jsonResponse(res, 400, { ok: false, error: "workspaceId query param required" });
          return;
        }
        const ws = getManagedWorkspace(configDir, wsId);
        jsonResponse(res, 200, {
          ok: true,
          data: {
            enabledWorkflows: ws?.enabledWorkflows || [],
            disabledWorkflows: ws?.disabledWorkflows || [],
          },
        });
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/worktrees") {
    try {
      const worktrees = listActiveWorktrees(repoRoot);
      const stats = await getWorktreeStats(repoRoot);
      const recovery = await readWorktreeRecoveryState(repoRoot);
      jsonResponse(res, 200, {
        ok: true,
        data: worktrees,
        stats: {
          ...stats,
          recovery,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/worktrees/peek") {
    try {
      const pathParam = url.searchParams.get("path") || "";
      const branch = url.searchParams.get("branch") || "";
      const taskKey = url.searchParams.get("taskKey") || url.searchParams.get("task") || "";
      const worktrees = listActiveWorktrees(repoRoot);
      const target = findWorktreeMatch(worktrees, { path: pathParam, branch, taskKey });
      if (!target) {
        jsonResponse(res, 404, { ok: false, error: "Worktree not found" });
        return;
      }
      const detail = await buildWorktreePeek(target);
      jsonResponse(res, 200, { ok: true, data: detail });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/worktrees/prune") {
    try {
      const result = await pruneStaleWorktrees({ actor: "telegram-ui" });
      jsonResponse(res, 200, { ok: true, data: result });
      broadcastUiEvent(["worktrees"], "invalidate", {
        reason: "worktrees-pruned",
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/worktrees/release") {
    try {
      const body = await readJsonBody(req);
      const taskKey = body?.taskKey || body?.key;
      const branch = body?.branch;
      let released = null;
      if (taskKey) {
        released = await releaseWorktree(repoRoot, taskKey);
      } else if (branch) {
        released = await releaseWorktreeByBranch(repoRoot, branch);
      } else {
        jsonResponse(res, 400, {
          ok: false,
          error: "taskKey or branch required",
        });
        return;
      }
      jsonResponse(res, 200, { ok: true, data: released });
      broadcastUiEvent(["worktrees"], "invalidate", {
        reason: "worktree-released",
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/presence") {
    try {
      await ensurePresenceLoaded();
      const instances = listActiveInstances({ ttlMs: PRESENCE_TTL_MS });
      const coordinator = selectCoordinator({ ttlMs: PRESENCE_TTL_MS });
      jsonResponse(res, 200, { ok: true, data: { instances, coordinator } });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/shared-workspaces") {
    try {
      const registry = await loadSharedWorkspaceRegistry();
      const sweep = await sweepExpiredLeases({
        registry,
        actor: "telegram-ui",
      });
      const availability = getSharedAvailabilityMap(sweep.registry);
      jsonResponse(res, 200, {
        ok: true,
        data: sweep.registry,
        availability,
        expired: sweep.expired || [],
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/shared-workspaces/claim") {
    try {
      const body = await readJsonBody(req);
      const workspaceId = body?.workspaceId || body?.id;
      if (!workspaceId) {
        jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
        return;
      }
      const result = await claimSharedWorkspace({
        workspaceId,
        owner: body?.owner,
        ttlMinutes: body?.ttlMinutes,
        note: body?.note,
        actor: "telegram-ui",
      });
      if (result.error) {
        jsonResponse(res, 400, { ok: false, error: result.error });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        data: result.workspace,
        lease: result.lease,
      });
      broadcastUiEvent(["workspaces"], "invalidate", {
        reason: "workspace-claimed",
        workspaceId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/shared-workspaces/release") {
    try {
      const body = await readJsonBody(req);
      const workspaceId = body?.workspaceId || body?.id;
      if (!workspaceId) {
        jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
        return;
      }
      const result = await releaseSharedWorkspace({
        workspaceId,
        owner: body?.owner,
        force: body?.force,
        reason: body?.reason,
        actor: "telegram-ui",
      });
      if (result.error) {
        jsonResponse(res, 400, { ok: false, error: result.error });
        return;
      }
      jsonResponse(res, 200, { ok: true, data: result.workspace });
      broadcastUiEvent(["workspaces"], "invalidate", {
        reason: "workspace-released",
        workspaceId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/shared-workspaces/renew") {
    try {
      const body = await readJsonBody(req);
      const workspaceId = body?.workspaceId || body?.id;
      if (!workspaceId) {
        jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
        return;
      }
      const result = await renewSharedWorkspaceLease({
        workspaceId,
        owner: body?.owner,
        ttlMinutes: body?.ttlMinutes,
        actor: "telegram-ui",
      });
      if (result.error) {
        jsonResponse(res, 400, { ok: false, error: result.error });
        return;
      }
      jsonResponse(res, 200, {
        ok: true,
        data: result.workspace,
        lease: result.lease,
      });
      broadcastUiEvent(["workspaces"], "invalidate", {
        reason: "workspace-renewed",
        workspaceId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agent-logs") {
    try {
      const file = normalizeAgentLogName(url.searchParams.get("file"));
      const query = url.searchParams.get("query") || "";
      const lines = Math.min(
        1000,
        Math.max(20, Number(url.searchParams.get("lines") || "200")),
      );
      if (!file) {
        const files = await listAgentLogFiles(query);
        jsonResponse(res, 200, { ok: true, data: files });
        return;
      }
      const agentLogsDir = await resolveAgentLogsDir();
      const filePath = resolve(agentLogsDir, file);
      if (!filePath.startsWith(agentLogsDir)) {
        jsonResponse(res, 403, { ok: false, error: "Forbidden" });
        return;
      }
      if (!existsSync(filePath)) {
        jsonResponse(res, 404, { ok: false, error: "Log not found" });
        return;
      }
      const tail = await tailFile(filePath, lines);
      jsonResponse(res, 200, { ok: true, data: tail });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/telemetry/summary") {
    try {
      const days = Number(url.searchParams.get("days") || "7");
      const logDir = resolveAgentWorkLogDir();
      const metricsPath = resolve(logDir, "agent-metrics.jsonl");
      const metrics = await readJsonlTail(metricsPath, 100_000, 50_000_000);
      const summary = summarizeTelemetry(metrics, days) || {};

      // Read lifetime totals from the full JSONL log (not the capped in-memory state)
      // so the count is accurate even when sessions exceed the in-memory cap.
      const { entries: allSessions } = await readCompletedSessionEntries(200_000);
      const lifetimeTotals = allSessions.reduce(
        (acc, session) => {
          acc.attemptsCount += 1;
          acc.tokenCount += Number(session?.tokenCount || 0);
          acc.inputTokens += Number(session?.inputTokens || 0);
          acc.outputTokens += Number(session?.outputTokens || 0);
          acc.durationMs += Math.max(0, Number(session?.durationMs || 0));
          return acc;
        },
        { attemptsCount: 0, tokenCount: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      );

      // Supplement token counts from agent-metrics.jsonl which has actual LLM usage data
      // (prompt_tokens, completion_tokens, total_tokens) that the session log may lack.
      if (lifetimeTotals.tokenCount <= 0 && metrics.length > 0) {
        let metricsTokens = 0;
        let metricsInputTokens = 0;
        let metricsOutputTokens = 0;
        for (const m of metrics) {
          const met = m?.metrics || m;
          metricsTokens += Number(met?.total_tokens || 0);
          metricsInputTokens += Number(met?.prompt_tokens || 0);
          metricsOutputTokens += Number(met?.completion_tokens || 0);
        }
        lifetimeTotals.tokenCount = metricsTokens;
        lifetimeTotals.inputTokens = metricsInputTokens;
        lifetimeTotals.outputTokens = metricsOutputTokens;
      }

      summary.lifetimeTotals = lifetimeTotals;
      jsonResponse(res, 200, { ok: true, data: summary });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/telemetry/errors") {
    try {
      const days = Number(url.searchParams.get("days") || "7");
      const logDir = resolveAgentWorkLogDir();
      const errorsPath = resolve(logDir, "agent-errors.jsonl");
      const errors = (await readJsonlTail(errorsPath, 2000)).filter((e) =>
        withinDays(e, days),
      );
      const byFingerprint = new Map();
      for (const e of errors) {
        const fp = e.data?.error_fingerprint || e.data?.error_message || "unknown";
        byFingerprint.set(fp, (byFingerprint.get(fp) || 0) + 1);
      }
      const top = [...byFingerprint.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([fingerprint, count]) => ({ fingerprint, count }));
      jsonResponse(res, 200, { ok: true, data: top });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/telemetry/executors") {
    try {
      const days = Number(url.searchParams.get("days") || "7");
      const logDir = resolveAgentWorkLogDir();
      const metricsPath = resolve(logDir, "agent-metrics.jsonl");
      const metrics = await readJsonlTail(metricsPath, 3000);
      const summary = summarizeTelemetry(metrics, days);
      jsonResponse(res, 200, {
        ok: true,
        data: summary?.executors || {},
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/telemetry/alerts") {
    try {
      const days = Number(url.searchParams.get("days") || "7");
      const logDir = resolveAgentWorkLogDir();
      const alertsPath = resolve(logDir, "agent-alerts.jsonl");
      const alerts = (await readJsonlTail(alertsPath, 500)).filter((a) =>
        withinDays(a, days),
      );
      jsonResponse(res, 200, {
        ok: true,
        data: alerts.slice(-50),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/telemetry/shredding") {
    try {
      const days = Number(url.searchParams.get("days") || "30");
      const includeSynthetic = /^(1|true|yes)$/i.test(String(url.searchParams.get("includeSynthetic") || "").trim());
      const includeNoop = /^(1|true|yes)$/i.test(String(url.searchParams.get("includeNoop") || "").trim());
      const shreddingPath = resolve(
        resolveAgentWorkLogDir(),
        "shredding-stats.jsonl",
      );
      const [{ entries: completedSessions }, raw] = await Promise.all([
        readCompletedSessionEntries(100_000),
        readJsonlTail(shreddingPath, 10_000),
      ]);
      const inWindow = raw.filter((e) => withinDays(e, days));
      let excludedSynthetic = 0;
      let excludedNoop = 0;
      const events = [];
      for (const entry of inWindow) {
        const normalizedEntry = {
          ...entry,
          agentType: normalizeShreddingAgentType(entry?.agentType),
        };
        if (!includeSynthetic && isLikelySyntheticShreddingEvent(normalizedEntry)) {
          excludedSynthetic++;
          continue;
        }
        if (!includeNoop && !isEffectiveShreddingEvent(normalizedEntry)) {
          excludedNoop++;
          continue;
        }
        events.push(normalizedEntry);
      }

      let totalEvents = events.length;
      let totalOriginalChars = 0;
      let totalCompressedChars = 0;
      let totalSavedChars = 0;
      let totalOriginalTokensEstimated = 0;
      let totalCompressedTokensEstimated = 0;
      let totalSavedTokensEstimated = 0;
      const dailySaved = {};
      const dailyOriginal = {};
      const dailyCompressed = {};
      const dailySavedTokensEstimated = {};
      const dailyCostSavedUsd = {};
      const dailyCounts = {};
      const agentCounts = {};
      const stageCounts = {};
      const compactionFamilyCounts = {};
      const commandFamilyCounts = {};
      let unknownAttribution = 0;
      let liveTotalEvents = 0;
      let liveOriginalChars = 0;
      let liveCompressedChars = 0;
      let liveSavedChars = 0;
      let liveSavedTokensEstimated = 0;
      const sessionCostModel = summarizeObservedSessionCostModel(
        completedSessions.filter((entry) => withinDays(entry, days)),
      );
      const blendedCostPerToken = sessionCostModel.blendedCostPerToken;

      for (const e of events) {
        const originalChars = numberOrZero(e.originalChars);
        const compressedChars = numberOrZero(e.compressedChars);
        const savedChars = numberOrZero(e.savedChars);
        const originalTokensEstimated = estimateTokensFromChars(originalChars);
        const compressedTokensEstimated = estimateTokensFromChars(compressedChars);
        const savedTokensEstimated = estimateTokensFromChars(savedChars);
        const estimatedCostSavedUsd = blendedCostPerToken != null
          ? roundMetric(savedTokensEstimated * blendedCostPerToken)
          : null;
        totalOriginalChars += originalChars;
        totalCompressedChars += compressedChars;
        totalSavedChars += savedChars;
        totalOriginalTokensEstimated += originalTokensEstimated;
        totalCompressedTokensEstimated += compressedTokensEstimated;
        totalSavedTokensEstimated += savedTokensEstimated;
        const day = getEntryDayKey(e);
        if (day) {
          dailyOriginal[day] = (dailyOriginal[day] || 0) + originalChars;
          dailyCompressed[day] = (dailyCompressed[day] || 0) + compressedChars;
          dailySaved[day] = (dailySaved[day] || 0) + savedChars;
          dailySavedTokensEstimated[day] = (dailySavedTokensEstimated[day] || 0) + savedTokensEstimated;
          if (estimatedCostSavedUsd != null) {
            dailyCostSavedUsd[day] = roundMetric((dailyCostSavedUsd[day] || 0) + estimatedCostSavedUsd);
          }
          dailyCounts[day] = (dailyCounts[day] || 0) + 1;
        }
        const agent = normalizeShreddingAgentType(e.agentType);
        if (agent === "unspecified") unknownAttribution++;
        agentCounts[agent] = (agentCounts[agent] || 0) + 1;

        const stage = String(e.stage || "session_total").trim().toLowerCase() || "session_total";
        stageCounts[stage] = (stageCounts[stage] || 0) + 1;
        if (stage === "live_tool_compaction") {
          liveTotalEvents += 1;
          liveOriginalChars += originalChars;
          liveCompressedChars += compressedChars;
          liveSavedChars += savedChars;
          liveSavedTokensEstimated += savedTokensEstimated;
          const compactionFamily = String(e.compactionFamily || "unknown").trim().toLowerCase() || "unknown";
          const commandFamily = String(e.commandFamily || "unknown").trim().toLowerCase() || "unknown";
          compactionFamilyCounts[compactionFamily] = (compactionFamilyCounts[compactionFamily] || 0) + 1;
          commandFamilyCounts[commandFamily] = (commandFamilyCounts[commandFamily] || 0) + 1;
        }
      }

      const avgSavedPct = totalOriginalChars > 0
        ? Math.round((totalSavedChars / totalOriginalChars) * 100)
        : 0;
      const liveAvgSavedPct = liveOriginalChars > 0
        ? Math.round((liveSavedChars / liveOriginalChars) * 100)
        : 0;

      const sortedDates = Object.keys(dailySaved).sort();
      const topAgents = Object.entries(agentCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({ name, count }));
      const topCompactionFamilies = Object.entries(compactionFamilyCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({ name, count }));
      const topCommandFamilies = Object.entries(commandFamilyCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({ name, count }));

      const recentEvents = events.slice(-20).reverse().map((e) => ({
        timestamp: e.timestamp,
        savedChars: numberOrZero(e.savedChars),
        savedPct: numberOrZero(e.savedPct),
        originalChars: numberOrZero(e.originalChars),
        compressedChars: numberOrZero(e.compressedChars),
        estimatedSavedTokens: estimateTokensFromChars(numberOrZero(e.savedChars)),
        estimatedCostSavedUsd: blendedCostPerToken != null
          ? roundMetric(estimateTokensFromChars(numberOrZero(e.savedChars)) * blendedCostPerToken)
          : null,
        agentType: normalizeShreddingAgentType(e.agentType),
        attemptId: e.attemptId || null,
        stage: String(e.stage || "session_total").trim().toLowerCase() || "session_total",
        compactionFamily: String(e.compactionFamily || "").trim().toLowerCase() || null,
        commandFamily: String(e.commandFamily || "").trim().toLowerCase() || null,
      }));
      const dailyReductionPct = {};
      for (const day of Object.keys(dailyOriginal)) {
        const originalChars = numberOrZero(dailyOriginal[day]);
        const savedChars = numberOrZero(dailySaved[day]);
        dailyReductionPct[day] = originalChars > 0
          ? Math.round((savedChars / originalChars) * 100)
          : 0;
      }
      const totalEstimatedCostSavedUsd = blendedCostPerToken != null
        ? roundMetric(totalSavedTokensEstimated * blendedCostPerToken)
        : null;

      jsonResponse(res, 200, {
        ok: true,
        data: {
          totalEvents,
          totalOriginalChars,
          totalCompressedChars,
          totalSavedChars,
          avgSavedPct,
          sortedDates,
          dailyOriginal,
          dailyCompressed,
          dailySaved,
          dailySavedTokensEstimated,
          dailyCostSavedUsd,
          dailyReductionPct,
          dailyCounts,
          topAgents,
          stageCounts,
          topCompactionFamilies,
          topCommandFamilies,
          totals: {
            originalTokensEstimated: totalOriginalTokensEstimated,
            compressedTokensEstimated: totalCompressedTokensEstimated,
            savedTokensEstimated: totalSavedTokensEstimated,
            estimatedCostSavedUsd: totalEstimatedCostSavedUsd,
          },
          estimation: {
            charsPerToken: SHREDDING_ESTIMATED_CHARS_PER_TOKEN,
            costModel: blendedCostPerToken != null ? "observed_blended_session_cost" : "unavailable",
            blendedCostPerMillionTokensUsd: sessionCostModel.blendedCostPerMillionTokensUsd,
            pricedSessions: sessionCostModel.pricedSessions,
          },
          liveCompaction: {
            totalEvents: liveTotalEvents,
            totalOriginalChars: liveOriginalChars,
            totalCompressedChars: liveCompressedChars,
            totalSavedChars: liveSavedChars,
            savedTokensEstimated: liveSavedTokensEstimated,
            avgSavedPct: liveAvgSavedPct,
          },
          recentEvents,
          diagnostics: {
            rawEvents: inWindow.length,
            excludedSynthetic,
            excludedNoop,
            unknownAttribution,
            includeSynthetic,
            includeNoop,
            pricedSessions: sessionCostModel.pricedSessions,
          },
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/analytics/usage") {
    try {
      const days = Number(url.searchParams.get("days") || "30");
      const data = await buildUsageAnalytics(days || 0);
      jsonResponse(res, 200, { ok: true, data });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agent-logs/context") {
    try {
      const query = url.searchParams.get("query") || "";
      if (!query) {
        jsonResponse(res, 400, { ok: false, error: "query required" });
        return;
      }
      const worktreeDir = resolve(repoRoot, ".cache", "worktrees");
      const dirs = await readdir(worktreeDir).catch(() => []);
      const matches = dirs.filter((d) =>
        d.toLowerCase().includes(query.toLowerCase()),
      );
      if (matches.length === 0) {
        jsonResponse(res, 200, { ok: true, data: { matches: [] } });
        return;
      }
      const wtName = matches[0];
      const wtPath = resolve(worktreeDir, wtName);
      let gitLog = "";
      let gitStatus = "";
      let diffStat = "";
      try {
        gitLog = execSync("git log --oneline -5 2>&1", {
          cwd: wtPath,
          encoding: "utf8",
          timeout: 10000,
        }).trim();
      } catch {
        gitLog = "";
      }
      try {
        gitStatus = execSync("git status --short 2>&1", {
          cwd: wtPath,
          encoding: "utf8",
          timeout: 10000,
        }).trim();
      } catch {
        gitStatus = "";
      }
      try {
        const branch = execSync("git branch --show-current 2>&1", {
          cwd: wtPath,
          encoding: "utf8",
          timeout: 5000,
        }).trim();
        diffStat = execSync(`git diff --stat main...${branch} 2>&1`, {
          cwd: wtPath,
          encoding: "utf8",
          timeout: 10000,
        }).trim();
      } catch {
        diffStat = "";
      }
      jsonResponse(res, 200, {
        ok: true,
        data: {
          name: wtName,
          path: wtPath,
          gitLog,
          gitStatus,
          diffStat,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agents") {
    try {
      const executor = uiDeps.getInternalExecutor?.();
      const agents = [];
      if (executor) {
        const status = executor.getStatus();
        for (const slot of status.slots || []) {
          if (slot.taskId) {
            agents.push({
              id: slot.taskId,
              status: slot.status || "busy",
              taskTitle: slot.taskTitle || slot.taskId,
              branch: slot.branch || null,
              startedAt: slot.startedAt || null,
              completedCount: slot.completedCount || 0,
            });
          }
        }
      }
      jsonResponse(res, 200, { ok: true, data: agents });
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: [] });
    }
    return;
  }

  if (path === "/api/infra") {
    try {
      const executor = uiDeps.getInternalExecutor?.();
      const status = executor?.getStatus?.() || {};
      const worktreeRecovery = await readWorktreeRecoveryState(repoRoot);
      const data = {
        executor: {
          mode: uiDeps.getExecutorMode?.() || "internal",
          maxParallel: status.maxParallel || 0,
          activeSlots: status.activeSlots || 0,
          paused: executor?.isPaused?.() || false,
        },
        worktreeRecovery,
        system: {
          uptime: process.uptime(),
          memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
          nodeVersion: process.version,
          platform: process.platform,
        },
      };
      jsonResponse(res, 200, { ok: true, data });
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: null });
    }
    return;
  }

  if (path === "/api/agent-logs/tail") {
    try {
      const fileParam = url.searchParams.get("file") || "";
      const query = url.searchParams.get("query") || "";
      const lines = Math.min(
        1000,
        Math.max(20, Number(url.searchParams.get("lines") || "100")),
      );
      const agentLogsDir = await resolveAgentLogsDir();
      // Prefer an explicit file name; fall back to query-based latest-file lookup
      let fileName = fileParam;
      if (!fileName) {
        const files = await listAgentLogFiles(query);
        if (!files.length) {
          jsonResponse(res, 200, { ok: true, data: null });
          return;
        }
        fileName = files[0].name || files[0];
      }
      const filePath = resolve(agentLogsDir, normalizeAgentLogName(fileName));
      if (!filePath.startsWith(agentLogsDir) || !existsSync(filePath)) {
        jsonResponse(res, 200, { ok: true, data: null });
        return;
      }
      const tail = await tailFile(filePath, Math.max(lines * 4, 240));
      const filteredLines = filterRelevantLogLines(tail?.lines || [], query || fileName, lines);
      const contentLines = filteredLines.length ? filteredLines : (tail?.lines || []).slice(-lines);
      jsonResponse(res, 200, {
        ok: true,
        data: {
          file: fileName,
          content: contentLines.join("\n"),
          lines: contentLines,
          mode: filteredLines.length ? "focused" : "tail",
          totalLines: Array.isArray(tail?.lines) ? tail.lines.length : 0,
          truncated: tail?.truncated === true,
        },
      });
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: null });
    }
    return;
  }

  if (path === "/api/agent-context") {
    try {
      const query = url.searchParams.get("query") || "";
      if (!query) {
        jsonResponse(res, 200, { ok: true, data: null });
        return;
      }
      const queryLower = query.toLowerCase();
      const worktreeDir = resolve(repoRoot, ".cache", "worktrees");

      const worktreeMatches = [];
      let matchedWorktree = null;
      try {
        const active = await listActiveWorktrees(repoRoot);
        for (const wt of active || []) {
          const branch = String(wt.branch || "").toLowerCase();
          const taskKey = String(wt.taskKey || "").toLowerCase();
          const name = String(wt.name || wt.branch || "").toLowerCase();
          if (
            branch.includes(queryLower) ||
            taskKey === queryLower ||
            taskKey.includes(queryLower) ||
            name.includes(queryLower)
          ) {
            matchedWorktree = wt;
            worktreeMatches.push(wt.branch || wt.taskKey || wt.path || wt.name || "");
            break;
          }
        }
      } catch {
        /* best effort */
      }

      let wtName = matchedWorktree?.name || "";
      let wtPath = matchedWorktree?.path || "";

      if (!wtPath) {
        const dirs = await readdir(worktreeDir).catch(() => []);
        const directMatches = dirs.filter((d) => d.toLowerCase().includes(queryLower));
        const shortQuery = queryLower.length > 8 ? queryLower.slice(0, 8) : "";
        const shortMatches = shortQuery
          ? dirs.filter((d) => d.toLowerCase().includes(shortQuery))
          : [];
        const matches = directMatches.length ? directMatches : shortMatches;
        if (!matches.length) {
          jsonResponse(res, 200, { ok: true, data: { matches: [], context: null } });
          return;
        }
        wtName = matches[0];
        wtPath = resolve(worktreeDir, wtName);
        worktreeMatches.push(...matches);
      }
      const runWtGit = (args) => {
        try {
          return execSync(`git ${args}`, { cwd: wtPath, encoding: "utf8", timeout: 5000 }).trim();
        } catch { return ""; }
      };
      const gitLog = runWtGit("log --oneline -10");
      const gitLogDetailed = runWtGit("log --format=%h||%D||%s||%cr -10");
      const gitStatus = runWtGit("status --porcelain");
      const gitBranch = runWtGit("rev-parse --abbrev-ref HEAD");
      const gitDiffStat = runWtGit("diff --stat");
      const gitAheadBehind = runWtGit("rev-list --left-right --count HEAD...@{upstream} 2>/dev/null");
      const changedFiles = gitStatus
        ? gitStatus
            .split("\n")
            .filter(Boolean)
            .map((line) => ({
              code: line.substring(0, 2).trim() || "?",
              file: line.substring(3).trim(),
            }))
        : [];
      const commitRows = gitLogDetailed
        ? gitLogDetailed.split("\n").filter(Boolean).map((line) => {
            const parts = line.split("||");
            // format: hash || refs (may be empty) || subject || relative-time
            const [hash, refs, message, time] =
              parts.length >= 4
                ? parts
                : [parts[0], "", parts[1] || "", parts[2] || ""];
            return { hash, refs: refs || "", message: message || "", time: time || "" };
          })
        : [];
      const sessionTracker = getSessionTracker();
      const sessions = sessionTracker?.listAllSessions?.() || [];
      let session =
        sessions.find((s) => String(s.id || "").toLowerCase() === queryLower) ||
        sessions.find((s) => String(s.taskId || "").toLowerCase() === queryLower);
      if (!session && matchedWorktree?.taskKey) {
        const taskKey = String(matchedWorktree.taskKey || "").toLowerCase();
        session =
          sessions.find((s) => String(s.id || "").toLowerCase() === taskKey) ||
          sessions.find((s) => String(s.taskId || "").toLowerCase() === taskKey);
      }
      if (!session && queryLower.length > 8) {
        const short = queryLower.slice(0, 8);
        session = sessions.find(
          (s) =>
            String(s.id || "").toLowerCase().includes(short) ||
            String(s.taskId || "").toLowerCase().includes(short),
        );
      }
      const fullSession =
        session && typeof sessionTracker?.getSessionMessages === "function"
          ? sessionTracker.getSessionMessages(session.id || session.taskId)
          : null;
      const actionHistory = [];
      const fileAccessMap = new Map();
      const fileAccessCounts = { read: 0, write: 0, other: 0 };
      const filePattern = /([a-zA-Z0-9_./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|json|md|mdx|css|scss|less|html|yml|yaml|toml|env|lock|go|rs|py|sh|ps1|psm1|txt|sql))/g;
      const classifyActionKind = (toolName, detail) => {
        const toolLower = String(toolName || "").toLowerCase();
        const cmdLower = String(detail || "").toLowerCase();
        if (toolLower.includes("apply_patch") || toolLower.includes("write")) return "write";
        if (/\b(rg|cat|sed|ls|stat|head|tail|grep|find)\b/.test(cmdLower)) return "read";
        return "other";
      };
      const addFileAccess = (path, kind) => {
        if (!path) return;
        const entry = fileAccessMap.get(path) || { path, kinds: new Set() };
        if (!entry.kinds.has(kind)) {
          entry.kinds.add(kind);
          if (fileAccessCounts[kind] != null) fileAccessCounts[kind] += 1;
          else fileAccessCounts.other += 1;
        }
        fileAccessMap.set(path, entry);
      };

      const messages = fullSession?.messages || [];
      const recentMessages = messages.slice(-50);
      for (const msg of recentMessages) {
        if (!msg || !msg.type) continue;
        if (msg.type === "tool_call" || msg.type === "tool_result" || msg.type === "error") {
          actionHistory.push({
            type: msg.type,
            tool: msg.meta?.toolName || (msg.type === "tool_result" ? "RESULT" : "TOOL"),
            detail: msg.content || "",
            content: msg.content || "",
            timestamp: msg.timestamp || null,
          });
        }
        if (msg.type === "tool_call" && msg.content) {
          const kind = classifyActionKind(msg.meta?.toolName, msg.content);
          const matches = msg.content.matchAll(filePattern);
          for (const match of matches) {
            const file = match?.[1];
            if (file) addFileAccess(file, kind);
          }
        }
      }
      for (const file of changedFiles) {
        if (file?.file) addFileAccess(file.file, "write");
      }
      const fileAccessSummary = fileAccessMap.size
        ? {
            files: Array.from(fileAccessMap.values()).map((entry) => ({
              path: entry.path,
              kinds: Array.from(entry.kinds),
            })),
            counts: fileAccessCounts,
          }
        : null;
      jsonResponse(res, 200, {
        ok: true,
        data: {
          matches: worktreeMatches,
          session: session || null,
          actionHistory,
          fileAccessSummary,
          context: {
            name: wtName,
            path: wtPath,
            gitLog,
            gitLogDetailed,
            gitStatus,
            gitBranch,
            gitDiffStat,
            gitAheadBehind,
            changedFiles,
            diffSummary: gitDiffStat,
            recentCommits: commitRows,
          },
        },
      });
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: null });
    }
    return;
  }

  if (path === "/api/git/branches") {
    try {
      const raw = runGit("branch -a --sort=-committerdate", 15000);
      const lines = raw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      jsonResponse(res, 200, { ok: true, data: lines.slice(0, 40) });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/git/branch-detail") {
    try {
      const rawBranch = url.searchParams.get("branch") || "";
      const cleaned = rawBranch.replace(/^\*\s*/, "").trim();
      const safe = cleaned.replace(/^remotes\//, "").replace(/[^\w./-]/g, "");
      if (!safe) {
        jsonResponse(res, 400, { ok: false, error: "branch is required" });
        return;
      }
      const hasRef = (ref) => {
        try {
          execSync(`git show-ref --verify --quiet ${ref}`, {
            cwd: repoRoot,
            timeout: 5000,
            stdio: "ignore",
          });
          return true;
        } catch {
          return false;
        }
      };
      const baseRef =
        (hasRef("refs/heads/main") && "main") ||
        (hasRef("refs/remotes/origin/main") && "origin/main") ||
        (hasRef("refs/heads/master") && "master") ||
        (hasRef("refs/remotes/origin/master") && "origin/master") ||
        null;
      const diffRange = baseRef ? `${baseRef}...${safe}` : `${safe}~1..${safe}`;
      const commitsRaw = runGit(`log ${safe} --format=%h||%s||%cr -20`, 15000);
      const commits = commitsRaw
        ? commitsRaw.split("\n").filter(Boolean).map((line) => {
            const [hash, message, time] = line.split("||");
            return { hash, message, time };
          })
        : [];
      const commitListRaw = runGit(
        `log ${safe} --format=%H||%h||%an||%ae||%ad||%s --date=iso-strict -20`,
        15000,
      );
      const commitList = commitListRaw
        ? commitListRaw.split("\n").filter(Boolean).map((line) => {
            const [hash, short, authorName, authorEmail, authorDate, subject] = line.split("||");
            return {
              hash,
              short,
              authorName,
              authorEmail,
              authorDate,
              subject,
            };
          })
        : [];
      const diffStat = runGit(`diff --stat ${diffRange}`, 15000);
      const filesRaw = runGit(`diff --name-only ${diffRange}`, 15000);
      const files = filesRaw ? filesRaw.split("\n").filter(Boolean) : [];
      const numstatRaw = runGit(`diff --numstat ${diffRange}`, 15000);
      const parseNumstat = (raw) => {
        if (!raw) return [];
        const entries = [];
        for (const line of raw.split("\n")) {
          if (!line.trim()) continue;
          const parts = line.split("\t");
          if (parts.length < 3) continue;
          const [addRaw, delRaw, ...fileParts] = parts;
          const file = fileParts.join("\t");
          if (!file) continue;
          if (addRaw === "-" && delRaw === "-") {
            entries.push({ file, additions: 0, deletions: 0, binary: true });
          } else {
            entries.push({
              file,
              additions: parseInt(addRaw, 10) || 0,
              deletions: parseInt(delRaw, 10) || 0,
              binary: false,
            });
          }
        }
        return entries;
      };
      const filesChanged = parseNumstat(numstatRaw);
      const diffSummary = filesChanged.length
        ? {
            totalFiles: filesChanged.length,
            totalAdditions: filesChanged.reduce((sum, f) => sum + (f.additions || 0), 0),
            totalDeletions: filesChanged.reduce((sum, f) => sum + (f.deletions || 0), 0),
            binaryFiles: filesChanged.reduce((sum, f) => sum + (f.binary ? 1 : 0), 0),
          }
        : null;

      let worktree = null;
      try {
        const active = await listActiveWorktrees(repoRoot);
        const match = (active || []).find((wt) => {
          const branch = String(wt.branch || "").replace(/^refs\/heads\//, "");
          return branch === safe || branch === cleaned || branch.endsWith(`/${safe}`);
        });
        if (match) {
          worktree = {
            path: match.path,
            taskKey: match.taskKey || null,
            branch: match.branch || safe,
            status: match.status || null,
          };
        }
      } catch {
        /* best effort */
      }

      let activeSlot = null;
      const executor = uiDeps.getInternalExecutor?.();
      if (executor?.getStatus) {
        const status = executor.getStatus();
        const slotMatch = (status?.slots || []).find((s) => {
          const slotBranch = String(s.branch || "").replace(/^refs\/heads\//, "");
          return slotBranch === safe || slotBranch === cleaned || slotBranch.endsWith(`/${safe}`);
        });
        if (slotMatch) {
          activeSlot = slotMatch;
        }
      }
      const workspaceTarget =
        activeSlot || worktree
          ? {
              taskId: activeSlot?.taskId || worktree?.taskKey || null,
              taskTitle: activeSlot?.taskTitle || worktree?.taskKey || safe,
              branch: worktree?.branch || safe,
              workspacePath: worktree?.path || null,
            }
          : null;
      const workspaceLink = workspaceTarget
        ? {
            label: workspaceTarget.taskTitle || workspaceTarget.branch || safe,
            taskTitle: workspaceTarget.taskTitle,
            branch: workspaceTarget.branch,
            workspacePath: workspaceTarget.workspacePath,
            target: workspaceTarget,
          }
        : null;

      jsonResponse(res, 200, {
        ok: true,
        data: {
          branch: safe,
          base: baseRef,
          commits,
          commitList,
          diffStat,
          files,
          filesChanged,
          filesDetailed: filesChanged,
          diffSummary,
          worktree,
          activeSlot,
          workspaceTarget,
          workspaceLink,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/git/diff") {
    try {
      const diff = runGit("diff --stat HEAD", 15000);
      jsonResponse(res, 200, { ok: true, data: diff });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/recent-commits") {
    try {
      // Return structured objects {hash,message,author,date} using a richer git format.
      // Falls back to parsing --oneline strings if the richer format fails.
      const proc = spawnSync(
        "git",
        ["log", "--format=%H\x1f%s\x1f%an\x1f%aI", "--max-count=6"],
        { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
      );
      if (proc.status === 0 && (proc.stdout || "").trim()) {
        const commits = proc.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const [hash, message, author, date] = line.split("\x1f");
            return { hash: (hash || "").slice(0, 7), message: message || "", author: author || "", date: date || "" };
          });
        jsonResponse(res, 200, { ok: true, data: commits });
      } else {
        // Fallback: parse --oneline strings
        const lines = getRecentCommits(process.cwd(), 6);
        const commits = lines.map((l) => {
          const sp = (l || "").indexOf(" ");
          return { hash: sp > 0 ? l.slice(0, sp) : l.slice(0, 7), message: sp > 0 ? l.slice(sp + 1) : l, author: "", date: "" };
        });
        jsonResponse(res, 200, { ok: true, data: commits });
      }
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: [], error: err.message });
    }
    return;
  }

  /* ═══════════════════════════════════════════════════════════
   *  Workflow API endpoints
   * ═══════════════════════════════════════════════════════════ */

  if (path === "/api/workflows") {
    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const engine = wfCtx.engine;
      const all = engine.list().filter((workflow) => !shouldHideGeneratedWorkflowFromList(workflow));
      jsonResponse(res, 200, { ok: true, workflows: all.map(w => ({
        id: w.id, name: w.name, description: w.description, category: w.category,
        enabled: w.enabled !== false,
        nodeCount: Number.isFinite(w.nodeCount) ? w.nodeCount : (w.nodes || []).length,
        trigger: w.trigger || (w.nodes || [])[0]?.type || "manual",
      })) });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/save") {
    try {
      const body = await readJsonBody(req);
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const engine = wfCtx.engine;
      if (typeof _wfTemplates?.applyWorkflowTemplateState === "function") {
        _wfTemplates.applyWorkflowTemplateState(body);
      }
      const saved = await engine.save(body);
      jsonResponse(res, 200, { ok: true, workflow: saved });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/workflows/concurrency — live concurrency stats for dashboard
  if (path === "/api/workflows/concurrency" && req.method === "GET") {
    try {
      const stats = engine.getConcurrencyStats();
      jsonResponse(res, 200, { ok: true, ...stats });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/workflows/launch-template — install (if needed) + execute a
  // workflow template with custom variable overrides, all in one step.
  // Body: { templateId, variables?: Record<string,any>, waitForCompletion?: boolean }
  if (path === "/api/workflows/launch-template" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const templateId = String(body?.templateId || "").trim();
      if (!templateId) {
        jsonResponse(res, 400, { ok: false, error: "templateId is required" });
        return;
      }

      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const engine = wfCtx.engine;
      const tplMod = _wfTemplates;

      // 1. Resolve template
      const template = tplMod.getTemplate(templateId);
      if (!template) {
        jsonResponse(res, 404, { ok: false, error: `Template "${templateId}" not found` });
        return;
      }

      // 2. Find or auto-install the workflow
      let workflowId;
      const installed = engine.list().find(
        (wf) => wf.metadata?.installedFrom === templateId || wf.name === template.name,
      );
      if (installed) {
        workflowId = installed.id;
      } else {
        // Auto-install silently
        const saved = tplMod.installTemplate(templateId, engine);
        workflowId = saved.id;
      }

      // 3. Build input: merge caller-supplied variables as execution input
      const userVars = body?.variables && typeof body.variables === "object" ? body.variables : {};
      const executeInput = { ...userVars };
      const workspaceId = String(wfCtx.workspaceContext?.workspaceId || "").trim();
      let defaultRepository = "";
      if (workspaceId) {
        const configDir = resolveUiConfigDir();
        if (configDir) {
          const listed = listManagedWorkspaces(configDir, { repoRoot });
          const workspace = listed.find(
            (entry) => String(entry?.id || "").trim().toLowerCase() === workspaceId.toLowerCase(),
          );
          defaultRepository = String(
            workspace?.activeRepo ||
              workspace?.repos?.find((repo) => repo?.primary)?.name ||
              workspace?.repos?.[0]?.name ||
              "",
          ).trim();
        }
      }
      if (!executeInput.workspace && workspaceId) executeInput.workspace = workspaceId;
      if (!executeInput.workspaceId && workspaceId) executeInput.workspaceId = workspaceId;
      if (!executeInput.repository && defaultRepository) executeInput.repository = defaultRepository;
      if (!executeInput._targetRepo && executeInput.repository) {
        executeInput._targetRepo = executeInput.repository;
      }

      // 4. Execute (dispatch by default for long-running research workflows)
      const shouldWait = body?.waitForCompletion === true;
      if (!shouldWait) {
        const dispatchedAt = new Date().toISOString();
        Promise.resolve()
          .then(() => engine.execute(workflowId, executeInput, { force: true }))
          .then((ctx) => {
            const runStatus = Array.isArray(ctx?.errors) && ctx.errors.length > 0 ? "failed" : "completed";
            console.log(`[workflows] Template launch finished template=${templateId} workflow=${workflowId} status=${runStatus}`);
          })
          .catch((err) => {
            console.error(`[workflows] Template launch failed template=${templateId}: ${err.message}`);
          });

        jsonResponse(res, 202, {
          ok: true,
          accepted: true,
          mode: "dispatch",
          templateId,
          templateName: template.name,
          workflowId,
          variables: { ...template.variables, ...userVars },
          workspaceId,
          repository: executeInput.repository || executeInput._targetRepo || null,
          targetRepo: executeInput._targetRepo || executeInput.repository || null,
          dispatchedAt,
        });
        return;
      }

      const result = await engine.execute(workflowId, executeInput, { force: true });
      jsonResponse(res, 200, {
        ok: true,
        mode: "sync",
        templateId,
        templateName: template.name,
        workflowId,
        workspaceId,
        repository: executeInput.repository || executeInput._targetRepo || null,
        targetRepo: executeInput._targetRepo || executeInput.repository || null,
        result,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/templates") {
    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const tplMod = _wfTemplates;
      const rootDir = wfCtx.workspaceContext?.workspaceDir || process.cwd();
      const list = tplMod.listTemplates(rootDir);
      jsonResponse(res, 200, { ok: true, templates: list });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/detect-project") {
    try {
      const wfCtx = await getWorkflowRequestContext(url);
      const rootDir = wfCtx.ok ? (wfCtx.workspaceContext?.workspaceDir || process.cwd()) : process.cwd();
      let detected = { stacks: [], primary: null, commands: {}, frameworks: [], isMonorepo: false };
      try {
        const { detectProjectStack } = await import("../workflow/project-detection.mjs");
        detected = detectProjectStack(rootDir);
      } catch {}
      jsonResponse(res, 200, { ok: true, detected });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/install-template") {
    try {
      const body = await readJsonBody(req);
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const tplMod = _wfTemplates;
      const engine = wfCtx.engine;
      const wf = await tplMod.installTemplate(body.templateId, engine, body.overrides);
      jsonResponse(res, 200, { ok: true, workflow: wf });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/reflow-template-layouts" && req.method === "POST") {
    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      if (typeof _wfTemplates?.relayoutInstalledTemplateWorkflows !== "function") {
        jsonResponse(res, 503, { ok: false, error: "Template relayout service unavailable" });
        return;
      }
      const body = await readJsonBody(req).catch(() => ({}));
      const result = _wfTemplates.relayoutInstalledTemplateWorkflows(wfCtx.engine, {
        workflowIds: body?.workflowIds || body?.workflowId,
      });
      const workflows = result.updatedWorkflowIds
        .map((workflowId) => wfCtx.engine.get(workflowId))
        .filter(Boolean);
      jsonResponse(res, 200, { ok: true, result, workflows });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/template-updates") {
    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const engine = wfCtx.engine;
      if (typeof _wfTemplates?.reconcileInstalledTemplates === "function") {
        _wfTemplates.reconcileInstalledTemplates(engine, {
          autoUpdateUnmodified: true,
        });
      }
      const updates = engine
        .list()
        .map((wf) => {
          const state = wf.metadata?.templateState || null;
          if (!state?.templateId) return null;
          return {
            workflowId: wf.id,
            workflowName: wf.name,
            templateId: state.templateId,
            templateName: state.templateName || state.templateId,
            updateAvailable: state.updateAvailable === true,
            isCustomized: state.isCustomized === true,
            templateVersion: state.templateVersion || null,
            installedTemplateVersion: state.installedTemplateVersion || null,
          };
        })
        .filter(Boolean);
      jsonResponse(res, 200, { ok: true, updates });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/workflows/") && path.endsWith("/template-update")) {
    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const engine = wfCtx.engine;
      const workflowId = decodeURIComponent(path.split("/")[3] || "");
      if (!workflowId) {
        jsonResponse(res, 400, { ok: false, error: "Missing workflow id" });
        return;
      }
      const body = await readJsonBody(req).catch(() => ({}));
      const mode = String(body?.mode || "replace").toLowerCase();
      const force = body?.force === true;
      if (typeof _wfTemplates?.updateWorkflowFromTemplate !== "function") {
        jsonResponse(res, 503, { ok: false, error: "Template update service unavailable" });
        return;
      }
      const workflow = _wfTemplates.updateWorkflowFromTemplate(engine, workflowId, { mode, force });
      jsonResponse(res, 200, { ok: true, workflow });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/node-types") {
    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const wfMod = wfCtx.wfMod;
      const types = wfMod.listNodeTypes();
      jsonResponse(res, 200, { ok: true, nodeTypes: types.map((nt) => {
        const rawPorts = nt?.ports && typeof nt.ports === "object" ? nt.ports : {};
        const ports = {
          inputs: Array.isArray(rawPorts.inputs) ? rawPorts.inputs : [],
          outputs: Array.isArray(rawPorts.outputs) ? rawPorts.outputs : [],
        };
        return {
          type: nt.type,
          category: nt.type.split(".")[0],
          description: nt.description || "",
          schema: nt.schema || {},
          source: nt.source || "builtin",
          badge: nt.badge || null,
          isCustom: nt.isCustom === true,
          filePath: nt.filePath || null,
          ports,
          ui: nt?.ui && typeof nt.ui === "object" ? nt.ui : {},
        };
      }) });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/runs") {
    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const engine = wfCtx.engine;
      const rawOffset = Number(url.searchParams.get("offset"));
      const rawLimit = Number(url.searchParams.get("limit"));
      const offset = Number.isFinite(rawOffset) && rawOffset > 0
        ? Math.max(0, Math.floor(rawOffset))
        : 0;
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, 5000)
        : 20;
      const page = typeof engine.getRunHistoryPage === "function"
        ? engine.getRunHistoryPage(null, { offset, limit })
        : {
            runs: engine.getRunHistory ? engine.getRunHistory(null, limit) : [],
            total: engine.getRunHistory ? engine.getRunHistory(null).length : 0,
            offset,
            limit,
          };
      const runs = Array.isArray(page?.runs) ? page.runs : [];
      const total = Number.isFinite(Number(page?.total)) ? Number(page.total) : runs.length;
      const nextOffset = Number.isFinite(Number(page?.nextOffset))
        ? Number(page.nextOffset)
        : (offset + runs.length < total ? offset + runs.length : null);
      jsonResponse(res, 200, {
        ok: true,
        runs,
        pagination: {
          total,
          offset,
          limit,
          count: runs.length,
          hasMore: page?.hasMore === true || (nextOffset != null && nextOffset < total),
          nextOffset,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/workflows/runs/")) {
    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const engine = wfCtx.engine;
      const subPath = path.replace("/api/workflows/runs/", "");
      const segments = subPath.split("/").map(decodeURIComponent);
      const runId = (segments[0] || "").trim();
      const action = (segments[1] || "").trim();

      if (!runId) {
        jsonResponse(res, 400, { ok: false, error: "runId is required" });
        return;
      }

      if (action === "copilot-context" && (req.method === "GET" || req.method === "POST")) {
        const run = typeof engine.getRunDetail === "function" ? engine.getRunDetail(runId) : null;
        if (!run) {
          jsonResponse(res, 404, { ok: false, error: "Workflow run not found" });
          return;
        }
        const requestBody = req.method === "POST" ? await readJsonBody(req).catch(() => ({})) : {};
        const intent = String(
          requestBody?.intent || url.searchParams.get("intent") || "ask",
        ).trim().toLowerCase();
        const nodeId = String(
          requestBody?.nodeId || url.searchParams.get("nodeId") || "",
        ).trim();
        const workflow = typeof engine.get === "function"
          ? engine.get(String(run?.workflowId || "").trim())
          : null;
        const nodeForensics =
          nodeId && typeof engine.getNodeForensics === "function"
            ? engine.getNodeForensics(runId, nodeId)
            : null;
        const runForensics = typeof engine.getRunForensics === "function"
          ? engine.getRunForensics(runId)
          : null;
        const payload = buildRunCopilotContextPayload(run, {
          intent,
          nodeId,
          workflow,
          nodeForensics,
          runForensics,
        });
        if (!payload?.prompt) {
          jsonResponse(res, 404, {
            ok: false,
            error: nodeId ? "Node not found in workflow run" : "Workflow run copilot context unavailable",
          });
          return;
        }
        jsonResponse(res, 200, { ok: true, ...payload });
        return;
      }

      if (action === "stop" && req.method === "POST") {
        if (typeof engine.cancelRun !== "function") {
          jsonResponse(res, 501, { ok: false, error: "Workflow run cancellation is not supported by this engine." });
          return;
        }
        const body = await readJsonBody(req);
        const reason = String(body?.reason || "Run cancellation requested from UI").trim() || "Run cancellation requested from UI";
        const result = engine.cancelRun(runId, { reason });
        if (!result?.ok) {
          const statusCode = String(result?.error || "").includes("not found") ? 404 : 409;
          jsonResponse(res, statusCode, {
            ok: false,
            error: result?.error || "Unable to stop workflow run",
            runId,
            status: result?.status || null,
          });
          return;
        }
        jsonResponse(res, 200, {
          ok: true,
          runId,
          status: result?.status || "running",
          cancelRequested: true,
          alreadyRequested: result?.alreadyRequested === true,
          cancelRequestedAt: result?.cancelRequestedAt || Date.now(),
        });
        return;
      }
      // ── POST /api/workflows/runs/:id/retry ──────────────────────────
      // Manual retry endpoint. Accepts { mode: "from_failed" | "from_scratch" }.
      // If mode is omitted, returns available retry options so the UI can
      // present a choice to the user.
      if (action === "retry" && req.method === "POST") {
        const run = engine.getRunDetail ? engine.getRunDetail(runId) : null;
        if (!run) {
          jsonResponse(res, 404, { ok: false, error: "Workflow run not found" });
          return;
        }
        if (run.status !== "failed") {
          jsonResponse(res, 400, { ok: false, error: `Run status is "${run.status}" — only failed runs can be retried` });
          return;
        }
        const body = await readJsonBody(req);
        const mode = body?.mode;
        if (!mode) {
          const retryOptions = typeof engine.getRetryOptions === "function"
            ? engine.getRetryOptions(runId)
            : null;
          if (retryOptions) {
            jsonResponse(res, 200, {
              ok: true,
              ...retryOptions,
            });
            return;
          }
          jsonResponse(res, 200, {
            ok: true,
            runId,
            status: run.status,
            options: [
              { mode: "from_failed", label: "Retry from last failed step", failedNodes: [] },
              { mode: "from_scratch", label: "Retry from scratch" },
            ],
          });
          return;
        }
        if (mode !== "from_failed" && mode !== "from_scratch") {
          jsonResponse(res, 400, { ok: false, error: `Invalid mode "${mode}". Use "from_failed" or "from_scratch".` });
          return;
        }
        const result = await engine.retryRun(runId, { mode });
        const retryStatus = result.ctx?.errors?.length > 0 ? "failed" : "completed";
        jsonResponse(res, 200, {
          ok: true,
          retryRunId: result.retryRunId,
          originalRunId: result.originalRunId,
          mode: result.mode,
          status: retryStatus,
        });
        return;
      }

      // ── GET /api/workflows/runs/:id/nodes/:nodeId — node forensics ──
      if (action === "nodes" && req.method === "GET") {
        const nodeId = (segments[2] || "").trim();
        if (!nodeId) {
          jsonResponse(res, 400, { ok: false, error: "nodeId is required" });
          return;
        }
        const forensics = typeof engine.getNodeForensics === "function"
          ? engine.getNodeForensics(runId, nodeId)
          : null;
        if (!forensics) {
          jsonResponse(res, 404, { ok: false, error: "Node not found in run" });
          return;
        }
        jsonResponse(res, 200, { ok: true, forensics });
        return;
      }

      // ── GET /api/workflows/runs/:id/forensics — full run forensics ──
      if (action === "forensics" && req.method === "GET") {
        const forensics = typeof engine.getRunForensics === "function"
          ? engine.getRunForensics(runId)
          : null;
        if (!forensics) {
          jsonResponse(res, 404, { ok: false, error: "Run not found" });
          return;
        }
        jsonResponse(res, 200, { ok: true, forensics });
        return;
      }

      // ── GET /api/workflows/runs/:id/evaluate — run evaluation ───────
      if (action === "evaluate" && req.method === "GET") {
        const run = engine.getRunDetail ? engine.getRunDetail(runId) : null;
        if (!run) {
          jsonResponse(res, 404, { ok: false, error: "Workflow run not found" });
          return;
        }
        const { RunEvaluator } = await import("../workflow/run-evaluator.mjs");
        const evaluator = new RunEvaluator();
        const evaluation = evaluator.evaluate(run);
        jsonResponse(res, 200, { ok: true, runId, evaluation });
        return;
      }

      // ── POST /api/workflows/runs/:id/snapshot — create snapshot ─────
      if (action === "snapshot" && req.method === "POST") {
        if (typeof engine.createRunSnapshot !== "function") {
          jsonResponse(res, 501, { ok: false, error: "Snapshots not supported" });
          return;
        }
        const result = engine.createRunSnapshot(runId);
        if (!result) {
          jsonResponse(res, 404, { ok: false, error: "Run not found" });
          return;
        }
        jsonResponse(res, 200, { ok: true, ...result });
        return;
      }

      // ── GET /api/workflows/runs/:id/snapshots — list snapshots ──────
      if (action === "snapshots" && req.method === "GET") {
        const run = engine.getRunDetail ? engine.getRunDetail(runId) : null;
        const workflowId = run?.workflowId || run?.detail?.data?._workflowId || null;
        const snapshots = typeof engine.listSnapshots === "function"
          ? engine.listSnapshots(workflowId)
          : [];
        jsonResponse(res, 200, { ok: true, snapshots });
        return;
      }

      // ── POST /api/workflows/runs/:id/restore — restore from snapshot ─
      if (action === "restore" && req.method === "POST") {
        if (typeof engine.restoreFromSnapshot !== "function") {
          jsonResponse(res, 501, { ok: false, error: "Restore not supported" });
          return;
        }
        const body = await readJsonBody(req);
        const variables = body?.variables || {};
        const result = await engine.restoreFromSnapshot(runId, { variables });
        jsonResponse(res, 200, {
          ok: true,
          runId: result.runId,
          snapshotId: result.snapshotId,
          workflowId: result.workflowId,
          status: result.status,
        });
        return;
      }

      // ── POST /api/workflows/runs/:id/remediate — apply fix actions ──
      if (action === "remediate" && req.method === "POST") {
        const run = engine.getRunDetail ? engine.getRunDetail(runId) : null;
        if (!run) {
          jsonResponse(res, 404, { ok: false, error: "Workflow run not found" });
          return;
        }
        const body = await readJsonBody(req);
        const actions = Array.isArray(body?.actions) ? body.actions : [];
        const autoRetry = body?.autoRetry === true;
        const applied = [];
        for (const action of actions) {
          applied.push({ type: action.type, nodeId: action.nodeId, status: "noted" });
        }
        let retryResult = null;
        if (autoRetry && run.status === "failed") {
          const mode = actions.length <= 1 ? "from_failed" : "from_scratch";
          retryResult = await engine.retryRun(runId, { mode });
        }
        jsonResponse(res, 200, {
          ok: true,
          runId,
          applied,
          retryTriggered: !!retryResult,
          retryRunId: retryResult?.retryRunId || null,
        });
        return;
      }

      // ── GET /api/workflows/runs/:id ─────────────────────────────────
      const run = engine.getRunDetail ? engine.getRunDetail(runId) : null;
      if (!run) {
        jsonResponse(res, 404, { ok: false, error: "Workflow run not found" });
        return;
      }
      jsonResponse(res, 200, { ok: true, run });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // Dynamic routes: /api/workflows/:id, /api/workflows/:id/execute, /api/workflows/:id/runs
  if (path.startsWith("/api/workflows/") && !path.startsWith("/api/workflows/save") && !path.startsWith("/api/workflows/templates") && !path.startsWith("/api/workflows/install") && !path.startsWith("/api/workflows/node") && !path.startsWith("/api/workflows/runs") && !path.match(/^\/api\/workflows\/[^/]+\/webhook/) && !path.match(/^\/api\/workflows\/[^/]+\/schedule$/)) {
    const segments = path.replace("/api/workflows/", "").split("/");
    const workflowId = segments[0];
    const action = segments[1] || "";

    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx.ok) {
        jsonResponse(res, wfCtx.status, { ok: false, error: wfCtx.error });
        return;
      }
      const engine = wfCtx.engine;

      if (action === "execute" && req.method === "POST") {
        const body = await readJsonBody(req);
        const input = body && typeof body === "object" ? body : {};
        const shouldWait = input.waitForCompletion === true || input.dispatch === false;
        const executeInput = { ...input };
        delete executeInput.waitForCompletion;
        delete executeInput.dispatch;

        if (!shouldWait) {
          const dispatchedAt = new Date().toISOString();
          Promise.resolve()
            .then(() => engine.execute(workflowId, executeInput))
            .then((ctx) => {
              const runStatus = Array.isArray(ctx?.errors) && ctx.errors.length > 0 ? "failed" : "completed";
              console.log(
                `[workflows] Dispatched run finished workflow=${workflowId} runId=${ctx?.id || "unknown"} status=${runStatus}`,
              );
            })
            .catch((err) => {
              console.error(`[workflows] Dispatched run failed workflow=${workflowId}: ${err.message}`);
            });

          jsonResponse(res, 202, {
            ok: true,
            accepted: true,
            mode: "dispatch",
            workflowId,
            dispatchedAt,
          });
          return;
        }

        const result = await engine.execute(workflowId, executeInput);
        jsonResponse(res, 200, { ok: true, result, mode: "sync" });
        return;
      }

      if (action === "reflow-layout" && req.method === "POST") {
        if (typeof _wfTemplates?.relayoutInstalledTemplateWorkflows !== "function") {
          jsonResponse(res, 503, { ok: false, error: "Template relayout service unavailable" });
          return;
        }
        const result = _wfTemplates.relayoutInstalledTemplateWorkflows(engine, {
          workflowId,
        });
        const workflow = engine.get(workflowId);
        if (!workflow) {
          jsonResponse(res, 404, { ok: false, error: "Workflow not found after relayout" });
          return;
        }
        jsonResponse(res, 200, { ok: true, workflow, result });
        return;
      }

      if (action === "runs") {
        const rawOffset = Number(url.searchParams.get("offset"));
        const rawLimit = Number(url.searchParams.get("limit"));
        const offset = Number.isFinite(rawOffset) && rawOffset > 0
          ? Math.max(0, Math.floor(rawOffset))
          : 0;
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, 5000)
          : 20;
        const page = typeof engine.getRunHistoryPage === "function"
          ? engine.getRunHistoryPage(workflowId, { offset, limit })
          : {
              runs: engine.getRunHistory ? engine.getRunHistory(workflowId, limit) : [],
              total: engine.getRunHistory ? engine.getRunHistory(workflowId).length : 0,
              offset,
              limit,
            };
        const runs = Array.isArray(page?.runs) ? page.runs : [];
        const total = Number.isFinite(Number(page?.total)) ? Number(page.total) : runs.length;
        const nextOffset = Number.isFinite(Number(page?.nextOffset))
          ? Number(page.nextOffset)
          : (offset + runs.length < total ? offset + runs.length : null);
        jsonResponse(res, 200, {
          ok: true,
          runs,
          pagination: {
            total,
            offset,
            limit,
            count: runs.length,
            hasMore: page?.hasMore === true || (nextOffset != null && nextOffset < total),
            nextOffset,
          },
        });
        return;
      }

      if (action === "copilot-context" && (req.method === "GET" || req.method === "POST")) {
        const requestBody = req.method === "POST" ? await readJsonBody(req).catch(() => ({})) : {};
        const persistedWorkflow = engine.get(workflowId);
        if (!persistedWorkflow && !requestBody?.workflow) {
          jsonResponse(res, 404, { ok: false, error: "Workflow not found" });
          return;
        }
        const draftWorkflow =
          requestBody?.workflow && typeof requestBody.workflow === "object"
            ? requestBody.workflow
            : null;
        const workflow = draftWorkflow || persistedWorkflow;
        const intent = String(
          requestBody?.intent || url.searchParams.get("intent") || "explain",
        ).trim().toLowerCase();
        const nodeId = String(
          requestBody?.nodeId || url.searchParams.get("nodeId") || "",
        ).trim();
        const payload = buildWorkflowCopilotContextPayload(workflow, {
          intent,
          nodeId,
          wfMod: wfCtx.wfMod,
        });
        if (!payload?.prompt) {
          jsonResponse(res, 404, {
            ok: false,
            error: nodeId ? "Workflow node not found" : "Workflow copilot context unavailable",
          });
          return;
        }
        jsonResponse(res, 200, { ok: true, ...payload });
        return;
      }

      // ── Workflow Code View ─────────────────────────────────────────
      if (action === "code" && req.method === "GET") {
        const wf = engine.get(workflowId);
        if (!wf) { jsonResponse(res, 404, { ok: false, error: "Workflow not found" }); return; }
        try {
          const { serializeWorkflowToCode } = await import("../workflow/workflow-serializer.mjs");
          const result = serializeWorkflowToCode(wf);
          jsonResponse(res, 200, result);
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return;
      }

      if (action === "code" && req.method === "PUT") {
        const wf = engine.get(workflowId);
        if (!wf) { jsonResponse(res, 404, { ok: false, error: "Workflow not found" }); return; }
        try {
          const body = await readJsonBody(req);
          const { deserializeCodeToWorkflow } = await import("../workflow/workflow-serializer.mjs");
          const result = deserializeCodeToWorkflow(body?.code);
          if (result.errors.length > 0) {
            jsonResponse(res, 400, { ok: false, error: "Validation failed", errors: result.errors });
            return;
          }
          const merged = { ...wf, ...result.workflow, id: wf.id };
          engine.save(merged);
          jsonResponse(res, 200, { ok: true, workflow: merged });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return;
      }

      // ── Workflow Code Validation (POST /api/workflows/:id/code/validate) ──
      {
        const subAction = segments[2] || "";
        if (action === "code" && subAction === "validate" && req.method === "POST") {
          try {
            const body = await readJsonBody(req);
            const { validateWorkflowCode } = await import("../workflow/workflow-serializer.mjs");
            const result = validateWorkflowCode(body?.code);
            jsonResponse(res, 200, result);
          } catch (err) {
            jsonResponse(res, 500, { ok: false, error: err.message });
          }
          return;
        }
      }

      // ── Workflow Export ──────────────────────────────────────────────
      if (action === "export" && req.method === "GET") {
        const wf = engine.get(workflowId);
        if (!wf) { jsonResponse(res, 404, { ok: false, error: "Workflow not found" }); return; }
        try {
          const { generateExportBundle } = await import("../workflow/workflow-exporter.mjs");
          const baseUrl = `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host || "localhost:3077"}`;
          const bundle = generateExportBundle(wf, { baseUrl });
          jsonResponse(res, 200, bundle);
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return;
      }

      // ── Cancel a running workflow run ─────────────────────────────
      if (action === "cancel" && req.method === "POST") {
        try {
          const runId = segments[2] || workflowId; // /api/workflows/:wfId/cancel/:runId or /api/workflows/:wfId/cancel
          const result = engine.cancelRun?.(runId);
          if (result === false || result === undefined) {
            jsonResponse(res, 404, { ok: false, error: "Run not found or not cancellable" });
          } else {
            jsonResponse(res, 200, { ok: true, cancelled: true, runId });
          }
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return;
      }

      // ── Credential management ─────────────────────────────────────
      if (action === "credentials") {
        try {
          const { CredentialStore } = await import("../workflow/credential-store.mjs");
          const ctx = resolveActiveWorkspaceExecutionContext();
          const store = new CredentialStore({ configDir: ctx.workspaceDir });
          const credName = segments[2] || "";

          if (req.method === "GET" && !credName) {
            // List all credentials (metadata only, no values)
            jsonResponse(res, 200, { ok: true, credentials: store.list() });
            return;
          }

          if (req.method === "GET" && credName) {
            // Get single credential metadata
            const cred = store.get(credName);
            if (!cred) { jsonResponse(res, 404, { ok: false, error: "Credential not found" }); return; }
            jsonResponse(res, 200, { ok: true, credential: cred });
            return;
          }

          if (req.method === "POST" || req.method === "PUT") {
            const body = await readJsonBody(req);
            const parsed = typeof body === "string" ? JSON.parse(body) : body;
            const name = credName || parsed.name;
            if (!name) { jsonResponse(res, 400, { ok: false, error: "Credential name is required" }); return; }
            const result = store.set(name, {
              type: parsed.type || "static",
              value: parsed.value,
              label: parsed.label,
              provider: parsed.provider,
              scopes: parsed.scopes,
            });
            jsonResponse(res, 200, { ok: true, ...result });
            return;
          }

          if (req.method === "DELETE" && credName) {
            const deleted = store.delete(credName);
            jsonResponse(res, deleted ? 200 : 404, { ok: deleted, deleted: credName });
            return;
          }

          jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return;
      }

      // ── Evaluation history + trends ───────────────────────────────
      if (action === "evaluations" && req.method === "GET") {
        try {
          const { RunEvaluator } = await import("../workflow/run-evaluator.mjs");
          const ctx = resolveActiveWorkspaceExecutionContext();
          const evaluator = new RunEvaluator({ configDir: ctx.workspaceDir });
          const history = evaluator.getHistory(workflowId);
          const trend = evaluator.getTrend(workflowId);
          jsonResponse(res, 200, { ok: true, workflowId, history, trend });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return;
      }

      // ── Cron schedule preview ─────────────────────────────────────
      if (action === "cron-preview" && req.method === "GET") {
        try {
          const { parseCronExpression } = await import("../workflow/cron-scheduler.mjs");
          const urlObj = new URL(path, "http://localhost");
          const expr = urlObj.searchParams?.get("expr") || segments[2] || "* * * * *";
          const tz = urlObj.searchParams?.get("tz") || null;
          const count = Math.min(20, Math.max(1, Number(urlObj.searchParams?.get("n")) || 5));
          const parsed = parseCronExpression(expr);
          const nextOccurrences = parsed.nextN(count, new Date(), tz);
          jsonResponse(res, 200, {
            ok: true,
            expression: expr,
            timezone: tz || "UTC",
            next: nextOccurrences.map((d) => d.toISOString()),
          });
        } catch (err) {
          jsonResponse(res, 400, { ok: false, error: err.message });
        }
        return;
      }

      // ── Webhook delivery log ──────────────────────────────────────
      if (action === "webhook-log" && req.method === "GET") {
        try {
          const { WebhookGateway } = await import("../workflow/webhook-gateway.mjs");
          const ctx = resolveActiveWorkspaceExecutionContext();
          const gateway = new WebhookGateway({ configDir: ctx.workspaceDir });
          const log = gateway.getDeliveryLog(workflowId);
          jsonResponse(res, 200, { ok: true, workflowId, deliveries: log });
        } catch (err) {
          jsonResponse(res, 500, { ok: false, error: err.message });
        }
        return;
      }

      if (req.method === "DELETE") {
        await engine.delete(workflowId);
        jsonResponse(res, 200, { ok: true });
        return;
      }

      // GET — return full workflow definition
      const wf = engine.get(workflowId);
      if (!wf) { jsonResponse(res, 404, { ok: false, error: "Workflow not found" }); return; }
      jsonResponse(res, 200, { ok: true, workflow: wf });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* ═══════════════════════════════════════════════════════════
   *  Public Webhook Receiver (no auth — token-validated)
   * ═══════════════════════════════════════════════════════════ */

  if (path.startsWith("/api/webhooks/") && (req.method === "POST" || req.method === "GET")) {
    const webhookSegments = path.replace("/api/webhooks/", "").split("/");
    const webhookWorkflowId = webhookSegments[0] || "";
    const webhookToken = webhookSegments[1] || "";

    if (!webhookWorkflowId || !webhookToken) {
      jsonResponse(res, 400, { ok: false, error: "Invalid webhook URL" });
      return;
    }

    try {
      const { WebhookGateway } = await import("../workflow/webhook-gateway.mjs");
      const ctx = resolveActiveWorkspaceExecutionContext();
      const gateway = new WebhookGateway({ configDir: ctx.workspaceDir });

      // Validate token (constant-time)
      if (!gateway.validateToken(webhookWorkflowId, webhookToken)) {
        jsonResponse(res, 401, { ok: false, error: "Invalid webhook token" });
        return;
      }

      // Check active state
      if (!gateway.isActive(webhookWorkflowId)) {
        jsonResponse(res, 403, { ok: false, error: "Webhook is inactive" });
        return;
      }

      // Rate limit
      const rateResult = gateway.checkRateLimit(webhookWorkflowId);
      if (!rateResult.allowed) {
        res.writeHead(429, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(Math.ceil((rateResult.resetAt - Date.now()) / 1000)),
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: false, error: "Rate limit exceeded" }));
        return;
      }

      // Read payload
      let webhookPayload = {};
      if (req.method === "POST") {
        try {
          webhookPayload = (await readJsonBody(req)) || {};
        } catch {
          webhookPayload = {};
        }
      } else {
        // GET: use query params as payload
        const qp = {};
        for (const [k, v] of url.searchParams.entries()) qp[k] = v;
        webhookPayload = qp;
      }

      // Check workflow exists and is enabled
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx?.ok) {
        jsonResponse(res, 503, { ok: false, error: "Workflow engine unavailable" });
        return;
      }
      const wf = wfCtx.engine.get(webhookWorkflowId);
      if (!wf || wf.enabled === false) {
        jsonResponse(res, 404, { ok: false, error: "Workflow not found or disabled" });
        return;
      }

      // Check method against trigger node config
      const triggerNode = (wf.nodes || []).find((n) => n.type === "trigger.webhook");
      if (triggerNode?.config?.method && req.method !== triggerNode.config.method) {
        jsonResponse(res, 405, { ok: false, error: `Method ${req.method} not allowed for this webhook` });
        return;
      }

      // Dispatch
      const runId = `webhook-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const eventPayload = {
        eventType: "webhook",
        webhookPayload,
        workflowId: webhookWorkflowId,
        method: req.method,
        headers: { ...req.headers },
        receivedAt: new Date().toISOString(),
      };

      Promise.resolve()
        .then(() => wfCtx.engine.execute(webhookWorkflowId, eventPayload))
        .then((result) => {
          const status = Array.isArray(result?.errors) && result.errors.length > 0 ? "failed" : "completed";
          console.log(`[webhooks] run ${status} workflow=${webhookWorkflowId} runId=${result?.id || runId}`);
        })
        .catch((err) => {
          console.warn(`[webhooks] run failed workflow=${webhookWorkflowId}: ${err?.message || err}`);
        });

      jsonResponse(res, 200, { ok: true, accepted: true, runId });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* ═══════════════════════════════════════════════════════════
   *  Webhook Management API (authenticated, under /api/workflows/:id/webhook)
   * ═══════════════════════════════════════════════════════════ */

  const webhookMgmtMatch = path.match(/^\/api\/workflows\/([^/]+)\/webhook(?:\/([^/]+))?$/);
  if (webhookMgmtMatch) {
    const wfId = webhookMgmtMatch[1];
    const subAction = webhookMgmtMatch[2] || "";

    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx?.ok) {
        jsonResponse(res, wfCtx.status || 503, { ok: false, error: wfCtx.error });
        return;
      }
      const wf = wfCtx.engine.get(wfId);
      if (!wf) {
        jsonResponse(res, 404, { ok: false, error: "Workflow not found" });
        return;
      }

      const { WebhookGateway } = await import("../workflow/webhook-gateway.mjs");
      const ctx = resolveActiveWorkspaceExecutionContext();
      const gateway = new WebhookGateway({ configDir: ctx.workspaceDir });

      // POST /api/workflows/:id/webhook/rotate
      if (subAction === "rotate" && req.method === "POST") {
        const newToken = gateway.rotateToken(wfId);
        jsonResponse(res, 200, {
          ok: true,
          workflowId: wfId,
          token: newToken,
          webhookUrl: `/api/webhooks/${wfId}/${newToken}`,
        });
        return;
      }

      // GET /api/workflows/:id/webhook
      if (req.method === "GET") {
        const info = gateway.getWebhookInfo(wfId);
        jsonResponse(res, 200, {
          ok: true,
          workflowId: wfId,
          webhook: info
            ? { active: info.active, token: info.token, createdAt: info.createdAt, webhookUrl: `/api/webhooks/${wfId}/${info.token}` }
            : null,
        });
        return;
      }

      // POST /api/workflows/:id/webhook — activate + generate token
      if (req.method === "POST") {
        const token = gateway.generateToken(wfId);
        jsonResponse(res, 201, {
          ok: true,
          workflowId: wfId,
          token,
          webhookUrl: `/api/webhooks/${wfId}/${token}`,
          active: true,
        });
        return;
      }

      // DELETE /api/workflows/:id/webhook — deactivate + revoke
      if (req.method === "DELETE") {
        gateway.revokeToken(wfId);
        jsonResponse(res, 200, { ok: true, workflowId: wfId, deactivated: true });
        return;
      }

      jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* ═══════════════════════════════════════════════════════════
   *  Cron / Schedule Management API
   * ═══════════════════════════════════════════════════════════ */

  const scheduleMgmtMatch = path.match(/^\/api\/workflows\/([^/]+)\/schedule$/);
  if (scheduleMgmtMatch) {
    const wfId = scheduleMgmtMatch[1];

    try {
      const wfCtx = await getWorkflowRequestContext(url);
      if (!wfCtx?.ok) {
        jsonResponse(res, wfCtx.status || 503, { ok: false, error: wfCtx.error });
        return;
      }
      const engine = wfCtx.engine;
      const wf = engine.get(wfId);
      if (!wf) {
        jsonResponse(res, 404, { ok: false, error: "Workflow not found" });
        return;
      }

      const triggerNode = (wf.nodes || []).find(
        (n) => n.type === "trigger.schedule" || n.type === "trigger.scheduled_once",
      );

      // GET /api/workflows/:id/schedule
      if (req.method === "GET") {
        const config = triggerNode?.config || {};
        jsonResponse(res, 200, {
          ok: true,
          workflowId: wfId,
          schedule: {
            cron: config.cron || null,
            intervalMs: config.intervalMs || null,
            timezone: config.timezone || "UTC",
            hasTrigger: Boolean(triggerNode),
          },
        });
        return;
      }

      // POST /api/workflows/:id/schedule — update cron expression
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const cronExpr = String(body?.cron || "").trim();
        const intervalMs = body?.intervalMs != null ? Number(body.intervalMs) : undefined;

        // Validate cron if provided
        if (cronExpr) {
          try {
            const { parseCronExpression } = await import("../workflow/cron-scheduler.mjs");
            parseCronExpression(cronExpr);
          } catch (err) {
            jsonResponse(res, 400, { ok: false, error: `Invalid cron expression: ${err?.message || err}` });
            return;
          }
        }

        if (!triggerNode) {
          jsonResponse(res, 400, { ok: false, error: "Workflow has no schedule trigger node" });
          return;
        }

        // Update the trigger node config
        if (!triggerNode.config) triggerNode.config = {};
        if (cronExpr) {
          triggerNode.config.cron = cronExpr;
        }
        if (intervalMs !== undefined && Number.isFinite(intervalMs) && intervalMs > 0) {
          triggerNode.config.intervalMs = intervalMs;
        }
        if (body?.timezone) {
          triggerNode.config.timezone = String(body.timezone);
        }

        // Save the updated workflow
        engine.save(wf);
        jsonResponse(res, 200, {
          ok: true,
          workflowId: wfId,
          schedule: {
            cron: triggerNode.config.cron || null,
            intervalMs: triggerNode.config.intervalMs || null,
            timezone: triggerNode.config.timezone || "UTC",
          },
        });
        return;
      }

      // DELETE /api/workflows/:id/schedule — disable schedule
      if (req.method === "DELETE") {
        if (triggerNode?.config) {
          delete triggerNode.config.cron;
          engine.save(wf);
        }
        jsonResponse(res, 200, { ok: true, workflowId: wfId, scheduleDisabled: true });
        return;
      }

      jsonResponse(res, 405, { ok: false, error: "Method not allowed" });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  /* ═══════════════════════════════════════════════════════════
   *  Manual Flows API endpoints
   * ═══════════════════════════════════════════════════════════ */

  if (path === "/api/manual-flows/templates") {
    try {
      const mf = await import("../workflow/manual-flows.mjs");
      const ctx = resolveActiveWorkspaceExecutionContext();
      const templates = mf.listFlowTemplates(ctx.workspaceDir);
      jsonResponse(res, 200, { ok: true, templates });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/manual-flows/templates/save" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const mf = await import("../workflow/manual-flows.mjs");
      const ctx = resolveActiveWorkspaceExecutionContext();
      const saved = mf.saveFlowTemplate(body, ctx.workspaceDir);
      jsonResponse(res, 200, { ok: true, template: saved });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/manual-flows/templates/install" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const templateId = String(body?.templateId || "").trim();
      if (!templateId) {
        jsonResponse(res, 400, { ok: false, error: "templateId is required" });
        return;
      }

      const mf = await import("../workflow/manual-flows.mjs");
      const ctx = resolveActiveWorkspaceExecutionContext();
      const source = mf.getFlowTemplate(templateId, ctx.workspaceDir);
      if (!source) {
        jsonResponse(res, 404, { ok: false, error: "Template not found" });
        return;
      }
      if (source.builtin !== true) {
        jsonResponse(res, 409, { ok: false, error: "Template is already user-installed" });
        return;
      }

      const saved = mf.saveFlowTemplate(
        {
          ...source,
          id: String(body?.targetId || `${templateId}-custom`).trim() || undefined,
          name: String(body?.name || source.name || "").trim() || source.name,
        },
        ctx.workspaceDir,
      );
      jsonResponse(res, 201, { ok: true, template: saved });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/manual-flows/execute" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { templateId, formValues, executionContext } = body || {};
      if (!templateId) {
        jsonResponse(res, 400, { ok: false, error: "templateId is required" });
        return;
      }
      const mf = await import("../workflow/manual-flows.mjs");
      const ctx = resolveActiveWorkspaceExecutionContext();
      const wfCtx = await getWorkflowRequestContext(url);
      const repository = String(
        executionContext?.repository ||
          executionContext?.targetRepo ||
          formValues?._targetRepo ||
          resolveDefaultRepositoryForWorkspaceContext(ctx),
      ).trim();
      const workspaceId = String(
        executionContext?.workspaceId ||
          executionContext?.workspace ||
          ctx.workspaceId ||
          "",
      ).trim();
      const projectId = String(
        executionContext?.projectId ||
          executionContext?.project ||
          body?.project ||
          "",
      ).trim();
      const flowContext = {
        ...(wfCtx?.ok ? { engine: wfCtx.engine } : {}),
        taskManager: createManualFlowTaskManager(ctx, {
          repository,
          workspaceId,
          projectId,
          templateId,
        }),
        runMetadata: {
          repository,
          workspaceId,
          workspaceDir: ctx.workspaceDir,
          projectId,
          triggerSource: "manual-ui",
        },
      };
      const run = await mf.executeFlow(templateId, formValues || {}, ctx.workspaceDir, flowContext);
      jsonResponse(res, 200, { ok: true, run });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/manual-flows/runs") {
    try {
      const mf = await import("../workflow/manual-flows.mjs");
      const ctx = resolveActiveWorkspaceExecutionContext();
      const templateId = url.searchParams.get("templateId") || undefined;
      const status = url.searchParams.get("status") || undefined;
      const rawLimit = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 50;
      const runs = mf.listRuns(ctx.workspaceDir, { templateId, status, limit });
      jsonResponse(res, 200, { ok: true, runs });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/manual-flows/templates/") && req.method === "DELETE") {
    try {
      const templateId = decodeURIComponent(path.replace("/api/manual-flows/templates/", "").split("/")[0] || "").trim();
      if (!templateId) {
        jsonResponse(res, 400, { ok: false, error: "templateId is required" });
        return;
      }

      const mf = await import("../workflow/manual-flows.mjs");
      const ctx = resolveActiveWorkspaceExecutionContext();
      const existing = mf.getFlowTemplate(templateId, ctx.workspaceDir);
      if (!existing) {
        jsonResponse(res, 404, { ok: false, error: "Template not found" });
        return;
      }
      if (existing.builtin === true) {
        jsonResponse(res, 403, { ok: false, error: "Built-in templates cannot be deleted" });
        return;
      }

      const deleted = mf.deleteFlowTemplate(templateId, ctx.workspaceDir);
      if (!deleted) {
        jsonResponse(res, 404, { ok: false, error: "Template not found" });
        return;
      }
      jsonResponse(res, 200, { ok: true, deleted: templateId });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/manual-flows/runs/") && !path.endsWith("/runs/")) {
    try {
      const runId = decodeURIComponent(path.replace("/api/manual-flows/runs/", "").split("/")[0] || "");
      if (!runId) {
        jsonResponse(res, 400, { ok: false, error: "runId is required" });
        return;
      }
      const mf = await import("../workflow/manual-flows.mjs");
      const ctx = resolveActiveWorkspaceExecutionContext();
      const run = mf.getRun(runId, ctx.workspaceDir);
      if (!run) {
        jsonResponse(res, 404, { ok: false, error: "Run not found" });
        return;
      }
      jsonResponse(res, 200, { ok: true, run });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/health") {
    jsonResponse(res, 200, {
      ok: true,
      uptime: process.uptime(),
      wsClients: wsClients.size,
      lanIp: getLocalLanIp(),
      url: getTelegramUiUrl(),
    });
    return;
  }

  if (path === "/api/health-stats") {
    const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
    const cutoff = new Date(Date.now() - SIX_HOURS_MS).toISOString();
    let successRuns = 0;
    let failedRuns = 0;
    try {
      const tasks = getAllInternalTasks();
      for (const task of tasks) {
        for (const entry of (task.statusHistory || [])) {
          if (entry.timestamp < cutoff) continue;
          if (entry.status === "done") successRuns++;
          else if (entry.status === "error") failedRuns++;
        }
      }
    } catch { /* task store not loaded or unavailable */ }
    const total = successRuns + failedRuns;
    const failRate = total > 0 ? failedRuns / total : 0;
    jsonResponse(res, 200, { ok: true, successRuns, failedRuns, total, failRate, windowHours: 6 });
    return;
  }

  if (path === "/api/config") {
    const regionEnv = (process.env.EXECUTOR_REGIONS || "").trim();
    const regions = regionEnv ? regionEnv.split(",").map((r) => r.trim()).filter(Boolean) : ["auto"];
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "package.json"), "utf8"));
    let runtimeKanbanBackend = "internal";
    try {
      runtimeKanbanBackend = String(
        getKanbanBackendName() || process.env.KANBAN_BACKEND || "internal",
      ).trim().toLowerCase();
    } catch {
      runtimeKanbanBackend = String(
        process.env.KANBAN_BACKEND || "internal",
      ).trim().toLowerCase();
    }
    jsonResponse(res, 200, {
      ok: true,
      version: pkg.version,
      miniAppEnabled:
        !!process.env.TELEGRAM_MINIAPP_ENABLED ||
        !!process.env.TELEGRAM_UI_PORT,
      uiUrl: getTelegramUiUrl(),
      lanIp: getLocalLanIp(),
      wsEnabled: true,
      authRequired: !isAllowUnsafe(),
      sdk: process.env.EXECUTOR_SDK || "auto",
      kanbanBackend: runtimeKanbanBackend,
      regions,
      tunnel: getTunnelStatus(),
      fallbackAuth: getFallbackAuthStatus(),
    });
    return;
  }

  if (path === "/api/config/update") {
    try {
      const body = await readJsonBody(req);
      const { key, value } = body || {};
      if (!key || !value) {
        jsonResponse(res, 400, { ok: false, error: "key and value are required" });
        return;
      }
      const envMap = { sdk: "EXECUTOR_SDK", kanban: "KANBAN_BACKEND", region: "EXECUTOR_REGIONS" };
      const envKey = envMap[key];
      if (!envKey) {
        jsonResponse(res, 400, { ok: false, error: `Unknown config key: ${key}` });
        return;
      }
      process.env[envKey] = value;
      if (envKey === "KANBAN_BACKEND") {
        try {
          setKanbanBackend(String(value).trim().toLowerCase());
        } catch (err) {
          console.warn(`[config] failed to switch kanban backend: ${err.message}`);
        }
      }
      // Also send chat command for backward compat
      const cmdMap = { sdk: `/sdk ${value}`, kanban: `/kanban ${value}`, region: `/region ${value}` };
      const handler = uiDeps.handleUiCommand;
      if (typeof handler === "function") {
        try { await handler(cmdMap[key]); } catch { /* best-effort */ }
      }
      broadcastUiEvent(["executor", "overview"], "invalidate", { reason: "config-updated", key, value });
      jsonResponse(res, 200, { ok: true, key, value });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/settings") {
    try {
      const { data, sources } = buildSettingsResponseData();
      const envPath = resolve(resolveUiConfigDir(), ".env");
      const configPath = resolveConfigPath();
      const configExists = existsSync(configPath);
      const configSchema = getConfigSchema();
      jsonResponse(res, 200, {
        ok: true,
        data,
        sources,
        meta: {
          envPath,
          configPath,
          configDir: dirname(configPath),
          configExists,
          configSchemaPath: CONFIG_SCHEMA_PATH,
          configSchemaLoaded: Boolean(configSchema),
          tunnel: getTunnelStatus(),
          fallbackAuth: getFallbackAuthStatus(),
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/settings/update") {
    try {
      const body = await readJsonBody(req);
      const changes = body?.changes;
      if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
        jsonResponse(res, 400, { ok: false, error: "changes object is required" });
        return;
      }
      // Rate limit: 2 seconds between settings updates
      const now = Date.now();
      if (now - _settingsLastUpdateTime < 2000) {
        jsonResponse(res, 429, { ok: false, error: "Settings update rate limited. Wait 2 seconds." });
        return;
      }
      const unknownKeys = Object.keys(changes).filter(k => !SETTINGS_KNOWN_SET.has(k));
      if (unknownKeys.length > 0) {
        jsonResponse(res, 400, { ok: false, error: `Unknown keys: ${unknownKeys.join(", ")}` });
        return;
      }
      const fieldErrors = {};
      for (const [key, value] of Object.entries(changes)) {
        const def = SETTINGS_SCHEMA.find((s) => s.key === key);
        if (!def) continue;
        const result = validateSetting(def, String(value ?? ""));
        if (!result.valid) {
          fieldErrors[key] = result.error || "Invalid value";
        }
      }
      const schemaFieldErrors = validateConfigSchemaChanges(changes);
      for (const [key, error] of Object.entries(schemaFieldErrors)) {
        if (!fieldErrors[key]) fieldErrors[key] = error;
      }
      if (Object.keys(fieldErrors).length > 0) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Validation failed",
          fieldErrors,
        });
        return;
      }
      for (const [key, value] of Object.entries(changes)) {
        const strVal = String(value);
        if (strVal.length > 2000) {
          jsonResponse(res, 400, { ok: false, error: `Value for ${key} exceeds 2000 chars` });
          return;
        }
        if (strVal.includes('\0') || strVal.includes('\n') || strVal.includes('\r')) {
          jsonResponse(res, 400, { ok: false, error: `Value for ${key} contains illegal characters (null bytes or newlines)` });
          return;
        }
      }
      // Apply to process.env
      const strChanges = {};
      for (const [key, value] of Object.entries(changes)) {
        const strVal = String(value);
        process.env[key] = strVal;
        strChanges[key] = strVal;
      }
      if (Object.prototype.hasOwnProperty.call(strChanges, "KANBAN_BACKEND")) {
        try {
          setKanbanBackend(
            String(strChanges.KANBAN_BACKEND).trim().toLowerCase(),
          );
        } catch (err) {
          console.warn(`[settings] failed to switch kanban backend: ${err.message}`);
        }
      }
      // Write to .env file
      const updated = updateEnvFile(strChanges);
      const configUpdate = updateConfigFile(changes);
      const configDir = configUpdate.path ? dirname(configUpdate.path) : null;
      _settingsLastUpdateTime = now;
      broadcastUiEvent(["settings", "overview"], "invalidate", { reason: "settings-updated", keys: updated });
      jsonResponse(res, 200, {
        ok: true,
        updated,
        updatedConfig: configUpdate.updated || [],
        configPath: configUpdate.path || null,
        configDir,
        tunnel: getTunnelStatus(),
        fallbackAuth: getFallbackAuthStatus(),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/project-summary") {
    try {
      const adapter = getKanbanAdapter();
      const projects = await adapter.listProjects();
      const project = projects?.[0] || null;
      if (project) {
        const tasks = await adapter.listTasks(project.id || project.name).catch(() => []);
        const completedCount = tasks.filter(
          (t) => t.status === "done" || t.status === "closed" || t.status === "completed",
        ).length;
        jsonResponse(res, 200, {
          ok: true,
          data: {
            id: project.id || project.name,
            name: project.name || project.title || project.id,
            description: project.description || project.body || null,
            taskCount: tasks.length,
            completedCount,
          },
        });
      } else {
        jsonResponse(res, 200, { ok: true, data: null });
      }
    } catch (err) {
      jsonResponse(res, 200, { ok: true, data: null });
    }
    return;
  }

  if (path === "/api/project-sync/metrics") {
    try {
      const syncEngine = uiDeps.getSyncEngine?.() || null;
      jsonResponse(res, 200, {
        ok: true,
        data: {
          webhook: getProjectSyncWebhookMetrics(),
          syncEngine: syncEngine?.getStatus?.()?.metrics || null,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/github/app/config") {
    const appId = (process.env.BOSUN_GITHUB_APP_ID || "").trim();
    const privateKeyPath = (process.env.BOSUN_GITHUB_PRIVATE_KEY_PATH || "").trim();
    const clientId = (process.env.BOSUN_GITHUB_CLIENT_ID || "").trim();
    const webhookSecretSet = Boolean(process.env.BOSUN_GITHUB_WEBHOOK_SECRET);
    const appWebhookPath = getAppWebhookPath();

    // Build public URLs from tunnel URL if available, else from request host.
    let baseUrl = String(getTunnelUrl() || "").replace(/\/+$/, "");
    if (!baseUrl) {
      const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
      const proto = uiServerTls || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
      baseUrl = `${proto}://${host}`;
    }

    jsonResponse(res, 200, {
      ok: true,
      data: {
        appId: appId || null,
        appSlug: "bosun-ve",
        botUsername: "bosun-ve[bot]",
        appUrl: "https://github.com/apps/bosun-ve",
        configured: {
          appId: Boolean(appId),
          privateKey: Boolean(privateKeyPath),
          oauthClient: Boolean(clientId),
          webhookSecret: webhookSecretSet,
        },
        urls: {
          webhookUrl: `${baseUrl}${appWebhookPath}`,
          oauthCallbackUrl: `${baseUrl}/api/github/callback`,
        },
        paths: {
          webhookPath: appWebhookPath,
          oauthCallbackPath: "/api/github/callback",
        },
      },
    });
    return;
  }

  if (path === "/api/command") {
    try {
      const body = await readJsonBody(req);
      const command = (body?.command || "").trim();
      if (!command) {
        jsonResponse(res, 400, { ok: false, error: "command is required" });
        return;
      }
      const ALLOWED_CMD_PREFIXES = [
        "/status",
        "/health",
        "/plan",
        "/logs",
        "/agentlogs",
        "/menu",
        "/tasks",
        "/start",
        "/stop",
        "/pause",
        "/resume",
        "/sdk",
        "/kanban",
        "/region",
        "/deploy",
        "/agents",
        "/executor",
        "/help",
        "/commands",
        "/starttask",
        "/stoptask",
        "/retrytask",
        "/parallelism",
        "/sentinel",
        "/hooks",
        "/version",
        "/ask",
        "/compact",
        "/context",
        "/mcp",
        "/helpfull",
        "/background",
        "/bg",
        "/shell",
        "/git",
        "/diff",
        "/branches",
        "/threads",
        "/worktrees",
        "/model",
        "/retry",
        "/history",
        "/clear",
        "/anomalies",
        "/workspace",
        "/ws",
      ];
      const cmdBase = command.split(/\s/)[0].toLowerCase();
      const privilegedCommandAccess = isPrivilegedAuthSource(authResult?.source);
      if (!privilegedCommandAccess && !ALLOWED_CMD_PREFIXES.some(p => cmdBase === p || cmdBase.startsWith(p + " "))) {
        jsonResponse(res, 400, { ok: false, error: `Command not allowed: ${cmdBase}` });
        return;
      }
      const handler = uiDeps.handleUiCommand;
      if (typeof handler === "function") {
        if (ASYNC_UI_COMMAND_BASES.has(cmdBase)) {
          setImmediate(() => {
            let pending;
            try {
              pending = Promise.resolve(handler(command));
            } catch (err) {
              console.warn(`[ui] async command failed (${command}): ${err?.message || err}`);
              broadcastUiEvent(["overview", "executor", "tasks"], "invalidate", {
                reason: "command-failed",
                command,
              });
              return;
            }
            pending
              .then(() => {
                broadcastUiEvent(["overview", "executor", "tasks"], "invalidate", {
                  reason: "command-executed",
                  command,
                });
              })
              .catch((err) => {
                console.warn(`[ui] async command failed (${command}): ${err?.message || err}`);
                broadcastUiEvent(["overview", "executor", "tasks"], "invalidate", {
                  reason: "command-failed",
                  command,
                });
              });
          });
          jsonResponse(res, 202, {
            ok: true,
            queued: true,
            command,
            message: "Command accepted and running in background.",
          });
        } else {
          const result = await handler(command);
          jsonResponse(res, 200, { ok: true, data: result || null, command });
        }
      } else {
        // No command handler wired — acknowledge and broadcast refresh
        jsonResponse(res, 200, {
          ok: true,
          data: null,
          command,
          message: "Command queued. Check status for results.",
        });
      }
      broadcastUiEvent(["overview", "executor", "tasks"], "invalidate", {
        reason: ASYNC_UI_COMMAND_BASES.has(cmdBase) ? "command-queued" : "command-executed",
        command,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/retry") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId is required" });
        return;
      }
      const executor = uiDeps.getInternalExecutor?.();
      if (!executor) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Internal executor not enabled.",
        });
        return;
      }
      const adapter = getKanbanAdapter();
      const task = await adapter.getTask(taskId);
      if (!task) {
        jsonResponse(res, 404, { ok: false, error: "Task not found." });
        return;
      }
      let nextTask = unblockInternalTask(taskId, {
        status: "todo",
        source: "manual-retry",
      });
      resetExecutorTaskThrottleState(taskId);
      if (!nextTask) {
        if (typeof adapter.updateTask === "function") {
          await adapter.updateTask(taskId, {
            status: "todo",
            cooldownUntil: null,
            blockedReason: null,
            meta: task?.meta && typeof task.meta === "object"
              ? Object.fromEntries(Object.entries(task.meta).filter(([key]) => key !== "autoRecovery"))
              : task?.meta,
          });
        } else if (typeof adapter.updateTaskStatus === "function") {
          await adapter.updateTaskStatus(taskId, "todo");
        }
        nextTask = await adapter.getTask(taskId);
      }
      executor.executeTask(nextTask || { ...task, status: "todo" }).catch((error) => {
        console.warn(
          `[telegram-ui] failed to retry task ${taskId}: ${error.message}`,
        );
      });
      const bus = _resolveEventBus();
      if (bus && typeof bus.clearRetryQueueTask === "function") {
        try {
          bus.clearRetryQueueTask(taskId, "manual-retry-now");
        } catch {
          /* best effort */
        }
      }
      jsonResponse(res, 200, { ok: true, taskId });
      broadcastUiEvent(
        ["tasks", "overview", "executor", "agents"],
        "invalidate",
        { reason: "task-retried", taskId },
      );
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/tasks/unblock") {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      jsonResponse(res, 405, { ok: false, error: "Method Not Allowed" });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      const targetStatus = String(body?.status || "todo").trim().toLowerCase() || "todo";
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId is required" });
        return;
      }
      const adapter = getKanbanAdapter();
      const task = await adapter.getTask(taskId);
      if (!task) {
        jsonResponse(res, 404, { ok: false, error: "Task not found." });
        return;
      }
      let updatedTask = unblockInternalTask(taskId, {
        status: targetStatus,
        source: "api.tasks.unblock",
      });
      resetExecutorTaskThrottleState(taskId);
      if (!updatedTask) {
        const nextMeta = task?.meta && typeof task.meta === "object"
          ? Object.fromEntries(Object.entries(task.meta).filter(([key]) => key !== "autoRecovery"))
          : task?.meta;
        if (typeof adapter.updateTask === "function") {
          await adapter.updateTask(taskId, {
            status: targetStatus,
            cooldownUntil: null,
            blockedReason: null,
            meta: nextMeta,
          });
        } else if (typeof adapter.updateTaskStatus === "function") {
          await adapter.updateTaskStatus(taskId, targetStatus);
        }
        updatedTask = await adapter.getTask(taskId);
      }
      jsonResponse(res, 200, { ok: true, taskId, data: updatedTask || null });
      broadcastUiEvent(
        ["tasks", "overview", "executor", "agents"],
        "invalidate",
        { reason: "task-unblocked", taskId },
      );
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── GET /api/retry-queue ───────────────────────────────────────────
  if (path === "/api/retry-queue" && req.method === "GET") {
    try {
      const bus = _resolveEventBus();
      let retryQueue = null;
      if (bus && typeof bus.getRetryQueue === "function") {
        try {
          const snapshot = bus.getRetryQueue();
          if (snapshot && typeof snapshot === "object") {
            retryQueue = snapshot;
          }
        } catch {
          /* best effort */
        }
      }
      if (!retryQueue) {
        retryQueue = globalThis.__bosun_setRetryQueueData
          ? _retryQueue
          : {
              count: 0,
              items: [],
              stats: { totalRetriesToday: 0, peakRetryDepth: 0, exhaustedTaskIds: [] },
            };
      }
      jsonResponse(res, 200, {
        ok: true,
        count: retryQueue.count || 0,
        items: retryQueue.items || [],
        stats: retryQueue.stats || {
          totalRetriesToday: 0,
          peakRetryDepth: 0,
          exhaustedTaskIds: [],
        },
      });
    } catch (err) {
      jsonResponse(res, 500, {
        ok: false,
        error: err.message,
        count: 0,
        items: [],
        stats: { totalRetriesToday: 0, peakRetryDepth: 0, exhaustedTaskIds: [] },
      });
    }
    return;
  }

  if (path === "/api/executor/dispatch") {
    try {
      const executor = uiDeps.getInternalExecutor?.();
      if (!executor) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Internal executor not enabled.",
        });
        return;
      }
      const body = await readJsonBody(req);
      const taskId = (body?.taskId || "").trim();
      const prompt = (body?.prompt || "").trim();
      if (!taskId && !prompt) {
        jsonResponse(res, 400, {
          ok: false,
          error: "taskId or prompt is required",
        });
        return;
      }
      const status = executor.getStatus?.() || {};
      if (taskId) {
        const adapter = getKanbanAdapter();
        const task = await adapter.getTask(taskId);
        if (!task) {
          jsonResponse(res, 404, { ok: false, error: "Task not found." });
          return;
        }
        executor.executeTask(task, { force: true }).catch((error) => {
          console.warn(
            `[telegram-ui] dispatch failed for ${taskId}: ${error.message}`,
          );
        });
        jsonResponse(res, 200, {
          ok: true,
          slotIndex: status.activeSlots || 0,
          taskId,
        });
      } else {
        // Ad-hoc prompt dispatch via command handler
        const handler = uiDeps.handleUiCommand;
        if (typeof handler === "function") {
          const result = await handler(`/prompt ${prompt}`);
          jsonResponse(res, 200, {
            ok: true,
            slotIndex: status.activeSlots || 0,
            data: result || null,
          });
        } else {
          jsonResponse(res, 400, {
            ok: false,
            error: "Prompt dispatch not available — no command handler.",
          });
          return;
        }
      }
      broadcastUiEvent(
        ["executor", "overview", "agents", "tasks"],
        "invalidate",
        { reason: "task-dispatched", taskId: taskId || "(ad-hoc)" },
      );
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/executor/stop-slot") {
    try {
      const executor = uiDeps.getInternalExecutor?.();
      if (!executor) {
        jsonResponse(res, 400, {
          ok: false,
          error: "Internal executor not enabled.",
        });
        return;
      }
      const body = await readJsonBody(req);
      const slot = Number(body?.slot ?? -1);
      if (typeof executor.stopSlot === "function") {
        await executor.stopSlot(slot);
      } else if (typeof executor.cancelSlot === "function") {
        await executor.cancelSlot(slot);
      } else {
        jsonResponse(res, 400, {
          ok: false,
          error: "Executor does not support stop-slot.",
        });
        return;
      }
      jsonResponse(res, 200, { ok: true, slot });
      broadcastUiEvent(["executor", "overview", "agents"], "invalidate", {
        reason: "slot-stopped",
        slot,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Agent API endpoints ────────────────────────────────────────────────

  if (path === "/api/agents/available" && req.method === "GET") {
    try {
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: false })
        || { workspaceDir: repoRoot, workspaceRoot: repoRoot };
      const agents = getAvailableAgents();
      const active = getPrimaryAgentSelection();
      const mode = getAgentMode();
      const manualAgents = listManualAgentProfiles(workspaceContext);
      jsonResponse(res, 200, { ok: true, agents, active, mode, manualAgents });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agents/switch" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const agent = (body?.agent || "").trim();
      if (!agent) {
        jsonResponse(res, 400, { ok: false, error: "agent is required" });
        return;
      }
      const previousAgent = getPrimaryAgentSelection();
      const result = await switchPrimaryAgent(agent);
      if (!result.ok) {
        jsonResponse(res, 400, { ok: false, error: result.reason || "Switch failed" });
        return;
      }
      const newAgent = getPrimaryAgentSelection();
      jsonResponse(res, 200, { ok: true, agent: newAgent, previousAgent });
      broadcastUiEvent(["agents", "sessions", "overview"], "invalidate", {
        reason: "agent-switched",
        agent: newAgent,
        previousAgent,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agents/mode" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const mode = (body?.mode || "").trim();
      if (!mode) {
        jsonResponse(res, 400, { ok: false, error: "mode is required" });
        return;
      }
      const result = setAgentMode(mode);
      if (!result.ok) {
        jsonResponse(res, 400, { ok: false, error: result.error });
        return;
      }
      jsonResponse(res, 200, { ok: true, mode: result.mode });
      broadcastUiEvent(["agents", "sessions"], "invalidate", {
        reason: "agent-mode-changed",
        mode: result.mode,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agents/mode" && req.method === "GET") {
    jsonResponse(res, 200, { ok: true, mode: getAgentMode() });
    return;
  }

  if (path === "/api/agent/modes" && req.method === "GET") {
    const { listAvailableModes } = await import("../agent/primary-agent.mjs");
    jsonResponse(res, 200, { modes: listAvailableModes() });
    return;
  }

  if (path === "/api/agents/sdk-command" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const command = (body?.command || "").trim();
      if (!command) {
        jsonResponse(res, 400, { ok: false, error: "command is required" });
        return;
      }
      const args = (body?.args || "").trim();
      const adapter = (body?.adapter || "").trim() || undefined;
      const requestedSessionId = String(body?.sessionId || "").trim();
      const tracker = getSessionTracker();
      const commandSession = requestedSessionId
        ? tracker.getSessionById(requestedSessionId)
        : null;
      const commandCwd = resolveSessionWorkspaceDir(commandSession);
      const runSdkCommand =
        typeof uiDeps.execSdkCommand === "function"
          ? uiDeps.execSdkCommand
          : execSdkCommand;
      const result = await runSdkCommand(command, args, adapter, {
        cwd: commandCwd,
        sessionId: requestedSessionId || undefined,
      });
      const parsed = typeof result === "string" ? result : JSON.stringify(result);
      jsonResponse(res, 200, {
        ok: true,
        result: parsed,
        command,
        adapter: adapter || getPrimaryAgentName(),
        sessionId: requestedSessionId || null,
      });
      broadcastUiEvent(["agents", "sessions"], "invalidate", {
        reason: "sdk-command-executed",
        command,
      });
    } catch (err) {
      const status = err.message?.includes("not supported") ? 400 : 500;
      jsonResponse(res, status, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agents/info" && req.method === "GET") {
    try {
      const info = getPrimaryAgentInfo();
      const mode = getAgentMode();
      const commands = getSdkCommands();
      jsonResponse(res, 200, { ok: true, ...info, mode, sdkCommands: commands });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Agent Event Bus API ───────────────────────────────────────────────

  if (path === "/api/agents/events" && req.method === "GET") {
    try {
      const bus = _resolveEventBus();
      if (!bus) {
        jsonResponse(res, 503, { ok: false, error: "Event bus not available" });
        return;
      }
      const taskId = url.searchParams.get("taskId") || undefined;
      const type = url.searchParams.get("type") || undefined;
      const since = url.searchParams.get("since")
        ? Number(url.searchParams.get("since"))
        : undefined;
      const limit = url.searchParams.get("limit")
        ? Number(url.searchParams.get("limit"))
        : 100;
      const events = bus.getEventLog({ taskId, type, since, limit });
      jsonResponse(res, 200, { ok: true, events });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agents/events/errors" && req.method === "GET") {
    try {
      const bus = _resolveEventBus();
      if (!bus) {
        jsonResponse(res, 503, { ok: false, error: "Event bus not available" });
        return;
      }
      const taskId = url.searchParams.get("taskId");
      if (taskId) {
        const history = bus.getErrorHistory(taskId);
        jsonResponse(res, 200, { ok: true, taskId, errors: history });
      } else {
        const summary = bus.getErrorPatternSummary();
        jsonResponse(res, 200, { ok: true, patterns: summary });
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agents/events/liveness" && req.method === "GET") {
    try {
      const bus = _resolveEventBus();
      if (!bus) {
        jsonResponse(res, 503, { ok: false, error: "Event bus not available" });
        return;
      }
      const liveness = bus.getAgentLiveness();
      jsonResponse(res, 200, { ok: true, agents: liveness });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/agents/events/status" && req.method === "GET") {
    try {
      const bus = _resolveEventBus();
      if (!bus) {
        jsonResponse(res, 503, { ok: false, error: "Event bus not available" });
        return;
      }
      const status = bus.getStatus();
      jsonResponse(res, 200, { ok: true, ...status });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Supervisor API endpoint ──
  if (path === "/api/supervisor/status" && req.method === "GET") {
    try {
      const supervisor = typeof uiDeps.getAgentSupervisor === "function"
        ? uiDeps.getAgentSupervisor()
        : null;
      if (!supervisor) {
        jsonResponse(res, 503, { ok: false, error: "Supervisor not available" });
        return;
      }
      const systemHealth = supervisor.getSystemHealth();
      const diagnostics = supervisor.getAllDiagnostics();
      jsonResponse(res, 200, { ok: true, ...systemHealth, tasks: diagnostics });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/supervisor/task/") && req.method === "GET") {
    try {
      const supervisor = typeof uiDeps.getAgentSupervisor === "function"
        ? uiDeps.getAgentSupervisor()
        : null;
      if (!supervisor) {
        jsonResponse(res, 503, { ok: false, error: "Supervisor not available" });
        return;
      }
      const taskId = path.split("/api/supervisor/task/")[1];
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "Missing taskId" });
        return;
      }
      const diag = supervisor.getTaskDiagnostics(taskId);
      if (!diag) {
        jsonResponse(res, 404, { ok: false, error: "Task not tracked" });
        return;
      }
      jsonResponse(res, 200, { ok: true, ...diag });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Session API endpoints ──────────────────────────────────────────────

  if (path === "/api/sessions" && req.method === "GET") {
    try {
      const tracker = getSessionTracker();
      const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: true });
      if (!workspaceContext) {
        jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
        return;
      }
      let sessions = tracker.listAllSessions();
      const includeHidden = /^(1|true|yes)$/i.test(String(url.searchParams.get("includeHidden") || "").trim());
      const typeFilter = url.searchParams.get("type");
      const statusFilter = url.searchParams.get("status");
      if (!includeHidden) {
        sessions = sessions.filter((session) => {
          const detailed = tracker.getSessionById(session.id) || session;
          return !shouldHideSessionFromDefaultList(detailed);
        });
      }
      if (typeFilter) sessions = sessions.filter((s) => s.type === typeFilter);
      if (statusFilter) sessions = sessions.filter((s) => s.status === statusFilter);
      sessions = sessions.filter((session) => {
        const detailed = tracker.getSessionById(session.id) || session;
        return sessionMatchesWorkspaceContext(detailed, workspaceContext);
      });
      jsonResponse(res, 200, {
        ok: true,
        sessions,
        loadMeta: {
          stale: false,
          lastSuccessAt: new Date().toISOString(),
          lastFailureAt: null,
          staleReason: null,
          staleReasonCode: null,
          staleReasonLabel: null,
          staleReasonMeta: null,
          retryAttempt: 0,
          retryDelayMs: 0,
          nextRetryAt: null,
          retriesExhausted: false,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/sessions/create" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const type = body?.type || "manual";
      const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const workspaceContext = resolveActiveWorkspaceExecutionContext();
      const requestedWorkspaceId = String(body?.workspaceId || "").trim();
      const requestedWorkspaceDir = normalizeCandidatePath(body?.workspaceDir);
      const resolvedWorkspaceId =
        requestedWorkspaceId || workspaceContext.workspaceId;
      const resolvedWorkspaceDir =
        requestedWorkspaceDir || workspaceContext.workspaceDir || repoRoot;
      const requestedAgentProfileId = String(body?.agentProfileId || "").trim();
      const tracker = getSessionTracker();
      const session = tracker.createSession({
        id,
        type,
        metadata: {
          prompt: body?.prompt,
          agent: body?.agent || getPrimaryAgentName(),
          mode: body?.mode || getAgentMode(),
          model: body?.model || undefined,
          ...(requestedAgentProfileId ? { agentProfileId: requestedAgentProfileId } : {}),
          ...(resolvedWorkspaceId ? { workspaceId: resolvedWorkspaceId } : {}),
          ...(resolvedWorkspaceDir ? { workspaceDir: resolvedWorkspaceDir } : {}),
        },
      });
      jsonResponse(res, 200, { ok: true, session: { id: session.id, type: session.type, status: session.status, metadata: session.metadata } });
      broadcastUiEvent(["sessions"], "invalidate", { reason: "session-created", sessionId: id });
      broadcastSessionsSnapshot();
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // Parameterized session routes: /api/sessions/:id[/action]
  const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1]);
    const action = sessionMatch[2] || null;
    // Session-specific routes should support workspace=all so the UI can open
    // historical sessions while browsing cross-workspace lists.
    const workspaceContext = resolveWorkspaceContextFromRequest(url, { allowAll: true });
    if (!workspaceContext) {
      jsonResponse(res, 400, { ok: false, error: "Unknown workspace" });
      return;
    }
    const tracker = getSessionTracker();
    const getScopedSession = () => {
      const session = tracker.getSessionById(sessionId);
      if (!session) return null;
      return sessionMatchesWorkspaceContext(session, workspaceContext) ? session : null;
    };

    if (!action && req.method === "GET") {
      try {
        if (!getScopedSession()) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        const session = tracker.getSessionMessages(sessionId);
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        // Support ?limit=N&offset=N for message pagination.
        // Default to a bounded tail window so large sessions don't crash the UI.
        const reqUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const limitParam = reqUrl.searchParams.get("limit");
        const offsetParam = reqUrl.searchParams.get("offset");
        const fullParam = String(reqUrl.searchParams.get("full") || "").toLowerCase();
        const wantsFull =
          fullParam === "1" || fullParam === "true" || fullParam === "yes";
        if (wantsFull) {
          jsonResponse(res, 200, { ok: true, session });
        } else {
          const parsedLimit = Number(limitParam);
          const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.max(1, Math.min(Math.floor(parsedLimit), 200))
            : 20;
          const allMessages = session.messages || [];
          const total = allMessages.length;
          const offset = offsetParam != null
            ? Math.max(0, Math.min(Number(offsetParam) || 0, total))
            : Math.max(0, total - limit);
          const sliced = allMessages.slice(offset, offset + limit);
          jsonResponse(res, 200, {
            ok: true,
            session: { ...session, messages: sliced },
            pagination: { total, offset, limit, hasMore: offset > 0 },
          });
        }
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "attachments" && req.method === "POST") {
      try {
        const session = getScopedSession();
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        const { files } = await readMultipartForm(req);
        if (!files.length) {
          jsonResponse(res, 400, { ok: false, error: "file required" });
          return;
        }
        const safeSession = sanitizePathSegment(sessionId);
        const targetDir = resolve(ATTACHMENTS_ROOT, "sessions", safeSession);
        mkdirSync(targetDir, { recursive: true });
        const added = [];
        for (const file of files) {
          const originalName = file.filename || "attachment";
          const ext = extname(originalName).toLowerCase();
          const base = sanitizePathSegment(basename(originalName, ext)) || "attachment";
          const unique = `${Date.now()}-${randomBytes(4).toString("hex")}`;
          const storedName = `${base}-${unique}${ext}`;
          const filePath = resolve(targetDir, storedName);
          writeFileSync(filePath, file.data);
          const relPath = relative(ATTACHMENTS_ROOT, filePath);
          const contentType =
            file.contentType || MIME_TYPES[ext] || "application/octet-stream";
          const kind =
            contentType.startsWith("image/") ||
            [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)
              ? "image"
              : "file";
          added.push({
            name: originalName,
            filePath,
            relativePath: relPath,
            url: resolveAttachmentUrl(relPath),
            size: file.data.length,
            contentType,
            kind,
            source: "upload",
            sourceType: "session",
            createdAt: new Date().toISOString(),
          });
        }
        jsonResponse(res, 200, { ok: true, attachments: added });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "stop" && req.method === "POST") {
      try {
        const session = getScopedSession();
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }

        const abortController = sessionRunAbortControllers.get(sessionId);
        const wasRunning = Boolean(abortController && !abortController.signal?.aborted);
        if (wasRunning) {
          try {
            abortController.abort("user_stop");
          } catch {
            /* best effort */
          }
          tracker.recordEvent(sessionId, {
            role: "system",
            type: "system",
            content: "Stop requested. Cancelling current agent turn...",
            timestamp: new Date().toISOString(),
          });
        }

        jsonResponse(res, 200, { ok: true, stopped: wasRunning });
        broadcastUiEvent(["sessions", "agents"], "invalidate", {
          reason: wasRunning ? "session-stop-requested" : "session-stop-noop",
          sessionId,
        });
        broadcastSessionsSnapshot();
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "message" && req.method === "POST") {
      try {
        const session = getScopedSession();
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        if (session.status === "paused" || session.status === "archived") {
          jsonResponse(res, 400, { ok: false, error: `Session is ${session.status}` });
          return;
        }
        // Re-activate completed/failed sessions when user sends a new message
        if (session.status === "completed" || session.status === "failed") {
          tracker.updateSessionStatus(sessionId, "active");
        }
        const body = await readJsonBody(req);
        const content = body?.content;
        const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
        const attachmentsAppended = body?.attachmentsAppended === true;
        if (!content && attachments.length === 0) {
          jsonResponse(res, 400, { ok: false, error: "content is required" });
          return;
        }
        const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const messageContent = typeof content === "string" ? content : "";

        // Per-message mode override (e.g. { "content": "...", "mode": "ask" })
        const messageMode = body?.mode || undefined;
        // Per-message model override (e.g. { "model": "o4-mini" })
        const messageModel = body?.model || undefined;
        const messageAgentProfileId = String(
          body?.agentProfileId || session?.metadata?.agentProfileId || "",
        ).trim() || undefined;

        // Forward to primary agent if applicable (exec records user + assistant events)
        let exec = session.type === "primary" ? uiDeps.execPrimaryPrompt : null;
        // Fallback: resolve execPrimaryPrompt from primary-agent.mjs if not injected
        if (!exec && session.type === "primary") {
          exec = await resolveExecPrimaryPrompt();
        }
        if (exec) {
          const sessionWorkspaceDir = resolveSessionWorkspaceDir(session);
          // Don't record user event here — execPrimaryPrompt records it
          // Respond immediately so the UI doesn't block on agent execution
          jsonResponse(res, 200, { ok: true, messageId });
          broadcastUiEvent(["sessions"], "invalidate", { reason: "session-message", sessionId });
          broadcastSessionsSnapshot();

          // Build an onEvent callback so intermediate SDK events (thinking,
          // tool calls, code edits, etc.) are streamed to the UI in real-time
          // via the existing session-tracker → WebSocket listener pipeline.
          // Without this, chat/telegram dispatches only show the final
          // user+assistant pair instead of the full thought stream that Flows
          // clients see.
          const streamOnEvent = (err, event) => {
            // The adapters call onEvent(err, event) or onEvent(event).
            // Normalise both calling conventions.
            const ev = event || err;
            if (!ev) return;
            try {
              if (typeof ev === "string") {
                tracker.recordEvent(sessionId, {
                  role: "system",
                  type: "system",
                  content: ev,
                  timestamp: new Date().toISOString(),
                });
              } else {
                tracker.recordEvent(sessionId, ev);
              }
            } catch {
              /* best-effort — never crash the agent loop */
            }
          };

          // Fire-and-forget: run agent asynchronously so the request handler
          // doesn't block and the agent doesn't appear "busy" to subsequent
          // messages from chat, telegram, portal, or any other source.
          const abortController = new AbortController();
          sessionRunAbortControllers.set(sessionId, abortController);
          exec(messageContent, {
            sessionId,
            sessionType: "primary",
            mode: messageMode,
            model: messageModel,
            agentProfileId: messageAgentProfileId,
            cwd: sessionWorkspaceDir,
            persistent: true,
            sendRawEvents: true,
            attachments,
            attachmentsAppended,
            onEvent: streamOnEvent,
            abortController,
          }).then(() => {
            // Mark session as completed once the agent finishes — prevents
            // sessions from staying "active" forever and causing session bloat.
            tracker.updateSessionStatus(sessionId, "completed");
            broadcastUiEvent(["sessions"], "invalidate", { reason: "agent-response", sessionId });
            broadcastSessionsSnapshot();
          }).catch((execErr) => {
            const wasAborted =
              abortController.signal.aborted ||
              execErr?.name === "AbortError" ||
              /abort|cancel|stop/i.test(String(execErr?.message || ""));
            if (wasAborted) {
              tracker.recordEvent(sessionId, {
                role: "system",
                type: "system",
                content: "Agent turn stopped.",
                timestamp: new Date().toISOString(),
              });
              tracker.updateSessionStatus(sessionId, "completed");
              broadcastUiEvent(["sessions"], "invalidate", {
                reason: "agent-stopped",
                sessionId,
              });
              broadcastSessionsSnapshot();
              return;
            }
            // Record error as system message so user sees feedback
            tracker.recordEvent(sessionId, {
              role: "system",
              type: "error",
              content: `Agent error: ${execErr.message || "Unknown error"}`,
              timestamp: new Date().toISOString(),
            });
            tracker.updateSessionStatus(sessionId, "failed");
            broadcastUiEvent(["sessions"], "invalidate", { reason: "agent-error", sessionId });
            broadcastSessionsSnapshot();
          }).finally(() => {
            // Clear only if this turn still owns the session abort controller.
            if (sessionRunAbortControllers.get(sessionId) === abortController) {
              sessionRunAbortControllers.delete(sessionId);
            }
            broadcastUiEvent(["agents"], "invalidate", {
              reason: "session-turn-finished",
              sessionId,
            });
          });
        } else {
          // No agent available — record user event and notify user
          tracker.recordEvent(sessionId, {
            role: "user",
            content: messageContent,
            attachments,
            timestamp: new Date().toISOString(),
          });
          tracker.recordEvent(sessionId, {
            role: "system",
            type: "error",
            content: ":alert: No agent is available to process this message. The primary agent may not be initialized — try restarting bosun or check the Logs tab for details.",
            timestamp: new Date().toISOString(),
          });
          jsonResponse(res, 200, { ok: true, messageId, warning: "no_agent_available" });
          broadcastUiEvent(["sessions"], "invalidate", { reason: "session-message", sessionId });
          broadcastSessionsSnapshot();
        }
      } catch (err) {
        console.error("[ui-server] session message failed for %s: %s", String(sessionId), String(err?.message || err || "unknown"));
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "message/edit" && req.method === "POST") {
      try {
        const session = getScopedSession();
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        const body = await readJsonBody(req);
        const content = String(body?.content || "").trim();
        if (!content) {
          jsonResponse(res, 400, { ok: false, error: "content is required" });
          return;
        }

        const edited = tracker.editUserMessage(sessionId, {
          messageId: body?.messageId,
          timestamp: body?.timestamp,
          previousContent: body?.previousContent,
          content,
        });
        if (!edited?.ok) {
          const status = edited?.error === "Message not found" ? 404 : 400;
          jsonResponse(res, status, { ok: false, error: edited?.error || "edit failed" });
          return;
        }

        jsonResponse(res, 200, { ok: true, message: edited.message });
        broadcastUiEvent(["sessions"], "invalidate", {
          reason: "session-message-edited",
          sessionId,
        });
        broadcastSessionsSnapshot();
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "archive" && req.method === "POST") {
      try {
        const session = getScopedSession();
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        tracker.updateSessionStatus(sessionId, "archived");
        jsonResponse(res, 200, { ok: true });
        broadcastUiEvent(["sessions"], "invalidate", {
          reason: "session-archived",
          sessionId,
        });
        broadcastSessionsSnapshot();
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "pause" && req.method === "POST") {
      try {
        const session = getScopedSession();
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        tracker.updateSessionStatus(sessionId, "paused");
        jsonResponse(res, 200, { ok: true });
        broadcastUiEvent(["sessions"], "invalidate", { reason: "session-paused", sessionId });
        broadcastSessionsSnapshot();
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "resume" && req.method === "POST") {
      try {
        const session = getScopedSession();
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        tracker.updateSessionStatus(sessionId, "active");
        jsonResponse(res, 200, { ok: true });
        broadcastUiEvent(["sessions"], "invalidate", { reason: "session-resumed", sessionId });
        broadcastSessionsSnapshot();
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "delete" && req.method === "POST") {
      try {
        const session = getScopedSession();
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        tracker.removeSession(sessionId);
        jsonResponse(res, 200, { ok: true });
        broadcastUiEvent(["sessions"], "invalidate", {
          reason: "session-deleted",
          sessionId,
        });
        broadcastSessionsSnapshot();
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "rename" && req.method === "POST") {
      try {
        const session = getScopedSession();
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        const body = await readJsonBody(req);
        const title = (body?.title || "").trim();
        if (!title) {
          jsonResponse(res, 400, { ok: false, error: "title is required" });
          return;
        }
        tracker.renameSession(sessionId, title);
        jsonResponse(res, 200, { ok: true });
        broadcastUiEvent(["sessions"], "invalidate", { reason: "session-renamed", sessionId });
        broadcastSessionsSnapshot();
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "diff" && req.method === "GET") {
      try {
        const session = getScopedSession();
        if (!session) {
          jsonResponse(res, 200, {
            ok: true,
            diff: {
              files: [],
              totalFiles: 0,
              totalAdditions: 0,
              totalDeletions: 0,
              formatted: "(session not found)",
            },
            summary: "(session not found)",
            commits: [],
          });
          return;
        }
        const worktreePath = await resolveSessionWorktreePath(session);
        if (!worktreePath || !existsSync(worktreePath)) {
          jsonResponse(res, 200, { ok: true, diff: { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0, formatted: "(no worktree)" }, summary: "(no worktree)", commits: [] });
          return;
        }
        const stats = collectDiffStats(worktreePath);
        const summary = getCompactDiffSummary(worktreePath);
        const commits = getRecentCommits(worktreePath);
        jsonResponse(res, 200, { ok: true, diff: stats, summary, commits });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }
  }

  // ── Voice API Routes ──────────────────────────────────────────────────────

  // GET /api/voice/providers — read voice.providers from bosun.config.json
  if (path === "/api/voice/providers" && req.method === "GET") {
    try {
      const { configData } = readConfigDocument();
      const providers = Array.isArray(configData?.voice?.providers)
        ? configData.voice.providers
        : [];
      jsonResponse(res, 200, { ok: true, providers });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/providers — save voice.providers to bosun.config.json
  if (path === "/api/voice/providers" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { providers } = body || {};
      if (!Array.isArray(providers)) {
        jsonResponse(res, 400, { ok: false, error: "providers array required" });
        return;
      }
      const allowedProviders = ["openai", "azure", "claude", "gemini", "fallback"];
      const cleaned = providers.slice(0, 5).map((p) => {
        const out = {};
        if (p.provider && allowedProviders.includes(String(p.provider))) out.provider = String(p.provider);
        if (p.model) out.model = String(p.model);
        if (p.visionModel) out.visionModel = String(p.visionModel);
        if (p.voiceId) out.voiceId = String(p.voiceId);
        if (p.azureDeployment) out.azureDeployment = String(p.azureDeployment);
        if (p.endpointId) out.endpointId = String(p.endpointId);
        return out;
      });
      const { configPath, configData } = readConfigDocument();
      configData.voice = { ...(configData.voice || {}), providers: cleaned };
      writeFileSync(configPath, JSON.stringify(configData, null, 2) + "\n", "utf8");
      broadcastUiEvent(["settings", "overview"], "invalidate", {
        reason: "voice-providers-updated",
      });
      jsonResponse(res, 200, { ok: true, configPath, count: cleaned.length });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/voice/endpoints — read voice.voiceEndpoints from bosun.config.json
  if (path === "/api/voice/endpoints" && req.method === "GET") {
    try {
      const { configData } = readConfigDocument();
      const voiceEndpoints = Array.isArray(configData?.voice?.voiceEndpoints)
        ? configData.voice.voiceEndpoints
        : [];
      jsonResponse(res, 200, { ok: true, voiceEndpoints });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/endpoints — save voice.voiceEndpoints to bosun.config.json
  if (path === "/api/voice/endpoints" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { voiceEndpoints } = body || {};
      if (!Array.isArray(voiceEndpoints)) {
        jsonResponse(res, 400, { ok: false, error: "voiceEndpoints array required" });
        return;
      }
      // Strip client-only _id fields and sanitize
      const cleaned = voiceEndpoints.map(({ _id, ...ep }) => {
        const out = {};
        if (ep.id) out.id = String(ep.id);
        if (ep.name) out.name = String(ep.name);
        if (ep.provider) out.provider = String(ep.provider);
        if (ep.endpoint) out.endpoint = String(ep.endpoint);
        if (ep.deployment) out.deployment = String(ep.deployment);
        if (ep.model) out.model = String(ep.model);
        if (ep.visionModel) out.visionModel = String(ep.visionModel);
        if (ep.apiKey) out.apiKey = String(ep.apiKey);
        if (ep.authSource) out.authSource = ["apiKey", "oauth"].includes(ep.authSource) ? ep.authSource : "apiKey";
        if (ep.voiceId) out.voiceId = String(ep.voiceId);
        if (ep.role) out.role = String(ep.role);
        if (ep.weight != null) out.weight = Number(ep.weight) || 1;
        if (ep.enabled != null) out.enabled = ep.enabled !== false;
        return out;
      });
      const { configPath, configData } = readConfigDocument();
      configData.voice = { ...(configData.voice || {}), voiceEndpoints: cleaned };
      writeFileSync(configPath, JSON.stringify(configData, null, 2) + "\n", "utf8");
      broadcastUiEvent(["settings", "overview"], "invalidate", {
        reason: "voice-endpoints-updated",
      });
      jsonResponse(res, 200, { ok: true, configPath, count: cleaned.length });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/endpoints/test — quick connectivity check for a single endpoint
  if (path === "/api/voice/endpoints/test" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const { provider, apiKey, endpoint: azureEndpoint, deployment, model, authSource } = body || {};
      if (!provider) {
        jsonResponse(res, 400, { ok: false, error: "provider is required" });
        return;
      }
      const useOAuth = authSource === "oauth";
      const start = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);

      try {
        let testUrl;
        const headers = {};
        if (provider === "openai") {
          testUrl = "https://api.openai.com/v1/models";
          if (apiKey && !useOAuth) headers["Authorization"] = `Bearer ${apiKey}`;
          else {
            // Try OAuth token if no API key
            try {
              const { getOpenAILoginStatus } = await import("../voice/voice-auth-manager.mjs");
              const st = getOpenAILoginStatus();
              if (st.hasToken && st.accessToken) headers["Authorization"] = `Bearer ${st.accessToken}`;
            } catch (_) { /* no oauth available */ }
          }
          if (!headers["Authorization"]) {
            jsonResponse(res, 400, { ok: false, error: "No API key or OAuth token available" });
            return;
          }
        } else if (provider === "azure") {
          if (!azureEndpoint) {
            jsonResponse(res, 400, { ok: false, error: "Azure endpoint URL is required" });
            return;
          }
          // Endpoint URL is authoritative: preserve user-provided path/host exactly.
          // Only append default OpenAI probe routes when endpoint is just a bare host.
          const rawEndpoint = String(azureEndpoint || "").trim();
          const base = rawEndpoint.replace(/\/+$/, "");
          // Single-deployment GET only requires Cognitive Services User role.
          // Use the GA api-version (2024-10-21) for broad compatibility across
          // classic Azure OpenAI and Azure AI Foundry resources.
          const dep = String(deployment || "").trim();
          let endpointHasCustomPath = false;
          try {
            const parsed = new URL(base);
            const p = String(parsed.pathname || "").trim();
            endpointHasCustomPath = Boolean(p && p !== "/");
          } catch {
            endpointHasCustomPath = false;
          }
          if (endpointHasCustomPath) {
            // User supplied a concrete URL (possibly including /openai/... and query).
            // Respect it as final and issue the probe directly.
            testUrl = base;
          } else {
            // Always use /openai/models — works on both classic Azure OpenAI and
            // Azure AI Foundry (Global Standard) where /openai/deployments/{name}
            // returns 404.
            testUrl = `${base}/openai/models?api-version=2024-10-21`;
          }
          if (apiKey) headers["api-key"] = apiKey;
          else {
            jsonResponse(res, 400, { ok: false, error: "Azure API key is required" });
            return;
          }
        } else if (provider === "claude") {
          testUrl = "https://api.anthropic.com/v1/models";
          headers["anthropic-version"] = "2023-06-01";
          if (apiKey && !useOAuth) headers["x-api-key"] = apiKey;
          else {
            try {
              const { getClaudeLoginStatus } = await import("../voice/voice-auth-manager.mjs");
              const st = getClaudeLoginStatus();
              if (st.hasToken && st.accessToken) headers["x-api-key"] = st.accessToken;
            } catch (_) { /* no oauth available */ }
          }
          if (!headers["x-api-key"]) {
            jsonResponse(res, 400, { ok: false, error: "No API key or OAuth token available" });
            return;
          }
        } else if (provider === "gemini") {
          let k = (apiKey && !useOAuth) ? apiKey : null;
          if (!k) {
            try {
              const { getGeminiLoginStatus } = await import("../voice/voice-auth-manager.mjs");
              const st = getGeminiLoginStatus();
              if (st.hasToken && st.accessToken) k = st.accessToken;
            } catch (_) { /* no oauth available */ }
          }
          if (!k) {
            jsonResponse(res, 400, { ok: false, error: "No API key or OAuth token available" });
            return;
          }
          testUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(k)}`;
        } else if (provider === "custom") {
          const base = String(azureEndpoint || "").trim().replace(/\/+$/, "");
          if (!base) {
            jsonResponse(res, 400, { ok: false, error: "Custom endpoint URL is required" });
            return;
          }
          const bearer = String(apiKey || "").trim();
          if (!bearer) {
            jsonResponse(res, 400, { ok: false, error: "API key is required for custom endpoints" });
            return;
          }
          testUrl = `${base}/v1/models`;
          headers.Authorization = `Bearer ${bearer}`;
        } else {
          jsonResponse(res, 400, { ok: false, error: `Unknown provider: ${provider}` });
          return;
        }

        const resp = await fetch(testUrl, { headers, signal: controller.signal });
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        if (resp.ok || resp.status === 200) {
          // Credentials verified via /openai/models. If a deployment name was
          // provided, do a secondary check to confirm the deployment exists.
          if (provider === "azure" && deployment) {
            const dep = String(deployment).trim();
            try {
              let base2 = String(azureEndpoint || "").replace(/\/+$/, "");
              try { const u2 = new URL(base2); base2 = `${u2.protocol}//${u2.host}`; } catch { /* keep */ }
              const depUrl = `${base2}/openai/deployments/${encodeURIComponent(dep)}/chat/completions?api-version=2024-10-21`;
              const depCtrl = new AbortController();
              const depTimer = setTimeout(() => depCtrl.abort(), 8_000);
              const depResp = await fetch(depUrl, {
                method: "POST",
                headers: { ...headers, "Content-Type": "application/json" },
                body: JSON.stringify({ messages: [{ role: "user", content: "test" }], max_tokens: 1 }),
                signal: depCtrl.signal,
              });
              clearTimeout(depTimer);
              // 200 = chat model works, 400 = realtime model (expected), both confirm deployment exists
              if (depResp.ok || depResp.status === 400) {
                jsonResponse(res, 200, { ok: true, latencyMs, deployment: dep });
              } else if (depResp.status === 404) {
                jsonResponse(res, 200, { ok: false, error: `Credentials valid but deployment "${dep}" not found — check the deployment name in Azure AI Foundry`, latencyMs });
              } else {
                jsonResponse(res, 200, { ok: true, latencyMs, warning: `Credentials valid. Could not verify deployment "${dep}" (HTTP ${depResp.status})` });
              }
            } catch {
              jsonResponse(res, 200, { ok: true, latencyMs, warning: `Credentials valid. Could not verify deployment "${dep}" (timeout)` });
            }
          } else {
            jsonResponse(res, 200, { ok: true, latencyMs });
          }
        } else {
          const text = await resp.text().catch(() => "");
          let errMsg = `HTTP ${resp.status}`;
          try { const j = JSON.parse(text); errMsg = j.error?.message || j.error || errMsg; } catch (_) { /* ignore */ }
          if (provider === "openai" && useOAuth && /missing scopes?/i.test(String(errMsg || ""))) {
            const missing = String(errMsg || "").match(/Missing scopes?:\s*([A-Za-z0-9._:\s-]+)/i)?.[1]?.trim() || "required scopes";
            errMsg = `OpenAI Connected Account token is missing scopes (${missing}). Sign out and reconnect OpenAI in Connected Accounts. Also verify role access: org Owner/Reader, project Owner/Member, and workspace RBAC API/dashboard permissions.`;
          }
          // Azure-specific: provide helpful messages for common errors
          if (provider === "azure") {
            if (resp.status === 401 || resp.status === 403) {
              errMsg = `Authentication failed (HTTP ${resp.status}) — check API key and endpoint URL`;
            } else if (resp.status === 404) {
              errMsg = `Endpoint not found (HTTP 404) — check the Azure endpoint URL. Use https://<resource>.openai.azure.com`;
            }
          }
          jsonResponse(res, 200, { ok: false, error: errMsg, latencyMs });
        }
      } catch (fetchErr) {
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        const msg = fetchErr.name === "AbortError" ? "Timeout (10s)" : (fetchErr.message || "Connection failed");
        jsonResponse(res, 200, { ok: false, error: msg, latencyMs });
      }
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── OpenAI Codex OAuth routes ─────────────────────────────────────────────

  // GET /api/voice/auth/openai/status — token presence + pending login state
  if (path === "/api/voice/auth/openai/status" && req.method === "GET") {
    try {
      const { getOpenAILoginStatus } = await import("../voice/voice-auth-manager.mjs");
      jsonResponse(res, 200, { ok: true, ...getOpenAILoginStatus() });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/auth/openai/login — start PKCE login, open browser
  if (path === "/api/voice/auth/openai/login" && req.method === "POST") {
    try {
      const { startOpenAICodexLogin } = await import("../voice/voice-auth-manager.mjs");
      const { authUrl } = startOpenAICodexLogin();
      jsonResponse(res, 200, { ok: true, authUrl });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/auth/openai/cancel — cancel pending login
  if (path === "/api/voice/auth/openai/cancel" && req.method === "POST") {
    try {
      const { cancelOpenAILogin } = await import("../voice/voice-auth-manager.mjs");
      cancelOpenAILogin();
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/auth/openai/logout — remove stored token
  if (path === "/api/voice/auth/openai/logout" && req.method === "POST") {
    try {
      const { logoutOpenAI } = await import("../voice/voice-auth-manager.mjs");
      const result = logoutOpenAI();
      broadcastUiEvent(["settings", "voice"], "invalidate", {
        reason: "openai-oauth-logout",
      });
      jsonResponse(res, 200, { ok: true, ...result });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/auth/openai/refresh — exchange refresh_token for new access_token
  if (path === "/api/voice/auth/openai/refresh" && req.method === "POST") {
    try {
      const { refreshOpenAICodexToken } = await import("../voice/voice-auth-manager.mjs");
      await refreshOpenAICodexToken();
      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // ── Claude OAuth routes ────────────────────────────────────────────────────

  if (path === "/api/voice/auth/claude/status" && req.method === "GET") {
    try {
      const { getClaudeLoginStatus } = await import("../voice/voice-auth-manager.mjs");
      jsonResponse(res, 200, { ok: true, ...getClaudeLoginStatus() });
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }); }
    return;
  }

  if (path === "/api/voice/auth/claude/login" && req.method === "POST") {
    try {
      const { startClaudeLogin } = await import("../voice/voice-auth-manager.mjs");
      const { authUrl } = startClaudeLogin();
      jsonResponse(res, 200, { ok: true, authUrl });
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }); }
    return;
  }

  if (path === "/api/voice/auth/claude/cancel" && req.method === "POST") {
    try {
      const { cancelClaudeLogin } = await import("../voice/voice-auth-manager.mjs");
      cancelClaudeLogin();
      jsonResponse(res, 200, { ok: true });
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }); }
    return;
  }

  if (path === "/api/voice/auth/claude/logout" && req.method === "POST") {
    try {
      const { logoutClaude } = await import("../voice/voice-auth-manager.mjs");
      const result = logoutClaude();
      broadcastUiEvent(["settings", "voice"], "invalidate", { reason: "claude-oauth-logout" });
      jsonResponse(res, 200, { ok: true, ...result });
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }); }
    return;
  }

  if (path === "/api/voice/auth/claude/refresh" && req.method === "POST") {
    try {
      const { refreshClaudeToken } = await import("../voice/voice-auth-manager.mjs");
      await refreshClaudeToken();
      jsonResponse(res, 200, { ok: true });
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }); }
    return;
  }

  // ── Google Gemini OAuth routes ─────────────────────────────────────────────

  if (path === "/api/voice/auth/gemini/status" && req.method === "GET") {
    try {
      const { getGeminiLoginStatus } = await import("../voice/voice-auth-manager.mjs");
      jsonResponse(res, 200, { ok: true, ...getGeminiLoginStatus() });
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }); }
    return;
  }

  if (path === "/api/voice/auth/gemini/login" && req.method === "POST") {
    try {
      const { startGeminiLogin } = await import("../voice/voice-auth-manager.mjs");
      const { authUrl } = startGeminiLogin();
      jsonResponse(res, 200, { ok: true, authUrl });
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }); }
    return;
  }

  if (path === "/api/voice/auth/gemini/cancel" && req.method === "POST") {
    try {
      const { cancelGeminiLogin } = await import("../voice/voice-auth-manager.mjs");
      cancelGeminiLogin();
      jsonResponse(res, 200, { ok: true });
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }); }
    return;
  }

  if (path === "/api/voice/auth/gemini/logout" && req.method === "POST") {
    try {
      const { logoutGemini } = await import("../voice/voice-auth-manager.mjs");
      const result = logoutGemini();
      broadcastUiEvent(["settings", "voice"], "invalidate", { reason: "gemini-oauth-logout" });
      jsonResponse(res, 200, { ok: true, ...result });
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }); }
    return;
  }

  if (path === "/api/voice/auth/gemini/refresh" && req.method === "POST") {
    try {
      const { refreshGeminiToken } = await import("../voice/voice-auth-manager.mjs");
      await refreshGeminiToken();
      jsonResponse(res, 200, { ok: true });
    } catch (err) { jsonResponse(res, 500, { ok: false, error: err.message }); }
    return;
  }

  // GET /api/voice/sdk-config — SDK-first configuration for client
  if (path === "/api/voice/sdk-config" && req.method === "GET") {
    try {
      const relay = await resolveVoiceRelay();
      const { getClientSdkConfig } = await import("../voice/voice-agents-sdk.mjs");
      const voiceConfig = relay.getVoiceConfig(true);
      const sdkConfig = await getClientSdkConfig(voiceConfig);
      jsonResponse(res, 200, sdkConfig);
    } catch (err) {
      jsonResponse(res, 200, {
        useSdk: false,
        provider: "fallback",
        fallbackReason: err.message,
        tier: 2,
      });
    }
    return;
  }

  // GET /api/voice/config
  if (path === "/api/voice/config" && req.method === "GET") {
    try {
      const relay = await resolveVoiceRelay();
      const config = relay.getVoiceConfig(true);
      const availability = relay.isVoiceAvailable();
      const connectionInfo = availability.tier === 1 ? relay.getRealtimeConnectionInfo() : null;

      jsonResponse(res, 200, {
        available: availability.available,
        tier: availability.tier,
        provider: availability.provider,
        providerChain: config.providerChainWithFallbacks || [config.provider],
        reason: availability.reason || "",
        voiceId: config.voiceId,
        turnDetection: config.turnDetection,
        model: config.model,
        visionModel: config.visionModel,
        vision: {
          enabled: true,
          frameMaxBytes: MAX_VISION_FRAME_BYTES,
          defaultIntervalMs: DEFAULT_VISION_ANALYSIS_INTERVAL_MS,
        },
        fallbackMode: config.fallbackMode,
        failover: config.failover || null,
        diagnostics: Array.isArray(config.diagnostics) ? config.diagnostics : [],
        connectionInfo,
      });
    } catch (err) {
      const message = String(err?.message || "Internal server error");
      if (/does not support realtime token/i.test(message)) {
        jsonResponse(res, 400, { error: message });
      } else {
        jsonResponse(res, 500, { error: message });
      }
    }
    return;
  }

  // POST /api/voice/trace
  if (path === "/api/voice/trace" && req.method === "POST") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const inputEvents = Array.isArray(body?.events)
        ? body.events
        : [body];
      const storedEvents = [];

      for (const rawEvent of inputEvents) {
        if (!rawEvent || typeof rawEvent !== "object") continue;
        const merged = {
          ...rawEvent,
          sessionId: String(rawEvent?.sessionId || body?.sessionId || "").trim(),
          source: String(rawEvent?.source || body?.source || "voice-client").trim() || "voice-client",
          provider: String(rawEvent?.provider || body?.provider || "").trim() || undefined,
          transport: String(rawEvent?.transport || body?.transport || "").trim() || undefined,
        };
        const appended = appendVoiceTraceEvent(merged);
        if (appended) storedEvents.push(appended);
      }

      if (storedEvents.length === 0) {
        jsonResponse(res, 400, { ok: false, error: "No valid trace events supplied" });
        return;
      }

      jsonResponse(res, 200, {
        ok: true,
        stored: storedEvents.length,
        latest: storedEvents[storedEvents.length - 1] || null,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/voice/trace
  if (path === "/api/voice/trace" && req.method === "GET") {
    try {
      const sessionId = String(url.searchParams.get("sessionId") || "").trim();
      const latestOnly = ["1", "true", "yes"].includes(String(url.searchParams.get("latest") || "").trim().toLowerCase());
      const limit = parseVoiceTraceLimit(url.searchParams.get("limit"), latestOnly ? 1 : 50);
      const result = queryVoiceTraceEvents({ sessionId, limit, latestOnly });
      if (latestOnly) {
        jsonResponse(res, 200, {
          ok: true,
          latest: result.latest || null,
          total: Number(result.total || 0),
        });
        return;
      }

      jsonResponse(res, 200, {
        ok: true,
        events: Array.isArray(result.events) ? result.events : [],
        total: Number(result.total || 0),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/voice/agents
  if (path === "/api/voice/agents" && req.method === "GET") {
    try {
      const callContext = {
        sessionId: String(url.searchParams.get("sessionId") || "").trim() || undefined,
      };
      const libraryRoot = resolveVoiceLibraryRoot(callContext);
      const { agents, selected } = resolveActiveVoiceAgent(
        libraryRoot,
        String(url.searchParams.get("voiceAgentId") || "").trim(),
      );
      jsonResponse(res, 200, {
        ok: true,
        agents,
        defaultAgentId: selected?.id || null,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/token
  if (path === "/api/voice/token" && req.method === "POST") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const requestedVoiceAgentId = String(body?.voiceAgentId || "").trim();
      const callContext = {
        sessionId: String(body?.sessionId || "").trim() || undefined,
        executor: String(body?.executor || "").trim() || undefined,
        mode: String(body?.mode || "").trim() || undefined,
        model: String(body?.model || "").trim() || undefined,
        authSource: String(authResult?.source || "").trim() || undefined,
      };
      const libraryRoot = resolveVoiceLibraryRoot(callContext);
      const { selected: selectedVoiceAgent } = resolveActiveVoiceAgent(
        libraryRoot,
        requestedVoiceAgentId,
      );
      const activeVoiceAgentId = selectedVoiceAgent?.id || "voice-agent";
      const relay = await resolveVoiceRelay();
      const voiceCfg = relay.getVoiceConfig(true);
      if (!voiceCfg || (voiceCfg.provider !== "openai" && voiceCfg.provider !== "azure")) {
        jsonResponse(res, 400, { error: `provider "${voiceCfg?.provider || "unknown"}" does not support realtime token` });
        return;
      }
      const privileged = relay.isPrivilegedVoiceContext(callContext);
      const delegateOnly =
        body?.delegateOnly === true && !privileged;
      let tools = await relay.getVoiceToolDefinitions({ delegateOnly, context: callContext });

      const voiceToolCfg = getAgentToolConfig(libraryRoot, activeVoiceAgentId);
      tools = applyVoiceAgentToolFilters(tools, voiceToolCfg);
      const capabilityPrompt = buildVoiceToolCapabilityPrompt(
        tools,
        voiceToolCfg,
        selectedVoiceAgent,
      );

      // Resolve voice agent skill content from library
      let voiceSkillContent = "";
      if (Array.isArray(selectedVoiceAgent?.skills) && selectedVoiceAgent.skills.length > 0) {
        try {
          const { loadManifest, getEntryContent } = await import("../infra/library-manager.mjs");
          const manifest = loadManifest(libraryRoot);
          const skillSections = [];
          for (const skillId of selectedVoiceAgent.skills) {
            const entry = manifest.entries.find((e) => e.type === "skill" && e.id === skillId);
            if (entry) {
              const content = getEntryContent(libraryRoot, entry);
              if (typeof content === "string" && content.trim()) {
                skillSections.push(`### ${entry.name || skillId}\n${content.trim()}`);
              }
            }
          }
          if (skillSections.length > 0) {
            voiceSkillContent = skillSections.join("\n\n");
          }
        } catch {
          // best effort — continue without skill content
        }
      }

      const voiceCallContext = {
        ...callContext,
        voiceAgentId: activeVoiceAgentId,
        voiceAgentName: selectedVoiceAgent?.name || undefined,
        voiceAgentInstructions: selectedVoiceAgent?.voiceInstructions || undefined,
        voiceAgentSkills: Array.isArray(selectedVoiceAgent?.skills) ? selectedVoiceAgent.skills : undefined,
        voiceAgentSkillsContent: voiceSkillContent || undefined,
        voiceToolCapabilityPrompt: capabilityPrompt,
        enabledMcpServers: Array.isArray(voiceToolCfg?.enabledMcpServers)
          ? voiceToolCfg.enabledMcpServers
          : undefined,
      };
      const tokenData = await relay.createEphemeralToken(tools, voiceCallContext);
      tokenData.voiceAgentId = activeVoiceAgentId;
      tokenData.voiceAgentName = selectedVoiceAgent?.name || null;
      tokenData.voiceAgentSkills = Array.isArray(selectedVoiceAgent?.skills) ? selectedVoiceAgent.skills : [];
      tokenData.enabledMcpServers = Array.isArray(voiceToolCfg?.enabledMcpServers)
        ? voiceToolCfg.enabledMcpServers
        : [];
      tokenData.tools = Array.isArray(tools) ? tools : [];
      tokenData.resolvedToolNames = Array.isArray(tools) ? tools.map((t) => t?.name).filter(Boolean) : [];
      tokenData.enabledToolsMode = voiceToolCfg?.enabledTools == null ? "all" : "custom";

      // When client requests sdkMode, include extra fields for @openai/agents SDK
      if (body?.sdkMode === true) {
        const baseInstruction = [voiceCfg.instructions || "", capabilityPrompt]
          .filter(Boolean)
          .join("\n\n")
          .trim() || "";
        // Prepend voice identity so the agent knows who it is
        tokenData.instructions = selectedVoiceAgent?.voiceInstructions
          ? `${selectedVoiceAgent.voiceInstructions}\n\n${baseInstruction}`.trim()
          : baseInstruction || undefined;
        if (voiceSkillContent) {
          tokenData.instructions = `${tokenData.instructions || ""}\n\n## Voice Agent Skills\n${voiceSkillContent}`.trim();
        }
        if (tokenData.provider === "azure") {
          tokenData.azureEndpoint = voiceCfg.azureEndpoint || undefined;
          tokenData.azureDeployment = voiceCfg.azureDeployment || undefined;
        }
      }

      jsonResponse(res, 200, tokenData);
    } catch (err) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  // POST /api/voice/audio/respond
  // Single-turn audio response transport for OpenAI gpt-audio-* models.
  if (path === "/api/voice/audio/respond" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const inputText = String(body?.inputText || body?.text || "").trim();
      if (!inputText) {
        jsonResponse(res, 400, { ok: false, error: "inputText required" });
        return;
      }
      const context = {
        sessionId: String(body?.sessionId || "").trim() || undefined,
        executor: String(body?.executor || "").trim() || undefined,
        mode: String(body?.mode || "").trim() || undefined,
        model: String(body?.model || "").trim() || undefined,
        voiceAgentId: String(body?.voiceAgentId || "").trim() || undefined,
      };
      const options = {
        voiceId: String(body?.voiceId || "").trim() || undefined,
        model: String(body?.model || "").trim() || undefined,
      };
      const { generateOpenAIAudioResponse } = await import("../voice/voice-relay.mjs");
      const result = await generateOpenAIAudioResponse(inputText, context, options);
      jsonResponse(res, 200, { ok: true, ...result });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/agents/tools
  if (path === "/api/agents/tools" && req.method === "GET") {
    try {
      const { getVoiceToolDefinitions, getAllowedVoiceTools } = await import("../voice/voice-relay.mjs");
      const requestedVoiceAgentId = String(url.searchParams.get("voiceAgentId") || "").trim();
      const context = {
        sessionId: String(url.searchParams.get("sessionId") || "").trim() || undefined,
        executor: String(url.searchParams.get("executor") || "").trim() || undefined,
        mode: String(url.searchParams.get("mode") || "").trim() || undefined,
        model: String(url.searchParams.get("model") || "").trim() || undefined,
        authSource: String(authResult?.source || "").trim() || undefined,
      };
      const allTools = await getVoiceToolDefinitions({ delegateOnly: false, context });
      const allowed = await getAllowedVoiceTools(context);
      const allowedTools = allowed instanceof Set ? allowed : null;
      let tools = allowedTools
        ? (Array.isArray(allTools) ? allTools : []).filter((tool) => allowedTools.has(String(tool?.name || "").trim()))
        : allTools;
      const libraryRoot = resolveVoiceLibraryRoot(context);
      const { selected: selectedVoiceAgent } = resolveActiveVoiceAgent(
        libraryRoot,
        requestedVoiceAgentId,
      );
      const activeVoiceAgentId = selectedVoiceAgent?.id || "voice-agent";
      const voiceToolCfg = getAgentToolConfig(libraryRoot, activeVoiceAgentId);
      tools = applyVoiceAgentToolFilters(tools, voiceToolCfg);
      jsonResponse(res, 200, {
        ok: true,
        tools: Array.isArray(tools) ? tools : [],
        allowedTools: allowedTools ? Array.from(allowedTools.values()).sort() : null,
        totalTools: Array.isArray(tools) ? tools.length : 0,
        voiceAgentId: activeVoiceAgentId,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/tool
  // POST /api/agents/tool
  if ((path === "/api/voice/tool" || path === "/api/agents/tool") && req.method === "POST") {
    try {
      const isVoiceToolRoute = path === "/api/voice/tool";
      const eventSource = isVoiceToolRoute ? "voice" : "agent";
      const startedEventType = isVoiceToolRoute ? "voice_tool_started" : "agent_tool_started";
      const errorEventType = isVoiceToolRoute ? "voice_tool_error" : "agent_tool_error";
      const completeEventType = isVoiceToolRoute ? "voice_tool_complete_summary" : "agent_tool_complete_summary";
      const eventLabel = isVoiceToolRoute ? "Voice Action" : "Agent Tool";
      const body = await readJsonBody(req);
      const {
        toolName,
        args,
        sessionId: voiceSessionId,
        executor,
        mode,
        model,
        voiceAgentId,
      } = body || {};
      const normalizedToolName = String(toolName || "").trim();
      if (!normalizedToolName) {
        if (isVoiceToolRoute) {
          jsonResponse(res, 400, { error: "toolName required" });
        } else {
          jsonResponse(res, 400, { ok: false, error: "toolName required" });
        }
        return;
      }
      const summarizeToolArgs = (value) => {
        try {
          const raw = typeof value === "string" ? value : JSON.stringify(value || {});
          const compact = String(raw || "").replace(/\s+/g, " ").trim();
          if (!compact) return "(no args)";
          return compact.length > 280 ? `${compact.slice(0, 280)}...` : compact;
        } catch {
          return "(args unavailable)";
        }
      };
      const summarizeToolResult = (value) => {
        try {
          const raw = typeof value === "string" ? value : JSON.stringify(value || {});
          const compact = String(raw || "").replace(/\s+/g, " ").trim();
          if (!compact) return "(no result)";
          return compact.length > 1200 ? `${compact.slice(0, 1200)}...` : compact;
        } catch {
          return "(result unavailable)";
        }
      };
      const { executeVoiceTool, normalizeVoiceToolArgs, getAllowedVoiceTools } = await import("../voice/voice-relay.mjs");
      const context = {
        sessionId: String(voiceSessionId || "").trim() || undefined,
        executor: String(executor || "").trim() || undefined,
        mode: String(mode || "").trim() || undefined,
        model: String(model || "").trim() || undefined,
        authSource: String(authResult?.source || "").trim() || undefined,
        voiceAgentId: String(voiceAgentId || "").trim() || undefined,
      };
      const normalizedArgs = normalizeVoiceToolArgs(normalizedToolName, args || {});
      const libraryRoot = resolveVoiceLibraryRoot(context);
      const { selected: selectedVoiceAgent } = resolveActiveVoiceAgent(
        libraryRoot,
        context.voiceAgentId || "",
      );
      const activeVoiceAgentId = selectedVoiceAgent?.id || "voice-agent";
      const voiceToolCfg = getAgentToolConfig(libraryRoot, activeVoiceAgentId);
      let tracker = null;
      let session = null;
      if (context.sessionId) {
        tracker = getSessionTracker();
        session = tracker.getSessionById(context.sessionId);
        if (!session) {
          session = tracker.createSession({
            id: context.sessionId,
            type: "primary",
            metadata: {
              agent: context.executor || getPrimaryAgentName() || "",
              mode: context.mode || getAgentMode() || "",
              model: context.model || undefined,
            },
          });
        }
        tracker.recordEvent(session?.id || context.sessionId, {
          role: "system",
          content: `[${eventLabel} Started] ${normalizedToolName}\nArgs: ${summarizeToolArgs(normalizedArgs)}`,
          timestamp: new Date().toISOString(),
          meta: {
            source: eventSource,
            eventType: startedEventType,
            toolName: normalizedToolName,
          },
        });
      }
      if (context.sessionId) {
        // Session-bound calls are validated against the allowed tool set
        const allowed = await getAllowedVoiceTools(context);
        if (!allowed.has(normalizedToolName)) {
          const deniedMessage = `Tool "${normalizedToolName}" is not allowed for session-bound calls`;
          if (isVoiceToolRoute) {
            jsonResponse(res, 400, { error: deniedMessage });
          } else {
            jsonResponse(res, 400, { ok: false, error: deniedMessage });
          }
          return;
        }
      }
      const toolEnabledForAgent =
        applyVoiceAgentToolFilters([{ name: normalizedToolName }], voiceToolCfg).length > 0;
      if (!toolEnabledForAgent) {
        const deniedMessage = `Tool "${normalizedToolName}" is not enabled for voice agent "${activeVoiceAgentId}"`;
        if (isVoiceToolRoute) {
          jsonResponse(res, 403, { error: deniedMessage });
        } else {
          jsonResponse(res, 403, { ok: false, error: deniedMessage });
        }
        return;
      }
      if (
        normalizedToolName === "invoke_mcp_tool"
        && Array.isArray(voiceToolCfg?.enabledMcpServers)
        && voiceToolCfg.enabledMcpServers.length > 0
      ) {
        const requestedServer = String(
          normalizedArgs?.server
          || normalizedArgs?.serverId
          || "",
        ).trim();
        if (requestedServer && !voiceToolCfg.enabledMcpServers.includes(requestedServer)) {
          const deniedMessage = `MCP server "${requestedServer}" is not enabled for voice agent "${activeVoiceAgentId}"`;
          if (isVoiceToolRoute) {
            jsonResponse(res, 403, { error: deniedMessage });
          } else {
            jsonResponse(res, 403, { ok: false, error: deniedMessage });
          }
          return;
        }
      }
      const voicePolicyDecision = evaluateVoiceToolPolicy({
        toolName: normalizedToolName,
        args: normalizedArgs,
        context,
        intentText: extractVoiceIntentText(normalizedArgs),
        transport: "http",
      });
      if (!voicePolicyDecision.allow) {
        const deniedMessage = String(voicePolicyDecision.message || "Voice tool policy denied execution");
        const deniedStatusCode = Number(voicePolicyDecision.statusCode || 403);
        if (isVoiceToolRoute) {
          jsonResponse(res, deniedStatusCode, {
            error: deniedMessage,
            statusCode: deniedStatusCode,
            policy: "voice-tool-pre-execution",
          });
        } else {
          jsonResponse(res, deniedStatusCode, {
            ok: false,
            error: deniedMessage,
            statusCode: deniedStatusCode,
            policy: "voice-tool-pre-execution",
          });
        }
        return;
      }
      const result = await executeVoiceTool(normalizedToolName, normalizedArgs, context);
      if (tracker && context.sessionId) {
        if (result?.error) {
          tracker.recordEvent(session?.id || context.sessionId, {
            role: "system",
            content: `[${eventLabel} Error] ${normalizedToolName}\nError: ${String(result.error || "Unknown error")}`,
            timestamp: new Date().toISOString(),
            meta: {
              source: eventSource,
              eventType: errorEventType,
              toolName: normalizedToolName,
            },
          });
        } else {
          tracker.recordEvent(session?.id || context.sessionId, {
            role: "system",
            content: `[${eventLabel} Complete] ${normalizedToolName}\nSummary: ${summarizeToolResult(result?.result)}`,
            timestamp: new Date().toISOString(),
            meta: {
              source: eventSource,
              eventType: completeEventType,
              toolName: normalizedToolName,
            },
          });
        }
      }

      if (isVoiceToolRoute) {
        jsonResponse(res, 200, result);
      } else {
        jsonResponse(res, 200, {
          ok: !result?.error,
          toolName: normalizedToolName,
          ...result,
        });
      }
    } catch (err) {
      if (path === "/api/voice/tool") {
        jsonResponse(res, 500, { error: err.message });
      } else {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
    }
    return;
  }

  // POST /api/voice/transcript
  if (path === "/api/voice/transcript" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const sessionId = String(body?.sessionId || "").trim();
      const role = String(body?.role || "").trim().toLowerCase();
      const content = String(body?.content || "").trim();
      if (!sessionId) {
        jsonResponse(res, 400, { ok: false, error: "sessionId required" });
        return;
      }
      if (!["user", "assistant", "system"].includes(role)) {
        jsonResponse(res, 400, { ok: false, error: "role must be user|assistant|system" });
        return;
      }
      if (!content) {
        jsonResponse(res, 400, { ok: false, error: "content required" });
        return;
      }

      const tracker = getSessionTracker();
      let session = tracker.getSessionById(sessionId);
      if (!session) {
        session = tracker.createSession({
          id: sessionId,
          type: "primary",
          metadata: {
            agent: String(body?.executor || getPrimaryAgentName() || ""),
            mode: String(body?.mode || getAgentMode() || ""),
            model: String(body?.model || "").trim() || undefined,
          },
        });
      }

      tracker.recordEvent(session.id || sessionId, {
        role,
        type: "voice_transcript",
        content,
        timestamp: new Date().toISOString(),
        meta: {
          source: "voice",
          provider: String(body?.provider || "").trim() || undefined,
          eventType: String(body?.eventType || "").trim() || undefined,
        },
      });

      const provider = String(body?.provider || "").trim() || null;
      const transcriptEventType = String(body?.eventType || "").trim().toLowerCase() || null;
      const executor = String(body?.executor || "").trim() || null;
      const mode = String(body?.mode || "").trim() || null;
      const model = String(body?.model || "").trim() || null;
      const normalizedSessionId = String(session.id || sessionId).trim();
      const contentHash = createHash("sha1")
        .update(`${role}:${content}`)
        .digest("hex")
        .slice(0, 16);
      const workflowPayload = {
        sessionId: normalizedSessionId,
        meetingSessionId: normalizedSessionId,
        role,
        content,
        source: "voice",
        provider,
        transcriptEventType,
        executor,
        mode,
        model,
      };

      queueWorkflowEvent(
        "meeting.transcript",
        workflowPayload,
        {
          dedupKey: `workflow-event:meeting.transcript:${normalizedSessionId}:${role}:${contentHash}`,
        },
      );
      if (transcriptEventType === "wake_phrase" || transcriptEventType === "wake-phrase") {
        queueWorkflowEvent(
          "meeting.wake_phrase",
          workflowPayload,
          {
            dedupKey: `workflow-event:meeting.wake_phrase:${normalizedSessionId}:${role}:${contentHash}`,
          },
        );
      }

      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/vision/frame
  if (path === "/api/vision/frame" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const sessionId = String(body?.sessionId || "").trim();
      const source = sanitizeVisionSource(body?.source);
      const frame = parseVisionFrameDataUrl(body?.frameDataUrl);
      const forceAnalyze = body?.forceAnalyze === true;
      const minIntervalMs = normalizeVisionInterval(body?.minIntervalMs);
      const width = Number.isFinite(Number(body?.width)) ? Number(body.width) : null;
      const height = Number.isFinite(Number(body?.height)) ? Number(body.height) : null;

      if (!sessionId) {
        jsonResponse(res, 400, { ok: false, error: "sessionId required" });
        return;
      }
      if (!frame.ok) {
        jsonResponse(res, frame.statusCode || 400, { ok: false, error: frame.error });
        return;
      }

      const state = getVisionSessionState(sessionId);
      if (!state) {
        jsonResponse(res, 400, { ok: false, error: "Invalid sessionId" });
        return;
      }

      const frameHash = createHash("sha1").update(frame.base64Data).digest("hex");
      const now = Date.now();

      state.lastFrameHash = frameHash;
      state.lastReceiptAt = now;
      state.lastFrameDataUrl = frame.raw;
      state.lastFrameSource = source;
      state.lastFrameWidth = width;
      state.lastFrameHeight = height;

      if (!forceAnalyze && state.inFlight) {
        jsonResponse(res, 202, {
          ok: true,
          analyzed: false,
          skipped: true,
          reason: "analysis_in_progress",
          summary: state.lastSummary || undefined,
        });
        return;
      }

      if (!forceAnalyze && frameHash === state.lastAnalyzedHash) {
        jsonResponse(res, 200, {
          ok: true,
          analyzed: false,
          skipped: true,
          reason: "duplicate_frame",
          summary: state.lastSummary || undefined,
        });
        return;
      }

      if (!forceAnalyze && now - state.lastAnalyzedAt < minIntervalMs) {
        jsonResponse(res, 202, {
          ok: true,
          analyzed: false,
          skipped: true,
          reason: "throttled",
          summary: state.lastSummary || undefined,
        });
        return;
      }

      const callContext = {
        sessionId,
        executor: String(body?.executor || "").trim() || undefined,
        mode: String(body?.mode || "").trim() || undefined,
        model: String(body?.model || "").trim() || undefined,
      };
      const prompt = String(body?.prompt || "").trim() || undefined;
      const model = String(body?.visionModel || "").trim() || undefined;

      const relay = await resolveVoiceRelay();
      const pending = relay.analyzeVisionFrame(frame.raw, {
        source,
        context: callContext,
        prompt,
        model,
      });
      state.inFlight = pending;
      let analysis;
      try {
        analysis = await pending;
      } finally {
        if (state.inFlight === pending) {
          state.inFlight = null;
        }
      }

      const tracker = getSessionTracker();
      let session = tracker.getSessionById(sessionId);
      if (!session) {
        session = tracker.createSession({
          id: sessionId,
          type: "primary",
          metadata: {
            agent: String(body?.executor || getPrimaryAgentName() || ""),
            mode: String(body?.mode || getAgentMode() || ""),
            model: String(body?.model || "").trim() || undefined,
          },
        });
      }

      const dimension = width && height ? ` (${width}x${height})` : "";
      const persistToChat = body?.persistToChat === true;
      if (session?.metadata && typeof session.metadata === "object") {
        session.metadata.latestVisionSummary = String(analysis.summary || "").trim();
        session.metadata.latestVisionSource = source;
        session.metadata.latestVisionAt = new Date().toISOString();
      }
      if (persistToChat) {
        tracker.recordEvent(session.id || sessionId, {
          role: "system",
          content: `[Vision ${source}${dimension}] ${analysis.summary}`,
          timestamp: new Date().toISOString(),
          meta: {
            source: "vision",
            eventType: "vision_summary",
            visionSource: source,
          },
        });
      }

      state.lastAnalyzedHash = frameHash;
      state.lastAnalyzedAt = Date.now();
      state.lastSummary = String(analysis.summary || "").trim();

      jsonResponse(res, 200, {
        ok: true,
        analyzed: true,
        summary: state.lastSummary,
        provider: analysis.provider || null,
        model: analysis.model || null,
        frameHash,
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/dispatch — Execute a voice action intent (direct JavaScript, no MCP)
  if (path === "/api/voice/dispatch" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const action = String(body?.action || "").trim();
      if (!action) {
        jsonResponse(res, 400, { ok: false, error: "action is required" });
        return;
      }
      const context = {
        sessionId: String(body?.sessionId || "").trim() || undefined,
        executor: String(body?.executor || "").trim() || undefined,
        mode: String(body?.mode || "").trim() || undefined,
        model: String(body?.model || "").trim() || undefined,
        authSource: String(authResult?.source || "").trim() || undefined,
      };
      const { dispatchVoiceActionIntent } = await import("../voice/voice-relay.mjs");
      const result = await dispatchVoiceActionIntent(
        { action, params: body?.params || {}, id: body?.id || undefined },
        context,
      );
      jsonResponse(res, 200, result);
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/voice/dispatch-batch — Execute multiple voice action intents
  if (path === "/api/voice/dispatch-batch" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const intents = Array.isArray(body?.actions) ? body.actions : [];
      if (!intents.length) {
        jsonResponse(res, 400, { ok: false, error: "actions array is required" });
        return;
      }
      const context = {
        sessionId: String(body?.sessionId || "").trim() || undefined,
        executor: String(body?.executor || "").trim() || undefined,
        mode: String(body?.mode || "").trim() || undefined,
        model: String(body?.model || "").trim() || undefined,
        authSource: String(authResult?.source || "").trim() || undefined,
      };
      const { dispatchVoiceActionIntents } = await import("../voice/voice-relay.mjs");
      const results = await dispatchVoiceActionIntents(intents, context);
      jsonResponse(res, 200, { ok: true, results });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/voice/actions — List all available voice actions
  if (path === "/api/voice/actions" && req.method === "GET") {
    try {
      const { listVoiceActions } = await import("../voice/voice-relay.mjs");
      const actions = await listVoiceActions();
      jsonResponse(res, 200, { ok: true, actions });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/voice/prompt — Get the full voice agent prompt with action manifest
  if (path === "/api/voice/prompt" && req.method === "GET") {
    try {
      const compact = url.searchParams?.get("compact") === "true";
      const context = {
        sessionId: String(url.searchParams?.get("sessionId") || "").trim() || undefined,
        voiceAgentId: String(url.searchParams?.get("voiceAgentId") || "").trim() || undefined,
        mode: String(url.searchParams?.get("mode") || "").trim() || undefined,
        executor: String(url.searchParams?.get("executor") || "").trim() || undefined,
        model: String(url.searchParams?.get("model") || "").trim() || undefined,
      };
      const { buildVoiceAgentPrompt } = await import("../voice/voice-relay.mjs");
      const prompt = await buildVoiceAgentPrompt({ compact, context });
      jsonResponse(res, 200, { ok: true, prompt });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  // GET /api/voice/action-manifest — Get the action manifest for prompt injection
  if (path === "/api/voice/action-manifest" && req.method === "GET") {
    try {
      const { getVoiceActionManifest } = await import("../voice/voice-relay.mjs");
      const manifest = await getVoiceActionManifest();
      jsonResponse(res, 200, { ok: true, manifest });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  jsonResponse(res, 404, { ok: false, error: "Unknown API endpoint" });
}

async function handleStatic(req, res, url) {
  if (tryLocalSessionBootstrap(req, res, url)) {
    return;
  }

  const authResult = await requireAuth(req);
  if (!authResult?.ok) {
    textResponse(res, 401, "Unauthorized");
    return;
  }
  if (authResult.issueSessionCookie) {
    res.setHeader("Set-Cookie", buildSessionCookieHeader());
  }

  const rawPathname = String(url.pathname || "/").trim() || "/";
  if (url.searchParams.get("localBootstrap") === "1") {
    const cleanUrl = new URL(url.toString());
    cleanUrl.searchParams.delete("localBootstrap");
    const redirectPath =
      cleanUrl.pathname +
      (cleanUrl.searchParams.toString()
        ? `?${cleanUrl.searchParams.toString()}`
        : "");
    res.writeHead(302, { Location: redirectPath || "/" });
    res.end();
    return;
  }
  const pathname = rawPathname === "/" ? "/index.html" : rawPathname;
  const isSharedLibRequest = pathname === "/lib" || pathname.startsWith("/lib/");
  const staticRoot = isSharedLibRequest ? sharedLibRoot : uiRoot;
  const staticPathname = isSharedLibRequest
    ? pathname.slice(4) || "/"
    : pathname;
  const filePath = resolve(staticRoot, `.${staticPathname}`);

  if (!filePath.startsWith(staticRoot)) {
    textResponse(res, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    // SPA fallback: deep links like /tasks/123 must load index.html so the
    // client router can resolve the route after refresh.
    const looksLikeFile = /\.[a-z0-9]+$/i.test(pathname);
    const hasTemplateBraces = pathname.includes("{{") || pathname.includes("}}");
    if (!looksLikeFile || hasTemplateBraces) {
      const indexPath = resolve(uiRoot, "index.html");
      if (existsSync(indexPath)) {
        try {
          const data = await readFile(indexPath);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          });
          res.end(data);
          return;
        } catch (err) {
          textResponse(res, 500, `Failed to load /index.html: ${err.message}`);
          return;
        }
      }
    }
    textResponse(res, 404, "Not Found");
    return;
  }

  try {
    const ext = extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (err) {
    textResponse(res, 500, `Failed to load ${pathname}: ${err.message}`);
  }
}

export async function startTelegramUiServer(options = {}) {
  if (uiServer) return uiServer;

  injectUiDependencies(options.dependencies || {});
  const taskStoreModule = await ensureTaskStoreApi();
  const sandbox = ensureTestRuntimeSandbox();

  // ── Setup mode integration (entrypoint.mjs) ───────────────────────────
  if (options.setupMode) {
    _setupMode = true;
    _setupOnComplete = () => {
      _setupMode = false;
      console.log("[telegram-ui] setup complete — portal mode active");
      // Notify entrypoint to start monitor
      try {
        import("../entrypoint.mjs").then((m) => {
          if (typeof m.markSetupComplete === "function") m.markSetupComplete();
        }).catch(() => {});
      } catch { /* not running via entrypoint */ }
    };
  }

  const rawPort = options.port ?? getDefaultPort();
  const configuredPort = Number(rawPort);
  const isTestRun =
    Boolean(process.env.VITEST) ||
    process.env.NODE_ENV === "test" ||
    Boolean(process.env.JEST_WORKER_ID);
  if (isTestRun && typeof taskStoreModule?.configureTaskStore === "function") {
    const cacheDir = sandbox?.cacheDir || resolve(repoRoot, ".bosun", ".cache");
    const isolatedStorePath = resolve(
      cacheDir,
      `kanban-state-vitest-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`,
    );
    taskStoreModule.configureTaskStore({ storePath: isolatedStorePath });
  }
  const skipInstanceLock =
    options.skipInstanceLock === true ||
    process.env.BOSUN_UI_SKIP_INSTANCE_LOCK === "1" ||
    isTestRun;
  const allowEphemeralPort =
    options.allowEphemeralPort === true ||
    process.env.BOSUN_UI_ALLOW_EPHEMERAL_PORT === "1" ||
    isTestRun;
  const persistedPort = readLastUiPort();
  const shouldReusePersistedPort =
    options.port == null &&
    configuredPort === 0 &&
    allowEphemeralPort &&
    persistedPort > 0;
  const port =
    shouldReusePersistedPort
      ? persistedPort
      : configuredPort;
  const hasExplicitEnvPort =
    Number.isFinite(Number(process.env.TELEGRAM_UI_PORT || "")) &&
    Number(process.env.TELEGRAM_UI_PORT || "") > 0;
  const portSource =
    shouldReusePersistedPort
      ? "cache.ui-last-port"
      : options.port != null
      ? "options.port"
      : hasExplicitEnvPort
        ? "env.TELEGRAM_UI_PORT"
        : `default(${DEFAULT_TELEGRAM_UI_PORT})`;
  const usingFallbackDefaultPort = portSource.startsWith("default(");

  if (!Number.isFinite(port) || port < 0) {
    console.warn(
      `[telegram-ui] invalid ui port: raw=${String(rawPort)} source=${portSource}`,
    );
    return null;
  }
  if (port === 0 && !allowEphemeralPort) {
    console.warn(
      `[telegram-ui] refusing ephemeral ui port (resolved 0 from ${portSource}); ` +
      `set TELEGRAM_UI_PORT (for example 4400) or set BOSUN_UI_ALLOW_EPHEMERAL_PORT=1`,
    );
    return null;
  }

  const browserOpenMode = getBrowserOpenMode();
  const autoOpenEnabled = shouldAutoOpenBrowser();
  console.log(
    `[telegram-ui] startup config: port=${port} source=${portSource} browserOpenMode=${browserOpenMode} autoOpen=${autoOpenEnabled ? "enabled" : "disabled"}`,
  );

  if (!skipInstanceLock) {
    const lockResult = tryAcquireUiInstanceLock({ preferredPort: port });
    if (!lockResult.ok) {
      const existing = lockResult.existing || {};
      const existingTarget = existing.url
        || (existing.port
          ? `${existing.protocol || "http"}://${existing.host || "127.0.0.1"}:${existing.port}`
          : "unknown");
      console.warn(
        `[telegram-ui] duplicate runtime detected (pid=${existing.pid}) — skipping secondary UI server start (${existingTarget})`,
      );
      return null;
    }
  }

  // Auto-TLS: generate a self-signed cert for HTTPS unless explicitly disabled
  let tlsOpts = null;
  if (!isTlsDisabled()) {
    tlsOpts = ensureSelfSignedCert();
  }

  const requestHandler = async (req, res) => {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`,
    );
    res.__bosunRequestContext = {
      diagnosticId: ensureResponseDiagnosticId(res),
      method: String(req?.method || "GET").toUpperCase(),
      path: url.pathname,
      query: url.search || "",
    };
    const webhookPath = getGitHubWebhookPath();

    try {

    // Token exchange: ?token=<hex> → set session cookie and redirect to clean URL
    const qToken = url.searchParams.get("token");
    if (qToken && sessionToken) {
      const provided = Buffer.from(qToken);
      const expected = Buffer.from(sessionToken);
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        const cleanUrl = new URL(url.toString());
        cleanUrl.searchParams.delete("token");
        const redirectPath =
          cleanUrl.pathname +
          (cleanUrl.searchParams.toString()
            ? `?${cleanUrl.searchParams.toString()}`
            : "");
        res.writeHead(302, {
          "Set-Cookie": buildSessionCookieHeader(),
          Location: redirectPath || "/",
        });
        res.end();
        return;
      }
    }

    // Desktop API key exchange: ?desktopKey=<key> → set session cookie and redirect to clean URL
    // Used by the Electron desktop app to bootstrap authenticated WebView sessions
    // without depending on the TTL-based session token.
    const qDesktopKey = url.searchParams.get("desktopKey");
    if (qDesktopKey) {
      const expectedDesktopKey = getExpectedDesktopApiKey();
      if (expectedDesktopKey) {
        try {
          const a = Buffer.from(qDesktopKey);
          const b = Buffer.from(expectedDesktopKey);
          if (a.length === b.length && timingSafeEqual(a, b)) {
            const cleanUrl = new URL(url.toString());
            cleanUrl.searchParams.delete("desktopKey");
            const redirectPath =
              cleanUrl.pathname +
              (cleanUrl.searchParams.toString()
                ? `?${cleanUrl.searchParams.toString()}`
                : "");
            res.writeHead(302, {
              "Set-Cookie": buildSessionCookieHeader(),
              Location: redirectPath || "/",
            });
            res.end();
            return;
          }
        } catch {
          /* malformed key — fall through to normal auth */
        }
      }
    }

    if (url.pathname === webhookPath) {
      await handleGitHubProjectWebhook(req, res);
      return;
    }

    // GitHub App webhook (installation events, pr events, etc.)
    const appWebhookPath = getAppWebhookPath();
    if (url.pathname === appWebhookPath) {
      await handleGitHubAppWebhook(req, res);
      return;
    }

    // Lightweight health check / relay-page detection — no auth required
    if (url.pathname === "/ping") {
      jsonResponse(res, 200, { ok: true, server: "bosun" });
      return;
    }

    // Docker / load-balancer health check — no auth required
    if (url.pathname === "/healthz") {
      try {
        const { getHealthStatus } = await import("../infra/health-status.mjs");
        jsonResponse(res, 200, getHealthStatus());
      } catch {
        // Fallback if health module unavailable
        jsonResponse(res, 200, { status: "ok", server: "bosun" });
      }
      return;
    }

    // GitHub OAuth callback — public (no session auth required)
    // Accept both /github/callback (registered in GitHub App settings) and
    // /api/github/callback (documented API path) so either works.
    if (url.pathname === "/api/github/callback" || url.pathname === "/github/callback") {
      await handleGitHubOAuthCallback(req, res);
      return;
    }

    // GitHub Device Flow — no public URL needed
    if (url.pathname === "/api/github/device/start") {
      await handleDeviceFlowStart(req, res);
      return;
    }
    if (url.pathname === "/api/github/device/poll") {
      await handleDeviceFlowPoll(req, res);
      return;
    }

    // Setup wizard API routes — handled before the general /api/ catch-all
    // so the setup wizard works whether running standalone or unified with portal.
    if (url.pathname.startsWith("/api/setup/")) {
      const { handleSetupApi } = await import("./setup-web-server.mjs");
      const handled = await handleSetupApi(req, res, url, {
        onComplete: _setupOnComplete || undefined,
      });
      if (handled) return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    // Vendor files (preact, htm, signals etc.) — served from node_modules, no auth needed
    if (url.pathname.startsWith("/vendor/")) {
      await handleVendor(req, res, url);
      return;
    }

    // ESM CDN proxy/cache (MUI, Emotion) — served through local server to avoid
    // direct browser→CDN dependency and self-signed cert cross-origin issues
    if (url.pathname.startsWith("/esm/")) {
      await handleEsmProxy(req, res, url);
      return;
    }

    // ── Setup wizard page ──────────────────────────────────────────────────
    // When in setup mode, redirect / → /setup so the user lands on the wizard.
    // When setup is complete, /setup still works for re-configuration access.
    if (_setupMode && url.pathname === "/") {
      res.writeHead(302, { Location: "/setup" });
      res.end();
      return;
    }

    // /demo and /ui/demo are convenience aliases for /demo.html (the self-contained mock UI demo)
    if (url.pathname === "/demo" || url.pathname === "/ui/demo") {
      const qs = url.search || "";
      res.writeHead(302, { Location: `/demo.html${qs}` });
      res.end();
      return;
    }

    // Telegram initData exchange: ?tgWebAppData=... or ?initData=... → set session cookie and redirect
    const initDataQuery =
      url.searchParams.get("tgWebAppData") ||
      url.searchParams.get("initData") ||
      "";
    if (
      initDataQuery &&
      sessionToken &&
      req.method === "GET"
    ) {
      const token = process.env.TELEGRAM_BOT_TOKEN || "";
      if (validateInitData(String(initDataQuery), token)) {
        const cleanUrl = new URL(url.toString());
        cleanUrl.searchParams.delete("tgWebAppData");
        cleanUrl.searchParams.delete("initData");
        const redirectPath =
          cleanUrl.pathname + (cleanUrl.searchParams.toString() ? `?${cleanUrl.searchParams.toString()}` : "");
        res.writeHead(302, {
          "Set-Cookie": buildSessionCookieHeader(),
          Location: redirectPath || "/",
        });
        res.end();
        return;
      }
    }
    await handleStatic(req, res, url);
    } catch (err) {
      if (res.headersSent) {
        console.error("[ui-server] unhandled request failure after headers sent", {
          diagnosticId: ensureResponseDiagnosticId(res),
          payload: describePayloadForErrorLog(err),
        });
        try {
          res.destroy?.(err);
        } catch {
          /* best effort */
        }
        return;
      }
      jsonResponse(res, 500, err);
    }
  };

  try {
    if (tlsOpts) {
      uiServer = createHttpsServer(tlsOpts, requestHandler);
      uiServerTls = true;
    } else {
      uiServer = createServer(requestHandler);
      uiServerTls = false;
    }

    wsServer = new WebSocketServer({ noServer: true });
    if (!sessionListenerAttached) {
      sessionListenerAttached = true;
      addSessionEventListener((payload) => {
        broadcastSessionMessage(payload);
      });
    }
    if (!sessionAccumulatorListenerAttached) {
      sessionAccumulatorListenerAttached = true;
      addSessionAccumulationListener((payload) => {
        broadcastUiEvent(["tasks", "overview", "telemetry", "sessions"], "invalidate", {
          reason: "session-accumulated",
          taskId: payload?.taskId || null,
          totals: payload?.totals || null,
          type: payload?.type || "session-accumulated",
        });
      });
    }

    // Periodic stats broadcast for TUI
    let statsBroadcastInterval = null;
    function startStatsBroadcast() {
      if (statsBroadcastInterval) return;
      const intervalMs = Number(process.env.BOSUN_STATS_BROADCAST_MS) || 2000;
      statsBroadcastInterval = setInterval(async () => {
        try {
          const stats = await collectUiStats();
          broadcastUiEvent(["stats", "tui"], "stats", stats);
        } catch (err) {
          // best effort
        }
      }, intervalMs);
      statsBroadcastInterval.unref?.();
    }
    startStatsBroadcast();

    // Retry queue tracking
    let _retryQueue = { count: 0, items: [] };
    function setRetryQueueData(data) {
      const normalized = data && typeof data === "object" ? data : {};
      _retryQueue = {
        count: Number(normalized.count || 0),
        items: Array.isArray(normalized.items) ? normalized.items : [],
        stats: normalized.stats && typeof normalized.stats === "object"
          ? {
              totalRetriesToday: Number(normalized.stats.totalRetriesToday || 0),
              peakRetryDepth: Number(normalized.stats.peakRetryDepth || 0),
              exhaustedTaskIds: Array.isArray(normalized.stats.exhaustedTaskIds)
                ? normalized.stats.exhaustedTaskIds
                : [],
            }
          : {
              totalRetriesToday: 0,
              peakRetryDepth: 0,
            exhaustedTaskIds: [],
          },
      };
      broadcastUiEvent(["retry-queue", "overview", "telemetry", "tasks"], "retry-queue-updated", _retryQueue);
      broadcastUiEvent(["overview", "telemetry", "retry-queue"], "invalidate", {
        reason: "retry-queue-updated",
        count: _retryQueue.count,
      });
    }
    globalThis.__bosun_setRetryQueueData = setRetryQueueData;

    // Task CRUD events
    function broadcastTaskEvent(type, task) {
      broadcastUiEvent(["tasks", "tui"], type, task);
    }

    wsServer.on("connection", (socket, req) => {
      socket.__channels = new Set(["*"]);
      socket.__lastPong = Date.now();
      socket.__lastPing = null;
      socket.__missedPongs = 0;
      socket.__authSource = String(req?.__authSource || "").trim() || undefined;
      wsClients.add(socket);
      sendWsMessage(socket, {
        type: "hello",
        channels: ["*"],
        payload: { connected: true },
        ts: Date.now(),
      });
      sendWsMessage(socket, {
        type: "sessions:update",
        channels: ["sessions", "tui"],
        payload: {
          sessions: _activeSessions.length ? _activeSessions : getLiveSessionSnapshot(),
        },
        ts: Date.now(),
      });

      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw || "{}"));
          if (message?.type === "subscribe" && Array.isArray(message.channels)) {
            const channels = message.channels
              .filter((item) => typeof item === "string" && item.trim())
              .map((item) => item.trim());
            socket.__channels = new Set(channels.length ? channels : ["*"]);
            sendWsMessage(socket, {
              type: "subscribed",
              channels: Array.from(socket.__channels),
              payload: { ok: true },
              ts: Date.now(),
            });
          } else if (message?.type === "ping" && typeof message.ts === "number") {
            // Client ping → echo back as pong
            sendWsMessage(socket, { type: "pong", ts: message.ts });
          } else if (message?.type === "pong" && typeof message.ts === "number") {
            // Client pong in response to server ping
            socket.__lastPong = Date.now();
            socket.__missedPongs = 0;
          } else if (message?.type === "subscribe-logs") {
            const logType = message.logType === "agent" ? "agent" : "system";
            const query = typeof message.query === "string" ? message.query : "";
            startLogStream(socket, logType, query);
          } else if (message?.type === "unsubscribe-logs") {
            stopLogStream(socket);
          } else if (message?.type === "voice-tool-call") {
            // Voice tool call via WebSocket
            const {
              toolName,
              args,
              callId,
              sessionId: voiceSessionId,
              executor,
              mode,
              model,
              voiceAgentId,
            } = message;
            const normalizedToolName = String(toolName || "").trim();
            if (!normalizedToolName) {
              sendWsMessage(socket, {
                type: "voice-tool-result",
                callId,
                error: "toolName required",
                ts: Date.now(),
              });
              return;
            }
            const normalizedSessionId = String(voiceSessionId || "").trim() || undefined;
            if (normalizedSessionId) {
              // Validate tool is in the allowed set for session-bound calls
              import("../voice/voice-relay.mjs").then((relay) => {
                const context = {
                  sessionId: normalizedSessionId,
                  executor: String(executor || "").trim() || undefined,
                  mode: String(mode || "").trim() || undefined,
                  model: String(model || "").trim() || undefined,
                  authSource: String(socket.__authSource || "").trim() || undefined,
                  voiceAgentId: String(voiceAgentId || "").trim() || undefined,
                };
                const normalizedArgs = relay.normalizeVoiceToolArgs(normalizedToolName, args || {});
                relay.getAllowedVoiceTools(context).then((allowed) => {
                  if (!allowed.has(normalizedToolName)) {
                    sendWsMessage(socket, {
                      type: "voice-tool-result",
                      callId,
                      error: `Tool "${normalizedToolName}" is not allowed for session-bound calls`,
                      ts: Date.now(),
                    });
                    return;
                  }
                  const libraryRoot = resolveVoiceLibraryRoot(context);
                  const { selected: selectedVoiceAgent } = resolveActiveVoiceAgent(
                    libraryRoot,
                    context.voiceAgentId || "",
                  );
                  const activeVoiceAgentId = selectedVoiceAgent?.id || "voice-agent";
                  const voiceToolCfg = getAgentToolConfig(libraryRoot, activeVoiceAgentId);
                  const toolEnabledForAgent =
                    applyVoiceAgentToolFilters([{ name: normalizedToolName }], voiceToolCfg).length > 0;
                  if (!toolEnabledForAgent) {
                    sendWsMessage(socket, {
                      type: "voice-tool-result",
                      callId,
                      error: `Tool "${normalizedToolName}" is not enabled for voice agent "${activeVoiceAgentId}"`,
                      ts: Date.now(),
                    });
                    return;
                  }
                  if (
                    normalizedToolName === "invoke_mcp_tool"
                    && Array.isArray(voiceToolCfg?.enabledMcpServers)
                    && voiceToolCfg.enabledMcpServers.length > 0
                  ) {
                    const requestedServer = String(
                      normalizedArgs?.server
                      || normalizedArgs?.serverId
                      || "",
                    ).trim();
                    if (requestedServer && !voiceToolCfg.enabledMcpServers.includes(requestedServer)) {
                      sendWsMessage(socket, {
                        type: "voice-tool-result",
                        callId,
                        error: `MCP server "${requestedServer}" is not enabled for voice agent "${activeVoiceAgentId}"`,
                        ts: Date.now(),
                      });
                      return;
                    }
                  }
                  const voicePolicyDecision = evaluateVoiceToolPolicy({
                    toolName: normalizedToolName,
                    args: normalizedArgs,
                    context,
                    intentText: extractVoiceIntentText(normalizedArgs),
                    transport: "ws",
                  });
                  if (!voicePolicyDecision.allow) {
                    sendWsMessage(socket, {
                      type: "voice-tool-result",
                      callId,
                      error: String(voicePolicyDecision.message || "Voice tool policy denied execution"),
                      statusCode: Number(voicePolicyDecision.statusCode || 403),
                      ts: Date.now(),
                    });
                    return;
                  }
                  // Tool is allowed — execute it
                  relay.executeVoiceTool(normalizedToolName, normalizedArgs, context).then((result) => {
                    sendWsMessage(socket, {
                      type: "voice-tool-result",
                      callId,
                      ...result,
                      ts: Date.now(),
                    });
                  }).catch((err) => {
                    sendWsMessage(socket, {
                      type: "voice-tool-result",
                      callId,
                      error: err.message,
                      ts: Date.now(),
                    });
                  });
                }).catch((err) => {
                  sendWsMessage(socket, {
                    type: "voice-tool-result",
                    callId,
                    error: `Tool policy check failed: ${err?.message || "unknown error"}`,
                    ts: Date.now(),
                  });
                });
              }).catch((err) => {
                sendWsMessage(socket, {
                  type: "voice-tool-result",
                  callId,
                  error: "Session-bound tool validation failed",
                  ts: Date.now(),
                });
              });
              return;
            }
            import("../voice/voice-relay.mjs").then(async (relay) => {
              try {
                const context = {
                  sessionId: normalizedSessionId,
                  executor: String(executor || "").trim() || undefined,
                  mode: String(mode || "").trim() || undefined,
                  model: String(model || "").trim() || undefined,
                  authSource: String(socket.__authSource || "").trim() || undefined,
                  voiceAgentId: String(voiceAgentId || "").trim() || undefined,
                };
                const normalizedArgs = relay.normalizeVoiceToolArgs(normalizedToolName, args || {});
                const libraryRoot = resolveVoiceLibraryRoot(context);
                const { selected: selectedVoiceAgent } = resolveActiveVoiceAgent(
                  libraryRoot,
                  context.voiceAgentId || "",
                );
                const activeVoiceAgentId = selectedVoiceAgent?.id || "voice-agent";
                const voiceToolCfg = getAgentToolConfig(libraryRoot, activeVoiceAgentId);
                const toolEnabledForAgent =
                  applyVoiceAgentToolFilters([{ name: normalizedToolName }], voiceToolCfg).length > 0;
                if (!toolEnabledForAgent) {
                  sendWsMessage(socket, {
                    type: "voice-tool-result",
                    callId,
                    error: `Tool "${normalizedToolName}" is not enabled for voice agent "${activeVoiceAgentId}"`,
                    ts: Date.now(),
                  });
                  return;
                }
                const voicePolicyDecision = evaluateVoiceToolPolicy({
                  toolName: normalizedToolName,
                  args: normalizedArgs,
                  context,
                  intentText: extractVoiceIntentText(normalizedArgs),
                  transport: "ws",
                });
                if (!voicePolicyDecision.allow) {
                  sendWsMessage(socket, {
                    type: "voice-tool-result",
                    callId,
                    error: String(voicePolicyDecision.message || "Voice tool policy denied execution"),
                    statusCode: Number(voicePolicyDecision.statusCode || 403),
                    ts: Date.now(),
                  });
                  return;
                }
                const result = await relay.executeVoiceTool(normalizedToolName, normalizedArgs, context);
                sendWsMessage(socket, {
                  type: "voice-tool-result",
                  callId,
                  ...result,
                  ts: Date.now(),
                });
              } catch (err) {
                sendWsMessage(socket, {
                  type: "voice-tool-result",
                  callId,
                  error: err.message,
                  ts: Date.now(),
                });
              }
            }).catch(err => {
              sendWsMessage(socket, {
                type: "voice-tool-result",
                callId,
                error: err.message,
                ts: Date.now(),
              });
            });
          }
        } catch {
          // Ignore malformed websocket payloads
        }
      });

      socket.on("close", () => {
        stopLogStream(socket);
        wsClients.delete(socket);
      });

      socket.on("error", () => {
        stopLogStream(socket);
        wsClients.delete(socket);
      });
    });

    startWsHeartbeat();

    uiServer.on("upgrade", (req, socket, head) => {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`,
      );
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      const wsAuthSource = resolveWsAuthSource(req, url);
      if (!wsAuthSource) {
        try {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        } catch {
          // no-op
        }
        socket.destroy();
        return;
      }
      req.__authSource = wsAuthSource;
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit("connection", ws, req);
      });
    });

    // Reuse a recent session token when possible so browser sessions survive restarts.
    ensureSessionToken();

    const host = options.host || DEFAULT_HOST;
    const maxPortFallbackAttempts = usingFallbackDefaultPort ? 20 : 0;
    const listenOnce = (targetPort) =>
      new Promise((resolveReady, rejectReady) => {
        const onError = (err) => {
          uiServer.off("listening", onListening);
          rejectReady(err);
        };
        const onListening = () => {
          uiServer.off("error", onError);
          resolveReady();
        };
        uiServer.once("error", onError);
        uiServer.once("listening", onListening);
        uiServer.listen(targetPort, host);
      });
    let listenPort = port;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await listenOnce(listenPort);
        break;
      } catch (err) {
        const isAddrInUse = err?.code === "EADDRINUSE";
        const canRetryPortIncrement =
          isAddrInUse &&
          attempt < maxPortFallbackAttempts &&
          listenPort > 0;
        if (canRetryPortIncrement) {
          const nextPort = listenPort + 1;
          console.warn(
            `[telegram-ui] port ${listenPort} in use; retrying on ${nextPort} (attempt ${attempt + 1}/${maxPortFallbackAttempts})`,
          );
          listenPort = nextPort;
          continue;
        }

        const code = String(err?.code || "").toUpperCase();
        const canRetryWithEphemeral =
          allowEphemeralPort && listenPort > 0 && (code === "EADDRINUSE" || code === "EACCES");
        if (!canRetryWithEphemeral) throw err;
        console.warn(
          `[telegram-ui] failed to bind ${host}:${listenPort} (${code || "unknown"}); retrying with ephemeral port`,
        );
        await listenOnce(0);
        break;
      }
    }
  } catch (err) {
    releaseUiInstanceLock();
    throw err;
  }

  const publicHost = options.publicHost || process.env.TELEGRAM_UI_PUBLIC_HOST;
  const boundHost = String(
    options.host || process.env.TELEGRAM_UI_HOST || DEFAULT_HOST,
  ).trim() || DEFAULT_HOST;
  const isLoopbackHost = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    return (
      normalized === "127.0.0.1" ||
      normalized === "localhost" ||
      normalized === "::1"
    );
  };
  const loopbackOnly = !publicHost && isLoopbackHost(boundHost);
  const lanIp = loopbackOnly ? "" : getLocalLanIp();
  const host = publicHost || (loopbackOnly ? boundHost : (lanIp || boundHost));
  const actualPort = uiServer.address().port;
  const isLocalOrPrivateHost = (value) => {
    const normalized = String(value || "").trim().toLowerCase();
    return normalized.startsWith("192.")
      || normalized.startsWith("10.")
      || normalized.startsWith("172.")
      || normalized.startsWith("127.")
      || normalized === "localhost"
      || normalized === "::1";
  };
  const protocol = uiServerTls
    ? "https"
    : publicHost && !isLocalOrPrivateHost(publicHost)
      ? "https"
      : "http";
  uiServerUrl = `${protocol}://${host}:${actualPort}`;
  updateUiInstanceLock({
    preferredPort: port,
    port: actualPort,
    host,
    protocol,
    url: uiServerUrl,
    startedAt: Date.now(),
  });
  persistLastUiPort(actualPort);
  console.log(`[telegram-ui] server listening on ${uiServerUrl}`);
  if (uiServerTls) {
    console.log(`[telegram-ui] TLS enabled (self-signed) — Telegram WebApp buttons will use HTTPS`);
  }

  // ── SECURITY: Warn loudly when auth is disabled ──────────────────────
  if (isAllowUnsafe()) {
    const tunnelMode = normalizeTunnelMode(process.env.TELEGRAM_UI_TUNNEL || DEFAULT_TUNNEL_MODE);
    const tunnelActive = tunnelMode !== TUNNEL_MODE_DISABLED;
    const border = "═".repeat(68);
    console.warn(`\n╔${border}╗`);
    console.warn(`║ :ban:  DANGER: TELEGRAM_UI_ALLOW_UNSAFE=true — ALL AUTH IS DISABLED   ║`);
    console.warn(`║                                                                    ║`);
    console.warn(`║  Anyone with your URL can control agents, read secrets, and        ║`);
    console.warn(`║  execute arbitrary commands on this machine.                        ║`);
    if (tunnelActive) {
      console.warn(`║                                                                    ║`);
      console.warn(`║  :dot:  TUNNEL IS ACTIVE — your UI is exposed to the PUBLIC INTERNET  ║`);
      console.warn(`║  This means ANYONE can discover your URL and take control.         ║`);
      console.warn(`║  Set TELEGRAM_UI_TUNNEL=disabled or TELEGRAM_UI_ALLOW_UNSAFE=false ║`);
    }
    console.warn(`╚${border}╝\n`);
  }
  if (loopbackOnly) {
    console.log(`[telegram-ui] Loopback access: ${protocol}://${host}:${actualPort}`);
    if (shouldLogTokenizedBrowserUrl()) {
      console.log(`[telegram-ui] Browser access: ${protocol}://${host}:${actualPort}/?token=${sessionToken}`);
    } else {
      console.log(
        `[telegram-ui] Browser access: ${protocol}://${host}:${actualPort} (token hidden; set BOSUN_UI_LOG_TOKENIZED_BROWSER_URL=1 for debug)`,
      );
    }
  } else {
    console.log(`[telegram-ui] LAN access: ${protocol}://${lanIp}:${actualPort}`);
    if (shouldLogTokenizedBrowserUrl()) {
      console.log(`[telegram-ui] Browser access: ${protocol}://${lanIp}:${actualPort}/?token=${sessionToken}`);
    } else {
      console.log(
        `[telegram-ui] Browser access: ${protocol}://${lanIp}:${actualPort} (token hidden; set BOSUN_UI_LOG_TOKENIZED_BROWSER_URL=1 for debug)`,
      );
    }
  }

  // Auto-open browser:
  //  - skip in desktop/Electron mode (BOSUN_DESKTOP=1)
  //  - skip when caller passes skipAutoOpen
  //  - skip during Vitest / Jest test runs (avoids opening 20+ tabs during `npm test`)
  //  - only open ONCE per process (singleton guard — prevents loops on server restart)
  const isTestRunRuntime =
    process.env.VITEST || process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID;
  const restartReason = String(
    options.restartReason || process.env.BOSUN_MONITOR_RESTART_REASON || "",
  ).trim();
  const suppressAutoOpenForRestart = restartReason.length > 0;
  if (suppressAutoOpenForRestart && autoOpenEnabled) {
    console.log(
      `[telegram-ui] auto-open suppressed during restart (${restartReason})`,
    );
  }
  if (
    autoOpenEnabled &&
    process.env.BOSUN_DESKTOP !== "1" &&
    !options.skipAutoOpen &&
    !suppressAutoOpenForRestart &&
    !_browserOpened &&
    !isTestRunRuntime &&
    shouldAutoOpenBrowserNow()
  ) {
    _browserOpened = true;
    const openHost = String(
      process.env.BOSUN_UI_AUTO_OPEN_HOST || "127.0.0.1",
    ).trim();
    const openProtocol = uiServerTls ? "https" : "http";
    const openUrl = `${openProtocol}://${openHost}:${actualPort}/?token=${sessionToken}`;
    try {
      const { exec } = await import("node:child_process");
      if (process.platform === "win32") {
        exec(`start "" "${openUrl}"`);
      } else if (process.platform === "darwin") {
        exec(`open "${openUrl}"`);
      } else {
        exec(`xdg-open "${openUrl}"`);
      }
      writeAutoOpenMarker({ url: openUrl });
    } catch { /* ignore auto-open failure */ }
  }

  if (loopbackOnly) {
    firewallState = null;
  } else {
    // Skip firewall probing for localhost-only servers to avoid a slow LAN self-connect.
    firewallState = await checkFirewall(actualPort);
    if (firewallState) {
      if (firewallState.blocked) {
        console.warn(
          `[telegram-ui] :alert:  Port ${actualPort}/tcp appears BLOCKED by ${firewallState.firewall} for LAN access.`,
        );
        console.warn(
          `[telegram-ui] To fix, run: ${firewallState.allowCmd}`,
        );
      } else {
        console.log(`[telegram-ui] Firewall (${firewallState.firewall}): port ${actualPort}/tcp is allowed`);
      }
    }
  }

    // Start cloudflared tunnel for trusted TLS (Telegram Mini App requires valid cert)
    const tUrl = await startTunnel(actualPort);
    if (tUrl) {
      console.log(`[telegram-ui] Telegram Mini App URL: ${tUrl}`);
      if (firewallState?.blocked) {
        console.log(
          `[telegram-ui] :help:  Tunnel active — Telegram Mini App works regardless of firewall. ` +
          `LAN browser access still requires port ${actualPort}/tcp to be open.`,
        );
      }
    }

  return uiServer;
}

export function stopTelegramUiServer() {
  if (!uiServer) return;
  stopTunnel();
  stopWsHeartbeat();
  _activeSessions = [];
  // Clear injected configDir so it does not leak between server lifecycles
  // (tests start/stop servers repeatedly with different config directories).
  delete uiDeps.configDir;
  for (const socket of wsClients) {
    try {
      stopLogStream(socket);
      socket.close();
    } catch {
      // best effort
    }
  }
  wsClients.clear();
  // Clean up any remaining log stream poll timers
  for (const [, streamer] of logStreamers) {
    if (streamer.pollTimer) clearInterval(streamer.pollTimer);
  }
  logStreamers.clear();
  if (wsServer) {
    try {
      wsServer.close();
    } catch {
      // best effort
    }
  }
  wsServer = null;
  try {
    uiServer.close();
  } catch {
    /* best effort */
  }
  uiServer = null;
  uiServerTls = false;
  resetProjectSyncWebhookMetrics();
  releaseUiInstanceLock();
}

export { getLocalLanIp };


