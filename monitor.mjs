import { execSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  watch,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { clearLine, createInterface, cursorTo } from "node:readline";
import net from "node:net";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

// Node.js Happy Eyeballs (RFC 8305) tries IPv6 first with a 250ms timeout
// before falling back to IPv4.  On networks where IPv6 is unreachable, the
// IPv4 fallback can exceed 250ms (Telegram's server round-trip is ~500ms)
// causing fetch() to fail with ETIMEDOUT while curl works fine.  Raise the
// attempt timeout so IPv4 has enough time to connect.
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === "function") {
  net.setDefaultAutoSelectFamilyAttemptTimeout(2000);
}

import { acquireMonitorLock, runMaintenanceSweep } from "./maintenance.mjs";
import { archiveCompletedTasks } from "./task-archiver.mjs";
import {
  attemptAutoFix,
  fixLoopingError,
  isDevMode,
  runCodexExec,
} from "./autofix.mjs";
import {
  startTelegramBot,
  stopTelegramBot,
  injectMonitorFunctions,
  notify,
  restoreLiveDigest,
  getDigestSnapshot,
  startStatusFileWriter,
  stopStatusFileWriter,
  initStatusBoard,
  pushStatusBoardUpdate,
} from "./telegram-bot.mjs";
import { startAnalyzer, stopAnalyzer } from "./agent-work-analyzer.mjs";
import {
  generateWeeklyAgentWorkReport,
  shouldSendWeeklyReport,
} from "./agent-work-report.mjs";

import {
  execPrimaryPrompt,
  initPrimaryAgent,
  setPrimaryAgent,
  getPrimaryAgentName,
  switchPrimaryAgent,
} from "./primary-agent.mjs";
import {
  execPooledPrompt,
  launchEphemeralThread,
  launchOrResumeThread,
  execWithRetry,
  getAvailableSdks,
  forceNewThread,
  steerActiveThread,
  hasActiveSession,
} from "./agent-pool.mjs";
import { loadConfig } from "./config.mjs";
import { formatPreflightReport, runPreflightChecks } from "./preflight.mjs";
import { startAutoUpdateLoop, stopAutoUpdateLoop } from "./update-check.mjs";
import {
  isWhatsAppEnabled,
  startWhatsAppChannel,
  stopWhatsAppChannel,
  notifyWhatsApp,
  getWhatsAppStatus,
} from "./whatsapp-channel.mjs";
import {
  isContainerEnabled,
  getContainerStatus,
  ensureContainerRuntime,
  stopAllContainers,
  cleanupOrphanedContainers,
} from "./container-runner.mjs";
import { ensureCodexConfig, printConfigSummary } from "./codex-config.mjs";
import { RestartController } from "./restart-controller.mjs";

import { assessTask, quickAssess } from "./task-assessment.mjs";
import {
  getBosunCoAuthorTrailer,
  shouldAddBosunCoAuthor,
} from "./git-commit-helpers.mjs";
import {
  normalizeDedupKey,
  stripAnsi,
  isErrorLine,
  escapeHtml,
  formatHtmlLink,
  getErrorFingerprint,
  getMaxParallelFromArgs,
  parsePrNumberFromUrl,
} from "./utils.mjs";
import { fetchWithFallback } from "./fetch-runtime.mjs";
import {
  initFleet,
  refreshFleet,
  buildFleetPresence,
  getFleetState,
  isFleetCoordinator,
  getFleetMode,
  getTotalFleetSlots,
  buildExecutionWaves,
  assignTasksToWorkstations,
  calculateBacklogDepth,
  detectMaintenanceMode,
  formatFleetSummary,
  persistFleetState,
} from "./fleet-coordinator.mjs";
import {
  getComplexityMatrix,
  assessCompletionConfidence,
  classifyComplexity,
  COMPLEXITY_TIERS,
  DEFAULT_MODEL_PROFILES,
  executorToSdk,
} from "./task-complexity.mjs";
import {
  getDirtyTasks,
  prioritizeDirtyTasks,
  shouldReserveDirtySlot,
  getDirtySlotReservation,
  buildConflictResolutionPrompt,
  isFileOverlapWithDirtyPR,
  registerDirtyTask,
  clearDirtyTask,
  isDirtyTask,
  getHighTierForDirty,
  isOnResolutionCooldown,
  recordResolutionAttempt,
  formatDirtyTaskSummary,
  DIRTY_TASK_DEFAULTS,
} from "./conflict-resolver.mjs";
import {
  resolveConflictsWithSDK,
  isSDKResolutionOnCooldown,
  isSDKResolutionExhausted,
  clearSDKResolutionState,
} from "./sdk-conflict-resolver.mjs";
import {
  initSharedKnowledge,
  buildKnowledgeEntry,
  appendKnowledgeEntry,
  formatKnowledgeSummary,
} from "./shared-knowledge.mjs";
import { WorkspaceMonitor } from "./workspace-monitor.mjs";
import { VkLogStream } from "./vk-log-stream.mjs";
import { VKErrorResolver } from "./vk-error-resolver.mjs";
import {
  createAnomalyDetector,
  setWorkflowEngine as bindWorkflowEngineToAnomalyDetector,
  wrapAnomalyCallback,
} from "./anomaly-detector.mjs";
import { resolvePwshRuntime } from "./pwsh-runtime.mjs";
import {
  getWorktreeManager,
  acquireWorktree,
  releaseWorktree,
  releaseWorktreeByBranch,
  findWorktreeForBranch as findManagedWorktree,
  pruneStaleWorktrees,
  getWorktreeStats,
} from "./worktree-manager.mjs";
import {
  getTaskExecutor,
  isInternalExecutorEnabled,
  isExecutorDisabled,
  getExecutorMode,
  loadExecutorOptionsFromConfig,
  setTaskStatusTransitionHandler,
} from "./task-executor.mjs";
import {
  configureFromArgs,
  installConsoleInterceptor,
  setErrorLogFile,
} from "./lib/logger.mjs";
import { fixGitConfigCorruption } from "./worktree-manager.mjs";
// ── Task management subsystem imports ──────────────────────────────────────
import {
  configureTaskStore,
  getTask as getInternalTask,
  getTasksByStatus as getInternalTasksByStatus,
  updateTask as updateInternalTask,
  addTask as addInternalTask,
  recordAgentAttempt,
  recordErrorPattern,
  getStorePath,
  loadStore as loadTaskStore,
  getStats as getTaskStoreStats,
  setTaskStatus as setInternalTaskStatus,
  setReviewResult,
  getTasksPendingReview,
  getStaleInProgressTasks,
  getStaleInReviewTasks,
  getAllTasks as getAllInternalTasks,
} from "./task-store.mjs";
import { createAgentEndpoint } from "./agent-endpoint.mjs";
import { createAgentEventBus } from "./agent-event-bus.mjs";
import { createReviewAgent } from "./review-agent.mjs";
import { createSyncEngine } from "./sync-engine.mjs";
import { createErrorDetector } from "./error-detector.mjs";
import { createAgentSupervisor } from "./agent-supervisor.mjs";
import { getSessionTracker } from "./session-tracker.mjs";
import { pullWorkspaceRepos } from "./workspace-manager.mjs";

import {
  getKanbanBackendName,
  setKanbanBackend,
  listTasks as listKanbanTasks,
  updateTaskStatus as updateKanbanTaskStatus,
  updateTask as updateKanbanTask,
  listProjects as listKanbanProjects,
  createTask as createKanbanTask,
} from "./kanban-adapter.mjs";
import { resolvePromptTemplate } from "./agent-prompts.mjs";
import { resolveCodexProfileRuntime } from "./codex-model-profiles.mjs";
const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));

// ── Anomaly signal file path (shared with ve-orchestrator.ps1) ──────────────
const ANOMALY_SIGNAL_PATH = resolve(
  __dirname,
  "..",
  ".cache",
  "anomaly-signals.json",
);

const AGENT_ALERT_POLL_MS = 10_000;
let agentWorkAnalyzerActive = false;
let agentAlertsOffset = 0;
let agentAlertsTimer = null;
const agentAlertsDedup = new Map();

function getAgentAlertsPath() {
  return resolve(repoRoot, ".cache", "agent-work-logs", "agent-alerts.jsonl");
}

function getAgentAlertsStatePath() {
  return resolve(
    repoRoot,
    ".cache",
    "agent-work-logs",
    "agent-alert-tail-state.json",
  );
}

function loadAgentAlertsState() {
  const statePath = getAgentAlertsStatePath();
  try {
    if (!existsSync(statePath)) return;
    const raw = readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const offset = Number(parsed?.offset || 0);
    if (Number.isFinite(offset) && offset >= 0) {
      agentAlertsOffset = offset;
    }
    const dedupEntries = Array.isArray(parsed?.dedupEntries)
      ? parsed.dedupEntries
      : [];
    agentAlertsDedup.clear();
    for (const entry of dedupEntries) {
      if (!entry || typeof entry !== "object") continue;
      const key = String(entry.key || "").trim();
      const ts = Number(entry.ts || 0);
      if (!key || !Number.isFinite(ts) || ts <= 0) continue;
      agentAlertsDedup.set(key, ts);
    }
  } catch (err) {
    console.warn(`[monitor] failed loading alert tail state: ${err.message}`);
  }
}

function saveAgentAlertsState() {
  const statePath = getAgentAlertsStatePath();
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    const dedupEntries = [...agentAlertsDedup.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 200)
      .map(([key, ts]) => ({ key, ts }));
    const payload = {
      offset: agentAlertsOffset,
      dedupEntries,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn(`[monitor] failed saving alert tail state: ${err.message}`);
  }
}

function rememberAlert(key) {
  agentAlertsDedup.set(key, Date.now());
  if (agentAlertsDedup.size > 200) {
    const sorted = [...agentAlertsDedup.entries()].sort((a, b) => a[1] - b[1]);
    for (const [oldKey] of sorted.slice(0, 100)) {
      agentAlertsDedup.delete(oldKey);
    }
  }
}

function formatAgentAlert(alert) {
  const severity = String(alert.severity || "medium").toUpperCase();
  const type = alert.type || "alert";
  const lines = [
    `:search: Agent Analyzer: ${severity} ${type}`,
    `Attempt: ${alert.attempt_id || "unknown"}`,
  ];
  if (alert.task_id) lines.push(`Task: ${alert.task_id}`);
  if (alert.executor) lines.push(`Executor: ${alert.executor}`);
  if (alert.recommendation) lines.push(`Recommendation: ${alert.recommendation}`);
  if (alert.error_count) lines.push(`Errors: ${alert.error_count}`);
  if (alert.idle_time_ms) {
    lines.push(`Idle: ${Math.round(alert.idle_time_ms / 1000)}s`);
  }
  if (alert.cost_usd) lines.push(`Cost: $${Number(alert.cost_usd).toFixed(3)}`);
  return lines.join("\n");
}

function formatMonitorError(err) {
  if (err == null) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message || String(err);
  if (typeof err === "object") {
    const details = [err.message, err.error, err.stderr, err.reason]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => String(value).trim());
    if (details.length > 0) return details[0];
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function parseEnvBoolean(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseEnvInteger(value, defaultValue, { min = null, max = null } = {}) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  if (Number.isFinite(min) && parsed < min) return defaultValue;
  if (Number.isFinite(max) && parsed > max) return defaultValue;
  return parsed;
}

let workflowAutomationEnabled = false;
let workflowEventDedupWindowMs = 15_000;
const workflowEventDedup = new Map();
const workflowTaskStatusSnapshot = new Map();
let workflowAutomationEngine = null;
let workflowAutomationInitPromise = null;
let workflowAutomationInitDone = false;
let workflowAutomationReadyLogged = false;
let workflowAutomationUnavailableLogged = false;
let workflowConflictResolverPausedLogged = false;
let workflowTaskReconcilePausedLogged = false;

/**
 * Cache of module names that have an enabled workflow replacement.
 * Populated once after the workflow engine loads.
 * Used by `isWorkflowReplacingModule()` to let legacy code yield.
 */
const _workflowReplacesModuleCache = new Set();
let _workflowReplacesModuleCachePopulated = false;

/**
 * Check whether a workflow replaces a legacy module and workflow automation is
 * enabled.  When this returns `true` the legacy code-path should yield so that
 * the same action is not performed twice (once by the module and once by the
 * workflow).
 *
 * @param {string} moduleName  e.g. "merge-strategy.mjs", "review-agent.mjs"
 * @returns {boolean}
 */
function isWorkflowReplacingModule(moduleName) {
  if (!workflowAutomationEnabled) return false;
  if (!workflowAutomationEngine) return false;

  // Lazily populate the cache from the engine's loaded workflows
  if (!_workflowReplacesModuleCachePopulated) {
    _workflowReplacesModuleCachePopulated = true;
    try {
      const all = workflowAutomationEngine.list?.() || [];
      for (const wf of all) {
        if (wf?.enabled === false) continue;
        const replaces = wf?.metadata?.replaces?.module;
        if (replaces) _workflowReplacesModuleCache.add(replaces);
      }
    } catch { /* best effort */ }
  }
  return _workflowReplacesModuleCache.has(moduleName);
}

function allowWorkflowEvent(dedupKey, windowMs = workflowEventDedupWindowMs) {
  if (!dedupKey) return true;
  const now = Date.now();
  const last = workflowEventDedup.get(dedupKey) || 0;
  if (now - last < windowMs) return false;
  workflowEventDedup.set(dedupKey, now);
  if (workflowEventDedup.size > 1000) {
    const cutoff = now - windowMs * 2;
    for (const [key, ts] of workflowEventDedup) {
      if (ts < cutoff) workflowEventDedup.delete(key);
    }
  }
  return true;
}

function buildWorkflowEventPayload(eventType, eventData = {}) {
  const payload =
    eventData && typeof eventData === "object" ? { ...eventData } : {};
  payload.eventType = eventType;
  if (String(eventType || "").startsWith("pr.")) {
    const prEvent = String(eventType).slice(3).trim();
    if (prEvent) payload.prEvent = prEvent;
  }
  payload._triggerSource = "monitor-event";
  payload._triggerEventType = eventType;
  payload._triggeredAt = new Date().toISOString();
  return payload;
}

async function ensureWorkflowAutomationEngine() {
  if (!workflowAutomationEnabled || process.env.VITEST) return null;
  if (workflowAutomationEngine) return workflowAutomationEngine;
  if (workflowAutomationInitDone) return null;
  if (workflowAutomationInitPromise) return workflowAutomationInitPromise;

  workflowAutomationInitPromise = (async () => {
    try {
      const [{ getWorkflowEngine }, { createTask }, wfNodes] = await Promise.all([
        import("./workflow-engine.mjs"),
        import("./kanban-adapter.mjs"),
        import("./workflow-nodes.mjs"),
      ]);
      if (!wfNodes) {
        throw new Error("workflow nodes unavailable");
      }

      const kanbanService = {
        createTask: async (taskData = {}) => {
          const backend = getActiveKanbanBackend();
          const projectId = String(
            taskData?.projectId || getConfiguredKanbanProjectId(backend) || "",
          ).trim();
          if (!projectId) {
            throw new Error(
              `No project ID configured for backend=${backend} (required for workflow action.create_task)`,
            );
          }
          const payload = { ...(taskData || {}) };
          delete payload.projectId;
          return createTask(projectId, payload);
        },
        updateTaskStatus: async (taskId, status, options = {}) =>
          updateTaskStatus(
            String(taskId || ""),
            String(status || ""),
            options && typeof options === "object" ? options : {},
          ),
        listTasks: async (projectId, filters = {}) =>
          listKanbanTasks(String(projectId || ""), filters || {}),
      };

      const agentPoolService = {
        launchEphemeralThread,
        launchOrResumeThread,
        execWithRetry,
        async continueSession(sessionId, prompt, opts = {}) {
          const timeout = Number(opts.timeout) || 60 * 60 * 1000;
          const cwd = opts.cwd || process.cwd();
          return launchOrResumeThread(prompt, cwd, timeout, {
            taskKey: sessionId,
            sdk: opts.sdk,
            model: opts.model,
          });
        },
      };

      const telegramService =
        telegramToken && telegramChatId
          ? {
              async sendMessage(chatId, text) {
                const target = chatId || telegramChatId;
                if (!target) return;
                await sendTelegramMessage(String(text || ""), {
                  chatId: String(target),
                });
              },
            }
          : null;

      let meetingService = null;
      try {
        const { createMeetingWorkflowService } = await import("./meeting-workflow-service.mjs");
        meetingService = createMeetingWorkflowService();
      } catch (err) {
        console.warn(`[workflows] meeting service unavailable: ${err?.message || err}`);
      }

      const services = {
        telegram: telegramService,
        kanban: kanbanService,
        agentPool: agentPoolService,
        meeting: meetingService,
        prompts: agentPrompts || null,
        anomalyDetector: anomalyDetector || null,
      };

      const engine = getWorkflowEngine({ services });
      workflowAutomationEngine = engine;
      bindWorkflowEngineToAnomalyDetector(engine);

      if (!workflowAutomationReadyLogged) {
        workflowAutomationReadyLogged = true;
        const all = engine.list?.() || [];
        const total = all.length;
        const enabled = all.filter((wf) => wf?.enabled !== false).length;
        console.log(
          `[workflows] automation enabled — loaded ${enabled}/${total} workflow(s)`,
        );

        // Populate the legacy-module replacement cache so callers of
        // isWorkflowReplacingModule() get instant answers.
        _workflowReplacesModuleCachePopulated = true;
        _workflowReplacesModuleCache.clear();
        const replaced = [];
        for (const wf of all) {
          if (wf?.enabled === false) continue;
          const mod = wf?.metadata?.replaces?.module;
          if (mod) {
            _workflowReplacesModuleCache.add(mod);
            replaced.push(mod);
          }
        }
        if (replaced.length > 0) {
          console.log(
            `[workflows] legacy modules paused (replaced by workflows): ${replaced.join(", ")}`,
          );
        }
      }
      return engine;
    } catch (err) {
      if (!workflowAutomationUnavailableLogged) {
        workflowAutomationUnavailableLogged = true;
        console.warn(
          `[workflows] automation unavailable: ${err?.message || err}`,
        );
      }
      return null;
    } finally {
      workflowAutomationInitDone = true;
      workflowAutomationInitPromise = null;
    }
  })();

  return workflowAutomationInitPromise;
}

async function dispatchWorkflowEvent(eventType, eventData = {}, opts = {}) {
  try {
  if (!workflowAutomationEnabled) return false;
  const dedupKey = String(opts?.dedupKey || "").trim();
  if (dedupKey && !allowWorkflowEvent(dedupKey)) {
    return false;
  }

  const engine = await ensureWorkflowAutomationEngine();
  if (!engine?.evaluateTriggers || !engine?.execute) return false;

  const payload = buildWorkflowEventPayload(eventType, eventData);
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
    void engine
      .execute(workflowId, runPayload)
      .then((ctx) => {
        const runId = ctx?.id || "unknown";
        const runStatus =
          Array.isArray(ctx?.errors) && ctx.errors.length > 0
            ? "failed"
            : "completed";
        console.log(
          `[workflows] auto-run ${runStatus} workflow=${workflowId} runId=${runId} event=${eventType}`,
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
  dispatchWorkflowEvent(eventType, eventData, opts).catch(() => {});
}

function configureExecutorTaskStatusTransitions() {
  if (!workflowAutomationEnabled) {
    setTaskStatusTransitionHandler(null);
    return;
  }

  setTaskStatusTransitionHandler(async (taskId, status, options = {}) => {
    const normalizedTaskId = String(taskId || "").trim();
    const normalizedStatus = String(status || "").trim().toLowerCase();
    if (!normalizedTaskId || !normalizedStatus) return false;
    const payload =
      options && typeof options === "object" ? { ...options } : {};

    queueWorkflowEvent(
      "task.transition.requested",
      {
        taskId: normalizedTaskId,
        targetStatus: normalizedStatus,
        status: normalizedStatus,
        taskTitle: String(payload.taskTitle || "").trim() || null,
        source: String(payload.source || "task-executor").trim() || "task-executor",
        branch: payload.branch || null,
        baseBranch: payload.baseBranch || null,
        worktreePath: payload.worktreePath || null,
        prNumber: payload.prNumber || null,
        prUrl: payload.prUrl || null,
        error: payload.error || null,
      },
      {
        dedupKey:
          payload.workflowDedupKey ||
          `workflow-event:task.transition.requested:${normalizedTaskId}:${normalizedStatus}`,
      },
    );
    return true;
  });
}

async function pollAgentAlerts() {
  if (process.env.VITEST) return;
  const path = getAgentAlertsPath();
  if (!existsSync(path)) return;
  let data;
  try {
    data = await readFile(path, "utf8");
  } catch {
    return;
  }
  if (data.length < agentAlertsOffset) {
    agentAlertsOffset = 0;
  }
  if (!data || data.length <= agentAlertsOffset) return;
  const chunk = data.slice(agentAlertsOffset);
  agentAlertsOffset = data.length;
  const lines = chunk.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let alert;
    try {
      alert = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const dedupKey = `${alert.type || "alert"}:${alert.attempt_id || "unknown"}:${alert.timestamp || ""}`;
    if (agentAlertsDedup.has(dedupKey)) continue;
    rememberAlert(dedupKey);
    console.warn(
      `[agent-work-analyzer] ${alert.severity || "medium"} ${alert.type || "alert"} ${alert.attempt_id || ""}`,
    );
    if (
      telegramToken &&
      telegramChatId &&
      process.env.AGENT_ALERTS_NOTIFY === "true"
    ) {
      runDetached("agent-alerts:notify", () =>
        sendTelegramMessage(formatAgentAlert(alert), {
          dedupKey: `agent-alert:${alert.type || "alert"}:${alert.attempt_id || "unknown"}`,
        }),
      );
    }

    // Act on failed-session alerts: apply a cooldown so task-executor does not
    // immediately restart the same session against a failing API/provider.
    if (
      (alert.type === "failed_session_high_errors" || alert.type === "failed_session_transient_errors") &&
      alert.task_id &&
      internalTaskExecutor
    ) {
      try {
        const taskId = alert.task_id;
        const cooldownMs = alert.type === "failed_session_transient_errors"
          ? 30 * 60_000
          : 15 * 60_000;
        const cooldownUntil = Date.now() + cooldownMs;
        if (typeof internalTaskExecutor.applyTaskCooldown === "function") {
          internalTaskExecutor.applyTaskCooldown(taskId, cooldownUntil);
        } else if (internalTaskExecutor._skipUntil instanceof Map) {
          internalTaskExecutor._skipUntil.set(taskId, cooldownUntil);
        }
        console.warn(
          `[monitor] ${Math.round(cooldownMs / 60_000)}m cooldown applied to task ${taskId} after ${alert.error_count || "?"} API errors (${alert.type}, executor: ${alert.executor || "unknown"})`,
        );
      } catch { /* best effort */ }
    }
  }
  saveAgentAlertsState();
}

function startAgentWorkAnalyzer() {
  if (agentWorkAnalyzerActive) return;
  if (process.env.AGENT_WORK_ANALYZER_ENABLED === "false") return;
  try {
    startAnalyzer().catch((err) => {
      console.warn(`[monitor] agent-work analyzer async error: ${err.message}`);
      agentWorkAnalyzerActive = false;
    });
    agentWorkAnalyzerActive = true;
    console.log("[monitor] agent-work analyzer started");
  } catch (err) {
    console.warn(`[monitor] agent-work analyzer failed to start: ${err.message}`);
  }
}

function stopAgentWorkAnalyzer() {
  if (!agentWorkAnalyzerActive) return;
  try {
    stopAnalyzer();
  } catch {
    /* ignore */
  }
  agentWorkAnalyzerActive = false;
}

function startAgentAlertTailer() {
  if (agentAlertsTimer) return;
  loadAgentAlertsState();
  agentAlertsTimer = setInterval(() => {
    runDetached("agent-alerts:poll-interval", pollAgentAlerts);
  }, AGENT_ALERT_POLL_MS);
  agentAlertsTimer.unref?.();
  runDetached("agent-alerts:poll-startup", pollAgentAlerts);
}

function stopAgentAlertTailer() {
  if (agentAlertsTimer) {
    clearInterval(agentAlertsTimer);
    agentAlertsTimer = null;
  }
}

/**
 * Write an anomaly signal to the shared signal file for the orchestrator to pick up.
 * The orchestrator reads this file in Process-AnomalySignals and acts accordingly.
 */
function writeAnomalySignal(anomaly) {
  try {
    const dir = resolve(__dirname, "..", ".cache");
    mkdirSync(dir, { recursive: true });
    let signals = [];
    try {
      const raw = readFileSync(ANOMALY_SIGNAL_PATH, "utf8");
      signals = JSON.parse(raw);
      if (!Array.isArray(signals)) signals = [];
    } catch {
      /* file doesn't exist yet */
    }
    signals.push({
      type: anomaly.type,
      severity: anomaly.severity,
      action: anomaly.action,
      shortId: anomaly.shortId,
      processId: anomaly.processId,
      message: anomaly.message,
      timestamp: new Date().toISOString(),
    });
    // Cap at 50 signals to prevent unbounded growth
    if (signals.length > 50) signals = signals.slice(-50);
    writeFileSync(ANOMALY_SIGNAL_PATH, JSON.stringify(signals, null, 2));
  } catch (err) {
    console.warn(
      `[anomaly-detector] writeAnomalySignal failed: ${err.message}`,
    );
  }
}

// ── Configure logging before anything else ──────────────────────────────────
configureFromArgs(process.argv.slice(2));
const isMonitorTestRuntime =
  ["1", "true", "yes", "on"].includes(
    String(process.env.VITEST || "")
      .trim()
      .toLowerCase(),
  ) || String(process.env.NODE_ENV || "").trim().toLowerCase() === "test";

// ── Load unified configuration ──────────────────────────────────────────────
let config;
try {
  config = loadConfig();
} catch (err) {
  const message = err?.message || String(err);
  console.error(`[monitor] configuration error: ${message}`);
  process.exit(1);
}
workflowAutomationEnabled = parseEnvBoolean(
  process.env.WORKFLOW_AUTOMATION_ENABLED,
  false,
);
{
  const dedupMs = Number(process.env.WORKFLOW_EVENT_DEDUP_WINDOW_MS || "15000");
  workflowEventDedupWindowMs = Number.isFinite(dedupMs) && dedupMs > 0
    ? dedupMs
    : 15_000;
}
configureExecutorTaskStatusTransitions();

// Install console interceptor with log file (after config provides logDir)
{
  if (!isMonitorTestRuntime) {
    const _logDir = config.logDir || resolve(__dirname, "logs");
    const _logFile = resolve(_logDir, "monitor.log");
    const _errorLogFile = resolve(_logDir, "monitor-error.log");
    installConsoleInterceptor({ logFile: _logFile });
    setErrorLogFile(_errorLogFile);
  }
}

// Guard against core.bare=true corruption on the main repo at startup
fixGitConfigCorruption(resolve(__dirname, "..", ".."));

function canSignalProcess(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireTelegramPollLock(owner) {
  if (telegramPollLockHeld) return true;
  try {
    const payload = JSON.stringify(
      { owner, pid: process.pid, started_at: new Date().toISOString() },
      null,
      2,
    );
    await writeFile(telegramPollLockPath, payload, { flag: "wx" });
    telegramPollLockHeld = true;
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") {
      try {
        const raw = await readFile(telegramPollLockPath, "utf8");
        const data = JSON.parse(raw);
        const pid = Number(data?.pid);
        if (!canSignalProcess(pid)) {
          await unlink(telegramPollLockPath);
          return await acquireTelegramPollLock(owner);
        }
      } catch {
        /* best effort */
      }
    }
    return false;
  }
}

async function releaseTelegramPollLock() {
  if (!telegramPollLockHeld) return;
  telegramPollLockHeld = false;
  try {
    await unlink(telegramPollLockPath);
  } catch {
    /* best effort */
  }
}

let {
  projectName,
  scriptPath,
  scriptArgs,
  restartDelayMs,
  maxRestarts,
  logDir,
  logMaxSizeMb,
  logCleanupIntervalMin,
  watchEnabled,
  watchPath: configWatchPath,
  echoLogs,
  interactiveShellEnabled,
  autoFixEnabled,
  preflightEnabled: configPreflightEnabled,
  preflightRetryMs: configPreflightRetryMs,
  primaryAgent,
  primaryAgentEnabled,
  agentPoolEnabled,
  repoRoot,
  agentRepoRoot,
  statusPath,
  telegramPollLockPath,
  telegramToken,
  telegramChatId,
  telegramIntervalMin,
  telegramCommandPollTimeoutSec,
  telegramCommandConcurrency,
  telegramCommandMaxBatch,
  telegramBotEnabled,
  telegramCommandEnabled,
  repoSlug,
  repoUrlBase,
  vkRecoveryPort,
  vkRecoveryHost,
  vkEndpointUrl,
  vkPublicUrl,
  vkTaskUrlTemplate,
  vkRecoveryCooldownMin,
  vkSpawnEnabled,
  vkEnsureIntervalMs,
  kanban: kanbanConfig,
  plannerPerCapitaThreshold,
  plannerIdleSlotThreshold,
  plannerDedupMs,
  plannerMode: configPlannerMode,
  triggerSystem: configTriggerSystem,
  agentPrompts,
  executorConfig: configExecutorConfig,
  scheduler: executorScheduler,
  agentSdk,
  envPaths,
  dependabotAutoMerge,
  dependabotAutoMergeIntervalMin,
  dependabotMergeMethod,
  dependabotAuthors,
  branchRouting,
  telegramVerbosity,
  fleet: fleetConfig,
  internalExecutor: internalExecutorConfig,
  executorMode: configExecutorMode,
  githubReconcile: githubReconcileConfig,
} = config;

const telegramWeeklyReportEnabled = parseEnvBoolean(
  process.env.TELEGRAM_WEEKLY_REPORT_ENABLED,
  false,
);
const telegramWeeklyReportDay = parseEnvInteger(
  process.env.TELEGRAM_WEEKLY_REPORT_DAY,
  0,
  { min: 0, max: 6 },
);
const telegramWeeklyReportHour = parseEnvInteger(
  process.env.TELEGRAM_WEEKLY_REPORT_HOUR,
  9,
  { min: 0, max: 23 },
);
const telegramWeeklyReportDays = parseEnvInteger(
  process.env.TELEGRAM_WEEKLY_REPORT_DAYS,
  7,
  { min: 1, max: 30 },
);

let watchPath = resolve(configWatchPath);
let codexEnabled = config.codexEnabled;
let plannerMode = configPlannerMode; // "codex-sdk" | "kanban" | "disabled"
let triggerSystemConfig =
  configTriggerSystem && typeof configTriggerSystem === "object"
    ? configTriggerSystem
    : { enabled: false, templates: [], defaults: { executor: "auto", model: "auto" } };
let kanbanBackend = String(kanbanConfig?.backend || "internal").toLowerCase();
let executorMode = configExecutorMode || getExecutorMode();
let githubReconcile = githubReconcileConfig || {
  enabled: false,
  intervalMs: 5 * 60 * 1000,
  mergedLookbackHours: 72,
  trackingLabels: ["tracking"],
};
let chdirUnsupportedInRuntime = false;

function isChdirUnsupportedError(err) {
  if (!err) {
    return false;
  }
  const code = String(err.code || "");
  const message = String(err.message || "").toLowerCase();
  return (
    code === "ERR_WORKER_UNSUPPORTED_OPERATION" ||
    message.includes("process.chdir() is not supported in workers")
  );
}

function normalizePathForCompare(pathValue) {
  const normalized = String(pathValue || "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// ── Ensure CWD is the repo root ─────────────────────────────────────────────
// The daemon is spawned with cwd=homedir (to avoid deleted worktree paths).
// Re-anchor CWD to repoRoot so child processes (esp. Codex CLI) inherit a
// trusted git directory, preventing "Not inside a trusted directory" errors.
// Prefer agentRepoRoot (workspace-aware) over raw repoRoot.
const effectiveRepoRoot = agentRepoRoot || repoRoot;
const needsChdir =
  effectiveRepoRoot &&
  normalizePathForCompare(process.cwd()) !==
    normalizePathForCompare(effectiveRepoRoot);
if (!isMainThread || chdirUnsupportedInRuntime) {
  // Worker threads cannot call process.chdir(); skip to avoid noisy warnings.
} else if (needsChdir) {
  try {
    process.chdir(effectiveRepoRoot);
    console.log(`[monitor] changed CWD to repo root: ${effectiveRepoRoot}`);
    if (agentRepoRoot && agentRepoRoot !== repoRoot) {
      console.log(`[monitor] agent repo root (workspace): ${agentRepoRoot}`);
      console.log(`[monitor] developer repo root: ${repoRoot}`);
    }
  } catch (err) {
    if (isChdirUnsupportedError(err)) {
      chdirUnsupportedInRuntime = true;
      console.log("[monitor] runtime does not support process.chdir(); skipping CWD re-anchor.");
    } else {
      console.warn(`[monitor] could not chdir to ${effectiveRepoRoot}: ${err.message}`);
      // Fall back to repoRoot if agentRepoRoot failed
      if (
        agentRepoRoot &&
        repoRoot &&
        agentRepoRoot !== repoRoot &&
        normalizePathForCompare(process.cwd()) !== normalizePathForCompare(repoRoot)
      ) {
        try {
          process.chdir(repoRoot);
          console.log(`[monitor] fell back to developer repo root: ${repoRoot}`);
        } catch (e2) {
          if (isChdirUnsupportedError(e2)) {
            chdirUnsupportedInRuntime = true;
            console.log("[monitor] runtime does not support process.chdir(); fallback skipped.");
          } else {
            console.warn(`[monitor] could not chdir to fallback ${repoRoot}: ${e2.message}`);
          }
        }
      }
    }
  }
}

// ── Workspace Bootstrap ─────────────────────────────────────────────────────
// If workspaces are configured, ensure workspace repos are cloned and have .git
// before any agent execution begins.
{
  const wsArray = config.repositories?.filter((r) => r.workspace) || [];
  if (wsArray.length > 0) {
    const workspaceIds = [...new Set(wsArray.map((r) => r.workspace).filter(Boolean))];
    for (const wsId of workspaceIds) {
      const wsRepos = wsArray.filter((r) => r.workspace === wsId);
      let needsClone = false;
      for (const repo of wsRepos) {
        const gitPath = resolve(repo.path, ".git");
        if (!existsSync(gitPath)) {
          console.log(`[monitor] workspace repo missing .git: ${repo.path}`);
          needsClone = true;
          break;
        }
      }
      if (needsClone) {
        try {
          const results = pullWorkspaceRepos(config.configDir, wsId);
          for (const r of results) {
            if (r.success) {
              console.log(`[monitor] ✓ workspace repo ready: ${r.name}`);
            } else {
              console.warn(`[monitor] :alert: workspace repo failed: ${r.name} — ${r.error}`);
            }
          }
        } catch (err) {
          console.warn(`[monitor] workspace bootstrap failed for ${wsId}: ${err.message}`);
          console.warn(`[monitor] falling back to REPO_ROOT for agent execution`);
        }
      }
    }
  }
}

// ── Periodic Workspace Sync ─────────────────────────────────────────────────
// Every 30 minutes, fetch latest changes for all workspace repos so agents
// always work against recent upstream. Only runs if workspaces are configured.
const WORKSPACE_SYNC_INTERVAL_MS = parseEnvInteger(
  process.env.BOSUN_WORKSPACE_SYNC_INTERVAL_MS,
  30 * 60 * 1000,
  { min: 60 * 1000, max: 120 * 60 * 1000 },
); // 1m..120m (default 30m)
const WORKSPACE_SYNC_INITIAL_DELAY_MS = parseEnvInteger(
  process.env.BOSUN_WORKSPACE_SYNC_INITIAL_DELAY_MS,
  20 * 1000,
  { min: 0, max: 5 * 60 * 1000 },
); // 0s..5m (default 20s)
const WORKSPACE_SYNC_INITIAL_JITTER_MS = parseEnvInteger(
  process.env.BOSUN_WORKSPACE_SYNC_INITIAL_JITTER_MS,
  5 * 1000,
  { min: 0, max: 60 * 1000 },
); // 0s..60s (default 5s)
const WORKSPACE_SYNC_WARN_THROTTLE_MS = parseEnvInteger(
  process.env.BOSUN_WORKSPACE_SYNC_WARN_THROTTLE_MS,
  6 * 60 * 60 * 1000,
  { min: 60 * 1000, max: 24 * 60 * 60 * 1000 },
); // 1m..24h (default 6h)
const WORKSPACE_SYNC_SLOW_WARN_MS = parseEnvInteger(
  process.env.BOSUN_WORKSPACE_SYNC_SLOW_WARN_MS,
  90 * 1000,
  { min: 5 * 1000, max: 10 * 60 * 1000 },
); // 5s..10m (default 90s)
const WORKSPACE_SYNC_WARN_MAX_KEYS = parseEnvInteger(
  process.env.BOSUN_WORKSPACE_SYNC_WARN_MAX_KEYS,
  500,
  { min: 50, max: 5000 },
); // 50..5000 (default 500)
let workspaceSyncTimer = null;
let workspaceSyncInitialTimer = null;
let workspaceSyncInFlight = false;
const workspaceSyncWarnSeen = new Map();
function stopWorkspaceSyncTimers() {
  if (workspaceSyncInitialTimer) {
    clearTimeout(workspaceSyncInitialTimer);
    workspaceSyncInitialTimer = null;
  }
  if (workspaceSyncTimer) {
    clearInterval(workspaceSyncTimer);
    workspaceSyncTimer = null;
  }
}
function shouldEmitWorkspaceSyncWarn(key, now = Date.now()) {
  for (const [seenKey, seenAt] of workspaceSyncWarnSeen.entries()) {
    if (now - Number(seenAt || 0) >= WORKSPACE_SYNC_WARN_THROTTLE_MS) {
      workspaceSyncWarnSeen.delete(seenKey);
    }
  }
  const last = Number(workspaceSyncWarnSeen.get(key) || 0);
  if (last > 0 && now - last < WORKSPACE_SYNC_WARN_THROTTLE_MS) return false;
  workspaceSyncWarnSeen.set(key, now);
  // keep memory bounded
  if (workspaceSyncWarnSeen.size > WORKSPACE_SYNC_WARN_MAX_KEYS) {
    const oldestKey = workspaceSyncWarnSeen.keys().next().value;
    if (oldestKey) workspaceSyncWarnSeen.delete(oldestKey);
  }
  return true;
}
function clearWorkspaceSyncWarnForWorkspace(workspaceId) {
  const prefix = `${workspaceId}:`;
  for (const key of workspaceSyncWarnSeen.keys()) {
    if (String(key).startsWith(prefix)) {
      workspaceSyncWarnSeen.delete(key);
    }
  }
}
function isBenignWorkspaceSyncFailure(errorText) {
  const text = String(errorText || "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("uncommitted changes") ||
    text.includes("unstaged changes") ||
    text.includes("your index contains uncommitted changes") ||
    text.includes("cannot pull with rebase") ||
    text.includes("cannot rebase") ||
    text.includes("please commit or stash") ||
    text.includes("please commit your changes or stash them") ||
    text.includes("would be overwritten by merge") ||
    text.includes("working tree contains unstaged changes") ||
    text.includes("non-fast-forward") ||
    text.includes("fetch first") ||
    text.includes("local changes would be overwritten by checkout") ||
    text.includes("cannot fast-forward") ||
    text.includes("is behind")
  );
}
{
  const wsArray = config.repositories?.filter((r) => r.workspace) || [];
  if (wsArray.length > 0) {
    const workspaceIds = [...new Set(wsArray.map((r) => r.workspace).filter(Boolean))];
    const doWorkspaceSync = () => {
      if (shuttingDown) return;
      if (workspaceSyncInFlight) {
        console.log("[monitor] workspace sync: previous run still in progress — skipping overlap");
        return;
      }
      workspaceSyncInFlight = true;
      const runStartedAt = Date.now();
      let workspaceCount = 0;
      let repoCount = 0;
      let failedRepoCount = 0;
      let workspaceExceptionCount = 0;
      try {
        for (const wsId of workspaceIds) {
          workspaceCount += 1;
          if (shuttingDown) break;
          try {
            const results = pullWorkspaceRepos(config.configDir, wsId);
            repoCount += Array.isArray(results) ? results.length : 0;
            const failed = results.filter((r) => !r.success);
            failedRepoCount += failed.length;
            if (failed.length > 0) {
              const benignFailed = failed.filter((r) => isBenignWorkspaceSyncFailure(r?.error));
              const nonBenignFailed = failed.filter((r) => !isBenignWorkspaceSyncFailure(r?.error));
              if (nonBenignFailed.length === 0) {
                clearWorkspaceSyncWarnForWorkspace(wsId);
                console.log(
                  `[monitor] workspace sync: ${wsId} skipped ${failed.length} repo(s) with local changes`,
                );
              } else {
                const sampleSource = nonBenignFailed[0] || failed[0];
                const sample = String(sampleSource?.error || "unknown error")
                  .replace(/\s+/g, " ")
                  .trim();
                const snippet = sample.slice(0, 180);
                const fingerprint = normalizeDedupKey(getErrorFingerprint(snippet)).slice(0, 120);
                const repoSample = Array.from(
                  new Set(
                    nonBenignFailed
                      .map((r) => String(r?.name || "").trim())
                      .filter(Boolean),
                  ),
                )
                  .sort((a, b) => a.localeCompare(b))
                  .slice(0, 3);
                const repoLabel = repoSample.length ? ` [repos: ${repoSample.join(", ")}]` : "";
                const benignSuffix = benignFailed.length
                  ? ` (+${benignFailed.length} benign skipped)`
                  : "";
                const warnKey = `${wsId}:${nonBenignFailed.length}:${repoSample.join("|")}:${fingerprint}`;
                if (shouldEmitWorkspaceSyncWarn(warnKey)) {
                  console.warn(
                    `[monitor] workspace sync: ${nonBenignFailed.length} repo(s) failed in ${wsId}${benignSuffix}${repoLabel} (sample: ${snippet || "unknown error"})`,
                  );
                } else {
                  console.log(
                    `[monitor] workspace sync: ${nonBenignFailed.length} repo(s) failed in ${wsId}${benignSuffix}${repoLabel} (duplicate warning suppressed)`,
                  );
                }
              }
            } else {
              clearWorkspaceSyncWarnForWorkspace(wsId);
              console.log(`[monitor] workspace sync: ${wsId} up to date (${results.length} repos)`);
            }
          } catch (err) {
            failedRepoCount += 1;
            workspaceExceptionCount += 1;
            const errText = formatMonitorError(err).replace(/\s+/g, " ").trim();
            const errSnippet = (errText || "unknown error").slice(0, 180);
            const errFingerprint = normalizeDedupKey(getErrorFingerprint(errSnippet)).slice(0, 120);
            const warnKey = `${wsId}:exception:${errFingerprint}`;
            if (shouldEmitWorkspaceSyncWarn(warnKey)) {
              console.warn(`[monitor] workspace sync failed for ${wsId}: ${errSnippet}`);
            } else {
              console.log(`[monitor] workspace sync failed for ${wsId} (duplicate warning suppressed)`);
            }
          }
        }
      } finally {
        const durationMs = Date.now() - runStartedAt;
        const summary = `[monitor] workspace sync: cycle complete (${workspaceCount} workspace(s), ${repoCount} repo(s), ${failedRepoCount} failure(s), ${workspaceExceptionCount} exception(s), ${Math.round(durationMs / 1000)}s)`;
        if (repoCount > 0 && failedRepoCount >= repoCount) {
          console.warn(
            `[monitor] workspace sync: all repos failed this cycle (${failedRepoCount}/${repoCount})`,
          );
        }
        if (workspaceExceptionCount > 0) {
          console.warn(
            `[monitor] workspace sync: ${workspaceExceptionCount} workspace exception(s) this cycle`,
          );
        }
        if (workspaceCount > 0 && workspaceExceptionCount >= workspaceCount) {
          console.warn(
            `[monitor] workspace sync: all workspaces raised exceptions this cycle (${workspaceExceptionCount}/${workspaceCount})`,
          );
        }
        if (workspaceCount > 0 && repoCount === 0) {
          console.warn(
            `[monitor] workspace sync: no repos processed across ${workspaceCount} workspace(s) this cycle`,
          );
        }
        if (durationMs >= WORKSPACE_SYNC_SLOW_WARN_MS) {
          console.warn(`${summary} [slow>=${Math.round(WORKSPACE_SYNC_SLOW_WARN_MS / 1000)}s]`);
        } else {
          console.log(summary);
        }
        workspaceSyncInFlight = false;
      }
    };
    const workspaceSyncInitialJitterMs =
      WORKSPACE_SYNC_INITIAL_JITTER_MS > 0
        ? Math.floor(Math.random() * (WORKSPACE_SYNC_INITIAL_JITTER_MS + 1))
        : 0;
    const workspaceSyncInitialDelayEffectiveMs = Math.max(
      0,
      WORKSPACE_SYNC_INITIAL_DELAY_MS + workspaceSyncInitialJitterMs,
    );
    workspaceSyncInitialTimer = setTimeout(() => {
      workspaceSyncInitialTimer = null;
      doWorkspaceSync();
    }, workspaceSyncInitialDelayEffectiveMs);
    if (workspaceSyncInitialTimer?.unref) workspaceSyncInitialTimer.unref();
    workspaceSyncTimer = setInterval(doWorkspaceSync, WORKSPACE_SYNC_INTERVAL_MS);
    // Unref so the timer doesn't keep the process alive during shutdown
    if (workspaceSyncTimer?.unref) workspaceSyncTimer.unref();
    console.log(
      `[monitor] workspace sync: scheduled every ${WORKSPACE_SYNC_INTERVAL_MS / 60000} min for ${workspaceIds.length} workspace(s); initial run in ${Math.round(workspaceSyncInitialDelayEffectiveMs / 1000)}s (base=${Math.round(WORKSPACE_SYNC_INITIAL_DELAY_MS / 1000)}s, jitter<=${Math.round(WORKSPACE_SYNC_INITIAL_JITTER_MS / 1000)}s)`,
    );
    console.log(
      `[monitor] workspace sync: warn-throttle=${Math.round(WORKSPACE_SYNC_WARN_THROTTLE_MS / 60000)}m slow-threshold=${Math.round(WORKSPACE_SYNC_SLOW_WARN_MS / 1000)}s max-warn-keys=${WORKSPACE_SYNC_WARN_MAX_KEYS}`,
    );
    if (WORKSPACE_SYNC_WARN_THROTTLE_MS < WORKSPACE_SYNC_INTERVAL_MS) {
      console.warn(
        `[monitor] workspace sync: warn-throttle (${Math.round(WORKSPACE_SYNC_WARN_THROTTLE_MS / 1000)}s) is below interval (${Math.round(WORKSPACE_SYNC_INTERVAL_MS / 1000)}s); duplicate warning suppression may be ineffective`,
      );
    }
    if (WORKSPACE_SYNC_SLOW_WARN_MS >= WORKSPACE_SYNC_INTERVAL_MS) {
      console.warn(
        `[monitor] workspace sync: slow-threshold (${Math.round(WORKSPACE_SYNC_SLOW_WARN_MS / 1000)}s) is >= interval (${Math.round(WORKSPACE_SYNC_INTERVAL_MS / 1000)}s); slow-cycle warnings may be delayed`,
      );
    }
    if (workspaceSyncInitialDelayEffectiveMs >= WORKSPACE_SYNC_INTERVAL_MS) {
      console.warn(
        `[monitor] workspace sync: effective initial-delay (${Math.round(workspaceSyncInitialDelayEffectiveMs / 1000)}s) is >= interval (${Math.round(WORKSPACE_SYNC_INTERVAL_MS / 1000)}s); startup sync may not run before first periodic cycle`,
      );
    }
  }
}

console.log(`[monitor] task planner mode: ${plannerMode}`);
console.log(`[monitor] kanban backend: ${kanbanBackend}`);
if (config?.kanbanSource) {
  const src = config.kanbanSource;
  const sourceLabel = src.sourcePath
    ? `${src.source} (${src.sourcePath})`
    : src.source;
  console.log(
    `[monitor] kanban backend source: ${sourceLabel} (raw=${src.rawValue})`,
  );
}
console.log(`[monitor] executor mode: ${executorMode}`);
let primaryAgentName = primaryAgent;
let primaryAgentReady = primaryAgentEnabled;

try {
  setKanbanBackend(kanbanBackend);
} catch (err) {
  console.warn(
    `[monitor] failed to set initial kanban backend "${kanbanBackend}": ${err?.message || err}`,
  );
}

function getActiveKanbanBackend() {
  try {
    return String(getKanbanBackendName() || kanbanBackend || "internal")
      .trim()
      .toLowerCase();
  } catch {
    return String(kanbanBackend || "internal")
      .trim()
      .toLowerCase();
  }
}

function isVkBackendActive() {
  return getActiveKanbanBackend() === "vk";
}

function isVkRuntimeRequired() {
  const backend = getActiveKanbanBackend();
  const runtimeExecutorMode = getExecutorMode();
  return (
    backend === "vk" ||
    runtimeExecutorMode === "vk" ||
    runtimeExecutorMode === "hybrid"
  );
}

function isVkSpawnAllowed() {
  return vkSpawnEnabled && isVkRuntimeRequired();
}

// ── Workspace monitor: track agent workspaces with git state + stuck detection ──
const workspaceMonitor = new WorkspaceMonitor({
  cacheDir: resolve(repoRoot, ".cache", "workspace-logs"),
  repoRoot,
  onStuckDetected: ({ attemptId, reason, recommendation }) => {
    const msg = `:alert: Agent ${attemptId.substring(0, 8)} stuck: ${reason}\nRecommendation: ${recommendation}`;
    console.warn(`[workspace-monitor] ${msg}`);
    void notify?.(msg, { dedupKey: `stuck-${attemptId.substring(0, 8)}` });
  },
});

// ── Devmode Monitor-Monitor: long-running 24/7 reliability guardian ────────
function isTruthyFlag(value) {
  return ["1", "true", "yes", "on"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function isFalsyFlag(value) {
  return ["0", "false", "no", "off"].includes(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}

function isReviewAgentEnabled() {
  // When the workflow version is handling reviews, the legacy review agent
  // must be disabled to prevent duplicate reviews on the same PR.
  if (isWorkflowReplacingModule("review-agent.mjs")) return false;

  const explicit = process.env.INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED;
  if (explicit !== undefined && String(explicit).trim() !== "") {
    return !isFalsyFlag(explicit);
  }
  if (typeof internalExecutorConfig?.reviewAgentEnabled === "boolean") {
    return internalExecutorConfig.reviewAgentEnabled;
  }
  return true;
}

function isFlowPrimaryEnabled() {
  const explicit = process.env.BOSUN_FLOW_PRIMARY;
  if (explicit !== undefined && String(explicit).trim() !== "") {
    return !isFalsyFlag(explicit);
  }
  return !isFalsyFlag(flowPrimaryDefault);
}

function isFlowReviewGateEnabled() {
  const explicit = process.env.BOSUN_FLOW_REQUIRE_REVIEW;
  if (explicit !== undefined && String(explicit).trim() !== "") {
    return !isFalsyFlag(explicit);
  }
  return !isFalsyFlag(flowRequireReviewDefault);
}

function isMonitorMonitorEnabled() {
  if (process.env.VITEST) return false;
  if (!isDevMode()) return false;

  const explicit = process.env.DEVMODE_MONITOR_MONITOR_ENABLED;
  if (explicit !== undefined && String(explicit).trim() !== "") {
    return !isFalsyFlag(explicit);
  }
  const legacy = process.env.DEVMODE_AUTO_CODE_FIX;
  if (legacy !== undefined && String(legacy).trim() !== "") {
    return isTruthyFlag(legacy);
  }
  // Default ON in devmode unless explicitly disabled.
  return true;
}

function isSelfRestartWatcherEnabled() {
  const devMode = isDevMode();
  const force = process.env.SELF_RESTART_WATCH_FORCE;
  const forceEnabled = isTruthyFlag(force);
  const npmLifecycleEvent = String(process.env.npm_lifecycle_event || "")
    .trim()
    .toLowerCase();
  const launchedViaNpmStartScript =
    npmLifecycleEvent === "start" || npmLifecycleEvent.startsWith("start:");
  const explicit = process.env.SELF_RESTART_WATCH_ENABLED;
  if (explicit !== undefined && String(explicit).trim() !== "") {
    return !isFalsyFlag(explicit);
  }
  if (!devMode && !forceEnabled) {
    return false;
  }
  if (devMode && !forceEnabled && !launchedViaNpmStartScript) {
    // Plain `bosun` command launches from a source checkout should behave like
    // npm/prod installs by default: no self-restart watcher unless explicitly
    // enabled. Auto-updates still handle published package changes.
    return false;
  }
  if (
    String(executorMode || "")
      .trim()
      .toLowerCase() === "internal" ||
    String(executorMode || "")
      .trim()
      .toLowerCase() === "hybrid"
  ) {
    // Internal/hybrid mode continuously mutates source as tasks run.
    // Auto self-restart from file churn causes unnecessary restart storms.
    return false;
  }
  // Dev mode (source checkout / monorepo) → watch for code changes.
  // npm mode (installed via npm) → do NOT watch; source only changes via
  // npm update, which is handled by the auto-update loop instead.
  return devMode;
}

const MONITOR_MONITOR_DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MONITOR_MONITOR_RECOMMENDED_MIN_TIMEOUT_MS = 600_000;
const MONITOR_MONITOR_STARTUP_CYCLE_DELAY_MS = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_STARTUP_CYCLE_DELAY_MS,
  15_000,
  { min: 0, max: 5 * 60_000 },
);
const MONITOR_MONITOR_STARTUP_STATUS_DELAY_MS = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_STARTUP_STATUS_DELAY_MS,
  20_000,
  { min: 0, max: 5 * 60_000 },
);
const MONITOR_MONITOR_STARTUP_STATUS_AFTER_CYCLE_MIN_MS = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_STARTUP_STATUS_AFTER_CYCLE_MIN_MS,
  2_000,
  { min: 0, max: 30_000 },
);
const MONITOR_MONITOR_STARTUP_JITTER_MS = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_STARTUP_JITTER_MS,
  3_000,
  { min: 0, max: 60_000 },
);
const MONITOR_MONITOR_STARTUP_STATUS_MIN_GAP_MS = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_STARTUP_STATUS_MIN_GAP_MS,
  5 * 60_000,
  { min: 30_000, max: 30 * 60_000 },
);
const MONITOR_MONITOR_STARTUP_STATUS_GATE_PATH = resolve(
  repoRoot,
  ".bosun",
  ".cache",
  "monitor-monitor-startup-status-gate.json",
);
const MONITOR_MONITOR_STARTUP_STATUS_GATE_TMP_PATH =
  `${MONITOR_MONITOR_STARTUP_STATUS_GATE_PATH}.tmp`;
const MONITOR_MONITOR_STARTUP_STATUS_GATE_CORRUPT_PREFIX =
  `${basename(MONITOR_MONITOR_STARTUP_STATUS_GATE_PATH)}.corrupt-`;
const MONITOR_MONITOR_STARTUP_STATUS_GATE_CORRUPT_MAX_FILES = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_STARTUP_STATUS_GATE_CORRUPT_MAX_FILES,
  5,
  { min: 1, max: 50 },
);
const MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS,
  60_000,
  { min: 10_000, max: 10 * 60_000 },
);
const MONITOR_MONITOR_SKIP_STREAK_WARN_THRESHOLD = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_SKIP_STREAK_WARN_THRESHOLD,
  5,
  { min: 2, max: 200 },
);
const MONITOR_MONITOR_SKIP_STREAK_WARN_MIN_GAP_MS = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_SKIP_STREAK_WARN_MIN_GAP_MS,
  60_000,
  { min: 10_000, max: 30 * 60_000 },
);
const MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_WINDOW_MS = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_WINDOW_MS,
  15 * 60_000,
  { min: 60_000, max: 24 * 60 * 60_000 },
);
const MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_THRESHOLD = parseEnvInteger(
  process.env.DEVMODE_MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_THRESHOLD,
  3,
  { min: 2, max: 100 },
);
const monitorMonitorTimeoutWarningKeys = new Set();
const monitorMonitorStartupGateWarningKeys = new Set();

function warnStartupStatusGateIssueOnce(key, message) {
  if (!key || monitorMonitorStartupGateWarningKeys.has(key)) return;
  monitorMonitorStartupGateWarningKeys.add(key);
  console.warn(message);
}

function cleanupStartupStatusGateTempFile() {
  try {
    if (existsSync(MONITOR_MONITOR_STARTUP_STATUS_GATE_TMP_PATH)) {
      unlinkSync(MONITOR_MONITOR_STARTUP_STATUS_GATE_TMP_PATH);
    }
  } catch (err) {
    warnStartupStatusGateIssueOnce(
      "cleanup-temp",
      `[monitor-monitor] startup gate temp cleanup failed: ${err?.message || err}`,
    );
  }
}

function cleanupStartupStatusGateCorruptFiles() {
  try {
    const gateDir = dirname(MONITOR_MONITOR_STARTUP_STATUS_GATE_PATH);
    if (!existsSync(gateDir)) return;
    const candidates = readdirSync(gateDir)
      .filter((name) =>
        String(name || "").startsWith(MONITOR_MONITOR_STARTUP_STATUS_GATE_CORRUPT_PREFIX),
      )
      .sort((a, b) => {
        const ta = Number(
          String(a || "").slice(MONITOR_MONITOR_STARTUP_STATUS_GATE_CORRUPT_PREFIX.length),
        );
        const tb = Number(
          String(b || "").slice(MONITOR_MONITOR_STARTUP_STATUS_GATE_CORRUPT_PREFIX.length),
        );
        const na = Number.isFinite(ta) ? ta : 0;
        const nb = Number.isFinite(tb) ? tb : 0;
        return nb - na;
      });
    for (const name of candidates.slice(MONITOR_MONITOR_STARTUP_STATUS_GATE_CORRUPT_MAX_FILES)) {
      try {
        unlinkSync(resolve(gateDir, name));
      } catch (err) {
        warnStartupStatusGateIssueOnce(
          "cleanup-corrupt-entry",
          `[monitor-monitor] startup gate corrupt cleanup failed: ${err?.message || err}`,
        );
      }
    }
  } catch (err) {
    warnStartupStatusGateIssueOnce(
      "cleanup-corrupt-list",
      `[monitor-monitor] startup gate corrupt scan failed: ${err?.message || err}`,
    );
  }
}

function readStartupStatusGateTs() {
  try {
    cleanupStartupStatusGateTempFile();
    cleanupStartupStatusGateCorruptFiles();
    if (!existsSync(MONITOR_MONITOR_STARTUP_STATUS_GATE_PATH)) return 0;
    const raw = readFileSync(MONITOR_MONITOR_STARTUP_STATUS_GATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const ts = Number(parsed?.lastStartupStatusAt || 0);
    if (!Number.isFinite(ts) || ts <= 0) return 0;
    const now = Date.now();
    const maxFutureSkewMs = Math.max(
      60_000,
      MONITOR_MONITOR_STARTUP_STATUS_MIN_GAP_MS,
    );
    if (ts > now + maxFutureSkewMs) {
      throw new Error(`startup gate timestamp is too far in future: ${ts}`);
    }
    return ts;
  } catch (err) {
    try {
      if (existsSync(MONITOR_MONITOR_STARTUP_STATUS_GATE_PATH)) {
        renameSync(
          MONITOR_MONITOR_STARTUP_STATUS_GATE_PATH,
          `${MONITOR_MONITOR_STARTUP_STATUS_GATE_PATH}.corrupt-${Date.now()}`,
        );
      }
    } catch (quarantineErr) {
      warnStartupStatusGateIssueOnce(
        "read-quarantine",
        `[monitor-monitor] startup gate quarantine failed: ${quarantineErr?.message || quarantineErr}`,
      );
    }
    warnStartupStatusGateIssueOnce(
      "read-invalid",
      `[monitor-monitor] startup gate read failed; using fallback: ${err?.message || err}`,
    );
    return 0;
  }
}

function writeStartupStatusGateTs(tsMs) {
  try {
    cleanupStartupStatusGateTempFile();
    const ts = Number(tsMs || 0);
    if (!Number.isFinite(ts) || ts <= 0) return;
    mkdirSync(resolve(repoRoot, ".bosun", ".cache"), { recursive: true });
    writeFileSync(
      MONITOR_MONITOR_STARTUP_STATUS_GATE_TMP_PATH,
      `${JSON.stringify(
        {
          lastStartupStatusAt: ts,
          updatedAt: new Date(ts).toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    renameSync(
      MONITOR_MONITOR_STARTUP_STATUS_GATE_TMP_PATH,
      MONITOR_MONITOR_STARTUP_STATUS_GATE_PATH,
    );
  } catch (err) {
    try {
      if (existsSync(MONITOR_MONITOR_STARTUP_STATUS_GATE_TMP_PATH)) {
        unlinkSync(MONITOR_MONITOR_STARTUP_STATUS_GATE_TMP_PATH);
      }
    } catch (cleanupErr) {
      warnStartupStatusGateIssueOnce(
        "write-temp-cleanup",
        `[monitor-monitor] startup gate temp cleanup after write failed: ${cleanupErr?.message || cleanupErr}`,
      );
    }
    warnStartupStatusGateIssueOnce(
      "write-failed",
      `[monitor-monitor] startup gate write failed: ${err?.message || err}`,
    );
  }
}

function parsePositiveMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.trunc(parsed);
}

function warnMonitorTimeoutConfig(key, message) {
  if (!key || monitorMonitorTimeoutWarningKeys.has(key)) return;
  monitorMonitorTimeoutWarningKeys.add(key);
  console.warn(message);
}

function resolveMonitorMonitorTimeoutMs() {
  const explicitTimeoutRaw = process.env.DEVMODE_MONITOR_MONITOR_TIMEOUT_MS;
  const legacyTimeoutRaw = process.env.DEVMODE_AUTO_CODE_FIX_TIMEOUT_MS;
  const minTimeoutRaw = process.env.DEVMODE_MONITOR_MONITOR_TIMEOUT_MIN_MS;
  const maxTimeoutRaw = process.env.DEVMODE_MONITOR_MONITOR_TIMEOUT_MAX_MS;

  const explicitTimeout = parsePositiveMs(explicitTimeoutRaw);
  const legacyTimeout = parsePositiveMs(legacyTimeoutRaw);
  const minTimeout = parsePositiveMs(minTimeoutRaw);
  const maxTimeoutCandidate = parsePositiveMs(maxTimeoutRaw);

  let maxTimeout = maxTimeoutCandidate;
  if (minTimeout !== null && maxTimeout !== null && maxTimeout < minTimeout) {
    warnMonitorTimeoutConfig(
      `bounds:${minTimeout}:${maxTimeout}`,
      `[monitor] :alert:  Invalid monitor-monitor timeout bounds: DEVMODE_MONITOR_MONITOR_TIMEOUT_MAX_MS=${maxTimeout}ms is lower than DEVMODE_MONITOR_MONITOR_TIMEOUT_MIN_MS=${minTimeout}ms. Ignoring max bound.`,
    );
    maxTimeout = null;
  }

  const sourceTimeout =
    explicitTimeout ?? legacyTimeout ?? MONITOR_MONITOR_DEFAULT_TIMEOUT_MS;

  let timeoutMs = sourceTimeout;
  if (minTimeout !== null && timeoutMs < minTimeout) timeoutMs = minTimeout;
  if (maxTimeout !== null && timeoutMs > maxTimeout) timeoutMs = maxTimeout;

  if (legacyTimeoutRaw && !explicitTimeoutRaw && legacyTimeout !== null) {
    if (legacyTimeout < MONITOR_MONITOR_RECOMMENDED_MIN_TIMEOUT_MS) {
      warnMonitorTimeoutConfig(
        `legacy-low:${legacyTimeout}`,
        `[monitor] :alert:  DEVMODE_AUTO_CODE_FIX_TIMEOUT_MS=${legacyTimeout}ms is low for monitor-monitor (recommended >= ${MONITOR_MONITOR_RECOMMENDED_MIN_TIMEOUT_MS}ms). Set DEVMODE_MONITOR_MONITOR_TIMEOUT_MS to override explicitly.`,
      );
    }
  }

  if (timeoutMs !== sourceTimeout) {
    warnMonitorTimeoutConfig(
      `bounded:${sourceTimeout}:${timeoutMs}:${minTimeout ?? "off"}:${maxTimeout ?? "off"}`,
      `[monitor] monitor-monitor timeout adjusted ${sourceTimeout}ms -> ${timeoutMs}ms (min=${minTimeout ?? "off"}, max=${maxTimeout ?? "off"})`,
    );
  }

  if (timeoutMs < MONITOR_MONITOR_RECOMMENDED_MIN_TIMEOUT_MS) {
    warnMonitorTimeoutConfig(
      `effective-low:${timeoutMs}`,
      `[monitor] :alert:  monitor-monitor timeout is ${timeoutMs}ms. Values below ${MONITOR_MONITOR_RECOMMENDED_MIN_TIMEOUT_MS}ms can cause premature failover loops.`,
    );
  }

  return timeoutMs;
}

const monitorMonitor = {
  enabled: isMonitorMonitorEnabled(),
  intervalMs: Math.max(
    60_000,
    Number(
      process.env.DEVMODE_MONITOR_MONITOR_INTERVAL_MS ||
        process.env.DEVMODE_AUTO_CODE_FIX_CYCLE_INTERVAL ||
        "300000",
    ),
  ),
  timeoutMs: resolveMonitorMonitorTimeoutMs(),
  statusIntervalMs: Math.max(
    5 * 60_000,
    Number(process.env.DEVMODE_MONITOR_MONITOR_STATUS_INTERVAL_MS || "1800000"),
  ),
  running: false,
  timer: null,
  statusTimer: null,
  startupCycleTimer: null,
  startupStatusTimer: null,
  heartbeatAt: 0,
  lastAttemptAt: 0,
  lastAttemptTrigger: "startup",
  lastSkipAt: 0,
  lastSkipReason: "",
  skipStreak: 0,
  lastSkipStreakWarned: 0,
  lastSkipStreakWarnAt: 0,
  supervisorRestartCountWindow: 0,
  supervisorRestartLastWarnAt: 0,
  supervisorStartCountTotal: 0,
  supervisorLastStartedAt: 0,
  supervisorStartTimes: [],
  lastRunAt: 0,
  lastStatusAt: 0,
  lastStatusReason: "",
  lastStatusText: "",
  lastTrigger: "startup",
  lastOutcome: "not-started",
  lastError: "",
  lastDigestText: "",
  branch:
    process.env.DEVMODE_MONITOR_MONITOR_BRANCH ||
    process.env.DEVMODE_AUTO_CODE_FIX_BRANCH ||
    "",
  sdkOrder: [],
  sdkIndex: 0,
  consecutiveFailures: 0,
  sdkFailures: new Map(),
  abortController: null,
};
if (monitorMonitor.enabled) {
  console.log(
    `[monitor] monitor-monitor ENABLED (interval ${Math.round(monitorMonitor.intervalMs / 1000)}s, status ${Math.round(monitorMonitor.statusIntervalMs / 60_000)}m, timeout ${Math.round(monitorMonitor.timeoutMs / 1000)}s, watchdog+${Math.round(MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS / 1000)}s, skip-warn>=${MONITOR_MONITOR_SKIP_STREAK_WARN_THRESHOLD}, skip-warn-gap>=${Math.round(MONITOR_MONITOR_SKIP_STREAK_WARN_MIN_GAP_MS / 1000)}s)`,
  );
}

// ── Interactive shell state ────────────────────────────────────────────────
const shellState = {
  enabled: !!interactiveShellEnabled,
  active: false,
  rl: null,
  prompt: "",
  agentStreaming: false,
  agentStreamed: false,
  agentPrefixPrinted: false,
  abortController: null,
  queue: Promise.resolve(),
};
const shellIsTTY = process.stdin.isTTY && process.stdout.isTTY;
const shellAnsi = {
  cyan: (s) => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s) => (process.stdout.isTTY ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (process.stdout.isTTY ? `\x1b[33m${s}\x1b[0m` : s),
  dim: (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[22m` : s),
  red: (s) => (process.stdout.isTTY ? `\x1b[31m${s}\x1b[0m` : s),
};
const shellPromptText = shellAnsi.cyan("[agent]") + " > ";
const shellInfoPrefix = shellAnsi.dim("[shell]") + " ";
console.log(`[monitor] task planner mode: ${plannerMode}`);

function shellWriteRaw(chunk) {
  try {
    process.stdout.write(chunk);
  } catch {
    /* ignore write failures */
  }
}

function shellWriteLine(text) {
  shellWriteRaw(`${shellInfoPrefix}${text}\n`);
}

function startInteractiveShell() {
  if (!shellIsTTY || shellState.active) {
    return;
  }
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: shellPromptText,
    terminal: true,
  });
  shellState.rl = rl;
  shellState.active = true;
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (["exit", "quit"].includes(trimmed.toLowerCase())) {
      rl.close();
      return;
    }
    shellState.queue = shellState.queue
      .then(async () => {
        if (!primaryAgentReady) {
          shellWriteLine("Primary agent not ready.");
          return;
        }
        await execPrimaryPrompt(trimmed, { timeoutMs: 15 * 60 * 1000 });
      })
      .catch((err) => {
        shellWriteLine(`Error: ${err.message || err}`);
      })
      .finally(() => {
        rl.prompt();
      });
  });
  rl.on("close", () => {
    shellState.active = false;
    shellState.rl = null;
  });
  rl.prompt();
}
let codexDisabledReason = codexEnabled
  ? ""
  : isTruthyFlag(process.env.CODEX_SDK_DISABLED)
    ? "disabled via CODEX_SDK_DISABLED"
    : agentSdk?.primary && agentSdk.primary !== "codex"
      ? `disabled via agent_sdk.primary=${agentSdk.primary}`
      : "disabled via --no-codex";
setPrimaryAgent(primaryAgentName);
let preflightEnabled = configPreflightEnabled;
let preflightRetryMs = configPreflightRetryMs;
if (primaryAgentReady) {
  void initPrimaryAgent(primaryAgentName);
}

// Merge strategy: now handled by PR_MERGE_STRATEGY workflow template
const mergeStrategyMode = String(
  process.env.MERGE_STRATEGY_MODE || "smart",
).toLowerCase();
const flowPrimaryDefault = "true";
const flowRequireReviewDefault = "true";
const codexResolveConflictsEnabled =
  agentPoolEnabled &&
  (process.env.CODEX_RESOLVE_CONFLICTS || "true").toLowerCase() !== "false";
const conflictResolutionTimeoutMs = Number(
  process.env.MERGE_CONFLICT_RESOLUTION_TIMEOUT_MS || "600000",
);
// When telegram-bot.mjs is active it owns getUpdates — monitor must NOT poll
// to avoid HTTP 409 "Conflict: terminated by other getUpdates request".
let telegramPollLockHeld = false;
let preflightInProgress = false;
let preflightLastResult = null;
let preflightLastRunAt = 0;
let preflightRetryTimer = null;

let CodexClient = null;

let restartCount = 0;
let shuttingDown = false;
let currentChild = null;
let pendingRestart = false;
let skipNextAnalyze = false;
let skipNextRestartCount = false;

// Cached VK repo ID (lazy loaded on first PR/rebase call)
let cachedRepoId = null;
// Cached VK project ID (lazy loaded)
let cachedProjectId = null;
let watcher = null;
let watcherDebounce = null;
let watchFileName = null;
let envWatchers = [];
let envWatcherDebounce = null;

// ── Self-restart: exit code 75 signals cli.mjs to re-fork with fresh ESM cache
const SELF_RESTART_EXIT_CODE = 75;
const SELF_RESTART_QUIET_MS = Math.max(
  90_000,
  Number(process.env.SELF_RESTART_QUIET_MS || "90000"),
);
const SELF_RESTART_RETRY_MS = Math.max(
  15_000,
  Number(process.env.SELF_RESTART_RETRY_MS || "30000"),
);
const ALLOW_INTERNAL_RUNTIME_RESTARTS = isTruthyFlag(
  process.env.ALLOW_INTERNAL_RUNTIME_RESTARTS || "false",
);
const SELF_RESTART_DEFER_HARD_CAP = Math.max(
  1,
  Number(process.env.SELF_RESTART_DEFER_HARD_CAP || "6") || 6,
);
const SELF_RESTART_MAX_DEFER_MS = Math.max(
  60_000,
  Number(process.env.SELF_RESTART_MAX_DEFER_MS || "180000") || 180000,
);
const SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS = Math.max(
  60_000,
  Number(
    process.env.SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS ||
      String(SELF_RESTART_MAX_DEFER_MS),
  ) || SELF_RESTART_MAX_DEFER_MS,
);
let selfWatcher = null;
let selfWatcherLib = null;
let selfWatcherDebounce = null;
let selfRestartTimer = null;
let selfRestartLastChangeAt = 0;
let selfRestartLastFile = null;
let pendingSelfRestart = null; // filename that triggered a deferred restart
let selfRestartDeferCount = 0;
let selfRestartFirstDeferredAt = 0;
let deferredMonitorRestartTimer = null;
let pendingMonitorRestartReason = "";
let selfRestartWatcherEnabled = isSelfRestartWatcherEnabled();

function buildCodexSdkOptionsForMonitor() {
  const { env: resolvedEnv } = resolveCodexProfileRuntime(process.env);
  const baseUrl = resolvedEnv.OPENAI_BASE_URL || "";
  const isAzure = baseUrl.includes(".openai.azure.com");
  const env = { ...resolvedEnv };
  // For SDK compatibility, pass Azure endpoint via provider config instead of OPENAI_BASE_URL.
  delete env.OPENAI_BASE_URL;

  if (isAzure) {
    if (env.OPENAI_API_KEY && !env.AZURE_OPENAI_API_KEY) {
      env.AZURE_OPENAI_API_KEY = env.OPENAI_API_KEY;
    }
    const azureModel = env.CODEX_MODEL || undefined;
    return {
      env,
      config: {
        model_provider: "azure",
        model_providers: {
          azure: {
            name: "Azure OpenAI",
            base_url: baseUrl,
            env_key: "AZURE_OPENAI_API_KEY",
            wire_api: "responses",
          },
        },
        ...(azureModel ? { model: azureModel } : {}),
      },
    };
  }

  return { env };
}

// ── Self-restart marker: detect if this process was spawned by a code-change restart
const selfRestartMarkerPath = resolve(
  config.cacheDir || resolve(config.repoRoot, ".cache"),
  "ve-self-restart.marker",
);
let isSelfRestart = false;
try {
  if (existsSync(selfRestartMarkerPath)) {
    const ts = Number(
      (await import("node:fs")).readFileSync(selfRestartMarkerPath, "utf8"),
    );
    // Marker is valid if written within the last 30 seconds
    if (Date.now() - ts < 30_000) {
      isSelfRestart = true;
      console.log(
        "[monitor] detected self-restart marker — suppressing startup notifications",
      );
    }
    // Clean up marker regardless
    try {
      (await import("node:fs")).unlinkSync(selfRestartMarkerPath);
    } catch {
      /* best effort */
    }
  }
} catch {
  /* first start or missing file */
}

let telegramNotifierInterval = null;
let telegramNotifierTimeout = null;
let weeklyReportLastSentAt = null;
const monitorRestartReason = String(
  process.env.BOSUN_MONITOR_RESTART_REASON || "",
)
  .trim()
  .toLowerCase();

function getTelegramBotStartOptions() {
  const restartReason = isSelfRestart
    ? "self-restart"
    : monitorRestartReason;
  return {
    restartReason,
    suppressPortalAutoOpen: restartReason.length > 0,
  };
}
let vkRecoveryLastAt = 0;
let vkNonJsonNotifiedAt = 0;
let vkNonJsonContentTypeLoggedAt = 0;
let vkInvalidResponseLoggedAt = 0;
let vkErrorBurstStartedAt = 0;
let vkErrorBurstCount = 0;
let vkErrorSuppressedUntil = 0;
let vkErrorSuppressionReason = "";
let vkErrorSuppressionMs = 0;
const VK_ERROR_SUPPRESSION_DISABLED =
  isTruthyFlag(process.env.VITEST) ||
  String(process.env.NODE_ENV || "").toLowerCase() === "test";
const VK_ERROR_BURST_WINDOW_MS = 30_000;
const VK_ERROR_BURST_THRESHOLD = 3;
const VK_ERROR_SUPPRESSION_MS = 60_000;
const VK_ERROR_SUPPRESSION_MAX_MS = 5 * 60_000;
const VK_WARNING_THROTTLE_DISABLED = VK_ERROR_SUPPRESSION_DISABLED;
const VK_WARNING_THROTTLE_MS = 5 * 60_000;
const vkWarningLastAt = new Map();
let vibeKanbanProcess = null;
let vibeKanbanStartedAt = 0;

// ── VK WebSocket log stream — captures real-time agent logs from execution processes ──
let vkLogStream = null;

// ── VK Error Resolver — auto-resolves errors from VK logs ──
let vkErrorResolver = null;
let vkSessionDiscoveryTimer = null;
let vkSessionDiscoveryInFlight = false;
const vkSessionCache = new Map();

const VK_SESSION_KEEP_STATUSES = new Set([
  "running",
  "review",
  "manual_review",
  "in_review",
  "inreview",
]);

function normalizeAttemptStatus(status) {
  return String(status || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
}

function shouldKeepSessionForStatus(status) {
  return VK_SESSION_KEEP_STATUSES.has(normalizeAttemptStatus(status));
}

// ── Anomaly detector — plaintext pattern matching for death loops, stalls, etc. ──
let anomalyDetector = null;
const smartPrAllowRecreateClosed = isTruthyFlag(
  process.env.VE_SMARTPR_ALLOW_RECREATE_CLOSED,
);
const githubToken =
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  process.env.GITHUB_PAT ||
  process.env.GITHUB_PAT_TOKEN ||
  "";
let monitorFailureHandling = false;
const monitorFailureTimestamps = [];
const monitorFailureWindowMs = 10 * 60 * 1000;
const monitorRestartCooldownMs = 60 * 1000;
let lastMonitorRestartAt = 0;
const orchestratorRestartTimestamps = [];
const orchestratorRestartWindowMs = 5 * 60 * 1000;
const orchestratorRestartThreshold = 8;
const orchestratorPauseMs = 10 * 60 * 1000;
let orchestratorHaltedUntil = 0;
let orchestratorLoopFixInProgress = false;
let monitorSafeModeUntil = 0;
let orchestratorResumeTimer = null;

// ── Mutex / restart-loop prevention ─────────────────────────────────────────
// When the orchestrator exits because "Another orchestrator instance is already
// running" (mutex held), the monitor must NOT restart immediately — the old
// instance still has the mutex and a tight restart loop will form.
const restartController = new RestartController();

let logRemainder = "";
let lastErrorLine = "";
let lastErrorAt = 0;
const mergeNotified = new Set();
const pendingMerges = new Set();
const errorNotified = new Map();
const mergeFailureNotified = new Map();
const vkErrorNotified = new Map();
const telegramDedup = new Map();

// ── Deduplication tracking (utilities imported from utils.mjs) ───────────────

// ── Internal crash loop circuit breaker ──────────────────────────────────────
// Detects rapid failure bursts independently of Telegram dedup.
// When tripped, kills the orchestrator child and pauses everything.
const CIRCUIT_BREAKER_WINDOW_MS = 60_000; // 1 minute
const CIRCUIT_BREAKER_THRESHOLD = 5; // 5 failures in window = circuit trips
const CIRCUIT_BREAKER_PAUSE_MS = 5 * 60_000; // 5-minute hard pause
let circuitBreakerTripped = false;
let circuitBreakerResetAt = 0;
let circuitBreakerNotified = false;
const circuitBreakerTimestamps = [];

function recordCircuitBreakerEvent() {
  const now = Date.now();
  circuitBreakerTimestamps.push(now);
  // Prune events outside window
  while (
    circuitBreakerTimestamps.length &&
    now - circuitBreakerTimestamps[0] > CIRCUIT_BREAKER_WINDOW_MS
  ) {
    circuitBreakerTimestamps.shift();
  }
  return circuitBreakerTimestamps.length;
}

function isCircuitBreakerTripped() {
  const now = Date.now();
  // If paused, check if pause expired
  if (circuitBreakerTripped && now >= circuitBreakerResetAt) {
    circuitBreakerTripped = false;
    circuitBreakerNotified = false;
    circuitBreakerTimestamps.length = 0;
    console.warn("[monitor] circuit breaker reset — resuming normal operation");
    return false;
  }
  return circuitBreakerTripped;
}

function tripCircuitBreaker(failureCount) {
  if (circuitBreakerTripped) return; // already tripped
  circuitBreakerTripped = true;
  circuitBreakerResetAt = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
  const pauseMin = Math.round(CIRCUIT_BREAKER_PAUSE_MS / 60_000);
  console.error(
    `[monitor] :plug: CIRCUIT BREAKER TRIPPED: ${failureCount} failures in ${Math.round(CIRCUIT_BREAKER_WINDOW_MS / 1000)}s. ` +
      `Killing orchestrator and pausing all restarts for ${pauseMin} minutes.`,
  );

  // Kill the orchestrator child if running
  if (currentChild) {
    try {
      currentChild.kill("SIGTERM");
    } catch {
      /* best effort */
    }
  }

  // Block orchestrator restarts via safe mode
  monitorSafeModeUntil = circuitBreakerResetAt;

  // Send ONE summary Telegram message (if not already notified)
  if (!circuitBreakerNotified && telegramToken && telegramChatId) {
    circuitBreakerNotified = true;
    const msg =
      `:plug: Circuit breaker tripped: ${failureCount} failures in ${Math.round(CIRCUIT_BREAKER_WINDOW_MS / 1000)}s.\n` +
      `Orchestrator killed. All restarts paused for ${pauseMin} minutes.\n` +
      `Will auto-resume at ${new Date(circuitBreakerResetAt).toLocaleTimeString()}.`;
    // Fire-and-forget with skipDedup to ensure it gets through
    sendTelegramMessage(msg, { skipDedup: true }).catch(() => {});
  }
}

let allCompleteNotified = false;
let backlogLowNotified = false;
let idleAgentsNotified = false;
let plannerTriggered = false;
const monitorStateCacheDir = resolve(repoRoot, ".bosun", ".cache");
const plannerStatePath = resolve(
  monitorStateCacheDir,
  "task-planner-state.json",
);
const taskPlannerStatus = {
  enabled: isDevMode(),
  intervalMs: Math.max(
    5 * 60_000,
    Number(process.env.DEVMODE_TASK_PLANNER_STATUS_INTERVAL_MS || "1800000"),
  ),
  timer: null,
  lastStatusAt: 0,
};

// ── Telegram history ring buffer ────────────────────────────────────────────
// Stores the last N sent messages for context enrichment (fed to autofix prompts)
const TELEGRAM_HISTORY_MAX = 25;
const telegramHistory = [];
let telegramUpdateOffset = 0;
const telegramCommandQueue = [];
let telegramCommandActive = 0;
let telegramCommandPolling = false;

function pushTelegramHistory(text) {
  const stamp = new Date().toISOString().slice(11, 19);
  telegramHistory.push(`[${stamp}] ${text.slice(0, 300)}`);
  if (telegramHistory.length > TELEGRAM_HISTORY_MAX) {
    telegramHistory.shift();
  }
}

function recordMonitorFailure() {
  const now = Date.now();
  monitorFailureTimestamps.push(now);
  while (
    monitorFailureTimestamps.length &&
    now - monitorFailureTimestamps[0] > monitorFailureWindowMs
  ) {
    monitorFailureTimestamps.shift();
  }
  return monitorFailureTimestamps.length;
}

function shouldRestartMonitor() {
  const now = Date.now();
  if (now - lastMonitorRestartAt < monitorRestartCooldownMs) {
    return false;
  }
  return monitorFailureTimestamps.length >= 3;
}

function schedulePreflightRetry(waitMs) {
  if (preflightRetryTimer) return;
  const delay = Math.max(30000, waitMs || preflightRetryMs);
  preflightRetryTimer = setTimeout(() => {
    preflightRetryTimer = null;
    startProcess();
  }, delay);
}

async function ensurePreflightReady(reason) {
  if (!preflightEnabled) return true;
  if (preflightInProgress) return false;
  const now = Date.now();
  if (preflightLastResult && !preflightLastResult.ok) {
    const elapsed = now - preflightLastRunAt;
    if (elapsed < preflightRetryMs) {
      schedulePreflightRetry(preflightRetryMs - elapsed);
      return false;
    }
  }
  preflightInProgress = true;
  const result = runPreflightChecks({ repoRoot });
  preflightInProgress = false;
  preflightLastResult = result;
  preflightLastRunAt = Date.now();
  const report = formatPreflightReport(result, {
    retryMs: result.ok ? 0 : preflightRetryMs,
  });
  if (!result.ok) {
    console.error(report);
    console.warn(
      `[monitor] preflight failed (${reason || "startup"}); blocking orchestrator start.`,
    );
    schedulePreflightRetry(preflightRetryMs);
    return false;
  }
  console.log(report);
  return true;
}

function restartSelf(reason) {
  if (shuttingDown) return;
  const protection = getRuntimeRestartProtection();
  if (protection.defer) {
    const retrySec = Math.round(SELF_RESTART_RETRY_MS / 1000);
    pendingMonitorRestartReason = reason || pendingMonitorRestartReason || "";
    if (!deferredMonitorRestartTimer) {
      console.warn(
        `[monitor] deferring monitor restart (${reason || "unknown"}) — ${protection.reason}; retrying in ${retrySec}s`,
      );
      deferredMonitorRestartTimer = safeSetTimeout("deferred-monitor-restart", () => {
        deferredMonitorRestartTimer = null;
        const deferredReason = pendingMonitorRestartReason || "deferred";
        pendingMonitorRestartReason = "";
        restartSelf(deferredReason);
      }, SELF_RESTART_RETRY_MS);
    }
    return;
  }
  pendingMonitorRestartReason = "";
  if (deferredMonitorRestartTimer) {
    clearTimeout(deferredMonitorRestartTimer);
    deferredMonitorRestartTimer = null;
  }
  const now = Date.now();
  lastMonitorRestartAt = now;

  // ── Graceful restart: use exit code 75 so cli.mjs re-forks cleanly ──
  // Previously this spawned a detached orphan + exit(1), which:
  //   - Triggered the crash handler in cli.mjs ("Monitor crashed exit code 1")
  //   - Created an unmanaged orphan process instead of using cli's fork loop
  //   - Killed in-flight agents without draining
  // Now we do the same graceful shutdown as selfRestartForSourceChange().
  console.warn(`[monitor] graceful restart — ${reason || "unknown"}`);
  shuttingDown = true;
  if (vkLogStream) {
    vkLogStream.stop();
    vkLogStream = null;
  }
  if (prCleanupDaemon) {
    prCleanupDaemon.stop();
  }
  const shutdownPromises = [];
  if (agentEndpoint) {
    shutdownPromises.push(
      Promise.resolve(agentEndpoint.stop()).catch((e) =>
        console.warn(`[monitor] endpoint stop error: ${e.message}`),
      ),
    );
  }
  stopTaskPlannerStatusLoop();
  stopMonitorMonitorSupervisor({ preserveRunning: true });
  stopAutoUpdateLoop();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  stopSelfWatcher();
  stopWatcher();
  stopEnvWatchers();
  if (currentChild) {
    currentChild.kill("SIGTERM");
    setTimeout(() => {
      if (currentChild && !currentChild.killed) {
        currentChild.kill("SIGKILL");
      }
    }, 3000);
  }
  void releaseTelegramPollLock();
  stopTelegramBot({ preserveDigest: true });
  stopWhatsAppChannel();
  if (isContainerEnabled()) {
    void stopAllContainers().catch(() => {});
  }
  // Write self-restart marker so the new process suppresses startup notifications
  try {
    writeFileSync(
      resolve(repoRoot, ".cache", "ve-self-restart.marker"),
      String(Date.now()),
    );
  } catch {
    /* best effort */
  }
  // Wait for shutdown, then exit with code 75 — cli.mjs re-forks cleanly
  Promise.allSettled(shutdownPromises).then(() => {
    setTimeout(() => process.exit(SELF_RESTART_EXIT_CODE), 500);
  });
  // Safety net: exit after 10s even if shutdown hangs
  setTimeout(() => process.exit(SELF_RESTART_EXIT_CODE), 10000);
}

function recordOrchestratorRestart() {
  const now = Date.now();
  orchestratorRestartTimestamps.push(now);
  while (
    orchestratorRestartTimestamps.length &&
    now - orchestratorRestartTimestamps[0] > orchestratorRestartWindowMs
  ) {
    orchestratorRestartTimestamps.shift();
  }
  return orchestratorRestartTimestamps.length;
}

function shouldHaltOrchestrator() {
  const now = Date.now();
  if (now < orchestratorHaltedUntil) {
    return true;
  }
  return orchestratorRestartTimestamps.length >= orchestratorRestartThreshold;
}

function detectChangedFiles(repoRootPath) {
  try {
    const output = execSync("git diff --name-only", {
      cwd: repoRootPath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function getChangeSummary(repoRootPath, files) {
  if (!files.length) return "(no file changes detected)";
  try {
    const diff = execSync("git diff --stat", {
      cwd: repoRootPath,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return diff.trim() || files.join(", ");
  } catch {
    return files.join(", ");
  }
}

const monitorFixAttempts = new Map();
const monitorFixMaxAttempts = 2;
const monitorFixCooldownMs = 5 * 60 * 1000;

function canAttemptMonitorFix(signature) {
  const record = monitorFixAttempts.get(signature);
  if (!record) return true;
  if (record.count >= monitorFixMaxAttempts) return false;
  if (Date.now() - record.lastAt < monitorFixCooldownMs) return false;
  return true;
}

function recordMonitorFixAttempt(signature) {
  const record = monitorFixAttempts.get(signature) || { count: 0, lastAt: 0 };
  record.count += 1;
  record.lastAt = Date.now();
  monitorFixAttempts.set(signature, record);
  return record.count;
}

async function attemptMonitorFix({ error, logText }) {
  if (!autoFixEnabled) return { fixed: false, outcome: "autofix-disabled" };
  if (!codexEnabled) return { fixed: false, outcome: "codex-disabled" };

  const signature = error?.message || "monitor-crash";
  if (!canAttemptMonitorFix(signature)) {
    return { fixed: false, outcome: "monitor-fix-exhausted" };
  }

  const attemptNum = recordMonitorFixAttempt(signature);
  const fallbackPrompt = `You are debugging the ${projectName} bosun.

The monitor process hit an unexpected exception and needs a fix.
Please inspect and fix code in the bosun directory:
- monitor.mjs
- autofix.mjs
- maintenance.mjs

Crash info:
${error?.stack || error?.message || String(error)}

Recent log context:
${logText.slice(-4000)}

Instructions:
1) Identify the root cause of the crash in bosun.
2) Apply a minimal fix.
3) Do not refactor unrelated code.
4) Keep behavior stable and production-safe.`;
  const prompt = resolvePromptTemplate(
    agentPrompts?.monitorCrashFix,
    {
      PROJECT_NAME: projectName,
      CRASH_INFO: error?.stack || error?.message || String(error),
      LOG_TAIL: logText.slice(-4000),
    },
    fallbackPrompt,
  );

  const filesBefore = detectChangedFiles(repoRoot);
  const result = await runCodexExec(prompt, repoRoot);
  const filesAfter = detectChangedFiles(repoRoot);
  const newChanges = filesAfter.filter((f) => !filesBefore.includes(f));
  const changeSummary = getChangeSummary(repoRoot, newChanges);

  const stamp = nowStamp();
  const auditPath = resolve(
    logDir,
    `monitor-fix-${stamp}-attempt${attemptNum}.log`,
  );
  await writeFile(
    auditPath,
    [
      `# Monitor fix attempt #${attemptNum}`,
      `# Signature: ${signature}`,
      `# Timestamp: ${new Date().toISOString()}`,
      "",
      "## Prompt sent to Codex:",
      prompt,
      "",
      "## Codex result:",
      result.output || "(no output)",
      result.error ? `## Error: ${result.error}` : "",
      `## Files changed: ${newChanges.join(", ") || "none"}`,
      "",
      "## Diff summary:",
      changeSummary,
    ].join("\n"),
    "utf8",
  );

  if (result.success && newChanges.length > 0) {
    return { fixed: true, outcome: `changes: ${changeSummary}` };
  }

  return {
    fixed: false,
    outcome: result.error || "no changes written",
  };
}

// Hard cap: if we hit this many failures in the window, enter degraded mode.
const MONITOR_FAILURE_HARD_CAP = 30;
// Minimum interval between handleMonitorFailure executions (prevent Telegram spam).
const MONITOR_FAILURE_COOLDOWN_MS = 5000;
let lastMonitorFailureHandledAt = 0;

async function handleMonitorFailure(reason, err) {
  if (monitorFailureHandling) return;
  const now = Date.now();

  // ── Circuit breaker: if tripped, suppress ALL handling silently ──
  if (isCircuitBreakerTripped()) return;

  // Rate-limit: don't re-enter within cooldown
  if (now - lastMonitorFailureHandledAt < MONITOR_FAILURE_COOLDOWN_MS) return;
  monitorFailureHandling = true;
  lastMonitorFailureHandledAt = now;
  const failureCount = recordMonitorFailure();
  const message = err && err.message ? err.message : String(err || reason);

  // ── Circuit breaker: track rapid failure bursts ──
  const burstCount = recordCircuitBreakerEvent();
  if (burstCount >= CIRCUIT_BREAKER_THRESHOLD) {
    tripCircuitBreaker(burstCount);
    monitorFailureHandling = false;
    return; // circuit breaker sends its own summary message
  }

  // Hard cap: never kill monitor; degrade into safe mode and pause restarts.
  if (failureCount >= MONITOR_FAILURE_HARD_CAP) {
    const pauseMs = Math.max(orchestratorPauseMs, 30 * 60 * 1000);
    const pauseMin = Math.max(1, Math.round(pauseMs / 60_000));
    const msg =
      `:close: bosun hit hard failure cap (${failureCount}). ` +
      `Entering safe mode for ${pauseMin} minute(s); monitor process will stay alive.`;
    console.error(`[monitor] ${msg}`);
    if (telegramToken && telegramChatId) {
      try {
        await sendTelegramMessage(msg);
      } catch {
        /* best effort */
      }
    }
    monitorSafeModeUntil = Math.max(monitorSafeModeUntil, Date.now() + pauseMs);
    // Prevent immediate retrigger loops after entering hard-cap safe mode.
    monitorFailureTimestamps.length = 0;
    // Stop currently running child orchestrator while keeping monitor alive.
    if (currentChild) {
      try {
        currentChild.kill("SIGTERM");
      } catch {
        /* best effort */
      }
    }
    // Ensure we retry after safe-mode window if still running.
    if (!shuttingDown) {
      setTimeout(() => {
        if (!shuttingDown) void startProcess();
      }, pauseMs + 1000);
    }
    return;
  }

  try {
    await ensureLogDir();
    const crashPath = resolve(logDir, `monitor-crash-${nowStamp()}.log`);
    const payload = [
      `# Monitor crash: ${reason}`,
      `# Timestamp: ${new Date().toISOString()}`,
      "",
      "## Error:",
      err?.stack || message,
      "",
      "## Recent logs:",
      logRemainder.slice(-8000),
    ].join("\n");
    await writeFile(crashPath, payload, "utf8");

    if (telegramToken && telegramChatId) {
      try {
        const shortMsg = message.length > 200 ? message.slice(0, 200) + "…" : message;
        await sendTelegramMessage(
          `:alert: bosun exception (${reason}): ${shortMsg}\n\nAttempting recovery (count=${failureCount}).`,
        );
      } catch {
        /* suppress Telegram errors during failure handling */
      }
    }

    const fixResult = await attemptMonitorFix({
      error: err || new Error(reason),
      logText: logRemainder,
    });

    if (fixResult.fixed) {
      if (telegramToken && telegramChatId) {
        try {
          await sendTelegramMessage(
            `:u1f6e0: bosun auto-fix applied. Restarting monitor.\n${fixResult.outcome}`,
          );
        } catch {
          /* best effort */
        }
      }
      restartSelf("monitor-fix-applied");
      return;
    }

    if (shouldRestartMonitor()) {
      monitorSafeModeUntil = Date.now() + orchestratorPauseMs;
      const pauseMin = Math.round(orchestratorPauseMs / 60000);
      if (telegramToken && telegramChatId) {
        try {
          await sendTelegramMessage(
            `:close: bosun entering safe mode after repeated failures (${failureCount} in 10m). Pausing restarts for ${pauseMin} minutes.`,
          );
        } catch {
          /* best effort */
        }
      }
      return;
    }
  } catch (fatal) {
    // Use process.stderr to avoid EPIPE on stdout
    try {
      // Duplicate-start lock contention exits with code 0; emit on stdout to avoid error-tail noise.
    process.stdout.write(
        `[monitor] failure handler crashed: ${fatal.message || fatal}\n`,
      );
    } catch {
      /* completely give up */
    }
  } finally {
    monitorFailureHandling = false;
  }
}

function reportGuardedFailure(reason, err) {
  if (shuttingDown) return;
  const error = err instanceof Error ? err : new Error(formatMonitorError(err));
  console.error("[monitor] " + reason + " failed: " + (error.stack || error.message));
  handleMonitorFailure(reason, error).catch((failureErr) => {
    try {
      // Duplicate-start lock contention exits with code 0; emit on stdout to avoid error-tail noise.
    process.stdout.write(
        "[monitor] handleMonitorFailure failed: " + (failureErr?.message || failureErr) + "\n",
      );
    } catch {
      /* best effort */
    }
  });
}

function runGuarded(reason, fn) {
  if (shuttingDown) return;
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      result.catch((err) => reportGuardedFailure(reason, err));
    }
  } catch (err) {
    reportGuardedFailure(reason, err);
  }
}

function runDetached(label, promiseOrFn) {
  if (shuttingDown) return;
  try {
    const pending =
      typeof promiseOrFn === "function" ? promiseOrFn() : promiseOrFn;
    if (pending && typeof pending.then === "function") {
      pending.catch((err) => {
        const error = err instanceof Error ? err : new Error(formatMonitorError(err));
        console.warn(
          `[monitor] detached task failed (${label}): ${error.stack || error.message}`,
        );
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(formatMonitorError(err));
    console.warn(
      `[monitor] detached task failed (${label}): ${error.stack || error.message}`,
    );
  }
}

function safeSetInterval(reason, fn, ms) {
  const normalized = Number(ms);
  const clamped = Number.isFinite(normalized) && normalized > 0
    ? Math.min(normalized, 2_147_483_647)
    : 1;
  if (clamped !== normalized) {
    console.warn(
      `[monitor] timer delay clamped for interval:${reason} (${normalized}ms -> ${clamped}ms)`,
    );
  }
  return setInterval(() => runGuarded(`interval:${reason}`, fn), clamped);
}

function safeSetTimeout(reason, fn, ms) {
  const normalized = Number(ms);
  const clamped = Number.isFinite(normalized) && normalized > 0
    ? Math.min(normalized, 2_147_483_647)
    : 1;
  if (clamped !== normalized) {
    console.warn(
      `[monitor] timer delay clamped for timeout:${reason} (${normalized}ms -> ${clamped}ms)`,
    );
  }
  return setTimeout(() => runGuarded(`timeout:${reason}`, fn), clamped);
}

const crashLoopFixAttempts = new Map();
const crashLoopFixMaxAttempts = 2;
const crashLoopFixCooldownMs = 10 * 60 * 1000;

function canAttemptCrashLoopFix(signature) {
  const record = crashLoopFixAttempts.get(signature);
  if (!record) return true;
  if (record.count >= crashLoopFixMaxAttempts) return false;
  if (Date.now() - record.lastAt < crashLoopFixCooldownMs) return false;
  return true;
}

function recordCrashLoopFixAttempt(signature) {
  const record = crashLoopFixAttempts.get(signature) || { count: 0, lastAt: 0 };
  record.count += 1;
  record.lastAt = Date.now();
  crashLoopFixAttempts.set(signature, record);
  return record.count;
}

async function attemptCrashLoopFix({ reason, logText }) {
  if (!autoFixEnabled || !codexEnabled) {
    return { fixed: false, outcome: "codex-disabled" };
  }
  const signature = `crash-loop:${reason}`;
  if (!canAttemptCrashLoopFix(signature)) {
    return { fixed: false, outcome: "crash-loop-fix-exhausted" };
  }

  const attemptNum = recordCrashLoopFixAttempt(signature);
  const fallbackPrompt = `You are a reliability engineer debugging a crash loop in ${projectName} automation.

The orchestrator is restarting repeatedly within minutes.
Please diagnose the likely root cause and apply a minimal fix.

Targets (edit only if needed):
- ${scriptPath}
- bosun/monitor.mjs
- bosun/autofix.mjs
- bosun/maintenance.mjs

Recent log excerpt:
${logText.slice(-6000)}

Constraints:
1) Prevent rapid restart loops (introduce backoff or safe-mode).
2) Keep behavior stable and production-safe.
3) Do not refactor unrelated code.
4) Prefer small guardrails over big rewrites.`;
  const prompt = resolvePromptTemplate(
    agentPrompts?.monitorRestartLoopFix,
    {
      PROJECT_NAME: projectName,
      SCRIPT_PATH: scriptPath,
      LOG_TAIL: logText.slice(-6000),
    },
    fallbackPrompt,
  );

  const filesBefore = detectChangedFiles(repoRoot);
  const result = await runCodexExec(prompt, repoRoot, 1_800_000);
  const filesAfter = detectChangedFiles(repoRoot);
  const newChanges = filesAfter.filter((f) => !filesBefore.includes(f));
  const changeSummary = getChangeSummary(repoRoot, newChanges);

  const stamp = nowStamp();
  const auditPath = resolve(
    logDir,
    `crash-loop-fix-${stamp}-attempt${attemptNum}.log`,
  );
  await writeFile(
    auditPath,
    [
      `# Crash-loop fix attempt #${attemptNum}`,
      `# Signature: ${signature}`,
      `# Timestamp: ${new Date().toISOString()}`,
      "",
      "## Prompt sent to Codex:",
      prompt,
      "",
      "## Codex result:",
      result.output || "(no output)",
      result.error ? `## Error: ${result.error}` : "",
      `## Files changed: ${newChanges.join(", ") || "none"}`,
      "",
      "## Diff summary:",
      changeSummary,
    ].join("\n"),
    "utf8",
  );

  if (result.success && newChanges.length > 0) {
    return { fixed: true, outcome: `changes: ${changeSummary}` };
  }
  return { fixed: false, outcome: result.error || "no changes written" };
}

export function getTelegramHistory() {
  return [...telegramHistory];
}

// ── Repeating error detection (loop detector) ───────────────────────────────────
// Tracks fingerprints of error lines. When the same error appears
// LOOP_THRESHOLD times within LOOP_WINDOW_MS, triggers Codex autofix.
const LOOP_THRESHOLD = 4;
const LOOP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const LOOP_COOLDOWN_MS = 15 * 60 * 1000; // 15 min cooldown per fingerprint

/** @type {Map<string, {timestamps: number[], fixTriggeredAt: number}>} */
const errorFrequency = new Map();
let loopFixInProgress = false;

// Infrastructure error patterns that should NEVER trigger loop-fix autofix.
// These are transient git/rebase failures handled by persistent cooldowns.
const infraErrorPatterns = [
  /Direct rebase failed/i,
  /checkout failed/i,
  /rebase cooldown/i,
  /worktree.*has (rebase in progress|uncommitted changes)/i,
  /No worktree found/i,
  /VK rebase (failed|unavailable)/i,
  /git fetch failed in worktree/i,
  /Cannot rebase/i,
  /merge conflict.*not auto-resolvable/i,
];

function isInfraError(line) {
  return infraErrorPatterns.some((p) => p.test(line));
}

function trackErrorFrequency(line) {
  // Skip infrastructure errors — they have their own cooldown/retry logic
  if (isInfraError(line)) return;

  const fingerprint = getErrorFingerprint(line);
  if (!fingerprint) return;

  const now = Date.now();
  let record = errorFrequency.get(fingerprint);
  if (!record) {
    record = { timestamps: [], fixTriggeredAt: 0 };
    errorFrequency.set(fingerprint, record);
  }

  record.timestamps.push(now);
  // Trim old entries outside window
  record.timestamps = record.timestamps.filter((t) => now - t < LOOP_WINDOW_MS);

  // Check threshold
  if (
    record.timestamps.length >= LOOP_THRESHOLD &&
    now - record.fixTriggeredAt > LOOP_COOLDOWN_MS &&
    !loopFixInProgress
  ) {
    record.fixTriggeredAt = now;
    console.log(
      `[monitor] repeating error detected (${record.timestamps.length}x): ${fingerprint.slice(0, 80)}`,
    );
    triggerLoopFix(line, record.timestamps.length);
  }
}

function triggerLoopFix(errorLine, repeatCount) {
  if (!autoFixEnabled) return;
  loopFixInProgress = true;

  const telegramFn =
    telegramToken && telegramChatId
      ? (msg) => void sendTelegramMessage(msg)
      : null;

  // Fire-and-forget: never block the stdout pipeline
  void (async () => {
    try {
      const result = await fixLoopingError({
        errorLine,
        repeatCount,
        repoRoot,
        logDir,
        onTelegram: telegramFn,
        recentMessages: getTelegramHistory(),
        promptTemplate: agentPrompts?.autofixLoop,
      });

      if (result.fixed) {
        console.log(
          "[monitor] loop fix applied — file watcher will restart orchestrator",
        );
      } else {
        console.log(
          `[monitor] loop fix returned no changes: ${result.outcome || "no-fix"}`,
        );
      }
    } catch (err) {
      console.warn(`[monitor] loop fix error: ${err.message || err}`);
      if (telegramFn) {
        telegramFn(`:repeat: Loop fix crashed: ${err.message || err}`);
      }
    } finally {
      loopFixInProgress = false;
    }
  })();
}

const contextPatterns = [
  "ContextWindowExceeded",
  "context window",
  "ran out of room",
  "prompt token count",
  "token count of",
  "context length exceeded",
  "maximum context length",
  "exceeds the limit",
  "token limit",
  "too many tokens",
  "prompt too large",
  "failed to get response from the ai model",
  "capierror",
];

const errorPatterns = [
  /\bERROR\b/i,
  /Exception/i,
  /Traceback/i,
  /SetValueInvocationException/i,
  /Cannot bind argument/i,
  /Unhandled/i,
  /\bFailed to compile\b/i,
  /\bFailed to start\b/i,
  /\bFATAL\b/i,
  /Copilot assignment failed/i,
];

const errorNoisePatterns = [
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Status:/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Initial sync:/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+SyncCopilotState:/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+CI (pending|failing)/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+PR #\d+ .*CI=/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Merge failed for PR/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Merge failure reason:/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Retry merge failed for PR/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Auto-merge enable failed:/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Failed to initialize vibe-kanban configuration/i,
  /HTTP GET http:\/\/127\.0\.0\.1:54089\/api\/projects failed/i,
  // Stats summary line (contains "Failed" as a counter, not an error)
  /First-shot:.*Failed:/i,
  // Attempt lifecycle lines that include "failed" but are expected status updates
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Attempt [0-9a-f]{8} finished \(failed\)\s+—\s+marking review/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Attempt [0-9a-f]{8} failed in workspace — requires agent attention/i,
  // Agent work logger noise (handled separately, not a monitor crash)
  /^\s*\[agent-logger\]\s+Session ended:/i,
  /^\s*\[agent-logger\]\s+Error logged:/i,
  // Attempt lifecycle lines that include "failed" but are normal status updates
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Attempt [0-9a-f]{8} finished \(failed\)\s+—\s+marking review/i,
  /^\s*\[\d{2}:\d{2}:\d{2}\]\s+Attempt [0-9a-f]{8} failed in workspace — requires agent attention/i,
  // Box-drawing cycle summary lines
  /^\s*[│┃|]\s*(Elapsed|Submitted|Tracked|First-shot):/i,
  /^\s*[─┄╌═]+/,
  /^\s*[└┗╚][─┄╌═]+/,
  /^\s*[╔╗╚╝║═]+/,
  // "No remote branch" is handled by smartPR, not an error
  /No remote branch for .* — agent must push/i,
  // Telegram 409 conflicts (harmless, handled by auto-disable)
  /telegram getUpdates failed: 409/i,
  /getUpdates failed: 409/i,
  // ── Infrastructure failures: rebase/checkout/worktree issues ──
  // These are transient git infra failures, NOT code bugs.
  // The orchestrator handles them with cooldowns; do NOT trigger autofix.
  /Direct rebase failed:.*checkout failed/i,
  /Direct rebase failed:.*merge conflict/i,
  /Direct rebase failed:.*push failed/i,
  /Direct rebase failed:.*setting cooldown/i,
  /Direct merge-rebase (succeeded|failed)/i,
  /Branch .* is on rebase cooldown/i,
  /Worktree .* has (rebase in progress|uncommitted changes)/i,
  /No worktree found for .* — using VK API/i,
  /Cannot rebase: (working tree is dirty|git rebase already in progress)/i,
  /VK rebase (failed|requested|unavailable)/i,
  /git fetch failed in worktree/i,
  // ── Benign "error" mentions in summary/stats lines ──
  /errors?[=:]\s*0\b/i,
  /\b0\s+errors?\b/i,
  /\bno\s+errors?\b/i,
  /errors?\s*(count|total|sum|rate)\s*[=:]\s*0/i,
  /\bcomplete\b.*\berrors?[=:]\s*0/i,
  /\bsuccess\b.*\berrors?\b/i,
];

const vkErrorPatterns = [
  /Failed to initialize vibe-kanban configuration/i,
  /HTTP GET http:\/\/127\.0\.0\.1:54089\/api\/projects failed/i,
];

function notifyErrorLine(line) {
  if (!telegramToken || !telegramChatId) {
    return;
  }
  if (vkErrorPatterns.some((pattern) => pattern.test(line))) {
    // Only forward VK errors when VK backend is actually active.
    // Prevents stale stdout lines from triggering false Telegram alerts.
    if (isVkBackendActive()) {
      notifyVkError(line);
    }
    return;
  }

  // Track error frequency for loop detection (always, even if deduped for Telegram)
  trackErrorFrequency(line);

  const key = line.trim();
  if (!key) {
    return;
  }
  const now = Date.now();
  const last = errorNotified.get(key) || 0;
  if (now - last < 5 * 60 * 1000) {
    return;
  }
  errorNotified.set(key, now);
  queueErrorMessage(line.trim());
}

function notifyVkError(line) {
  // In GitHub/Jira/internal-only modes, VK outages are non-actionable noise.
  // Suppress alerts to avoid false-positive reliability digests.
  if (!isVkBackendActive()) {
    return;
  }
  // If the user explicitly disabled VK spawning they know VK isn't running —
  // spamming "unreachable" every 10 minutes is pure noise.
  if (!vkSpawnEnabled) {
    return;
  }
  const key = "vibe-kanban-unavailable";
  const now = Date.now();
  const last = vkErrorNotified.get(key) || 0;
  if (now - last < 10 * 60 * 1000) {
    return;
  }
  vkErrorNotified.set(key, now);
  const vkLink = formatHtmlLink(vkEndpointUrl, "VK_ENDPOINT_URL");
  const publicLink = vkPublicUrl
    ? formatHtmlLink(vkPublicUrl, "Public URL")
    : null;
  const message = [
    `${projectName} Orchestrator Warning`,
    "Vibe-Kanban API unreachable.",
    `Check ${vkLink} and ensure the service is running.`,
    publicLink ? `Open ${publicLink}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
  runDetached("vk-error:notify", () =>
    sendTelegramMessage(message, { parseMode: "HTML" }),
  );
  runDetached("vk-error:trigger-recovery", () => triggerVibeKanbanRecovery(line));
}

function notifyCodexTrigger(context) {
  if (!telegramToken || !telegramChatId) {
    return;
  }
  void sendTelegramMessage(`Codex triggered: ${context}`);
}

async function runCodexRecovery(reason) {
  if (!codexEnabled) {
    return null;
  }
  try {
    if (!CodexClient) {
      const ready = await ensureCodexSdkReady();
      if (!ready) {
        throw new Error(codexDisabledReason || "Codex SDK not available");
      }
    }
    const codex = new CodexClient(buildCodexSdkOptionsForMonitor());
    const thread = codex.startThread({ skipGitRepoCheck: true, workingDirectory: repoRoot, approvalPolicy: "never" });
    const prompt = `You are monitoring a Node.js orchestrator.
A local service (vibe-kanban) is unreachable.
Provide a short recovery plan and validate environment assumptions.
Reason: ${reason}`;
    const result = await thread.run(prompt);
    const outPath = resolve(logDir, `codex-recovery-${nowStamp()}.txt`);
    await writeFile(outPath, formatCodexResult(result), "utf8");
    return outPath;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const outPath = resolve(logDir, `codex-recovery-${nowStamp()}.txt`);
    await writeFile(outPath, `Codex recovery failed: ${message}\n`, "utf8");
    return null;
  }
}

let vkRestartCount = 0;
const vkMaxRestarts = 20;
const vkRestartDelayMs = 5000;

async function startVibeKanbanProcess() {
  if (!isVkSpawnAllowed()) {
    return;
  }
  if (vibeKanbanProcess && !vibeKanbanProcess.killed) {
    return;
  }

  // ── Guard: if the API is already reachable (e.g. detached from a previous
  // monitor instance), adopt it instead of spawning a new copy that will
  // crash with EADDRINUSE/exit-code-1.
  if (await isVibeKanbanOnline()) {
    console.log(
      `[monitor] vibe-kanban already online at ${vkEndpointUrl} — skipping spawn`,
    );
    vkRestartCount = 0;
    return;
  }

  // ── Kill any stale process holding the port ───────────────────────
  try {
    const isWindows = process.platform === "win32";
    let stalePid;
    const protectedPids = new Set([String(process.pid), String(process.ppid)]);

    if (isWindows) {
      const portCheck = execSync(
        `netstat -aon | findstr ":${vkRecoveryPort}.*LISTENING"`,
        { encoding: "utf8", timeout: 5000, stdio: "pipe" },
      ).trim();
      const pidMatch = portCheck.match(/(\d+)\s*$/);
      if (pidMatch && !protectedPids.has(pidMatch[1])) {
        stalePid = pidMatch[1];
      }
    } else if (commandExists("lsof")) {
      // Linux/macOS: use lsof when available
      const portCheck = execSync(`lsof -ti :${vkRecoveryPort}`, {
        encoding: "utf8",
        timeout: 5000,
        stdio: "pipe",
      }).trim();
      const pids = portCheck.split("\n").filter((p) => p.trim());
      // Filter out own process tree to avoid self-kill
      const safePids = pids.filter((p) => !protectedPids.has(p));
      if (safePids.length > 0) {
        stalePid = safePids[0];
      } else if (pids.length > 0) {
        console.log(
          `[monitor] port ${vkRecoveryPort} held by own process tree (PIDs: ${pids.join(", ")}) — skipping kill`,
        );
      }
    } else {
      console.warn(
        `[monitor] lsof not found on PATH; skipping stale PID scan for port ${vkRecoveryPort}`,
      );
    }

    if (stalePid) {
      console.log(
        `[monitor] sending SIGTERM to stale process ${stalePid} on port ${vkRecoveryPort}`,
      );
      try {
        if (isWindows) {
          const killRes = spawnSync(
            "taskkill",
            ["/F", "/PID", String(stalePid)],
            {
              encoding: "utf8",
              timeout: 5000,
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          if (killRes.status !== 0) {
            const detail = String(
              killRes.stderr ||
                killRes.stdout ||
                killRes.error?.message ||
                "taskkill failed",
            ).toLowerCase();
            if (
              !detail.includes("no running instance") &&
              !detail.includes("not found")
            ) {
              console.warn(
                `[monitor] failed to kill stale PID ${stalePid} on port ${vkRecoveryPort}: ${String(
                  killRes.stderr ||
                    killRes.stdout ||
                    killRes.error?.message ||
                    `exit ${killRes.status}`,
                ).slice(0, 200)}`,
              );
            }
          }
        } else {
          // Graceful SIGTERM first, then escalate if still alive
          execSync(`kill ${stalePid}`, {
            timeout: 5000,
            stdio: "pipe",
          });
        }
      } catch {
        /* best effort */
      }
      // Brief delay so the OS releases the port
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch {
    /* no process on port — fine */
  }

  const env = {
    ...process.env,
    PORT: vkRecoveryPort,
    HOST: vkRecoveryHost,
  };

  // Prefer locally-installed vibe-kanban binary (from npm dependency),
  // fall back to npx for global/remote installs.
  const vkBin = resolve(__dirname, "node_modules", ".bin", "vibe-kanban");
  const useLocal = existsSync(vkBin) || existsSync(vkBin + ".cmd");
  const spawnCmd = useLocal
    ? process.platform === "win32"
      ? vkBin + ".cmd"
      : vkBin
    : "npx";
  const spawnArgs = useLocal ? [] : ["--yes", "vibe-kanban"];

  console.log(
    `[monitor] starting vibe-kanban via ${useLocal ? "local bin" : "npx"} (HOST=${vkRecoveryHost} PORT=${vkRecoveryPort}, endpoint=${vkEndpointUrl})`,
  );

  // Use shell: true only when running through npx (string command).
  // When using the local binary directly, avoid shell to prevent DEP0190
  // deprecation warning ("Passing args to child process with shell true").
  const useShell = process.platform === "win32" || !useLocal;
  const spawnOptions = {
    env,
    cwd: repoRoot,
    stdio: "ignore",
    shell: useShell,
    detached: true,
  };
  if (useShell && spawnArgs.length > 0) {
    const shellQuote = (value) => {
      const str = String(value);
      if (!/\s/.test(str)) return str;
      const escaped = str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `"${escaped}"`;
    };
    const fullCommand = [spawnCmd, ...spawnArgs].map(shellQuote).join(" ");
    vibeKanbanProcess = spawn(fullCommand, spawnOptions);
  } else if (useShell) {
    vibeKanbanProcess = spawn(spawnCmd, spawnOptions);
  } else {
    vibeKanbanProcess = spawn(spawnCmd, spawnArgs, spawnOptions);
  }
  vibeKanbanProcess.unref();
  vibeKanbanStartedAt = Date.now();

  vibeKanbanProcess.on("error", (err) => {
    vibeKanbanProcess = null;
    vibeKanbanStartedAt = 0;
    const message = err && err.message ? err.message : String(err);
    console.warn(`[monitor] vibe-kanban spawn error: ${message}`);
    scheduleVibeKanbanRestart();
  });

  vibeKanbanProcess.on("exit", (code, signal) => {
    vibeKanbanProcess = null;
    vibeKanbanStartedAt = 0;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    console.warn(`[monitor] vibe-kanban exited (${reason})`);
    if (!shuttingDown) {
      scheduleVibeKanbanRestart();
    }
  });
}

function scheduleVibeKanbanRestart() {
  if (shuttingDown) return;
  if (!isVkSpawnAllowed()) return;
  vkRestartCount++;
  if (vkRestartCount > vkMaxRestarts) {
    console.error(
      `[monitor] vibe-kanban exceeded ${vkMaxRestarts} restarts, giving up`,
    );
    if (telegramToken && telegramChatId) {
      void sendTelegramMessage(
        `Vibe-kanban exceeded ${vkMaxRestarts} restart attempts. Manual intervention required.`,
      );
    }
    return;
  }
  const delay = Math.min(vkRestartDelayMs * vkRestartCount, 60000);
  console.log(
    `[monitor] restarting vibe-kanban in ${delay}ms (attempt ${vkRestartCount}/${vkMaxRestarts})`,
  );
  setTimeout(() => void startVibeKanbanProcess(), delay);
}

async function canConnectTcp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    const done = (ok) => {
      try {
        socket.destroy();
      } catch {
        /* best effort */
      }
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function isVibeKanbanOnline() {
  if (!isVkRuntimeRequired()) {
    return false;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetchWithFallback(`${vkEndpointUrl}/api/projects`, {
      signal: controller.signal,
    });
    // Any HTTP response means the service is up, even if auth/route fails.
    return true;
  } catch {
    return await canConnectTcp(vkRecoveryHost, vkRecoveryPort);
  } finally {
    clearTimeout(timeout);
  }
}

async function ensureVibeKanbanRunning() {
  if (!isVkRuntimeRequired()) {
    return;
  }
  if (!isVkSpawnAllowed()) {
    if (await isVibeKanbanOnline()) {
      ensureVkLogStream();
    }
    return;
  }
  if (await isVibeKanbanOnline()) {
    // Reset restart counter on successful health check
    vkRestartCount = 0;
    // Start VK log stream if not already running
    ensureVkLogStream();
    return;
  }
  // If process is alive, give it 15s grace to start up
  if (vibeKanbanProcess && !vibeKanbanProcess.killed) {
    const graceMs = 15000;
    if (vibeKanbanStartedAt && Date.now() - vibeKanbanStartedAt < graceMs) {
      return;
    }
    // Process alive but API not responding — kill and let auto-restart handle it
    console.warn(
      "[monitor] vibe-kanban process alive but API unresponsive, killing",
    );
    try {
      vibeKanbanProcess.kill();
    } catch {
      /* best effort */
    }
    return;
  }
  // No process running — start fresh
  await startVibeKanbanProcess();
}

function restartVibeKanbanProcess() {
  if (!isVkSpawnAllowed()) {
    return;
  }
  // Stop log stream — will restart when VK comes back online
  if (vkLogStream) {
    vkLogStream.stop();
    vkLogStream = null;
  }
  if (prCleanupDaemon) {
    prCleanupDaemon.stop();
  }
  // Just kill the process — the exit handler will auto-restart it
  if (vibeKanbanProcess && !vibeKanbanProcess.killed) {
    try {
      vibeKanbanProcess.kill();
    } catch {
      /* best effort */
    }
  } else {
    void startVibeKanbanProcess();
  }
}

function ensureAnomalyDetector() {
  if (anomalyDetector) return anomalyDetector;
  if (process.env.VITEST) return null;
  if (isWorkflowReplacingModule("anomaly-detector.mjs")) {
    console.log("[monitor] skipping legacy anomaly detector — handled by workflow");
    return null;
  }
  anomalyDetector = createAnomalyDetector({
    onAnomaly: wrapAnomalyCallback((anomaly) => {
      const icon =
        anomaly.severity === "CRITICAL"
          ? ":dot:"
          : anomaly.severity === "HIGH"
            ? ":u1f7e0:"
            : ":dot:";
      console.warn(
        `[anomaly-detector] ${icon} ${anomaly.severity} ${anomaly.type} [${anomaly.shortId}]: ${anomaly.message}`,
      );

      // Act on kill/restart actions — write signal file for the orchestrator
      // AND directly kill the VK process WebSocket to stop further resource
      // wastage immediately. The signal file ensures the orchestrator also
      // archives and retries the attempt on its next loop.
      if (anomaly.action === "kill" || anomaly.action === "restart") {
        console.warn(
          `[anomaly-detector] writing signal for action="${anomaly.action}" ${anomaly.type} on process ${anomaly.shortId}`,
        );
        writeAnomalySignal(anomaly);

        // Directly kill the VK log stream for this process so the agent
        // stops consuming compute immediately. Don't wait for the
        // orchestrator's next poll cycle.
        if (vkLogStream && anomaly.processId) {
          const killed = vkLogStream.killProcess(
            anomaly.processId,
            `anomaly: ${anomaly.type} (${anomaly.action})`,
          );
          if (killed) {
            console.warn(
              `[anomaly-detector] killed VK process stream ${anomaly.shortId} directly`,
            );
          }
        }
      }
    }),
    notify: (text, options) => {
      sendTelegramMessage(text, options).catch(() => {});
    },
  });
  if (workflowAutomationEngine?.services) {
    workflowAutomationEngine.services.anomalyDetector = anomalyDetector;
  }
  console.log("[monitor] anomaly detector started");
  return anomalyDetector;
}

function getAnomalyStatusReport() {
  if (!isVkRuntimeRequired()) {
    const backend = getActiveKanbanBackend();
    return `Anomaly detector inactive (VK runtime not required; backend=${backend}, executorMode=${executorMode}).`;
  }
  if (!anomalyDetector) {
    ensureAnomalyDetector();
  }
  return anomalyDetector
    ? anomalyDetector.getStatusReport()
    : "Anomaly detector not running.";
}

/**
 * Ensure the VK log stream is running. Creates a new VkLogStream instance
 * if one doesn't exist, connecting to VK's execution-process WebSocket
 * endpoints to capture real-time agent stdout/stderr.
 *
 * Two log outputs:
 *   1. Raw per-process logs → .cache/agent-logs/vk-exec-{shortId}.log
 *   2. Structured session logs → logs/vk-sessions/vk-session-{stamp}-{shortId}.log
 *      (mirrors codex-exec format with task metadata headers for autofix analysis)
 *
 * Discovery model: No REST list endpoint exists for execution processes.
 * Instead, connectToSession(sessionId) is called when sessions are created
 * (see startFreshSession). On startup, we also scan active_attempts for any
 * existing session IDs to connect to.
 */
function ensureVkLogStream() {
  if (!isVkRuntimeRequired()) return;
  if (vkLogStream) return;
  console.log("[monitor] ensureVkLogStream: creating VkLogStream instance");

  // Keep the detector running even when VK stream is reconnecting.
  ensureAnomalyDetector();

  const agentLogDir = resolve(repoRoot, ".cache", "agent-logs");
  const sessionLogDir = resolve(__dirname, "logs", "vk-sessions");
  vkLogStream = new VkLogStream(vkEndpointUrl, {
    logDir: agentLogDir,
    sessionLogDir,
    // Always keep VK log streaming silent in the CLI.
    echo: false,
    filterLine: (line) => {
      // Drop verbose VK/Codex event chatter and token streams.
      if (!line) return false;
      if (line.length > 6000) return false;
      if (line.startsWith('{"method":"codex/event/')) return false;
      if (line.startsWith('{"method":"item/')) return false;
      if (line.startsWith('{"method":"thread/')) return false;
      if (line.startsWith('{"method":"account/')) return false;
      if (line.includes('"type":"reasoning_content_delta"')) return false;
      if (line.includes('"type":"agent_reasoning_delta"')) return false;
      if (line.includes('"type":"token_count"')) return false;
      if (line.includes('"type":"item_started"')) return false;
      if (line.includes('"type":"item_completed"')) return false;
      if (line.includes('"type":"exec_command_begin"')) return false;
      if (line.includes('"type":"exec_command_output_delta"')) return false;
      if (line.includes('"type":"exec_command_end"')) return false;
      if (line.includes('"method":"codex/event/reasoning_content_delta"'))
        return false;
      if (line.includes('"method":"codex/event/agent_reasoning_delta"'))
        return false;
      if (line.includes('"method":"codex/event/token_count"')) return false;
      if (line.includes('"method":"codex/event/item_started"')) return false;
      if (line.includes('"method":"codex/event/item_completed"')) return false;
      if (line.includes('"method":"codex/event/exec_command_')) return false;
      if (line.includes('"method":"item/reasoning/summaryTextDelta"'))
        return false;
      if (line.includes('"method":"item/commandExecution/outputDelta"'))
        return false;
      if (line.includes('"method":"codex/event/agent_reasoning"')) return false;
      return true;
    },
    onLine: (line, meta) => {
      // Feed every agent log line to the anomaly detector for real-time
      // pattern matching (death loops, token overflow, stalls, etc.).
      if (anomalyDetector) {
        try {
          anomalyDetector.processLine(line, meta);
        } catch {
          /* detector error — non-fatal */
        }
      }

      // Feed log lines to VK error resolver for auto-resolution
      if (vkErrorResolver) {
        try {
          void vkErrorResolver.handleLogLine(line);
        } catch (err) {
          console.error(`[monitor] vkErrorResolver error: ${err.message}`);
        }
      }
    },
    onProcessConnected: (processId, meta) => {
      // When a new execution process is discovered via the session stream,
      // look up task metadata from status data and enrich the process
      void (async () => {
        try {
          const statusData = await readStatusData();
          const attempts = statusData?.attempts || {};
          // Find the attempt that matches this session
          // VK processes belong to sessions which belong to workspaces (= attempts)
          for (const [attemptId, info] of Object.entries(attempts)) {
            if (!info) continue;
            // Match by session_id if available, or if the process was connected
            // for a session belonging to this attempt
            if (
              meta.sessionId &&
              (info.session_id === meta.sessionId ||
                attemptId === meta.sessionId)
            ) {
              vkLogStream.setProcessMeta(processId, {
                attemptId,
                taskId: info.task_id,
                taskTitle: info.task_title || info.name,
                branch: info.branch,
                sessionId: meta.sessionId,
                executor: info.executor,
                executorVariant: info.executor_variant,
              });
              break;
            }
          }
        } catch {
          /* best effort */
        }
      })();
    },
  });
  vkLogStream.start();

  // Initialize VK error resolver
  const vkAutoResolveEnabled = config.vkAutoResolveErrors ?? true;
  if (vkAutoResolveEnabled) {
    console.log("[monitor] initializing VK error resolver...");
    vkErrorResolver = new VKErrorResolver(repoRoot, vkEndpointUrl, {
      enabled: true,
      onResolve: (resolution) => {
        console.log(
          `[monitor] VK auto-resolution: ${resolution.errorType} - ${resolution.result.success ? "✓ success" : "✗ failed"}`,
        );

        // Notify via Telegram
        const emoji = resolution.result.success ? ":bot:" : ":alert:";
        const status = resolution.result.success ? "resolved" : "failed";
        const branch =
          resolution.context.branch || `PR #${resolution.context.prNumber}`;
        notify(`${emoji} Auto-${status} ${resolution.errorType} on ${branch}`);
      },
    });
    console.log("[monitor] VK error resolver initialized");
  }

  // Discover any active sessions immediately and keep polling for new sessions
  void refreshVkSessionStreams("startup");
  ensureVkSessionDiscoveryLoop();
}

function ensureVkSessionDiscoveryLoop() {
  if (vkSessionDiscoveryTimer) return;
  if (!Number.isFinite(vkEnsureIntervalMs) || vkEnsureIntervalMs <= 0) return;
  vkSessionDiscoveryTimer = setInterval(() => {
    void refreshVkSessionStreams("periodic");
  }, vkEnsureIntervalMs);
}

async function refreshVkSessionStreams(reason = "manual") {
  if (!vkLogStream) {
    console.log(`[monitor] refreshVkSessionStreams(${reason}): no vkLogStream`);
    return;
  }
  if (vkSessionDiscoveryInFlight) return;
  vkSessionDiscoveryInFlight = true;

  try {
    // ── 1. Collect attempts from orchestrator status file ──────────────
    const statusData = await readStatusData();
    const statusAttempts = statusData?.attempts || {};
    const statusDataAvailable = !!statusData;

    // ── 2. Also query VK directly for all non-archived attempts ────────
    //    The status file can be stale/incomplete (e.g. after restarts or
    //    when attempts were submitted in previous orchestrator cycles).
    let vkAttempts = [];
    let vkAttemptsAvailable = false;
    try {
      const vkRes = await fetchVk("/api/task-attempts?archived=false");
      if (vkRes?.success && Array.isArray(vkRes.data)) {
        vkAttempts = vkRes.data;
        vkAttemptsAvailable = true;
      }
    } catch (err) {
      console.warn(
        `[monitor] refreshVkSessionStreams: VK attempt fetch failed: ${err.message}`,
      );
    }

    const allowedAttemptIds = new Set();
    const allowedSessions = new Set();

    // ── 3. Merge: build unified map of attemptId → metadata ───────────
    /** @type {Map<string, {task_id?:string, task_title?:string, branch?:string, session_id?:string, executor?:string, executor_variant?:string}>} */
    const mergedAttempts = new Map();

    // Status file attempts (mark running + review states)
    for (const [attemptId, info] of Object.entries(statusAttempts)) {
      if (!attemptId || !info) continue;
      if (!shouldKeepSessionForStatus(info.status)) continue;
      allowedAttemptIds.add(attemptId);
      if (info.session_id) {
        allowedSessions.add(info.session_id);
      }
      mergedAttempts.set(attemptId, {
        task_id: info.task_id,
        task_title: info.task_title || info.name,
        branch: info.branch,
        session_id: info.session_id,
        executor: info.executor,
        executor_variant: info.executor_variant,
        source: "status",
      });
    }

    // VK API attempts (add any not already present from status file)
    for (const vkAttempt of vkAttempts) {
      if (!vkAttempt?.id) continue;
      if (mergedAttempts.has(vkAttempt.id)) continue; // status file takes precedence
      const vkStatus = vkAttempt.status ?? vkAttempt.state ?? "";
      if (vkStatus && !shouldKeepSessionForStatus(vkStatus)) {
        continue;
      }
      allowedAttemptIds.add(vkAttempt.id);
      mergedAttempts.set(vkAttempt.id, {
        task_id: vkAttempt.task_id,
        task_title: vkAttempt.name,
        branch: vkAttempt.branch,
        session_id: null,
        executor: null,
        executor_variant: null,
        source: "vk-api",
      });
    }

    console.log(
      `[monitor] refreshVkSessionStreams(${reason}): ${mergedAttempts.size} attempts ` +
        `(${Object.values(statusAttempts).filter((i) => i?.status === "running").length} status + ` +
        `${vkAttempts.length} vk-api, merged)`,
    );

    // Keep cached sessions for allowed attempts
    for (const attemptId of allowedAttemptIds) {
      const cachedSession = vkSessionCache.get(attemptId);
      if (cachedSession) {
        allowedSessions.add(cachedSession);
      }
    }

    // ── 4. Discover sessions and connect ──────────────────────────────
    for (const [attemptId, info] of mergedAttempts) {
      let sessionId = info.session_id || vkSessionCache.get(attemptId) || null;

      if (!sessionId) {
        sessionId = await fetchLatestVkSessionId(attemptId);
        if (sessionId) {
          vkSessionCache.set(attemptId, sessionId);
          console.log(
            `[monitor] refreshVkSessionStreams: discovered session ${sessionId.slice(0, 8)} for attempt ${attemptId.slice(0, 8)} (${info.source})`,
          );
        }
      }

      if (!sessionId) continue; // no session yet — will retry next cycle

      allowedSessions.add(sessionId);
      vkLogStream.setProcessMeta(attemptId, {
        attemptId,
        taskId: info.task_id,
        taskTitle: info.task_title,
        branch: info.branch,
        sessionId,
        executor: info.executor,
        executorVariant: info.executor_variant,
      });
      vkLogStream.connectToSession(sessionId);
    }

    if (statusDataAvailable || vkAttemptsAvailable) {
      for (const attemptId of Array.from(vkSessionCache.keys())) {
        if (!allowedAttemptIds.has(attemptId)) {
          vkSessionCache.delete(attemptId);
        }
      }
      if (vkLogStream?.pruneSessions) {
        const pruned = vkLogStream.pruneSessions(
          allowedSessions,
          "session no longer active",
        );
        if (pruned > 0) {
          console.log(
            `[monitor] refreshVkSessionStreams(${reason}): pruned ${pruned} stale session streams`,
          );
        }
      }
    }
  } catch (err) {
    console.warn(
      `[monitor] VK session discovery (${reason}) failed: ${err.message || err}`,
    );
  } finally {
    vkSessionDiscoveryInFlight = false;
  }
}

async function fetchLatestVkSessionId(workspaceId) {
  const res = await fetchVk(
    `/api/sessions?workspace_id=${encodeURIComponent(workspaceId)}`,
  );
  if (!res?.success || !Array.isArray(res.data)) return null;
  const sessions = res.data;
  if (!sessions.length) return null;
  const ordered = sessions.slice().sort((a, b) => {
    const aTs = Date.parse(a?.updated_at || a?.created_at || 0) || 0;
    const bTs = Date.parse(b?.updated_at || b?.created_at || 0) || 0;
    return bTs - aTs;
  });
  return ordered[0]?.id || null;
}

async function triggerVibeKanbanRecovery(reason) {
  if (!isVkSpawnAllowed()) {
    return;
  }
  const now = Date.now();
  const cooldownMs = vkRecoveryCooldownMin * 60 * 1000;
  if (now - vkRecoveryLastAt < cooldownMs) {
    return;
  }
  vkRecoveryLastAt = now;

  if (telegramToken && telegramChatId) {
    const link = formatHtmlLink(vkEndpointUrl, "VK_ENDPOINT_URL");
    const notice = codexEnabled
      ? `Codex recovery triggered: vibe-kanban unreachable. Attempting restart. (${link})`
      : `Vibe-kanban recovery triggered (Codex disabled). Attempting restart. (${link})`;
    void sendTelegramMessage(notice, { parseMode: "HTML" });
  }
  await runCodexRecovery(reason || "vibe-kanban unreachable");
  restartVibeKanbanProcess();
}

// ── VK API client ───────────────────────────────────────────────────────────

/**
 * Generic HTTP client for the Vibe-Kanban REST API.
 * @param {string} path  - API path (e.g. "/api/projects")
 * @param {object} [opts] - { method, body, timeoutMs }
 * @returns {Promise<object|null>} Parsed JSON body, or null on failure.
 */
function resetVkErrorBurst() {
  vkErrorBurstStartedAt = 0;
  vkErrorBurstCount = 0;
  vkErrorSuppressedUntil = 0;
  vkErrorSuppressionReason = "";
  vkErrorSuppressionMs = VK_ERROR_SUPPRESSION_MS;
}

function noteVkErrorBurst(reason) {
  if (VK_ERROR_SUPPRESSION_DISABLED) return;
  const now = Date.now();
  if (
    !vkErrorBurstStartedAt ||
    now - vkErrorBurstStartedAt > VK_ERROR_BURST_WINDOW_MS
  ) {
    vkErrorBurstStartedAt = now;
    vkErrorBurstCount = 0;
  }
  vkErrorBurstCount += 1;
  if (vkErrorBurstCount >= VK_ERROR_BURST_THRESHOLD) {
    if (!vkErrorSuppressionMs) {
      vkErrorSuppressionMs = VK_ERROR_SUPPRESSION_MS;
    }
    vkErrorSuppressedUntil = now + vkErrorSuppressionMs;
    vkErrorSuppressionReason = reason || "vk-unavailable";
    vkErrorBurstCount = 0;
    vkErrorBurstStartedAt = now;
    console.warn(
      `[monitor] fetchVk suppressing VK requests for ${Math.round(
        vkErrorSuppressionMs / 1000,
      )}s (reason: ${vkErrorSuppressionReason})`,
    );
    vkErrorSuppressionMs = Math.min(
      (vkErrorSuppressionMs || VK_ERROR_SUPPRESSION_MS) * 2,
      VK_ERROR_SUPPRESSION_MAX_MS,
    );
  }
}

function shouldSuppressVkRequest(method) {
  if (VK_ERROR_SUPPRESSION_DISABLED) return false;
  const now = Date.now();
  if (vkErrorSuppressedUntil && now < vkErrorSuppressedUntil) {
    // Allow non-GET methods to attempt recovery actions.
    return method === "GET";
  }
  return false;
}

function shouldLogVkWarning(key, intervalMs = VK_WARNING_THROTTLE_MS) {
  if (VK_WARNING_THROTTLE_DISABLED) return true;
  const now = Date.now();
  const last = vkWarningLastAt.get(key) || 0;
  if (now - last < intervalMs) {
    return false;
  }
  vkWarningLastAt.set(key, now);
  return true;
}

async function fetchVk(path, opts = {}) {
  // Guard: if VK backend is not active, return null immediately instead of
  // attempting to connect. This prevents "fetch failed" spam when using
  // GitHub/Jira backends.
  const backend = getActiveKanbanBackend();
  if (backend !== "vk") {
    // Silent return for non-VK backends to avoid polluting logs
    return null;
  }

  const url = `${vkEndpointUrl}${path.startsWith("/") ? path : "/" + path}`;
  const method = (opts.method || "GET").toUpperCase();
  if (shouldSuppressVkRequest(method)) {
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs || 15000);

  let res;
  try {
    const fetchOpts = {
      method,
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
    };
    if (opts.body && method !== "GET") {
      fetchOpts.body = JSON.stringify(opts.body);
    }
    res = await fetchWithFallback(url, fetchOpts);
  } catch (err) {
    // Network error, timeout, abort, etc. - res is undefined
    const msg = err?.message || String(err);
    if (!msg.includes("abort")) {
      if (shouldLogVkWarning("network-error")) {
        console.warn(`[monitor] fetchVk ${method} ${path} error: ${msg}`);
      }
      runDetached("fetchVk:network-recovery", () =>
        triggerVibeKanbanRecovery(
          `fetchVk ${method} ${path} network error: ${msg}`,
        ),
      );
      noteVkErrorBurst("network-error");
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }

  // Safety: validate response object (guards against mock/test issues)
  if (!res || typeof res.ok === "undefined") {
    const now = Date.now();
    if (now - vkInvalidResponseLoggedAt > VK_WARNING_THROTTLE_MS) {
      vkInvalidResponseLoggedAt = now;
      console.warn(
        `[monitor] fetchVk ${method} ${path} error: invalid response object (res=${!!res}, res.ok=${res?.ok})`,
      );
    }
    runDetached("fetchVk:invalid-response-recovery", () =>
      triggerVibeKanbanRecovery(
        `fetchVk ${method} ${path} invalid response object`,
      ),
    );
    noteVkErrorBurst("invalid-response");
    return null;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (shouldLogVkWarning(`http-${res.status}`)) {
      console.warn(
        `[monitor] fetchVk ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`,
      );
    }
    if (res.status >= 500) {
      runDetached("fetchVk:http-5xx-recovery", () =>
        triggerVibeKanbanRecovery(
          `fetchVk ${method} ${path} HTTP ${res.status}`,
        ),
      );
      noteVkErrorBurst("http-5xx");
    }
    return null;
  }

  const contentTypeRaw =
    typeof res.headers?.get === "function"
      ? res.headers.get("content-type") || res.headers.get("Content-Type")
      : res.headers?.["content-type"] || res.headers?.["Content-Type"] || "";
  const contentType = String(contentTypeRaw || "").toLowerCase();
  if (!contentType.includes("application/json")) {
    const text = await (typeof res.text === "function"
      ? res.text().catch(() => "")
      : "");
    if (text) {
      try {
        const parsed = JSON.parse(text);
        resetVkErrorBurst();
        return parsed;
      } catch {
        // Fall through to non-JSON handling below.
      }
    }
    const now = Date.now();
    const shouldLogDetails = shouldLogVkWarning("non-json");
    if (shouldLogDetails) {
      vkNonJsonContentTypeLoggedAt = now;
      console.warn(
        `[monitor] fetchVk ${method} ${path} error: non-JSON response (${contentType || "unknown"})`,
      );
      if (text) {
        console.warn(
          `[monitor] fetchVk ${method} ${path} body: ${text.slice(0, 200)}`,
        );
      }
    }
    runDetached("fetchVk:non-json-recovery", () =>
      triggerVibeKanbanRecovery(
        `fetchVk ${method} ${path} non-JSON response`,
      ),
    );
    noteVkErrorBurst("non-json");
    if (now - vkNonJsonNotifiedAt > 10 * 60 * 1000) {
      vkNonJsonNotifiedAt = now;
      notifyVkError(
        "Vibe-Kanban API returned HTML/non-JSON. Check VK_BASE_URL/VK_ENDPOINT_URL.",
      );
    }
    return null;
  }

  try {
    const parsed = await res.json();
    resetVkErrorBurst();
    return parsed;
  } catch (err) {
    if (shouldLogVkWarning("invalid-json")) {
      console.warn(
        `[monitor] fetchVk ${method} ${path} error: Invalid JSON - ${err.message}`,
      );
    }
    noteVkErrorBurst("invalid-json");
    return null;
  }
}

/**
 * GET /api/task-attempts/:id/branch-status
 * Returns branch status data for an attempt (commits ahead/behind, conflicts, etc.)
 */
async function fetchBranchStatus(attemptId) {
  const res = await fetchVk(`/api/task-attempts/${attemptId}/branch-status`);
  if (!res?.success || !Array.isArray(res.data)) return null;
  return res.data[0] || null;
}

async function getAttemptInfo(attemptId) {
  try {
    const statusData = await readStatusData();
    const attempts = statusData?.active_attempts || [];
    const match = attempts.find((a) => a.id === attemptId);
    if (match) return match;
  } catch {
    /* best effort */
  }
  const res = await fetchVk(`/api/task-attempts/${attemptId}`);
  if (res?.success && res.data) {
    return res.data;
  }
  return null;
}

function ghAvailable() {
  const res = spawnSync("gh", ["--version"], { stdio: "ignore" });
  return res.status === 0;
}

/**
 * Find the worktree path for a given branch.
 * Delegates to the centralized WorktreeManager; falls back to direct git parsing
 * for branches not tracked in the registry.
 */
function findWorktreeForBranch(branch) {
  if (!branch) return null;
  // Try centralized manager first (has registry + git porcelain search)
  try {
    const managed = findManagedWorktree(branch);
    if (managed) return managed;
  } catch {
    // Manager may not be initialized — fall through
  }
  // Fallback: direct git worktree list parsing
  try {
    const result = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
      encoding: "utf8",
      shell: false,
    });
    if (result.status !== 0 || !result.stdout) return null;

    const lines = result.stdout.split("\n");
    let currentPath = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        currentPath = line.slice(9).trim();
      } else if (line.startsWith("branch ") && currentPath) {
        const branchRef = line.slice(7).trim();
        const branchName = branchRef.replace(/^refs\/heads\//, "");
        if (branchName === branch) {
          return currentPath;
        }
      } else if (line.trim() === "") {
        currentPath = null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function findExistingPrForBranch(branch) {
  if (!branch || !ghAvailable()) return null;
  const res = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "5",
      "--json",
      "number,state,title,url,mergedAt,closedAt",
    ],
    { encoding: "utf8" },
  );
  if (res.status !== 0) {
    return null;
  }
  try {
    const items = JSON.parse(res.stdout || "[]");
    return Array.isArray(items) && items.length > 0 ? items[0] : null;
  } catch {
    return null;
  }
}

async function findExistingPrForBranchApi(branch) {
  if (!branch || !githubToken || !repoSlug) return null;
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) return null;
  const head = `${owner}:${branch}`;
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&head=${encodeURIComponent(
    head,
  )}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bosun",
      },
    });
    if (!res || !res.ok) {
      const text = res ? await res.text().catch(() => "") : "";
      const status = res?.status || "no response";
      console.warn(
        `[monitor] GitHub API PR lookup failed (${status}): ${text.slice(0, 120)}`,
      );
      return null;
    }
    const items = await res.json();
    return Array.isArray(items) && items.length > 0 ? items[0] : null;
  } catch (err) {
    console.warn(
      `[monitor] GitHub API PR lookup error: ${err?.message || err}`,
    );
    return null;
  }
}

async function getPullRequestByNumber(prNumber) {
  if (!Number.isFinite(prNumber) || prNumber <= 0) return null;
  if (ghAvailable()) {
    const res = spawnSync(
      "gh",
      [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "number,state,title,url,mergedAt,closedAt,mergeable,mergeStateStatus",
      ],
      { encoding: "utf8" },
    );
    if (res.status === 0) {
      try {
        return JSON.parse(res.stdout || "{}");
      } catch {
        /* fall through */
      }
    }
  }
  if (!githubToken || !repoSlug) return null;
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) return null;
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "bosun",
      },
    });
    if (!res || !res.ok) {
      const text = res ? await res.text().catch(() => "") : "";
      const status = res?.status || "no response";
      console.warn(
        `[monitor] GitHub API PR ${prNumber} lookup failed (${status}): ${text.slice(0, 120)}`,
      );
      return null;
    }
    return await res.json();
  } catch (err) {
    console.warn(
      `[monitor] GitHub API PR ${prNumber} lookup error: ${err?.message || err}`,
    );
    return null;
  }
}

/**
 * Find the matching project by projectName, with caching.
 * Falls back to the first project if no name match.
 * Works with any kanban backend (VK, GitHub, Jira).
 */
async function findKanbanProjectId() {
  if (cachedProjectId) return cachedProjectId;

  try {
    const projects = await listKanbanProjects();
    if (!Array.isArray(projects) || projects.length === 0) {
      console.warn("[monitor] No projects found in kanban backend");
      return null;
    }

    // Match by projectName (case-insensitive)
    const match = projects.find(
      (p) => p.name?.toLowerCase() === projectName?.toLowerCase(),
    );
    const project = match || projects[0];
    if (!project?.id) {
      console.warn("[monitor] No valid project found in kanban backend");
      return null;
    }
    if (!match) {
      console.warn(
        `[monitor] No project matching "${projectName}" — using "${project.name}" as fallback`,
      );
    }
    cachedProjectId = project.id;
    console.log(
      `[monitor] Cached project_id: ${String(cachedProjectId).substring(0, 16)}... (${project.name})`,
    );
    return cachedProjectId;
  } catch (err) {
    console.warn(`[monitor] Failed to fetch projects: ${err.message}`);
    return null;
  }
}

/**
 * VK-specific project lookup (returns null if not using VK backend).
 * Legacy function for VK-specific code paths that haven't been migrated to kanban-adapter yet.
 */
async function findVkProjectId() {
  const backend = getActiveKanbanBackend();
  if (backend !== "vk") {
    return null;
  }
  return findKanbanProjectId();
}

/**
 * Fetches and caches the repo_id from VK API.
 * Uses the flat /api/repos endpoint and matches by repoRoot path or projectName.
 */
async function getRepoId() {
  if (cachedRepoId) return cachedRepoId;
  if (process.env.VK_REPO_ID) {
    cachedRepoId = process.env.VK_REPO_ID;
    return cachedRepoId;
  }

  // Skip VK API calls if not using VK backend
  const backend = getActiveKanbanBackend();
  if (backend !== "vk") {
    return null;
  }

  try {
    // Use the flat /api/repos endpoint (not nested under projects)
    const reposRes = await fetchVk("/api/repos");
    if (
      !reposRes?.success ||
      !Array.isArray(reposRes.data) ||
      reposRes.data.length === 0
    ) {
      console.warn("[monitor] Failed to fetch repos from VK API");
      return null;
    }

    // Match by repo path (normalized for comparison)
    const normalPath = (p) =>
      (p || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const targetPath = normalPath(repoRoot);

    let repo = reposRes.data.find((r) => normalPath(r.path) === targetPath);

    // Fallback: match by name / display_name
    if (!repo) {
      repo = reposRes.data.find(
        (r) =>
          (r.name || r.display_name || "").toLowerCase() ===
          projectName?.toLowerCase(),
      );
    }

    if (!repo) {
      console.warn(
        `[monitor] No VK repo matching path "${repoRoot}" or name "${projectName}" — ` +
          `available: ${reposRes.data.map((r) => r.name).join(", ")}`,
      );
      return null;
    }

    cachedRepoId = repo.id;
    console.log(
      `[monitor] Cached repo_id: ${cachedRepoId.substring(0, 8)}... (${repo.name})`,
    );
    return cachedRepoId;
  } catch (err) {
    console.warn(`[monitor] Error fetching repo_id: ${err.message}`);
    return null;
  }
}

/**
 * POST /api/task-attempts/:id/rebase
 * Rebases the attempt's worktree onto target branch.
 */
async function rebaseAttempt(attemptId, baseBranch) {
  const repoId = await getRepoId();
  if (!repoId) {
    console.warn("[monitor] Cannot rebase: repo_id not available");
    return {
      success: false,
      error: "repo_id_missing",
      message: "repo_id not available",
    };
  }
  const body = { repo_id: repoId };
  if (baseBranch) {
    body.old_base_branch = baseBranch;
    body.new_base_branch = baseBranch;
  }
  const res = await fetchVk(`/api/task-attempts/${attemptId}/rebase`, {
    method: "POST",
    body,
    timeoutMs: 60000,
  });
  return res;
}

/**
 * POST /api/task-attempts/:id/pr
 * Creates a PR via the VK API (triggers prepush hooks in the worktree).
 * Can take up to 15 minutes if prepush hooks run lint/test/build.
 * @param {string} attemptId
 * @param {object} prOpts - { title, description, draft }
 */
async function createPRViaVK(attemptId, prOpts = {}) {
  // Fetch repo_id if not cached
  const repoId = await getRepoId();
  if (!repoId) {
    console.error("[monitor] Cannot create PR: repo_id not available");
    return { success: false, error: "repo_id_missing", _elapsedMs: 0 };
  }

  const bosunCredit = "\n\n---\n*Created by [Bosun Bot](https://github.com/apps/bosun-ve)*";
  const rawDescription = prOpts.description || "";
  const description = rawDescription.includes("bosun-ve")
    ? rawDescription
    : rawDescription.trimEnd() + bosunCredit;

  const body = {
    repo_id: repoId,
    title: prOpts.title || "",
    description,
    draft: prOpts.draft ?? true,
    base: prOpts.base || process.env.VK_TARGET_BRANCH || "origin/main",
  };
  const startMs = Date.now();
  const res = await fetchVk(`/api/task-attempts/${attemptId}/pr`, {
    method: "POST",
    body,
    timeoutMs: 15 * 60 * 1000, // prepush hooks can take up to 15 min
  });
  const elapsed = Date.now() - startMs;
  // Attach timing so callers can distinguish instant vs slow failures
  if (res) res._elapsedMs = elapsed;
  return { ...(res || { success: false }), _elapsedMs: elapsed };
}

/**
 * POST /api/task-attempts/:id/resolve-conflicts
 * Auto-resolves merge conflicts after a failed rebase by accepting "ours" changes.
 */
async function resolveConflicts(attemptId) {
  const res = await fetchVk(
    `/api/task-attempts/${attemptId}/resolve-conflicts`,
    { method: "POST", body: {}, timeoutMs: 60000 },
  );
  return res;
}

/**
 * POST /api/task-attempts/:id/archive
 * Archives a stale attempt (0 commits, many behind).
 */
async function archiveAttempt(attemptId) {
  const res = await fetchVk(`/api/task-attempts/${attemptId}/archive`, {
    method: "POST",
    body: {},
    timeoutMs: 30000,
  });
  return res;
}

// ── Fresh session retry system ──────────────────────────────────────────────
// When an agent gets stuck (context window exhausted, crash loop, repeated
// failures), starting a fresh session in the SAME workspace is often the
// most effective recovery — the new agent gets clean context but inherits
// the existing worktree and file changes.

/**
 * Build a retry prompt that gives the fresh agent full task context.
 * Mirrors the format the user showed: failure notice + task context block.
 *
 * @param {object} attemptInfo - { task_id, task_title, task_description, branch, id }
 * @param {string} reason      - Why we're retrying (e.g., "context_window_exhausted")
 * @param {string} [logTail]   - Last N chars of log for diagnosis
 * @returns {string} The follow-up prompt
 */
function buildRetryPrompt(attemptInfo, reason, logTail) {
  const parts = [
    `Detected a failure (${reason}). Please retry your task. If it fails again, I will start a fresh session.`,
    "",
    "Task context (vibe-kanban):",
    `Branch: ${attemptInfo.branch || "unknown"}`,
    `Title: ${attemptInfo.task_title || attemptInfo.name || "unknown"}`,
  ];

  if (attemptInfo.task_description) {
    parts.push(`Description:\n${attemptInfo.task_description}`);
  }

  parts.push(
    "",
    "If VE_TASK_TITLE/VE_TASK_DESCRIPTION are missing, treat this as an orchestrated task:",
    "Worktree paths often include .git/worktrees/ or a task runner path (e.g., vibe-kanban).",
    "Tasks typically map to a ve/<id>-<slug> branch.",
    "Resume with the context above, then commit/push/PR as usual.",
  );

  if (logTail) {
    const trimmed = logTail.slice(-2000).trim();
    if (trimmed) {
      parts.push("", "Recent log output:", "```", trimmed, "```");
    }
  }

  return parts.join("\n");
}

/**
 * Get the currently active attempt info from VK status data.
 * @returns {Promise<object|null>} Attempt info with task context, or null
 */
async function getActiveAttemptInfo() {
  try {
    const statusData = await readStatusData();
    const attempts = statusData?.active_attempts || [];
    // Find the running/most recent attempt
    const running =
      attempts.find((a) => a.status === "running") ||
      attempts.find((a) => a.status === "error") ||
      attempts[0];

    if (!running) return null;

    // Enrich with task description if available
    if (running.task_id && !running.task_description) {
      try {
        const taskRes = await fetchVk(`/api/tasks/${running.task_id}`);
        if (taskRes?.success && taskRes.data) {
          running.task_title = running.task_title || taskRes.data.title;
          running.task_description =
            taskRes.data.description || taskRes.data.body || "";
        }
      } catch {
        /* best effort */
      }
    }

    return running;
  } catch {
    return null;
  }
}

// Rate-limit fresh session creation to avoid spam
const FRESH_SESSION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
let lastFreshSessionAt = 0;
let freshSessionCount = 0;
const FRESH_SESSION_MAX_PER_TASK = 3; // max retries per task before giving up
const freshSessionTaskRetries = new Map();

/**
 * Start a fresh VK session in the same workspace and send a retry prompt.
 * This is the nuclear option when an agent is irrecoverably stuck.
 *
 * @param {string} workspaceId - The workspace/attempt UUID
 * @param {string} prompt      - The follow-up prompt with task context
 * @param {string} taskId      - Task ID for retry tracking
 * @returns {Promise<{success: boolean, sessionId?: string, reason?: string}>}
 */
async function startFreshSession(workspaceId, prompt, taskId) {
  // Guard: internal executor mode runs tasks via agent-pool, not VK sessions
  const execMode = configExecutorMode || getExecutorMode();
  if (execMode === "internal") {
    console.log(
      `[monitor] startFreshSession skipped — executor mode is "internal"`,
    );
    return {
      success: false,
      reason: "internal executor mode — VK sessions disabled",
    };
  }

  const now = Date.now();

  // Rate limit
  if (now - lastFreshSessionAt < FRESH_SESSION_COOLDOWN_MS) {
    const waitSec = Math.round(
      (FRESH_SESSION_COOLDOWN_MS - (now - lastFreshSessionAt)) / 1000,
    );
    console.warn(`[monitor] fresh session rate-limited, ${waitSec}s remaining`);
    return { success: false, reason: `rate-limited (${waitSec}s)` };
  }

  // Per-task retry limit
  if (taskId) {
    const retries = freshSessionTaskRetries.get(taskId) || 0;
    if (retries >= FRESH_SESSION_MAX_PER_TASK) {
      console.warn(
        `[monitor] fresh session limit reached for task ${taskId.slice(0, 8)} (${retries}/${FRESH_SESSION_MAX_PER_TASK})`,
      );
      return {
        success: false,
        reason: `max retries (${FRESH_SESSION_MAX_PER_TASK}) reached for task`,
      };
    }
    freshSessionTaskRetries.set(taskId, retries + 1);
  }

  lastFreshSessionAt = now;
  freshSessionCount += 1;

  try {
    // Step 1: Create a new session for the workspace
    const session = await fetchVk("/api/sessions", {
      method: "POST",
      body: { workspace_id: workspaceId },
      timeoutMs: 15000,
    });

    if (!session?.id) {
      console.warn("[monitor] failed to create fresh VK session");
      return { success: false, reason: "session creation failed" };
    }

    // Step 2: Send the retry prompt as a follow-up
    const followUp = await fetchVk(`/api/sessions/${session.id}/follow-up`, {
      method: "POST",
      body: { prompt },
      timeoutMs: 15000,
    });

    if (!followUp) {
      console.warn("[monitor] failed to send follow-up to fresh session");
      return { success: false, reason: "follow-up send failed" };
    }

    console.log(
      `[monitor] :check: Fresh session started: ${session.id} (retry #${freshSessionCount})`,
    );

    // Connect the VK log stream to this session for real-time log capture
    if (vkLogStream) {
      // Set metadata so structured session logs get proper headers
      const attemptInfo = await getAttemptInfo(workspaceId);
      if (attemptInfo) {
        vkLogStream.setProcessMeta(workspaceId, {
          attemptId: workspaceId,
          taskId: attemptInfo.task_id,
          taskTitle: attemptInfo.task_title || attemptInfo.name,
          branch: attemptInfo.branch,
          sessionId: session.id,
          executor: attemptInfo.executor,
          executorVariant: attemptInfo.executor_variant,
        });
      }
      vkLogStream.connectToSession(session.id);
    }

    return { success: true, sessionId: session.id };
  } catch (err) {
    console.warn(`[monitor] fresh session error: ${err.message || err}`);
    return { success: false, reason: err.message || String(err) };
  }
}

/**
 * High-level: detect a stuck agent, build retry prompt, start fresh session.
 * Call this from handleExit, crash loop detection, or smartPRFlow stale detection.
 *
 * @param {string} reason  - Why we're retrying
 * @param {string} [logTail] - Recent log output for context
 * @returns {Promise<boolean>} true if fresh session started
 */
async function attemptFreshSessionRetry(reason, logTail) {
  // Guard: internal executor mode runs tasks via agent-pool, not VK sessions
  const execMode = configExecutorMode || getExecutorMode();
  if (execMode === "internal") {
    console.log(
      `[monitor] attemptFreshSessionRetry skipped — executor mode is "internal"`,
    );
    return false;
  }

  if (!vkEndpointUrl) {
    console.log("[monitor] fresh session retry skipped — no VK endpoint");
    return false;
  }

  const attemptInfo = await getActiveAttemptInfo();
  if (!attemptInfo?.id) {
    console.log("[monitor] fresh session retry skipped — no active attempt");
    return false;
  }

  const prompt = buildRetryPrompt(attemptInfo, reason, logTail);
  const result = await startFreshSession(
    attemptInfo.id,
    prompt,
    attemptInfo.task_id,
  );

  if (result.success) {
    if (telegramToken && telegramChatId) {
      const taskLabel =
        attemptInfo.task_title || attemptInfo.branch || "unknown";
      void sendTelegramMessage(
        `:refresh: Fresh session started for "${taskLabel}" (${reason}).\nNew session: ${result.sessionId}`,
      );
    }
    return true;
  }

  console.warn(`[monitor] fresh session retry failed: ${result.reason}`);
  if (telegramToken && telegramChatId) {
    void sendTelegramMessage(
      `:alert: Fresh session retry failed (${reason}): ${result.reason}`,
    );
  }
  return false;
}

/**
 * Calculate how long a task has been in its current state (ms).
 * Uses `updated_at` if available, otherwise `created_at`.
 * @param {object} task - VK task object with `updated_at` / `created_at`
 * @returns {number} Age in milliseconds, or 0 if no timestamp available
 */
function getTaskAgeMs(task) {
  const ts = task?.updated_at || task?.created_at;
  if (!ts) return 0;
  const parsed = new Date(ts).getTime();
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Date.now() - parsed);
}

/**
 * Return the task's "version" timestamp used for cache invalidation.
 * Prefers updated_at, falls back to created_at.
 * @param {object} task
 * @returns {string} ISO-ish timestamp string or empty string
 */
function getTaskUpdatedAt(task) {
  return task?.updated_at || task?.created_at || "";
}

function parseGitHubIssueNumber(value) {
  if (value == null) return null;
  const numeric = String(value)
    .trim()
    .match(/^#?(\d+)$/);
  if (numeric?.[1]) return numeric[1];
  const urlMatch = String(value).match(/\/issues\/(\d+)(?:\b|$)/i);
  return urlMatch?.[1] || null;
}

function getConfiguredKanbanProjectId(backend) {
  const githubProjectId =
    process.env.GITHUB_REPOSITORY ||
    (process.env.GITHUB_REPO_OWNER && process.env.GITHUB_REPO_NAME
      ? `${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}`
      : null) ||
    repoSlug ||
    null;
  const jiraProjectKey =
    process.env.JIRA_PROJECT_KEY || config?.jira?.projectKey || null;
  return (
    process.env.INTERNAL_EXECUTOR_PROJECT_ID ||
    internalExecutorConfig?.projectId ||
    config?.kanban?.projectId ||
    process.env.KANBAN_PROJECT_ID ||
    (backend === "github"
      ? githubProjectId
      : backend === "jira"
        ? jiraProjectKey
        : null)
  );
}

function resolveTaskIdForBackend(taskId, backend) {
  const rawId = String(taskId || "").trim();
  if (!rawId) return null;
  if (backend !== "github") return rawId;
  const directMatch = parseGitHubIssueNumber(rawId);
  if (directMatch) return directMatch;
  try {
    const internalTasks = getAllInternalTasks();
    const internalTask = internalTasks.find(
      (t) =>
        String(t?.id || "").trim() === rawId ||
        String(t?.externalId || "").trim() === rawId,
    );
    return (
      parseGitHubIssueNumber(internalTask?.externalId) ||
      parseGitHubIssueNumber(internalTask?.id) ||
      null
    );
  } catch {
    return null;
  }
}

/**
 * GET /api/projects/:project_id/tasks?status=<status>
 * Fetches tasks by status from active kanban backend.
 * @param {string} status - Task status (e.g., "inreview", "todo", "done")
 * @returns {Promise<Array>} Array of task objects, or empty array on failure
 */
async function fetchTasksByStatus(status) {
  const backend = getActiveKanbanBackend();
  if (backend !== "vk") {
    try {
      // Internal backend uses file-based storage — no project ID required.
      if (backend === "internal") {
        const tasks = status
          ? getInternalTasksByStatus(status)
          : getAllInternalTasks();
        return Array.isArray(tasks) ? tasks : [];
      }

      const projectId = getConfiguredKanbanProjectId(backend);
      if (!projectId) {
        console.warn(
          `[monitor] No project ID configured for backend=${backend} task query`,
        );
        return [];
      }
      const tasks = await listKanbanTasks(projectId, { status });
      return Array.isArray(tasks) ? tasks : [];
    } catch (err) {
      console.warn(
        `[monitor] Error fetching tasks by status from ${backend}: ${err.message || err}`,
      );
      return [];
    }
  }
  try {
    // Find matching VK project
    const projectId = await findVkProjectId();
    if (!projectId) {
      console.warn("[monitor] No VK project found for task query");
      return [];
    }

    // Use flat /api/tasks endpoint with query params
    const tasksRes = await fetchVk(
      `/api/tasks?project_id=${projectId}&status=${status}`,
    );
    if (!tasksRes?.success || !Array.isArray(tasksRes.data)) {
      console.warn(`[monitor] Failed to fetch tasks with status=${status}`);
      return [];
    }

    return tasksRes.data;
  } catch (err) {
    console.warn(
      `[monitor] Error fetching tasks by status: ${err.message || err}`,
    );
    return [];
  }
}

/**
 * Updates task status via active kanban backend.
 * @param {string} taskId - Task ID (UUID for VK, issue number for GitHub)
 * @param {string} newStatus - New status ("todo", "inprogress", "inreview", "done", "cancelled")
 * @returns {Promise<boolean>} true if successful, false otherwise
 */
async function updateTaskStatus(taskId, newStatus, options = {}) {
  const normalizedTaskId = String(taskId || "").trim();
  const normalizedStatus = String(newStatus || "").trim().toLowerCase();
  const taskData =
    options?.taskData && typeof options.taskData === "object"
      ? options.taskData
      : null;
  const workflowData =
    options?.workflowData && typeof options.workflowData === "object"
      ? options.workflowData
      : null;
  const taskTitle = String(
    options?.taskTitle || taskData?.title || getInternalTask(normalizedTaskId)?.title || "",
  ).trim();
  const previousStatus = String(
    options?.previousStatus || workflowTaskStatusSnapshot.get(normalizedTaskId) || "",
  )
    .trim()
    .toLowerCase();
  const baseWorkflowPayload = {
    taskId: normalizedTaskId,
    taskTitle,
    previousStatus: previousStatus || null,
    status: normalizedStatus,
    branch: String(
      options?.branch ||
        taskData?.branch ||
        taskData?.branchName ||
        taskData?.meta?.branch_name ||
        workflowData?.branch ||
        "",
    ).trim() || null,
    baseBranch: String(
      options?.baseBranch ||
        taskData?.baseBranch ||
        taskData?.base_branch ||
        taskData?.meta?.base_branch ||
        workflowData?.baseBranch ||
        "",
    ).trim() || null,
    worktreePath: String(
      options?.worktreePath ||
        taskData?.worktreePath ||
        taskData?.meta?.worktreePath ||
        workflowData?.worktreePath ||
        "",
    ).trim() || null,
    prNumber: String(
      options?.prNumber ||
        taskData?.prNumber ||
        taskData?.meta?.pr_number ||
        workflowData?.prNumber ||
        "",
    ).trim() || null,
    prUrl: String(
      options?.prUrl ||
        taskData?.prUrl ||
        taskData?.meta?.pr_url ||
        workflowData?.prUrl ||
        "",
    ).trim() || null,
  };
  const queueTaskStatusWorkflowEvents = () => {
    const statusChanged = previousStatus !== normalizedStatus;
    const shouldEmitLifecycle =
      statusChanged || ["done", "inreview"].includes(normalizedStatus);
    workflowTaskStatusSnapshot.set(normalizedTaskId, normalizedStatus);

    if (!normalizedTaskId || !normalizedStatus || !shouldEmitLifecycle) {
      return;
    }

    queueWorkflowEvent(
      "task.status_changed",
      baseWorkflowPayload,
      { dedupKey: `workflow-event:task.status_changed:${normalizedTaskId}:${normalizedStatus}` },
    );
    queueWorkflowEvent(
      `task.${normalizedStatus}`,
      baseWorkflowPayload,
      { dedupKey: `workflow-event:task.${normalizedStatus}:${normalizedTaskId}` },
    );

    if (normalizedStatus === "done") {
      queueWorkflowEvent(
        "task.completed",
        baseWorkflowPayload,
        { dedupKey: `workflow-event:task.completed:${normalizedTaskId}` },
      );
    } else if (normalizedStatus === "inreview") {
      queueWorkflowEvent(
        "task.in_review",
        baseWorkflowPayload,
        { dedupKey: `workflow-event:task.in_review:${normalizedTaskId}` },
      );
    }

    if (options?.workflowEvent) {
      const eventName = String(options.workflowEvent || "").trim();
      if (eventName) {
        const extraPayload =
          options?.workflowData && typeof options.workflowData === "object"
            ? options.workflowData
            : {};
        queueWorkflowEvent(
          eventName,
          {
            ...baseWorkflowPayload,
            ...extraPayload,
          },
          {
            dedupKey:
              options?.workflowDedupKey ||
              `workflow-event:${eventName}:${normalizedTaskId}:${normalizedStatus}`,
          },
        );
      }
    }
  };

  const transitionSource = String(options?.source || "").trim().toLowerCase();
  const workflowBypass = options?.bypassWorkflowOwnership === true;
  if (workflowAutomationEnabled && transitionSource !== "workflow" && !workflowBypass) {
    const engine = await ensureWorkflowAutomationEngine().catch(() => null);
    if (engine) {
      queueWorkflowEvent(
        "task.transition.requested",
        {
          ...baseWorkflowPayload,
          targetStatus: normalizedStatus,
          source: transitionSource || "legacy-monitor",
          error: options?.error || null,
        },
        {
          dedupKey:
            options?.workflowDedupKey ||
            `workflow-event:task.transition.requested:${normalizedTaskId}:${normalizedStatus}`,
        },
      );
      return true;
    }
  }

  const backend = getActiveKanbanBackend();
  if (backend !== "vk") {
    const resolvedTaskId = resolveTaskIdForBackend(taskId, backend);
    if (!resolvedTaskId) {
      console.warn(
        `[monitor] Skipping status update for ${taskId} — no compatible ${backend} task ID`,
      );
      return false;
    }
    try {
      await updateKanbanTaskStatus(
        resolvedTaskId,
        newStatus,
        options && typeof options === "object" ? options : {},
      );
      clearRecoveryCaches(taskId);
      if (resolvedTaskId !== taskId) {
        clearRecoveryCaches(resolvedTaskId);
      }
      try { queueTaskStatusWorkflowEvents(); } catch { /* workflow event errors must not break task updates */ }
      return true;
    } catch (err) {
      console.warn(
        `[monitor] Failed to update task status via ${backend} (${resolvedTaskId} -> ${newStatus}): ${err.message || err}`,
      );
      return false;
    }
  }

  const res = await fetchVk(`/api/tasks/${taskId}`, {
    method: "PUT",
    body: { status: newStatus },
    timeoutMs: 10000,
  });
  const ok = res?.success === true;
  // Clear recovery caches — task status changed, so it needs re-evaluation
  if (ok) {
    clearRecoveryCaches(taskId);
    try { queueTaskStatusWorkflowEvents(); } catch { /* workflow event errors must not break task updates */ }
  }
  return ok;
}

function parseTaskTimestamp(value) {
  if (!value) return null;
  const raw =
    value.created_at ||
    value.createdAt ||
    value.created ||
    value.updated_at ||
    value.updatedAt ||
    value.updated ||
    value.started_at ||
    value.startedAt ||
    value;
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function isPlannerTaskData(task) {
  if (!task) return false;
  const title = String(task.title || "").toLowerCase();
  const desc = String(task.description || task.body || "").toLowerCase();
  if (title.includes("plan next tasks") || title.includes("plan next phase")) {
    return true;
  }
  if (title.includes("task planner")) {
    return true;
  }
  return (
    desc.includes("task planner — auto-created by bosun") ||
    desc.includes("task planner - auto-created by bosun")
  );
}

async function verifyPlannerTaskCompletion(taskData, attemptInfo) {
  const projectId =
    taskData?.project_id ||
    taskData?.projectId ||
    attemptInfo?.project_id ||
    attemptInfo?.projectId ||
    (await findVkProjectId());
  if (!projectId) {
    return { completed: false, reason: "project_not_found" };
  }
  const tasksRes = await fetchVk(`/api/tasks?project_id=${projectId}`);
  const tasks = Array.isArray(tasksRes?.data)
    ? tasksRes.data
    : Array.isArray(tasksRes?.tasks)
      ? tasksRes.tasks
      : Array.isArray(tasksRes)
        ? tasksRes
        : [];
  const sinceMs =
    parseTaskTimestamp(taskData) ||
    parseTaskTimestamp(attemptInfo) ||
    Date.now();
  const candidates = tasks.filter((t) => {
    if (!t || t.id === taskData?.id) return false;
    if (isPlannerTaskData(t)) return false;
    const createdMs = parseTaskTimestamp(t);
    return createdMs && createdMs > sinceMs;
  });
  const backlogCandidates = candidates.filter((t) => {
    if (!t?.status) return true;
    const status = String(t.status).toLowerCase();
    return (
      status === "todo" || status === "inprogress" || status === "inreview"
    );
  });
  const finalCandidates =
    backlogCandidates.length > 0 ? backlogCandidates : candidates;
  return {
    completed: finalCandidates.length > 0,
    createdCount: finalCandidates.length,
    projectId,
    sinceMs,
    sampleTitles: finalCandidates
      .slice(0, 3)
      .map((t) => t.title || t.id)
      .filter(Boolean),
  };
}

/**
 * Safe recovery: re-fetches a task's live status from VK before moving it
 * to "todo".  If the user has since cancelled/done the task, the recovery
 * is aborted.  This prevents the loop where:
 *   user cancels → monitor moves to todo → orchestrator re-dispatches.
 *
 * @param {string} taskId - Task UUID
 * @param {string} taskTitle - Human-readable title (for logging)
 * @param {string} reason - Why the recovery is happening (for logging)
 * @returns {Promise<boolean>} true if moved to todo, false if skipped/failed
 */
async function safeRecoverTask(taskId, taskTitle, reason) {
  // In internal executor mode, only update task status — never start VK sessions
  const execMode = configExecutorMode || getExecutorMode();
  const isInternal = execMode === "internal";

  try {
    const activeBackend = getActiveKanbanBackend();
    if (activeBackend !== "vk") {
      const localStatus = String(getInternalTask(taskId)?.status || "")
        .trim()
        .toLowerCase();
      if (localStatus === "cancelled" || localStatus === "done") {
        console.log(
          `[monitor] safeRecover: task "${taskTitle}" is now ${localStatus} (local store) - aborting recovery`,
        );
        recoverySkipCache.set(taskId, {
          resolvedStatus: localStatus,
          timestamp: Date.now(),
          updatedAt: "",
          status: localStatus,
        });
        scheduleRecoveryCacheSave();
        return false;
      }
      if (localStatus === "todo") {
        console.log(
          `[monitor] safeRecover: task "${taskTitle}" is already todo (local store) - no action needed`,
        );
        recoverySkipCache.set(taskId, {
          resolvedStatus: localStatus,
          timestamp: Date.now(),
          updatedAt: "",
          status: localStatus,
        });
        scheduleRecoveryCacheSave();
        return false;
      }

      const success = await updateTaskStatus(taskId, "todo");
      if (success) {
        console.log(
          `[monitor] :repeat: Recovered "${taskTitle}" from ${localStatus || "inprogress"} → todo (${reason}) [${activeBackend} backend - VK status re-fetch skipped]`,
        );
      } else {
        console.warn(
          `[monitor] safeRecover: failed to move "${taskTitle}" to todo (${reason}) [${activeBackend} backend]`,
        );
      }
      return success;
    }

    const res = await fetchVk(`/api/tasks/${taskId}`);
    const liveStatus = res?.data?.status || res?.status;
    const liveUpdatedAt = res?.data?.updated_at || res?.data?.created_at || "";
    if (!liveStatus) {
      // Cache the failure so we don't re-attempt every cycle (prevents log spam).
      // Uses a shorter TTL (5 min) so we re-check sooner than successful skips.
      const FETCH_FAIL_BACKOFF_MS = 5 * 60 * 1000;
      const existingSkip = recoverySkipCache.get(taskId);
      const alreadyBackedOff =
        existingSkip?.resolvedStatus === "fetch-failed" &&
        Date.now() - existingSkip.timestamp < FETCH_FAIL_BACKOFF_MS;
      if (!alreadyBackedOff) {
        console.warn(
          `[monitor] safeRecover: could not re-fetch status for "${taskTitle}" (${taskId.substring(0, 8)}...) — skipping (backoff ${Math.round(FETCH_FAIL_BACKOFF_MS / 60000)}min)`,
        );
        recoverySkipCache.set(taskId, {
          resolvedStatus: "fetch-failed",
          timestamp: Date.now(),
          updatedAt: "",
          status: "fetch-failed",
        });
        scheduleRecoveryCacheSave();
      }
      return false;
    }
    // If the user has moved the task out of inprogress (cancelled, done,
    // or even already todo), do NOT touch it.
    if (liveStatus === "cancelled" || liveStatus === "done") {
      console.log(
        `[monitor] safeRecover: task "${taskTitle}" is now ${liveStatus} — aborting recovery`,
      );
      // Cache so we skip this task for RECOVERY_SKIP_CACHE_MS
      recoverySkipCache.set(taskId, {
        resolvedStatus: liveStatus,
        timestamp: Date.now(),
        updatedAt: liveUpdatedAt,
        status: liveStatus,
      });
      scheduleRecoveryCacheSave();
      return false;
    }
    if (liveStatus === "todo") {
      console.log(
        `[monitor] safeRecover: task "${taskTitle}" is already todo — no action needed`,
      );
      // Cache so we skip this task for RECOVERY_SKIP_CACHE_MS
      recoverySkipCache.set(taskId, {
        resolvedStatus: liveStatus,
        timestamp: Date.now(),
        updatedAt: liveUpdatedAt,
        status: liveStatus,
      });
      scheduleRecoveryCacheSave();
      return false;
    }
    const success = await updateTaskStatus(taskId, "todo");
    if (success) {
      if (isInternal) {
        console.log(
          `[monitor] :repeat: Recovered "${taskTitle}" from ${liveStatus} → todo (${reason}) [internal mode — VK session skipped]`,
        );
      } else {
        console.log(
          `[monitor] :repeat: Recovered "${taskTitle}" from ${liveStatus} → todo (${reason})`,
        );
      }
    }
    return success;
  } catch (err) {
    // Cache the exception so we don't retry every cycle (5 min backoff)
    const FETCH_FAIL_BACKOFF_MS = 5 * 60 * 1000;
    const existingSkip = recoverySkipCache.get(taskId);
    const alreadyBackedOff =
      existingSkip?.resolvedStatus === "fetch-failed" &&
      Date.now() - existingSkip.timestamp < FETCH_FAIL_BACKOFF_MS;
    if (!alreadyBackedOff) {
      console.warn(
        `[monitor] safeRecover failed for "${taskTitle}": ${err.message || err} (backoff ${Math.round(FETCH_FAIL_BACKOFF_MS / 60000)}min)`,
      );
      recoverySkipCache.set(taskId, {
        resolvedStatus: "fetch-failed",
        timestamp: Date.now(),
        updatedAt: "",
        status: "fetch-failed",
      });
      scheduleRecoveryCacheSave();
    }
    return false;
  }
}

/**
 * Checks if a git branch has been merged into the target base branch.
 * Uses GitHub CLI + git commands to determine merge status.
 *
 * IMPORTANT: "branch not on remote" does NOT mean merged. The agent may
 * never have pushed, the PR may have been closed without merging, or the
 * branch was manually deleted. We must verify via GitHub PR state.
 *
 * @param {string} branch - Branch name (e.g., "ve/1234-feat-auth")
 * @param {string} [baseBranch] - Upstream/base branch to compare against
 * @returns {Promise<boolean>} true if definitively merged, false otherwise
 */
async function isBranchMerged(branch, baseBranch) {
  if (!branch) return false;

  try {
    const target = normalizeBranchName(baseBranch) || DEFAULT_TARGET_BRANCH;

    const branchInfo = splitRemoteRef(normalizeBranchName(branch), "origin");
    const baseInfo = splitRemoteRef(target, "origin");
    const branchRef = `${branchInfo.remote}/${branchInfo.name}`;
    const baseRef = `${baseInfo.remote}/${baseInfo.name}`;
    const ghHead = branchInfo.name || branch;

    // ── Strategy 1: Check GitHub PR state for this head branch ───────────
    // Open PR always wins over historical merged PRs for the same head.
    // A branch can have an old merged PR and a newer open PR with fresh commits.
    // In that case, treat as NOT merged.
    if (ghAvailable()) {
      try {
        const openResult = execSync(
          `gh pr list --head "${ghHead}" --state open --json number,baseRefName --limit 10`,
          {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
            timeout: 15000,
          },
        ).trim();
        const openPRs = JSON.parse(openResult || "[]");
        const hasOpenForTarget = openPRs.some((pr) => {
          const prBase = normalizeBranchName(pr?.baseRefName);
          return !prBase || prBase === baseInfo.name;
        });
        if (hasOpenForTarget || openPRs.length > 0) {
          console.log(
            `[monitor] Branch ${branch} has open PR(s) — treating as NOT merged`,
          );
          return false;
        }
      } catch {
        // best-effort
      }

      try {
        const ghResult = execSync(
          `gh pr list --head "${ghHead}" --base "${baseInfo.name}" --state merged --json number,mergedAt --limit 1`,
          {
            cwd: repoRoot,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
            timeout: 15000,
          },
        ).trim();
        const mergedPRs = JSON.parse(ghResult || "[]");
        if (mergedPRs.length > 0) {
          console.log(
            `[monitor] Branch ${branch} has merged PR #${mergedPRs[0].number}`,
          );
          return true;
        }
      } catch {
        // Fallback for older gh variants / edge cases that reject --base here.
        try {
          const ghResult = execSync(
            `gh pr list --head "${ghHead}" --state merged --json number,mergedAt --limit 1`,
            {
              cwd: repoRoot,
              encoding: "utf8",
              stdio: ["pipe", "pipe", "ignore"],
              timeout: 15000,
            },
          ).trim();
          const mergedPRs = JSON.parse(ghResult || "[]");
          if (mergedPRs.length > 0) {
            console.log(
              `[monitor] Branch ${branch} has merged PR #${mergedPRs[0].number}`,
            );
            return true;
          }
        } catch {
          // gh failed — fall through to git-based checks
        }
      }
    }

    // ── Strategy 2: Check if branch exists on remote ────────────────────
    const branchExistsCmd = `git ls-remote --heads ${branchInfo.remote} ${branchInfo.name}`;
    const branchExists = execSync(branchExistsCmd, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();

    // Branch NOT on remote — this does NOT prove it was merged.
    // Without a confirmed merged PR (strategy 1), we must assume NOT merged.
    if (!branchExists) {
      console.log(
        `[monitor] Branch ${branchRef} not found on ${branchInfo.remote} — no merged PR found against ${baseRef}, treating as NOT merged`,
      );
      return false;
    }

    // ── Strategy 3: Branch exists on remote — check if ancestor of main ─
    execSync(`git fetch ${baseInfo.remote} ${baseInfo.name} --quiet`, {
      cwd: repoRoot,
      stdio: "ignore",
      timeout: 15000,
    });
    execSync(`git fetch ${branchInfo.remote} ${branchInfo.name} --quiet`, {
      cwd: repoRoot,
      stdio: "ignore",
      timeout: 15000,
    });

    // Check if the branch is fully merged into origin/main
    // Returns non-zero exit code if not merged
    const mergeCheckCmd = `git merge-base --is-ancestor ${branchRef} ${baseRef}`;
    execSync(mergeCheckCmd, {
      cwd: repoRoot,
      stdio: "ignore",
      timeout: 10000,
    });

    // If we get here, the branch is merged
    console.log(
      `[monitor] Branch ${branchRef} is ancestor of ${baseRef} (merged)`,
    );
    return true;
  } catch (err) {
    // Non-zero exit code means not merged, or other error
    return false;
  }
}

/**
 * Persistent cache of task IDs already confirmed as done.
 * Survives monitor restarts by writing to disk.
 * @type {Set<string>}
 */
const mergedTaskCache = new Set();

/**
 * Branch-level dedup cache — VK can have duplicate tasks (different IDs)
 * pointing at the same branch. Once a branch is confirmed merged we skip
 * ALL tasks that reference it, regardless of task ID.
 * @type {Set<string>}
 */
const mergedBranchCache = new Set();

function normalizeMergedBranchKey(branch) {
  const normalized = normalizeBranchName(branch);
  if (normalized) return normalized;
  const raw = String(branch || "").trim();
  return raw || "";
}

function addMergedBranchCache(branch) {
  const key = normalizeMergedBranchKey(branch);
  if (!key) return false;
  mergedBranchCache.add(key);
  return true;
}

function hasMergedBranchCache(branch) {
  const key = normalizeMergedBranchKey(branch);
  if (!key) return false;
  return mergedBranchCache.has(key);
}

function removeMergedBranchCache(branch) {
  const key = normalizeMergedBranchKey(branch);
  if (!key) return false;
  return mergedBranchCache.delete(key);
}

async function isMergedBranchCacheEntryStillValid(branch, baseBranch) {
  if (!hasMergedBranchCache(branch)) return false;
  const stillMerged = await isBranchMerged(branch, baseBranch);
  if (stillMerged) return true;
  if (removeMergedBranchCache(branch)) {
    saveMergedTaskCache();
    console.log(
      `[monitor] Branch ${branch} removed from merged cache after revalidation`,
    );
  }
  return false;
}

/** Path to the persistent merged-task cache file */
const mergedTaskCachePath = resolve(
  config.cacheDir || resolve(config.repoRoot, ".cache"),
  "ve-merged-tasks.json",
);

/** Load persisted merged-task cache from disk (best-effort) */
function loadMergedTaskCache() {
  try {
    if (existsSync(mergedTaskCachePath)) {
      const raw = readFileSync(mergedTaskCachePath, "utf8");
      const data = JSON.parse(raw);
      // No expiry — merged PRs don't un-merge. Cache is permanent.
      const ids = data.taskIds ?? data; // back-compat: old format was flat {id:ts}
      for (const id of Object.keys(ids)) {
        mergedTaskCache.add(id);
      }
      if (Array.isArray(data.branches)) {
        for (const b of data.branches) {
          addMergedBranchCache(b);
        }
      }
      const total = mergedTaskCache.size + mergedBranchCache.size;
      if (total > 0) {
        console.log(
          `[monitor] Restored ${mergedTaskCache.size} task IDs + ${mergedBranchCache.size} branches from merged-task cache`,
        );
      }
    }
  } catch {
    /* best-effort — start fresh */
  }
}

/** Persist merged-task cache to disk (best-effort) */
function saveMergedTaskCache() {
  try {
    const taskIds = {};
    const now = Date.now();
    for (const id of mergedTaskCache) {
      taskIds[id] = now;
    }
    const payload = {
      taskIds,
      branches: [...mergedBranchCache],
    };
    writeFileSync(
      mergedTaskCachePath,
      JSON.stringify(payload, null, 2),
      "utf8",
    );
  } catch {
    /* best-effort */
  }
}

// Load cache on startup
loadMergedTaskCache();

/**
 * Persistent cache for epic merge orchestration state.
 * Keyed by `${head}::${base}` where head/base are normalized.
 * @type {Map<string, object>}
 */
const epicMergeCache = new Map();

const epicMergeCachePath = resolve(
  config.cacheDir || resolve(config.repoRoot, ".cache"),
  "epic-merge-cache.json",
);

let epicMergeCacheSaveTimer = null;

function loadEpicMergeCache() {
  try {
    if (!existsSync(epicMergeCachePath)) return;
    const raw = readFileSync(epicMergeCachePath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = parsed?.entries || parsed || {};
    for (const [key, value] of Object.entries(entries)) {
      epicMergeCache.set(key, value || {});
    }
    if (epicMergeCache.size > 0) {
      console.log(
        `[monitor] Restored ${epicMergeCache.size} epic merge records`,
      );
    }
  } catch {
    /* best-effort */
  }
}

function saveEpicMergeCache() {
  try {
    const entries = {};
    for (const [key, value] of epicMergeCache.entries()) {
      entries[key] = value;
    }
    const payload = { entries };
    writeFileSync(epicMergeCachePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

function scheduleEpicMergeCacheSave() {
  if (epicMergeCacheSaveTimer) return;
  epicMergeCacheSaveTimer = setTimeout(() => {
    epicMergeCacheSaveTimer = null;
    saveEpicMergeCache();
  }, 2000);
}

function updateEpicMergeCache(key, patch = {}) {
  if (!key) return;
  const existing = epicMergeCache.get(key) || {};
  const next = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  epicMergeCache.set(key, next);
  scheduleEpicMergeCacheSave();
}

loadEpicMergeCache();

// ── Recovery/Idle caches (persistent) ───────────────────────────────────────

const recoveryCacheEnabled =
  String(process.env.RECOVERY_CACHE_ENABLED || "true").toLowerCase() !==
  "false";
const recoveryLogDedupMs =
  Number(process.env.RECOVERY_LOG_DEDUP_MINUTES || "30") * 60 * 1000;
const recoveryCacheMaxEntries = Number(
  process.env.RECOVERY_CACHE_MAX || "2000",
);

const recoveryCachePath = resolve(
  config.cacheDir || resolve(config.repoRoot, ".cache"),
  "ve-task-recovery-cache.json",
);

/**
 * Cooldown cache for tasks whose branches are all unresolvable (deleted,
 * no PR, abandoned).  We re-check them every 30 min instead of every cycle.
 * After STALE_MAX_STRIKES consecutive stale checks the task is moved back
 * to "todo" so another agent can pick it up.
 * Key = task ID, Value = { lastCheck: timestamp, strikes: number, updatedAt?: string, status?: string }.
 * @type {Map<string, {lastCheck: number, strikes: number, updatedAt?: string, status?: string}>}
 */
const staleBranchCooldown = new Map();

/**
 * Cache for tasks whose recovery was a no-op (already todo/cancelled/done).
 * Prevents redundant VK API calls, branch/PR checks, and log spam every cycle.
 * Key = task ID, Value = { resolvedStatus: string, timestamp: number, updatedAt?: string, status?: string }.
 * Expires after RECOVERY_SKIP_CACHE_MS so we re-check periodically.
 * @type {Map<string, {resolvedStatus: string, timestamp: number, updatedAt?: string, status?: string}>}
 */
const recoverySkipCache = new Map();

/**
 * Log dedup for repeated "no attempt found" messages.
 * Key = task ID, Value = { lastLogAt: number, updatedAt?: string, status?: string, reason?: string }.
 * @type {Map<string, {lastLogAt: number, updatedAt?: string, status?: string, reason?: string}>}
 */
const noAttemptLogCache = new Map();

let recoveryCacheDirty = false;
let recoveryCacheSaveTimer = null;

function taskVersionMatches(task, entry, status) {
  if (!entry) return false;
  const updatedAt = getTaskUpdatedAt(task);
  if (!updatedAt) return false;
  if (!entry.updatedAt) return false;
  if (entry.updatedAt !== updatedAt) return false;
  if (entry.status && status && entry.status !== status) return false;
  return true;
}

function scheduleRecoveryCacheSave() {
  if (!recoveryCacheEnabled) return;
  recoveryCacheDirty = true;
  if (recoveryCacheSaveTimer) return;
  recoveryCacheSaveTimer = setTimeout(() => {
    recoveryCacheSaveTimer = null;
    if (!recoveryCacheDirty) return;
    recoveryCacheDirty = false;
    saveRecoveryCache();
  }, 1000);
  if (typeof recoveryCacheSaveTimer.unref === "function") {
    recoveryCacheSaveTimer.unref();
  }
}

function buildCacheObject(map, tsField) {
  const entries = [...map.entries()];
  entries.sort((a, b) => (b[1]?.[tsField] || 0) - (a[1]?.[tsField] || 0));
  const limited =
    recoveryCacheMaxEntries > 0
      ? entries.slice(0, recoveryCacheMaxEntries)
      : entries;
  const obj = {};
  for (const [id, value] of limited) {
    obj[id] = value;
  }
  return obj;
}

function saveRecoveryCache() {
  if (!recoveryCacheEnabled) return;
  try {
    const payload = {
      version: 1,
      savedAt: new Date().toISOString(),
      staleCooldown: buildCacheObject(staleBranchCooldown, "lastCheck"),
      recoverySkip: buildCacheObject(recoverySkipCache, "timestamp"),
      noAttemptLog: buildCacheObject(noAttemptLogCache, "lastLogAt"),
    };
    writeFileSync(recoveryCachePath, JSON.stringify(payload, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

function loadRecoveryCache() {
  if (!recoveryCacheEnabled) return;
  try {
    if (!existsSync(recoveryCachePath)) return;
    const raw = readFileSync(recoveryCachePath, "utf8");
    const data = JSON.parse(raw);
    const now = Date.now();
    const staleEntries = data?.staleCooldown || {};
    for (const [id, entry] of Object.entries(staleEntries)) {
      if (!entry?.lastCheck) continue;
      if (now - entry.lastCheck > STALE_COOLDOWN_MS) continue;
      staleBranchCooldown.set(id, entry);
    }
    const skipEntries = data?.recoverySkip || {};
    for (const [id, entry] of Object.entries(skipEntries)) {
      if (!entry?.timestamp) continue;
      if (now - entry.timestamp > RECOVERY_SKIP_CACHE_MS) continue;
      recoverySkipCache.set(id, entry);
    }
    const logEntries = data?.noAttemptLog || {};
    for (const [id, entry] of Object.entries(logEntries)) {
      if (!entry?.lastLogAt) continue;
      if (
        recoveryLogDedupMs > 0 &&
        now - entry.lastLogAt > recoveryLogDedupMs
      ) {
        continue;
      }
      noAttemptLogCache.set(id, entry);
    }
    const total =
      staleBranchCooldown.size +
      recoverySkipCache.size +
      noAttemptLogCache.size;
    if (total > 0) {
      console.log(
        `[monitor] Restored ${total} recovery cache entries (stale=${staleBranchCooldown.size}, skip=${recoverySkipCache.size}, logs=${noAttemptLogCache.size})`,
      );
    }
  } catch {
    /* best-effort */
  }
}

function clearRecoveryCaches(taskId) {
  let changed = false;
  if (staleBranchCooldown.delete(taskId)) changed = true;
  if (recoverySkipCache.delete(taskId)) changed = true;
  if (noAttemptLogCache.delete(taskId)) changed = true;
  if (changed) scheduleRecoveryCacheSave();
}

function shouldLogNoAttempt(task, taskStatus, reason) {
  if (!recoveryCacheEnabled || recoveryLogDedupMs <= 0) return true;
  const entry = noAttemptLogCache.get(task.id);
  if (!entry) return true;
  if (entry.reason && entry.reason !== reason) return true;
  if (!taskVersionMatches(task, entry, taskStatus)) {
    noAttemptLogCache.delete(task.id);
    scheduleRecoveryCacheSave();
    return true;
  }
  return Date.now() - entry.lastLogAt >= recoveryLogDedupMs;
}

function recordNoAttemptLog(task, taskStatus, reason) {
  if (!recoveryCacheEnabled) return;
  const updatedAt = getTaskUpdatedAt(task);
  if (!updatedAt) return;
  noAttemptLogCache.set(task.id, {
    lastLogAt: Date.now(),
    updatedAt,
    status: taskStatus,
    reason,
  });
  scheduleRecoveryCacheSave();
}

/** Maximum number of tasks to process per sweep (0 = unlimited) */
const MERGE_CHECK_BATCH_SIZE = 0;

/** Small delay between GitHub API calls to avoid rate-limiting (ms) */
const MERGE_CHECK_THROTTLE_MS = 1500;

const STALE_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const STALE_MAX_STRIKES = 2; // move to todo after this many stale checks
const RECOVERABLE_IDLE_STATUSES = new Set(["inprogress", "inreview"]);

function isRecoverableIdleStatus(status) {
  return RECOVERABLE_IDLE_STATUSES.has(String(status || "").trim().toLowerCase());
}

/**
 * Age-based stale detection: if a task has been in inprogress/inreview for
 * longer than this threshold with no active branch or PR, it is immediately
 * moved back to "todo" on the first check — no strikes needed.
 * Configurable via STALE_TASK_AGE_HOURS env var (default: 3).
 */
const STALE_TASK_AGE_HOURS = Number(process.env.STALE_TASK_AGE_HOURS || "3");
const STALE_TASK_AGE_MS = STALE_TASK_AGE_HOURS * 60 * 60 * 1000;

/**
 * Cooldown cache for tasks whose PRs have merge conflicts.
 * We re-trigger conflict resolution at most every 30 minutes per task.
 * Key = task ID, Value = timestamp of last resolution attempt.
 * @type {Map<string, number>}
 */
const conflictResolutionCooldown = new Map();
const CONFLICT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const CONFLICT_MAX_ATTEMPTS = 3; // Max resolution attempts per task before giving up
const conflictResolutionAttempts = new Map(); // task ID → attempt count

const RECOVERY_SKIP_CACHE_MS = 30 * 60 * 1000; // 30 minutes

// Load recovery cache on startup (after constants initialize)
loadRecoveryCache();

/**
 * Periodic check: find tasks in "inreview" status, check if their PRs
 * have been merged, and automatically move them to "done" status.
 * Also detects open PRs with merge conflicts and triggers resolution.
 */
async function checkMergedPRsAndUpdateTasks() {
  try {
    if (
      isWorkflowReplacingModule("task-executor.mjs") ||
      isWorkflowReplacingModule("monitor.mjs")
    ) {
      if (!workflowTaskReconcilePausedLogged) {
        workflowTaskReconcilePausedLogged = true;
        console.log(
          "[monitor] skipping legacy task-status reconciliation — handled by workflow replacement",
        );
      }
      return {
        checked: 0,
        movedDone: 0,
        movedReview: 0,
        movedTodo: 0,
        skippedByWorkflowReplacement: true,
      };
    }
    console.log("[monitor] Checking for merged PRs to update task status...");
    const workflowOwnsLegacyConflictResolution =
      isWorkflowReplacingModule("pr-cleanup-daemon.mjs") ||
      isWorkflowReplacingModule("monitor.mjs");

    const statuses = ["inreview", "inprogress"];
    const tasksByStatus = await Promise.all(
      statuses.map((status) => fetchTasksByStatus(status)),
    );
    const taskMap = new Map();
    statuses.forEach((status, index) => {
      for (const task of tasksByStatus[index]) {
        if (task?.id) {
          taskMap.set(task.id, { task, status });
        }
      }
    });
    const reviewTasks = [];
    let prunedMergedTaskCacheCount = 0;
    for (const entry of taskMap.values()) {
      const taskId = String(entry?.task?.id || "").trim();
      if (!taskId) continue;
      if (!mergedTaskCache.has(taskId)) {
        reviewTasks.push(entry);
        continue;
      }
      // Task is active (inprogress/inreview) so a previous done-cache entry
      // is stale (e.g. task reopened or status rollback) and must be purged.
      mergedTaskCache.delete(taskId);
      prunedMergedTaskCacheCount++;
      reviewTasks.push(entry);
    }
    if (prunedMergedTaskCacheCount > 0) {
      saveMergedTaskCache();
      console.log(
        `[monitor] Pruned ${prunedMergedTaskCacheCount} stale merged-task cache entr${prunedMergedTaskCacheCount === 1 ? "y" : "ies"} for active tasks`,
      );
    }
    if (reviewTasks.length === 0) {
      console.log(
        "[monitor] No tasks in review/inprogress status (after dedup)",
      );
      return { checked: 0, movedDone: 0, movedReview: 0 };
    }

    const totalCandidates = reviewTasks.length;
    const batch =
      MERGE_CHECK_BATCH_SIZE > 0
        ? reviewTasks.slice(0, MERGE_CHECK_BATCH_SIZE)
        : reviewTasks;
    console.log(
      `[monitor] Found ${totalCandidates} tasks in review/inprogress` +
        (MERGE_CHECK_BATCH_SIZE > 0 && totalCandidates > MERGE_CHECK_BATCH_SIZE
          ? ` (processing first ${MERGE_CHECK_BATCH_SIZE})`
          : ""),
    );

    // For each task, get its workspace/branch and check if merged
    const statusData = await readStatusData();
    const attempts = Array.isArray(statusData?.active_attempts)
      ? statusData.active_attempts
      : Object.values(statusData?.attempts || {});

    // Also fetch VK task-attempts as fallback (covers archived attempts
    // that are no longer in the orchestrator's status file)
    let vkAttempts = [];
    try {
      const vkRes = await fetchVk("/api/task-attempts");
      const vkData = vkRes?.data ?? vkRes;
      if (Array.isArray(vkData)) {
        vkAttempts = vkData;
      }
    } catch {
      /* best-effort fallback */
    }

    let movedCount = 0;
    let movedReviewCount = 0;
    let movedTodoCount = 0;
    let conflictsTriggered = 0;
    /** @type {string[]} */
    const completedTaskNames = [];
    /** @type {string[]} */
    const recoveredTaskNames = [];

    for (const entry of batch) {
      const task = entry.task;
      const taskStatus = entry.status;
      // Find the attempt associated with this task — first in local status,
      // then fall back to the VK API (which includes archived attempts)
      let attempt = attempts.find((a) => a?.task_id === task.id);
      if (!attempt) {
        // VK API fallback: find the most recent attempt for this task
        const vkMatch = vkAttempts
          .filter((a) => a?.task_id === task.id)
          .sort(
            (a, b) =>
              new Date(b.created_at).getTime() -
              new Date(a.created_at).getTime(),
          );
        if (vkMatch.length > 0) {
          attempt = vkMatch[0];
          console.log(
            `[monitor] Found VK attempt for task "${task.title}" via API fallback (branch: ${attempt.branch})`,
          );
        } else {
          if (shouldLogNoAttempt(task, taskStatus, "no_attempt")) {
            console.log(
              `[monitor] No attempt found for task "${task.title}" (${task.id.substring(0, 8)}...) — cannot resolve branch/PR`,
            );
            recordNoAttemptLog(task, taskStatus, "no_attempt");
          }
        }
      }
      const branch =
        attempt?.branch ||
        task?.branch ||
        task?.workspace_branch ||
        task?.git_branch;
      const prNumber =
        attempt?.pr_number ||
        task?.pr_number ||
        parsePrNumberFromUrl(attempt?.pr_url) ||
        parsePrNumberFromUrl(task?.pr_url);
      let prInfo = null;
      if (prNumber) {
        prInfo = await getPullRequestByNumber(prNumber);
      }
      const isMerged =
        !!prInfo?.mergedAt ||
        (!!prInfo?.merged_at && prInfo.merged_at !== null);
      const prState = prInfo?.state ? String(prInfo.state).toUpperCase() : "";

      // ── Skip cancelled/done tasks — they should never be recovered ──
      if (taskStatus === "cancelled" || taskStatus === "done") {
        continue;
      }

      // ── Recovery skip cache: skip tasks we already resolved recently ──
      // safeRecoverTask caches tasks that are already todo/cancelled/done,
      // so we skip the entire branch/PR lookup and recovery attempt.
      const skipEntry = recoverySkipCache.get(task.id);
      if (skipEntry) {
        // For fetch-failed entries, use a shorter TTL (5 min) regardless of task version.
        // These aren't tied to a specific task state — just API unavailability.
        if (skipEntry.resolvedStatus === "fetch-failed") {
          const FETCH_FAIL_BACKOFF_MS = 5 * 60 * 1000;
          if (Date.now() - skipEntry.timestamp < FETCH_FAIL_BACKOFF_MS) {
            continue;
          }
          recoverySkipCache.delete(task.id);
          scheduleRecoveryCacheSave();
        } else if (!taskVersionMatches(task, skipEntry, taskStatus)) {
          recoverySkipCache.delete(task.id);
          scheduleRecoveryCacheSave();
        } else if (Date.now() - skipEntry.timestamp < RECOVERY_SKIP_CACHE_MS) {
          continue;
        }
      }

      // ── Stale cooldown: skip tasks we already checked recently ──
      const staleEntry = staleBranchCooldown.get(task.id);
      if (staleEntry) {
        if (!taskVersionMatches(task, staleEntry, taskStatus)) {
          staleBranchCooldown.delete(task.id);
          scheduleRecoveryCacheSave();
        } else if (Date.now() - staleEntry.lastCheck < STALE_COOLDOWN_MS) {
          continue;
        }
      }

      // ── Gather ALL attempts for this task (local + VK API) ──
      // VK can have multiple attempts with different branches. An older
      // attempt may have the merged PR while the newest was abandoned.
      const localAttempt = attempts.find((a) => a?.task_id === task.id);
      const allVkAttempts = vkAttempts
        .filter((a) => a?.task_id === task.id)
        .sort(
          (a, b) =>
            new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
        );

      // Build a deduplicated list of all branches + PR numbers to check
      /** @type {Array<{branch?: string, prNumber?: number, attemptId?: string, baseBranch?: string}>} */
      const candidates = [];
      const seenBranches = new Set();

      const addCandidate = (src) => {
        const b = src?.branch;
        const pr = src?.pr_number || parsePrNumberFromUrl(src?.pr_url);
        const aid = src?.id; // attempt UUID
        const baseBranch = resolveAttemptTargetBranch(src, task);
        if (b && !seenBranches.has(b)) {
          seenBranches.add(b);
          candidates.push({
            branch: b,
            prNumber: pr || undefined,
            attemptId: aid,
            baseBranch,
          });
        } else if (b && baseBranch) {
          const existing = candidates.find((c) => c.branch === b);
          if (existing && !existing.baseBranch) {
            existing.baseBranch = baseBranch;
          }
        } else if (pr && !candidates.some((c) => c.prNumber === pr)) {
          candidates.push({
            branch: b,
            prNumber: pr,
            attemptId: aid,
            baseBranch,
          });
        }
      };

      if (localAttempt) addCandidate(localAttempt);
      for (const a of allVkAttempts) addCandidate(a);
      // Also check task-level fields
      addCandidate({
        branch: task?.branch || task?.workspace_branch || task?.git_branch,
        pr_number: task?.pr_number,
        pr_url: task?.pr_url,
      });

      if (candidates.length > 0) {
        if (noAttemptLogCache.delete(task.id)) {
          scheduleRecoveryCacheSave();
        }
      }

      if (candidates.length === 0) {
        // ── Internal executor guard ──
        // If the internal executor is managing this task (active, cooldown,
        // or blocked), do NOT recover it — the executor handles its own lifecycle.
        if (
          internalTaskExecutor &&
          internalTaskExecutor.isTaskManaged?.(task.id)
        ) {
          if (
            shouldLogNoAttempt(task, taskStatus, "internal_executor_managed")
          ) {
            console.log(
              `[monitor] Task "${task.title}" (${task.id.substring(0, 8)}...) is managed by internal executor — skipping recovery`,
            );
            recordNoAttemptLog(task, taskStatus, "internal_executor_managed");
          }
          continue;
        }

        // ── Recover only idle inprogress/inreview tasks ──
        // inprogress/inreview tasks with an active agent should not be touched.
        if (!isRecoverableIdleStatus(taskStatus)) {
          if (shouldLogNoAttempt(task, taskStatus, "no_attempt_skip_status")) {
            console.log(
              `[monitor] No attempt found for task "${task.title}" (${task.id.substring(0, 8)}...) in ${taskStatus} — skipping (only idle inprogress/inreview tasks are recovered)`,
            );
            recordNoAttemptLog(task, taskStatus, "no_attempt_skip_status");
          }
          continue;
        }

        // Check if an agent is actively working on this task
        const hasActiveAgent =
          task.has_in_progress_attempt === true || !!localAttempt;
        if (hasActiveAgent) {
          console.log(
            `[monitor] Task "${task.title}" (${task.id.substring(0, 8)}...) has active agent — skipping recovery`,
          );
          continue;
        }

        // ── Age-based immediate recovery ──
        // If the task has been stuck for longer than STALE_TASK_AGE_MS
        // with no active agent and no branch/PR, move it to todo immediately.
        const taskAge = getTaskAgeMs(task);
        if (taskAge >= STALE_TASK_AGE_MS) {
          const ageHours = (taskAge / (60 * 60 * 1000)).toFixed(1);
          console.log(
            `[monitor] No attempt found for idle ${taskStatus} task "${task.title}" (${task.id.substring(0, 8)}...) — stale for ${ageHours}h, attempting recovery`,
          );
          const success = await safeRecoverTask(
            task.id,
            task.title,
            `age-based: ${taskStatus}, ${ageHours}h, no agent, no branch/PR`,
          );
          if (success) {
            movedTodoCount++;
            recoveredTaskNames.push(task.title);
            staleBranchCooldown.delete(task.id);
            scheduleRecoveryCacheSave();
          }
          continue;
        }

        const prev = staleBranchCooldown.get(task.id);
        const strikes = (prev?.strikes || 0) + 1;
        staleBranchCooldown.set(task.id, {
          lastCheck: Date.now(),
          strikes,
          updatedAt: getTaskUpdatedAt(task),
          status: taskStatus,
        });
        scheduleRecoveryCacheSave();
        console.log(
          `[monitor] No attempt found for idle ${taskStatus} task "${task.title}" (${task.id.substring(0, 8)}...) — strike ${strikes}/${STALE_MAX_STRIKES}`,
        );
        if (strikes >= STALE_MAX_STRIKES) {
          const success = await safeRecoverTask(
            task.id,
            task.title,
            `no branch/PR after ${strikes} checks (${taskStatus})`,
          );
          if (success) {
            movedTodoCount++;
            recoveredTaskNames.push(task.title);
            staleBranchCooldown.delete(task.id);
            scheduleRecoveryCacheSave();
          }
        }
        continue;
      }

      if (allVkAttempts.length > 0) {
        const branches = candidates.map((c) => c.branch).filter(Boolean);
        console.log(
          `[monitor] Task "${task.title}": checking ${candidates.length} attempt(s) [${branches.join(", ")}]`,
        );
      }

      // ── Branch-level dedup: skip if ANY branch is already known-merged ──
      const knownBranch = candidates.find(
        (c) => c.branch && hasMergedBranchCache(c.branch),
      );
      if (knownBranch?.branch) {
        const cachedStillMerged = await isMergedBranchCacheEntryStillValid(
          knownBranch.branch,
          knownBranch.baseBranch,
        );
        if (cachedStillMerged) {
          const canFinalize = await shouldFinalizeMergedTask(task, {
            branch: knownBranch.branch,
            prNumber: knownBranch.prNumber,
            reason: "known_merged_branch",
          });
          if (!canFinalize) {
            continue;
          }
          mergedTaskCache.add(task.id);
          pendingMergeStrategyByTask.delete(String(task.id || "").trim());
          // Cache all branches for this task
          for (const c of candidates) {
            if (c.branch) addMergedBranchCache(c.branch);
          }
          saveMergedTaskCache();
          void updateTaskStatus(task.id, "done", {
            taskData: task,
            workflowEvent: "pr.merged",
            workflowData: {
              prNumber: knownBranch.prNumber || null,
              branch: knownBranch.branch || null,
              triggerReason: "known_merged_branch",
            },
          });
          continue;
        }
      }

      // ── Check ALL candidates for a merged PR/branch ──
      let resolved = false;
      let hasOpenPR = false;
      let firstOpenPr = null;
      /** @type {Array<{prNumber: number, attemptId?: string, branch?: string}>} */
      const conflictCandidates = [];

      for (const cand of candidates) {
        // Check PR by number first (cheapest)
        if (cand.prNumber) {
          const prInfo = await getPullRequestByNumber(cand.prNumber);
          const isMerged =
            !!prInfo?.mergedAt ||
            (!!prInfo?.merged_at && prInfo.merged_at !== null);
          const prState = prInfo?.state
            ? String(prInfo.state).toUpperCase()
            : "";

          if (isMerged) {
            // Assess completion confidence for merged PR
            const sizeLabel =
              task.title?.match(/\[(xs|s|m|l|xl|xxl)\]/i)?.[1] || "m";
            const taskComplexity = classifyComplexity({
              sizeLabel,
              title: task.title,
              description: task.description,
            });
            const confidence = assessCompletionConfidence({
              testsPass: true, // PR was merged → CI must have passed
              buildClean: true,
              lintClean: true,
              filesChanged: prInfo?.changed_files || prInfo?.changedFiles || 0,
              attemptCount: allVkAttempts.length || 1,
              complexityTier: taskComplexity.tier,
            });
            console.log(
              `[monitor] Task "${task.title}" (${task.id.substring(0, 8)}...) has merged PR #${cand.prNumber}, updating to done [confidence=${confidence.confidence}, ${confidence.reason}]`,
            );
            const canFinalize = await shouldFinalizeMergedTask(task, {
              branch: cand.branch,
              prNumber: cand.prNumber,
              reason: "merged_pr_detected",
            });
            if (!canFinalize) {
              resolved = true;
              break;
            }
            const success = await updateTaskStatus(task.id, "done", {
              taskData: task,
              workflowEvent: "pr.merged",
              workflowData: {
                prNumber: cand.prNumber || null,
                branch: cand.branch || null,
                baseBranch: cand.baseBranch || null,
                triggerReason: "merged_pr_detected",
              },
            });
            movedCount++;
            mergedTaskCache.add(task.id);
            pendingMergeStrategyByTask.delete(String(task.id || "").trim());
            for (const c of candidates) {
              if (c.branch) addMergedBranchCache(c.branch);
            }
            saveMergedTaskCache();
            completedTaskNames.push(task.title);
            if (success) {
              console.log(
                `[monitor] :check: Moved task "${task.title}" from ${taskStatus} → done`,
              );
            } else {
              console.warn(
                `[monitor] :alert: VK update failed for "${task.title}" — cached anyway (PR is merged)`,
              );
            }
            // ── Trigger downstream rebase for tasks on same upstream ──
            const mergedBase =
              cand.baseBranch ||
              resolveUpstreamFromTask(task) ||
              DEFAULT_TARGET_BRANCH;
            void rebaseDownstreamTasks(mergedBase, cand.attemptId);
            resolved = true;
            break;
          }
          if (prState === "OPEN") {
            hasOpenPR = true;
            if (!firstOpenPr) {
              firstOpenPr = {
                prNumber: cand.prNumber || null,
                branch: cand.branch || null,
                baseBranch: cand.baseBranch || null,
              };
            }
            // Detect merge conflicts on open PRs
            // gh CLI: mergeable = "CONFLICTING" / "MERGEABLE" / "UNKNOWN"
            // REST API: mergeable = false, mergeable_state = "dirty"
            const isConflicting =
              prInfo?.mergeable === "CONFLICTING" ||
              prInfo?.mergeable === false ||
              prInfo?.mergeable_state === "dirty" ||
              prInfo?.mergeStateStatus === "DIRTY";
            if (isConflicting) {
              conflictCandidates.push({
                prNumber: cand.prNumber,
                attemptId: cand.attemptId,
                branch: cand.branch,
              });
            }
          }
        }

        if (!cand.branch) continue;

        // Throttle between GitHub API calls
        if (MERGE_CHECK_THROTTLE_MS > 0) {
          await new Promise((r) => setTimeout(r, MERGE_CHECK_THROTTLE_MS));
        }

        // Check if the branch has been merged (checks gh + git)
        const merged = await isBranchMerged(cand.branch, cand.baseBranch);
        if (merged) {
          console.log(
            `[monitor] Task "${task.title}" (${task.id.substring(0, 8)}...) has merged branch ${cand.branch}, updating to done`,
          );
          const canFinalize = await shouldFinalizeMergedTask(task, {
            branch: cand.branch,
            prNumber: cand.prNumber,
            reason: "merged_branch_detected",
          });
          if (!canFinalize) {
            resolved = true;
            break;
          }
          const success = await updateTaskStatus(task.id, "done", {
            taskData: task,
            workflowEvent: "pr.merged",
            workflowData: {
              prNumber: cand.prNumber || null,
              branch: cand.branch || null,
              baseBranch: cand.baseBranch || null,
              triggerReason: "merged_branch_detected",
            },
          });
          movedCount++;
          mergedTaskCache.add(task.id);
          pendingMergeStrategyByTask.delete(String(task.id || "").trim());
          for (const c of candidates) {
            if (c.branch) addMergedBranchCache(c.branch);
          }
          saveMergedTaskCache();
          completedTaskNames.push(task.title);
          if (success) {
            console.log(
              `[monitor] :check: Moved task "${task.title}" from ${taskStatus} → done`,
            );
          } else {
            console.warn(
              `[monitor] :alert: VK update failed for "${task.title}" — cached anyway (branch is merged)`,
            );
          }
          // ── Trigger downstream rebase for tasks on same upstream ──
          const mergedBase2 =
            cand.baseBranch ||
            resolveUpstreamFromTask(task) ||
            DEFAULT_TARGET_BRANCH;
          void rebaseDownstreamTasks(mergedBase2, cand.attemptId);
          resolved = true;
          break;
        }

        // Branch not merged — look up its open PR and check for conflicts
        if (!cand.prNumber) {
          let branchPr = null;
          if (ghAvailable()) {
            branchPr = await findExistingPrForBranch(cand.branch);
          }
          if (!branchPr) {
            branchPr = await findExistingPrForBranchApi(cand.branch);
          }
          if (branchPr) {
            const bpState = String(branchPr.state).toUpperCase();
            if (bpState === "OPEN") {
              hasOpenPR = true;
              if (!firstOpenPr) {
                firstOpenPr = {
                  prNumber: branchPr.number || null,
                  branch: cand.branch || null,
                  baseBranch: branchPr.base?.ref || null,
                };
              }
              // Fetch full PR info (with mergeable) via number
              const fullPrInfo = await getPullRequestByNumber(branchPr.number);
              const isConflicting =
                fullPrInfo?.mergeable === "CONFLICTING" ||
                fullPrInfo?.mergeable === false ||
                fullPrInfo?.mergeable_state === "dirty" ||
                fullPrInfo?.mergeStateStatus === "DIRTY";
              if (isConflicting) {
                conflictCandidates.push({
                  prNumber: branchPr.number,
                  attemptId: cand.attemptId,
                  branch: cand.branch,
                });
                // Register as dirty for slot reservation + file-overlap
                registerDirtyTask({
                  taskId: task.id,
                  prNumber: branchPr.number,
                  branch: cand.branch,
                  title: task.title,
                  files: fullPrInfo?.files?.map((f) => f.filename || f) || [],
                });
              }
            }
          }
        }
      }

      if (resolved) continue;

      // ── Conflict resolution for open PRs with merge conflicts ──
      // DEDUPLICATION: The PS1 orchestrator owns direct rebase with persistent
      // disk-based cooldowns (survives restarts). monitor.mjs only defers to
      // the orchestrator by logging and registering the dirty task for slot
      // reservation. We do NOT trigger smartPRFlow("conflict") here to avoid
      // the thundering herd where both systems race to fix the same PR.
      if (conflictCandidates.length > 0) {
        if (workflowOwnsLegacyConflictResolution) {
          if (!workflowConflictResolverPausedLogged) {
            workflowConflictResolverPausedLogged = true;
            console.log(
              "[monitor] skipping legacy PR conflict resolver — handled by workflow replacement",
            );
          }
          continue;
        }
        const lastConflictCheck = conflictResolutionCooldown.get(task.id);
        const onCooldown =
          lastConflictCheck &&
          Date.now() - lastConflictCheck < CONFLICT_COOLDOWN_MS;
        const onDirtyCooldown = isOnResolutionCooldown(task.id);
        if (!onCooldown && !onDirtyCooldown) {
          // Check if we've exhausted max resolution attempts for this task
          const attempts = conflictResolutionAttempts.get(task.id) || 0;
          if (attempts >= CONFLICT_MAX_ATTEMPTS) {
            console.warn(
              `[monitor] :alert: Task "${task.title}" PR #${conflictCandidates[0].prNumber} conflict resolution exhausted (${attempts}/${CONFLICT_MAX_ATTEMPTS} attempts) — skipping`,
            );
          } else {
            conflictResolutionAttempts.set(task.id, attempts + 1);
            const cc = conflictCandidates[0];
            let resolveAttemptId = cc.attemptId;
            if (!resolveAttemptId) {
              const matchAttempt = allVkAttempts.find(
                (a) => a.branch === cc.branch || a.pr_number === cc.prNumber,
              );
              resolveAttemptId = matchAttempt?.id || localAttempt?.id;
            }
            if (resolveAttemptId) {
              const shortId = resolveAttemptId.substring(0, 8);
              conflictResolutionCooldown.set(task.id, Date.now());
              recordResolutionAttempt(task.id);

              const sdkOnCooldown = isSDKResolutionOnCooldown(cc.branch);
              const sdkExhausted = isSDKResolutionExhausted(cc.branch);

              if (!sdkOnCooldown && !sdkExhausted) {
                console.log(
                  `[monitor] :alert: Task "${task.title}" PR #${cc.prNumber} has merge conflicts — launching SDK resolver (attempt ${shortId})`,
                );
                if (telegramToken && telegramChatId) {
                  void sendTelegramMessage(
                    `:git: PR #${cc.prNumber} for "${task.title}" has merge conflicts — launching SDK resolver (attempt ${shortId})`,
                  );
                }

                let worktreePath = null;
                const attemptInfo = await getAttemptInfo(resolveAttemptId);
                worktreePath =
                  attemptInfo?.worktree_dir || attemptInfo?.worktree || null;
                if (!worktreePath) {
                  worktreePath = findWorktreeForBranch(cc.branch);
                }

                // Create worktree via centralized manager if none found
                if (!worktreePath && cc.branch) {
                  try {
                    const taskKey = task.id || cc.branch;
                    const wt = await acquireWorktree(repoRoot, cc.branch, taskKey, {
                      owner: "monitor-conflict",
                    });
                    if (wt?.path) {
                      worktreePath = wt.path;
                      console.log(
                        `[monitor] Acquired worktree for ${cc.branch} at ${wt.path} (${wt.created ? "created" : "existing"})`,
                      );
                    }
                  } catch (wErr) {
                    console.warn(
                      `[monitor] Worktree acquisition error: ${wErr.message}`,
                    );
                  }
                }

                if (worktreePath) {
                  void (async () => {
                    try {
                      const result = await resolveConflictsWithSDK({
                        worktreePath,
                        branch: cc.branch,
                        baseBranch: resolveAttemptTargetBranch(
                          attemptInfo,
                          task,
                        ),
                        prNumber: cc.prNumber,
                        taskTitle: task.title,
                        taskDescription: task.description || "",
                        logDir: logDir,
                        promptTemplate: agentPrompts?.sdkConflictResolver,
                      });
                      if (result.success) {
                        console.log(
                          `[monitor] :check: SDK resolved conflicts for PR #${cc.prNumber} (${result.resolvedFiles.length} files)`,
                        );
                        clearDirtyTask(task.id);
                        clearSDKResolutionState(cc.branch);
                        conflictResolutionAttempts.delete(task.id); // Reset on success
                        if (telegramToken && telegramChatId) {
                          void sendTelegramMessage(
                            `:check: SDK resolved merge conflicts for PR #${cc.prNumber} "${task.title}" (${result.resolvedFiles.length} files)`,
                          );
                        }
                      } else {
                        console.warn(
                          `[monitor] :close: SDK conflict resolution failed for PR #${cc.prNumber}: ${result.error}`,
                        );
                        if (telegramToken && telegramChatId) {
                          void sendTelegramMessage(
                            `:close: SDK conflict resolution failed for PR #${cc.prNumber} "${task.title}": ${result.error}\nFalling back to orchestrator.`,
                          );
                        }
                        conflictsTriggered++;
                        void smartPRFlow(resolveAttemptId, shortId, "conflict");
                      }
                    } catch (err) {
                      console.warn(
                        `[monitor] SDK conflict resolution threw: ${err.message}`,
                      );
                    }
                  })();
                } else {
                  console.warn(
                    `[monitor] No worktree found for ${cc.branch} — deferring to orchestrator`,
                  );
                  if (telegramToken && telegramChatId) {
                    void sendTelegramMessage(
                      `:git: PR #${cc.prNumber} for "${task.title}" has merge conflicts — no worktree, orchestrator will handle (attempt ${shortId})`,
                    );
                  }
                  conflictsTriggered++;
                  void smartPRFlow(resolveAttemptId, shortId, "conflict");
                }
              } else {
                const reason = sdkExhausted
                  ? "SDK attempts exhausted"
                  : "SDK on cooldown";
                console.log(
                  `[monitor] :alert: Task "${task.title}" PR #${cc.prNumber} has merge conflicts — ${reason}, deferring to orchestrator (attempt ${shortId})`,
                );
                if (telegramToken && telegramChatId) {
                  void sendTelegramMessage(
                    `:git: PR #${cc.prNumber} for "${task.title}" has merge conflicts — ${reason}, orchestrator will handle (attempt ${shortId})`,
                  );
                }
                conflictsTriggered++;
                void smartPRFlow(resolveAttemptId, shortId, "conflict");
              }
            } else {
              console.warn(
                `[monitor] Task "${task.title}" PR #${cc.prNumber} has conflicts but no attempt ID — cannot trigger resolution`,
              );
            }
          }
        }
      }

      // Task is NOT merged via any attempt — handle accordingly
      if (hasOpenPR && taskStatus !== "inreview") {
        const success = await updateTaskStatus(task.id, "inreview", {
          taskData: task,
          workflowEvent: "pr.opened",
          workflowData: {
            prNumber: firstOpenPr?.prNumber || null,
            branch: firstOpenPr?.branch || null,
            baseBranch: firstOpenPr?.baseBranch || null,
          },
        });
        if (success) {
          movedReviewCount++;
          console.log(
            `[monitor] :check: Moved task "${task.title}" from ${taskStatus} → inreview`,
          );
        }
      } else if (!hasOpenPR) {
        // ── Recover only idle inprogress/inreview tasks ──
        if (!isRecoverableIdleStatus(taskStatus)) {
          console.log(
            `[monitor] Task "${task.title}" (${task.id.substring(0, 8)}...): no open PR but status=${taskStatus} — skipping recovery`,
          );
          continue;
        }

        // Check if an agent is actively working on this task
        const hasActiveAgent =
          task.has_in_progress_attempt === true || !!localAttempt;
        if (hasActiveAgent) {
          console.log(
            `[monitor] Task "${task.title}" (${task.id.substring(0, 8)}...): no open PR but agent is active — skipping recovery`,
          );
          continue;
        }

        // Genuinely idle inprogress task with no open PR — recover
        const taskAge = getTaskAgeMs(task);
        if (taskAge >= STALE_TASK_AGE_MS) {
          const ageHours = (taskAge / (60 * 60 * 1000)).toFixed(1);
          console.log(
            `[monitor] Idle ${taskStatus} task "${task.title}" (${task.id.substring(0, 8)}...): no branch/PR, stale for ${ageHours}h — attempting recovery`,
          );
          const success = await safeRecoverTask(
            task.id,
            task.title,
            `age-based: ${taskStatus}, ${ageHours}h, no agent, no branch/PR`,
          );
          if (success) {
            movedTodoCount++;
            recoveredTaskNames.push(task.title);
            staleBranchCooldown.delete(task.id);
            scheduleRecoveryCacheSave();
          }
        } else {
          // Not old enough — use the strike-based system
          const prev = staleBranchCooldown.get(task.id);
          const strikes = (prev?.strikes || 0) + 1;
          staleBranchCooldown.set(task.id, {
            lastCheck: Date.now(),
            strikes,
            updatedAt: getTaskUpdatedAt(task),
            status: taskStatus,
          });
          scheduleRecoveryCacheSave();
          console.log(
            `[monitor] Idle ${taskStatus} task "${task.title}" (${task.id.substring(0, 8)}...): no branch, no PR (strike ${strikes}/${STALE_MAX_STRIKES})`,
          );
          if (strikes >= STALE_MAX_STRIKES) {
            const success = await safeRecoverTask(
              task.id,
              task.title,
              `abandoned ${taskStatus} — ${strikes} stale checks`,
            );
            if (success) {
              movedTodoCount++;
              recoveredTaskNames.push(task.title);
              staleBranchCooldown.delete(task.id);
              scheduleRecoveryCacheSave();
            }
          }
        }
      }
    }

    // Send a single aggregated Telegram notification
    if (movedCount > 0 && telegramToken && telegramChatId) {
      if (movedCount <= 3) {
        // Few tasks — list them individually
        for (const name of completedTaskNames) {
          void sendTelegramMessage(`:check: Task completed: "${name}"`);
        }
      } else {
        // Many tasks — send a single summary to avoid spam
        const listed = completedTaskNames
          .slice(0, 5)
          .map((n) => `• ${n}`)
          .join("\n");
        const extra = movedCount > 5 ? `\n…and ${movedCount - 5} more` : "";
        void sendTelegramMessage(
          `:check: ${movedCount} tasks moved to done:\n${listed}${extra}`,
        );
      }
    }

    if (movedCount > 0) {
      console.log(`[monitor] Moved ${movedCount} merged tasks to done status`);
    }
    if (movedReviewCount > 0) {
      console.log(
        `[monitor] Moved ${movedReviewCount} tasks to inreview (PR open)`,
      );
    }
    console.log(`[monitor] ${formatDirtyTaskSummary()}`);
    if (conflictsTriggered > 0) {
      console.log(
        `[monitor] Triggered conflict resolution for ${conflictsTriggered} PR(s)`,
      );
    }
    // Notify about tasks recovered to todo
    if (movedTodoCount > 0) {
      console.log(
        `[monitor] Recovered ${movedTodoCount} abandoned tasks to todo`,
      );
      if (telegramToken && telegramChatId) {
        if (movedTodoCount <= 3) {
          for (const name of recoveredTaskNames) {
            void sendTelegramMessage(
              `:repeat: Task recovered to todo (abandoned — no branch/PR): "${name}"`,
            );
          }
        } else {
          const listed = recoveredTaskNames
            .slice(0, 5)
            .map((n) => `• ${n}`)
            .join("\n");
          const extra =
            movedTodoCount > 5 ? `\n…and ${movedTodoCount - 5} more` : "";
          void sendTelegramMessage(
            `:repeat: ${movedTodoCount} abandoned tasks recovered to todo:\n${listed}${extra}`,
          );
        }
      }
    }
    return {
      checked: batch.length,
      movedDone: movedCount,
      movedReview: movedReviewCount,
      movedTodo: movedTodoCount,
      conflictsTriggered,
      cached: mergedTaskCache.size,
    };
  } catch (err) {
    console.warn(`[monitor] Error checking merged PRs: ${err.message || err}`);
    return {
      checked: 0,
      movedDone: 0,
      movedReview: 0,
      movedTodo: 0,
      error: err,
    };
  }
}

async function reconcileTaskStatuses(reason = "manual") {
  console.log(`[monitor] Reconciling VK tasks (${reason})...`);
  return await checkMergedPRsAndUpdateTasks();
}

// ── Epic Branch Orchestration ───────────────────────────────────────────────

const EPIC_COMPLETE_STATUSES = new Set(["done", "cancelled"]);

function normalizeTaskStatusForEpic(status) {
  return String(status || "").trim().toLowerCase();
}

function isEpicTaskComplete(task) {
  const status = normalizeTaskStatusForEpic(task?.status);
  if (!status) return false;
  return EPIC_COMPLETE_STATUSES.has(status);
}

function buildEpicCacheKey(headBranch, baseBranch) {
  const head = normalizeBranchName(headBranch) || "";
  const base = normalizeBranchName(baseBranch) || "";
  return `${head}::${base}`;
}

async function listTasksForEpicCheck(projectId) {
  const backend = getActiveKanbanBackend();
  const seen = new Map();

  const addTasks = (tasks = []) => {
    for (const task of tasks) {
      const id = String(task?.id || task?.task_id || "");
      if (!id) continue;
      if (!seen.has(id)) seen.set(id, task);
    }
  };

  try {
    const primary = await listKanbanTasks(projectId, {});
    addTasks(Array.isArray(primary) ? primary : []);
  } catch (err) {
    console.warn(
      `[monitor] epic check failed to list tasks: ${err.message || err}`,
    );
  }

  if (backend === "github") {
    try {
      const closed = await listKanbanTasks(projectId, { status: "done" });
      addTasks(Array.isArray(closed) ? closed : []);
    } catch (err) {
      console.warn(
        `[monitor] epic check failed to list closed tasks: ${err.message || err}`,
      );
    }
  }

  return [...seen.values()];
}

function groupTasksByEpicBranch(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const resolved =
      resolveUpstreamFromTask(task) ||
      normalizeBranchName(task?.baseBranch || task?.base_branch) ||
      DEFAULT_TARGET_BRANCH;
    const baseBranch = normalizeBranchName(resolved) || DEFAULT_TARGET_BRANCH;
    const key = normalizeBranchForCompare(baseBranch);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { baseBranch, tasks: [] });
    }
    groups.get(key).tasks.push(task);
  }
  return groups;
}

function getRepoSlugForEpic() {
  return (
    repoSlug ||
    process.env.GITHUB_REPOSITORY ||
    (process.env.GITHUB_REPO_OWNER && process.env.GITHUB_REPO_NAME
      ? `${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}`
      : null)
  );
}

function createEpicMergeTitle(headName, baseName) {
  return `Epic Merge: ${headName} → ${baseName}`;
}

function buildEpicMergeBody(tasks, headName, baseName) {
  const lines = [
    "## Epic Merge",
    "",
    `Epic branch: \`${headName}\``,
    `Target branch: \`${baseName}\``,
    "",
    "Completed tasks:",
  ];
  const safeTasks = Array.isArray(tasks) ? tasks : [];
  const maxList = 25;
  const slice = safeTasks.slice(0, maxList);
  for (const task of slice) {
    const title = String(task?.title || task?.name || "Untitled task").trim();
    const id = task?.id ? ` (${task.id})` : "";
    lines.push(`- ${title}${id}`);
  }
  if (safeTasks.length > maxList) {
    lines.push(`- ...and ${safeTasks.length - maxList} more`);
  }
  lines.push("");
  lines.push("---");
  lines.push("*Created by [Bosun Bot](https://github.com/apps/bosun-ve)*");
  return lines.join("\n");
}

function summarizeEpicBranch(headBranch, baseBranch) {
  const headInfo = splitRemoteRef(headBranch, "origin");
  const baseInfo = splitRemoteRef(baseBranch, "origin");
  return { headInfo, baseInfo };
}

function parseGhJsonResult(raw, fallback = []) {
  try {
    return JSON.parse(raw || "[]");
  } catch {
    return fallback;
  }
}

function readEpicPrInfo(headBranch, baseBranch) {
  const slug = getRepoSlugForEpic();
  if (!slug || !ghAvailable()) return null;
  const { headInfo, baseInfo } = summarizeEpicBranch(headBranch, baseBranch);
  try {
    const listCmd = `gh pr list --repo ${slug} --head "${headInfo.name}" --base "${baseInfo.name}" --state all --json number,state,url,mergedAt`;
    const listResult = execSync(listCmd, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    const entries = parseGhJsonResult(listResult, []);
    if (!entries.length) return null;
    const pr = entries[0];
    let detail = {};
    try {
      const viewCmd = `gh pr view ${pr.number} --repo ${slug} --json number,state,url,mergeable,mergeable_state,mergeStateStatus,baseRefName,headRefName`;
      const viewResult = execSync(viewCmd, {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 20_000,
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      detail = parseGhJsonResult(viewResult, {});
    } catch {
      /* best-effort */
    }
    return { ...pr, ...detail };
  } catch {
    return null;
  }
}

function detectPrConflicts(prInfo) {
  if (!prInfo) return false;
  return (
    prInfo.mergeable === "CONFLICTING" ||
    prInfo.mergeable === false ||
    prInfo.mergeable_state === "dirty" ||
    prInfo.mergeStateStatus === "DIRTY"
  );
}

function detectFailedChecks(checks = []) {
  return checks.some((check) => {
    const state = String(check?.state || "").toUpperCase();
    const conclusion = String(check?.conclusion || "").toUpperCase();
    const signal = conclusion || state;
    return (
      signal === "FAILURE" ||
      signal === "FAILED" ||
      signal === "ERROR" ||
      signal === "CANCELLED" ||
      signal === "TIMED_OUT" ||
      signal === "ACTION_REQUIRED"
    );
  });
}

async function readRequiredChecks(prNumber) {
  const slug = getRepoSlugForEpic();
  if (!slug || !ghAvailable() || !prNumber) return [];
  try {
    const checksCmd = `gh pr checks ${prNumber} --repo ${slug} --json name,state --required`;
    const checksResult = execSync(checksCmd, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return parseGhJsonResult(checksResult, []);
  } catch {
    return [];
  }
}

function getEpicMergeReadiness(headBranch, baseBranch) {
  const { headInfo, baseInfo } = summarizeEpicBranch(headBranch, baseBranch);
  const headRef = `${headInfo.remote}/${headInfo.name}`;
  const baseRef = `${baseInfo.remote}/${baseInfo.name}`;
  const runGit = (args) =>
    spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
    });

  const headExistsRes = runGit([
    "ls-remote",
    "--heads",
    headInfo.remote,
    headInfo.name,
  ]);
  if (headExistsRes.status !== 0 || !String(headExistsRes.stdout || "").trim()) {
    return { ready: false, reason: "head-missing" };
  }

  const baseExistsRes = runGit([
    "ls-remote",
    "--heads",
    baseInfo.remote,
    baseInfo.name,
  ]);
  if (baseExistsRes.status !== 0 || !String(baseExistsRes.stdout || "").trim()) {
    return { ready: false, reason: "base-missing" };
  }

  const fetchHead = runGit(["fetch", headInfo.remote, headInfo.name, "--quiet"]);
  const fetchBase = runGit(["fetch", baseInfo.remote, baseInfo.name, "--quiet"]);
  if (fetchHead.status !== 0 || fetchBase.status !== 0) {
    return { ready: false, reason: "fetch-failed" };
  }

  const aheadRes = runGit(["rev-list", "--count", `${baseRef}..${headRef}`]);
  if (aheadRes.status !== 0) {
    return { ready: false, reason: "ahead-unknown" };
  }
  const aheadCount = Number(String(aheadRes.stdout || "").trim());
  if (!Number.isFinite(aheadCount) || aheadCount < 0) {
    return { ready: false, reason: "ahead-unknown" };
  }
  if (aheadCount === 0) {
    return { ready: false, reason: "no-commits", aheadCount: 0 };
  }
  return { ready: true, reason: "ready", aheadCount };
}

async function createEpicMergePr(headBranch, baseBranch, tasks) {
  const slug = getRepoSlugForEpic();
  if (!slug || !ghAvailable()) return null;
  const { headInfo, baseInfo } = summarizeEpicBranch(headBranch, baseBranch);
  const title = createEpicMergeTitle(headInfo.name, baseInfo.name);
  const body = buildEpicMergeBody(tasks, headInfo.name, baseInfo.name);
  const readiness = getEpicMergeReadiness(headBranch, baseBranch);
  if (!readiness.ready) {
    if (
      readiness.reason === "no-commits" ||
      readiness.reason === "head-missing" ||
      readiness.reason === "base-missing"
    ) {
      console.log(
        `[monitor] skipping epic PR create for ${headInfo.name} -> ${baseInfo.name}: ${readiness.reason}`,
      );
      return {
        skipped: true,
        reason: readiness.reason,
        head: headInfo.name,
        base: baseInfo.name,
        aheadCount:
          typeof readiness.aheadCount === "number" ? readiness.aheadCount : null,
      };
    }
  }
  try {
    const result = spawnSync(
      "gh",
      [
        "pr",
        "create",
        "--repo",
        slug,
        "--head",
        headInfo.name,
        "--base",
        baseInfo.name,
        "--title",
        title,
        "--body",
        body,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    if (result.status !== 0) {
      const msg = result.stderr || result.stdout || "";
      console.warn(
        `[monitor] failed to create epic PR for ${headInfo.name}: ${String(msg).slice(0, 200)}`,
      );
      return null;
    }
    const output = (result.stdout || "").trim();
    const url =
      output.split(/\s+/).find((item) => item.startsWith("http")) || output;
    return {
      url: url || null,
      title,
      head: headInfo.name,
      base: baseInfo.name,
    };
  } catch (err) {
    const msg = err?.stderr || err?.message || String(err || "");
    console.warn(
      `[monitor] failed to create epic PR for ${headInfo.name}: ${msg.slice(0, 200)}`,
    );
    return null;
  }
}

async function enableEpicAutoMerge(prNumber) {
  const slug = getRepoSlugForEpic();
  if (!slug || !ghAvailable() || !prNumber) return false;
  try {
    const cmd = `gh pr merge ${prNumber} --repo ${slug} --merge --auto`;
    execSync(cmd, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

async function ensureEpicConflictTask(
  projectId,
  tasks,
  epicBranch,
  baseBranch,
  reason,
  prInfo,
) {
  const epicName = splitRemoteRef(epicBranch, "origin").name;
  const existing = (tasks || []).find((task) => {
    const title = String(task?.title || "").toLowerCase();
    const status = normalizeTaskStatusForEpic(task?.status);
    if (EPIC_COMPLETE_STATUSES.has(status)) return false;
    return (
      title.includes("epic merge") &&
      title.includes(epicName.toLowerCase()) &&
      title.includes("resolve")
    );
  });
  if (existing) return existing;

  const prText = prInfo?.number ? `PR #${prInfo.number}` : "PR";
  const prUrl = prInfo?.url ? `\n\n${prInfo.url}` : "";
  const title = `[m] Resolve epic merge for ${epicName}`;
  const description = [
    `Epic merge needs manual intervention (${reason}).`,
    "",
    `Epic branch: ${epicBranch}`,
    `Target branch: ${baseBranch}`,
    `${prText} requires fixes.${prUrl}`,
    "",
    "## Implementation Steps",
    "- Rebase or merge the target branch into the epic branch.",
    "- Resolve conflicts and run required checks.",
    "- Push updates to the epic branch and ensure the PR is clean.",
    "",
    "## Verification",
    "- PR shows mergeable and required checks pass.",
  ].join("\n");

  return await createKanbanTask(projectId, {
    title,
    description,
    status: "todo",
    baseBranch: epicBranch,
  });
}

function ensureEpicBranchAvailable(headBranch, baseBranch) {
  const headInfo = splitRemoteRef(headBranch, "origin");
  const baseInfo = splitRemoteRef(baseBranch, "origin");
  const localRef = `refs/heads/${headInfo.name}`;
  const localCheck = spawnSync("git", ["show-ref", "--verify", localRef], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5000,
  });
  if (localCheck.status === 0) {
    return headInfo.name;
  }

  let remoteExists = false;
  try {
    const remoteCheck = spawnSync(
      "git",
      ["ls-remote", "--heads", headInfo.remote, headInfo.name],
      { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
    );
    remoteExists =
      remoteCheck.status === 0 && (remoteCheck.stdout || "").trim().length > 0;
  } catch {
    remoteExists = false;
  }

  if (remoteExists) {
    spawnSync("git", ["fetch", headInfo.remote, headInfo.name, "--quiet"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 15000,
    });
    spawnSync("git", ["branch", headInfo.name, `${headInfo.remote}/${headInfo.name}`], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 8000,
    });
    return headInfo.name;
  }

  spawnSync("git", ["fetch", baseInfo.remote, baseInfo.name, "--quiet"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15000,
  });
  const createRes = spawnSync(
    "git",
    ["branch", headInfo.name, `${baseInfo.remote}/${baseInfo.name}`],
    { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
  );
  if (createRes.status !== 0) {
    const stderr = (createRes.stderr || "").trim();
    console.warn(
      `[monitor] failed to create epic branch ${headInfo.name} from ${baseInfo.remote}/${baseInfo.name}: ${stderr}`,
    );
    return headInfo.name;
  }
  spawnSync("git", ["push", "-u", headInfo.remote, headInfo.name], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  return headInfo.name;
}

async function syncEpicBranchWithDefault(epicBranch, defaultBranch) {
  const headInfo = splitRemoteRef(epicBranch, "origin");
  const baseInfo = splitRemoteRef(defaultBranch, "origin");

  spawnSync("git", ["fetch", headInfo.remote, headInfo.name, "--quiet"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15000,
  });
  spawnSync("git", ["fetch", baseInfo.remote, baseInfo.name, "--quiet"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 15000,
  });

  const behindRes = spawnSync(
    "git",
    ["rev-list", "--count", `${headInfo.remote}/${headInfo.name}..${baseInfo.remote}/${baseInfo.name}`],
    { cwd: repoRoot, encoding: "utf8", timeout: 8000 },
  );
  const behindCount = Number((behindRes.stdout || "").trim());
  if (!Number.isFinite(behindCount) || behindCount <= 0) {
    return { synced: false, behind: 0 };
  }

  ensureEpicBranchAvailable(epicBranch, defaultBranch);
  const worktreeKey = `epic-sync:${headInfo.name}`;
  const worktree = await acquireWorktree(repoRoot, headInfo.name, worktreeKey, {
    owner: "epic-sync",
  });

  try {
    const headBefore = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf8",
      timeout: 5000,
    }).stdout?.trim();

    const mergeRes = spawnSync(
      "git",
      ["merge", "--no-edit", `${baseInfo.remote}/${baseInfo.name}`],
      { cwd: worktree.path, encoding: "utf8", timeout: 120_000 },
    );
    if (mergeRes.status !== 0) {
      spawnSync("git", ["merge", "--abort"], {
        cwd: worktree.path,
        encoding: "utf8",
        timeout: 10_000,
      });
      return { synced: false, behind: behindCount, conflict: true };
    }

    const headAfter = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: worktree.path,
      encoding: "utf8",
      timeout: 5000,
    }).stdout?.trim();

    if (headAfter && headBefore && headAfter !== headBefore) {
      spawnSync("git", ["push", headInfo.remote, headInfo.name], {
        cwd: worktree.path,
        encoding: "utf8",
        timeout: 30_000,
      });
      return { synced: true, behind: behindCount };
    }

    return { synced: false, behind: behindCount };
  } finally {
    await releaseWorktree(repoRoot, worktreeKey);
  }
}

async function checkEpicBranches(reason = "interval") {
  const backend = getActiveKanbanBackend();
  const projectId =
    backend === "vk"
      ? await findVkProjectId()
      : getConfiguredKanbanProjectId(backend);
  if (!projectId) return;

  const tasks = await listTasksForEpicCheck(projectId);
  if (!tasks.length) return;

  const groups = groupTasksByEpicBranch(tasks);
  const defaultKey = normalizeBranchForCompare(DEFAULT_TARGET_BRANCH);

  for (const [key, group] of groups) {
    if (!group?.tasks?.length) continue;
    if (defaultKey && key === defaultKey) continue;

    const epicBranch = group.baseBranch;
    const epicTasks = group.tasks;
    const incomplete = epicTasks.filter((task) => !isEpicTaskComplete(task));
    const cacheKey = buildEpicCacheKey(epicBranch, DEFAULT_TARGET_BRANCH);

    if (incomplete.length > 0) {
      const syncResult = await syncEpicBranchWithDefault(
        epicBranch,
        DEFAULT_TARGET_BRANCH,
      );
      if (syncResult?.conflict) {
        updateEpicMergeCache(cacheKey, {
          status: "sync-conflict",
          head: epicBranch,
          base: DEFAULT_TARGET_BRANCH,
        });
        await ensureEpicConflictTask(
          projectId,
          tasks,
          epicBranch,
          DEFAULT_TARGET_BRANCH,
          "sync conflict",
          null,
        );
        void sendTelegramMessage(
          `:alert: Epic sync conflict on ${epicBranch} → ${DEFAULT_TARGET_BRANCH} (${reason})`,
        );
      }
      continue;
    }

    const merged = await isBranchMerged(epicBranch, DEFAULT_TARGET_BRANCH);
    if (merged) {
      updateEpicMergeCache(cacheKey, {
        status: "merged",
        head: epicBranch,
        base: DEFAULT_TARGET_BRANCH,
      });
      continue;
    }

    let prInfo = readEpicPrInfo(epicBranch, DEFAULT_TARGET_BRANCH);
    if (!prInfo || prInfo.state === "CLOSED") {
      const created = await createEpicMergePr(
        epicBranch,
        DEFAULT_TARGET_BRANCH,
        epicTasks,
      );
      if (created?.url) {
        updateEpicMergeCache(cacheKey, {
          status: "open",
          head: epicBranch,
          base: DEFAULT_TARGET_BRANCH,
          prUrl: created.url,
        });
        void sendTelegramMessage(
          `:workflow: Epic PR created for ${epicBranch} → ${DEFAULT_TARGET_BRANCH}\n${created.url}`,
        );
      } else if (created?.skipped) {
        updateEpicMergeCache(cacheKey, {
          status: created.reason || "skipped",
          head: epicBranch,
          base: DEFAULT_TARGET_BRANCH,
          aheadCount:
            typeof created.aheadCount === "number" ? created.aheadCount : undefined,
        });
      }
      continue;
    }

    if (prInfo.state === "MERGED") {
      updateEpicMergeCache(cacheKey, {
        status: "merged",
        head: epicBranch,
        base: DEFAULT_TARGET_BRANCH,
        prNumber: prInfo.number,
        prUrl: prInfo.url,
      });
      continue;
    }

    const hasConflicts = detectPrConflicts(prInfo);
    if (hasConflicts) {
      updateEpicMergeCache(cacheKey, {
        status: "conflict",
        head: epicBranch,
        base: DEFAULT_TARGET_BRANCH,
        prNumber: prInfo.number,
        prUrl: prInfo.url,
      });
      await ensureEpicConflictTask(
        projectId,
        tasks,
        epicBranch,
        DEFAULT_TARGET_BRANCH,
        "merge conflicts",
        prInfo,
      );
      void sendTelegramMessage(
        `:alert: Epic PR conflicts for ${epicBranch} → ${DEFAULT_TARGET_BRANCH} (${prInfo.url || "no url"})`,
      );
      continue;
    }

    const checks = await readRequiredChecks(prInfo.number);
    if (checks.length && detectFailedChecks(checks)) {
      updateEpicMergeCache(cacheKey, {
        status: "checks-failed",
        head: epicBranch,
        base: DEFAULT_TARGET_BRANCH,
        prNumber: prInfo.number,
        prUrl: prInfo.url,
      });
      await ensureEpicConflictTask(
        projectId,
        tasks,
        epicBranch,
        DEFAULT_TARGET_BRANCH,
        "failing checks",
        prInfo,
      );
      void sendTelegramMessage(
        `:alert: Epic PR checks failing for ${epicBranch} → ${DEFAULT_TARGET_BRANCH} (${prInfo.url || "no url"})`,
      );
      continue;
    }

    const autoMerged = await enableEpicAutoMerge(prInfo.number);
    updateEpicMergeCache(cacheKey, {
      status: autoMerged ? "auto-merge-enabled" : "open",
      head: epicBranch,
      base: DEFAULT_TARGET_BRANCH,
      prNumber: prInfo.number,
      prUrl: prInfo.url,
    });
  }
}

// ── Dependabot / Bot PR Auto-Merge ──────────────────────────────────────────

/** Set of PR numbers we've already attempted to merge this session */
const dependabotMergeAttempted = new Set();

/**
 * Check for open Dependabot (or other bot) PRs where all CI checks have passed,
 * and auto-merge them.
 *
 * Flow:
 *   1. `gh pr list` filtered by bot authors
 *   2. For each PR, `gh pr checks` to verify all CI passed
 *   3. `gh pr merge --squash` (or configured method)
 *   4. Notify via Telegram
 */
async function checkAndMergeDependabotPRs() {
  if (!dependabotAutoMerge) return;
  if (!repoSlug || repoSlug === "unknown/unknown") {
    console.warn("[dependabot] auto-merge disabled — no repo slug configured");
    return;
  }

  const authorFilter = dependabotAuthors.map((a) => `author:${a}`).join(" ");

  try {
    // List open PRs by bot authors
    const listCmd = `gh pr list --repo ${repoSlug} --state open --json number,title,author,headRefName,statusCheckRollup --limit 20`;
    const listResult = execSync(listCmd, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
    }).trim();

    const prs = JSON.parse(listResult || "[]");
    if (prs.length === 0) return;

    // Filter to only bot-authored PRs
    const botPRs = prs.filter((pr) => {
      const login = pr.author?.login || pr.author?.name || "";
      return dependabotAuthors.some(
        (a) =>
          login === a ||
          login === a.replace("app/", "") ||
          a === `app/${login}`,
      );
    });

    if (botPRs.length === 0) return;
    console.log(
      `[dependabot] found ${botPRs.length} bot PR(s): ${botPRs.map((p) => `#${p.number}`).join(", ")}`,
    );

    for (const pr of botPRs) {
      if (dependabotMergeAttempted.has(pr.number)) continue;

      try {
        // Check CI status — all checks must pass
        const checksCmd = `gh pr checks ${pr.number} --repo ${repoSlug} --json name,state --required`;
        let checksResult;
        try {
          checksResult = execSync(checksCmd, {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 15_000,
          }).trim();
        } catch (checksErr) {
          // gh pr checks returns exit code 1 if any check failed/pending
          // Parse the output anyway if available
          checksResult = checksErr.stdout?.trim() || "";
          if (!checksResult) {
            console.log(
              `[dependabot] PR #${pr.number}: checks still pending or failed`,
            );
            continue;
          }
        }

        let checks;
        try {
          checks = JSON.parse(checksResult || "[]");
        } catch {
          // JSON parse failed — might be old gh version, try simpler check
          console.log(
            `[dependabot] PR #${pr.number}: could not parse checks output`,
          );
          continue;
        }

        // All required checks must be in a passing state
        const allPassed =
          checks.length > 0 &&
          checks.every((c) => {
            const state = String(c?.state || "").toUpperCase();
            const conclusion = String(c?.conclusion || "").toUpperCase();
            const signal = conclusion || state;
            return (
              signal === "SUCCESS" ||
              signal === "PASSED" ||
              signal === "PASS" ||
              signal === "NEUTRAL" ||
              signal === "SKIPPED" ||
              signal === "COMPLETED"
            );
          });

        if (!allPassed) {
          const pending = checks.filter((c) => {
            const state = String(c?.state || "").toUpperCase();
            const conclusion = String(c?.conclusion || "").toUpperCase();
            return (
              !conclusion ||
              state === "PENDING" ||
              state === "IN_PROGRESS" ||
              state === "QUEUED" ||
              state === "WAITING"
            );
          });
          const failed = checks.filter((c) => {
            const state = String(c?.state || "").toUpperCase();
            const conclusion = String(c?.conclusion || "").toUpperCase();
            const signal = conclusion || state;
            return (
              signal === "FAILURE" ||
              signal === "FAILED" ||
              signal === "ERROR" ||
              signal === "TIMED_OUT" ||
              signal === "CANCELLED" ||
              signal === "ACTION_REQUIRED"
            );
          });
          if (failed.length > 0) {
            console.log(
              `[dependabot] PR #${pr.number}: ${failed.length} check(s) failed — skipping`,
            );
            dependabotMergeAttempted.add(pr.number); // don't retry failed
          } else if (pending.length > 0) {
            console.log(
              `[dependabot] PR #${pr.number}: ${pending.length} check(s) still pending`,
            );
          } else if (checks.length === 0) {
            console.log(
              `[dependabot] PR #${pr.number}: no required checks found — waiting`,
            );
          }
          continue;
        }

        // All checks passed — merge!
        console.log(
          `[dependabot] PR #${pr.number}: all ${checks.length} check(s) passed — merging (${dependabotMergeMethod})`,
        );
        dependabotMergeAttempted.add(pr.number);

        const mergeCmd = `gh pr merge ${pr.number} --repo ${repoSlug} --${dependabotMergeMethod} --delete-branch --auto`;
        try {
          execSync(mergeCmd, {
            cwd: repoRoot,
            encoding: "utf8",
            timeout: 30_000,
          });
          console.log(`[dependabot] :check: PR #${pr.number} merged: ${pr.title}`);
          void sendTelegramMessage(
            `:check: Auto-merged bot PR #${pr.number}: ${pr.title}`,
          );
        } catch (mergeErr) {
          const errMsg = mergeErr.stderr || mergeErr.message || "";
          console.warn(
            `[dependabot] merge failed for PR #${pr.number}: ${errMsg.slice(0, 200)}`,
          );
          // If auto-merge was enabled (queued), that's fine — gh returns success for --auto
          if (errMsg.includes("auto-merge")) {
            console.log(
              `[dependabot] PR #${pr.number}: auto-merge enabled, will merge when protection rules are met`,
            );
            void sendTelegramMessage(
              `:refresh: Auto-merge enabled for bot PR #${pr.number}: ${pr.title}`,
            );
          }
        }
      } catch (prErr) {
        console.warn(
          `[dependabot] error processing PR #${pr.number}: ${prErr.message || prErr}`,
        );
      }
    }
  } catch (err) {
    console.warn(`[dependabot] error listing bot PRs: ${err.message || err}`);
  }
}

// ── Merge Strategy Analysis ─────────────────────────────────────────────────

function getReviewGateSnapshot(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return null;

  const runtime = reviewGateResults.get(id);
  if (runtime) {
    return {
      approved: runtime.approved === true,
      reviewedAt: runtime.reviewedAt || null,
      source: "runtime",
    };
  }

  try {
    const task = getInternalTask(id);
    if (!task) return null;
    return {
      approved: task.reviewStatus === "approved",
      reviewedAt: task.reviewedAt || null,
      source: "task-store",
    };
  } catch {
    return null;
  }
}

function isTaskReviewApprovedForFlow(taskId) {
  const snapshot = getReviewGateSnapshot(taskId);
  return snapshot?.approved === true;
}

function rememberPendingMergeStrategy(ctx, reason = "review_pending") {
  const taskId = String(ctx?.taskId || "").trim();
  if (!taskId) return false;
  pendingMergeStrategyByTask.set(taskId, {
    ...ctx,
    _flowDeferredAt: new Date().toISOString(),
    _flowDeferredReason: reason,
  });
  return true;
}

function dequeuePendingMergeStrategy(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return null;
  const ctx = pendingMergeStrategyByTask.get(id) || null;
  if (ctx) pendingMergeStrategyByTask.delete(id);
  return ctx;
}

async function queueFlowReview(taskId, ctx, reason = "") {
  if (!reviewAgent) return false;
  const id = String(taskId || "").trim();
  if (!id) return false;
  try {
    const prUrl =
      ctx?.prUrl ||
      (ctx?.prNumber ? `${repoUrlBase}/pull/${ctx.prNumber}` : "");
    await reviewAgent.queueReview({
      id,
      title: ctx?.taskTitle || id,
      branchName: ctx?.branch || "",
      prUrl,
      description: ctx?.taskDescription || "",
      taskContext: reason ? `Flow gate reason: ${reason}` : "",
      worktreePath: ctx?.worktreeDir || null,
      sessionMessages: "",
      diffStats: "",
    });
    return true;
  } catch (err) {
    console.warn(
      `[flow-gate] failed to queue review for ${id}: ${err.message || err}`,
    );
    return false;
  }
}

function parsePositivePrNumber(value) {
  const parsed = Number(String(value || "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractPrNumberFromUrl(prUrl) {
  const raw = String(prUrl || "");
  const match = raw.match(/\/pull\/(\d+)(?:$|[/?#])/i);
  return match ? parsePositivePrNumber(match[1]) : null;
}

function buildFlowGateMergeBody(taskTitle, taskId) {
  const safeTitle = String(taskTitle || "Task").trim() || "Task";
  const safeId = String(taskId || "").trim();
  const lines = [
    `Merged by Bosun flow gate for: ${safeTitle}`,
    safeId ? `Task: ${safeId}` : "",
  ].filter(Boolean);
  if (shouldAddBosunCoAuthor({ taskId: safeId })) {
    lines.push("", getBosunCoAuthorTrailer());
  }
  return lines.join("\n");
}

async function triggerFlowPostReviewMerge(taskId, context = {}) {
  if (!isFlowPrimaryEnabled() || !isFlowReviewGateEnabled()) {
    return false;
  }
  if (!ghAvailable()) {
    return false;
  }

  const id = String(taskId || "").trim();
  if (!id) return false;

  const task = getInternalTask(id);
  const branch = String(
    context.branch || task?.branchName || task?.branch || "",
  ).trim();
  const taskTitle = String(
    context.taskTitle || task?.title || id,
  ).trim();
  let prNumber =
    parsePositivePrNumber(context.prNumber) ||
    parsePositivePrNumber(task?.prNumber) ||
    parsePositivePrNumber(task?.pr_number) ||
    null;
  let prUrl = String(
    context.prUrl || task?.prUrl || task?.pr_url || "",
  ).trim();
  if (!prNumber && prUrl) {
    prNumber = extractPrNumberFromUrl(prUrl);
  }

  if (!prNumber && branch) {
    let existingPr = await findExistingPrForBranch(branch);
    if (!existingPr) {
      existingPr = await findExistingPrForBranchApi(branch);
    }
    if (existingPr?.number) {
      prNumber = parsePositivePrNumber(existingPr.number);
      prUrl = prUrl || String(existingPr.url || "").trim();
    }
  }

  if (!prNumber) {
    console.warn(
      `[flow-gate] review approved for ${id}, but no PR number could be resolved yet`,
    );
    return false;
  }

  const autoArgs = ["pr", "merge", String(prNumber)];
  if (repoSlug) autoArgs.push("--repo", repoSlug);
  autoArgs.push("--body", buildFlowGateMergeBody(taskTitle, id));
  autoArgs.push("--auto", "--squash");

  const autoResult = spawnSync("gh", autoArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (autoResult.status === 0) {
    console.log(
      `[flow-gate] review approved for "${taskTitle}" (${id}) — auto-merge queued for PR #${prNumber}`,
    );
    return true;
  }

  const autoErr = String(
    autoResult.stderr || autoResult.stdout || "",
  ).trim();
  if (/clean status|not in the correct state/i.test(autoErr)) {
    const directArgs = ["pr", "merge", String(prNumber)];
    if (repoSlug) directArgs.push("--repo", repoSlug);
    directArgs.push("--body", buildFlowGateMergeBody(taskTitle, id));
    directArgs.push("--squash");
    const directResult = spawnSync("gh", directArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (directResult.status === 0) {
      console.log(
        `[flow-gate] review approved for "${taskTitle}" (${id}) — directly merged PR #${prNumber}`,
      );
      return true;
    }
    const directErr = String(
      directResult.stderr || directResult.stdout || "",
    ).trim();
    console.warn(
      `[flow-gate] direct merge failed after approval for PR #${prNumber}: ${directErr.slice(0, 220)}`,
    );
    return false;
  }

  if (/auto-merge/i.test(autoErr) && /enabled|already/i.test(autoErr)) {
    console.log(
      `[flow-gate] review approved for "${taskTitle}" (${id}) — auto-merge already queued for PR #${prNumber}`,
    );
    return true;
  }

  console.warn(
    `[flow-gate] could not queue auto-merge for approved task ${id} (PR #${prNumber}): ${autoErr.slice(0, 220)}`,
  );
  return false;
}

async function canEnableMergeForFlow(ctx) {
  if (!isFlowPrimaryEnabled() || !isFlowReviewGateEnabled()) {
    return { allowed: true };
  }

  const taskId = String(ctx?.taskId || "").trim();
  if (!taskId) {
    return { allowed: false, reason: "missing_task_id_for_review_gate" };
  }

  if (!isTaskReviewApprovedForFlow(taskId)) {
    return { allowed: false, reason: "task_review_not_approved" };
  }

  return { allowed: true };
}

async function shouldFinalizeMergedTask(task, context = {}) {
  if (!isFlowPrimaryEnabled() || !isFlowReviewGateEnabled()) {
    return true;
  }

  const taskId = String(task?.id || "").trim();
  if (!taskId) return false;
  if (isTaskReviewApprovedForFlow(taskId)) return true;

  const branch = context.branch || task?.branch || task?.workspace_branch || "";
  const prNumber = context.prNumber || task?.pr_number || null;
  const reason = context.reason || "merged_before_review";
  console.log(
    `[flow-gate] Task "${task?.title || taskId}" merged but review is not approved yet — holding in inreview`,
  );
  const currentStatus = String(task?.status || "").toLowerCase();
  if (currentStatus && currentStatus !== "inreview") {
    try {
      await updateTaskStatus(taskId, "inreview");
    } catch {
      /* best effort */
    }
  }
  await queueFlowReview(taskId, {
    taskId,
    taskTitle: task?.title || taskId,
    taskDescription: task?.description || task?.body || "",
    branch,
    prNumber,
    prUrl:
      context.prUrl ||
      (prNumber ? `${repoUrlBase}/pull/${prNumber}` : task?.pr_url || ""),
  }, reason);
  return false;
}

/**
 * Run the Codex-powered merge strategy analysis for a completed task.
 * This is fire-and-forget (void) — it runs async in the background and
 * handles its own errors/notifications.
 *
 * @param {import("./merge-strategy.mjs").MergeContext} ctx
 */
async function runMergeStrategyAnalysis(ctx, opts = {}) {
  const tag = `merge-strategy(${ctx.shortId})`;

  // ── Workflow guard: yield to the workflow version if active ──────────
  if (isWorkflowReplacingModule("merge-strategy.mjs")) {
    console.log(
      `[${tag}] skipping legacy merge-strategy — handled by workflow`,
    );
    return;
  }

  try {
    const skipFlowGate = opts?.skipFlowGate === true;
    const flowGateEnabled = isFlowPrimaryEnabled() && isFlowReviewGateEnabled();
    if (!skipFlowGate && flowGateEnabled) {
      const taskId = String(ctx?.taskId || "").trim();
      if (!taskId) {
        console.warn(
          `[${tag}] flow gate: missing taskId — deferring merge strategy until task mapping is available`,
        );
        return;
      }
      if (!isTaskReviewApprovedForFlow(taskId)) {
        rememberPendingMergeStrategy(ctx, "review_pending");
        await queueFlowReview(taskId, ctx, "merge_strategy_waiting_for_review");
        console.log(
          `[${tag}] flow gate: deferred until review is approved for task ${taskId}`,
        );
        return;
      }
    }

    const telegramFn =
      telegramToken && telegramChatId
        ? (msg) => void sendTelegramMessage(msg)
        : null;

    const decision = await analyzeMergeStrategy(ctx, {
      execCodex: execPooledPrompt,
      timeoutMs:
        parseInt(process.env.MERGE_STRATEGY_TIMEOUT_MS, 10) || 10 * 60 * 1000,
      logDir,
      onTelegram: telegramFn,
      promptTemplates: {
        mergeStrategy: agentPrompts?.mergeStrategy,
      },
    });

    if (!decision || !decision.success) {
      console.warn(`[${tag}] analysis failed — falling back to manual review`);
      return;
    }

    // ── Execute the decision via centralized executor ────────────
    console.log(
      `[${tag}] → ${decision.action}${decision.reason ? ": " + decision.reason.slice(0, 100) : ""}`,
    );

    const execResult = await executeDecision(decision, ctx, {
      logDir,
      onTelegram: telegramFn,
      timeoutMs:
        parseInt(process.env.MERGE_STRATEGY_TIMEOUT_MS, 10) || 15 * 60 * 1000,
      canEnableMerge: ({ ctx: mergeCtx }) => canEnableMergeForFlow(mergeCtx),
      promptTemplates: {
        mergeStrategyFix: agentPrompts?.mergeStrategyFix,
        mergeStrategyReAttempt: agentPrompts?.mergeStrategyReAttempt,
      },
    });

    // ── Post-execution handling ──────────────────────────────────
    if (execResult.action === "wait" && execResult.waitSeconds) {
      // Re-run analysis after the wait period
      setTimeout(
        () => {
          void runMergeStrategyAnalysis({
            ...ctx,
            ciStatus: "re-check",
          });
        },
        (execResult.waitSeconds || 300) * 1000,
      );
    }

    if (!execResult.success && execResult.error) {
      console.warn(`[${tag}] execution issue: ${execResult.error}`);
      if (
        String(execResult.error).startsWith("FLOW_REVIEW_GATE:") &&
        ctx?.taskId
      ) {
        rememberPendingMergeStrategy(ctx, "merge_blocked_by_review_gate");
        await queueFlowReview(
          ctx.taskId,
          ctx,
          "merge_action_blocked_by_review_gate",
        );
      }
    }
  } catch (err) {
    console.warn(
      `[${tag}] merge strategy analysis error: ${err.message || err}`,
    );
  }
}

// ── Auto-Rebase Downstream Tasks on PR Merge ────────────────────────────────

/**
 * When a PR is merged into an upstream branch, find all active tasks that
 * share the same upstream and trigger a rebase on each of them.
 *
 * This prevents tasks from drifting behind their upstream and accumulating
 * merge conflicts.
 *
 * @param {string} mergedUpstreamBranch - The branch the PR was merged into
 * @param {string} [excludeAttemptId]   - Attempt to exclude (the one that just merged)
 */
async function rebaseDownstreamTasks(mergedUpstreamBranch, excludeAttemptId) {
  if (!branchRouting?.autoRebaseOnMerge) {
    console.log("[rebase-downstream] auto-rebase disabled in config");
    return;
  }

  const tag = "rebase-downstream";
  console.log(
    `[${tag}] PR merged into ${mergedUpstreamBranch} — checking for downstream tasks to rebase`,
  );

  try {
    // Get all active tasks
    const statuses = ["inprogress", "inreview"];
    const tasksByStatus = await Promise.all(
      statuses.map((status) => fetchTasksByStatus(status)),
    );
    const allTasks = [];
    for (const tasks of tasksByStatus) {
      for (const task of tasks) {
        if (task?.id) allTasks.push(task);
      }
    }

    // Get active attempts from status file
    const statusData = await readStatusData();
    const attempts = Array.isArray(statusData?.active_attempts)
      ? statusData.active_attempts
      : Object.values(statusData?.attempts || {});

    // Also fetch VK task-attempts as fallback
    let vkAttempts = [];
    try {
      const vkRes = await fetchVk("/api/task-attempts");
      const vkData = vkRes?.data ?? vkRes;
      if (Array.isArray(vkData)) vkAttempts = vkData;
    } catch {
      /* best-effort */
    }

    let rebasedCount = 0;
    let failedCount = 0;
    const rebaseResults = [];

    for (const task of allTasks) {
      // Resolve this task's upstream branch
      const taskUpstream =
        resolveUpstreamFromTask(task) || DEFAULT_TARGET_BRANCH;

      // Normalize both branches for comparison (strip "origin/" prefix)
      const normalize = (b) => b?.replace(/^origin\//, "") || "";
      if (normalize(taskUpstream) !== normalize(mergedUpstreamBranch)) {
        continue; // Different upstream — not affected
      }

      // Find the attempt for this task
      let attempt = attempts.find((a) => a?.task_id === task.id);
      if (!attempt) {
        const vkMatch = vkAttempts
          .filter((a) => a?.task_id === task.id)
          .sort(
            (a, b) =>
              new Date(b.created_at).getTime() -
              new Date(a.created_at).getTime(),
          );
        if (vkMatch.length > 0) attempt = vkMatch[0];
      }

      if (!attempt || attempt.id === excludeAttemptId) continue;
      if (!attempt.branch) continue;

      console.log(
        `[${tag}] rebasing task "${task.title}" (${attempt.id.substring(0, 8)}) onto ${mergedUpstreamBranch}`,
      );

      try {
        const rebaseResult = await rebaseAttempt(
          attempt.id,
          mergedUpstreamBranch,
        );

        if (rebaseResult?.success || rebaseResult?.data?.success) {
          rebasedCount++;
          rebaseResults.push({
            taskTitle: task.title,
            attemptId: attempt.id,
            status: "success",
          });
          console.log(
            `[${tag}] ✓ rebased "${task.title}" (${attempt.id.substring(0, 8)}) onto ${mergedUpstreamBranch}`,
          );
        } else {
          failedCount++;
          const error =
            rebaseResult?.error || rebaseResult?.message || "unknown";
          rebaseResults.push({
            taskTitle: task.title,
            attemptId: attempt.id,
            status: "failed",
            error,
          });
          console.warn(
            `[${tag}] ✗ rebase failed for "${task.title}" (${attempt.id.substring(0, 8)}): ${error}`,
          );

          // ── Run task assessment on rebase failure ──────────────
          if (branchRouting?.assessWithSdk && agentPoolEnabled) {
            void runTaskAssessment({
              taskId: task.id,
              taskTitle: task.title,
              taskDescription: task.description,
              attemptId: attempt.id,
              shortId: attempt.id.substring(0, 8),
              trigger: "rebase_failed",
              branch: attempt.branch,
              upstreamBranch: mergedUpstreamBranch,
              rebaseError: error,
              conflictFiles:
                rebaseResult?.conflicted_files ||
                rebaseResult?.data?.conflicted_files ||
                [],
            });
          }
        }
      } catch (err) {
        failedCount++;
        rebaseResults.push({
          taskTitle: task.title,
          attemptId: attempt.id,
          status: "error",
          error: err.message || String(err),
        });
        console.warn(
          `[${tag}] error rebasing "${task.title}": ${err.message || err}`,
        );
      }
    }

    if (rebasedCount > 0 || failedCount > 0) {
      const summary = `Downstream rebase after merge to ${mergedUpstreamBranch}: ${rebasedCount} rebased, ${failedCount} failed`;
      console.log(`[${tag}] ${summary}`);
      void sendTelegramMessage(
        `:refresh: ${summary}\n${rebaseResults.map((r) => `  ${r.status === "success" ? "✓" : "✗"} ${r.taskTitle}`).join("\n")}`,
      );
    } else {
      console.log(
        `[${tag}] no downstream tasks found on upstream ${mergedUpstreamBranch}`,
      );
    }
  } catch (err) {
    console.warn(`[${tag}] error: ${err.message || err}`);
  }
}

// ── Task Assessment Integration ─────────────────────────────────────────────

/**
 * Run a full task lifecycle assessment using Codex/Copilot SDK.
 * First tries quickAssess (heuristic, no SDK call), then falls back to
 * full SDK assessment if needed.
 *
 * After getting a decision, ACTS on it — sends prompts, triggers retries, etc.
 *
 * @param {import("./task-assessment.mjs").TaskAssessmentContext} ctx
 */
async function runTaskAssessment(ctx) {
  const tag = `assessment(${ctx.shortId})`;
  try {
    // ── Quick heuristic assessment first ───────────────────
    const quick = quickAssess(ctx);
    if (quick) {
      console.log(
        `[${tag}] quick decision: ${quick.action} — ${(quick.reason || "").slice(0, 100)}`,
      );
      await actOnAssessment(ctx, quick);
      return;
    }

    // ── Full SDK assessment ───────────────────────────────
    if (!agentPoolEnabled) {
      console.log(`[${tag}] skipping SDK assessment — agent disabled`);
      return;
    }

    const telegramFn =
      telegramToken && telegramChatId
        ? (msg) => void sendTelegramMessage(msg)
        : null;

    const decision = await assessTask(ctx, {
      execCodex: execPooledPrompt,
      timeoutMs: 5 * 60 * 1000,
      logDir,
      onTelegram: telegramFn,
    });

    if (!decision?.success) {
      console.warn(`[${tag}] assessment failed — no action taken`);
      return;
    }

    await actOnAssessment(ctx, decision);
  } catch (err) {
    console.warn(`[${tag}] error: ${err.message || err}`);
  }
}

/**
 * Act on an assessment decision — execute the recommended action.
 *
 * @param {import("./task-assessment.mjs").TaskAssessmentContext} ctx
 * @param {import("./task-assessment.mjs").TaskAssessmentDecision} decision
 */
async function actOnAssessment(ctx, decision) {
  const tag = `assessment-act(${ctx.shortId})`;

  switch (decision.action) {
    case "merge":
      console.log(`[${tag}] → merge`);
      // Handled by VK cleanup script / auto-merge
      break;

    case "reprompt_same":
      console.log(`[${tag}] → reprompt same session`);
      if (decision.prompt && agentPoolEnabled) {
        execPooledPrompt(decision.prompt, { timeoutMs: 15 * 60 * 1000 }).catch(
          (err) => {
            console.warn(
              `[${tag}] reprompt_same failed: ${err?.message || err}`,
            );
          },
        );
      }
      break;

    case "reprompt_new_session":
      console.log(`[${tag}] → reprompt new session`);
      if (typeof startFreshSession === "function") {
        startFreshSession(
          null,
          decision.prompt || `Resume task: ${ctx.taskTitle}`,
          ctx.taskId || null,
        );
      } else if (typeof attemptFreshSessionRetry === "function") {
        await attemptFreshSessionRetry(
          "assessment_new_session",
          decision.reason || "Assessment recommended new session",
        );
      }
      break;

    case "new_attempt":
      console.log(
        `[${tag}] → new attempt (agent: ${decision.agentType || "auto"})`,
      );
      // Move task back to todo for re-scheduling
      if (ctx.taskId) {
        await updateTaskStatus(ctx.taskId, "todo");
      }
      void sendTelegramMessage(
        `:star: Assessment: starting new attempt for "${ctx.taskTitle}" — ${decision.reason || ""}`,
      );
      break;

    case "wait": {
      const waitSec = decision.waitSeconds || 300;
      console.log(`[${tag}] → wait ${waitSec}s`);
      setTimeout(() => {
        void runTaskAssessment({
          ...ctx,
          trigger: "reassessment",
        });
      }, waitSec * 1000);
      break;
    }

    case "manual_review":
      console.log(`[${tag}] → manual review`);
      void sendTelegramMessage(
        `:eye: Assessment: manual review needed for "${ctx.taskTitle}" — ${decision.reason || ""}`,
      );
      break;

    case "close_and_replan":
      console.log(`[${tag}] → close and replan`);
      if (ctx.taskId) {
        await updateTaskStatus(ctx.taskId, "todo");
      }
      void sendTelegramMessage(
        `:ban: Assessment: closing and replanning "${ctx.taskTitle}" — ${decision.reason || ""}`,
      );
      break;

    case "noop":
      console.log(`[${tag}] → noop`);
      break;

    default:
      console.warn(`[${tag}] unknown action: ${decision.action}`);
  }
}

// ── Smart PR creation flow ──────────────────────────────────────────────────

// Use config-driven branch routing instead of hardcoded defaults
const DEFAULT_TARGET_BRANCH =
  branchRouting?.defaultBranch || process.env.VK_TARGET_BRANCH || "origin/main";
const DEFAULT_BOSUN_UPSTREAM =
  branchRouting?.scopeMap?.["bosun"] ||
  process.env.BOSUN_TASK_UPSTREAM ||
  "origin/ve/bosun-generic";

/**
 * Extract the conventional commit scope from a task title.
 * E.g. "feat(bosun): add caching" → "bosun"
 *      "[P1] fix(veid): broken flow"      → "veid"
 *      "chore(provider): cleanup"         → "provider"
 * @param {string} title
 * @returns {string|null}
 */
function extractScopeFromTitle(title) {
  if (!title) return null;
  // Match conventional commit patterns: type(scope): ... or [P*] type(scope): ...
  const match = String(title).match(
    /(?:^\[P\d+\]\s*)?(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\(([^)]+)\)/i,
  );
  return match ? match[1].toLowerCase().trim() : null;
}

/**
 * Resolve the upstream branch for a task using config-based scope routing.
 * Priority:
 *   1. Task-level explicit fields (target_branch, base_branch, etc.)
 *   2. Task metadata fields
 *   3. Task labels with upstream/base/target patterns
 *   4. Text body extraction
 *   5. Config scopeMap matching (title scope → branch)
 *   6. Config scopeMap matching (keyword-based)
 *   7. Legacy bosun keyword detection
 *   8. Config defaultBranch
 * @param {object} task
 * @returns {string|null}
 */
function resolveUpstreamFromConfig(task) {
  if (!task) return null;

  // ── Priority 5+: Config-based scope routing ──────────────
  const scope = extractScopeFromTitle(task.title || task.name);
  if (scope && branchRouting?.scopeMap) {
    // Exact scope match
    const exactMatch = branchRouting.scopeMap[scope];
    if (exactMatch) return exactMatch;

    // Partial scope match — check if any config key is contained in the scope
    for (const [key, branch] of Object.entries(branchRouting.scopeMap)) {
      if (scope.includes(key) || key.includes(scope)) return branch;
    }
  }

  // ── Priority 6: Keyword-based scope matching from task text ─
  if (branchRouting?.scopeMap) {
    const text = getTaskTextBlob(task).toLowerCase();
    for (const [key, branch] of Object.entries(branchRouting.scopeMap)) {
      // Check if the routing key appears as a keyword in the task text
      if (text.includes(key.toLowerCase())) return branch;
    }
  }

  return null;
}

function normalizeBranchName(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

let cachedGitRemotes = null;

function getGitRemoteNames(defaultRemote = "origin") {
  if (cachedGitRemotes) return cachedGitRemotes;
  const remotes = new Set(["origin", "upstream", defaultRemote]);
  try {
    const res = spawnSync("git", ["remote"], {
      cwd: repoRoot || process.cwd(),
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (res.status === 0) {
      for (const line of String(res.stdout || "").split(/\r?\n/)) {
        const remote = line.trim();
        if (remote) remotes.add(remote);
      }
    }
  } catch {
    // Best-effort only; callers fall back to default remote.
  }
  cachedGitRemotes = remotes;
  return cachedGitRemotes;
}

function splitRemoteRef(ref, defaultRemote = "origin") {
  const normalized = normalizeBranchName(ref);
  if (!normalized) return { remote: defaultRemote, name: ref };
  const match = normalized.match(/^([^/]+)\/(.+)$/);
  if (!match) return { remote: defaultRemote, name: normalized };
  const [, remoteCandidate, remainder] = match;
  const remotes = getGitRemoteNames(defaultRemote);
  if (remoteCandidate && remainder && remotes.has(remoteCandidate)) {
    return { remote: remoteCandidate, name: remainder };
  }
  // Branch names like "ve/bosun-generic" are not remote-qualified refs.
  return { remote: defaultRemote, name: normalized };
}

function normalizeBranchForCompare(ref) {
  const normalized = normalizeBranchName(ref);
  if (!normalized) return null;
  const info = splitRemoteRef(normalized, "origin");
  return info?.name || normalized;
}

function extractUpstreamFromText(text) {
  if (!text) return null;
  const match = String(text).match(
    /\b(?:upstream|base|target)(?:_branch| branch)?\s*[:=]\s*([A-Za-z0-9._/-]+)/i,
  );
  if (!match) return null;
  return normalizeBranchName(match[1]);
}

function collectTaskLabels(task) {
  const labels = [];
  if (!task) return labels;
  for (const field of [
    "labels",
    "label",
    "tags",
    "tag",
    "categories",
    "category",
  ]) {
    const value = task[field];
    if (!value) continue;
    if (typeof value === "string") {
      labels.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!item) continue;
        if (typeof item === "string") labels.push(item);
        else if (item.name) labels.push(item.name);
        else if (item.label) labels.push(item.label);
        else if (item.title) labels.push(item.title);
      }
    }
  }
  if (task.metadata) {
    for (const field of ["labels", "tags"]) {
      const value = task.metadata[field];
      if (!value) continue;
      if (typeof value === "string") labels.push(value);
      else if (Array.isArray(value)) labels.push(...value);
    }
  }
  return labels;
}

function getTaskTextBlob(task) {
  const parts = [];
  if (!task) return "";
  for (const field of [
    "title",
    "name",
    "description",
    "body",
    "details",
    "content",
  ]) {
    const value = task[field];
    if (value) parts.push(value);
  }
  const labels = collectTaskLabels(task);
  if (labels.length) parts.push(labels.join(" "));
  return parts.join("\n");
}

function resolveUpstreamFromTask(task) {
  if (!task) return null;

  const directFields = [
    "target_branch",
    "base_branch",
    "upstream_branch",
    "upstream",
    "target",
    "base",
    "targetBranch",
    "baseBranch",
  ];
  for (const field of directFields) {
    if (task[field]) return normalizeBranchName(task[field]);
  }
  if (task.metadata) {
    for (const field of directFields) {
      if (task.metadata[field])
        return normalizeBranchName(task.metadata[field]);
    }
  }

  for (const label of collectTaskLabels(task)) {
    const match = String(label).match(
      /^(?:upstream|base|target)(?:_branch)?[:=]\s*([A-Za-z0-9._/-]+)$/i,
    );
    if (match) return normalizeBranchName(match[1]);
  }

  const fromText = extractUpstreamFromText(getTaskTextBlob(task));
  if (fromText) return fromText;

  // ── Config-based scope routing ────────────────────────────
  const fromConfig = resolveUpstreamFromConfig(task);
  if (fromConfig) return fromConfig;

  // ── Legacy bosun keyword detection ────────────────
  const text = getTaskTextBlob(task).toLowerCase();
  if (
    text.includes("bosun") ||
    text.includes("codex monitor") ||
    text.includes("bosun") ||
    text.includes("scripts/bosun")
  ) {
    return DEFAULT_BOSUN_UPSTREAM;
  }

  return null;
}

// ── Conflict Classification ─────────────────────────────────────────────────
// Auto-resolvable file patterns for rebase conflicts:
//   "theirs" = accept upstream version (lock files, generated files)
//   "ours"   = keep our version (changelogs, coverage reports)
const AUTO_RESOLVE_THEIRS = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "go.sum",
];
const AUTO_RESOLVE_OURS = ["CHANGELOG.md", "coverage.txt", "results.txt"];
const AUTO_RESOLVE_LOCK_EXTENSIONS = [".lock"];

/**
 * Classify conflicted files into auto-resolvable and manual categories.
 * @param {string[]} files - List of conflicted file paths
 * @returns {{ allResolvable: boolean, manualFiles: string[], summary: string }}
 */
function classifyConflictedFiles(files) {
  const manualFiles = [];
  const strategies = [];

  for (const file of files) {
    const fileName = file.split("/").pop();
    let strategy = null;

    if (AUTO_RESOLVE_THEIRS.includes(fileName)) {
      strategy = "theirs";
    } else if (AUTO_RESOLVE_OURS.includes(fileName)) {
      strategy = "ours";
    } else if (
      AUTO_RESOLVE_LOCK_EXTENSIONS.some((ext) => fileName.endsWith(ext))
    ) {
      strategy = "theirs";
    }

    if (strategy) {
      strategies.push(`${fileName}→${strategy}`);
    } else {
      manualFiles.push(file);
    }
  }

  return {
    allResolvable: manualFiles.length === 0,
    manualFiles,
    summary: strategies.join(", ") || "none",
  };
}

function resolveAttemptTargetBranch(attempt, task) {
  if (attempt) {
    const candidate =
      attempt.target_branch ||
      attempt.targetBranch ||
      attempt.base_branch ||
      attempt.baseBranch ||
      attempt.upstream_branch;
    const normalized = normalizeBranchName(candidate);
    if (normalized) return normalized;
    if (Array.isArray(attempt.repos) && attempt.repos.length) {
      const repoTarget =
        attempt.repos[0].target_branch || attempt.repos[0].targetBranch;
      const repoNorm = normalizeBranchName(repoTarget);
      if (repoNorm) return repoNorm;
    }
  }

  const fromTask = resolveUpstreamFromTask(task);
  if (fromTask) return fromTask;

  return DEFAULT_TARGET_BRANCH;
}

/**
 * Intelligent multi-step PR creation using the VK API:
 *
 *   1. Check branch-status → decide action
 *   2. Stale detection: 0 commits AND far behind → rebase first, archive on error
 *   3. Rebase onto main (resolve conflicts automatically if possible)
 *   4. Create PR via /pr endpoint
 *   5. Distinguish fast-fail (<2s = worktree issue) vs slow-fail (>30s = prepush)
 *   6. On prepush failure → prompt agent to fix lint/test issues and push
 *
 * @param {string} attemptId - Full attempt UUID
 * @param {string} shortId   - Short ID for logging (4-8 chars)
 * @param {string} status    - "completed", "failed", or "no-remote-branch"
 */
async function smartPRFlow(attemptId, shortId, status) {
  const tag = `smartPR(${shortId})`;
  try {
    // ── Step 0: Check if task/branch is already merged ───────────
    // Prevents infinite retry loops for tasks that were completed in previous sessions
    const attemptInfo = await getAttemptInfo(attemptId);
    let taskData = null;
    if (attemptInfo?.branch) {
      if (
        await isMergedBranchCacheEntryStillValid(
          attemptInfo.branch,
          attemptInfo?.target_branch ||
            attemptInfo?.targetBranch ||
            attemptInfo?.base_branch ||
            attemptInfo?.baseBranch ||
            null,
        )
      ) {
        console.log(
          `[monitor] ${tag}: branch already in merged cache — archiving`,
        );
        await archiveAttempt(attemptId);
        return;
      }
      const merged = await isBranchMerged(attemptInfo.branch);
      if (merged) {
        let canFinalize = true;
        if (attemptInfo.task_id) {
          canFinalize = await shouldFinalizeMergedTask(
            {
              id: attemptInfo.task_id,
              title: attemptInfo.task_title || attemptInfo.task_id,
              description: attemptInfo.task_description || "",
              pr_number: attemptInfo.pr_number || null,
              pr_url: attemptInfo.pr_url || "",
            },
            {
              branch: attemptInfo.branch,
              prNumber: attemptInfo.pr_number || null,
              reason: "smartpr_initial_merged_branch",
            },
          );
        }
        console.log(
          `[monitor] ${tag}: branch ${attemptInfo.branch} confirmed merged — ${canFinalize ? "completing task" : "awaiting review gate"}`,
        );
        addMergedBranchCache(attemptInfo.branch);
        if (attemptInfo.task_id && canFinalize) {
          mergedTaskCache.add(attemptInfo.task_id);
          pendingMergeStrategyByTask.delete(
            String(attemptInfo.task_id || "").trim(),
          );
          void updateTaskStatus(attemptInfo.task_id, "done");
        }
        await archiveAttempt(attemptId);
        saveMergedTaskCache();
        return;
      }
    }

    // ── Step 0b: Check task description for "already completed" signals ──
    if (attemptInfo?.task_id) {
      try {
        const taskRes = await fetchVk(`/api/tasks/${attemptInfo.task_id}`);
        taskData = taskRes?.data || taskRes || null;
        const desc = String(
          taskData?.description || taskData?.body || "",
        ).toLowerCase();
        const completionSignals = [
          "superseded by",
          "already completed",
          "this task has been completed",
          "merged in",
          "completed via",
          "no longer needed",
          "already merged",
        ];
        const isDescComplete = completionSignals.some((s) => desc.includes(s));
        if (isDescComplete) {
          console.log(
            `[monitor] ${tag}: task description indicates already completed — archiving`,
          );
          void updateTaskStatus(attemptInfo.task_id, "done");
          await archiveAttempt(attemptId);
          return;
        }
        if (isPlannerTaskData(taskData)) {
          const verify = await verifyPlannerTaskCompletion(
            taskData,
            attemptInfo,
          );
          if (verify.completed) {
            console.log(
              `[monitor] ${tag}: planner task verified (${verify.createdCount} new task(s)) — marking done`,
            );
            void updateTaskStatus(attemptInfo.task_id, "done");
            await archiveAttempt(attemptId);
            if (telegramToken && telegramChatId) {
              const suffix = verify.sampleTitles?.length
                ? ` Examples: ${verify.sampleTitles.join(", ")}`
                : "";
              void sendTelegramMessage(
                `:check: Task planner verified: ${verify.createdCount} new task(s) detected.${suffix}`,
              );
            }
            return;
          }
          console.warn(
            `[monitor] ${tag}: planner task incomplete — no new backlog tasks detected`,
          );
          void updateTaskStatus(attemptInfo.task_id, "todo");
          await archiveAttempt(attemptId);
          if (telegramToken && telegramChatId) {
            void sendTelegramMessage(
              ":alert: Task planner incomplete: no new backlog tasks detected. Returned to todo.",
            );
          }
          return;
        }
      } catch {
        /* best effort */
      }
    }

    // ── Step 1: Check branch status ─────────────────────────────
    const branchStatus = await fetchBranchStatus(attemptId);
    if (!branchStatus) {
      console.log(`[monitor] ${tag}: cannot fetch branch-status, skipping`);
      return;
    }

    const { commits_ahead, commits_behind, has_uncommitted_changes } =
      branchStatus;

    // ── Step 2: Stale attempt detection ─────────────────────────
    // 0 commits ahead, 0 uncommitted changes, many behind → stale
    const isStale =
      commits_ahead === 0 && !has_uncommitted_changes && commits_behind > 10;
    if (isStale) {
      console.warn(
        `[monitor] ${tag}: stale attempt — 0 commits, ${commits_behind} behind. Trying rebase first.`,
      );
    }

    // No commits and no changes → archive stale attempt (unless called for conflict resolution)
    if (
      commits_ahead === 0 &&
      !has_uncommitted_changes &&
      status !== "conflict"
    ) {
      console.warn(
        `[monitor] ${tag}: no commits ahead, no changes — archiving stale attempt`,
      );
      await archiveAttempt(attemptId);
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:trash: Archived attempt ${shortId}: no commits, no changes (status=${status}). Task will be reattempted.`,
        );
      }
      return;
    }

    // Uncommitted changes but no commits → agent didn't commit
    if (has_uncommitted_changes && commits_ahead === 0) {
      console.log(
        `[monitor] ${tag}: uncommitted changes but no commits — agent needs to commit first`,
      );
      // Ask the agent to commit via primary agent
      if (primaryAgentReady) {
        void execPooledPrompt(
          `Task attempt ${shortId} has uncommitted changes but no commits.\n` +
            `Please navigate to the worktree for this attempt and:\n` +
            `1. Stage all changes: git add -A\n` +
            `2. Create a conventional commit\n` +
            `3. Push and create a PR`,
          { timeoutMs: 10 * 60 * 1000 },
        );
      }
      return;
    }

    // ── Resolve target branch (task-level upstream overrides) ───
    const attempt = await getAttemptInfo(attemptId);
    if (!taskData && attempt?.task_id) {
      try {
        const taskRes = await fetchVk(`/api/tasks/${attempt.task_id}`);
        if (taskRes?.success && taskRes.data) {
          taskData = taskRes.data;
        } else if (taskRes?.data || taskRes) {
          taskData = taskRes.data || taskRes;
        }
        if (taskData) {
          attempt.task_title = attempt.task_title || taskData.title;
          attempt.task_description =
            taskData.description || taskData.body || "";
        }
      } catch {
        /* best effort */
      }
    }
    const targetBranch = resolveAttemptTargetBranch(attempt, taskData);

    // ── Step 3: Rebase onto target branch ────────────────────────
    console.log(`[monitor] ${tag}: rebasing onto ${targetBranch}...`);
    const rebaseResult = await rebaseAttempt(attemptId, targetBranch);

    if (rebaseResult && !rebaseResult.success) {
      if (isStale) {
        console.warn(
          `[monitor] ${tag}: stale attempt rebase failed — archiving and reattempting next cycle.`,
        );
        await archiveAttempt(attemptId);
        const freshStarted = await attemptFreshSessionRetry(
          "stale_attempt_rebase_failed",
          `Attempt ${shortId} was stale and rebase failed.`,
        );
        if (telegramToken && telegramChatId) {
          const action = freshStarted
            ? "Fresh session started for reattempt."
            : "Will reattempt on next cycle.";
          void sendTelegramMessage(
            `:trash: Archived stale attempt ${shortId} after failed rebase. ${action}`,
          );
        }
        return;
      }
      const errorData = rebaseResult.error_data;
      // Rebase has conflicts → try smart auto-resolve based on file type
      if (errorData?.type === "merge_conflicts") {
        const files = errorData.conflicted_files || [];
        console.warn(
          `[monitor] ${tag}: rebase conflicts in ${files.join(", ")} — attempting smart auto-resolve`,
        );

        // Classify conflicted files
        const autoResolvable = classifyConflictedFiles(files);
        if (autoResolvable.allResolvable) {
          console.log(
            `[monitor] ${tag}: all ${files.length} conflicted files are auto-resolvable (${autoResolvable.summary})`,
          );
        } else {
          console.warn(
            `[monitor] ${tag}: ${autoResolvable.manualFiles.length} files need manual resolution: ${autoResolvable.manualFiles.join(", ")}`,
          );
        }

        // Try VK resolve-conflicts API first (it does "accept ours")
        const resolveResult = await resolveConflicts(attemptId);
        if (resolveResult?.success) {
          console.log(`[monitor] ${tag}: conflicts resolved via VK API`);
        } else {
          const attemptInfo = await getAttemptInfo(attemptId);
          let worktreeDir =
            attemptInfo?.worktree_dir || attemptInfo?.worktree || null;
          // Fallback: look up worktree by branch name from git
          if (!worktreeDir && (attemptInfo?.branch || attempt?.branch)) {
            worktreeDir = findWorktreeForBranch(
              attemptInfo?.branch || attempt?.branch,
            );
          }
          if (codexResolveConflictsEnabled) {
            console.warn(
              `[monitor] ${tag}: auto-resolve failed — running Codex SDK conflict resolution (worktree: ${worktreeDir || "UNKNOWN"})`,
            );
            const classification = classifyConflictedFiles(files);
            const fileGuidance = files
              .map((f) => {
                const fn = f.split("/").pop();
                if (
                  AUTO_RESOLVE_THEIRS.includes(fn) ||
                  AUTO_RESOLVE_LOCK_EXTENSIONS.some((ext) => fn.endsWith(ext))
                ) {
                  return `  - ${f}: Accept THEIRS (upstream version — lock/generated file)`;
                }
                if (AUTO_RESOLVE_OURS.includes(fn)) {
                  return `  - ${f}: Accept OURS (keep our version)`;
                }
                return `  - ${f}: Resolve MANUALLY (inspect both sides, merge intelligently)`;
              })
              .join("\n");
            const prompt = `You are fixing a git rebase conflict in a Vibe-Kanban worktree.
Worktree: ${worktreeDir || "(unknown)"}
Attempt: ${shortId}
Conflicted files: ${files.join(", ") || "(unknown)"}

Per-file resolution strategy:
${fileGuidance}

Instructions:
1) cd into the worktree directory.
2) For each conflicted file, apply the strategy above:
   - THEIRS: git checkout --theirs -- <file> && git add <file>
   - OURS: git checkout --ours -- <file> && git add <file>
   - MANUAL: Open the file, remove conflict markers (<<<< ==== >>>>), merge both sides intelligently, then git add <file>
3) After resolving all files, run: git rebase --continue
4) If more conflicts appear, repeat steps 2-3.
5) Once rebase completes, push the branch: git push --force-with-lease
6) Verify the build still passes if possible.
Return a short summary of what you did and any files that needed manual resolution.`;
            const codexResult = await runCodexExec(
              prompt,
              worktreeDir || repoRoot,
              conflictResolutionTimeoutMs,
            );
            const logPath = resolve(
              logDir,
              `codex-conflict-${shortId}-${nowStamp()}.log`,
            );
            await writeFile(
              logPath,
              codexResult.output || codexResult.error || "(no output)",
              "utf8",
            );
            if (codexResult.success) {
              console.log(
                `[monitor] ${tag}: Codex conflict resolution succeeded`,
              );
              if (telegramToken && telegramChatId) {
                void sendTelegramMessage(
                  `:check: Codex resolved rebase conflicts for ${shortId}. Log: ${logPath}`,
                );
              }
              return;
            }
            console.warn(
              `[monitor] ${tag}: Codex conflict resolution failed — prompting agent`,
            );
            if (telegramToken && telegramChatId) {
              void sendTelegramMessage(
                `:alert: Codex failed to resolve conflicts for ${shortId}. Log: ${logPath}`,
              );
            }
          }
          // Auto-resolve failed — ask agent to fix
          console.warn(
            `[monitor] ${tag}: auto-resolve failed — prompting agent`,
          );
          if (telegramToken && telegramChatId) {
            void sendTelegramMessage(
              `:alert: Attempt ${shortId} has unresolvable rebase conflicts: ${files.join(", ")}`,
            );
          }
          if (primaryAgentReady) {
            void execPooledPrompt(
              `Task attempt ${shortId} has rebase conflicts in: ${files.join(", ")}.\n` +
                `Please resolve the conflicts, commit, push, and create a PR.`,
              { timeoutMs: 15 * 60 * 1000 },
            );
          }
          return;
        }
      }
    }

    // ── Step 4: Build PR title & description from VK task ─────

    let prTitle = attempt?.task_title || attempt?.branch || shortId;
    prTitle = prTitle.replace(/\s*\(vibe-kanban\)$/i, "");

    // Build PR description from task description + auto-created footer
    let prDescription = "";
    if (attempt?.task_description) {
      prDescription = attempt.task_description.trim();
      prDescription += `\n\n---\n_Auto-created by bosun (${status})_`;
    } else {
      prDescription = `Auto-created by bosun after ${status} status.`;
    }

    const branchName = attempt?.branch || branchStatus?.branch || null;
    if (attempt?.pr_number || attempt?.pr_url) {
      console.log(
        `[monitor] ${tag}: attempt already linked to PR (${attempt.pr_number || attempt.pr_url}) — skipping`,
      );
      return;
    }
    if (branchName) {
      let existingPr = null;
      if (ghAvailable()) {
        existingPr = await findExistingPrForBranch(branchName);
      }
      if (!existingPr) {
        existingPr = await findExistingPrForBranchApi(branchName);
      }
      if (existingPr) {
        const state = (existingPr.state || "").toUpperCase();
        if (state === "CLOSED" && smartPrAllowRecreateClosed) {
          console.log(
            `[monitor] ${tag}: existing CLOSED PR #${existingPr.number} found, recreating allowed by VE_SMARTPR_ALLOW_RECREATE_CLOSED`,
          );
        } else {
          console.log(
            `[monitor] ${tag}: existing PR #${existingPr.number} (${state}) for ${branchName} — skipping auto-PR`,
          );
          if (telegramToken && telegramChatId) {
            void sendTelegramMessage(
              `:alert: Auto-PR skipped for ${shortId}: existing PR #${existingPr.number} (${state}) already linked to ${branchName}.`,
            );
          }
          return;
        }
      }
    }

    // ── Step 5: Create PR via VK API ────────────────────────────
    console.log(`[monitor] ${tag}: creating PR "${prTitle}"...`);
    const prResult = await createPRViaVK(attemptId, {
      title: prTitle,
      description: prDescription,
      draft: false,
      base: targetBranch,
    });

    if (prResult?.success) {
      const prUrl = prResult.data?.url || prResult.data?.html_url || "";
      const prNum = prResult.data?.number || null;
      console.log(
        `[monitor] ${tag}: PR created successfully${prUrl ? " — " + prUrl : ""}`,
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:check: Auto-created PR for ${shortId}${prUrl ? ": " + prUrl : ""}`,
        );
      }

      // ── Step 5b: Merge strategy analysis (Codex-powered) ─────
      if (codexAnalyzeMergeStrategy) {
        void runMergeStrategyAnalysis({
          taskId: attempt?.task_id || attemptInfo?.task_id || null,
          attemptId,
          shortId,
          status,
          prTitle,
          prNumber: prNum,
          prUrl,
          prState: "open",
          branch: branchName,
          commitsAhead: branchStatus.commits_ahead,
          commitsBehind: branchStatus.commits_behind,
          taskTitle: attempt?.task_title,
          taskDescription: attempt?.task_description,
          worktreeDir: attempt?.worktree_dir || attempt?.worktree || null,
        });
      }

      return;
    }

    // ── Step 6: Handle PR creation failure ──────────────────────
    const elapsed = prResult._elapsedMs || 0;
    const isFastFail = elapsed < 2000; // < 2s = instant (worktree/config issue)

    if (prResult.error === "repo_id_missing") {
      console.warn(
        `[monitor] ${tag}: PR creation failed — repo_id missing (VK config/API issue)`,
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:alert: Auto-PR for ${shortId} failed: repo_id missing. Check VK_BASE_URL/VK_REPO_ID.`,
        );
      }
      return;
    }

    if (isFastFail) {
      // Instant failure — worktree issue, ask agent to handle everything
      console.warn(
        `[monitor] ${tag}: PR creation fast-failed (${elapsed}ms) — worktree/config issue`,
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:alert: Auto-PR for ${shortId} fast-failed (${elapsed}ms) — likely worktree issue. Prompting agent.`,
        );
      }
      if (primaryAgentReady) {
        void execPooledPrompt(
          `Task attempt ${shortId} needs to create a PR but the automated PR creation ` +
            `failed instantly (worktree or config issue).\n` +
            `Branch: ${attempt?.branch || shortId}\n\n` +
            `Please:\n` +
            `1. Navigate to the worktree\n` +
            `2. Ensure git status is clean and commits exist\n` +
            `3. Run: git push --set-upstream origin ${attempt?.branch || shortId}\n` +
            `4. Create a PR targeting main`,
          { timeoutMs: 15 * 60 * 1000 },
        );
      }
    } else {
      // Slow failure — prepush hooks failed (lint/test/build)
      console.warn(
        `[monitor] ${tag}: PR creation slow-failed (${Math.round(elapsed / 1000)}s) — prepush hook failure`,
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:alert: Auto-PR for ${shortId} failed after ${Math.round(elapsed / 1000)}s (prepush hooks). Prompting agent to fix.`,
        );
      }
      if (primaryAgentReady) {
        void execPooledPrompt(
          `Task attempt ${shortId}: the prepush hooks (lint/test/build) failed ` +
            `when trying to create a PR.\n` +
            `Branch: ${attempt?.branch || shortId}\n\n` +
            `Please:\n` +
            `1. Navigate to the worktree for this branch\n` +
            `2. Fix any lint, test, or build errors\n` +
            `3. Commit the fixes\n` +
            `4. Rebase onto main: git pull --rebase origin main\n` +
            `5. Push: git push --set-upstream origin ${attempt?.branch || shortId}\n` +
            `6. Create a PR targeting main`,
          { timeoutMs: 15 * 60 * 1000 },
        );
      }
    }
  } catch (err) {
    console.warn(`[monitor] ${tag}: error — ${err.message || err}`);
  }
}

// Tracks attempts we've already tried smartPR for (dedup)
const smartPRAttempted = new Set();

/**
 * Check if a shortId (or a prefix/suffix of it) is already tracked.
 * Handles the case where the orchestrator emits different-length prefixes
 * for the same attempt UUID (e.g., "2f71" and "2f7153e7").
 */
function isSmartPRAttempted(shortId) {
  if (smartPRAttempted.has(shortId)) return true;
  for (const existing of smartPRAttempted) {
    if (existing.startsWith(shortId) || shortId.startsWith(existing)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve a short (4-8 char) attempt ID prefix to the full UUID and trigger
 * smartPRFlow. De-duplicated so each attempt is only processed once per
 * monitor lifetime.
 */
async function resolveAndTriggerSmartPR(shortId, status) {
  if (isSmartPRAttempted(shortId)) return;
  smartPRAttempted.add(shortId);

  try {
    const statusData = await readStatusData();
    const attempts = statusData?.active_attempts || [];
    const match = attempts.find((a) => a.id?.startsWith(shortId));

    // ── Early merged-branch check: skip if branch is already merged ──
    const resolvedAttempt = match;
    if (resolvedAttempt?.branch) {
      if (
        await isMergedBranchCacheEntryStillValid(
          resolvedAttempt.branch,
          resolvedAttempt?.target_branch ||
            resolvedAttempt?.targetBranch ||
            resolvedAttempt?.base_branch ||
            resolvedAttempt?.baseBranch ||
            null,
        )
      ) {
        console.log(
          `[monitor] smartPR(${shortId}): branch ${resolvedAttempt.branch} already in mergedBranchCache — skipping`,
        );
        return;
      }
      // Check GitHub for a merged PR with this head branch
      const merged = await isBranchMerged(resolvedAttempt.branch);
      if (merged) {
        let canFinalize = true;
        if (resolvedAttempt.task_id) {
          canFinalize = await shouldFinalizeMergedTask(
            {
              id: resolvedAttempt.task_id,
              title: resolvedAttempt.task_title || resolvedAttempt.task_id,
              description: resolvedAttempt.task_description || "",
              pr_number: resolvedAttempt.pr_number || null,
              pr_url: resolvedAttempt.pr_url || "",
            },
            {
              branch: resolvedAttempt.branch,
              prNumber: resolvedAttempt.pr_number || null,
              reason: "resolve_smartpr_merged_branch",
            },
          );
        }
        console.log(
          `[monitor] smartPR(${shortId}): branch ${resolvedAttempt.branch} confirmed merged — ${canFinalize ? "completing task and skipping PR flow" : "awaiting review gate"}`,
        );
        addMergedBranchCache(resolvedAttempt.branch);
        if (resolvedAttempt.task_id && canFinalize) {
          mergedTaskCache.add(resolvedAttempt.task_id);
          pendingMergeStrategyByTask.delete(
            String(resolvedAttempt.task_id || "").trim(),
          );
          void updateTaskStatus(resolvedAttempt.task_id, "done");
        }
        await archiveAttempt(resolvedAttempt.id || shortId);
        saveMergedTaskCache();
        return;
      }
    }

    if (!match) {
      // Try the full list via VK API
      const allAttempts = await fetchVk(
        "/api/task-attempts?status=review,error",
      );
      const vkMatch =
        allAttempts?.data?.find((a) => a.id?.startsWith(shortId)) || null;
      if (!vkMatch) {
        console.log(
          `[monitor] smartPR(${shortId}): attempt not found in status or VK data`,
        );
        return;
      }
      await smartPRFlow(vkMatch.id, shortId, status);
      return;
    }
    await smartPRFlow(match.id, shortId, status);
  } catch (err) {
    console.warn(`[monitor] resolveSmartPR(${shortId}): ${err.message || err}`);
  }
}

const errorQueue = [];

function queueErrorMessage(line) {
  errorQueue.push(stripAnsi(line));
  if (errorQueue.length >= 3) {
    void flushErrorQueue();
  }
}

async function flushErrorQueue() {
  if (!telegramToken || !telegramChatId) {
    return;
  }
  if (errorQueue.length === 0) {
    return;
  }
  const lines = errorQueue.splice(0, errorQueue.length);
  const message = [`${projectName} Orchestrator Error`, ...lines].join("\n");
  await sendTelegramMessage(message);
}

function notifyMerge(line) {
  const match = line.match(/PR\s+#(\d+)/i);
  if (!match) {
    return;
  }
  const pr = match[1];
  if (mergeNotified.has(pr)) {
    return;
  }
  mergeNotified.add(pr);
  pendingMerges.add(pr);
}

function notifyMergeFailure(line) {
  if (!telegramToken || !telegramChatId) {
    return;
  }
  const match = line.match(
    /Merge notify: PR #(\d+)\s+stage=([^\s]+)\s+category=([^\s]+)\s+action=([^\s]+)\s+reason=(.+)$/i,
  );
  if (!match) {
    return;
  }
  const pr = match[1];
  const stage = match[2];
  const category = match[3];
  const action = match[4];
  const reason = match[5];
  if (stage !== "manual_review") {
    return;
  }
  if (mergeFailureNotified.has(pr)) {
    return;
  }
  mergeFailureNotified.set(pr, Date.now());
  const message = [
    `Merge failed for PR #${pr} (${stage})`,
    `Category: ${category}`,
    `Action: ${action}`,
    `Reason: ${reason}`,
    `${repoUrlBase}/pull/${pr}`,
  ].join("\n");
  void sendTelegramMessage(message);
}

async function flushMergeNotifications() {
  if (!telegramToken || !telegramChatId) {
    return;
  }
  if (pendingMerges.size === 0) {
    return;
  }
  const merged = Array.from(pendingMerges);
  pendingMerges.clear();
  const formatted = merged
    .map((pr) => `#${pr} ${repoUrlBase}/pull/${pr}`)
    .join(", ");
  const message = `Merged PRs: ${formatted}`;
  await sendTelegramMessage(message);
}

async function readStatusData() {
  try {
    const raw = await readFile(statusPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function readStatusSummary() {
  try {
    const status = await readStatusData();
    if (!status) {
      return {
        text: `${projectName} Orchestrator Update\nStatus: unavailable (missing status file)`,
        parseMode: null,
      };
    }

    const counts = status.counts || {};
    const submitted = Array.isArray(status.submitted_tasks)
      ? status.submitted_tasks
      : [];
    const completed = Array.isArray(status.completed_tasks)
      ? status.completed_tasks
      : [];
    const followups = Array.isArray(status.followup_events)
      ? status.followup_events
      : [];
    const copilotRequests = Array.isArray(status.copilot_requests)
      ? status.copilot_requests
      : [];
    const attempts = status.attempts || {};
    const manualReviewTasks = Array.isArray(status.manual_review_tasks)
      ? status.manual_review_tasks
      : [];

    const now = Date.now();
    const intervalMs = telegramIntervalMin * 60 * 1000;
    const cutoff = now - intervalMs;

    const recentSubmitted = submitted.filter((item) => {
      if (!item.submitted_at) {
        return false;
      }
      const ts = Date.parse(item.submitted_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const recentCompleted = completed.filter((item) => {
      if (!item.completed_at) {
        return false;
      }
      const ts = Date.parse(item.completed_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const recentFollowups = followups.filter((item) => {
      if (!item.occurred_at) {
        return false;
      }
      const ts = Date.parse(item.occurred_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const recentCopilot = copilotRequests.filter((item) => {
      if (!item.occurred_at) {
        return false;
      }
      const ts = Date.parse(item.occurred_at);
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const manualReviewLines = manualReviewTasks.length
      ? manualReviewTasks.map((taskId) => {
          const attempt = Object.values(attempts).find(
            (item) =>
              item &&
              item.task_id === taskId &&
              item.status === "manual_review",
          );
          if (attempt && attempt.pr_number) {
            const prNumber = `#${attempt.pr_number}`;
            return `- ${formatHtmlLink(
              `${repoUrlBase}/pull/${attempt.pr_number}`,
              prNumber,
            )}`;
          }
          return `- ${escapeHtml(taskId)}`;
        })
      : ["- none"];

    const createdLines = recentSubmitted.length
      ? recentSubmitted.map((item) => {
          const title = item.task_title || item.task_id || "(task)";
          const link = item.task_url
            ? formatHtmlLink(item.task_url, title)
            : escapeHtml(title);
          return `- ${link}`;
        })
      : ["- none"];

    const mergedLines = recentCompleted.length
      ? recentCompleted.map((item) => {
          const prNumber = item.pr_number ? `#${item.pr_number}` : "";
          const title = item.pr_title || prNumber || "(PR)";
          const link = item.pr_url
            ? formatHtmlLink(item.pr_url, title)
            : escapeHtml(title);
          const suffix =
            prNumber && !title.includes(prNumber) ? ` (${prNumber})` : "";
          return `- ${link}${suffix}`;
        })
      : ["- none"];

    const followupLines = recentFollowups.length
      ? recentFollowups.map((item) => {
          const title = item.task_title || item.task_id || "(task)";
          const link = item.task_url
            ? formatHtmlLink(item.task_url, title)
            : escapeHtml(title);
          const reason = item.reason ? `: ${escapeHtml(item.reason)}` : "";
          return `- ${link}${reason}`;
        })
      : ["- none"];

    const copilotLines = recentCopilot.length
      ? recentCopilot.map((item) => {
          const prNumber = item.pr_number ? `#${item.pr_number}` : "";
          const title = item.pr_title || prNumber || "(PR)";
          const link = item.pr_url
            ? formatHtmlLink(item.pr_url, title)
            : escapeHtml(title);
          const reason = item.reason ? `: ${escapeHtml(item.reason)}` : "";
          return `- ${link}${reason}`;
        })
      : ["- none"];

    const running = counts.running ?? 0;
    const review = counts.review ?? 0;
    const error = counts.error ?? 0;
    const manualReview = counts.manual_review ?? 0;

    // Success rate metrics
    const sm = status.success_metrics || {};
    const firstShot = sm.first_shot_success ?? 0;
    const neededFix = sm.needed_fix ?? 0;
    const failed = sm.failed ?? 0;
    const firstShotRate = sm.first_shot_rate ?? 0;
    const totalDecided = firstShot + neededFix + failed;
    const successLine =
      totalDecided > 0
        ? `First-shot: ${firstShotRate}% (${firstShot}/${totalDecided}) | Fix: ${neededFix} | Failed: ${failed}`
        : "No completed tasks yet";

    const message = [
      `${projectName} Orchestrator ${telegramIntervalMin}-min Update`,
      `New tasks created (${recentSubmitted.length}):`,
      ...createdLines,
      `Merged tasks (${recentCompleted.length}):`,
      ...mergedLines,
      `Task follow-ups (${recentFollowups.length}):`,
      ...followupLines,
      `Copilot triggered (${recentCopilot.length}):`,
      ...copilotLines,
      `Manual review (${manualReviewTasks.length}):`,
      ...manualReviewLines,
      `Counts: running=${running}, review=${review}, error=${error}, manual_review=${manualReview}, conflict_resolving=${conflictResolutionCooldown.size}`,
      `Success: ${successLine}`,
    ].join("\n");

    return { text: message, parseMode: "HTML" };
  } catch (err) {
    return {
      text: `${projectName} Orchestrator Update\nStatus: unavailable (missing status file)`,
      parseMode: null,
    };
  }
}

async function readPlannerState() {
  try {
    const raw = await readFile(plannerStatePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writePlannerState(nextState) {
  await mkdir(monitorStateCacheDir, { recursive: true });
  await writeFile(plannerStatePath, JSON.stringify(nextState, null, 2), "utf8");
}

async function updatePlannerState(patch) {
  const current = (await readPlannerState()) || {};
  const merged = { ...current, ...patch };
  await writePlannerState(merged);
  return merged;
}

function isPlannerDeduped(state, now) {
  if (!state || !state.last_triggered_at) {
    return false;
  }
  // Only dedup if the last run was successful — failed/skipped runs
  // should not block subsequent attempts
  if (!state.last_success_at) {
    return false;
  }
  const last = Date.parse(state.last_success_at);
  if (!Number.isFinite(last)) {
    return false;
  }
  return now - last < plannerDedupMs;
}

function truncateText(value, maxChars = 1200) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function formatRecentStatusItems(items, timestampField, maxItems = 6) {
  if (!Array.isArray(items) || items.length === 0) return [];
  return [...items]
    .sort((a, b) => {
      const ta = Date.parse(a?.[timestampField] || 0);
      const tb = Date.parse(b?.[timestampField] || 0);
      return tb - ta;
    })
    .slice(0, maxItems)
    .map((entry) => {
      const title = entry?.task_title || entry?.title || "Untitled task";
      const id = (entry?.task_id || entry?.id || "").toString().slice(0, 8);
      const suffix = id ? ` (${id})` : "";
      return `- ${title}${suffix}`;
    });
}

function safeJsonBlock(value, maxChars = 1600) {
  const serialized = safeStringify(value);
  if (!serialized) return "(unavailable)";
  return truncateText(serialized, maxChars);
}

function readRecentGitCommits(limit = 12) {
  try {
    const output = execSync(`git log --oneline -${Math.max(1, limit)}`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, limit);
  } catch {
    return [];
  }
}

async function buildPlannerRuntimeContext(reason, details, numTasks) {
  const status = (await readStatusData()) || {};
  const counts = status.counts || {};
  const backlogRemaining = Number(status.backlog_remaining || 0);
  const running = Number(counts.running || 0);
  const review = Number(counts.review || 0);
  const error = Number(counts.error || 0);
  const manualReview = Number(counts.manual_review || 0);
  const maxParallel = Math.max(1, getMaxParallelFromArgs(scriptArgs) || 1);
  const backlogPerSlot = Number((backlogRemaining / maxParallel).toFixed(2));
  const idleSlots = Math.max(0, maxParallel - running);
  const recentCompleted = formatRecentStatusItems(
    status.completed_tasks,
    "completed_at",
    8,
  );
  const recentSubmitted = formatRecentStatusItems(
    status.submitted_tasks,
    "submitted_at",
    8,
  );
  const recentCommits = readRecentGitCommits(15);
  const plannerState = (await readPlannerState()) || {};

  return {
    reason: reason || "manual",
    numTasks,
    counts: {
      backlogRemaining,
      running,
      review,
      error,
      manualReview,
      maxParallel,
      backlogPerSlot,
      idleSlots,
    },
    recentCompleted,
    recentSubmitted,
    recentCommits,
    triggerDetails: details || null,
    plannerState,
  };
}

/**
 * Extract a conventional-commit scope from a task title and return the
 * corresponding module branch ref (e.g. "origin/veid").
 * Respects TASK_BRANCH_AUTO_MODULE env var (default: true) and
 * MODULE_BRANCH_PREFIX (default: "origin/").
 */
function extractModuleBaseBranchFromTitle(title) {
  const enabled = (process.env.TASK_BRANCH_AUTO_MODULE ?? "true") !== "false";
  if (!enabled || !title) return null;
  const match = String(title).match(
    /(?:^\[[^\]]+\]\s*)?(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\(([^)]+)\)/i,
  );
  if (!match) return null;
  const scope = match[1].toLowerCase().trim();
  // Exclude generic scopes that don't map to real module branches
  const generic = new Set(["deps", "app", "sdk", "cli", "api"]);
  if (generic.has(scope)) return null;
  const prefix = (process.env.MODULE_BRANCH_PREFIX || "origin/").replace(/\/*$/, "/");
  return `${prefix}${scope}`;
}

function buildPlannerTaskDescription({
  plannerPrompt,
  reason,
  numTasks,
  runtimeContext,
  userPrompt,
}) {
  return [
    "## Task Planner — Auto-created by bosun",
    "",
    `**Trigger reason:** ${reason || "manual"}`,
    `**Requested task count:** ${numTasks}`,
    ...(userPrompt
      ? [
          "",
          "### User Planning Prompt",
          "",
          userPrompt,
        ]
      : []),
    "",
    "### Planner Prompt (Injected by bosun)",
    "",
    plannerPrompt,
    "",
    "### Runtime Context Snapshot",
    "",
    `- Backlog remaining: ${runtimeContext.counts.backlogRemaining}`,
    `- Running: ${runtimeContext.counts.running}`,
    `- In review: ${runtimeContext.counts.review}`,
    `- Errors: ${runtimeContext.counts.error}`,
    `- Manual review: ${runtimeContext.counts.manualReview}`,
    `- Max parallel slots: ${runtimeContext.counts.maxParallel}`,
    `- Backlog per slot: ${runtimeContext.counts.backlogPerSlot}`,
    `- Idle slots: ${runtimeContext.counts.idleSlots}`,
    "",
    "Recent completed tasks:",
    ...(runtimeContext.recentCompleted.length
      ? runtimeContext.recentCompleted
      : ["- (none recorded)"]),
    "",
    "Recently submitted tasks:",
    ...(runtimeContext.recentSubmitted.length
      ? runtimeContext.recentSubmitted
      : ["- (none recorded)"]),
    "",
    "Recent commits:",
    ...(runtimeContext.recentCommits.length
      ? runtimeContext.recentCommits.map((line) => `- ${line}`)
      : ["- (git log unavailable)"]),
    "",
    "Trigger details (JSON):",
    "```json",
    safeJsonBlock(runtimeContext.triggerDetails),
    "```",
    "",
    "Previous planner state (JSON):",
    "```json",
    safeJsonBlock(runtimeContext.plannerState),
    "```",
    "",
    "### Execution Rules",
    "",
    `1. Create at least ${numTasks} backlog tasks unless constrained by duplicate/overlap safeguards.`,
    "2. Ensure each task title starts with one size label: [xs], [s], [m], [l], [xl], [xxl].",
    "3. Every task description must include: problem, implementation steps, acceptance criteria, and verification plan.",
    "4. Prioritize reliability and unblockers first when errors/review backlog is elevated.",
    "5. Avoid duplicates with existing todo/inprogress/review tasks and open PRs.",
    "6. Prefer task sets that can run in parallel with minimal file overlap.",
    "7. **Module branch routing (important):** When a task's title follows conventional commit format",
    "   `feat(module):` or `fix(module):`, ALWAYS set `base_branch` to `origin/<module>` in the JSON.",
    "   This enables parallel branch-per-module execution where all work for a module accumulates on",
    "   its dedicated branch and integrates upstream changes continuously.",
    "   Examples: `feat(veid):` → `origin/veid`, `fix(market):` → `origin/market`.",
    "   Do NOT set base_branch for cross-cutting tasks that modify many modules.",
    "8. If a task should target a non-default epic/base branch for other reasons, include `base_branch` in the JSON task object.",
    "9. Output MUST be exactly one fenced ```json code block with shape { \"tasks\": [...] } and no surrounding prose.",
    "10. Each task object must include title, description, implementation_steps, acceptance_criteria, verification.",
    "11. Do not output placeholder tasks. If uncertain, reduce scope but keep tasks executable.",].join("\n");
}

function normalizePlannerTitleForComparison(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlannerTaskTitle(title, fallbackSize = "m") {
  const trimmed = String(title || "").trim();
  if (!trimmed) return null;
  const hasSizePrefix = /^\[(xs|s|m|l|xl|xxl)\]\s+/i.test(trimmed);
  if (hasSizePrefix) return trimmed;
  return `[${fallbackSize}] ${trimmed}`;
}

function formatPlannerTaskDescription(task) {
  const summary = String(task.description || task.summary || "").trim();
  const implementationSteps = Array.isArray(task.implementation_steps)
    ? task.implementation_steps
    : Array.isArray(task.implementationSteps)
      ? task.implementationSteps
      : [];
  const acceptanceCriteria = Array.isArray(task.acceptance_criteria)
    ? task.acceptance_criteria
    : Array.isArray(task.acceptanceCriteria)
      ? task.acceptanceCriteria
      : [];
  const verificationPlan = Array.isArray(task.verification)
    ? task.verification
    : Array.isArray(task.verification_plan)
      ? task.verification_plan
      : Array.isArray(task.verificationPlan)
        ? task.verificationPlan
        : [];

  const lines = [];
  if (summary) {
    lines.push(summary, "");
  }
  if (implementationSteps.length > 0) {
    lines.push("## Implementation Steps", "");
    for (const step of implementationSteps) {
      lines.push(`- ${String(step || "").trim()}`);
    }
    lines.push("");
  }
  if (acceptanceCriteria.length > 0) {
    lines.push("## Acceptance Criteria", "");
    for (const criterion of acceptanceCriteria) {
      lines.push(`- ${String(criterion || "").trim()}`);
    }
    lines.push("");
  }
  if (verificationPlan.length > 0) {
    lines.push("## Verification", "");
    for (const verificationStep of verificationPlan) {
      lines.push(`- ${String(verificationStep || "").trim()}`);
    }
  }

  const description = lines.join("\n").trim();
  return description || "Planned by bosun task planner.";
}

function resolvePlannerTaskBaseBranch(task) {
  if (!task) return null;
  const directFields = [
    "base_branch",
    "baseBranch",
    "target_branch",
    "targetBranch",
    "upstream_branch",
    "upstreamBranch",
    "upstream",
    "base",
    "target",
  ];
  for (const field of directFields) {
    if (task[field]) return normalizeBranchName(task[field]);
  }
  if (task.metadata) {
    for (const field of directFields) {
      if (task.metadata[field]) return normalizeBranchName(task.metadata[field]);
    }
  }
  if (task.meta) {
    for (const field of directFields) {
      if (task.meta[field]) return normalizeBranchName(task.meta[field]);
    }
  }
  return null;
}

function parsePlannerTaskCollection(parsedValue) {
  if (Array.isArray(parsedValue)) return parsedValue;
  if (Array.isArray(parsedValue?.tasks)) return parsedValue.tasks;
  if (Array.isArray(parsedValue?.backlog)) return parsedValue.backlog;
  return [];
}

function extractPlannerTasksFromOutput(output, maxTasks) {
  const text = String(output || "");
  const candidates = [];
  const fencedJsonPattern = /```json[^\n]*\n([\s\S]*?)```/gi;
  let match = fencedJsonPattern.exec(text);
  while (match) {
    const candidate = String(match[1] || "").trim();
    if (candidate) candidates.push(candidate);
    match = fencedJsonPattern.exec(text);
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    candidates.push(trimmed);
  }

  const normalized = [];
  const seenTitles = new Set();
  const cap = Number.isFinite(maxTasks) && maxTasks > 0 ? maxTasks : Infinity;

  for (const candidate of candidates) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const tasks = parsePlannerTaskCollection(parsed);
    if (!Array.isArray(tasks) || tasks.length === 0) continue;
    for (const task of tasks) {
      const title = normalizePlannerTaskTitle(task?.title, "m");
      if (!title) continue;
      const dedupKey = normalizePlannerTitleForComparison(title);
      if (!dedupKey || seenTitles.has(dedupKey)) continue;
      seenTitles.add(dedupKey);
      normalized.push({
        title,
        description: formatPlannerTaskDescription(task),
        baseBranch: resolvePlannerTaskBaseBranch(task),
      });
      if (normalized.length >= cap) return normalized;
    }
  }

  return normalized;
}

async function materializePlannerTasksToKanban(tasks) {
  const existingOpenTasks = getInternalTasksByStatus("todo");
  const existingTitles = new Set(
    (Array.isArray(existingOpenTasks) ? existingOpenTasks : [])
      .map((task) => normalizePlannerTitleForComparison(task?.title))
      .filter(Boolean),
  );

  const created = [];
  const skipped = [];

  for (const task of tasks) {
    const dedupKey = normalizePlannerTitleForComparison(task.title);
    if (!dedupKey) {
      skipped.push({ title: task.title || "", reason: "invalid_title" });
      continue;
    }
    if (existingTitles.has(dedupKey)) {
      skipped.push({ title: task.title, reason: "duplicate_title" });
      continue;
    }
    const baseBranch = task.baseBranch || task.base_branch || extractModuleBaseBranchFromTitle(task.title);
    const executionOverride =
      task.execution && typeof task.execution === "object" ? task.execution : {};
    const plannerMeta = {
      source: "task-planner",
      plannerMode: "codex-sdk",
      kind: "planned-task",
      externalSyncPending: true,
      createdAt: new Date().toISOString(),
    };
    const createdTask = addInternalTask({
      id: randomUUID(),
      title: task.title,
      description: task.description,
      status: "todo",
      projectId: process.env.INTERNAL_EXECUTOR_PROJECT_ID || "internal",
      ...(baseBranch ? { baseBranch } : {}),
      syncDirty: true,
      meta: {
        planner: plannerMeta,
        execution: {
          sdk:
            executionOverride.sdk && executionOverride.sdk !== "auto"
              ? String(executionOverride.sdk).trim()
              : undefined,
          model:
            executionOverride.model && executionOverride.model !== "auto"
              ? String(executionOverride.model).trim()
              : undefined,
        },
        ...(baseBranch ? { base_branch: baseBranch, baseBranch } : {}),
      },
    });
    if (createdTask?.id) {
      created.push({ id: createdTask.id, title: task.title });
      existingTitles.add(dedupKey);
    } else {
      skipped.push({ title: task.title, reason: "create_failed" });
    }
  }

  return { created, skipped };
}

function buildTaskPlannerStatusText(plannerState, reason = "interval") {
  const now = Date.now();
  const lastTriggered = plannerState?.last_triggered_at
    ? formatElapsedMs(now - Date.parse(plannerState.last_triggered_at))
    : "never";
  const lastSuccess = plannerState?.last_success_at
    ? formatElapsedMs(now - Date.parse(plannerState.last_success_at))
    : "never";
  return [
    ":clipboard: Codex-Task-Planner Update",
    `- Reason: ${reason}`,
    `- Planner mode: ${plannerMode}`,
    `- Trigger in progress: ${plannerTriggered ? "yes" : "no"}`,
    `- Last triggered: ${lastTriggered}`,
    `- Last success: ${lastSuccess}`,
    `- Last trigger reason: ${plannerState?.last_trigger_reason || "n/a"}`,
    `- Last trigger mode: ${plannerState?.last_trigger_mode || "n/a"}`,
    plannerState?.last_error
      ? `- Last error: ${truncateText(plannerState.last_error, 180)}`
      : "- Last error: none",
  ].join("\n");
}

async function publishTaskPlannerStatus(reason = "interval") {
  if (!taskPlannerStatus.enabled || plannerMode === "disabled") return;
  if (!telegramToken || !telegramChatId) return;
  const state = (await readPlannerState()) || {};
  const text = buildTaskPlannerStatusText(state, reason);
  taskPlannerStatus.lastStatusAt = Date.now();
  await sendTelegramMessage(text, {
    dedupKey: `task-planner-status-${reason}-${plannerMode}`,
    exactDedup: true,
    skipDedup: reason === "interval",
  });
}

function stopTaskPlannerStatusLoop() {
  if (taskPlannerStatus.timer) {
    clearInterval(taskPlannerStatus.timer);
    taskPlannerStatus.timer = null;
  }
}

function startTaskPlannerStatusLoop() {
  stopTaskPlannerStatusLoop();
  taskPlannerStatus.enabled = isDevMode();
  taskPlannerStatus.intervalMs = Math.max(
    5 * 60_000,
    Number(process.env.DEVMODE_TASK_PLANNER_STATUS_INTERVAL_MS || "1800000"),
  );
  if (!taskPlannerStatus.enabled || plannerMode === "disabled") return;
  taskPlannerStatus.timer = setInterval(() => {
    if (shuttingDown) return;
    runDetached("task-planner-status:interval", () =>
      publishTaskPlannerStatus("interval"),
    );
  }, taskPlannerStatus.intervalMs);
  setTimeout(() => {
    if (shuttingDown) return;
    runDetached("task-planner-status:startup", () =>
      publishTaskPlannerStatus("startup"),
    );
  }, 25_000);
}

async function maybeTriggerTaskPlanner(reason, details, options = {}) {
  if (internalTaskExecutor?.isPaused?.()) {
    console.log("[monitor] task planner skipped: executor paused");
    return;
  }
  if (plannerMode === "disabled") {
    console.log(`[monitor] task planner skipped: mode=disabled`);
    return;
  }
  if (plannerMode === "codex-sdk" && !codexEnabled) {
    console.log(
      `[monitor] task planner skipped: codex-sdk mode but Codex disabled`,
    );
    return;
  }
  if (plannerTriggered) {
    console.log(`[monitor] task planner skipped: already running`);
    return;
  }
  const now = Date.now();
  const state = await readPlannerState();
  if (isPlannerDeduped(state, now)) {
    const lastAt = state?.last_triggered_at || "unknown";
    console.log(
      `[monitor] task planner skipped: deduped (last triggered ${lastAt})`,
    );
    return;
  }
  try {
    const result = await triggerTaskPlanner(reason, details, options);
    console.log(
      `[monitor] task planner result: ${result?.status || "unknown"} (${reason})`,
    );
  } catch (err) {
    // Auto-triggered planner failures are non-fatal — already logged/notified by triggerTaskPlanner
    console.warn(
      `[monitor] auto-triggered planner failed: ${err.message || err}`,
    );
  }
}

async function sendTelegramMessage(text, options = {}) {
  const targetChatId = options.chatId ?? telegramChatId;
  if (!telegramToken || !targetChatId) {
    return;
  }
  const rawDedupKey = options.dedupKey ?? String(text || "").trim();
  // Use fuzzy normalization so structural duplicates with different numbers match
  const dedupKey = options.exactDedup
    ? rawDedupKey
    : normalizeDedupKey(rawDedupKey);
  if (dedupKey && !options.skipDedup) {
    const now = Date.now();
    const last = telegramDedup.get(dedupKey) || 0;
    if (now - last < 5 * 60 * 1000) {
      return;
    }
    telegramDedup.set(dedupKey, now);
  }

  // Always record to history ring buffer (even deduped messages are useful context)
  pushTelegramHistory(String(text || ""));

  // Determine priority based on message content
  const textLower = String(text || "").toLowerCase();
  let priority = 4; // default: info
  let category = "general";

  // Positive signals override negative keyword matches — a ":check: Task completed"
  // message should never be classified as an error even when the task title
  // happens to contain words like "error" or "failed".
  // Orchestrator periodic updates contain counter labels like "Failed: 0" and
  // "error=0" which should NOT trigger error classification.
  // Status updates (planner, monitor-monitor) contain "Last error: none" which
  // is informational, not an actual error.
  const isPositive =
    textLower.includes(":check:") ||
    textLower.includes("task completed") ||
    textLower.includes("branch merged") ||
    textLower.includes("pr merged") ||
    (textLower.includes("orchestrator") && textLower.includes("-min update")) ||
    (textLower.includes("update") && textLower.includes("last error: none")) ||
    (textLower.includes("update") && textLower.includes("- reason:"));

  // Priority 1: Critical/Fatal
  if (
    !isPositive &&
    (textLower.includes("fatal") ||
      textLower.includes("critical") ||
      textLower.includes(":zap:"))
  ) {
    priority = 1;
    category = "critical";
  }
  // Priority 2: Errors
  else if (
    !isPositive &&
    (textLower.includes("error") ||
      textLower.includes("failed") ||
      textLower.includes(":close:") ||
      textLower.includes("auto-fix gave up"))
  ) {
    priority = 2;
    category = "error";
  }
  // Priority 3: Warnings
  else if (
    !isPositive &&
    (textLower.includes("warning") || textLower.includes(":alert:"))
  ) {
    priority = 3;
    category = "warning";
  }
  // Priority 4: Info (default)
  else {
    // Categorize info messages
    if (textLower.includes("pr") || textLower.includes("pull request")) {
      category = "pr";
    } else if (textLower.includes("task") || textLower.includes("completed")) {
      category = "task";
    } else if (textLower.includes("codex") || textLower.includes("analysis")) {
      category = "analysis";
    } else if (
      textLower.includes("auto-created") ||
      textLower.includes("merged")
    ) {
      category = "git";
    }
  }

  // Allow caller to explicitly override the computed priority (e.g. auto-update
  // restart notifications should always arrive as direct messages, not digest).
  if (options.priority !== undefined) priority = Number(options.priority);

  // Route through batching system — apply verbosity filter first.
  // minimal: only priority 1-2 (critical + error)
  // summary: priority 1-4 (everything except debug) — DEFAULT
  // detailed: priority 1-5 (everything)
  const maxPriority =
    telegramVerbosity === "minimal"
      ? 2
      : telegramVerbosity === "detailed"
        ? 5
        : 4;
  if (priority > maxPriority) return; // filtered out by verbosity setting

  // Also bridge critical/error notifications to WhatsApp (if enabled)
  if (priority <= 2 && isWhatsAppEnabled()) {
    notifyWhatsApp(stripAnsi(String(text || ""))).catch(() => {});
  }

  return notify(text, priority, {
    category,
    silent: options.silent,
    data: { parseMode: options.parseMode, chatId: targetChatId },
  });
}

async function maybeSendWeeklyReport(nowInput = new Date()) {
  if (!telegramWeeklyReportEnabled) return;
  if (!telegramToken || !telegramChatId) return;
  const now = nowInput instanceof Date ? nowInput : new Date(nowInput);
  if (!Number.isFinite(now.getTime())) return;

  if (!shouldSendWeeklyReport({
    now,
    dayOfWeek: telegramWeeklyReportDay,
    hourUtc: telegramWeeklyReportHour,
    lastSentAt: weeklyReportLastSentAt,
  })) return;

  try {
    const report = await generateWeeklyAgentWorkReport({
      days: telegramWeeklyReportDays,
      now,
    });
    await sendTelegramMessage(report.text, {
      dedupKey: `weekly-report:${now.toISOString().slice(0, 10)}`,
      exactDedup: true,
      skipDedup: true,
    });
    weeklyReportLastSentAt = now.toISOString();
    if (Array.isArray(report.warnings) && report.warnings.length > 0) {
      console.warn(
        `[monitor] weekly report generated with warnings: ${report.warnings.join(" | ")}`,
      );
    }
  } catch (err) {
    console.warn(`[monitor] weekly report generation failed: ${err?.message || err}`);
    await sendTelegramMessage(
      `:alert: Weekly report failed: ${err?.message || err}`,
      { dedupKey: "weekly-report:failed", exactDedup: true },
    );
  }
}

globalThis.__bosunNotifyAnomaly = (anomaly) => {
  if (process.env.BOSUN_INTERNAL_ANOMALY_NOTIFY === "false") return;
  if (!telegramToken || !telegramChatId) return;
  const icon =
    anomaly.severity === "CRITICAL"
      ? ":dot:"
      : anomaly.severity === "HIGH"
        ? ":u1f7e0:"
        : anomaly.severity === "MEDIUM"
          ? ":dot:"
          : ":dot:";
  const lines = [
    `${icon} Internal Anomaly: ${anomaly.type}`,
    `Attempt: ${anomaly.processId || anomaly.shortId || "unknown"}`,
    anomaly.message ? `Message: ${anomaly.message}` : null,
  ].filter(Boolean);
  void sendTelegramMessage(lines.join("\n"), {
    dedupKey: `internal-anomaly:${anomaly.type}:${anomaly.processId || anomaly.shortId || "unknown"}`,
  }).catch(() => {});
};

function enqueueTelegramCommand(handler) {
  telegramCommandQueue.push(handler);
  runDetached("telegram-commands:drain", drainTelegramCommandQueue);
}

function drainTelegramCommandQueue() {
  while (
    telegramCommandActive < telegramCommandConcurrency &&
    telegramCommandQueue.length > 0
  ) {
    const job = telegramCommandQueue.shift();
    if (!job) {
      continue;
    }
    telegramCommandActive += 1;
    Promise.resolve()
      .then(job)
      .catch((err) => {
        console.warn(
          `[monitor] telegram command handler failed: ${err?.message || err}`,
        );
      })
      .finally(() => {
        telegramCommandActive -= 1;
        setImmediate(() => drainTelegramCommandQueue());
      });
  }
}

function normalizeTelegramCommand(text) {
  if (!text) {
    return null;
  }
  const trimmed = String(text).trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  const [raw, ...rest] = trimmed.split(/\s+/);
  const command = raw.split("@")[0].toLowerCase();
  return { command, args: rest.join(" ") };
}

function isAllowedTelegramChat(chatId) {
  if (!telegramChatId) {
    return true;
  }
  return String(chatId) === String(telegramChatId);
}

function limitLines(lines, limit = 8) {
  if (lines.length <= limit) {
    return lines;
  }
  const remaining = lines.length - limit;
  return [...lines.slice(0, limit), `- ...and ${remaining} more`];
}

function buildTaskUrl(task, projectId) {
  if (!task) {
    return null;
  }

  const taskId = task.id || task;
  const backend = getActiveKanbanBackend();

  // For GitHub, task object might have URL in meta
  if (backend === "github") {
    if (typeof task === "object" && task.meta?.url) {
      return task.meta.url;
    }
    // GitHub issue URL format
    const cfg = loadConfig();
    const slug = process.env.GITHUB_REPOSITORY || cfg?.repoSlug || "";
    if (!slug || slug === "unknown/unknown") {
      return null;
    }
    return `https://github.com/${slug}/issues/${String(taskId).replace(/^#/, "")}`;
  }

  // For VK backend
  if (backend === "vk") {
    const template = String(vkTaskUrlTemplate || "").trim();
    if (template) {
      return template
        .replace("{projectId}", projectId || "")
        .replace("{taskId}", taskId);
    }
    const base = String(vkPublicUrl || vkEndpointUrl || "").replace(/\/+$/, "");
    if (!base || !projectId) {
      return null;
    }
    return `${base}/local-projects/${projectId}/tasks/${taskId}`;
  }

  // Fallback for other backends
  return null;
}

function buildVkTaskUrl(taskId, projectId) {
  return buildTaskUrl(taskId, projectId);
}

function formatTaskLink(item) {
  const title = item.task_title || item.task_id || "(task)";
  if (item.task_url) {
    return formatHtmlLink(item.task_url, title);
  }
  return escapeHtml(title);
}

function formatAttemptLine(attempt) {
  if (!attempt) {
    return null;
  }
  const taskId = attempt.task_id ? escapeHtml(attempt.task_id) : "(task)";
  const branch = attempt.branch ? ` (${escapeHtml(attempt.branch)})` : "";
  const status = attempt.status ? ` — ${escapeHtml(attempt.status)}` : "";
  if (attempt.pr_number) {
    const prLabel = `#${attempt.pr_number}`;
    const prLink = formatHtmlLink(
      `${repoUrlBase}/pull/${attempt.pr_number}`,
      prLabel,
    );
    return `- ${taskId} ${prLink}${branch}${status}`;
  }
  return `- ${taskId}${branch}${status}`;
}

async function buildTasksResponse() {
  const status = await readStatusData();
  if (!status) {
    return {
      text: "Status unavailable (missing status file).",
      parseMode: null,
    };
  }

  const counts = status.counts || {};
  const attempts = status.attempts || {};
  const runningAttempts = Object.values(attempts).filter(
    (attempt) => attempt && attempt.status === "running",
  );

  const reviewTasks = Array.isArray(status.review_tasks)
    ? status.review_tasks
    : [];
  const errorTasks = Array.isArray(status.error_tasks)
    ? status.error_tasks
    : [];
  const manualReviewTasks = Array.isArray(status.manual_review_tasks)
    ? status.manual_review_tasks
    : [];
  const submitted = Array.isArray(status.submitted_tasks)
    ? status.submitted_tasks
    : [];

  const runningLines = limitLines(
    runningAttempts
      .map((attempt) => formatAttemptLine(attempt))
      .filter(Boolean),
  );
  const submittedLines = limitLines(
    submitted.map((item) => `- ${formatTaskLink(item)}`),
  );

  const reviewLines = reviewTasks.length
    ? limitLines(reviewTasks.map((taskId) => `- ${escapeHtml(taskId)}`))
    : ["- none"];
  const errorLines = errorTasks.length
    ? limitLines(errorTasks.map((taskId) => `- ${escapeHtml(taskId)}`))
    : ["- none"];
  const manualLines = manualReviewTasks.length
    ? limitLines(manualReviewTasks.map((taskId) => `- ${escapeHtml(taskId)}`))
    : ["- none"];

  const message = [
    `${projectName} Task Snapshot`,
    `Counts: running=${counts.running ?? 0}, review=${counts.review ?? 0}, error=${counts.error ?? 0}, manual_review=${counts.manual_review ?? 0}`,
    `Backlog remaining: ${status.backlog_remaining ?? 0}`,
    "Running attempts:",
    ...(runningLines.length ? runningLines : ["- none"]),
    "Recently submitted:",
    ...(submittedLines.length ? submittedLines : ["- none"]),
    "Needs review:",
    ...reviewLines,
    "Errors:",
    ...errorLines,
    "Manual review:",
    ...manualLines,
  ].join("\n");

  return { text: message, parseMode: "HTML" };
}

async function buildAgentResponse() {
  const status = await readStatusData();
  const attempts = status?.attempts || {};
  const runningAttempts = Object.values(attempts).filter(
    (attempt) => attempt && attempt.status === "running",
  );
  const activeLines = limitLines(
    runningAttempts
      .map((attempt) => formatAttemptLine(attempt))
      .filter(Boolean),
  );
  const orchestratorState = currentChild
    ? `Orchestrator running (pid ${currentChild.pid}).`
    : "Orchestrator not running.";
  const message = [
    `${projectName} Agent Status`,
    orchestratorState,
    `Active attempts: ${runningAttempts.length}`,
    ...(activeLines.length ? activeLines : ["- none"]),
  ].join("\n");
  return { text: message, parseMode: "HTML" };
}

async function buildBackgroundResponse() {
  const vkOnline = isVkRuntimeRequired() ? await isVibeKanbanOnline() : false;
  const vkStatus = isVkRuntimeRequired()
    ? vkOnline
      ? "online"
      : "unreachable"
    : "disabled";
  const now = Date.now();
  const halted =
    now < orchestratorHaltedUntil
      ? `halted until ${new Date(orchestratorHaltedUntil).toISOString()}`
      : "active";
  const safeMode =
    now < monitorSafeModeUntil
      ? `safe-mode until ${new Date(monitorSafeModeUntil).toISOString()}`
      : "normal";
  const message = [
    `${projectName} Background Status`,
    currentChild
      ? `Orchestrator: running (pid ${currentChild.pid})`
      : "Orchestrator: stopped",
    `Monitor state: ${halted}, ${safeMode}`,
    `Vibe-kanban: ${vkStatus}`,
  ].join("\n");
  return { text: message, parseMode: null };
}

async function buildHealthResponse() {
  const status = await readStatusData();
  const updatedAt = status?.updated_at
    ? new Date(status.updated_at).toISOString()
    : "unknown";
  const vkOnline = isVkRuntimeRequired() ? await isVibeKanbanOnline() : false;
  const vkStatus = isVkRuntimeRequired()
    ? vkOnline
      ? "online"
      : "unreachable"
    : "disabled";
  const message = [
    `${projectName} Health`,
    `Orchestrator: ${currentChild ? "running" : "stopped"}`,
    `Status updated: ${updatedAt}`,
    `Vibe-kanban: ${vkStatus}`,
  ].join("\n");
  return { text: message, parseMode: null };
}

async function handleTelegramUpdate(update) {
  if (!update) {
    return;
  }
  const message =
    update.message || update.edited_message || update.callback_query?.message;
  if (!message) {
    return;
  }
  const chatId = message.chat?.id;
  if (!chatId || !isAllowedTelegramChat(chatId)) {
    return;
  }
  const parsed = normalizeTelegramCommand(message.text || "");
  if (!parsed) {
    return;
  }

  let response = null;
  switch (parsed.command) {
    case "/status":
      response = await readStatusSummary();
      break;
    case "/tasks":
      response = await buildTasksResponse();
      break;
    case "/agent":
      response = await buildAgentResponse();
      break;
    case "/background":
      response = await buildBackgroundResponse();
      break;
    case "/health":
      response = await buildHealthResponse();
      break;
    case "/help":
    case "/start":
      response = {
        text: [
          `${projectName} Command Help`,
          "/status — summary snapshot",
          "/tasks — task breakdown",
          "/agent — active agent status",
          "/background — monitor status",
          "/health — service health",
        ].join("\n"),
        parseMode: null,
      };
      break;
    default:
      response = {
        text: "Unknown command. Send /help for available commands.",
        parseMode: null,
      };
      break;
  }

  if (!response || !response.text) {
    return;
  }

  await sendTelegramMessage(response.text, {
    chatId,
    parseMode: response.parseMode,
    disablePreview: true,
    skipDedup: true,
  });
}

async function fetchTelegramUpdates() {
  const url = `https://api.telegram.org/bot${telegramToken}/getUpdates`;
  const params = new URLSearchParams({
    offset: String(telegramUpdateOffset),
    timeout: String(Math.max(5, telegramCommandPollTimeoutSec)),
    limit: String(Math.max(1, telegramCommandMaxBatch)),
  });

  const controller = new AbortController();
  const timeoutMs = (telegramCommandPollTimeoutSec + 5) * 1000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${url}?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!res || !res.ok) {
      const body = res ? await res.text() : "";
      const status = res?.status || "no response";
      console.warn(`[monitor] telegram getUpdates failed: ${status} ${body}`);
      if (res?.status === 409) {
        telegramCommandEnabled = false;
        await releaseTelegramPollLock();
      }
      return [];
    }
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.result)) {
      return [];
    }
    return data.result;
  } catch (err) {
    if (err?.name !== "AbortError") {
      console.warn(
        `[monitor] telegram getUpdates error: ${err?.message || err}`,
      );
    }
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function pollTelegramCommands() {
  if (shuttingDown) {
    telegramCommandPolling = false;
    return;
  }
  if (!telegramCommandEnabled) {
    telegramCommandPolling = false;
    return;
  }
  try {
    const updates = await fetchTelegramUpdates();
    if (updates.length) {
      for (const update of updates) {
        if (typeof update.update_id === "number") {
          telegramUpdateOffset = update.update_id + 1;
        }
        enqueueTelegramCommand(async () => {
          try {
            await handleTelegramUpdate(update);
          } catch (err) {
            const message =
              err && err.message ? err.message : String(err || "unknown error");
            console.warn(`[monitor] telegram command crashed: ${message}`);
            const chatId = update.message?.chat?.id;
            if (chatId && isAllowedTelegramChat(chatId)) {
              await sendTelegramMessage(`Command failed: ${message}`, {
                chatId,
                skipDedup: true,
              });
            }
          }
        });
      }
    }
    const delayMs = updates.length ? 0 : 1000;
    setTimeout(pollTelegramCommands, delayMs);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(`[monitor] telegram command poll error: ${message}`);
    setTimeout(pollTelegramCommands, 3000);
  }
}

function startTelegramCommandListener() {
  if (!telegramToken || !telegramCommandEnabled) {
    return;
  }
  if (telegramCommandPolling) {
    return;
  }
  void acquireTelegramPollLock("monitor").then((ok) => {
    if (!ok) {
      telegramCommandEnabled = false;
      return;
    }
    telegramCommandPolling = true;
    void pollTelegramCommands();
  });
}

async function startTelegramNotifier() {
  if (telegramNotifierInterval) {
    clearInterval(telegramNotifierInterval);
    telegramNotifierInterval = null;
  }
  if (telegramNotifierTimeout) {
    clearTimeout(telegramNotifierTimeout);
    telegramNotifierTimeout = null;
  }
  if (!telegramToken || !telegramChatId) {
    console.warn(
      "[monitor] telegram notifier disabled (missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID)",
    );
    return;
  }
  if (!Number.isFinite(telegramIntervalMin) || telegramIntervalMin <= 0) {
    console.warn("[monitor] telegram notifier disabled (invalid interval)");
    return;
  }
  const intervalMs = telegramIntervalMin * 60 * 1000;
  const sendUpdate = async () => {
    const summary = await readStatusSummary();
    if (summary && summary.text) {
      // Push to the pinned status board (edits in-place) when available.
      // Fall back to a regular new message only if the board hasn't been set up.
      const routed = pushStatusBoardUpdate(summary.text, {
        parseMode: summary.parseMode,
      });
      if (!routed) {
        await sendTelegramMessage(summary.text, {
          parseMode: summary.parseMode,
          disablePreview: true,
        });
      }
    }
    await flushMergeNotifications();
    await checkStatusMilestones();
  };

  // Suppress "Notifier started" message on rapid restarts (e.g. code-change restarts).
  // If the last start was <60s ago, skip the notification — just log locally.
  const lastStartPath = resolve(
    repoRoot,
    ".cache",
    "ve-last-notifier-start.txt",
  );
  let suppressStartup = isSelfRestart;
  if (!suppressStartup) {
    try {
      const prev = await readFile(lastStartPath, "utf8");
      const elapsed = Date.now() - Number(prev);
      if (elapsed < 60_000) suppressStartup = true;
    } catch {
      /* first start or missing file */
    }
  }
  await writeFile(lastStartPath, String(Date.now())).catch(() => {});

  if (suppressStartup) {
    console.log(
      `[monitor] notifier restarted (suppressed telegram notification — rapid restart)`,
    );
  } else {
    runDetached("telegram-notifier:startup-message", () =>
      sendTelegramMessage(`${projectName} Orchestrator Notifier started.`),
    );
  }
  telegramNotifierTimeout = setTimeout(
    () => runDetached("telegram-notifier:timeout-update", sendUpdate),
    intervalMs,
  );
  telegramNotifierInterval = setInterval(
    () => runDetached("telegram-notifier:interval-update", sendUpdate),
    intervalMs,
  );
}

async function checkStatusMilestones() {
  const status = await readStatusData();
  if (!status) {
    return;
  }
  const counts = status.counts || {};
  const backlogRemaining = status.backlog_remaining ?? 0;
  const running = counts.running ?? 0;
  const review = counts.review ?? 0;
  const error = counts.error ?? 0;
  const localMaxParallel = getMaxParallelFromArgs(scriptArgs) || running || 1;

  // Fleet-aware capacity: use total fleet slots when fleet is active
  const fleet = fleetConfig?.enabled ? getFleetState() : null;
  const maxParallel =
    fleet && fleet.mode === "fleet" && fleet.totalSlots > 0
      ? fleet.totalSlots
      : localMaxParallel;
  const backlogPerCapita =
    maxParallel > 0 ? backlogRemaining / maxParallel : backlogRemaining;
  const idleSlots = Math.max(0, maxParallel - running);
  const staleTaskAgeHours = Number(process.env.STALE_TASK_AGE_HOURS || "24");
  const staleTaskCutoffMs =
    Date.now() - Math.max(1, staleTaskAgeHours) * 60 * 60 * 1000;
  const staleInProgressCount = (getInternalTasksByStatus("inprogress") || []).filter(
    (task) => {
      const updatedAt =
        Date.parse(task?.updated_at || task?.updatedAt || task?.meta?.updatedAt || 0) ||
        Date.parse(task?.created_at || task?.createdAt || 0);
      return Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt <= staleTaskCutoffMs;
    },
  ).length;

  const triggerContext = {
    backlogRemaining,
    backlogPerCapita,
    running,
    review,
    error,
    idleSlots,
    maxParallel,
    staleInProgressCount,
  };

  await evaluateTriggerTemplates(triggerContext);
  const triggerSystemEnabled = Boolean(triggerSystemConfig?.enabled);

  // Fleet-aware backlog depth check: if fleet is active, check if we need
  // more tasks to keep all workstations busy
  if (fleet && fleet.mode === "fleet") {
    const depth = calculateBacklogDepth({
      totalSlots: fleet.totalSlots,
      currentBacklog: backlogRemaining,
      bufferMultiplier: fleetConfig?.bufferMultiplier || 3,
    });
    if (depth.shouldGenerate && depth.deficit > 0) {
      // Only coordinator triggers planner to avoid duplicates
      if (isFleetCoordinator() && triggerSystemEnabled) {
        await maybeTriggerTaskPlanner("fleet-deficit", {
          backlogRemaining,
          targetDepth: depth.targetDepth,
          deficit: depth.deficit,
          fleetSize: fleet.fleetSize,
          totalSlots: fleet.totalSlots,
          formula: depth.formula,
        });
      }
    }

    // Maintenance mode detection
    const maintenance = detectMaintenanceMode({
      backlog_remaining: backlogRemaining,
      counts,
    });
    if (maintenance.isMaintenanceMode && isFleetCoordinator()) {
      if (!allCompleteNotified) {
        allCompleteNotified = true;
        await sendTelegramMessage(
          `:server: Fleet entering maintenance mode: ${maintenance.reason}`,
        );
      }
      return;
    }
  }

  if (
    !allCompleteNotified &&
    backlogRemaining === 0 &&
    running === 0 &&
    review === 0 &&
    error === 0
  ) {
    allCompleteNotified = true;
    await sendTelegramMessage(
      "All tasks completed. Orchestrator backlog is empty.",
    );
    if (triggerSystemEnabled) {
      await maybeTriggerTaskPlanner("backlog-empty", {
        backlogRemaining,
        backlogPerCapita,
        running,
        review,
        error,
        idleSlots,
        maxParallel,
      });
    }
    return;
  }

  // Planner triggers: reset notification flags each cycle so we can
  // re-trigger if conditions persist and dedup window has passed.
  // The dedup state file prevents rapid re-triggering (default 6h).
  const plannerConditionsMet =
    backlogRemaining > 0 &&
    Number.isFinite(backlogPerCapita) &&
    backlogPerCapita < plannerPerCapitaThreshold;
  const idleConditionsMet = idleSlots >= plannerIdleSlotThreshold;

  if (plannerConditionsMet) {
    if (!backlogLowNotified) {
      backlogLowNotified = true;
      await sendTelegramMessage(
        `Backlog per-capita low: ${backlogRemaining} tasks for ${maxParallel} slots (${backlogPerCapita.toFixed(
          2,
        )} per slot). Triggering task planner.`,
      );
    }
    if (triggerSystemEnabled) {
      await maybeTriggerTaskPlanner("backlog-per-capita", {
        backlogRemaining,
        backlogPerCapita,
        running,
        review,
        error,
        idleSlots,
        maxParallel,
        threshold: plannerPerCapitaThreshold,
      });
    }
    return;
  } else {
    // Conditions no longer met — reset so we re-notify next time
    backlogLowNotified = false;
  }

  if (idleConditionsMet) {
    if (!idleAgentsNotified) {
      idleAgentsNotified = true;
      await sendTelegramMessage(
        `Agents idle: ${idleSlots} slot(s) available (running ${running}/${maxParallel}). Triggering task planner.`,
      );
    }
    if (triggerSystemEnabled) {
      await maybeTriggerTaskPlanner("idle-slots", {
        backlogRemaining,
        backlogPerCapita,
        running,
        review,
        error,
        idleSlots,
        maxParallel,
        threshold: plannerIdleSlotThreshold,
      });
    }
  } else {
    idleAgentsNotified = false;
  }
}

function compareTriggerMetric(left, operator, right) {
  switch (String(operator || "eq").toLowerCase()) {
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "neq":
      return left !== right;
    case "eq":
    default:
      return left === right;
  }
}

function getTriggerTemplateState(state, templateId) {
  const map = state?.trigger_templates;
  if (!map || typeof map !== "object") return null;
  return map[templateId] || null;
}

async function updateTriggerTemplateState(templateId, patch) {
  const current = (await readPlannerState()) || {};
  const templates =
    current.trigger_templates && typeof current.trigger_templates === "object"
      ? { ...current.trigger_templates }
      : {};
  templates[templateId] = {
    ...(templates[templateId] || {}),
    ...patch,
  };
  await writePlannerState({
    ...current,
    trigger_templates: templates,
  });
}

function resolveTemplateMinIntervalMs(template) {
  const minIntervalMinutes = Number(template?.minIntervalMinutes || 0);
  if (Number.isFinite(minIntervalMinutes) && minIntervalMinutes > 0) {
    return minIntervalMinutes * 60 * 1000;
  }
  return plannerDedupMs;
}

function evaluateTemplateCondition(condition, context, lastSuccessMs) {
  if (!condition || typeof condition !== "object") return false;
  const kind = String(condition.kind || "metric").toLowerCase();
  if (kind === "interval") {
    const minutes = Number(condition.minutes || 0);
    if (!Number.isFinite(minutes) || minutes <= 0) return false;
    if (!Number.isFinite(lastSuccessMs) || lastSuccessMs <= 0) return true;
    return Date.now() - lastSuccessMs >= minutes * 60 * 1000;
  }
  const metric = String(condition.metric || "").trim();
  if (!metric || !(metric in context)) return false;
  const left = Number(context[metric]);
  const right = Number(condition.value);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
  return compareTriggerMetric(left, condition.operator, right);
}

async function evaluateTriggerTemplates(context) {
  const system = triggerSystemConfig || {};
  if (!system.enabled) return;
  const templates = Array.isArray(system.templates) ? system.templates : [];
  if (templates.length === 0) return;

  const state = (await readPlannerState()) || {};

  for (const template of templates) {
    if (!template || template.enabled !== true) continue;
    const templateId = String(template.id || template.name || "").trim();
    if (!templateId) continue;

    const templateState = getTriggerTemplateState(state, templateId);
    const lastSuccessMs = Date.parse(templateState?.last_success_at || 0);
    const minIntervalMs = resolveTemplateMinIntervalMs(template);
    if (Number.isFinite(lastSuccessMs) && lastSuccessMs > 0) {
      const elapsed = Date.now() - lastSuccessMs;
      if (elapsed < minIntervalMs) {
        continue;
      }
    }

    const rules = Array.isArray(template?.trigger?.anyOf)
      ? template.trigger.anyOf
      : [];
    if (rules.length === 0) continue;

    const shouldRun = rules.some((condition) =>
      evaluateTemplateCondition(condition, context, lastSuccessMs),
    );
    if (!shouldRun) continue;

    try {
      const action = String(template.action || "").toLowerCase();
      const templateConfig =
        template.config && typeof template.config === "object"
          ? template.config
          : {};
      const defaultExecutor =
        system.defaults && typeof system.defaults === "object"
          ? String(system.defaults.executor || "auto")
          : "auto";
      const defaultModel =
        system.defaults && typeof system.defaults === "object"
          ? String(system.defaults.model || "auto")
          : "auto";
      const executorOverride =
        String(templateConfig.executor || defaultExecutor || "auto").trim();
      const modelOverride =
        String(templateConfig.model || defaultModel || "auto").trim();

      if (action === "task-planner") {
        await maybeTriggerTaskPlanner(`trigger:${templateId}`, {
          templateId,
          ...context,
        }, {
          preferredMode:
            templateConfig.plannerMode === "kanban" ||
            templateConfig.plannerMode === "codex-sdk"
              ? templateConfig.plannerMode
              : undefined,
          taskCount: Number(templateConfig.defaultTaskCount || 0) || undefined,
          executorSdk:
            executorOverride && executorOverride !== "auto"
              ? executorOverride
              : undefined,
          model:
            modelOverride && modelOverride !== "auto"
              ? modelOverride
              : undefined,
        });
      } else if (action === "create-task") {
        const title = String(templateConfig.title || "").trim();
        if (!title) continue;
        const dedup = normalizePlannerTitleForComparison(title);
        const existing = [
          ...(getInternalTasksByStatus("todo") || []),
          ...(getInternalTasksByStatus("inprogress") || []),
          ...(getInternalTasksByStatus("inreview") || []),
        ].some((task) => normalizePlannerTitleForComparison(task?.title) === dedup);
        if (!existing) {
          addInternalTask({
            id: randomUUID(),
            title,
            description: String(templateConfig.description || "").trim(),
            status: "todo",
            priority: String(templateConfig.priority || "").trim() || undefined,
            projectId: process.env.INTERNAL_EXECUTOR_PROJECT_ID || "internal",
            syncDirty: true,
            meta: {
              triggerTemplate: {
                id: templateId,
                source: "trigger-system",
                createdAt: new Date().toISOString(),
              },
              execution: {
                executor:
                  executorOverride && executorOverride !== "auto"
                    ? executorOverride
                    : undefined,
                model:
                  modelOverride && modelOverride !== "auto"
                    ? modelOverride
                    : undefined,
              },
            },
          });
        }
      }

      await updateTriggerTemplateState(templateId, {
        last_triggered_at: new Date().toISOString(),
        last_success_at: new Date().toISOString(),
        last_error: null,
      });
    } catch (err) {
      await updateTriggerTemplateState(templateId, {
        last_triggered_at: new Date().toISOString(),
        last_error: err?.message || String(err || "unknown"),
        last_failure_at: new Date().toISOString(),
      });
      console.warn(
        `[monitor] trigger template failed (${template?.id || template?.name || "unknown"}): ${err?.message || err}`,
      );
    }
  }
}

async function triggerTaskPlanner(
  reason,
  details,
  {
    taskCount,
    userPrompt,
    notify = true,
    preferredMode,
    allowCodexWhenDisabled = false,
    executorSdk,
    model,
  } = {},
) {
  if (internalTaskExecutor?.isPaused?.()) {
    return { status: "skipped", reason: "executor_paused" };
  }
  if (plannerMode === "disabled") {
    return { status: "skipped", reason: "planner_disabled" };
  }
  if (plannerTriggered) {
    return { status: "skipped", reason: "planner_busy" };
  }

  const requestedMode =
    preferredMode === "kanban" || preferredMode === "codex-sdk"
      ? preferredMode
      : null;
  const effectiveMode = requestedMode || plannerMode;

  plannerTriggered = true;
  await updatePlannerState({
    last_triggered_at: new Date().toISOString(),
    last_trigger_reason: reason || "manual",
    last_trigger_details: details || null,
    last_trigger_mode: effectiveMode,
  });

  try {
    let result;
    if (effectiveMode === "kanban") {
      try {
        result = await triggerTaskPlannerViaKanban(reason, details, {
          taskCount,
          userPrompt,
          notify,
          executorSdk,
          model,
        });
      } catch (kanbanErr) {
        const message = kanbanErr?.message || String(kanbanErr || "");
        const backend = getActiveKanbanBackend();
        const fallbackEligible =
          codexEnabled &&
          [
            "cannot reach",
            "no project found",
            "gh cli failed",
            "vk api",
            "network error",
          ].some((token) => message.toLowerCase().includes(token));

        if (!fallbackEligible) {
          throw kanbanErr;
        }

        console.warn(
          `[monitor] task planner kanban path failed on backend=${backend}; falling back to codex-sdk: ${message}`,
        );
        if (notify) {
          await sendTelegramMessage(
            `:alert: Task planner kanban path failed on ${backend}; using codex fallback.\nReason: ${message}`,
          );
        }
        result = await triggerTaskPlannerViaCodex(reason, details, {
          taskCount,
          userPrompt,
          notify,
          allowWhenDisabled: allowCodexWhenDisabled,
          executorSdk,
          model,
        });
      }
    } else if (effectiveMode === "codex-sdk") {
      try {
        result = await triggerTaskPlannerViaCodex(reason, details, {
          taskCount,
          userPrompt,
          notify,
          allowWhenDisabled: allowCodexWhenDisabled,
          executorSdk,
          model,
        });
      } catch (codexErr) {
        const codexMessage = codexErr?.message || String(codexErr || "");
        const allowKanbanFallback =
          requestedMode === "codex-sdk" && plannerMode === "kanban";

        if (!allowKanbanFallback) {
          throw codexErr;
        }

        console.warn(
          `[monitor] task planner codex path failed; falling back to kanban planner mode: ${codexMessage}`,
        );
        if (notify) {
          await sendTelegramMessage(
            `:alert: Task planner codex path failed; trying kanban fallback.\nReason: ${codexMessage}`,
          );
        }

        result = await triggerTaskPlannerViaKanban(reason, details, {
          taskCount,
          userPrompt,
          notify,
          executorSdk,
          model,
        });
      }
    } else {
      throw new Error(`Unknown planner mode: ${effectiveMode}`);
    }
    runDetached("task-planner-status:trigger-success", () =>
      publishTaskPlannerStatus("trigger-success"),
    );
    return result;
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await updatePlannerState({
      last_error: message,
      last_failure_at: new Date().toISOString(),
      last_failure_reason: reason || "manual",
    });
    if (notify) {
      await sendTelegramMessage(
        `Task planner run failed (${effectiveMode}): ${message}`,
      );
    }
    runDetached("task-planner-status:trigger-failed", () =>
      publishTaskPlannerStatus("trigger-failed"),
    );
    throw err; // re-throw so callers (e.g. /plan command) know it failed
  } finally {
    plannerTriggered = false;
  }
}

/**
 * Trigger the task planner by creating a kanban task — a real agent will
 * pick it up and plan the next phase of work.
 */
async function triggerTaskPlannerViaKanban(
  reason,
  details,
  { taskCount, userPrompt, notify = true, executorSdk, model } = {},
) {
  const defaultPlannerTaskCount = Number(
    process.env.TASK_PLANNER_DEFAULT_COUNT || "30",
  );
  const numTasks =
    taskCount && Number.isFinite(taskCount) && taskCount > 0
      ? taskCount
      : defaultPlannerTaskCount;
  const plannerPrompt = agentPrompts.planner;
  const plannerTaskSizeLabel = String(
    process.env.TASK_PLANNER_TASK_SIZE_LABEL || "m",
  ).toLowerCase();
  const runtimeContext = await buildPlannerRuntimeContext(
    reason,
    details,
    numTasks,
  );

  const desiredTitle = userPrompt
    ? `[${plannerTaskSizeLabel}] Plan next tasks (${reason || "backlog-empty"}) — ${userPrompt.slice(0, 60)}${userPrompt.length > 60 ? "…" : ""}`
    : `[${plannerTaskSizeLabel}] Plan next tasks (${reason || "backlog-empty"})`;
  const desiredDescription = buildPlannerTaskDescription({
    plannerPrompt,
    reason,
    numTasks,
    runtimeContext,
    userPrompt,
  });

  // Check for existing planner tasks to avoid duplicates
  // Only block on TODO tasks whose title matches the exact format we create
  const existingTasks = getInternalTasksByStatus("todo");
  const existingPlanner = (
    Array.isArray(existingTasks) ? existingTasks : []
  ).find((t) => {
    // Double-check status client-side
    if (t.status && t.status !== "todo") return false;
    const title = String(t.title || "").toLowerCase();
    const normalizedTitle = title.replace(/^\[[^\]]+\]\s*/, "").trim();
    // Only match the exact title format we create: "Plan next tasks (...)"
    return (
      normalizedTitle.startsWith("plan next tasks") ||
      normalizedTitle.startsWith("plan next phase")
    );
  });
  if (existingPlanner) {
    console.log(
      `[monitor] task planner task already exists in backlog — skipping: "${existingPlanner.title}" (${existingPlanner.id})`,
    );
    // Best-effort: keep backlog task aligned with current requirements
    // Update description if the backend supports it, so the agent gets fresh context
    try {
      await updateKanbanTask(existingPlanner.id, {
        description: desiredDescription,
      });
      console.log(
        `[monitor] updated description of existing planner task: "${existingPlanner.title}" (${existingPlanner.id})`,
      );
    } catch (updateErr) {
      // Not all backends support partial description updates — log and continue
      console.log(
        `[monitor] could not update existing planner task description (${updateErr.message || updateErr}) — skipping`,
      );
    }

    const taskUrl = null;
    if (notify) {
      const suffix = taskUrl ? `\n${taskUrl}` : "";
      await sendTelegramMessage(
        `:clipboard: Task planner skipped — existing planning task found.${suffix}`,
      );
    }
    await updatePlannerState({
      last_success_at: new Date().toISOString(),
      last_success_reason: reason || "manual",
      last_error: null,
      last_result: "existing_planner_task",
    });
    return {
      status: "skipped",
      reason: "existing_planner_task",
      taskId: existingPlanner.id,
      taskTitle: existingPlanner.title,
      taskUrl,
      projectId: process.env.INTERNAL_EXECUTOR_PROJECT_ID || "internal",
    };
  }

  const taskData = {
    title: desiredTitle,
    description: desiredDescription,
    status: "todo",
  };

  const createdTask = addInternalTask({
    id: randomUUID(),
    title: taskData.title,
    description: taskData.description,
    status: "todo",
    projectId: process.env.INTERNAL_EXECUTOR_PROJECT_ID || "internal",
    syncDirty: true,
    meta: {
      planner: {
        source: "task-planner",
        plannerMode: "kanban",
        kind: "planner-request",
        triggerReason: reason || "manual",
        externalSyncPending: true,
        createdAt: new Date().toISOString(),
      },
      execution: {
        sdk:
          executorSdk && executorSdk !== "auto" ? String(executorSdk).trim() : undefined,
        model: model && model !== "auto" ? String(model).trim() : undefined,
      },
    },
  });

  if (createdTask && createdTask.id) {
    console.log(`[monitor] task planner task created: ${createdTask.id}`);
    await updatePlannerState({
      last_success_at: new Date().toISOString(),
      last_success_reason: reason || "manual",
      last_error: null,
      last_result: "kanban_task_created",
    });
    const createdId = createdTask.id;
    const createdUrl = null;
    if (notify) {
      const suffix = createdUrl ? `\n${createdUrl}` : "";
      await sendTelegramMessage(
        `:clipboard: Task planner: created task for next phase planning (${reason}).${suffix}`,
      );
    }
    return {
      status: "created",
      taskId: createdId,
      taskTitle: taskData.title,
      taskUrl: createdUrl,
      projectId: process.env.INTERNAL_EXECUTOR_PROJECT_ID || "internal",
    };
  }
  throw new Error("Task creation failed");
}

/**
 * Trigger the task planner via Codex SDK — runs the planner prompt directly
 * in an in-process Codex thread.
 */
async function triggerTaskPlannerViaCodex(
  reason,
  details,
  {
    taskCount,
    userPrompt,
    notify = true,
    allowWhenDisabled = false,
    executorSdk,
    model,
  } = {},
) {
  if (!codexEnabled && !allowWhenDisabled) {
    throw new Error(
      "Codex SDK disabled — use TASK_PLANNER_MODE=kanban instead",
    );
  }
  notifyCodexTrigger("task planner run");
  if (!CodexClient) {
    CodexClient = await loadCodexSdk();
  }
  if (!CodexClient) {
    throw new Error("Codex SDK not available");
  }
  const numTasks =
    taskCount && Number.isFinite(taskCount) && taskCount > 0
      ? taskCount
      : Number(process.env.TASK_PLANNER_DEFAULT_COUNT || "30");
  const runtimeContext = await buildPlannerRuntimeContext(
    reason,
    details,
    numTasks,
  );
  const agentPrompt = agentPrompts.planner;
  const codexOpts = buildCodexSdkOptionsForMonitor();
  const codex = new CodexClient(codexOpts);
  const threadOpts = { skipGitRepoCheck: true, workingDirectory: repoRoot, approvalPolicy: "never" };
  console.log(`[monitor] task planner codex: cwd=${process.cwd()}, workingDir=${repoRoot}, skipGitRepoCheck=true`);
  const thread = codex.startThread(threadOpts);
  const prompt = [
    agentPrompt,
    "",
    "## Execution Context",
    `- Trigger reason: ${reason || "manual"}`,
    `- Requested task count: ${numTasks}`,
    ...(userPrompt
      ? [
          "",
          "## User Planning Prompt",
          "",
          userPrompt,
          "",
          "Incorporate the above user prompt into any relevant planning decisions.",
        ]
      : []),
    "",
    "Context JSON:",
    "```json",
    safeJsonBlock(runtimeContext),
    "```",
    "",
    "Produce the planning output now. Do not call any external task APIs.",
    "Return a strict JSON code block with the tasks payload required by the prompt.",
  ].join("\n");
  const result = await thread.run(prompt);
  const outPath = resolve(logDir, `task-planner-${nowStamp()}.md`);
  const output = formatCodexResult(result);
  await writeFile(outPath, output, "utf8");
  const parsedTasks = extractPlannerTasksFromOutput(output, numTasks);
  if (parsedTasks.length === 0) {
    throw new Error(
      "Task planner output did not contain parseable JSON tasks; expected a fenced ```json block with a tasks array",
    );
  }

  const plannerArtifactDir = resolve(repoRoot, ".bosun", ".cache");
  await mkdir(plannerArtifactDir, { recursive: true });
  const artifactPath = resolve(
    plannerArtifactDir,
    `task-planner-${nowStamp()}.tasks.json`,
  );
  await writeFile(
    artifactPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        trigger_reason: reason || "manual",
        requested_task_count: numTasks,
        parsed_task_count: parsedTasks.length,
        tasks: parsedTasks,
      },
      null,
      2,
    ),
    "utf8",
  );

  const { created, skipped } = await materializePlannerTasksToKanban(
    parsedTasks.map((task) => ({
      ...task,
      execution: {
        sdk:
          executorSdk && executorSdk !== "auto"
            ? String(executorSdk).trim()
            : undefined,
        model: model && model !== "auto" ? String(model).trim() : undefined,
      },
    })),
  );

  if (created.length === 0) {
    throw new Error(
      `Task planner parsed ${parsedTasks.length} tasks but created 0 tasks after dedup/materialization`,
    );
  }

  console.log(`[monitor] task planner output saved: ${outPath}`);
  console.log(
    `[monitor] task planner artifact saved: ${artifactPath} (parsed=${parsedTasks.length}, created=${created.length}, skipped=${skipped.length})`,
  );
  await updatePlannerState({
    last_success_at: new Date().toISOString(),
    last_success_reason: reason || "manual",
    last_error: null,
    last_result: `codex_planner_completed:${created.length}`,
  });
  if (notify) {
    await sendTelegramMessage(
      `:clipboard: Task planner run completed (${reason || "manual"}). Created ${created.length}/${parsedTasks.length} tasks.${
        skipped.length > 0
          ? ` Skipped ${skipped.length} duplicates/failed.`
          : ""
      }\nOutput: ${outPath}\nArtifact: ${artifactPath}`,
    );
  }
  return {
    status: "completed",
    outputPath: outPath,
    artifactPath,
    projectId: process.env.INTERNAL_EXECUTOR_PROJECT_ID || "internal",
    parsedTaskCount: parsedTasks.length,
    createdTaskCount: created.length,
    skippedTaskCount: skipped.length,
  };
}

async function ensureLogDir() {
  await mkdir(logDir, { recursive: true });
}

/**
 * Truncate the log directory to stay within logMaxSizeMb.
 * Deletes oldest files first until total size is under the limit.
 * Returns { deletedCount, freedBytes, totalBefore, totalAfter }.
 */
async function truncateOldLogs() {
  if (!logMaxSizeMb || logMaxSizeMb <= 0)
    return { deletedCount: 0, freedBytes: 0 };
  const { readdir, stat: fsStat } = await import("node:fs/promises");
  const maxBytes = logMaxSizeMb * 1024 * 1024;
  let entries;
  try {
    entries = await readdir(logDir);
  } catch {
    return { deletedCount: 0, freedBytes: 0 };
  }
  // Gather file info
  const files = [];
  for (const name of entries) {
    const filePath = resolve(logDir, name);
    try {
      const s = await fsStat(filePath);
      if (s.isFile()) {
        files.push({ name, path: filePath, size: s.size, mtimeMs: s.mtimeMs });
      }
    } catch {
      /* skip inaccessible files */
    }
  }
  const totalBefore = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBefore <= maxBytes) {
    return {
      deletedCount: 0,
      freedBytes: 0,
      totalBefore,
      totalAfter: totalBefore,
    };
  }
  // Sort oldest first
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let currentSize = totalBefore;
  let deletedCount = 0;
  let freedBytes = 0;
  for (const f of files) {
    if (currentSize <= maxBytes) break;
    try {
      await unlink(f.path);
      currentSize -= f.size;
      freedBytes += f.size;
      deletedCount++;
    } catch {
      /* skip locked/active files */
    }
  }
  const totalAfter = currentSize;
  if (deletedCount > 0) {
    const mbFreed = (freedBytes / 1024 / 1024).toFixed(1);
    const mbAfter = (totalAfter / 1024 / 1024).toFixed(1);
    console.log(
      `[monitor] log rotation: deleted ${deletedCount} old log files, freed ${mbFreed} MB (${mbAfter} MB / ${logMaxSizeMb} MB limit)`,
    );
  }
  return { deletedCount, freedBytes, totalBefore, totalAfter };
}

async function finalizeActiveLog(activePath, archivePath) {
  try {
    await rename(activePath, archivePath);
  } catch {
    try {
      await copyFile(activePath, archivePath);
      await unlink(activePath);
    } catch {
      // Best effort only.
    }
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (v) => String(v).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours(),
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function commandExists(cmd) {
  try {
    execSync(`${process.platform === "win32" ? "where" : "which"} ${cmd}`, {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function safeStringify(value) {
  const seen = new Set();
  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) {
            return "[Circular]";
          }
          seen.add(val);
        }
        if (typeof val === "bigint") {
          return val.toString();
        }
        return val;
      },
      2,
    );
  } catch {
    return null;
  }
}

function formatCodexResult(result) {
  if (result === null || result === undefined) {
    return "";
  }
  if (typeof result === "string") {
    return result;
  }
  if (typeof result === "number" || typeof result === "boolean") {
    return String(result);
  }
  if (typeof result === "object") {
    const candidates = [
      result.finalResponse,
      result.output,
      result.text,
      result.message,
      result.content,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate;
      }
    }
    const serialized = safeStringify(result);
    if (serialized) {
      return serialized;
    }
  }
  return String(result);
}

async function analyzeWithCodex(logPath, logText, reason) {
  if (!codexEnabled) {
    return;
  }
  notifyCodexTrigger(`orchestrator analysis (${reason})`);

  // ── Build a workspace-aware prompt ────────────────────────────────────
  // The old approach used CodexClient SDK (chat-only, no file access).
  // The new approach uses `codex exec` with --full-auto so the agent can
  // actually read files, inspect git status, and give a real diagnosis.
  const logTail = logText.slice(-12000);
  const prompt = `You are diagnosing why the bosun orchestrator exited.
You have FULL READ ACCESS to the workspace. Use it.

## Context
- Exit reason: ${reason}
- Orchestrator script: ${scriptPath}
- Repository root: ${repoRoot}
- Active log file: ${logPath}
- Monitor script: scripts/bosun/monitor.mjs
- VK endpoint: ${vkEndpointUrl || "(not set)"}
- Git branch: ${(() => {
    try {
      return execSync("git branch --show-current", {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
    } catch {
      return "unknown";
    }
  })()}

## Log tail (last ~12k chars)
\`\`\`
${logTail}
\`\`\`

## Instructions
1. READ the orchestrator script (${scriptPath}) to understand the code flow
2. READ any relevant source files referenced in the log
3. Check git status/diff if relevant
4. Diagnose the ROOT CAUSE — not surface symptoms
5. Do NOT edit or create any files. Analysis only.
6. Common issues:
   - Path errors: worktree paths don't contain the orchestrator script
   - Mutex contention: multiple instances fighting over named mutex
   - VK API failures: wrong HTTP method, endpoint down, auth issues
   - Git rebase conflicts: agent branches conflict with main
   - Exit 64 / ENOENT: shell runtime can't locate the orchestrator target
   - SIGKILL: OOM or external termination
7. Return a SHORT, ACTIONABLE diagnosis with the concrete fix.`;

  try {
    // Use runCodexExec from autofix.mjs — gives Codex workspace access
    const result = await runCodexExec(prompt, repoRoot, 1_800_000);

    const analysisPath = logPath.replace(/\.log$/, "-analysis.txt");
    const analysisText = result.output || result.error || "(no output)";
    await writeFile(analysisPath, analysisText, "utf8");

    if (telegramToken && telegramChatId) {
      const summary = analysisText.slice(0, 500).replace(/\n{3,}/g, "\n\n");
      void sendTelegramMessage(
        `:search: Codex Analysis Result (${reason}):\n${summary}${analysisText.length > 500 ? "\n...(truncated)" : ""}`,
      );
    }
  } catch (err) {
    // Fallback: try the SDK chat approach if exec is unavailable
    try {
      if (!CodexClient) {
        const ready = await ensureCodexSdkReady();
        if (!ready) throw new Error(codexDisabledReason || "Codex SDK N/A");
      }
      const codex = new CodexClient(buildCodexSdkOptionsForMonitor());
      const thread = codex.startThread({ skipGitRepoCheck: true, workingDirectory: repoRoot, approvalPolicy: "never" });
      const result = await thread.run(prompt);
      const analysisPath = logPath.replace(/\.log$/, "-analysis.txt");
      const analysisText = formatCodexResult(result);
      await writeFile(analysisPath, analysisText, "utf8");
      if (telegramToken && telegramChatId) {
        const summary = analysisText.slice(0, 500).replace(/\n{3,}/g, "\n\n");
        void sendTelegramMessage(
          `:search: Codex Analysis Result (${reason}):\n${summary}${analysisText.length > 500 ? "\n...(truncated)" : ""}`,
        );
      }
    } catch (fallbackErr) {
      const analysisPath = logPath.replace(/\.log$/, "-analysis.txt");
      const message = fallbackErr?.message || String(fallbackErr);
      await writeFile(
        analysisPath,
        `Codex analysis failed: ${message}\n`,
        "utf8",
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(`:search: Codex Analysis Failed: ${message}`);
      }
    }
  }
}

async function loadCodexSdk() {
  const result = await tryImportCodex();
  if (result) {
    return result;
  }

  const installResult = installDependencies();
  if (!installResult) {
    return null;
  }

  return await tryImportCodex();
}

async function tryImportCodex() {
  try {
    const mod = await import("@openai/codex-sdk");
    return mod.Codex;
  } catch (err) {
    return null;
  }
}

function installDependencies() {
  const cwd = __dirname;
  const pnpm = spawnSync("pnpm", ["--version"], { stdio: "ignore" });
  if (pnpm.status === 0) {
    const res = spawnSync("pnpm", ["install"], { cwd, stdio: "inherit" });
    return res.status === 0;
  }

  const corepack = spawnSync("corepack", ["--version"], { stdio: "ignore" });
  if (corepack.status === 0) {
    const res = spawnSync("corepack", ["pnpm", "install"], {
      cwd,
      stdio: "inherit",
    });
    return res.status === 0;
  }

  const npm = spawnSync("npm", ["install"], { cwd, stdio: "inherit" });
  return npm.status === 0;
}

async function ensureCodexSdkReady() {
  if (!codexEnabled) {
    return false;
  }
  const client = await loadCodexSdk();
  if (!client) {
    codexEnabled = false;
    codexDisabledReason =
      "Codex SDK not available (install failed or module missing)";
    console.warn(`[monitor] ${codexDisabledReason}`);
    return false;
  }
  CodexClient = client;
  return true;
}

function hasContextWindowError(text) {
  return contextPatterns.some((pattern) =>
    text.toLowerCase().includes(pattern.toLowerCase()),
  );
}

async function handleExit(code, signal, logPath) {
  if (shuttingDown) {
    return;
  }

  const logText = await readFile(logPath, "utf8").catch(() => "");
  const reason = signal ? `signal ${signal}` : `exit ${code}`;
  const isSigKill = signal === "SIGKILL";

  // ── Check if this is an intentional restart BEFORE clearing flags ──
  const isFileChangeRestart = pendingRestart && skipNextAnalyze;
  const isAbnormalExit = Boolean(signal) || code !== 0;
  const isCleanExit = !isAbnormalExit; // exit code 0, no signal

  if (pendingRestart) {
    pendingRestart = false;
    skipNextAnalyze = false;
    if (!skipNextRestartCount) {
      restartCount += 1;
    }
    skipNextRestartCount = false;

    // File-change restarts don't need analysis or auto-fix
    if (isFileChangeRestart) {
      console.log(
        `[monitor] intentional restart (${reason}) — skipping autofix`,
      );
      startProcess();
      return;
    }
  }

  // ── Track quick exits for crash-loop detection ──────────────────────
  const runDurationMs = restartController.lastProcessStartAt
    ? Date.now() - restartController.lastProcessStartAt
    : Infinity;

  // ── Mutex-held: orchestrator found another instance holding the mutex ──
  const isMutexHeld =
    restartController.mutexHeldDetected ||
    logText.includes("Another orchestrator instance is already running") ||
    logText.includes("mutex held");
  const exitState = restartController.recordExit(runDurationMs, isMutexHeld);

  if (exitState.backoffReset) {
    console.log("[monitor] orchestrator ran >20s — resetting mutex backoff");
  }

  if (exitState.isMutexHeld) {
    console.warn(
      `[monitor] mutex held detected — backing off ${exitState.backoffMs / 1000}s ` +
        `(consecutive quick exits: ${exitState.consecutiveQuickExits})`,
    );
    if (telegramToken && telegramChatId) {
      void sendTelegramMessage(
        `:clock: Mutex held — backing off ${exitState.backoffMs / 1000}s before retry`,
      );
    }
    restartCount += 1;
    setTimeout(startProcess, exitState.backoffMs);
    return;
  }

  // ── External kill (SIGKILL): treat as non-actionable, restart quietly ──
  if (isSigKill) {
    console.warn(
      `[monitor] orchestrator killed by ${reason} — skipping autofix/analysis`,
    );
    restartCount += 1;
    setTimeout(startProcess, restartDelayMs);
    return;
  }

  // ── Benign exit 1: orchestrator ran normally but PowerShell propagated a
  // non-zero $LASTEXITCODE from the last native command (git/gh).  Detect by
  // checking that the log has no actual errors — just normal cycle messages.
  if (
    code === 1 &&
    !signal &&
    logText.length > 200 &&
    !logText.includes("ERROR") &&
    !logText.includes("FATAL") &&
    !logText.includes("Unhandled exception") &&
    (logText.includes("Sleeping") || logText.includes("next cycle"))
  ) {
    console.log(
      `[monitor] benign exit 1 detected (no errors in log, normal cycles) — restarting without autofix`,
    );
    restartCount += 1;
    setTimeout(startProcess, restartDelayMs);
    return;
  }

  // ── Clean exit: skip autofix/analysis, handle backlog-empty gracefully ──
  if (isCleanExit) {
    const isEmptyBacklog =
      logText.includes("ALL TASKS COMPLETE") ||
      logText.includes("No more todo tasks in backlog") ||
      logText.includes("All tasks completed");

    if (isEmptyBacklog) {
      if (triggerSystemConfig?.enabled) {
        console.log(
          "[monitor] clean exit with empty backlog — triggering task planner",
        );
        await maybeTriggerTaskPlanner("backlog-empty-exit", {
          reason: "Orchestrator exited cleanly with empty backlog",
        });
      }
      // Wait before restarting so the planner has time to create tasks
      const plannerWaitMs = 2 * 60 * 1000; // 2 minutes
      console.log(
        `[monitor] waiting ${plannerWaitMs / 1000}s for planner before restart`,
      );
      setTimeout(startProcess, plannerWaitMs);
      return;
    }

    // Other clean exits (e.g., Stop-Requested) — just restart normally
    console.log(
      `[monitor] clean exit (${reason}) — restarting without analysis`,
    );
    restartCount += 1;
    setTimeout(startProcess, restartDelayMs);
    return;
  }

  // ── Auto-fix: runs in BACKGROUND only for genuine monitor/orchestrator crashes ──
  // STRICT trigger: only fire when the orchestrator ITSELF crashed (unhandled
  // exception, stack trace from our code, import error, etc.) — NOT when the
  // log merely contains "ERROR" from normal task lifecycle messages.
  //
  // If autofix writes changes, the devmode file watcher triggers a clean restart.
  // If no changes are needed, autofix just logs the outcome — no restart.
  const hasMonitorCrash =
    logText.includes("Unhandled exception") ||
    logText.includes("Unhandled rejection") ||
    logText.includes("SyntaxError:") ||
    logText.includes("ReferenceError:") ||
    logText.includes("TypeError:") ||
    logText.includes("Cannot find module") ||
    logText.includes("FATAL ERROR") ||
    logText.includes("Traceback (most recent call last)") ||
    // PowerShell internal crash
    logText.includes("TerminatingError") ||
    logText.includes("script block termination") ||
    // Very short runtime with high exit code = likely startup crash
    (code > 1 && runDurationMs < 30_000);

  if (autoFixEnabled && logText.length > 0 && hasMonitorCrash) {
    const telegramFn =
      telegramToken && telegramChatId
        ? (msg) => void sendTelegramMessage(msg)
        : null;

    // Fire-and-forget: autofix runs in background, orchestrator restarts now
    void (async () => {
      try {
        const result = await attemptAutoFix({
          logText: logText.slice(-15000),
          reason,
          repoRoot,
          logDir,
          onTelegram: telegramFn,
          recentMessages: getTelegramHistory(),
          promptTemplates: {
            autofixFix: agentPrompts?.autofixFix,
            autofixFallback: agentPrompts?.autofixFallback,
          },
        });

        if (result.fixed) {
          console.log(
            "[monitor] background auto-fix applied — file watcher will restart orchestrator if needed",
          );
          return;
        }

        if (result.outcome && result.outcome !== "clean-exit-skip") {
          console.log(
            `[monitor] background auto-fix outcome: ${result.outcome.slice(0, 100)}`,
          );
        }

        // Auto-fix couldn't help — run diagnostic analysis in background too
        console.log(
          "[monitor] auto-fix unsuccessful — running background Codex analysis",
        );
        await analyzeWithCodex(logPath, logText.slice(-15000), reason);
      } catch (err) {
        console.warn(
          `[monitor] background auto-fix error: ${err.message || err}`,
        );
      }
    })();
  } else if (autoFixEnabled && logText.length > 0 && !hasMonitorCrash) {
    // Not a monitor crash — normal exit with task errors. Skip autofix entirely.
    console.log(
      `[monitor] exit ${reason} — no monitor crash detected — skipping autofix`,
    );
  }

  // ── Context window exhaustion: attempt fresh session (non-blocking) ───
  if (hasContextWindowError(logText)) {
    console.log(
      "[monitor] context window exhaustion detected — attempting fresh session in background",
    );
    void (async () => {
      const freshStarted = await attemptFreshSessionRetry(
        "context_window_exhausted",
        logText.slice(-3000),
      );
      if (freshStarted) {
        console.log(
          "[monitor] fresh session started for context-exhausted task",
        );
      } else {
        await writeFile(
          logPath.replace(/\.log$/, "-context.txt"),
          "Detected context window error. Fresh session retry failed — consider manual recovery.\n",
          "utf8",
        );
      }
    })();
  }

  if (isAbnormalExit) {
    const restartCountNow = recordOrchestratorRestart();
    if (restartCountNow >= orchestratorRestartThreshold) {
      if (Date.now() >= orchestratorHaltedUntil) {
        orchestratorHaltedUntil = Date.now() + orchestratorPauseMs;
        const pauseMin = Math.round(orchestratorPauseMs / 60000);
        console.warn(
          `[monitor] crash loop detected (${restartCountNow} exits in 5m). Pausing orchestrator restarts for ${pauseMin}m.`,
        );
        if (!orchestratorResumeTimer) {
          orchestratorResumeTimer = setTimeout(() => {
            orchestratorResumeTimer = null;
            startProcess();
          }, orchestratorPauseMs);
        }
        if (telegramToken && telegramChatId) {
          void sendTelegramMessage(
            `:close: Crash loop detected (${restartCountNow} exits in 5m). Pausing orchestrator restarts for ${pauseMin} minutes. Background fix running.`,
          );
        }
        // ── Background crash-loop fix: runs while orchestrator is paused ──
        // Does NOT block handleExit. If it writes changes, file watcher restarts.
        // If it fails, the pause timer will restart the orchestrator anyway.
        if (!orchestratorLoopFixInProgress) {
          orchestratorLoopFixInProgress = true;
          void (async () => {
            try {
              const fixResult = await attemptCrashLoopFix({
                reason,
                logText,
              });
              if (fixResult.fixed) {
                console.log(
                  "[monitor] background crash-loop fix applied — file watcher will handle restart",
                );
                if (telegramToken && telegramChatId) {
                  void sendTelegramMessage(
                    `:u1f6e0: Crash-loop fix applied. File watcher will restart orchestrator.\n${fixResult.outcome}`,
                  );
                }
              } else {
                console.log(
                  `[monitor] background crash-loop fix unsuccessful: ${fixResult.outcome}`,
                );
                // Try fresh session as background last resort
                const freshStarted = await attemptFreshSessionRetry(
                  "crash_loop_unresolvable",
                  logText.slice(-3000),
                );
                if (freshStarted && telegramToken && telegramChatId) {
                  void sendTelegramMessage(
                    `:refresh: Crash-loop fix failed but fresh session started. New agent will retry.`,
                  );
                } else if (!freshStarted && telegramToken && telegramChatId) {
                  void sendTelegramMessage(
                    `:alert: Crash-loop fix failed: ${fixResult.outcome}. Orchestrator will resume after ${pauseMin}m pause.`,
                  );
                }
              }
            } catch (err) {
              console.warn(
                `[monitor] background crash-loop fix error: ${err.message || err}`,
              );
            } finally {
              orchestratorLoopFixInProgress = false;
            }
          })();
        }
      }
      return;
    }
  }

  if (maxRestarts > 0 && restartCount >= maxRestarts) {
    return;
  }

  const now = Date.now();
  if (now < orchestratorHaltedUntil || now < monitorSafeModeUntil) {
    const waitMs = Math.max(
      orchestratorHaltedUntil - now,
      monitorSafeModeUntil - now,
    );
    const waitSec = Math.max(5, Math.round(waitMs / 1000));
    console.warn(`[monitor] restart paused; retrying in ${waitSec}s`);
    setTimeout(startProcess, waitSec * 1000);
    return;
  }

  restartCount += 1;
  setTimeout(startProcess, restartDelayMs);
}

// ── Devmode Monitor-Monitor supervisor (24/7 + auto-resume + failover) ─────

function normalizeSdkName(value) {
  const raw = String(value || "")
    .trim()
    .toLowerCase();
  if (raw.startsWith("copilot")) return "copilot";
  if (raw.startsWith("claude")) return "claude";
  if (raw.startsWith("codex")) return "codex";
  return raw;
}

function roleRank(role) {
  const raw = String(role || "")
    .trim()
    .toLowerCase();
  if (raw === "primary") return 0;
  if (raw === "backup") return 1;
  if (raw === "tertiary") return 2;
  const match = raw.match(/^executor-(\d+)$/);
  if (match) return 100 + Number(match[1]);
  return 50;
}

function buildMonitorMonitorSdkOrder() {
  const order = [];
  const seen = new Set();
  const add = (candidate) => {
    const sdk = normalizeSdkName(candidate);
    if (!["codex", "copilot", "claude"].includes(sdk)) return;
    if (seen.has(sdk)) return;
    seen.add(sdk);
    order.push(sdk);
  };

  add(primaryAgentName);

  const executors = Array.isArray(configExecutorConfig?.executors)
    ? [...configExecutorConfig.executors]
    : [];
  executors.sort((a, b) => roleRank(a?.role) - roleRank(b?.role));
  for (const profile of executors) {
    add(executorToSdk(profile?.executor));
  }

  for (const sdk of getAvailableSdks()) {
    add(sdk);
  }

  if (!order.length) {
    add("codex");
  }
  return order;
}

function getCurrentMonitorSdk() {
  if (!monitorMonitor.sdkOrder.length) {
    monitorMonitor.sdkOrder = buildMonitorMonitorSdkOrder();
  }
  if (monitorMonitor.sdkIndex >= monitorMonitor.sdkOrder.length) {
    monitorMonitor.sdkIndex = 0;
  }
  return monitorMonitor.sdkOrder[monitorMonitor.sdkIndex] || "codex";
}

function rotateMonitorSdk(reason = "") {
  if (monitorMonitor.sdkOrder.length < 2) return false;
  monitorMonitor.sdkIndex =
    (monitorMonitor.sdkIndex + 1) % monitorMonitor.sdkOrder.length;
  const nextSdk = getCurrentMonitorSdk();
  console.warn(
    `[monitor-monitor] failover -> ${nextSdk}${reason ? ` (${reason})` : ""}`,
  );
  return true;
}

/**
 * Record a failure for a specific monitor-monitor SDK.
 * After 5 failures → 15min exclusion; after 10 failures → 60min exclusion.
 * @param {string} sdk
 */
function recordMonitorSdkFailure(sdk) {
  if (!sdk) return;
  const entry = monitorMonitor.sdkFailures.get(sdk) || {
    count: 0,
    excludedUntil: 0,
  };
  entry.count += 1;
  if (entry.count >= 10) {
    entry.excludedUntil = Date.now() + 60 * 60_000; // 60 min
    console.warn(
      `[monitor-monitor] ${sdk} excluded for 60min after ${entry.count} failures`,
    );
  } else if (entry.count >= 5) {
    entry.excludedUntil = Date.now() + 15 * 60_000; // 15 min
    console.warn(
      `[monitor-monitor] ${sdk} excluded for 15min after ${entry.count} failures`,
    );
  }
  monitorMonitor.sdkFailures.set(sdk, entry);
  rebuildMonitorSdkOrder();
}

/**
 * Clear failure count for a monitor-monitor SDK (on success).
 * @param {string} sdk
 */
function clearMonitorSdkFailure(sdk) {
  if (!sdk) return;
  if (monitorMonitor.sdkFailures.has(sdk)) {
    monitorMonitor.sdkFailures.delete(sdk);
    rebuildMonitorSdkOrder();
  }
}

/**
 * Check if a monitor-monitor SDK is currently excluded.
 * @param {string} sdk
 * @returns {boolean}
 */
function isMonitorSdkExcluded(sdk) {
  const entry = monitorMonitor.sdkFailures.get(sdk);
  if (!entry || !entry.excludedUntil) return false;
  if (Date.now() >= entry.excludedUntil) {
    // Exclusion expired — clear it
    entry.excludedUntil = 0;
    entry.count = 0;
    monitorMonitor.sdkFailures.set(sdk, entry);
    console.log(`[monitor-monitor] ${sdk} exclusion expired, re-enabling`);
    return false;
  }
  return true;
}

/**
 * Rebuild the SDK order excluding currently-excluded SDKs.
 * If all SDKs are excluded, force the primary back in.
 */
function rebuildMonitorSdkOrder() {
  const original = buildMonitorMonitorSdkOrder();
  const filtered = original.filter((sdk) => !isMonitorSdkExcluded(sdk));
  if (filtered.length === 0) {
    // All excluded — force primary back
    const primary = original[0] || "codex";
    console.warn(
      `[monitor-monitor] all SDKs excluded, forcing ${primary} back`,
    );
    monitorMonitor.sdkOrder = [primary];
  } else {
    monitorMonitor.sdkOrder = filtered;
  }
  // Reset index if out of bounds
  if (monitorMonitor.sdkIndex >= monitorMonitor.sdkOrder.length) {
    monitorMonitor.sdkIndex = 0;
  }
}

function shouldFailoverMonitorSdk(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  const patterns = [
    /rate.?limit/,
    /\b429\b/,
    /too many requests/,
    /quota/,
    /context window/,
    /context length/,
    /maximum context length/,
    /token limit/,
    /timeout/,
    /timed out/,
    /deadline exceeded/,
    /abort(?:ed|ing) due to timeout/,
    /\b500\b/,
    /\b502\b/,
    /\b503\b/,
    /\b504\b/,
    /server error/,
    /internal server error/,
    /gateway timeout/,
    /overloaded/,
    /temporarily unavailable/,
    /api error/,
    /econnreset/,
    /socket hang up/,
    /codex exec exited/,
    /reading prompt from stdin/,
    /exit code 3221225786/,
    /exit code 1073807364/,
    /serde error expected value/,
  ];
  return patterns.some((p) => p.test(text));
}

function formatElapsedMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m ago` : `${hr}h ago`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

function buildMonitorMonitorStatusText(
  reason = "heartbeat",
  currentSdk = getCurrentMonitorSdk(),
) {
  const now = Date.now();
  const runAgeMs =
    monitorMonitor.running && Number.isFinite(monitorMonitor.heartbeatAt)
      ? now - monitorMonitor.heartbeatAt
      : null;
  const lastRun = monitorMonitor.lastRunAt
    ? formatElapsedMs(now - monitorMonitor.lastRunAt)
    : runAgeMs !== null
      ? `in progress (${formatDurationMs(runAgeMs)})`
      : "never";
  const lastStatus = monitorMonitor.lastStatusAt
    ? formatElapsedMs(now - monitorMonitor.lastStatusAt)
    : "first update";
  const lastOutcome =
    monitorMonitor.running &&
    String(monitorMonitor.lastOutcome || "").toLowerCase() === "not-started"
      ? "in-progress"
      : monitorMonitor.lastOutcome || "unknown";
  const lastDigestLine = String(monitorMonitor.lastDigestText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const lastAttemptTrigger =
    monitorMonitor.lastAttemptTrigger || monitorMonitor.lastTrigger || "";
  const lastAttempted =
    monitorMonitor.lastAttemptAt && Number.isFinite(monitorMonitor.lastAttemptAt)
      ? formatElapsedMs(now - monitorMonitor.lastAttemptAt)
      : "never";
  const lastSkipReason = String(monitorMonitor.lastSkipReason || "").trim();
  const lastSkipped =
    monitorMonitor.lastSkipAt && Number.isFinite(monitorMonitor.lastSkipAt)
      ? formatElapsedMs(now - monitorMonitor.lastSkipAt)
      : "never";
  const supervisorLastStarted =
    monitorMonitor.supervisorLastStartedAt &&
    Number.isFinite(monitorMonitor.supervisorLastStartedAt)
      ? formatElapsedMs(now - monitorMonitor.supervisorLastStartedAt)
      : "never";
  const supervisorRestartWindowMin = Math.max(
    1,
    Math.round(MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_WINDOW_MS / 60_000),
  );
  const supervisorRestartCountWindow = Math.max(
    0,
    Number(monitorMonitor.supervisorRestartCountWindow || 0),
  );
  const supervisorRestartsUntilWarn = Math.max(
    0,
    Number(MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_THRESHOLD || 0) -
      supervisorRestartCountWindow,
  );

  const lines = [
    ":server: Bosun-Monitor Update",
    `- Reason: ${reason}`,
    `- Running: ${monitorMonitor.running ? "yes" : "no"}`,
    `- Current SDK: ${currentSdk}`,
    `- SDK order: ${monitorMonitor.sdkOrder.join(" -> ") || "codex"}`,
    `- Last attempt trigger: ${lastAttemptTrigger || "n/a"} (${lastAttempted})`,
    `- Last skip: ${lastSkipReason || "none"} (${lastSkipped})`,
    `- Skip streak: ${Math.max(0, Number(monitorMonitor.skipStreak || 0))}`,
    `- Supervisor restarts (window ${supervisorRestartWindowMin}m): ${supervisorRestartCountWindow}`,
    `- Supervisor restarts until warn: ${supervisorRestartsUntilWarn}`,
    `- Supervisor starts: total=${Math.max(0, Number(monitorMonitor.supervisorStartCountTotal || 0))}, last=${supervisorLastStarted}`,
    `- Last trigger: ${monitorMonitor.lastTrigger || "n/a"}`,
    `- Last run: ${lastRun}`,
    `- Previous status: ${lastStatus}`,
    `- Consecutive failures: ${monitorMonitor.consecutiveFailures}`,
    `- Last outcome: ${lastOutcome}`,
  ];

  if (monitorMonitor.lastError) {
    lines.push(
      `- Last error: ${String(monitorMonitor.lastError).slice(0, 180)}`,
    );
  }
  if (lastDigestLine) {
    lines.push(`- Latest digest: ${lastDigestLine.slice(0, 180)}`);
  }
  return lines.join("\n");
}

async function publishMonitorMonitorStatus(reason = "heartbeat") {
  const now = Date.now();
  const statusSdk = getCurrentMonitorSdk();
  const text = buildMonitorMonitorStatusText(reason, statusSdk);
  const persistedStartupStatusAt =
    reason === "startup" ? readStartupStatusGateTs() : 0;
  const latestStartupStatusAt = Math.max(
    Number(monitorMonitor.lastStatusAt || 0),
    Number(persistedStartupStatusAt || 0),
  );
  const startupStatusSeenRecently =
    monitorMonitor.lastStatusReason === "startup" || persistedStartupStatusAt > 0;
  if (
    reason === "startup" &&
    startupStatusSeenRecently &&
    latestStartupStatusAt > 0 &&
    Number(monitorMonitor.lastRunAt || 0) <= latestStartupStatusAt &&
    now - latestStartupStatusAt < MONITOR_MONITOR_STARTUP_STATUS_MIN_GAP_MS
  ) {
    console.log(
      `[monitor-monitor] status (startup) skipped (duplicate within ${Math.round(MONITOR_MONITOR_STARTUP_STATUS_MIN_GAP_MS / 1000)}s)`,
    );
    return;
  }
  const prevStatusAt = monitorMonitor.lastStatusAt;
  const prevStatusReason = monitorMonitor.lastStatusReason;
  const prevStatusText = monitorMonitor.lastStatusText;
  monitorMonitor.lastStatusAt = now;
  monitorMonitor.lastStatusReason = reason;
  monitorMonitor.lastStatusText = text;
  try {
    if (telegramToken && telegramChatId) {
      await sendTelegramMessage(text, {
        dedupKey: `monitor-monitor-status-${reason}-${statusSdk}`,
        exactDedup: true,
        skipDedup: reason === "interval",
      });
    }
    if (reason === "startup") {
      writeStartupStatusGateTs(now);
    }
    console.log(
      `[monitor-monitor] status (${reason}) sdk=${statusSdk} failures=${monitorMonitor.consecutiveFailures}`,
    );
  } catch (err) {
    monitorMonitor.lastStatusAt = prevStatusAt;
    monitorMonitor.lastStatusReason = prevStatusReason;
    monitorMonitor.lastStatusText = prevStatusText;
    console.warn(
      `[monitor-monitor] status (${reason}) publish failed: ${err?.message || err}`,
    );
    throw err;
  }
}

async function readLogTail(
  filePath,
  { maxLines = 120, maxChars = 12000 } = {},
) {
  try {
    if (!existsSync(filePath)) {
      return `(missing: ${filePath})`;
    }
    const raw = await readFile(filePath, "utf8");
    const tail = raw.split(/\r?\n/).slice(-maxLines).join("\n");
    if (tail.length <= maxChars) return tail;

    // When maxChars cuts mid-line, drop the partial head fragment so monitor-
    // monitor does not ingest stale/truncated orphan text without timestamps.
    const sliced = tail.slice(-maxChars);
    const firstNl = sliced.indexOf("\n");
    if (firstNl <= 0) return sliced;
    return sliced.slice(firstNl + 1);
  } catch (err) {
    return `(unable to read ${filePath}: ${err.message || err})`;
  }
}

async function readLatestLogTail(
  dirPath,
  prefix,
  { maxLines = 120, maxChars = 12000 } = {},
) {
  try {
    const { readdir, stat } = await import("node:fs/promises");
    const entries = await readdir(dirPath);
    const candidates = entries.filter(
      (name) => name.startsWith(prefix) && name.endsWith(".log"),
    );
    if (!candidates.length) return null;
    const stats = await Promise.all(
      candidates.map(async (name) => {
        const path = resolve(dirPath, name);
        const info = await stat(path);
        return { name, path, mtimeMs: info.mtimeMs };
      }),
    );
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = stats[0];
    const tail = await readLogTail(latest.path, { maxLines, maxChars });
    return { name: latest.name, tail };
  } catch {
    return null;
  }
}

function formatDigestLines(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return "(no digest entries)";
  }
  return entries
    .slice(-40)
    .map((entry) => {
      const time = entry?.time || "--:--:--";
      const emoji = entry?.emoji || "";
      const text = entry?.text || safeStringify(entry) || "(invalid entry)";
      return `${time} ${emoji} ${text}`.trim();
    })
    .join("\n");
}

function parseCsvList(value) {
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getMonitorClaudeAllowedTools() {
  const explicit = parseCsvList(
    process.env.DEVMODE_MONITOR_MONITOR_CLAUDE_ALLOWED_TOOLS,
  );
  if (explicit.length) return explicit;
  const standard = parseCsvList(process.env.CLAUDE_ALLOWED_TOOLS);
  if (standard.length) return standard;
  return [
    "Read",
    "Write",
    "Edit",
    "Grep",
    "Glob",
    "Bash",
    "WebSearch",
    "Task",
    "Skill",
  ];
}

function refreshMonitorMonitorRuntime() {
  const wasEnabled = monitorMonitor.enabled;
  const previousSdk = monitorMonitor.sdkOrder[monitorMonitor.sdkIndex] || null;

  monitorMonitor.enabled = isMonitorMonitorEnabled();
  monitorMonitor.intervalMs = Math.max(
    60_000,
    Number(
      process.env.DEVMODE_MONITOR_MONITOR_INTERVAL_MS ||
        process.env.DEVMODE_AUTO_CODE_FIX_CYCLE_INTERVAL ||
        "300000",
    ),
  );
  monitorMonitor.timeoutMs = resolveMonitorMonitorTimeoutMs();
  monitorMonitor.statusIntervalMs = Math.max(
    5 * 60_000,
    Number(process.env.DEVMODE_MONITOR_MONITOR_STATUS_INTERVAL_MS || "1800000"),
  );
  monitorMonitor.branch =
    process.env.DEVMODE_MONITOR_MONITOR_BRANCH ||
    process.env.DEVMODE_AUTO_CODE_FIX_BRANCH ||
    monitorMonitor.branch ||
    "";

  monitorMonitor.sdkOrder = buildMonitorMonitorSdkOrder();
  if (previousSdk) {
    const idx = monitorMonitor.sdkOrder.indexOf(previousSdk);
    monitorMonitor.sdkIndex = idx >= 0 ? idx : 0;
  } else {
    monitorMonitor.sdkIndex = 0;
  }

  if (wasEnabled !== monitorMonitor.enabled) {
    if (monitorMonitor.enabled) {
      console.log(
        `[monitor] monitor-monitor enabled (interval ${Math.round(monitorMonitor.intervalMs / 1000)}s, status ${Math.round(monitorMonitor.statusIntervalMs / 60_000)}m, timeout ${Math.round(monitorMonitor.timeoutMs / 1000)}s)`,
      );
    } else {
      console.log("[monitor] monitor-monitor disabled");
    }
  }
}

function getMonitorMonitorStatusSnapshot() {
  const currentSdk = getCurrentMonitorSdk();
  return {
    enabled: !!monitorMonitor.enabled,
    running: !!monitorMonitor.running,
    currentSdk,
    sdkOrder: [...(monitorMonitor.sdkOrder || [])],
    intervalMs: monitorMonitor.intervalMs,
    statusIntervalMs: monitorMonitor.statusIntervalMs,
    timeoutMs: monitorMonitor.timeoutMs,
    lastAttemptAt: monitorMonitor.lastAttemptAt || 0,
    lastAttemptTrigger: monitorMonitor.lastAttemptTrigger || "",
    lastSkipAt: monitorMonitor.lastSkipAt || 0,
    lastSkipReason: monitorMonitor.lastSkipReason || "",
    skipStreak: monitorMonitor.skipStreak || 0,
    lastSkipStreakWarned: monitorMonitor.lastSkipStreakWarned || 0,
    lastSkipStreakWarnAt: monitorMonitor.lastSkipStreakWarnAt || 0,
    supervisorRestartCountWindow:
      monitorMonitor.supervisorRestartCountWindow || 0,
    supervisorRestartLastWarnAt:
      monitorMonitor.supervisorRestartLastWarnAt || 0,
    supervisorRestartWarnWindowMs:
      MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_WINDOW_MS,
    supervisorRestartWarnThreshold:
      MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_THRESHOLD,
    supervisorRestartsUntilWarn: Math.max(
      0,
      Number(MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_THRESHOLD || 0) -
        Number(monitorMonitor.supervisorRestartCountWindow || 0),
    ),
    supervisorStartCountTotal: monitorMonitor.supervisorStartCountTotal || 0,
    supervisorLastStartedAt: monitorMonitor.supervisorLastStartedAt || 0,
    lastRunAt: monitorMonitor.lastRunAt || 0,
    lastStatusAt: monitorMonitor.lastStatusAt || 0,
    lastTrigger: monitorMonitor.lastTrigger || "",
    lastOutcome: monitorMonitor.lastOutcome || "",
    consecutiveFailures: monitorMonitor.consecutiveFailures || 0,
    lastError: monitorMonitor.lastError || "",
  };
}

function resolveMonitorMonitorErrorTailWindowMs() {
  const intervalMs = Number(monitorMonitor?.intervalMs);
  const normalizedIntervalMs =
    Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 5 * 60_000;
  const defaultWindowMs = Math.max(
    10 * 60_000,
    Math.min(20 * 60_000, normalizedIntervalMs * 3),
  );
  const raw = Number(
    process.env.DEVMODE_MONITOR_MONITOR_ERROR_TAIL_WINDOW_MS ||
      String(defaultWindowMs),
  );
  if (!Number.isFinite(raw) || raw <= 0) return defaultWindowMs;
  return Math.max(60_000, raw);
}

function resolveMonitorMonitorStartupErrorTailWindowMs(baseWindowMs) {
  const base = Number.isFinite(Number(baseWindowMs)) && Number(baseWindowMs) > 0
    ? Number(baseWindowMs)
    : resolveMonitorMonitorErrorTailWindowMs();
  const raw = Number(
    process.env.DEVMODE_MONITOR_MONITOR_STARTUP_ERROR_TAIL_WINDOW_MS || "120000",
  );
  const startupWindow = Number.isFinite(raw) && raw > 0 ? raw : 120_000;
  return Math.max(30_000, Math.min(base, startupWindow));
}

function filterMonitorTailByRecency(tail, { windowMs } = {}) {
  const text = String(tail || "");
  if (!text) return text;

  const parsedWindow = Number(windowMs);
  if (!Number.isFinite(parsedWindow) || parsedWindow <= 0) return text;
  const cutoff = Date.now() - parsedWindow;

  const lines = text.split("\n");
  const blocks = [];
  let current = null;

  const flushCurrent = () => {
    if (!current) return;
    blocks.push(current);
    current = null;
  };

  for (const line of lines) {
    const currentLine = String(line || "");
    const tsMatch = currentLine.match(
      /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s/,
    );
    if (tsMatch) {
      flushCurrent();
      const tsMs = Date.parse(tsMatch[1]);
      current = {
        tsMs: Number.isFinite(tsMs) ? tsMs : null,
        lines: [currentLine],
      };
      continue;
    }

    if (current) {
      current.lines.push(currentLine);
    } else {
      const trimmed = currentLine.trim();
      if (!trimmed) continue;

      // Keep only explicit diagnostics as orphan blocks. Untimestamped trailing
      // fragments are usually mid-line truncation artifacts and can surface stale
      // noise in monitor-monitor prompts.
      const isDiagnosticOrphan =
        /^\(missing:/.test(trimmed) ||
        /^\(unable to read /.test(trimmed) ||
        /^\[fallback:/.test(trimmed);
      if (isDiagnosticOrphan) {
        blocks.push({ tsMs: null, lines: [currentLine] });
      }
    }
  }
  flushCurrent();

  return blocks
    .filter((block) => block.tsMs === null || block.tsMs >= cutoff)
    .map((block) => block.lines.join("\n"))
    .join("\n")
    .trimEnd();
}

function sanitizeMonitorTailForPrompt(tail, backend) {
  const text = String(tail || "");
  if (!text) return text;
  if (String(backend || "").toLowerCase() === "vk") return text;

  const fixtureTokens = [
    "/api/tasks/999",
    "/api/tasks/111",
    "/api/tasks/123",
    "/api/tasks/task-5",
    "safeRecover: could not re-fetch status for \"Failing Task\"",
    "Invalid JSON - Invalid JSON",
    "plain text response",
    "<h1>404 Not Found</h1>",
    "<h1>502 Bad Gateway</h1>",
    "nginx/1.18.0",
  ];
  const fixtureTokensLower = fixtureTokens.map((token) =>
    String(token || "").toLowerCase(),
  );
  const benignMonitorTailPatterns = [
    /ExperimentalWarning:\s+SQLite is an experimental feature/i,
    /Use `node --trace-warnings .*` to show where the warning was created/i,
    /local\s+'[^']+'\s+diverged\s+\(\d+↑\s+\d+↓\)\s+but has uncommitted changes\s+[—-]\s+skipping/i,
    /workspace sync:\s+\d+\s+repo\(s\)\s+failed in\s+[^(]+$/i,
  ];

  const lines = text.split("\n");
  const filtered = lines.filter((line) => {
    const current = String(line || "");
    const normalized = current
      .replace(/^\d{4}-\d{2}-\d{2}T[0-9:.+-]+Z?\s+/, "")
      .replace(/^\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+/, "")
      .replace(/^(?:\[[^\]]+\]\s*)+/, "")
      .trim();
    const currentLower = current.toLowerCase();
    const normalizedLower = normalized.toLowerCase();
    if (/A{40,}/.test(current)) return false;
    if (
      benignMonitorTailPatterns.some(
        (pattern) => pattern.test(current) || pattern.test(normalized),
      )
    ) {
      return false;
    }
    return !fixtureTokensLower.some(
      (token) => currentLower.includes(token) || normalizedLower.includes(token),
    );
  });

  if (filtered.length === lines.length) return text;

  return [
    filtered.join("\n"),
    "[monitor] (sanitized benign tail noise for non-VK backend)",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatOrchestratorTailForMonitorPrompt({
  mode,
  activeKanbanBackend,
  orchestratorTail,
}) {
  try {
    const resolvedMode = String(mode || "unknown").trim().toLowerCase();
    const backendLabel = String(activeKanbanBackend || "unknown")
      .trim()
      .toLowerCase();
    if (
      mode === "internal" ||
      mode === "disabled" ||
      resolvedMode === "internal" ||
      resolvedMode === "disabled" ||
      resolvedMode === "none" ||
      resolvedMode === "monitor-only"
    ) {
      return (
        `(not applicable: executor mode "${resolvedMode}" runs without external orchestrator logs)` +
        ` [backend=${backendLabel}]`
      );
    }

    const tailText = String(orchestratorTail || "").trim();
    if (tailText) return tailText;

    return `(missing: orchestrator tail unavailable for mode "${resolvedMode}")`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `(missing: failed to format orchestrator tail: ${message})`;
  }
}

async function buildMonitorMonitorPrompt({ trigger, entries, text }) {
  const digestSnapshot = getDigestSnapshot();
  const digestEntries =
    Array.isArray(entries) && entries.length
      ? entries
      : digestSnapshot?.entries || [];
  const latestDigestText = String(text || monitorMonitor.lastDigestText || "");
  const actionableEntries = digestEntries.filter(
    (entry) => Number(entry?.priority || 99) <= 3,
  );
  const modeHint =
    actionableEntries.length > 0 ? "reliability-fix" : "code-analysis";
  const currentSdk = getCurrentMonitorSdk();
  const branchInstruction = monitorMonitor.branch
    ? `Work on branch ${monitorMonitor.branch}. Do not create a new branch.`
    : "Work on the current branch. Do not create a new branch.";

  const activeKanbanBackend = getActiveKanbanBackend();
  const runtimeExecutorMode = String(
    configExecutorMode || getExecutorMode() || "internal",
  )
    .trim()
    .toLowerCase();
  const usesExternalOrchestratorLog =
    runtimeExecutorMode !== "internal" && !isExecutorDisabled();
  let orchestratorTail = "";
  if (usesExternalOrchestratorLog) {
    orchestratorTail = await readLogTail(resolve(logDir, "orchestrator-active.log"), {
      maxLines: 140,
      maxChars: 14000,
    });
    if (orchestratorTail.startsWith("(missing:")) {
      const fallback = await readLatestLogTail(logDir, "orchestrator-", {
        maxLines: 140,
        maxChars: 14000,
      });
      if (fallback?.tail) {
        orchestratorTail = `[fallback: ${fallback.name}]\n${fallback.tail}`;
      } else {
        const defaultLogDir = resolve(__dirname, "logs");
        if (defaultLogDir !== logDir) {
          const alt = await readLatestLogTail(defaultLogDir, "orchestrator-", {
            maxLines: 140,
            maxChars: 14000,
          });
          if (alt?.tail) {
            orchestratorTail = `[fallback: ${alt.name}]\n${alt.tail}`;
          }
        }
      }
    }
  }
  orchestratorTail = formatOrchestratorTailForMonitorPrompt({
    mode: runtimeExecutorMode,
    activeKanbanBackend,
    orchestratorTail,
  });
  const monitorTailWindowMs = resolveMonitorMonitorErrorTailWindowMs();
  const effectiveMonitorTailWindowMs =
    String(trigger || "").trim().toLowerCase() === "startup"
      ? resolveMonitorMonitorStartupErrorTailWindowMs(monitorTailWindowMs)
      : monitorTailWindowMs;
  const rawMonitorTail = await readLogTail(resolve(logDir, "monitor-error.log"), {
    maxLines: 120,
    maxChars: 12000,
  });
  const recentMonitorTail = filterMonitorTailByRecency(rawMonitorTail, {
    windowMs: effectiveMonitorTailWindowMs,
  });
  const monitorTail = sanitizeMonitorTailForPrompt(
    recentMonitorTail,
    activeKanbanBackend,
  );
  const monitorTailForPrompt =
    String(monitorTail || "").trim() ||
    `(no recent monitor errors in last ${Math.round(effectiveMonitorTailWindowMs / 60_000)}m)`;

  const anomalyReport = getAnomalyStatusReport();
  const monitorPrompt = agentPrompts?.monitorMonitor || "";
  const claudeTools = getMonitorClaudeAllowedTools();

  return [
    monitorPrompt,
    "",
    "## Runtime Contract",
    "- You are running under monitor.mjs in devmode.",
    "- Fix reliability issues immediately; if smooth, perform code-analysis improvements.",
    "- Apply fixes directly in scripts/bosun and related prompt/config files.",
    "- Do not commit, push, or open PRs from this run.",
    `- ${branchInstruction}`,
    "",
    "## Orchestrator Requirements To Enforce",
    "- Monitor-Monitor must run continuously (24/7 in devmode).",
    "- If this run fails due to rate limit/API/context/server errors, next SDK must be used automatically.",
    "- Keep monitoring after each improvement; regressions must be fixed immediately.",
    "",
    "## Current Context",
    `- Trigger: ${trigger}`,
    `- Mode hint: ${modeHint}`,
    `- Current SDK slot: ${currentSdk}`,
    `- SDK failover order: ${monitorMonitor.sdkOrder.join(" -> ") || "codex"}`,
    `- Consecutive monitor failures: ${monitorMonitor.consecutiveFailures}`,
    `- Claude allowed tools: ${claudeTools.join(", ")}`,
    "",
    "## Live Digest (latest)",
    latestDigestText || "(no digest text)",
    "",
    "## Actionable Digest Entries",
    formatDigestLines(actionableEntries),
    "",
    "## Anomaly Report",
    anomalyReport || "(none)",
    "",
    "## Monitor Error Log Tail",
    monitorTailForPrompt,
    "",
    "## Orchestrator Log Tail",
    orchestratorTail,
    "",
    "## Deliverable",
    "1. Diagnose current reliability issues first and patch root causes.",
    "2. If no active reliability issue exists, implement one meaningful bosun quality/reliability improvement.",
    "3. Run focused validation commands for touched files.",
    "4. Summarize what changed and why.",
  ].join("\n");
}

function clearMonitorMonitorWatchdogTimer({ preserveRunning = false } = {}) {
  if (!monitorMonitor._watchdogForceResetTimer) return;
  if (preserveRunning && monitorMonitor.running) return;
  clearTimeout(monitorMonitor._watchdogForceResetTimer);
  monitorMonitor._watchdogForceResetTimer = null;
}

function recordMonitorMonitorSkip(reason = "unknown") {
  monitorMonitor.lastSkipReason = String(reason || "unknown");
  monitorMonitor.lastSkipAt = Date.now();
  const skipStreak = Math.max(
    0,
    Number(monitorMonitor.skipStreak || 0),
  ) + 1;
  monitorMonitor.skipStreak = skipStreak;
  const lastWarned = Math.max(
    0,
    Number(monitorMonitor.lastSkipStreakWarned || 0),
  );
  const now = Date.now();
  const lastWarnAt = Math.max(
    0,
    Number(monitorMonitor.lastSkipStreakWarnAt || 0),
  );
  if (skipStreak < MONITOR_MONITOR_SKIP_STREAK_WARN_THRESHOLD) return;
  if (
    lastWarned > 0 &&
    skipStreak - lastWarned < MONITOR_MONITOR_SKIP_STREAK_WARN_THRESHOLD
  ) {
    return;
  }
  if (
    lastWarnAt > 0 &&
    now - lastWarnAt < MONITOR_MONITOR_SKIP_STREAK_WARN_MIN_GAP_MS
  ) {
    return;
  }
  monitorMonitor.lastSkipStreakWarned = skipStreak;
  monitorMonitor.lastSkipStreakWarnAt = now;
  console.warn(
    `[monitor-monitor] skip streak ${skipStreak} (reason=${monitorMonitor.lastSkipReason}) while prior run is still active`,
  );
}

async function runMonitorMonitorCycle({
  trigger = "interval",
  entries = [],
  text = "",
} = {}) {
  refreshMonitorMonitorRuntime();
  if (!monitorMonitor.enabled) return;
  monitorMonitor.lastAttemptTrigger = trigger;
  monitorMonitor.lastAttemptAt = Date.now();

  if (monitorMonitor.running) {
    const heartbeatAt = Number(monitorMonitor.heartbeatAt || 0);
    const runAge =
      Number.isFinite(heartbeatAt) && heartbeatAt > 0
        ? Date.now() - heartbeatAt
        : Number.POSITIVE_INFINITY;
    const runStaleThresholdMs =
      monitorMonitor.timeoutMs + MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS;
    if (!monitorMonitor.abortController) {
      if (runAge > runStaleThresholdMs) {
        console.warn(
          `[monitor-monitor] force-resetting stale run without abort controller after ${Math.round(runAge / 1000)}s`,
        );
        monitorMonitor.running = false;
        monitorMonitor._watchdogAbortCount = 0;
        clearMonitorMonitorWatchdogTimer();
        monitorMonitor.consecutiveFailures += 1;
        recordMonitorSdkFailure(getCurrentMonitorSdk());
        monitorMonitor.lastOutcome = "force-reset (no-abort-controller)";
        monitorMonitor.lastError = `stale running=true without abort controller after ${Math.round(runAge / 1000)}s`;
      } else {
        recordMonitorMonitorSkip("running-no-abort-controller");
        return;
      }
    } else if (runAge > runStaleThresholdMs) {
      const watchdogCount = (monitorMonitor._watchdogAbortCount || 0) + 1;
      monitorMonitor._watchdogAbortCount = watchdogCount;
      console.warn(
        `[monitor-monitor] watchdog abort #${watchdogCount} after ${Math.round(runAge / 1000)}s (stuck run)`,
      );
      try {
        monitorMonitor.abortController.abort("watchdog-timeout");
      } catch {
        /* best effort */
      }
      // After 2 consecutive watchdog aborts (abort signal didn't kill the run),
      // force-reset the running flag so the next cycle can start fresh.
      if (watchdogCount >= 2) {
        console.warn(
          `[monitor-monitor] force-resetting stuck run after ${watchdogCount} watchdog aborts`,
        );
        monitorMonitor.running = false;
        monitorMonitor.abortController = null;
        monitorMonitor._watchdogAbortCount = 0;
        clearMonitorMonitorWatchdogTimer();
        monitorMonitor.consecutiveFailures += 1;
        recordMonitorSdkFailure(getCurrentMonitorSdk());
        monitorMonitor.lastOutcome = "force-reset (watchdog)";
        monitorMonitor.lastError = `watchdog force-reset after ${Math.round(runAge / 1000)}s`;
        // Don't return — allow the cycle to start fresh below
      } else {
        // Schedule an accelerated force-reset instead of waiting for
        // the next full interval cycle (which could be 5+ minutes away).
        // If the abort signal actually kills the run, the scheduled callback
        // will find monitorMonitor.running === false and no-op.
        if (!monitorMonitor._watchdogForceResetTimer) {
          const watchdogRunHeartbeatAt = Number(monitorMonitor.heartbeatAt || 0);
          monitorMonitor._watchdogForceResetTimer = setTimeout(() => {
            monitorMonitor._watchdogForceResetTimer = null;
            if (!monitorMonitor.running) return; // Already resolved
            // Ignore stale timer from an earlier run that already completed and
            // got replaced by a new run before this timeout fired.
            if (
              watchdogRunHeartbeatAt > 0 &&
              Number(monitorMonitor.heartbeatAt || 0) !== watchdogRunHeartbeatAt
            ) {
              return;
            }
            console.warn(
              `[monitor-monitor] accelerated force-reset — abort signal was ignored for ${Math.round(MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS / 1000)}s`,
            );
            monitorMonitor.running = false;
            monitorMonitor.abortController = null;
            monitorMonitor._watchdogAbortCount = 0;
            monitorMonitor.consecutiveFailures += 1;
            recordMonitorSdkFailure(getCurrentMonitorSdk());
            monitorMonitor.lastOutcome = "force-reset (watchdog-accelerated)";
            monitorMonitor.lastError = `watchdog accelerated force-reset after ${Math.round((Date.now() - monitorMonitor.heartbeatAt) / 1000)}s`;
          }, MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS);
        }
        recordMonitorMonitorSkip("running-watchdog-await");
        return;
      }
    } else {
      recordMonitorMonitorSkip("running-active");
      return;
    }
  }

  clearMonitorMonitorWatchdogTimer({ preserveRunning: true });
  monitorMonitor.lastTrigger = trigger;
  monitorMonitor.lastSkipReason = "";
  monitorMonitor.lastSkipAt = 0;
  monitorMonitor.skipStreak = 0;
  monitorMonitor.lastSkipStreakWarned = 0;
  monitorMonitor.lastSkipStreakWarnAt = 0;
  monitorMonitor.running = true;
  monitorMonitor.heartbeatAt = Date.now();
  monitorMonitor._watchdogAbortCount = 0;
  if (typeof text === "string" && text.trim()) {
    monitorMonitor.lastDigestText = text;
  }

  let prompt = "";
  try {
    prompt = await buildMonitorMonitorPrompt({ trigger, entries, text });
  } catch (err) {
    monitorMonitor.running = false;
    console.warn(
      `[monitor-monitor] prompt build failed: ${err.message || err}`,
    );
    return;
  }

  const runOnce = async (sdk) => {
    const abortController = new AbortController();
    monitorMonitor.abortController = abortController;
    return await launchOrResumeThread(
      prompt,
      repoRoot,
      monitorMonitor.timeoutMs,
      {
        taskKey: "monitor-monitor",
        sdk,
        abortController,
        claudeAllowedTools: getMonitorClaudeAllowedTools(),
      },
    );
  };

  const runLogDir = resolve(repoRoot, ".cache", "monitor-monitor-logs");
  try {
    await mkdir(runLogDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sdkForLog = getCurrentMonitorSdk();
    await writeFile(
      resolve(
        runLogDir,
        `monitor-monitor-${stamp}-${trigger}-${sdkForLog}.prompt.md`,
      ),
      prompt,
      "utf8",
    );
  } catch {
    /* best effort */
  }

  let sdk = getCurrentMonitorSdk();
  let result;
  const runStartTime = Date.now();

  try {
    result = await runOnce(sdk);
    const runDuration = Math.round((Date.now() - runStartTime) / 1000);

    if (!result.success && shouldFailoverMonitorSdk(result.error)) {
      const canRotate = rotateMonitorSdk(result.error || "retryable failure");
      if (canRotate) {
        sdk = getCurrentMonitorSdk();
        const isTimeout = result.error?.includes("timeout");
        console.warn(
          `[monitor-monitor] retrying with ${sdk} (previous ${isTimeout ? "timeout" : "failure"} after ${runDuration}s)`,
        );
        result = await runOnce(sdk);
      }
    }

    if (result.success) {
      const totalDuration = Math.round((Date.now() - runStartTime) / 1000);
      monitorMonitor.consecutiveFailures = 0;
      clearMonitorSdkFailure(sdk);
      monitorMonitor.lastOutcome = `success (${sdk})`;
      monitorMonitor.lastError = "";
      console.log(
        `[monitor-monitor] cycle complete via ${sdk} in ${totalDuration}s${trigger ? ` (${trigger})` : ""}`,
      );
    } else {
      const totalDuration = Math.round((Date.now() - runStartTime) / 1000);
      monitorMonitor.consecutiveFailures += 1;
      recordMonitorSdkFailure(sdk);
      const errMsg = result.error || "unknown error";
      const isTimeout = errMsg.includes("timeout");
      monitorMonitor.lastOutcome = `failed (${sdk})`;
      monitorMonitor.lastError = errMsg;
      console.warn(
        `[monitor-monitor] run failed via ${sdk} after ${totalDuration}s${isTimeout ? " [TIMEOUT]" : ""}: ${errMsg}`,
      );
      if (shouldFailoverMonitorSdk(errMsg)) {
        rotateMonitorSdk("prepare next cycle");
      }
      void notify?.(
        `:alert: Monitor-Monitor failed (${sdk}): ${String(errMsg).slice(0, 240)}`,
        3,
        { dedupKey: "monitor-monitor-failed" },
      );
      try {
        await publishMonitorMonitorStatus("failure");
      } catch {
        /* best effort */
      }
    }
  } catch (runErr) {
    // Uncaught exception during execution (e.g. launchOrResumeThread threw)
    monitorMonitor.consecutiveFailures += 1;
    recordMonitorSdkFailure(sdk);
    const errMsg = String(runErr?.message || runErr || "unknown exception");
    monitorMonitor.lastOutcome = `exception (${sdk})`;
    monitorMonitor.lastError = errMsg;
    console.error(`[monitor-monitor] uncaught exception via ${sdk}: ${errMsg}`);
    void notify?.(
      `:alert: Monitor-Monitor exception (${sdk}): ${errMsg.slice(0, 240)}`,
      3,
      { dedupKey: "monitor-monitor-exception" },
    );
  } finally {
    // CRITICAL: Always reset running flag, even if runOnce throws or times out
    clearMonitorMonitorWatchdogTimer();
    monitorMonitor.lastRunAt = Date.now();
    monitorMonitor.running = false;
    monitorMonitor.abortController = null;
  }
}

function startMonitorMonitorSupervisor() {
  refreshMonitorMonitorRuntime();
  if (!monitorMonitor.enabled) return;
  const now = Date.now();
  const restartWindowMs = Math.max(
    60_000,
    MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_WINDOW_MS,
  );
  const recentStarts = Array.isArray(monitorMonitor.supervisorStartTimes)
    ? monitorMonitor.supervisorStartTimes.filter(
        (ts) => Number.isFinite(ts) && ts > 0 && now - ts <= restartWindowMs,
      )
    : [];
  recentStarts.push(now);
  monitorMonitor.supervisorStartTimes = recentStarts.slice(-200);
  monitorMonitor.supervisorRestartCountWindow = recentStarts.length;
  monitorMonitor.supervisorStartCountTotal = Math.max(
    0,
    Number(monitorMonitor.supervisorStartCountTotal || 0),
  ) + 1;
  monitorMonitor.supervisorLastStartedAt = now;
  if (
    recentStarts.length >= MONITOR_MONITOR_SUPERVISOR_RESTART_WARN_THRESHOLD &&
    now - Number(monitorMonitor.supervisorRestartLastWarnAt || 0) >= restartWindowMs
  ) {
    monitorMonitor.supervisorRestartLastWarnAt = now;
    console.warn(
      `[monitor] monitor-monitor supervisor restarted ${recentStarts.length} times within ${Math.round(restartWindowMs / 60_000)}m window`,
    );
  }

  if (monitorMonitor.timer) {
    clearInterval(monitorMonitor.timer);
    monitorMonitor.timer = null;
  }
  if (monitorMonitor.statusTimer) {
    clearInterval(monitorMonitor.statusTimer);
    monitorMonitor.statusTimer = null;
  }
  if (monitorMonitor.startupCycleTimer) {
    clearTimeout(monitorMonitor.startupCycleTimer);
    monitorMonitor.startupCycleTimer = null;
  }
  if (monitorMonitor.startupStatusTimer) {
    clearTimeout(monitorMonitor.startupStatusTimer);
    monitorMonitor.startupStatusTimer = null;
  }
  clearMonitorMonitorWatchdogTimer({ preserveRunning: true });

  monitorMonitor.timer = safeSetInterval("monitor-monitor-cycle", () => {
    if (shuttingDown) return;
    return runMonitorMonitorCycle({ trigger: "interval" });
  }, monitorMonitor.intervalMs);
  monitorMonitor.statusTimer = safeSetInterval("monitor-monitor-status", () => {
    if (shuttingDown) return;
    return publishMonitorMonitorStatus("interval");
  }, monitorMonitor.statusIntervalMs);

  console.log(
    `[monitor] monitor-monitor supervisor started (${Math.round(monitorMonitor.intervalMs / 1000)}s run interval, ${Math.round(monitorMonitor.statusIntervalMs / 60_000)}m status interval, sdk order: ${monitorMonitor.sdkOrder.join(" -> ")})`,
  );
  console.log(
    `[monitor] monitor-monitor startup gate: status-gap=${Math.round(MONITOR_MONITOR_STARTUP_STATUS_MIN_GAP_MS / 1000)}s jitter<=${Math.round(MONITOR_MONITOR_STARTUP_JITTER_MS / 1000)}s corrupt-retain=${MONITOR_MONITOR_STARTUP_STATUS_GATE_CORRUPT_MAX_FILES}`,
  );
  if (MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS >= monitorMonitor.intervalMs) {
    console.warn(
      `[monitor] monitor-monitor watchdog delay (${Math.round(MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS / 1000)}s) is >= run interval (${Math.round(monitorMonitor.intervalMs / 1000)}s); accelerated force-reset may not preempt the next scheduled cycle`,
    );
  }
  if (MONITOR_MONITOR_STARTUP_STATUS_DELAY_MS < MONITOR_MONITOR_STARTUP_CYCLE_DELAY_MS) {
    console.warn(
      `[monitor] monitor-monitor startup status delay (${Math.round(MONITOR_MONITOR_STARTUP_STATUS_DELAY_MS / 1000)}s) is below startup cycle delay (${Math.round(MONITOR_MONITOR_STARTUP_CYCLE_DELAY_MS / 1000)}s); startup status may post before first cycle begins`,
    );
  }
  const startupJitterMs =
    MONITOR_MONITOR_STARTUP_JITTER_MS > 0
      ? Math.floor(Math.random() * (MONITOR_MONITOR_STARTUP_JITTER_MS + 1))
      : 0;
  const startupCycleDelayEffectiveMs = Math.max(
    0,
    MONITOR_MONITOR_STARTUP_CYCLE_DELAY_MS + startupJitterMs,
  );
  const startupStatusDelayEffectiveMs = Math.max(
    0,
    MONITOR_MONITOR_STARTUP_STATUS_DELAY_MS + startupJitterMs,
  );
  let startupStatusDelayAdjustedMs = startupStatusDelayEffectiveMs;
  if (startupStatusDelayAdjustedMs < startupCycleDelayEffectiveMs) {
    startupStatusDelayAdjustedMs =
      startupCycleDelayEffectiveMs +
      Math.max(0, MONITOR_MONITOR_STARTUP_STATUS_AFTER_CYCLE_MIN_MS);
    console.warn(
      `[monitor] monitor-monitor startup status delay auto-adjusted to ${Math.round(startupStatusDelayAdjustedMs / 1000)}s to follow startup cycle (${Math.round(startupCycleDelayEffectiveMs / 1000)}s)`,
    );
  }
  if (startupJitterMs > 0) {
    console.log(
      `[monitor] monitor-monitor startup jitter applied: +${Math.round(startupJitterMs / 1000)}s (cycle=${Math.round(startupCycleDelayEffectiveMs / 1000)}s, status=${Math.round(startupStatusDelayAdjustedMs / 1000)}s)`,
    );
  }

  monitorMonitor.startupCycleTimer = safeSetTimeout("monitor-monitor-startup-cycle", () => {
    monitorMonitor.startupCycleTimer = null;
    if (shuttingDown) return;
    return runMonitorMonitorCycle({ trigger: "startup" });
  }, startupCycleDelayEffectiveMs);
  monitorMonitor.startupStatusTimer = safeSetTimeout("monitor-monitor-startup-status", () => {
    monitorMonitor.startupStatusTimer = null;
    if (shuttingDown) return;
    return publishMonitorMonitorStatus("startup");
  }, startupStatusDelayAdjustedMs);
}

function stopMonitorMonitorSupervisor({ preserveRunning = false } = {}) {
  if (monitorMonitor.timer) {
    clearInterval(monitorMonitor.timer);
    monitorMonitor.timer = null;
  }
  if (monitorMonitor.statusTimer) {
    clearInterval(monitorMonitor.statusTimer);
    monitorMonitor.statusTimer = null;
  }
  if (monitorMonitor.startupCycleTimer) {
    clearTimeout(monitorMonitor.startupCycleTimer);
    monitorMonitor.startupCycleTimer = null;
  }
  if (monitorMonitor.startupStatusTimer) {
    clearTimeout(monitorMonitor.startupStatusTimer);
    monitorMonitor.startupStatusTimer = null;
  }
  clearMonitorMonitorWatchdogTimer({ preserveRunning });
  // Only abort a running cycle if explicitly requested (hard shutdown).
  // During self-restart, preserve the running agent so it completes its work.
  if (!preserveRunning && monitorMonitor.abortController) {
    try {
      monitorMonitor.abortController.abort("monitor-shutdown");
    } catch {
      /* best effort */
    }
    monitorMonitor.abortController = null;
  }
  if (!preserveRunning) {
    monitorMonitor.running = false;
  }
}

/**
 * Called when a Live Digest window is sealed.
 * This provides fresh high-priority context and triggers an immediate run.
 */
async function handleDigestSealed({ entries, text }) {
  if (!monitorMonitor.enabled) return;

  const actionableEntries = (entries || []).filter(
    (entry) => Number(entry?.priority || 99) <= 3,
  );

  if (!actionableEntries.length) {
    if (typeof text === "string" && text.trim()) {
      monitorMonitor.lastDigestText = text;
    }
    return;
  }

  console.log(
    `[monitor-monitor] digest trigger (${actionableEntries.length} actionable entries)`,
  );
  void runMonitorMonitorCycle({
    trigger: "digest",
    entries: actionableEntries,
    text,
  });
}

async function startProcess() {
  try {
    // Guard: never spawn VK orchestrator when executor mode is internal or disabled
    const execMode = configExecutorMode || getExecutorMode();
    if (execMode === "internal" || isExecutorDisabled()) {
      console.log(
        `[monitor] startProcess skipped — executor mode is "${execMode}" (VK orchestrator not needed)`,
      );
      try {
        await ensureLogDir();
        const backend = getActiveKanbanBackend();
        const activeLogPath = resolve(logDir, "orchestrator-active.log");
        const message =
          `[monitor] orchestrator inactive in executor mode "${execMode}" (backend=${backend})`;
        await writeFile(activeLogPath, `${message}\n`, "utf8");
      } catch {
        /* best effort */
      }
      return;
    }

    const now = Date.now();

  // ── Minimum restart interval — never restart faster than 15s ──────
  if (restartController.lastProcessStartAt > 0) {
    const sinceLast = now - restartController.lastProcessStartAt;
    const waitMs = restartController.getMinRestartDelay(now);
    if (waitMs > 0) {
      console.log(
        `[monitor] throttling restart — only ${Math.round(sinceLast / 1000)}s since last start, waiting ${Math.round(waitMs / 1000)}s`,
      );
      setTimeout(startProcess, waitMs);
      return;
    }
  }

  if (now < orchestratorHaltedUntil || now < monitorSafeModeUntil) {
    const waitMs = Math.max(
      orchestratorHaltedUntil - now,
      monitorSafeModeUntil - now,
    );
    const waitSec = Math.max(5, Math.round(waitMs / 1000));
    console.warn(
      `[monitor] orchestrator start blocked; retrying in ${waitSec}s`,
    );
    setTimeout(startProcess, waitSec * 1000);
    return;
  }
  if (!(await ensurePreflightReady("start"))) {
    return;
  }
  await ensureLogDir();
  const activeLogPath = resolve(logDir, "orchestrator-active.log");
  const archiveLogPath = resolve(logDir, `orchestrator-${nowStamp()}.log`);
  const logStream = await writeFile(activeLogPath, "", "utf8").then(() => null);

  // ── Workspace monitor: initialize for this process session ──
  try {
    await workspaceMonitor.init();
  } catch (err) {
    console.warn(`[monitor] workspace monitor init failed: ${err.message}`);
  }

  // ── Agent log streaming: fan out per-attempt log lines to .cache/agent-logs/ ──
  const agentLogDir = resolve(repoRoot, ".cache", "agent-logs");
  try {
    await mkdir(agentLogDir, { recursive: true });
  } catch {
    /* best effort */
  }
  /** @type {Map<string, import('fs').WriteStream>} */
  const agentLogStreams = new Map();
  const AGENT_LOG_PATTERN =
    /\b([0-9a-f]{8})(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\b/i;

  /**
   * Stream a log line to the per-attempt log file if it contains an attempt short ID.
   * @param {string} line - The log line
   */
  function streamToAgentLog(line) {
    const match = line.match(AGENT_LOG_PATTERN);
    if (!match) return;
    const shortId = match[1].toLowerCase();
    // Filter out common false positives (git SHAs in non-attempt context)
    if (
      line.includes("HEAD") ||
      line.includes("commit ") ||
      line.includes("Deleted branch")
    ) {
      return;
    }
    const logPath = resolve(agentLogDir, `${shortId}.log`);
    try {
      appendFileSync(logPath, `${line}\n`);
    } catch {
      /* best effort — non-critical */
    }
  }

  // Guard: verify script exists before spawning to avoid cryptic exit 64
  if (!existsSync(scriptPath)) {
    console.error(
      `[monitor] orchestrator script not found: ${scriptPath}\n` +
        `  Set ORCHESTRATOR_SCRIPT to an absolute path or fix the relative path in .env`,
    );
    if (telegramToken && telegramChatId) {
      void sendTelegramMessage(
        `:close: Orchestrator script not found: ${scriptPath}\nSet ORCHESTRATOR_SCRIPT to a valid path.`,
      );
    }
    return;
  }

  // Reset mutex flag before spawn — will be re-set if this instance hits mutex
  restartController.noteProcessStarted(Date.now());

  const scriptLower = String(scriptPath).toLowerCase();
  let orchestratorCmd = scriptPath;
  let orchestratorArgs = [...scriptArgs];

  if (scriptLower.endsWith(".ps1")) {
    const pwshRuntime = resolvePwshRuntime({ preferBundled: true });
    if (!pwshRuntime.exists) {
      const pwshLabel =
        pwshRuntime.source === "env"
          ? `PWSH_PATH (${pwshRuntime.command})`
          : pwshRuntime.source === "bundled"
            ? `bundled pwsh (${pwshRuntime.command})`
            : pwshRuntime.source === "powershell"
              ? `powershell on PATH`
              : "pwsh on PATH";
      const pauseMs = Math.max(orchestratorPauseMs, 60_000);
      const pauseMin = Math.max(1, Math.round(pauseMs / 60_000));
      monitorSafeModeUntil = Math.max(monitorSafeModeUntil, Date.now() + pauseMs);
      console.error(
        `[monitor] .ps1 orchestrator selected but PowerShell runtime is unavailable (${pwshLabel}). ` +
          `Install PowerShell 7+ or set PWSH_PATH correctly. Pausing restarts for ${pauseMin}m.`,
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          `:close: .ps1 orchestrator selected, but PowerShell runtime is unavailable (${pwshLabel}).\n` +
            `Install PowerShell 7+ or set PWSH_PATH to a valid executable path. ` +
            `Pausing restarts for ${pauseMin} minute(s).`,
        );
      }
      setTimeout(startProcess, pauseMs);
      return;
    }
    orchestratorCmd = pwshRuntime.command;
    orchestratorArgs = ["-File", scriptPath, ...scriptArgs];
  } else if (scriptLower.endsWith(".sh")) {
    const shellCmd =
      process.platform === "win32"
        ? commandExists("bash")
          ? "bash"
          : commandExists("sh")
            ? "sh"
            : ""
        : commandExists("bash")
          ? "bash"
          : commandExists("sh")
            ? "sh"
            : "";
    if (!shellCmd) {
      console.error(
        "[monitor] shell-mode orchestrator selected (.sh) but no bash/sh runtime is available on PATH.",
      );
      if (telegramToken && telegramChatId) {
        void sendTelegramMessage(
          ":close: shell-mode orchestrator selected (.sh), but bash/sh is missing on PATH.",
        );
      }
      return;
    }
    orchestratorCmd = shellCmd;
    orchestratorArgs = [scriptPath, ...scriptArgs];
  }

  const child = spawn(orchestratorCmd, orchestratorArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  currentChild = child;

  const append = async (chunk) => {
    if (echoLogs) {
      try {
        shellWriteRaw(chunk);
      } catch {
        /* EPIPE — ignore */
      }
    }
    const text = chunk.toString();
    try {
      await writeFile(activeLogPath, text, { flag: "a" });
    } catch {
      /* log file write failed — ignore */
    }
    logRemainder += text;
    const lines = logRemainder.split(/\r?\n/);
    logRemainder = lines.pop() || "";
    for (const line of lines) {
      // ── Agent log streaming: fan out to per-attempt log files ──
      streamToAgentLog(line);

      // ── Workspace monitoring: detect attempt lifecycle from orchestrator logs ──
      const trackMatch = line.match(
        /Tracking new attempt:\s+([0-9a-f]{8})\s*→\s*(\S+)/i,
      );
      if (trackMatch) {
        const shortId = trackMatch[1];
        const branch = trackMatch[2];
        const worktreePath = findWorktreeForBranch(branch);
        if (worktreePath) {
          void workspaceMonitor
            .startMonitoring(shortId, worktreePath, {
              taskId: shortId,
              executor: "unknown",
              branch,
            })
            .catch((err) =>
              console.warn(
                `[workspace-monitor] failed to start for ${shortId}: ${err.message}`,
              ),
            );
        }
      }

      if (isErrorLine(line, errorPatterns, errorNoisePatterns)) {
        lastErrorLine = line;
        lastErrorAt = Date.now();
        notifyErrorLine(line);
      }
      if (line.includes("Merged PR") || line.includes("Marking task")) {
        notifyMerge(line);
      }
      if (line.includes("Merge notify: PR #")) {
        notifyMergeFailure(line);
      }
      // ── Mutex-held detection ─────────────────────────────────────
      restartController.noteLogLine(line);
      // ── Smart PR creation: detect completed/failed attempts ──────
      const prFlowMatch = line.match(
        /Attempt\s+([0-9a-f]{8})\s+finished\s+\((completed|failed)\)\s*[—–-]\s*marking review/i,
      );
      if (prFlowMatch) {
        const shortId = prFlowMatch[1];
        const finishStatus = prFlowMatch[2];
        void resolveAndTriggerSmartPR(shortId, finishStatus);
        // Stop workspace monitoring for this attempt
        void workspaceMonitor
          .stopMonitoring(shortId, finishStatus)
          .catch(() => {});
      }
      // ── "No remote branch" → trigger VK-based PR flow ──────────
      const noBranchMatch = line.match(
        /No remote branch for (ve\/([0-9a-f]{4})-\S+)/i,
      );
      if (noBranchMatch) {
        const shortId = noBranchMatch[2]; // 4-char prefix
        void resolveAndTriggerSmartPR(shortId, "no-remote-branch");
      }
      if (line.includes("ALL TASKS COMPLETE")) {
        if (!allCompleteNotified) {
          allCompleteNotified = true;
          void sendTelegramMessage(
            "All tasks completed. Orchestrator backlog is empty.",
          );
          void triggerTaskPlanner();
        }
      }
    }
  };

  child.stdout.on("data", (data) => append(data));
  child.stderr.on("data", (data) => append(data));
  // Prevent stream errors from bubbling up as uncaughtException
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});

  child.on("exit", (code, signal) => {
    if (currentChild === child) {
      currentChild = null;
    }
    finalizeActiveLog(activeLogPath, archiveLogPath).finally(() => {
      handleExit(code, signal, archiveLogPath);
    });
  });
  } catch (err) {
    reportGuardedFailure("startProcess", err);
    if (!shuttingDown) {
      const retryMs = Math.max(5_000, restartDelayMs || 0);
      safeSetTimeout("startProcess-retry", () => {
        if (!shuttingDown) void startProcess();
      }, retryMs);
    }
  }
}

function requestRestart(reason) {
  if (shuttingDown) {
    return;
  }
  if (pendingRestart) {
    return;
  }
  // ── Suppress file-change restarts during mutex backoff ──────────
  if (restartController.shouldSuppressRestart(reason)) {
    console.log(
      `[monitor] suppressing file-change restart — mutex backoff active (${restartController.mutexBackoffMs / 1000}s)`,
    );
    return;
  }
  pendingRestart = true;
  skipNextAnalyze = true;
  skipNextRestartCount = true;

  console.log(`[monitor] restart requested (${reason})`);
  if (currentChild) {
    currentChild.kill("SIGTERM");
    setTimeout(() => {
      if (currentChild && !currentChild.killed) {
        currentChild.kill("SIGKILL");
      }
    }, 5000);
  } else {
    pendingRestart = false;
    startProcess();
  }
}

function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  watcherDebounce = null;
  watchFileName = null;
}

// ── Self-monitor watcher: restart when own .mjs files change ─────────────────
function stopSelfWatcher() {
  if (selfWatcher) {
    selfWatcher.close();
    selfWatcher = null;
  }
  if (selfWatcherLib) {
    selfWatcherLib.close();
    selfWatcherLib = null;
  }
  if (selfWatcherDebounce) {
    clearTimeout(selfWatcherDebounce);
    selfWatcherDebounce = null;
  }
  if (selfRestartTimer) {
    clearTimeout(selfRestartTimer);
    selfRestartTimer = null;
  }
  pendingSelfRestart = null;
}

function getInternalActiveSlotCount() {
  try {
    if (!internalTaskExecutor) return 0;
    const status = internalTaskExecutor.getStatus?.();
    if (Number.isFinite(status?.activeSlots)) {
      return Number(status.activeSlots);
    }
    if (
      internalTaskExecutor._activeSlots &&
      Number.isFinite(internalTaskExecutor._activeSlots.size)
    ) {
      return Number(internalTaskExecutor._activeSlots.size);
    }
  } catch {
    /* best effort */
  }
  return 0;
}

function isMonitorMonitorCycleActive() {
  try {
    return Boolean(
      monitorMonitor &&
      monitorMonitor.enabled &&
      (monitorMonitor.running || monitorMonitor.abortController),
    );
  } catch {
    return false;
  }
}

function getRuntimeRestartProtection() {
  if (ALLOW_INTERNAL_RUNTIME_RESTARTS) {
    return { defer: false, reason: "" };
  }
  const execMode = configExecutorMode || getExecutorMode();
  if (execMode !== "internal" && execMode !== "hybrid") {
    return { defer: false, reason: "" };
  }
  const activeSlots = getInternalActiveSlotCount();
  if (activeSlots > 0) {
    return {
      defer: true,
      reason: `${activeSlots} internal task agent(s) active`,
    };
  }
  // NOTE: monitor-monitor is NOT included here — it's safely restartable
  // and should never block source-change restarts. Only real task agents matter.
  return { defer: false, reason: "" };
}

function getYoungActiveAgentRestartDeferralInfo(now = Date.now()) {
  if (SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS <= 0) return null;
  if (!internalTaskExecutor || typeof internalTaskExecutor.getStatus !== "function") {
    return null;
  }
  try {
    const status = internalTaskExecutor.getStatus();
    const slots = Array.isArray(status?.slots) ? status.slots : [];
    const activeSlots = Math.max(0, Number(status?.activeSlots || slots.length || 0));
    if (activeSlots <= 0) return null;

    let oldestRunningMs = 0;
    for (const slot of slots) {
      let runningMs = 0;
      const runningForSec = Number(slot?.runningFor);
      const startedAt = Number(slot?.startedAt);
      if (Number.isFinite(runningForSec) && runningForSec >= 0) {
        runningMs = runningForSec * 1000;
      } else if (Number.isFinite(startedAt) && startedAt > 0) {
        runningMs = Math.max(0, now - startedAt);
      }
      oldestRunningMs = Math.max(oldestRunningMs, runningMs);
    }

    if (oldestRunningMs >= SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS) {
      return null;
    }

    return {
      activeSlots,
      oldestRunningMs,
      minAgeMs: SELF_RESTART_FORCE_ACTIVE_SLOT_MIN_AGE_MS,
    };
  } catch {
    return null;
  }
}

function selfRestartForSourceChange(
  filename,
  { forceActiveAgentExit = false } = {},
) {
  pendingSelfRestart = null;

  // ── SAFETY NET: Double-check no agents are running before killing process ──
  // This should never trigger because attemptSelfRestartAfterQuiet() already
  // defers, but provides defense-in-depth against race conditions.
  const activeSlots = getInternalActiveSlotCount();
  if (activeSlots > 0 && !forceActiveAgentExit) {
    console.warn(
      `[monitor] SAFETY NET: selfRestartForSourceChange called with ${activeSlots} active agent(s)! Deferring instead of killing.`,
    );
    pendingSelfRestart = filename;
    selfRestartTimer = safeSetTimeout("self-restart-safety-net-retry", retryDeferredSelfRestart, 30_000);
    return;
  }
  if (activeSlots > 0 && forceActiveAgentExit) {
    console.warn(
      `[monitor] FORCED self-restart: proceeding with ${activeSlots} active agent(s) after defer hard cap`,
    );
  }
  console.log(
    `\n[monitor] source files stable for ${Math.round(SELF_RESTART_QUIET_MS / 1000)}s — restarting (${filename})`,
  );
  console.log("[monitor] exiting for self-restart (fresh ESM modules)...");
  shuttingDown = true;
  if (vkLogStream) {
    vkLogStream.stop();
    vkLogStream = null;
  }
  if (prCleanupDaemon) {
    prCleanupDaemon.stop();
  }
  // ── Agent isolation: by default, do NOT stop internal executor on self-restart ──
  // Task agents run as in-process SDK async iterators. Stopping the executor
  // during a normal restart is unnecessary because process.exit(75) kills them.
  // Forced restarts are different: request stop to reduce abrupt termination.
  const shutdownPromises = [];
  if (forceActiveAgentExit && internalTaskExecutor) {
    shutdownPromises.push(
      Promise.resolve(internalTaskExecutor.stop()).catch(() => {}),
    );
  }
  // Agent endpoint is lightweight — stop it so the new process can bind the port.
  if (agentEndpoint) {
    shutdownPromises.push(
      Promise.resolve(agentEndpoint.stop()).catch((e) =>
        console.warn(`[monitor] endpoint stop error: ${e.message}`),
      ),
    );
  }
  stopTaskPlannerStatusLoop();
  stopMonitorMonitorSupervisor({ preserveRunning: true });
  stopAutoUpdateLoop();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  stopSelfWatcher();
  stopWatcher();
  stopEnvWatchers();
  if (currentChild) {
    currentChild.kill("SIGTERM");
    setTimeout(() => {
      if (currentChild && !currentChild.killed) {
        currentChild.kill("SIGKILL");
      }
    }, 3000);
  }
  void releaseTelegramPollLock();
  stopTelegramBot({ preserveDigest: true });
  stopWhatsAppChannel();
  if (isContainerEnabled()) {
    void stopAllContainers().catch(() => {});
  }
  // Write self-restart marker so the new process suppresses startup notifications
  try {
    writeFileSync(
      resolve(repoRoot, ".cache", "ve-self-restart.marker"),
      String(Date.now()),
    );
  } catch {
    /* best effort */
  }
  // Wait for executor/endpoint shutdown, then exit
  Promise.allSettled(shutdownPromises).then(() => {
    // Exit with special code — cli.mjs re-forks with fresh module cache
    setTimeout(() => process.exit(SELF_RESTART_EXIT_CODE), 500);
  });
  // Safety net: exit after 10s even if shutdown hangs
  setTimeout(() => process.exit(SELF_RESTART_EXIT_CODE), 10000);
}

function attemptSelfRestartAfterQuiet() {
  if (selfRestartTimer) {
    clearTimeout(selfRestartTimer);
    selfRestartTimer = null;
  }
  if (!selfRestartLastChangeAt) return;
  const now = Date.now();
  const sinceLastChange = now - selfRestartLastChangeAt;
  if (sinceLastChange < SELF_RESTART_QUIET_MS) {
    const waitMs = SELF_RESTART_QUIET_MS - sinceLastChange;
    selfRestartTimer = safeSetTimeout("self-restart-quiet-wait", attemptSelfRestartAfterQuiet, waitMs);
    return;
  }
  const filename = selfRestartLastFile || "unknown";
  const protection = getRuntimeRestartProtection();
  if (protection.defer) {
    pendingSelfRestart = filename;
    if (!selfRestartFirstDeferredAt) {
      selfRestartFirstDeferredAt = now;
    }
    const deferCount = (selfRestartDeferCount =
      (selfRestartDeferCount || 0) + 1);
    const deferElapsedMs = Math.max(0, now - selfRestartFirstDeferredAt);
    const retrySec = Math.round(SELF_RESTART_RETRY_MS / 1000);
    const hitCountCap = deferCount >= SELF_RESTART_DEFER_HARD_CAP;
    const hitTimeCap = deferElapsedMs >= SELF_RESTART_MAX_DEFER_MS;

    // Hard caps: after too many deferrals or too much deferred time the
    // active agent is likely stuck. Force-stop and restart so changes apply.
    if (hitCountCap || hitTimeCap) {
      const youngAgentInfo = getYoungActiveAgentRestartDeferralInfo(now);
      if (youngAgentInfo) {
        console.warn(
          `[monitor] self-restart defer cap reached, but ${youngAgentInfo.activeSlots} active agent(s) are still young (oldest ${Math.round(youngAgentInfo.oldestRunningMs / 1000)}s < ${Math.round(youngAgentInfo.minAgeMs / 1000)}s). Extending defer window.`,
        );
        selfRestartDeferCount = 0;
        selfRestartFirstDeferredAt = now;
        selfRestartTimer = safeSetTimeout(
          "self-restart-deferred-retry",
          retryDeferredSelfRestart,
          SELF_RESTART_RETRY_MS,
        );
        return;
      }

      const elapsedSec = Math.max(1, Math.round(deferElapsedMs / 1000));
      const capReason = hitCountCap
        ? `hard cap ${SELF_RESTART_DEFER_HARD_CAP}`
        : `max defer ${Math.round(SELF_RESTART_MAX_DEFER_MS / 1000)}s`;
      console.warn(
        `[monitor] self-restart deferred ${deferCount} times over ${elapsedSec}s (${capReason}) — force-stopping active agents and restarting`,
      );
      selfRestartDeferCount = 0;
      selfRestartFirstDeferredAt = 0;
      selfRestartForSourceChange(filename, { forceActiveAgentExit: true });
      return;
    }

    if (deferCount % 20 === 0) {
      console.warn(
        `[monitor] self-restart deferred ${deferCount} times over ${Math.round(deferElapsedMs / 1000)}s — still waiting for ${protection.reason}; continuing to defer (caps: count=${SELF_RESTART_DEFER_HARD_CAP}, time=${Math.round(SELF_RESTART_MAX_DEFER_MS / 1000)}s)`,
      );
    }
    console.log(
      `[monitor] deferring self-restart (${filename}) — ${protection.reason}; retrying in ${retrySec}s (defer #${deferCount})`,
    );
    selfRestartTimer = safeSetTimeout(
      "self-restart-deferred-retry",
      retryDeferredSelfRestart,
      SELF_RESTART_RETRY_MS,
    );
    return;
  }
  selfRestartDeferCount = 0;
  selfRestartFirstDeferredAt = 0;

  // ── Agent isolation: defer restart if task agents are actively running ──
  // Task agents run inside this process. If we exit now, all running agents
  // die and their work is lost. Wait for them to finish naturally.
  if (internalTaskExecutor) {
    const status = internalTaskExecutor.getStatus();
    if (status.activeSlots > 0) {
      if (!selfRestartFirstDeferredAt) {
        selfRestartFirstDeferredAt = now;
      }
      const deferCount = (selfRestartDeferCount =
        (selfRestartDeferCount || 0) + 1);
      const deferElapsedMs = Math.max(0, now - selfRestartFirstDeferredAt);
      const hitCountCap = deferCount >= SELF_RESTART_DEFER_HARD_CAP;
      const hitTimeCap = deferElapsedMs >= SELF_RESTART_MAX_DEFER_MS;
      if (hitCountCap || hitTimeCap) {
        const youngAgentInfo = getYoungActiveAgentRestartDeferralInfo(now);
        if (youngAgentInfo) {
          console.warn(
            `[monitor] self-restart deferred ${deferCount} times over ${Math.round(deferElapsedMs / 1000)}s while waiting for active agents, but ${youngAgentInfo.activeSlots} agent(s) are still young (oldest ${Math.round(youngAgentInfo.oldestRunningMs / 1000)}s < ${Math.round(youngAgentInfo.minAgeMs / 1000)}s). Extending defer window.`,
          );
          selfRestartDeferCount = 0;
          selfRestartFirstDeferredAt = now;
          selfRestartTimer = safeSetTimeout(
            "self-restart-agent-wait-retry",
            attemptSelfRestartAfterQuiet,
            60_000,
          );
          return;
        }

        console.warn(
          `[monitor] self-restart deferred ${deferCount} times over ${Math.round(deferElapsedMs / 1000)}s while waiting for active agents — restarting anyway`,
        );
        selfRestartDeferCount = 0;
        selfRestartFirstDeferredAt = 0;
        selfRestartForSourceChange(filename, { forceActiveAgentExit: true });
        return;
      }
      const slotNames = (status.slots || []).map((s) => s.taskTitle).join(", ");
      console.log(
        `[monitor] self-restart deferred — ${status.activeSlots} agent(s) still running: ${slotNames}`,
      );
      console.log(
        `[monitor] will retry restart in 60s (agents must finish first)` +
          ` (defer #${deferCount}, elapsed ${Math.round(deferElapsedMs / 1000)}s)`,
      );
      selfRestartTimer = safeSetTimeout("self-restart-agent-wait-retry", attemptSelfRestartAfterQuiet, 60_000);
      return;
    }
  }

  selfRestartDeferCount = 0;
  selfRestartFirstDeferredAt = 0;
  selfRestartForSourceChange(filename);
}

function queueSelfRestart(filename) {
  selfRestartLastChangeAt = Date.now();
  selfRestartLastFile = filename;
  selfRestartDeferCount = 0;
  selfRestartFirstDeferredAt = 0;
  if (selfRestartTimer) {
    clearTimeout(selfRestartTimer);
  }
  console.log(
    `\n[monitor] source file changed: ${filename} — waiting ${Math.round(SELF_RESTART_QUIET_MS / 1000)}s for quiet before restart`,
  );
  selfRestartTimer = safeSetTimeout(
    "self-restart-queue",
    attemptSelfRestartAfterQuiet,
    SELF_RESTART_QUIET_MS,
  );
}

function retryDeferredSelfRestart() {
  if (!pendingSelfRestart) return;
  selfRestartLastFile = pendingSelfRestart;
  selfRestartLastChangeAt = Date.now() - SELF_RESTART_QUIET_MS;
  attemptSelfRestartAfterQuiet();
}

function startSelfWatcher() {
  stopSelfWatcher();
  if (!watchEnabled) {
    return;
  }
  try {
    const handleSourceChange = (_event, filename) => {
      // Only react to .mjs source files
      if (!filename || !filename.endsWith(".mjs")) return;
      // Ignore node_modules and log artifacts
      if (filename.includes("node_modules")) return;
      if (selfWatcherDebounce) {
        clearTimeout(selfWatcherDebounce);
      }
      selfWatcherDebounce = safeSetTimeout("self-watcher-debounce", () => {
        queueSelfRestart(filename);
      }, 1000);
    };
    selfWatcher = watch(__dirname, { persistent: true }, handleSourceChange);
    const libDir = resolve(__dirname, "lib");
    if (existsSync(libDir)) {
      selfWatcherLib = watch(libDir, { persistent: true }, handleSourceChange);
      console.log("[monitor] watching own source files (root + lib/) for self-restart");
    } else {
      console.log("[monitor] watching own source files for self-restart");
    }
  } catch (err) {
    console.warn(`[monitor] self-watcher failed: ${err.message}`);
  }
}

async function startWatcher(force = false) {
  if (!watchEnabled) {
    stopWatcher();
    return;
  }
  if (watcher && !force) {
    return;
  }
  if (watcher && force) {
    stopWatcher();
  }
  let targetPath = watchPath;
  let missingWatchPath = false;
  try {
    const stats = await (await import("node:fs/promises")).stat(watchPath);
    if (stats.isFile()) {
      watchFileName = watchPath.split(/[\\/]/).pop();
      targetPath = watchPath.split(/[\\/]/).slice(0, -1).join("/") || ".";
    }
  } catch {
    // The configured path may not exist yet (common for stale ORCHESTRATOR_SCRIPT paths).
    // Fall back to watching its parent directory if present; otherwise watch repoRoot.
    missingWatchPath = true;
    const candidateFile = watchPath.split(/[\\/]/).pop() || null;
    const candidateDir = watchPath.split(/[\\/]/).slice(0, -1).join("/") || ".";
    if (existsSync(candidateDir)) {
      targetPath = candidateDir;
      watchFileName = candidateFile;
    } else if (existsSync(repoRoot)) {
      targetPath = repoRoot;
      watchFileName = null;
    } else {
      targetPath = process.cwd();
      watchFileName = null;
    }
  }

  if (!existsSync(targetPath)) {
    console.warn(
      `[monitor] watcher disabled — target path does not exist: ${targetPath}`,
    );
    return;
  }
  if (missingWatchPath) {
    console.warn(
      `[monitor] watch path not found: ${watchPath} — watching ${targetPath} instead`,
    );
  }

  try {
    watcher = watch(targetPath, { persistent: true }, (_event, filename) => {
      if (watchFileName && filename && filename !== watchFileName) {
        return;
      }
      if (watcherDebounce) {
        clearTimeout(watcherDebounce);
      }
      watcherDebounce = safeSetTimeout("watcher-file-change-debounce", () => {
        requestRestart("file-change");
      }, 5000);
    });
  } catch (err) {
    console.warn(
      `[monitor] watcher failed for ${targetPath}: ${err?.message || err}`,
    );
  }
}

function stopEnvWatchers() {
  for (const w of envWatchers) {
    try {
      w.close();
    } catch {
      /* best effort */
    }
  }
  envWatchers = [];
  envWatcherDebounce = null;
}

function scheduleEnvReload(reason) {
  if (envWatcherDebounce) {
    clearTimeout(envWatcherDebounce);
  }
  envWatcherDebounce = safeSetTimeout("env-reload-debounce", () => {
    runDetached("config-reload:env-change", () =>
      reloadConfig(reason || "env-change"),
    );
  }, 400);
}

function startEnvWatchers() {
  stopEnvWatchers();
  if (!envPaths || envPaths.length === 0) {
    return;
  }
  const dirMap = new Map();
  for (const envPath of envPaths) {
    const dir = resolve(envPath, "..");
    const file = envPath.split(/[\\/]/).pop();
    if (!file) continue;
    if (!dirMap.has(dir)) {
      dirMap.set(dir, new Set());
    }
    dirMap.get(dir).add(file);
  }
  for (const [dir, files] of dirMap.entries()) {
    try {
      const w = watch(dir, { persistent: true }, (_event, filename) => {
        if (!filename) return;
        if (!files.has(filename)) return;
        scheduleEnvReload(`env:${filename}`);
      });
      envWatchers.push(w);
    } catch {
      /* best effort */
    }
  }
}

function applyConfig(nextConfig, options = {}) {
  const { restartIfChanged = false, reason = "config-change" } = options;
  const prevScriptPath = scriptPath;
  const prevArgs = scriptArgs?.join(" ") || "";
  const prevWatchPath = watchPath;
  const prevTelegramInterval = telegramIntervalMin;
  const prevCodexEnabled = codexEnabled;
  const prevPrimaryAgentName = primaryAgentName;
  const prevPrimaryAgentReady = primaryAgentReady;
  const prevTelegramCommandEnabled = telegramCommandEnabled;
  const prevTelegramBotEnabled = telegramBotEnabled;
  const prevPreflightEnabled = preflightEnabled;
  const prevSelfRestartWatcherEnabled = selfRestartWatcherEnabled;
  const prevVkRuntimeRequired = isVkRuntimeRequired();

  config = nextConfig;
  projectName = nextConfig.projectName;
  scriptPath = nextConfig.scriptPath;
  scriptArgs = nextConfig.scriptArgs;
  restartDelayMs = nextConfig.restartDelayMs;
  maxRestarts = nextConfig.maxRestarts;
  logDir = nextConfig.logDir;
  watchEnabled = nextConfig.watchEnabled;
  watchPath = resolve(nextConfig.watchPath);
  echoLogs = nextConfig.echoLogs;
  autoFixEnabled = nextConfig.autoFixEnabled;
  shellState.enabled = !!nextConfig.interactiveShellEnabled;
  preflightEnabled = nextConfig.preflightEnabled;
  preflightRetryMs = nextConfig.preflightRetryMs;
  repoRoot = nextConfig.repoRoot;
  statusPath = nextConfig.statusPath;
  telegramPollLockPath = nextConfig.telegramPollLockPath;
  telegramToken = nextConfig.telegramToken;
  telegramChatId = nextConfig.telegramChatId;
  telegramIntervalMin = nextConfig.telegramIntervalMin;
  telegramCommandPollTimeoutSec = nextConfig.telegramCommandPollTimeoutSec;
  telegramCommandConcurrency = nextConfig.telegramCommandConcurrency;
  telegramCommandMaxBatch = nextConfig.telegramCommandMaxBatch;
  telegramBotEnabled = nextConfig.telegramBotEnabled;
  telegramCommandEnabled = nextConfig.telegramCommandEnabled;
  repoSlug = nextConfig.repoSlug;
  repoUrlBase = nextConfig.repoUrlBase;
  vkRecoveryPort = nextConfig.vkRecoveryPort;
  vkRecoveryHost = nextConfig.vkRecoveryHost;
  vkEndpointUrl = nextConfig.vkEndpointUrl;
  vkPublicUrl = nextConfig.vkPublicUrl;
  vkTaskUrlTemplate = nextConfig.vkTaskUrlTemplate;
  // Invalidate VK caches when endpoint URL changes
  cachedRepoId = null;
  cachedProjectId = null;
  vkRecoveryCooldownMin = nextConfig.vkRecoveryCooldownMin;
  vkSpawnEnabled = nextConfig.vkSpawnEnabled;
  vkEnsureIntervalMs = nextConfig.vkEnsureIntervalMs;
  kanbanBackend = String(nextConfig.kanban?.backend || kanbanBackend || "internal")
    .trim()
    .toLowerCase();
  if (nextConfig?.kanbanSource) {
    const src = nextConfig.kanbanSource;
    const sourceLabel = src.sourcePath
      ? `${src.source} (${src.sourcePath})`
      : src.source;
    console.log(
      `[monitor] kanban backend source: ${sourceLabel} (raw=${src.rawValue})`,
    );
  }
  try {
    setKanbanBackend(kanbanBackend);
  } catch (err) {
    console.warn(
      `[monitor] failed to switch kanban backend to "${kanbanBackend}": ${err?.message || err}`,
    );
  }
  executorMode = nextConfig.executorMode || getExecutorMode();
  plannerPerCapitaThreshold = nextConfig.plannerPerCapitaThreshold;
  plannerIdleSlotThreshold = nextConfig.plannerIdleSlotThreshold;
  plannerDedupMs = nextConfig.plannerDedupMs;
  plannerMode = nextConfig.plannerMode || "codex-sdk";
  workflowAutomationEnabled = parseEnvBoolean(
    process.env.WORKFLOW_AUTOMATION_ENABLED,
    workflowAutomationEnabled,
  );
  {
    const dedupMs = Number(
      process.env.WORKFLOW_EVENT_DEDUP_WINDOW_MS || workflowEventDedupWindowMs || "15000",
    );
    workflowEventDedupWindowMs = Number.isFinite(dedupMs) && dedupMs > 0
      ? dedupMs
      : 15_000;
  }
  triggerSystemConfig =
    nextConfig.triggerSystem && typeof nextConfig.triggerSystem === "object"
      ? nextConfig.triggerSystem
      : { enabled: false, templates: [], defaults: { executor: "auto", model: "auto" } };
  configureExecutorTaskStatusTransitions();
  if (workflowAutomationEnabled) {
    ensureWorkflowAutomationEngine().catch(() => {});
  }
  githubReconcile = nextConfig.githubReconcile || githubReconcile;
  agentPrompts = nextConfig.agentPrompts;
  configExecutorConfig = nextConfig.executorConfig;
  executorScheduler = nextConfig.scheduler;
  agentSdk = nextConfig.agentSdk;
  envPaths = nextConfig.envPaths;
  selfRestartWatcherEnabled = isSelfRestartWatcherEnabled();
  const nextVkRuntimeRequired = isVkRuntimeRequired();

  if (prevVkRuntimeRequired && !nextVkRuntimeRequired) {
    if (vkLogStream) {
      vkLogStream.stop();
      vkLogStream = null;
    }
    if (vkSessionDiscoveryTimer) {
      clearInterval(vkSessionDiscoveryTimer);
      vkSessionDiscoveryTimer = null;
    }
    if (vibeKanbanProcess && !vibeKanbanProcess.killed) {
      try {
        vibeKanbanProcess.kill();
      } catch {
        /* best effort */
      }
      vibeKanbanProcess = null;
      vibeKanbanStartedAt = 0;
    }
  } else if (!prevVkRuntimeRequired && nextVkRuntimeRequired) {
    void ensureVibeKanbanRunning();
  }

  // ── Internal executor hot-reload ──────────────────────────────────────
  if (nextConfig.internalExecutor) {
    internalExecutorConfig = nextConfig.internalExecutor;
  }

  codexEnabled = nextConfig.codexEnabled;
  primaryAgentName = nextConfig.primaryAgent;
  primaryAgentReady = nextConfig.primaryAgentEnabled;
  codexDisabledReason = codexEnabled
    ? ""
    : isTruthyFlag(process.env.CODEX_SDK_DISABLED)
      ? "disabled via CODEX_SDK_DISABLED"
      : agentSdk?.primary && agentSdk.primary !== "codex"
        ? `disabled via agent_sdk.primary=${agentSdk.primary}`
        : "disabled via --no-codex";

  const primaryAgentChanged = prevPrimaryAgentName !== primaryAgentName;
  if (primaryAgentChanged) {
    setPrimaryAgent(primaryAgentName);
  }
  if (
    (primaryAgentChanged && primaryAgentReady) ||
    (!prevPrimaryAgentReady && primaryAgentReady)
  ) {
    void initPrimaryAgent(primaryAgentName);
  }

  if (prevWatchPath !== watchPath || watchEnabled === false) {
    void startWatcher(true);
  }
  if (prevSelfRestartWatcherEnabled !== selfRestartWatcherEnabled) {
    if (selfRestartWatcherEnabled) {
      startSelfWatcher();
      console.log(
        "[monitor] self-restart watcher enabled (devmode or SELF_RESTART_WATCH_ENABLED=1)",
      );
    } else {
      stopSelfWatcher();
      console.log(
        "[monitor] self-restart watcher disabled (set SELF_RESTART_WATCH_FORCE=1 to allow in npm/prod mode)",
      );
    }
  }
  startEnvWatchers();

  if (prevTelegramInterval !== telegramIntervalMin) {
    void startTelegramNotifier();
  }
  if (!prevTelegramCommandEnabled && telegramCommandEnabled) {
    startTelegramCommandListener();
  }
  if (prevTelegramBotEnabled !== telegramBotEnabled) {
    if (telegramBotEnabled) {
      void startTelegramBot(getTelegramBotStartOptions());
    } else {
      stopTelegramBot();
    }
  }
  if (prevCodexEnabled && !codexEnabled) {
    console.warn(
      `[monitor] Codex disabled: ${codexDisabledReason || "disabled"}`,
    );
  }
  if (!prevCodexEnabled && codexEnabled) {
    void ensureCodexSdkReady();
  }
  if (prevPreflightEnabled && !preflightEnabled && preflightRetryTimer) {
    clearTimeout(preflightRetryTimer);
    preflightRetryTimer = null;
  }

  if (shellState.enabled && !shellState.active) {
    startInteractiveShell();
  } else if (!shellState.enabled && shellState.active && shellState.rl) {
    shellState.rl.close();
  }

  if (plannerMode !== "disabled") {
    startTaskPlannerStatusLoop();
  } else {
    stopTaskPlannerStatusLoop();
  }

  refreshMonitorMonitorRuntime();
  if (monitorMonitor.enabled) {
    startMonitorMonitorSupervisor();
  } else {
    stopMonitorMonitorSupervisor();
  }
  restartGitHubReconciler();

  const nextArgs = scriptArgs?.join(" ") || "";
  const scriptChanged = prevScriptPath !== scriptPath || prevArgs !== nextArgs;
  if (restartIfChanged && scriptChanged) {
    requestRestart(`config-change (${reason})`);
  }
}

async function reloadConfig(reason) {
  try {
    const nextConfig = loadConfig(process.argv, { reloadEnv: true });
    applyConfig(nextConfig, { restartIfChanged: true, reason });
    console.log(`[monitor] config reloaded (${reason})`);
    if (telegramToken && telegramChatId) {
      try {
        await sendTelegramMessage(
          `:refresh: .env reloaded (${reason}). Runtime config updated.`,
          { dedupKey: "env-reload" },
        );
      } catch {
        /* best effort */
      }
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    console.warn(`[monitor] failed to reload config: ${message}`);
  }
}

process.on("SIGINT", async () => {
  shuttingDown = true;
  stopWorkspaceSyncTimers();
  stopTaskPlannerStatusLoop();
  stopGitHubReconciler();
  // Stop monitor-monitor immediately (it's safely restartable)
  stopMonitorMonitorSupervisor();
  if (vkLogStream) {
    vkLogStream.stop();
    vkLogStream = null;
  }
  if (prCleanupDaemon) {
    prCleanupDaemon.stop();
  }
  stopAutoUpdateLoop();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  stopSelfWatcher();
  stopEnvWatchers();
  if (watcher) {
    watcher.close();
  }
  if (currentChild) {
    currentChild.kill("SIGTERM");
  }
  void workspaceMonitor.shutdown();
  void releaseTelegramPollLock();
  stopWhatsAppChannel();
  if (agentSupervisor) {
    agentSupervisor.stop();
  }
  if (isContainerEnabled()) {
    await stopAllContainers().catch((e) =>
      console.warn(`[monitor] container cleanup error: ${e.message}`),
    );
  }

  // Wait for active task agents to finish gracefully (up to 5 minutes)
  if (internalTaskExecutor) {
    const status = internalTaskExecutor.getStatus();
    if (status.activeSlots > 0) {
      const slotNames = (status.slots || []).map((s) => s.taskTitle).join(", ");
      console.log(
        `[monitor] SIGINT: waiting for ${status.activeSlots} active agent(s) to finish: ${slotNames}`,
      );
      console.log(`[monitor] (press Ctrl+C again to force exit)`);
      await internalTaskExecutor.stop();
    }
    stopStatusFileWriter();
  }
  process.exit(0);
});

// Windows: closing the terminal window doesn't send SIGINT/SIGTERM reliably.
process.on("exit", () => {
  shuttingDown = true;
  stopWorkspaceSyncTimers();
  stopTaskPlannerStatusLoop();
  stopGitHubReconciler();
  stopMonitorMonitorSupervisor();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  if (vkLogStream) {
    vkLogStream.stop();
    vkLogStream = null;
  }
  void workspaceMonitor.shutdown();
  void releaseTelegramPollLock();
});

process.on("SIGTERM", async () => {
  shuttingDown = true;
  stopWorkspaceSyncTimers();
  stopTaskPlannerStatusLoop();
  stopGitHubReconciler();
  // Stop monitor-monitor immediately (it's safely restartable)
  stopMonitorMonitorSupervisor();
  if (vkLogStream) {
    vkLogStream.stop();
    vkLogStream = null;
  }
  stopAutoUpdateLoop();
  stopAgentAlertTailer();
  stopAgentWorkAnalyzer();
  stopSelfWatcher();
  stopEnvWatchers();
  if (watcher) {
    watcher.close();
  }
  if (currentChild) {
    currentChild.kill("SIGTERM");
  }
  void workspaceMonitor.shutdown();
  void releaseTelegramPollLock();
  stopTelegramBot();
  stopWhatsAppChannel();
  if (agentSupervisor) {
    agentSupervisor.stop();
  }
  if (isContainerEnabled()) {
    await stopAllContainers().catch((e) =>
      console.warn(`[monitor] container cleanup error: ${e.message}`),
    );
  }

  // Wait for active task agents to finish gracefully (up to 5 minutes)
  if (internalTaskExecutor) {
    const status = internalTaskExecutor.getStatus();
    if (status.activeSlots > 0) {
      const slotNames = (status.slots || []).map((s) => s.taskTitle).join(", ");
      console.log(
        `[monitor] SIGTERM: waiting for ${status.activeSlots} active agent(s) to finish: ${slotNames}`,
      );
      await internalTaskExecutor.stop();
    }
  }
  process.exit(0);
});

// Stream noise patterns that should NEVER trigger recovery —
// they happen when child processes die or pipes break and are harmless.
function isStreamNoise(msg) {
  return (
    msg.includes("EPIPE") ||
    msg.includes("ERR_STREAM_PREMATURE_CLOSE") ||
    msg.includes("ERR_STREAM_DESTROYED") ||
    msg.includes("stream was destroyed") ||
    msg.includes("Cannot call write after a stream was destroyed") ||
    msg.includes("write after end") ||
    msg.includes("write after a stream was destroyed") ||
    msg.includes("Cannot call write after") ||
    msg.includes("This socket has been ended") ||
    msg.includes("Cannot read properties of null") ||
    msg.includes("ECONNRESET") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("socket hang up") ||
    msg.includes("AbortError") ||
    msg.includes("The operation was aborted") ||
    msg.includes("This operation was aborted") ||
    msg.includes("setRawMode EIO") ||
    msg.includes("hard_timeout") ||
    msg.includes("watchdog-timeout") ||
    // Spawn failures: codex/copilot binary not found — transient noise, not a monitor bug
    msg.includes("ENOENT") ||
    msg.includes("The system cannot find the file specified") ||
    msg.includes("os error 2") ||
    msg.includes("spawn failed")
  );
}

process.on("uncaughtException", (err) => {
  const msg = (err?.code ? err.code + ": " : "") + (err?.message || "");
  // Always suppress stream noise — not just during shutdown
  if (isStreamNoise(msg)) {
    console.error(
      "[monitor] suppressed stream noise (uncaughtException): " + msg,
    );
    return;
  }
  // Always log the exception — even during shutdown — so the crash is traceable.
  const detail = err?.stack || msg || String(err);
  try {
    // Duplicate-start lock contention exits with code 0; emit on stdout to avoid error-tail noise.
    process.stdout.write("[monitor] uncaughtException: " + detail + "\n");
  } catch { /* stderr may be torn down */ }
  try {
    const crashDir = config?.logDir || resolve(__dirname, "logs");
    mkdirSync(crashDir, { recursive: true });
    appendFileSync(
      resolve(crashDir, "monitor-crash-breadcrumb.log"),
      `[${new Date().toISOString()}] uncaughtException (shuttingDown=${shuttingDown}): ${detail}\n`,
    );
  } catch { /* best effort */ }
  if (shuttingDown) return;
  console.error("[monitor] uncaughtException: " + detail);
  handleMonitorFailure("uncaughtException", err).catch((failureErr) => {
    try {
      // Duplicate-start lock contention exits with code 0; emit on stdout to avoid error-tail noise.
    process.stdout.write(
        "[monitor] uncaughtException handler failed: " + (failureErr?.message || failureErr) + "\n",
      );
    } catch {
      /* best effort */
    }
  });
});

process.on("unhandledRejection", (reason) => {
  const msg = (reason?.code ? reason.code + ": " : "") + (reason?.message || String(reason || ""));
  // Always write breadcrumb — unhandled rejections can cause exit code 1
  try {
    const crashDir = config?.logDir || resolve(__dirname, "logs");
    mkdirSync(crashDir, { recursive: true });
    const detail = reason instanceof Error ? (reason.stack || msg) : msg;
    appendFileSync(
      resolve(crashDir, "monitor-crash-breadcrumb.log"),
      `[${new Date().toISOString()}] unhandledRejection (shuttingDown=${shuttingDown}): ${detail}\n`,
    );
  } catch { /* best effort */ }
  // Always suppress stream noise
  if (isStreamNoise(msg)) {
    console.error(
      "[monitor] suppressed stream noise (unhandledRejection): " + msg,
    );
    return;
  }
  if (shuttingDown) return;
  const err =
    reason instanceof Error ? reason : new Error(String(reason || ""));
  console.error("[monitor] unhandledRejection: " + (err?.stack || msg));
  handleMonitorFailure("unhandledRejection", err).catch((failureErr) => {
    try {
      // Duplicate-start lock contention exits with code 0; emit on stdout to avoid error-tail noise.
    process.stdout.write(
        "[monitor] unhandledRejection handler failed: " + (failureErr?.message || failureErr) + "\n",
      );
    } catch {
      /* best effort */
    }
  });
});

// ── Exit diagnostic: always log the exit code so crashes are traceable ──────
process.on("exit", (code) => {
  if (code === 0 || code === SELF_RESTART_EXIT_CODE) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] process exiting with code ${code} (shuttingDown=${shuttingDown}, uptime=${Math.round(process.uptime())}s)`;
  // Write directly to stderr — console may already be torn down at exit time
  try {
    // Duplicate-start lock contention exits with code 0; emit on stdout to avoid error-tail noise.
    process.stdout.write("[monitor] " + line + "\n");
  } catch {
    /* best effort — stderr may be broken */
  }
  // Persist breadcrumb to disk so the crash is always traceable even when
  // stderr output is lost (e.g., background daemon, piped output).
  try {
    const crashDir = config?.logDir || resolve(__dirname, "logs");
    mkdirSync(crashDir, { recursive: true });
    appendFileSync(
      resolve(crashDir, "monitor-crash-breadcrumb.log"),
      line + "\n",
    );
  } catch {
    /* best effort */
  }
});

if (!isMonitorTestRuntime) {
  const DUPLICATE_START_EXIT_STATE_FILE =
    "monitor-duplicate-start-exit-state.json";
  const MONITOR_PID_FILE_NAME = "bosun.pid";
  const DUPLICATE_START_EXIT_THROTTLE_MS = Math.max(
    5_000,
    Number(process.env.MONITOR_DUPLICATE_START_WARN_THROTTLE_MS || "60000") ||
      60000,
  );

  function readMonitorLockOwnerPid(cacheDir) {
    const pidPath = resolve(cacheDir, MONITOR_PID_FILE_NAME);
    try {
      const raw = String(readFileSync(pidPath, "utf8") || "").trim();
      if (!raw) return null;
      if (raw.startsWith("{")) {
        const parsed = JSON.parse(raw);
        const pid = Number(parsed?.pid);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
      const pid = Number(raw);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  function writeDuplicateStartExitNotice(cacheDir) {
    const statePath = resolve(cacheDir, DUPLICATE_START_EXIT_STATE_FILE);
    const now = Date.now();
    const ownerPid = readMonitorLockOwnerPid(cacheDir);
    let state = {};
    try {
      state = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      state = {};
    }

    const lastPid = Number(state?.pid || 0);
    const samePid = Number(ownerPid) > 0 && lastPid === Number(ownerPid);
    const lastLoggedAt = Number(state?.lastLoggedAt || 0);
    const suppressed = Math.max(0, Number(state?.suppressed || 0));
    if (samePid && now - lastLoggedAt < DUPLICATE_START_EXIT_THROTTLE_MS) {
      try {
        writeFileSync(
          statePath,
          JSON.stringify({
            pid: ownerPid,
            lastLoggedAt,
            suppressed: suppressed + 1,
          }),
          "utf8",
        );
      } catch {
        /* best effort */
      }
      return;
    }

    const suffix =
      samePid && suppressed > 0
        ? " (suppressed " +
          suppressed +
          " duplicate-start exits in last " +
          Math.round(DUPLICATE_START_EXIT_THROTTLE_MS / 1000) +
          "s)"
        : "";
    const pidSuffix = Number(ownerPid) > 0 ? ` (PID ${ownerPid})` : "";
    // Duplicate-start lock contention exits with code 0; emit on stdout to avoid error-tail noise.
    process.stdout.write(
      "[monitor] another bosun instance holds the lock" +
        pidSuffix +
        " — duplicate start ignored (exit code 0)." +
        suffix +
        "\n",
    );

    try {
      writeFileSync(
        statePath,
        JSON.stringify({
          pid: Number(ownerPid) > 0 ? ownerPid : null,
          lastLoggedAt: now,
          suppressed: 0,
        }),
        "utf8",
      );
    } catch {
      /* best effort */
    }
  }

  // ── Singleton guard: prevent ghost monitors ─────────────────────────────────
  if (!acquireMonitorLock(config.cacheDir)) {
    // During source-change self-restart, the previous monitor can still be
    // shutting down and holding the lock briefly. Ask cli.mjs to retry instead
    // of treating this as a hard crash.
    if (isSelfRestart) {
      // Write directly to stderr so the message reaches the terminal even when
      // the console interceptor is redirecting to a log file.
      // Duplicate-start lock contention exits with code 0; emit on stdout to avoid error-tail noise.
    process.stdout.write(
        "[monitor] self-restart lock handoff still busy — retrying startup\n",
      );
      process.exit(SELF_RESTART_EXIT_CODE);
    }
    // Duplicate start (lock held by another healthy monitor) is benign.
    // Exit 0 so daemon/service wrappers do not treat this as a crash loop.
    writeDuplicateStartExitNotice(config.cacheDir);
    process.exit(0);
  }

// ── Codex CLI config.toml: ensure global defaults + stream timeouts ─────────
try {
  const vkPort = config.vkRecoveryPort || "54089";
  const vkBaseUrl = config.vkEndpointUrl || `http://127.0.0.1:${vkPort}`;
  const allowRuntimeCodexMutation = isTruthyFlag(
    process.env.BOSUN_ALLOW_RUNTIME_GLOBAL_CODEX_MUTATION,
  );
  const tomlResult = ensureCodexConfig({
    vkBaseUrl,
    skipVk: true,
    dryRun: !allowRuntimeCodexMutation,
  });
  if (!tomlResult.noChanges) {
    if (!allowRuntimeCodexMutation) {
      console.log(
        "[monitor] Codex config drift detected (runtime is read-only; run `node cli.mjs --setup` to apply).",
      );
    } else {
      console.log("[monitor] updated ~/.codex/config.toml:");
    }
    printConfigSummary(tomlResult);
  }
} catch (err) {
  console.warn(
    `[monitor] config.toml check failed (non-fatal): ${err.message}`,
  );
}

// ── Startup sweep: kill stale processes, prune worktrees, archive old tasks ──
runGuarded("startup-maintenance-sweep", () =>
  runMaintenanceSweep({
    repoRoot,
    archiveCompletedTasks: async () => {
      const projectId = await findVkProjectId();
      if (!projectId) return { archived: 0 };
      return await archiveCompletedTasks(fetchVk, projectId, { maxArchive: 50 });
    },
  }),
);

safeSetInterval("flush-error-queue", () => flushErrorQueue(), 60 * 1000);

// ── Periodic maintenance: every 5 min, reap stuck pushes & prune worktrees ──
const maintenanceIntervalMs = 5 * 60 * 1000;
safeSetInterval("maintenance-sweep", () => {
  const childPid = currentChild ? currentChild.pid : undefined;
  return runMaintenanceSweep({
    repoRoot,
    childPid,
    archiveCompletedTasks: async () => {
      const projectId = await findVkProjectId();
      if (!projectId) return { archived: 0 };
      return await archiveCompletedTasks(fetchVk, projectId, {
        maxArchive: 25,
        dryRun: false,
      });
    },
  });
}, maintenanceIntervalMs);

// ── Periodic merged PR check: every 10 min, move merged PRs to done ─────────
const mergedPRCheckIntervalMs = 10 * 60 * 1000;
safeSetInterval("merged-pr-check", () => checkMergedPRsAndUpdateTasks(), mergedPRCheckIntervalMs);

// ── Periodic epic branch sync/merge: every 15 min ──────────────────────────
const epicMergeIntervalMs = 15 * 60 * 1000;
safeSetInterval("epic-merge-check", () => checkEpicBranches("interval"), epicMergeIntervalMs);

// ── Log rotation: truncate oldest logs when folder exceeds size limit ───────
if (logMaxSizeMb > 0) {
  // Run once at startup (delayed 10s)
  safeSetTimeout("startup-log-rotation", () => truncateOldLogs(), 10 * 1000);
  if (logCleanupIntervalMin > 0) {
    const logCleanupIntervalMs = logCleanupIntervalMin * 60 * 1000;
    safeSetInterval("log-rotation", () => truncateOldLogs(), logCleanupIntervalMs);
    console.log(
      `[monitor] log rotation enabled — max ${logMaxSizeMb} MB, checking every ${logCleanupIntervalMin} min`,
    );
  } else {
    console.log(
      `[monitor] log rotation enabled — max ${logMaxSizeMb} MB (startup check only)`,
    );
  }
}

// Run once immediately after startup (delayed by 30s to let things settle)
safeSetTimeout("startup-health-checks", () => {
  checkMergedPRsAndUpdateTasks();
  checkEpicBranches("startup");
  return checkAndMergeDependabotPRs();
}, 30 * 1000);

// ── Fleet Coordination ───────────────────────────────────────────────────────
if (fleetConfig?.enabled) {
  const maxParallel = getMaxParallelFromArgs(scriptArgs) || 6;
  void initFleet({
    repoRoot,
    localSlots: maxParallel,
    ttlMs: fleetConfig.presenceTtlMs,
  })
    .then((state) => {
      console.log(
        `[fleet] ready: mode=${state.mode}, peers=${state.fleetSize}, totalSlots=${state.totalSlots}`,
      );
      void persistFleetState(repoRoot);
    })
    .catch((err) => {
      console.warn(`[fleet] init failed (continuing solo): ${err.message}`);
    });

  // Periodic fleet sync
  const syncMs = fleetConfig.syncIntervalMs || 2 * 60 * 1000;
  safeSetInterval("fleet-sync", async () => {
    try {
      await refreshFleet({ ttlMs: fleetConfig.presenceTtlMs });
      await persistFleetState(repoRoot);
    } catch (err) {
      console.warn(`[fleet] sync error: ${err.message}`);
    }
  }, syncMs);
  console.log(
    `[fleet] sync every ${Math.round(syncMs / 1000)}s, TTL=${Math.round((fleetConfig.presenceTtlMs || 300000) / 1000)}s`,
  );

  // Shared knowledge system
  if (fleetConfig.knowledgeEnabled) {
    initSharedKnowledge({
      repoRoot,
      targetFile: fleetConfig.knowledgeFile || "AGENTS.md",
    });
    console.log(
      `[fleet] shared knowledge enabled → ${fleetConfig.knowledgeFile || "AGENTS.md"}`,
    );
  }
} else {
  console.log("[fleet] disabled (set FLEET_ENABLED=true to enable)");
}

// ── Periodic Dependabot auto-merge check ─────────────────────────────────────
if (dependabotAutoMerge) {
  const depIntervalMs = (dependabotAutoMergeIntervalMin || 10) * 60 * 1000;
  safeSetInterval("dependabot-auto-merge", () => checkAndMergeDependabotPRs(), depIntervalMs);
  console.log(
    `[dependabot] auto-merge enabled — checking every ${dependabotAutoMergeIntervalMin || 10} min for: ${dependabotAuthors.join(", ")}`,
  );
}

if (telegramWeeklyReportEnabled) {
  const weeklyReportPollMs = 60 * 1000;
  safeSetInterval("telegram-weekly-report", () => maybeSendWeeklyReport(), weeklyReportPollMs);
  safeSetTimeout("telegram-weekly-report-initial", () => maybeSendWeeklyReport(), 45 * 1000);
  console.log(
    `[monitor] weekly Telegram report scheduler enabled (day=${telegramWeeklyReportDay}, hourUtc=${telegramWeeklyReportHour}, lookbackDays=${telegramWeeklyReportDays})`,
  );
}

// ── Self-updating: poll npm every 10 min, auto-install + restart ────────────
startAutoUpdateLoop({
  onRestart: (reason) => restartSelf(reason),
  onNotify: (msg) =>
    // Priority 1 (critical) bypasses the live digest so the user gets a
    // direct push notification for update-detected and restarting events.
    sendTelegramMessage(msg, { priority: 1, skipDedup: true }).catch(() => {}),
});

startWatcher();
startEnvWatchers();
if (selfRestartWatcherEnabled) {
  startSelfWatcher();
} else {
  const normalizedExecutorMode = String(executorMode || "")
    .trim()
    .toLowerCase();
  const explicitSelfRestartWatch = process.env.SELF_RESTART_WATCH_ENABLED;
  const hasExplicitSelfRestartWatch =
    explicitSelfRestartWatch !== undefined &&
    String(explicitSelfRestartWatch).trim() !== "";
  const forceSelfRestartWatch = isTruthyFlag(process.env.SELF_RESTART_WATCH_FORCE);
  const npmLifecycleEvent = String(process.env.npm_lifecycle_event || "")
    .trim()
    .toLowerCase();
  const launchedViaNpmStartScript =
    npmLifecycleEvent === "start" || npmLifecycleEvent.startsWith("start:");
  const disabledReason = hasExplicitSelfRestartWatch
    ? "explicitly"
    : !isDevMode()
    ? "npm/prod mode — updates via auto-update loop"
    : !forceSelfRestartWatch && !launchedViaNpmStartScript
      ? "CLI command mode in source checkout — use npm run start or SELF_RESTART_WATCH_ENABLED=1 to enable"
    : normalizedExecutorMode === "internal" || normalizedExecutorMode === "hybrid"
      ? `executor mode "${normalizedExecutorMode}" (continuous task-driven code changes)`
      : "explicitly";
  console.log(
    `[monitor] self-restart file watcher disabled (${disabledReason})`,
  );
}
startInteractiveShell();
if (isVkRuntimeRequired()) {
  ensureAnomalyDetector();
}
if (isVkSpawnAllowed()) {
  void ensureVibeKanbanRunning();
}
// When VK is externally managed (not spawned by monitor), still connect the
// log stream so agent logs are captured to .cache/agent-logs/.
if (isVkRuntimeRequired() && !isVkSpawnAllowed() && vkEndpointUrl) {
  void isVibeKanbanOnline().then((online) => {
    if (online) ensureVkLogStream();
  });
}
if (
  isVkSpawnAllowed() &&
  Number.isFinite(vkEnsureIntervalMs) &&
  vkEnsureIntervalMs > 0
) {
  safeSetInterval("vk-runtime-ensure", () => ensureVibeKanbanRunning(), vkEnsureIntervalMs);
}
// Periodically reconnect log stream for externally-managed VK (e.g. after VK restart).
// Session discovery is handled by ensureVkSessionDiscoveryLoop() inside ensureVkLogStream().
if (
  isVkRuntimeRequired() &&
  !isVkSpawnAllowed() &&
  vkEndpointUrl &&
  Number.isFinite(vkEnsureIntervalMs) &&
  vkEnsureIntervalMs > 0
) {
  safeSetInterval("vk-logstream-reconnect", async () => {
    if (!vkLogStream) {
      const online = await isVibeKanbanOnline();
      if (online) ensureVkLogStream();
    }
  }, vkEnsureIntervalMs);
}
void ensureCodexSdkReady().then(() => {
  if (!codexEnabled) {
    const reason = codexDisabledReason || "disabled";
    console.warn(`[monitor] Codex disabled: ${reason}`);
  } else {
    console.log("[monitor] Codex enabled.");
  }
});

// ── Log complexity routing matrix at startup ──────────────────────────────────
try {
  const complexityMatrix = getComplexityMatrix(config.complexityRouting);
  const matrixLines = [];
  for (const [exec, tiers] of Object.entries(complexityMatrix)) {
    for (const [tier, profile] of Object.entries(tiers)) {
      matrixLines.push(
        `  ${exec}/${tier}: ${profile.model || "default"} (${profile.reasoningEffort || "default"})`,
      );
    }
  }
  console.log(
    `[monitor] complexity routing matrix:\n${matrixLines.join("\n")}`,
  );
} catch (err) {
  console.warn(`[monitor] complexity matrix log failed: ${err.message}`);
}

// ── Clean stale status data on startup ─────────────────────────────────────
try {
  const statusRaw = existsSync(statusPath)
    ? readFileSync(statusPath, "utf8")
    : null;
  if (statusRaw) {
    const statusData = JSON.parse(statusRaw);
    const attempts = statusData.attempts || {};
    const STALE_AGE_MS = 12 * 60 * 60 * 1000; // 12 hours
    const now = Date.now();
    let cleaned = 0;
    for (const [key, attempt] of Object.entries(attempts)) {
      const ts = attempt?.updated_at || attempt?.created_at;
      if (!ts) continue;
      const age = now - Date.parse(ts);
      if (age > STALE_AGE_MS && attempt.status === "running") {
        // Mark stale running attempts as "stale" so they don't show as active
        attempt.status = "stale";
        attempt._stale_reason = `No update for ${Math.round(age / 3600000)}h — marked stale on startup`;
        cleaned++;
      }
    }
    if (cleaned > 0) {
      statusData.updated_at = new Date().toISOString();
      writeFileSync(statusPath, JSON.stringify(statusData, null, 2), "utf8");
      console.log(
        `[monitor] cleaned ${cleaned} stale attempts from status file`,
      );
    }
  }
} catch (err) {
  console.warn(`[monitor] stale cleanup failed: ${err.message}`);
}
} else {
  console.log(
    "[monitor] test runtime detected (VITEST/NODE_ENV=test) — startup maintenance loops disabled",
  );
}

// ── Internal Executor / VK Orchestrator startup ──────────────────────────────
/** @type {import("./task-executor.mjs").TaskExecutor|null} */
let internalTaskExecutor = null;
/** @type {import("./agent-endpoint.mjs").AgentEndpoint|null} */
let agentEndpoint = null;
/** @type {import("./agent-event-bus.mjs").AgentEventBus|null} */
let agentEventBus = null;
/** @type {import("./review-agent.mjs").ReviewAgent|null} */
let reviewAgent = null;
/** @type {Map<string, import("./merge-strategy.mjs").MergeContext>} */
const pendingMergeStrategyByTask = new Map();
/** @type {Map<string, { approved: boolean, reviewedAt: string }>} */
const reviewGateResults = new Map();
/** @type {import("./sync-engine.mjs").SyncEngine|null} */
let syncEngine = null;
/** @type {import("./error-detector.mjs").ErrorDetector|null} */
let errorDetector = null;
/** @type {import("./agent-supervisor.mjs").AgentSupervisor|null} */
let agentSupervisor = null;
/** @type {import("./pr-cleanup-daemon.mjs").PRCleanupDaemon|null} */
let prCleanupDaemon = null;
/** @type {import("./github-reconciler.mjs").GitHubReconciler|null} */
let ghReconciler = null;

function restartGitHubReconciler() {
  if (isWorkflowReplacingModule("github-reconciler.mjs")) {
    console.log("[monitor] skipping legacy GitHub reconciler — handled by workflow");
    return;
  }
  try {
    stopGitHubReconciler();
    ghReconciler = null;
  } catch {
    /* best effort */
  }

  const activeKanbanBackend = getActiveKanbanBackend();
  if (activeKanbanBackend !== "github") {
    return;
  }
  if (!githubReconcile?.enabled) {
    return;
  }
  const repo =
    process.env.GITHUB_REPOSITORY ||
    (process.env.GITHUB_REPO_OWNER && process.env.GITHUB_REPO_NAME
      ? `${process.env.GITHUB_REPO_OWNER}/${process.env.GITHUB_REPO_NAME}`
      : "") ||
    repoSlug ||
    "unknown/unknown";
  if (!repo || repo === "unknown/unknown") {
    console.warn("[gh-reconciler] disabled — missing repo slug");
    return;
  }

  ghReconciler = startGitHubReconciler({
    repoSlug: repo,
    intervalMs: githubReconcile.intervalMs,
    mergedLookbackHours: githubReconcile.mergedLookbackHours,
    trackingLabels: githubReconcile.trackingLabels,
    sendTelegram:
      telegramToken && telegramChatId
        ? (msg) => void sendTelegramMessage(msg)
        : null,
  });
}

if (!isMonitorTestRuntime) {
if (workflowAutomationEnabled) {
  await ensureWorkflowAutomationEngine().catch(() => {});
} else {
  console.log(
    "[workflows] automation disabled (set WORKFLOW_AUTOMATION_ENABLED=true to enable event-driven workflow triggers)",
  );
}
// ── Task Management Subsystem Initialization ────────────────────────────────
try {
  mkdirSync(monitorStateCacheDir, { recursive: true });
  configureTaskStore({
    storePath: resolve(monitorStateCacheDir, "kanban-state.json"),
  });
  console.log(`[monitor] planner state path: ${plannerStatePath}`);
  console.log(`[monitor] task store path: ${getStorePath()}`);
  loadTaskStore();
  console.log("[monitor] internal task store loaded");
} catch (err) {
  console.warn(`[monitor] task store init warning: ${err.message}`);
}

// Error detector
try {
  errorDetector = createErrorDetector({
    sendTelegram:
      telegramToken && telegramChatId
        ? (msg) => void sendTelegramMessage(msg)
        : null,
  });
  console.log("[monitor] error detector initialized");
} catch (err) {
  console.warn(`[monitor] error detector init failed: ${err.message}`);
}

if (isExecutorDisabled()) {
  console.log(
    `[monitor] :ban: task execution DISABLED (EXECUTOR_MODE=${executorMode}) — no tasks will be executed`,
  );
} else if (executorMode === "internal" || executorMode === "hybrid") {
  // Start internal executor
  try {
    const workflowOwnsTaskExecutorLifecycle = isWorkflowReplacingModule("task-executor.mjs");
    if (workflowOwnsTaskExecutorLifecycle) {
      console.log(
        "[monitor] task-executor lifecycle delegation enabled — finalization/recovery handled by workflow replacement",
      );
    }
    const execOpts = {
      ...internalExecutorConfig,
      repoRoot,
      repoSlug,
      agentPrompts,
      workflowOwnsTaskLifecycle: workflowOwnsTaskExecutorLifecycle,
      sendTelegram:
        telegramToken && telegramChatId
          ? (msg) => void sendTelegramMessage(msg)
          : null,
      onTaskStarted: (task, slot) => {
        const agentId =
          Number.isFinite(slot?.agentInstanceId) && slot.agentInstanceId > 0
            ? `#${slot.agentInstanceId}`
            : "n/a";
        const taskId = String(task?.id || task?.task_id || "").trim();
        console.log(
          `[task-executor] :rocket: started: "${task.title}" (${slot.sdk}) agent=${agentId} branch=${slot.branch} worktree=${slot.worktreePath || "(pending)"}`,
        );
        if (agentEventBus) agentEventBus.onTaskStarted(task, slot);
        if (taskId) {
          queueWorkflowEvent(
            "task.assigned",
            {
              taskId,
              taskTitle: task?.title || "",
              taskStatus: "inprogress",
              sdk: slot?.sdk || null,
              branch: slot?.branch || null,
              worktreePath: slot?.worktreePath || null,
            },
            { dedupKey: `workflow-event:task.assigned:${taskId}` },
          );
          queueWorkflowEvent(
            "agent.started",
            {
              taskId,
              taskTitle: task?.title || "",
              sdk: slot?.sdk || null,
              branch: slot?.branch || null,
              agentInstanceId: slot?.agentInstanceId ?? null,
            },
            { dedupKey: `workflow-event:agent.started:${taskId}:${slot?.agentInstanceId ?? "na"}` },
          );
        }
      },
      onTaskCompleted: (task, result) => {
        const taskId = String(task?.id || task?.task_id || "").trim();
        const finalizationFailed =
          result?.finalized === false ||
          String(result?.finalizationReason || "").trim().toLowerCase() ===
            "no_commits";
        const branch = String(
          result?.branch ||
            task?.branchName ||
            task?.meta?.branch_name ||
            "",
        ).trim() || null;
        const worktreePath = String(
          result?.worktreePath ||
            task?.worktreePath ||
            task?.meta?.worktreePath ||
            "",
        ).trim() || null;
        const prNumber = result?.prNumber
          ? String(result.prNumber)
          : null;
        const prUrl = String(result?.prUrl || "").trim() || null;
        const baseBranch = String(
          result?.baseBranch ||
            task?.baseBranch ||
            task?.base_branch ||
            task?.meta?.base_branch ||
            "",
        ).trim() || null;
        console.log(
          finalizationFailed
            ? `[task-executor] :alert: completed without finalization: "${task.title}" (${result.attempts} attempt(s), reason=${result?.finalizationReason || "unknown"})`
            : `[task-executor] :check: completed: "${task.title}" (${result.attempts} attempt(s))`,
        );
        if (!finalizationFailed && agentEventBus) {
          agentEventBus.onTaskCompleted(task, result);
        } else if (!finalizationFailed) {
          // Fallback: queue review directly if event bus not ready
          if (reviewAgent && result.success) {
            try {
              reviewAgent.queueReview({
                id: task.id || task.task_id,
                title: task.title,
                branchName: task.branchName || task.meta?.branch_name,
                description: task.description || "",
                taskContext: task?._taskContextBlock || task?.meta?.taskContextBlock || "",
              });
            } catch {
              /* best-effort */
            }
          }
        }
        if (taskId) {
          if (finalizationFailed) {
            queueWorkflowEvent(
              "task.finalization_failed",
              {
                taskId,
                taskTitle: task?.title || "",
                taskStatus: "todo",
                attempts: Number(result?.attempts || 0),
                success: false,
                branch,
                worktreePath,
                prNumber,
                prUrl,
                baseBranch,
                reason: result?.finalizationReason || "unknown",
              },
              {
                dedupKey: `workflow-event:task.finalization_failed:${taskId}:${result?.attempts || 0}:${result?.finalizationReason || "unknown"}`,
              },
            );
          } else {
            queueWorkflowEvent(
              "task.completed",
              {
                taskId,
                taskTitle: task?.title || "",
                taskStatus: "completed",
                attempts: Number(result?.attempts || 0),
                success: result?.success !== false,
                branch,
                worktreePath,
                prNumber,
                prUrl,
                baseBranch,
              },
              { dedupKey: `workflow-event:task.completed:${taskId}:${result?.attempts || 0}` },
            );
          }
        }
      },
      onTaskFailed: (task, err) => {
        const taskId = String(task?.id || task?.task_id || "").trim();
        const branch = String(
          err?.branch ||
            task?.branchName ||
            task?.meta?.branch_name ||
            "",
        ).trim() || null;
        const worktreePath = String(
          err?.worktreePath ||
            task?.worktreePath ||
            task?.meta?.worktreePath ||
            "",
        ).trim() || null;
        const baseBranch = String(
          err?.baseBranch ||
            task?.baseBranch ||
            task?.base_branch ||
            task?.meta?.base_branch ||
            "",
        ).trim() || null;
        const attempts =
          Number(err?.attempts || 0) > 0 ? Number(err.attempts) : null;
        console.warn(
          `[task-executor] :close: failed: "${task.title}" — ${formatMonitorError(err)}`,
        );
        if (agentEventBus) agentEventBus.onTaskFailed(task, err);
        if (taskId) {
          const errorMessage = formatMonitorError(err);
          queueWorkflowEvent(
            "task.failed",
            {
              taskId,
              taskTitle: task?.title || "",
              taskStatus: "failed",
              error: errorMessage,
              branch,
              worktreePath,
              baseBranch,
              attempts,
            },
            { dedupKey: `workflow-event:task.failed:${taskId}:${errorMessage}` },
          );
          queueWorkflowEvent(
            "agent.crashed",
            {
              taskId,
              taskTitle: task?.title || "",
              error: errorMessage,
            },
            { dedupKey: `workflow-event:agent.crashed:${taskId}:${errorMessage}` },
          );
        }
      },
    };
    internalTaskExecutor = getTaskExecutor(execOpts);
    internalTaskExecutor.start();

    // Write executor slots to status file every 30s for Telegram /tasks
    startStatusFileWriter(30000);
    console.log(
      `[monitor] internal executor started (maxParallel=${execOpts.maxParallel || 3}, sdk=${execOpts.sdk || "auto"})`,
    );

    // ── Agent Endpoint ──
    try {
      agentEndpoint = createAgentEndpoint({
        port: Number(process.env.AGENT_ENDPOINT_PORT || 18432),
        taskStore: {
          listTasks: (_projectId, { status } = {}) => {
            const normalized = String(status || "")
              .trim()
              .toLowerCase();
            if (!normalized) return getAllInternalTasks();
            return getInternalTasksByStatus(normalized);
          },
          getTask: (taskId) => getInternalTask(taskId),
          addTask: (taskData) => addInternalTask(taskData),
          updateTaskStatus: (taskId, status) =>
            setInternalTaskStatus(taskId, status, "agent-endpoint"),
          update: (taskId, updates) => updateInternalTask(taskId, updates),
          recordAgentAttempt: (taskId, info) =>
            recordAgentAttempt(taskId, info),
          recordErrorPattern: (taskId, pattern) =>
            recordErrorPattern(taskId, pattern),
        },
        getExecutorStatus: () => {
          if (!internalTaskExecutor) {
            return { running: false, paused: false, activeSlots: 0 };
          }
          return internalTaskExecutor.getStatus();
        },
        onPauseTasks: () => {
          if (!internalTaskExecutor) {
            return {
              paused: false,
              changed: false,
              reason: "executor-not-ready",
            };
          }
          const changed = internalTaskExecutor.pause();
          return {
            paused: true,
            changed,
            status: internalTaskExecutor.getStatus(),
          };
        },
        onResumeTasks: () => {
          if (!internalTaskExecutor) {
            return {
              paused: false,
              changed: false,
              reason: "executor-not-ready",
            };
          }
          const changed = internalTaskExecutor.resume();
          return {
            paused: internalTaskExecutor.isPaused(),
            changed,
            status: internalTaskExecutor.getStatus(),
          };
        },
        onTaskComplete: (taskId, body) => {
          console.log(`[monitor] agent self-reported complete for ${taskId}`);
          if (agentEventBus) {
            agentEventBus.onAgentComplete(taskId, body);
          } else {
            try {
              setInternalTaskStatus(taskId, "inreview", "agent-endpoint");
            } catch {
              /* best-effort */
            }
            if (reviewAgent) {
              const task = internalTaskExecutor?._activeSlots?.get(taskId);
              if (task)
                reviewAgent.queueReview({
                  id: taskId,
                  title: task.taskTitle,
                  prNumber: body?.prNumber,
                  branchName: task.branch,
                  description: body?.description || "",
                  taskContext: task.taskContext || task.taskContextBlock || "",
                });
            }
          }
        },
        onTaskError: (taskId, body) => {
          console.warn(
            `[monitor] agent self-reported error for ${taskId}: ${body?.error}`,
          );
          if (agentEventBus) {
            agentEventBus.onAgentError(taskId, body);
          } else if (errorDetector) {
            const classification = errorDetector.classify(
              body?.output || "",
              body?.error || "",
            );
            errorDetector.recordError(taskId, classification);
          }
        },
        onStatusChange: (taskId, newStatus) => {
          console.log(
            `[monitor] agent status change for ${taskId}: ${newStatus}`,
          );
          if (agentEventBus) {
            agentEventBus.onStatusChange(taskId, newStatus, "agent");
          } else {
            try {
              setInternalTaskStatus(taskId, newStatus, "agent-endpoint");
            } catch {
              /* best-effort */
            }
          }
        },
      });
      agentEndpoint
        .start()
        .then(() => {
          console.log("[monitor] agent endpoint started");
        })
        .catch((err) => {
          console.warn(
            `[monitor] agent endpoint failed to start: ${err.message}`,
          );
          agentEndpoint = null;
        });
    } catch (err) {
      console.warn(`[monitor] agent endpoint creation failed: ${err.message}`);
      agentEndpoint = null;
    }

    // ── Agent Event Bus ──
    try {
      agentEventBus = createAgentEventBus({
        errorDetector: errorDetector || undefined,
        sendTelegram:
          telegramToken && telegramChatId
            ? (msg) => void sendTelegramMessage(msg)
            : null,
        getTask: (taskId) => getInternalTask(taskId),
        setTaskStatus: (taskId, status, source) =>
          setInternalTaskStatus(taskId, status, source),
        // broadcastUiEvent is wired later when UI server starts via
        // injectUiDependencies → setBroadcastFn pattern
      });
      agentEventBus.start();
      console.log("[monitor] agent event bus started");
    } catch (err) {
      console.warn(`[monitor] agent event bus failed: ${err.message}`);
      agentEventBus = null;
    }

    // ── Agent Supervisor ──
    try {
      agentSupervisor = createAgentSupervisor({
        sessionTracker: (() => {
          try { return getSessionTracker(); } catch { return null; }
        })(),
        errorDetector: errorDetector || undefined,
        eventBus: agentEventBus || undefined,
        sendTelegram:
          telegramToken && telegramChatId
            ? (msg) => void sendTelegramMessage(msg)
            : null,
        getTask: (taskId) => getInternalTask(taskId),
        setTaskStatus: (taskId, status, source) =>
          setInternalTaskStatus(taskId, status, source),
        assessIntervalMs: 30_000,
        // ── Intervention callbacks (steering, thread management) ──
        forceNewThread: (taskId, reason) => {
          console.log(`[monitor] supervisor forcing new thread for ${taskId}: ${reason}`);
          forceNewThread(taskId, reason);
        },
        injectPrompt: (taskId, prompt) => {
          if (hasActiveSession(taskId)) {
            console.log(`[monitor] supervisor steering active session for ${taskId}`);
            steerActiveThread(taskId, prompt);
          } else {
            console.warn(`[monitor] supervisor inject: no active session for ${taskId}, prompt dropped`);
          }
        },
        sendContinueSignal: (taskId) => {
          if (hasActiveSession(taskId)) {
            console.log(`[monitor] supervisor sending continue signal to ${taskId}`);
            steerActiveThread(taskId, "Continue executing your current task. Do NOT restart or re-read files you already processed.");
          } else {
            console.warn(`[monitor] supervisor continue: no active session for ${taskId}`);
          }
        },
      });
      agentSupervisor.start();

      // Wire supervisor into event bus and review agent
      if (agentEventBus) agentEventBus.setSupervisor(agentSupervisor);

      console.log("[monitor] agent supervisor started");
    } catch (err) {
      console.warn(`[monitor] agent supervisor failed: ${err.message}`);
      agentSupervisor = null;
    }

    // ── Review Agent ──
    if (isReviewAgentEnabled()) {
      try {
        reviewAgent = createReviewAgent({
          maxConcurrentReviews: Number(
            process.env.INTERNAL_EXECUTOR_REVIEW_MAX_CONCURRENT ||
              internalExecutorConfig?.reviewMaxConcurrent ||
              2,
          ),
          reviewTimeoutMs: Number(
            process.env.INTERNAL_EXECUTOR_REVIEW_TIMEOUT_MS ||
              internalExecutorConfig?.reviewTimeoutMs ||
              300_000,
          ),
          sendTelegram:
            telegramToken && telegramChatId
              ? (msg) => void sendTelegramMessage(msg)
              : null,
          promptTemplate: agentPrompts?.reviewer,
          onReviewComplete: (taskId, result) => {
            const normalizedTaskId = String(taskId || "").trim();
            console.log(
              `[monitor] review complete for ${taskId}: ${result?.approved ? "approved" : "changes_requested"} — prMerged: ${result?.prMerged}`,
            );
            reviewGateResults.set(normalizedTaskId, {
              approved: result?.approved === true,
              reviewedAt: result?.reviewedAt || new Date().toISOString(),
            });
            try {
              setReviewResult(taskId, {
                approved: result?.approved ?? false,
                issues: result?.issues || [],
              });
            } catch {
              /* best-effort */
            }
            const pendingCtx = result?.approved
              ? dequeuePendingMergeStrategy(normalizedTaskId)
              : null;

            if (result?.approved && result?.prMerged) {
              // PR merged and reviewer happy — fully done
              console.log(
                `[monitor] review approved + PR merged — marking ${taskId} as done`,
              );
              try {
                setInternalTaskStatus(taskId, "done", "review-agent");
              } catch {
                /* best-effort */
              }
              try {
                updateTaskStatus(taskId, "done");
              } catch {
                /* best-effort */
              }
            } else if (result?.approved && !result?.prMerged) {
              // Approved but PR not yet merged — stays in review
              console.log(
                `[monitor] review approved but PR not merged — ${taskId} stays inreview`,
              );
              if (pendingCtx) {
                console.log(
                  `[monitor] flow gate released for ${taskId} — running deferred merge strategy`,
                );
                void runMergeStrategyAnalysis(
                  {
                    ...pendingCtx,
                    taskId: pendingCtx.taskId || taskId,
                  },
                  { skipFlowGate: false },
                );
              } else {
                void triggerFlowPostReviewMerge(taskId, {
                  taskTitle: getInternalTask(taskId)?.title || taskId,
                });
              }
            } else {
              console.log(
                `[monitor] review found ${result?.issues?.length || 0} issue(s) for ${taskId} — task stays inreview`,
              );
              if (pendingMergeStrategyByTask.has(normalizedTaskId)) {
                console.log(
                  `[monitor] flow gate remains active for ${taskId} — merge strategy stays deferred`,
                );
              }
            }
          },
        });
        reviewAgent.start();

        // Connect review agent to supervisor for review enforcement
        if (agentSupervisor) {
          reviewAgent.setSupervisor(agentSupervisor);
        }

        // Connect review agent to task executor for handoff
        if (internalTaskExecutor) {
          internalTaskExecutor.setReviewAgent(reviewAgent);
        }

        // Re-hydrate inreview tasks after restart so review queue is not empty
        // while task-store still reports tasks awaiting review.
        try {
          const pending = getTasksPendingReview();
          if (Array.isArray(pending) && pending.length > 0) {
            let requeued = 0;
            for (const task of pending) {
              const taskId = String(task?.id || "").trim();
              if (!taskId) continue;
              reviewAgent.queueReview({
                id: taskId,
                title: task?.title || taskId,
                branchName: task?.branchName || "",
                prUrl: task?.prUrl || "",
                description: task?.description || "",
                taskContext: task?._taskContextBlock || task?.meta?.taskContextBlock || "",
                worktreePath: null,
                sessionMessages: "",
                diffStats: "",
              });
              requeued += 1;
            }
            if (requeued > 0) {
              console.log(
                `[monitor] review agent rehydrated ${requeued} inreview task(s) from task-store`,
              );
            }
          }
        } catch (err) {
          console.warn(
            `[monitor] review agent rehydrate failed: ${err.message || err}`,
          );
        }

        console.log("[monitor] review agent started");

        // Wire review agent into event bus
        if (agentEventBus) {
          agentEventBus._reviewAgent = reviewAgent;
        }
      } catch (err) {
        console.warn(`[monitor] review agent failed to start: ${err.message}`);
      }
    } else {
      reviewAgent = null;
      console.log(
        "[monitor] review agent disabled (INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED=0 or config override)",
      );
    }

    // ── Sync Engine ──
    try {
      const activeKanbanBackend = getActiveKanbanBackend();

      // Sync engine only makes sense when there is an external backend to sync
      // with.  When the backend is "internal" there is no remote to pull/push,
      // and every sync attempt would fail, accumulating consecutive-failure
      // counters and spamming alerts.
      if (activeKanbanBackend === "internal") {
        console.log(
          `[monitor] sync engine skipped — kanban backend is "internal" (no external to sync)`,
        );
      } else {
      const projectId = getConfiguredKanbanProjectId(activeKanbanBackend);
      if (projectId) {
        syncEngine = createSyncEngine({
          projectId,
          syncIntervalMs: 60_000, // 1 minute
          syncPolicy: kanbanConfig?.syncPolicy || "internal-primary",
          sendTelegram:
            telegramToken && telegramChatId
              ? (msg) => sendTelegramMessage(msg)
              : null,
          onAlert:
            telegramToken && telegramChatId
              ? (event) =>
                  sendTelegramMessage(
                    `:alert: Project sync alert: ${event?.message || "unknown"}`,
                  )
              : null,
          failureAlertThreshold:
            config?.githubProjectSync?.alertFailureThreshold || 3,
          rateLimitAlertThreshold:
            config?.githubProjectSync?.rateLimitAlertThreshold || 3,
        });
        syncEngine.start();
        console.log(
          `[monitor] sync engine started (interval: 60s, backend=${activeKanbanBackend}, policy=${kanbanConfig?.syncPolicy || "internal-primary"}, project=${projectId})`,
        );
      } else {
        console.log(
          `[monitor] sync engine skipped — no project ID configured for backend=${activeKanbanBackend}`,
        );
      }
      } // end else (non-internal backend)
    } catch (err) {
      console.warn(`[monitor] sync engine failed to start: ${err.message}`);
    }
  } catch (err) {
    console.error(
      `[monitor] internal executor failed to start: ${err.message}`,
    );
  }
}

if (isExecutorDisabled()) {
  // Already logged above
} else if (executorMode === "vk" || executorMode === "hybrid") {
  // Start VK orchestrator (ve-orchestrator.sh/ps1)
  startProcess();
} else {
  console.log("[monitor] VK orchestrator skipped (executor mode = internal)");
  if (!isVkRuntimeRequired()) {
    console.log("[monitor] VK runtime not required — all VK notifications suppressed");
  }
}
if (telegramCommandEnabled) {
  startTelegramCommandListener();
}
// Restore live digest state BEFORE any messages flow — so restarts continue the
// existing digest message instead of creating a new one.
// Chain notifier start after restore to prevent race conditions.
// Also initialise the pinned status board (creates/restores the persistent message).
void restoreLiveDigest()
  .catch(() => {})
  .then(() => startTelegramNotifier())
  .then(() => initStatusBoard().catch(() => {}));

// ── Start long-running devmode monitor-monitor supervisor ───────────────────
startAgentWorkAnalyzer();
startAgentAlertTailer();
startMonitorMonitorSupervisor();
startTaskPlannerStatusLoop();
restartGitHubReconciler();

// ── Two-way Telegram :workflow: primary agent ────────────────────────────────────────
injectMonitorFunctions({
  sendTelegramMessage,
  readStatusData,
  readStatusSummary,
  getCurrentChild: () => currentChild,
  startProcess,
  getVibeKanbanUrl: () => vkPublicUrl || vkEndpointUrl,
  fetchVk,
  getRepoRoot: () => repoRoot,
  startFreshSession,
  attemptFreshSessionRetry,
  buildRetryPrompt,
  getActiveAttemptInfo,
  triggerTaskPlanner,
  reconcileTaskStatuses,
  onDigestSealed: handleDigestSealed,
  getAnomalyReport: () => getAnomalyStatusReport(),
  getInternalExecutor: () => internalTaskExecutor,
  getExecutorMode: () => executorMode,
  getAgentEndpoint: () => agentEndpoint,
  getAgentEventBus: () => agentEventBus,
  getReviewAgent: () => reviewAgent,
  getAgentSupervisor: () => agentSupervisor,
  getReviewAgentEnabled: () => isReviewAgentEnabled(),
  getSyncEngine: () => syncEngine,
  getErrorDetector: () => errorDetector,
  getPrCleanupDaemon: () => prCleanupDaemon,
  getWorkspaceMonitor: () => workspaceMonitor,
  getMonitorMonitorStatus: () => getMonitorMonitorStatusSnapshot(),
  getTaskStoreStats: () => {
    try {
      return getTaskStoreStats();
    } catch {
      return null;
    }
  },
  getTasksPendingReview: () => {
    try {
      return getTasksPendingReview();
    } catch {
      return [];
    }
  },
});
if (telegramBotEnabled) {
  void startTelegramBot(getTelegramBotStartOptions());

  // Process any commands queued by telegram-sentinel while monitor was down
  try {
    const { getQueuedCommands } = await import("./telegram-sentinel.mjs");
    const queued = getQueuedCommands();
    if (queued && queued.length > 0) {
      console.log(
        `[monitor] processing ${queued.length} queued sentinel command(s)`,
      );
      for (const cmd of queued) {
        try {
          console.log(
            `[monitor] replaying sentinel command: ${cmd.command || cmd.type || JSON.stringify(cmd)}`,
          );
          // Handle known commands
          if (cmd.command === "/status" || cmd.type === "status") {
            // Will be covered by next status report
            console.log(
              "[monitor] sentinel queued /status — will send on next cycle",
            );
          } else if (cmd.command === "/pause" || cmd.type === "pause") {
            console.log(
              "[monitor] sentinel queued /pause — pausing task dispatch",
            );
            // Signal pause if task executor supports it
          } else if (cmd.command === "/resume" || cmd.type === "resume") {
            console.log("[monitor] sentinel queued /resume — resuming");
          }
        } catch (cmdErr) {
          console.warn(
            `[monitor] failed to process queued command: ${cmdErr.message}`,
          );
        }
      }
    }
  } catch {
    // telegram-sentinel not available — ignore
  }
}

// ── Start WhatsApp channel (when configured) ──────────────────────────────────
if (isWhatsAppEnabled()) {
  try {
    await startWhatsAppChannel({
      onMessage: async (msg) => {
        // Route WhatsApp messages to primary agent (same as Telegram user messages)
        if (primaryAgentReady && msg.text) {
          try {
            const response = await execPrimaryPrompt(msg.text);
            if (response) {
              await notifyWhatsApp(response);
            }
          } catch (err) {
            console.warn(`[monitor] WhatsApp→agent failed: ${err.message}`);
          }
        }
      },
      onStatusChange: (status) => {
        console.log(`[monitor] WhatsApp status: ${status}`);
      },
      logger: (level, ...args) => console.log(`[whatsapp] [${level}]`, ...args),
    });
    console.log("[monitor] WhatsApp channel started");
  } catch (err) {
    console.warn(`[monitor] WhatsApp channel failed to start: ${err.message}`);
  }
}

// ── Container runtime initialization (when configured) ────────────────────
if (isContainerEnabled()) {
  try {
    await ensureContainerRuntime();
    await cleanupOrphanedContainers();
    console.log("[monitor] Container runtime ready:", getContainerStatus());
  } catch (err) {
    console.warn(`[monitor] Container runtime not available: ${err.message}`);
    console.warn(
      "[monitor] Container isolation will be disabled for this session",
    );
  }
}

// ── Start PR Cleanup Daemon ──────────────────────────────────────────────────
// Automatically resolves PR conflicts and CI failures every 30 minutes
if (config.prCleanupEnabled !== false) {
  if (isWorkflowReplacingModule("pr-cleanup-daemon.mjs")) {
    console.log("[monitor] skipping legacy PR cleanup daemon — handled by workflow");
  } else {
    const prRepoRoot = effectiveRepoRoot || repoRoot || process.cwd();
    const flowGateControlsMerges =
      isFlowPrimaryEnabled() && isFlowReviewGateEnabled();
    console.log(`[monitor] Starting PR cleanup daemon (repoRoot: ${prRepoRoot})...`);
    if (flowGateControlsMerges) {
      console.log(
        "[monitor] Flow review gate is active — PR cleanup daemon auto-merge is disabled",
      );
    }
    prCleanupDaemon = new PRCleanupDaemon({
      intervalMs: 30 * 60 * 1000, // 30 minutes
      maxConcurrentCleanups: 3,
      dryRun: false,
      autoMerge: !flowGateControlsMerges,
      repoRoot: prRepoRoot,
    });
    prCleanupDaemon.start();
  }
}
} else {
  console.log(
    "[monitor] test runtime detected (VITEST/NODE_ENV=test) — runtime services disabled",
  );
}

// ── Named exports for testing ───────────────────────────────────────────────
export {
  fetchVk,
  updateTaskStatus,
  reconcileTaskStatuses,
  safeRecoverTask,
  recoverySkipCache,
  getTaskAgeMs,
  classifyConflictedFiles,
  AUTO_RESOLVE_THEIRS,
  AUTO_RESOLVE_OURS,
  AUTO_RESOLVE_LOCK_EXTENSIONS,
  extractScopeFromTitle,
  resolveUpstreamFromConfig,
  rebaseDownstreamTasks,
  runTaskAssessment,
  // Internal executor
  internalTaskExecutor,
  // Task management subsystems
  agentEndpoint,
  reviewAgent,
  syncEngine,
  errorDetector,
  // Fleet coordination re-exports for external consumers
  getFleetState,
  isFleetCoordinator,
  getFleetMode,
  formatFleetSummary,
  buildExecutionWaves,
  calculateBacklogDepth,
  detectMaintenanceMode,
  appendKnowledgeEntry,
  buildKnowledgeEntry,
  formatKnowledgeSummary,
  extractPlannerTasksFromOutput,
  formatCodexResult,
  // Container runner re-exports
  getContainerStatus,
  isContainerEnabled,
};
