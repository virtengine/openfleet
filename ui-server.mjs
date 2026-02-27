import { execSync, spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual, X509Certificate } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, chmodSync, createWriteStream, createReadStream, writeFileSync, unlinkSync, watchFile, unwatchFile } from "node:fs";
import { open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { get as httpsGet } from "node:https";
import { createServer as createHttpsServer } from "node:https";
import { networkInterfaces, homedir } from "node:os";
import { connect as netConnect } from "node:net";
import { resolve, extname, dirname, basename, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { arch as osArch, platform as osPlatform } from "node:os";
import Ajv2020 from "ajv/dist/2020.js";

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
} from "./kanban-adapter.mjs";
import {
  getActiveThreads,
  launchEphemeralThread,
  launchOrResumeThread,
  execWithRetry,
  invalidateThread,
} from "./agent-pool.mjs";
import { resolveAgentPrompts } from "./agent-prompts.mjs";
import {
  listActiveWorktrees,
  getWorktreeStats,
  pruneStaleWorktrees,
  releaseWorktree,
  releaseWorktreeByBranch,
} from "./worktree-manager.mjs";
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
  loadManifest,
  getManifestPath,
} from "./library-manager.mjs";
import {
  loadSharedWorkspaceRegistry,
  sweepExpiredLeases,
  getSharedAvailabilityMap,
  claimSharedWorkspace,
  releaseSharedWorkspace,
  renewSharedWorkspaceLease,
} from "./shared-workspace-registry.mjs";
import {
  getAllSharedStates,
  clearIgnoreFlag,
  setIgnoreFlag,
} from "./shared-state-manager.mjs";
import {
  initPresence,
  listActiveInstances,
  selectCoordinator,
} from "./presence.mjs";
import {
  loadWorkspaceRegistry,
  getLocalWorkspace,
} from "./workspace-registry.mjs";
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
} from "./workspace-manager.mjs";
import {
  getSessionTracker,
  addSessionEventListener,
} from "./session-tracker.mjs";
import {
  collectDiffStats,
  getCompactDiffSummary,
  getRecentCommits,
} from "./diff-stats.mjs";
import { resolveRepoRoot } from "./repo-root.mjs";
import {
  SETTINGS_SCHEMA,
  validateSetting,
} from "./ui/modules/settings-schema.js";
import { loadConfig } from "./config.mjs";
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
} from "./primary-agent.mjs";
import {
  addTaskAttachment,
  listTaskAttachments,
  mergeTaskAttachments,
} from "./task-attachments.mjs";

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolveRepoRoot();
const uiRootPreferred = resolve(__dirname, "site", "ui");
const uiRootFallback = resolve(__dirname, "ui");
const uiRoot = existsSync(uiRootPreferred) ? uiRootPreferred : uiRootFallback;
let libraryInitAttempted = false;

function ensureLibraryInitialized() {
  if (libraryInitAttempted) return;
  libraryInitAttempted = true;
  try {
    const manifestPath = getManifestPath(repoRoot);
    const manifest = loadManifest(repoRoot);
    if (!existsSync(manifestPath) || !Array.isArray(manifest?.entries) || manifest.entries.length === 0) {
      const result = initLibrary(repoRoot);
      const count = result?.manifest?.entries?.length ?? 0;
      if (count > 0) {
        console.log(`[ui] Library initialized (${count} entries).`);
      }
    }
  } catch (err) {
    console.warn(`[ui] Library init failed: ${err.message}`);
  }
}

// ── Workflow engine lazy-loader (module-scope cache) ──────────────────────────
let _wfEngine;
let _wfNodes;
let _wfTemplates;
let _wfServicesReady = false;
let _wfRecommendedInstalled = false;
let _wfInitPromise = null;
let _wfInitDone = false;
let _wfLoadedBase = null;

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

function resolveWorkflowBootstrapSelection(templatesModule) {
  const autoInstallEnabled = parseBooleanEnv(
    process.env.WORKFLOW_DEFAULT_AUTOINSTALL,
    true,
  );
  if (!autoInstallEnabled) {
    return {
      enabled: false,
      source: "disabled",
      profileId: null,
      templateIds: [],
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
      };
    }
    return {
      enabled: true,
      source: "custom:list",
      profileId: null,
      templateIds: parseTemplateIdList(rawTemplateEnv),
    };
  }

  const profileId = String(
    process.env.WORKFLOW_DEFAULT_PROFILE || "balanced",
  ).trim().toLowerCase();

  if (typeof templatesModule?.resolveWorkflowTemplateIds === "function") {
    return {
      enabled: true,
      source: "profile",
      profileId,
      templateIds: templatesModule.resolveWorkflowTemplateIds({ profileId }),
    };
  }

  return {
    enabled: true,
    source: "recommended",
    profileId: null,
    templateIds: [],
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
        _wfEngine = await import(new URL("workflow-engine.mjs", base).href);
        _wfNodes = await import(new URL("workflow-nodes.mjs", base).href);
        _wfTemplates = await import(new URL("workflow-templates.mjs", base).href);
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
              async sendMessage(chatId, text) {
                const target = chatId || telegramChatId;
                if (!target) return;
                try {
                  await fetch(
                    `https://api.telegram.org/bot${telegramToken}/sendMessage`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        chat_id: target,
                        text: String(text || ""),
                        parse_mode: "HTML",
                      }),
                    }
                  );
                } catch (e) {
                  console.warn("[workflows/telegram] sendMessage failed:", e.message);
                }
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

        const services = {
          telegram: telegramService,
          agentPool: agentPoolService,
          kanban: kanbanService,
          prompts: promptBundle?.prompts || null,
        };
        _wfEngine.getWorkflowEngine({ services });
        _wfServicesReady = true;
      } catch (err) {
        console.warn("[workflows] services setup failed (engine still usable):", err.message);
      }
    }

    if (!_wfRecommendedInstalled && _wfTemplates) {
      try {
        const engine = _wfEngine.getWorkflowEngine();
        const selection = resolveWorkflowBootstrapSelection(_wfTemplates);
        let result = { installed: [], skipped: [], errors: [] };

        if (selection.enabled) {
          if (
            Array.isArray(selection.templateIds) &&
            selection.templateIds.length > 0 &&
            typeof _wfTemplates.installTemplateSet === "function"
          ) {
            result = _wfTemplates.installTemplateSet(engine, selection.templateIds);
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
  "es-module-shims.js":       { specifier: "es-module-shims/dist/es-module-shims.js",        cdn: "https://cdn.jsdelivr.net/npm/es-module-shims@1.10.0/dist/es-module-shims.min.js" },
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
    "Cache-Control": "max-age=86400, stale-while-revalidate=604800",
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
  const localPath = resolveVendorPath(entry.specifier);
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
const statusPath = resolve(repoRoot, ".cache", "ve-orchestrator-status.json");
const logsDir = resolve(__dirname, "logs");
const monitorMonitorLogsDir = resolve(repoRoot, ".cache", "monitor-monitor-logs");
const agentLogsDirCandidates = [
  resolve(__dirname, "logs", "agents"),
  resolve(repoRoot, ".cache", "agent-logs"),
];
const CONFIG_SCHEMA_PATH = resolve(__dirname, "bosun.schema.json");
const PLANNER_STATE_PATH = resolve(
  repoRoot,
  ".bosun",
  ".cache",
  "task-planner-state.json",
);
let _configSchema = null;
let _configValidator = null;

function normalizeTriggerTemplateId(template = {}) {
  return String(template?.id || template?.name || "")
    .trim()
    .toLowerCase();
}

function normalizeTriggerTemplate(template = {}) {
  const id = normalizeTriggerTemplateId(template);
  if (!id) return null;
  return {
    ...template,
    id,
    name: String(template?.name || id).trim() || id,
    enabled: template?.enabled === true,
    action:
      String(template?.action || "task-planner").trim() === "create-task"
        ? "create-task"
        : "task-planner",
    minIntervalMinutes:
      Number.isFinite(Number(template?.minIntervalMinutes)) &&
      Number(template?.minIntervalMinutes) > 0
        ? Number(template.minIntervalMinutes)
        : undefined,
    trigger:
      template?.trigger && typeof template.trigger === "object"
        ? template.trigger
        : { anyOf: [] },
    config:
      template?.config && typeof template.config === "object"
        ? template.config
        : {},
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

async function readPlannerTemplateState() {
  try {
    const raw = await readFile(PLANNER_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
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
  const plannerState = await readPlannerTemplateState();
  const plannerTemplateMap =
    plannerState?.trigger_templates &&
    typeof plannerState.trigger_templates === "object"
      ? plannerState.trigger_templates
      : {};
  const statsByTemplateId = await collectTriggerTemplateTaskStats(
    triggerSystem.templates,
  );

  const templates = triggerSystem.templates.map((template) => {
    const templateId = normalizeTriggerTemplateId(template);
    return {
      ...template,
      state:
        plannerTemplateMap[templateId] &&
        typeof plannerTemplateMap[templateId] === "object"
          ? plannerTemplateMap[templateId]
          : {},
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
    planner: {
      lastTriggeredAt: plannerState?.last_triggered_at || null,
      lastSuccessAt: plannerState?.last_success_at || null,
      lastFailureAt: plannerState?.last_failure_at || null,
      lastError: plannerState?.last_error || null,
    },
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
  TASK_PLANNER_MODE: "plannerMode",
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
};
const CONFIG_PATH_OVERRIDES = {
  EXECUTOR_MODE: ["internalExecutor", "mode"],
  PROJECT_REQUIREMENTS_PROFILE: ["projectRequirements", "profile"],
  TASK_PLANNER_DEDUP_HOURS: ["plannerDedupHours"],
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

// Read port lazily — .env may not be loaded at module import time
function getDefaultPort() {
  return Number(process.env.TELEGRAM_UI_PORT || "0") || 0;
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
const DEFAULT_SESSION_TOKEN_TTL_MS = AUTH_MAX_AGE_SEC * 1000;
const wsClients = new Set();
let sessionListenerAttached = false;
/** @type {ReturnType<typeof setInterval>|null} */
let wsHeartbeatTimer = null;
let uiInstanceLockPath = "";
let uiInstanceLockHeld = false;

/* ─── Log Streaming State ─── */
/** Map<string, { sockets: Set<WebSocket>, offset: number, pollTimer }> keyed by filePath */
const logStreamers = new Map();
let uiDeps = {};

/**
 * Resolve the bosun config directory. Falls back through:
 *   1. uiDeps.configDir (injected at server start)
 *   2. BOSUN_DIR env var
 *   3. ~/bosun (standard default)
 * Ensures the directory exists.
 */
function resolveUiConfigDir() {
  if (process.env.BOSUN_CONFIG_PATH) {
    const fromConfigPath = dirname(resolve(process.env.BOSUN_CONFIG_PATH));
    try { mkdirSync(fromConfigPath, { recursive: true }); } catch { /* ok */ }
    if (!uiDeps.configDir) uiDeps.configDir = fromConfigPath;
    return fromConfigPath;
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
    || resolve(baseDir, "bosun");
  if (dir) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
    // Cache it so subsequent calls don't re-resolve
    if (!uiDeps.configDir) uiDeps.configDir = dir;
  }
  return dir;
}

function getAutoOpenCooldownMs() {
  const raw = Number(process.env.BOSUN_UI_AUTO_OPEN_COOLDOWN_MS || "");
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AUTO_OPEN_COOLDOWN_MS;
  return Math.max(60_000, Math.trunc(raw));
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
  "TELEGRAM_UI_AUTH_MAX_AGE_SEC", "TELEGRAM_UI_TUNNEL",
  "EXECUTOR_MODE", "INTERNAL_EXECUTOR_PARALLEL", "INTERNAL_EXECUTOR_SDK",
  "INTERNAL_EXECUTOR_TIMEOUT_MS", "INTERNAL_EXECUTOR_MAX_RETRIES", "INTERNAL_EXECUTOR_POLL_MS",
  "INTERNAL_EXECUTOR_REVIEW_AGENT_ENABLED", "INTERNAL_EXECUTOR_REPLENISH_ENABLED",
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
  "TASK_PLANNER_MODE", "TASK_TRIGGER_SYSTEM_ENABLED", "TASK_PLANNER_DEDUP_HOURS",
  "TASK_BRANCH_MODE", "TASK_BRANCH_AUTO_MODULE", "TASK_UPSTREAM_SYNC_MAIN",
  "MODULE_BRANCH_PREFIX", "DEFAULT_TARGET_BRANCH",
  "BOSUN_PROMPT_PLANNER",
  "GITHUB_TOKEN", "GITHUB_REPOSITORY", "GITHUB_PROJECT_MODE",
  "GITHUB_PROJECT_NUMBER", "GITHUB_DEFAULT_ASSIGNEE", "GITHUB_AUTO_ASSIGN_CREATOR",
  "BOSUN_GITHUB_APP_ID", "BOSUN_GITHUB_PRIVATE_KEY_PATH", "BOSUN_GITHUB_CLIENT_ID", "BOSUN_GITHUB_CLIENT_SECRET",
  "BOSUN_GITHUB_WEBHOOK_SECRET", "BOSUN_GITHUB_USER_TOKEN",
  "GITHUB_PROJECT_WEBHOOK_PATH", "GITHUB_PROJECT_WEBHOOK_SECRET", "GITHUB_PROJECT_WEBHOOK_REQUIRE_SIGNATURE",
  "GITHUB_PROJECT_SYNC_ALERT_FAILURE_THRESHOLD", "GITHUB_PROJECT_SYNC_RATE_LIMIT_ALERT_THRESHOLD",
  "VK_TARGET_BRANCH", "CODEX_ANALYZE_MERGE_STRATEGY", "DEPENDABOT_AUTO_MERGE",
  "GH_RECONCILE_ENABLED",
  "CLOUDFLARE_TUNNEL_NAME", "CLOUDFLARE_TUNNEL_CREDENTIALS",
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
  "CLOUDFLARE_TUNNEL_CREDENTIALS",
]);

const SETTINGS_KNOWN_SET = new Set(SETTINGS_KNOWN_KEYS);
let _settingsLastUpdateTime = 0;

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

  for (const key of SETTINGS_KNOWN_KEYS) {
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
    if (SETTINGS_SENSITIVE_KEYS.has(key)) {
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
function checkRateLimit(req, maxPerMin = 30) {
  const key = req.headers["x-telegram-initdata"] || req.socket?.remoteAddress || "unknown";
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
const TLS_CACHE_DIR = resolve(__dirname, ".cache", "tls");
const TLS_CERT_PATH = resolve(TLS_CACHE_DIR, "server.crt");
const TLS_KEY_PATH = resolve(TLS_CACHE_DIR, "server.key");
function isTlsDisabled() {
  return ["1", "true", "yes"].includes(
    String(process.env.TELEGRAM_UI_TLS_DISABLE || "").toLowerCase(),
  );
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
    if (!existsSync(TLS_CACHE_DIR)) {
      mkdirSync(TLS_CACHE_DIR, { recursive: true });
    }

    // Reuse existing cert if still valid
    if (existsSync(TLS_CERT_PATH) && existsSync(TLS_KEY_PATH)) {
      try {
        const certPem = readFileSync(TLS_CERT_PATH, "utf8");
        const cert = new X509Certificate(certPem);
        const notAfter = new Date(cert.validTo);
        if (notAfter > new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)) {
          return {
            key: readFileSync(TLS_KEY_PATH),
            cert: readFileSync(TLS_CERT_PATH),
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
    execSync(
      `"${opensslBin}" req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
        `-keyout "${TLS_KEY_PATH}" -out "${TLS_CERT_PATH}" ` +
        `-days 825 -nodes -batch ` +
        `-subj "/CN=bosun" ` +
        `-addext "subjectAltName=${subjectAltName}"`,
      { stdio: "pipe", timeout: 10_000 },
    );

    console.log(
      `[telegram-ui] auto-generated self-signed TLS cert (SAN: ${subjectAltName})`,
    );
    return {
      key: readFileSync(TLS_KEY_PATH),
      cert: readFileSync(TLS_CERT_PATH),
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
    // Build the actual command for pkexec (it doesn't support shell pipelines)
    let pkexecCmd;
    if (firewall === "ufw") {
      pkexecCmd = `pkexec ufw allow ${port}/tcp comment "bosun UI"`;
    } else if (firewall === "firewalld") {
      pkexecCmd = `pkexec bash -c 'firewall-cmd --add-port=${port}/tcp --permanent && firewall-cmd --reload'`;
    } else {
      pkexecCmd = `pkexec iptables -I INPUT -p tcp --dport ${port} -j ACCEPT`;
    }

    try {
      execSync(pkexecCmd, { encoding: "utf8", timeout: 60000, stdio: "pipe" });
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

let tunnelUrl = null;
let tunnelProcess = null;

/** Return the tunnel URL (e.g. https://xxx.trycloudflare.com) or null. */
export function getTunnelUrl() {
  return tunnelUrl;
}

let _tunnelReadyCallbacks = [];

/** Register a callback to be called whenever the tunnel URL changes. */
export function onTunnelUrlChange(cb) {
  if (typeof cb === 'function') _tunnelReadyCallbacks.push(cb);
}

function _notifyTunnelChange(url) {
  for (const cb of _tunnelReadyCallbacks) {
    try { cb(url); } catch (err) {
      console.warn(`[telegram-ui] tunnel change callback error: ${err.message}`);
    }
  }
}

// ── Cloudflared binary auto-download ─────────────────────────────────

const CF_CACHE_DIR = resolve(__dirname, ".cache", "bin");
const CF_BIN_NAME = osPlatform() === "win32" ? "cloudflared.exe" : "cloudflared";
const CF_CACHED_PATH = resolve(CF_CACHE_DIR, CF_BIN_NAME);

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
  // 1. Check system PATH
  try {
    const cmd = osPlatform() === "win32"
      ? "where cloudflared 2>nul"
      : "which cloudflared 2>/dev/null";
    const found = execSync(cmd, { encoding: "utf8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (found) return found.split(/\r?\n/)[0]; // `where` may return multiple lines
  } catch { /* not on PATH */ }

  // 2. Check cached binary
  if (existsSync(CF_CACHED_PATH)) {
    return CF_CACHED_PATH;
  }

  // 3. Auto-download
  const dlUrl = getCloudflaredDownloadUrl();
  if (!dlUrl) {
    console.warn("[telegram-ui] cloudflared: unsupported platform/arch for auto-download");
    return null;
  }

  console.log("[telegram-ui] cloudflared not found — auto-downloading...");
  try {
    mkdirSync(CF_CACHE_DIR, { recursive: true });
    await downloadFile(dlUrl, CF_CACHED_PATH);
    if (osPlatform() !== "win32") {
      chmodSync(CF_CACHED_PATH, 0o755);
      // Small delay to ensure OS fully releases file locks after chmod
      await new Promise((r) => setTimeout(r, 100));
    }
    console.log(`[telegram-ui] cloudflared downloaded to ${CF_CACHED_PATH}`);
    return CF_CACHED_PATH;
  } catch (err) {
    console.warn(`[telegram-ui] cloudflared auto-download failed: ${err.message}`);
    return null;
  }
}

/**
 * Start a cloudflared tunnel for the given local URL.
 *
 * Two modes:
 * 1. **Quick tunnel** (default): Free, no account, random *.trycloudflare.com domain.
 *    Pros: Zero setup. Cons: URL changes on each restart.
 * 2. **Named tunnel**: Persistent custom domain (e.g., myapp.example.com).
 *    Pros: Stable URL, custom domain. Cons: Requires cloudflare account + tunnel setup.
 *
 * Named tunnel setup:
 *   1. Create a tunnel: `cloudflared tunnel create <name>`
 *   2. Create DNS record: `cloudflared tunnel route dns <name> <subdomain.yourdomain.com>`
 *   3. Set env vars:
 *      - CLOUDFLARE_TUNNEL_NAME=<name>
 *      - CLOUDFLARE_TUNNEL_CREDENTIALS=/path/to/<tunnel-id>.json
 *
 * Returns the assigned public URL or null on failure.
 */
async function startTunnel(localPort) {
  const tunnelMode = (process.env.TELEGRAM_UI_TUNNEL || "auto").toLowerCase();
  if (tunnelMode === "disabled" || tunnelMode === "off" || tunnelMode === "0") {
    console.log("[telegram-ui] tunnel disabled via TELEGRAM_UI_TUNNEL=disabled");
    return null;
  }

  // ── SECURITY: Block tunnel when auth is disabled ─────────────────────
  if (isAllowUnsafe()) {
    console.error(
      "[telegram-ui] ⛔ REFUSING to start Cloudflare tunnel — TELEGRAM_UI_ALLOW_UNSAFE=true\n" +
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
    if (tunnelMode === "auto") {
      console.log(
        "[telegram-ui] cloudflared unavailable — Telegram Mini App will use self-signed cert (may be rejected by Telegram webview).",
      );
      return null;
    }
    console.warn("[telegram-ui] cloudflared not found but TELEGRAM_UI_TUNNEL=cloudflared requested");
    return null;
  }

  // Check for named tunnel configuration (persistent URL)
  const namedTunnel = process.env.CLOUDFLARE_TUNNEL_NAME || process.env.CF_TUNNEL_NAME;
  const tunnelCreds = process.env.CLOUDFLARE_TUNNEL_CREDENTIALS || process.env.CF_TUNNEL_CREDENTIALS;

  if (namedTunnel && tunnelCreds) {
    return startNamedTunnel(cfBin, namedTunnel, tunnelCreds, localPort);
  }

  // Fall back to quick tunnel (random URL, no persistence)
  return startQuickTunnel(cfBin, localPort);
}

/**
 * Spawn cloudflared with ETXTBSY retry (race condition after fresh download).
 * Returns the child process or throws after max retries.
 */
function spawnCloudflared(cfBin, args, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
        // Sync sleep (rare case, acceptable here)
        execSync(`sleep 0.${delayMs / 100}`, { stdio: "ignore" });
        continue;
      }
      throw err;
    }
  }
  throw new Error("spawn failed after retries");
}

/**
 * Start a cloudflared **named tunnel** with persistent URL.
 * Requires: cloudflared tunnel create + DNS setup.
 */
async function startNamedTunnel(cfBin, tunnelName, credentialsPath, localPort) {
  if (!existsSync(credentialsPath)) {
    console.warn(`[telegram-ui] named tunnel credentials not found: ${credentialsPath}`);
    console.warn("[telegram-ui] falling back to quick tunnel (random URL)");
    return startQuickTunnel(cfBin, localPort);
  }

  // Named tunnels require config file with ingress rules.
  // We'll create a temporary config on the fly.
  const configPath = resolve(__dirname, ".cache", "cloudflared-config.yml");
  mkdirSync(dirname(configPath), { recursive: true });

  const configYaml = `
tunnel: ${tunnelName}
credentials-file: ${credentialsPath}

ingress:
  - hostname: "*"
    service: https://localhost:${localPort}
    originRequest:
      noTLSVerify: true
  - service: http_status:404
`.trim();

  writeFileSync(configPath, configYaml, "utf8");

  // Read the tunnel ID from credentials to construct the public URL
  let publicUrl = null;
  try {
    const creds = JSON.parse(readFileSync(credentialsPath, "utf8"));
    const tunnelId = creds.TunnelID || creds.tunnel_id;
    if (tunnelId) {
      publicUrl = `https://${tunnelId}.cfargotunnel.com`;
    }
  } catch (err) {
    console.warn(`[telegram-ui] failed to parse tunnel credentials: ${err.message}`);
  }

  return new Promise((resolvePromise) => {
    const args = ["tunnel", "--config", configPath, "run"];
    console.log(`[telegram-ui] starting named tunnel: ${tunnelName} → https://localhost:${localPort}`);

    let child;
    try {
      child = spawnCloudflared(cfBin, args);
    } catch (err) {
      console.warn(`[telegram-ui] named tunnel spawn failed: ${err.message}`);
      return resolvePromise(null);
    }

    let resolved = false;
    let output = "";
    // Named tunnels emit "Connection <UUID> registered" when ready
    const readyPattern = /Connection [a-f0-9-]+ registered/;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn("[telegram-ui] named tunnel timed out after 60s");
        resolvePromise(null);
      }
    }, 60_000);

    function parseOutput(chunk) {
      output += chunk;
      if (readyPattern.test(output) && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        tunnelUrl = publicUrl;
        tunnelProcess = child;
        _notifyTunnelChange(publicUrl);
        console.log(`[telegram-ui] named tunnel active: ${publicUrl || tunnelName}`);
        resolvePromise(publicUrl);
      }
    }

    child.stdout.on("data", (d) => parseOutput(d.toString()));
    child.stderr.on("data", (d) => parseOutput(d.toString()));

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.warn(`[telegram-ui] named tunnel failed: ${err.message}`);
        resolvePromise(null);
      }
    });

    child.on("exit", (code) => {
      tunnelProcess = null;
      tunnelUrl = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.warn(`[telegram-ui] named tunnel exited with code ${code}`);
        resolvePromise(null);
      } else if (code !== 0 && code !== null) {
        console.warn(`[telegram-ui] named tunnel exited (code ${code})`);
      }
    });
  });
}

/**
 * Start a cloudflared **quick tunnel** (random *.trycloudflare.com URL).
 * Quick tunnels are free, require no account, but the URL changes on each restart.
 */
async function startQuickTunnel(cfBin, localPort) {
  return new Promise((resolvePromise) => {
    const localUrl = `https://localhost:${localPort}`;
    const args = ["tunnel", "--url", localUrl, "--no-autoupdate", "--no-tls-verify"];
    console.log(`[telegram-ui] starting quick tunnel → ${localUrl}`);

    let child;
    try {
      child = spawnCloudflared(cfBin, args);
    } catch (err) {
      console.warn(`[telegram-ui] quick tunnel spawn failed: ${err.message}`);
      return resolvePromise(null);
    }

    let resolved = false;
    let output = "";
    const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        console.warn("[telegram-ui] quick tunnel timed out after 30s");
        resolvePromise(null);
      }
    }, 30_000);

    function parseOutput(chunk) {
      output += chunk;
      const match = output.match(urlPattern);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        tunnelUrl = match[0];
        tunnelProcess = child;
        _notifyTunnelChange(match[0]);
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
        console.warn(`[telegram-ui] quick tunnel failed: ${err.message}`);
        resolvePromise(null);
      }
    });

    child.on("exit", (code) => {
      tunnelProcess = null;
      tunnelUrl = null;
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        console.warn(`[telegram-ui] quick tunnel exited with code ${code}`);
        resolvePromise(null);
      } else if (code !== 0 && code !== null) {
        console.warn(`[telegram-ui] quick tunnel exited (code ${code})`);
      }
    });
  });
}

/** Stop the tunnel if running. */
export function stopTunnel() {
  if (tunnelProcess) {
    try {
      tunnelProcess.kill("SIGTERM");
    } catch { /* ignore */ }
    tunnelProcess = null;
    tunnelUrl = null;
  }
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

function jsonResponse(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
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
      return true;
    }
  }
  // Cookie
  const cookieVal = parseCookie(req, "ve_session");
  if (cookieVal) {
    const provided = Buffer.from(cookieVal);
    const expected = Buffer.from(sessionToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

function requireAuth(req) {
  if (isAllowUnsafe()) return true;
  // Session token (browser access)
  if (checkSessionToken(req)) return true;
  // Telegram initData HMAC
  const initData =
    req.headers["x-telegram-initdata"] ||
    req.headers["x-telegram-init-data"] ||
    req.headers["x-telegram-init"] ||
    req.headers["x-telegram-webapp"] ||
    req.headers["x-telegram-webapp-data"] ||
    "";
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!initData) return false;
  return validateInitData(String(initData), token);
}

function requireWsAuth(req, url) {
  if (isAllowUnsafe()) return true;
  // Session token (query param or cookie)
  if (checkSessionToken(req)) return true;
  if (sessionToken) {
    const qTokenVal = url.searchParams.get("token") || "";
    if (qTokenVal) {
      const provided = Buffer.from(qTokenVal);
      const expected = Buffer.from(sessionToken);
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
    }
  }
  // Telegram initData HMAC
  const initData =
    req.headers["x-telegram-initdata"] ||
    req.headers["x-telegram-init-data"] ||
    req.headers["x-telegram-init"] ||
    url.searchParams.get("initData") ||
    "";
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!initData) return false;
  return validateInitData(String(initData), token);
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
  const required = new Set(["sessions", "chat"]);
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

async function resolvePreferredSystemLogPath() {
  const rootLogEntries = await listDirFilesWithMtime(
    logsDir,
    (name) => name.endsWith(".log"),
  );
  const nonDaemonEntries = rootLogEntries.filter((entry) => entry.name !== "daemon.log");

  const monitorPromptEntries = await listDirFilesWithMtime(
    monitorMonitorLogsDir,
    (name) =>
      name.startsWith("monitor-monitor-") &&
      (name.endsWith(".prompt.md") || name.endsWith(".md")),
  );

  const preferredEntries = [...nonDaemonEntries, ...monitorPromptEntries].sort(
    (a, b) => b.mtimeMs - a.mtimeMs,
  );
  if (preferredEntries.length > 0) return preferredEntries[0].path;

  const daemonEntry = rootLogEntries.find((entry) => entry.name === "daemon.log");
  return daemonEntry ? daemonEntry.path : null;
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
    const agentLogsDir = await resolveAgentLogsDir();
    const files = await readdir(agentLogsDir).catch(() => []);
    let candidates = files.filter((f) => f.endsWith(".log")).sort().reverse();
    if (query) {
      const q = query.toLowerCase();
      const filtered = candidates.filter((f) => f.toLowerCase().includes(q));
      if (filtered.length) candidates = filtered;
    }
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
  try {
    const raw = await readFile(statusPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function runGit(args, timeoutMs = 10000) {
  return execSync(`git ${args}`, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
  }).trim();
}

async function readJsonBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
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

async function getLatestLogTail(lineCount) {
  const logPath = await resolvePreferredSystemLogPath();
  if (!logPath) return { file: null, lines: [] };
  const tail = await tailFile(logPath, lineCount);
  return { file: basename(logPath), lines: tail.lines || [] };
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

async function readJsonlTail(filePath, maxLines = 2000) {
  if (!existsSync(filePath)) return [];
  const tail = await tailFile(filePath, maxLines);
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

function withinDays(entry, days) {
  if (!days) return true;
  const ts = Date.parse(entry?.timestamp || "");
  if (!Number.isFinite(ts)) return true;
  return ts >= Date.now() - days * 24 * 60 * 60 * 1000;
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

function resolveAgentWorkLogDir() {
  const candidates = [
    resolve(repoRoot, ".cache", "agent-work-logs"),
    // Legacy path used by older task-executor builds.
    resolve(repoRoot, "..", "..", ".cache", "agent-work-logs"),
    resolve(repoRoot, "..", ".cache", "agent-work-logs"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

async function listAgentLogFiles(query = "", limit = 60) {
  const entries = [];
  const agentLogsDir = await resolveAgentLogsDir();
  const files = await readdir(agentLogsDir).catch(() => []);
  for (const name of files) {
    if (!name.endsWith(".log")) continue;
    if (query && !name.toLowerCase().includes(query.toLowerCase())) continue;
    try {
      const info = await stat(resolve(agentLogsDir, name));
      entries.push({
        name,
        source: agentLogsDir,
        size: info.size,
        mtime:
          info.mtime?.toISOString?.() || new Date(info.mtime).toISOString(),
        mtimeMs: info.mtimeMs,
      });
    } catch {
      // ignore
    }
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return entries.slice(0, limit);
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
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,X-Telegram-InitData",
    });
    res.end();
    return;
  }

  if (!requireAuth(req)) {
    jsonResponse(res, 401, {
      ok: false,
      error: "Unauthorized. Telegram init data missing or invalid.",
    });
    return;
  }

  if (req.method === "POST" && !checkRateLimit(req, 30)) {
    jsonResponse(res, 429, { ok: false, error: "Rate limit exceeded. Try again later." });
    return;
  }

  const path = url.pathname;
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

  if (path === "/api/tasks") {
    const status = url.searchParams.get("status") || "";
    const projectId = url.searchParams.get("project") || "";
    const workspaceFilter = (url.searchParams.get("workspace") || "").trim().toLowerCase();
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
        const taskWorkspace = String(
          task.workspace || task.meta?.workspace || "",
        ).trim().toLowerCase();
        const taskRepository = String(
          task.repository || task.meta?.repository || "",
        ).trim().toLowerCase();
        if (workspaceFilter && taskWorkspace !== workspaceFilter) {
          return false;
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
      const start = page * pageSize;
      const slice = filtered.slice(start, start + pageSize);
      const enriched = await applySharedStateToTasks(slice);
      jsonResponse(res, 200, {
        ok: true,
        data: enriched,
        page,
        pageSize,
        total,
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
      if (!taskId) {
        jsonResponse(res, 400, { ok: false, error: "taskId required" });
        return;
      }
      const adapter = getKanbanAdapter();
      const task = await adapter.getTask(taskId);
      const enriched = await applySharedStateToTasks(task ? [task] : []);
      jsonResponse(res, 200, { ok: true, data: enriched[0] || null });
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

  if (path === "/api/tasks/start") {
    try {
      const body = await readJsonBody(req);
      const taskId = body?.taskId || body?.id;
      const sdk = typeof body?.sdk === "string" ? body.sdk.trim() : "";
      const model = typeof body?.model === "string" ? body.model.trim() : "";
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

      const status = executor.getStatus?.() || {};
      const freeSlots =
        (status.maxParallel || 0) - (status.activeSlots || 0);

      if (freeSlots <= 0) {
        jsonResponse(res, 202, {
          ok: true,
          taskId,
          queued: true,
          started: false,
          reason: "No free slots",
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

      try {
        if (typeof adapter.updateTaskStatus === "function") {
          await adapter.updateTaskStatus(taskId, "inprogress");
        } else if (typeof adapter.updateTask === "function") {
          await adapter.updateTask(taskId, { status: "inprogress" });
        }
      } catch (err) {
        console.warn(
          `[telegram-ui] failed to mark task ${taskId} inprogress: ${err.message}`,
        );
      }
      const wasPaused = executor.isPaused?.();
      executor.executeTask(task, {
        ...(sdk ? { sdk } : {}),
        ...(model ? { model } : {}),
        force: true,
      }).catch((error) => {
        console.warn(
          `[telegram-ui] failed to execute task ${taskId}: ${error.message}`,
        );
      });
      jsonResponse(res, 200, {
        ok: true,
        taskId,
        queued: false,
        started: true,
        wasPaused,
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
      const adapter = getKanbanAdapter();
      const tagsProvided = body && Object.prototype.hasOwnProperty.call(body, "tags");
      const tags = tagsProvided ? normalizeTagsInput(body?.tags) : undefined;
      const draftProvided = body && Object.prototype.hasOwnProperty.call(body, "draft");
      const baseBranchProvided =
        body &&
        (Object.prototype.hasOwnProperty.call(body, "baseBranch") ||
          Object.prototype.hasOwnProperty.call(body, "base_branch"));
      const baseBranch = baseBranchProvided
        ? normalizeBranchInput(body?.baseBranch ?? body?.base_branch)
        : undefined;
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
        ...(baseBranchProvided ? { baseBranch } : {}),
      };
      const hasPatch = Object.values(patch).some(
        (value) => typeof value === "string" && value.trim(),
      );
      const hasTags = Array.isArray(patch.tags);
      const hasDraft = typeof patch.draft === "boolean";
      const hasBaseBranch = baseBranchProvided;
      const hasWorkspace = typeof patch.workspace === "string";
      const hasRepository = typeof patch.repository === "string";
      const hasRepositories = Array.isArray(patch.repositories);
      if (!hasPatch && !hasTags && !hasDraft && !hasBaseBranch && !hasWorkspace && !hasRepository && !hasRepositories) {
        jsonResponse(res, 400, {
          ok: false,
          error: "No update fields provided",
        });
        return;
      }
      const updated =
        typeof adapter.updateTask === "function"
          ? await adapter.updateTask(taskId, patch)
          : await adapter.updateTaskStatus(taskId, patch.status);
      jsonResponse(res, 200, { ok: true, data: updated });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-updated",
        taskId,
        status: updated?.status || patch.status || null,
      });
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
      const adapter = getKanbanAdapter();
      const tagsProvided = body && Object.prototype.hasOwnProperty.call(body, "tags");
      const tags = tagsProvided ? normalizeTagsInput(body?.tags) : undefined;
      const draftProvided = body && Object.prototype.hasOwnProperty.call(body, "draft");
      const baseBranchProvided =
        body &&
        (Object.prototype.hasOwnProperty.call(body, "baseBranch") ||
          Object.prototype.hasOwnProperty.call(body, "base_branch"));
      const baseBranch = baseBranchProvided
        ? normalizeBranchInput(body?.baseBranch ?? body?.base_branch)
        : undefined;
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
        ...(baseBranchProvided ? { baseBranch } : {}),
      };
      const hasPatch = Object.values(patch).some(
        (value) => typeof value === "string" && value.trim(),
      );
      const hasTags = Array.isArray(patch.tags);
      const hasDraft = typeof patch.draft === "boolean";
      const hasBaseBranch = baseBranchProvided;
      const hasWorkspace = typeof patch.workspace === "string";
      const hasRepository = typeof patch.repository === "string";
      const hasRepositories = Array.isArray(patch.repositories);
      if (!hasPatch && !hasTags && !hasDraft && !hasBaseBranch && !hasWorkspace && !hasRepository && !hasRepositories) {
        jsonResponse(res, 400, {
          ok: false,
          error: "No edit fields provided",
        });
        return;
      }
      const updated =
        typeof adapter.updateTask === "function"
          ? await adapter.updateTask(taskId, patch)
          : await adapter.updateTaskStatus(taskId, patch.status);
      jsonResponse(res, 200, { ok: true, data: updated });
      broadcastUiEvent(["tasks", "overview"], "invalidate", {
        reason: "task-edited",
        taskId,
        status: updated?.status || patch.status || null,
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
      const taskData = {
        title: String(title).trim(),
        description: body?.description || "",
        status: body?.status || (wantsDraft ? "draft" : "todo"),
        priority: body?.priority || undefined,
        ...(workspace ? { workspace } : {}),
        ...(repository ? { repository } : {}),
        ...(repositories.length ? { repositories } : {}),
        ...(tags.length ? { tags } : {}),
        ...(tags.length ? { labels: tags } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        meta: {
          ...(workspace ? { workspace } : {}),
          ...(repository ? { repository } : {}),
          ...(repositories.length ? { repositories } : {}),
          ...(tags.length ? { tags } : {}),
          ...(wantsDraft ? { draft: true } : {}),
          ...(baseBranch ? { base_branch: baseBranch, baseBranch } : {}),
        },
      };
      const created = await adapter.createTask(projectId, taskData);
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
      ensureLibraryInitialized();
      const typeRaw = (url.searchParams.get("type") || "").trim();
      const search = (url.searchParams.get("search") || "").trim();
      const type = typeRaw && typeRaw !== "all" ? typeRaw : "";
      const data = listEntries(repoRoot, {
        type: type || undefined,
        search: search || undefined,
      });
      jsonResponse(res, 200, { ok: true, data });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/entry") {
    try {
      ensureLibraryInitialized();
      if (req.method === "GET") {
        const id = (url.searchParams.get("id") || "").trim();
        if (!id) {
          jsonResponse(res, 400, { ok: false, error: "id required" });
          return;
        }
        const entry = getEntry(repoRoot, id);
        if (!entry) {
          jsonResponse(res, 404, { ok: false, error: "not found" });
          return;
        }
        const content = getEntryContent(repoRoot, entry);
        jsonResponse(res, 200, { ok: true, data: { ...entry, content } });
        return;
      }

      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const { content, ...entryData } = body || {};
        const entry = upsertEntry(repoRoot, entryData, content);
        jsonResponse(res, 200, { ok: true, data: entry });
        return;
      }

      if (req.method === "DELETE") {
        const body = await readJsonBody(req);
        const id = body?.id;
        if (!id) {
          jsonResponse(res, 400, { ok: false, error: "id required" });
          return;
        }
        const deleted = deleteEntry(repoRoot, id, { deleteFile: Boolean(body?.deleteFile) });
        if (!deleted) {
          jsonResponse(res, 404, { ok: false, error: "not found" });
          return;
        }
        jsonResponse(res, 200, { ok: true });
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
      ensureLibraryInitialized();
      const result = detectScopes(repoRoot);
      jsonResponse(res, 200, { ok: true, data: result?.scopes || [] });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/init" && req.method === "POST") {
    try {
      const result = initLibrary(repoRoot);
      const entriesCount = result?.manifest?.entries?.length ?? 0;
      const scaffoldedCount = result?.scaffolded?.written?.length ?? 0;
      jsonResponse(res, 200, {
        ok: true,
        data: { entries: entriesCount, scaffolded: scaffoldedCount },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/rebuild" && req.method === "POST") {
    try {
      const result = rebuildManifest(repoRoot);
      jsonResponse(res, 200, {
        ok: true,
        data: {
          count: result?.entries?.length ?? 0,
          added: result?.added ?? 0,
          removed: result?.removed ?? 0,
        },
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/library/match-profile") {
    try {
      ensureLibraryInitialized();
      const title = (url.searchParams.get("title") || "").trim();
      const match = matchAgentProfile(repoRoot, title);
      jsonResponse(res, 200, { ok: true, data: match || null });
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
        const wsId = body?.workspaceId || body?.id;
        if (!wsId) {
          jsonResponse(res, 400, { ok: false, error: "workspaceId required" });
          return;
        }
        setActiveManagedWorkspace(configDir, wsId);
        jsonResponse(res, 200, { ok: true, activeId: wsId });
        broadcastUiEvent(["workspaces", "tasks", "overview"], "invalidate", {
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
      const { runWorkspaceHealthCheck } = await import("./config-doctor.mjs");
      const configDir = resolveUiConfigDir();
      const result = runWorkspaceHealthCheck({ configDir });
      jsonResponse(res, 200, { ok: result.ok, data: result });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/worktrees") {
    try {
      const worktrees = listActiveWorktrees(repoRoot);
      const stats = await getWorktreeStats(repoRoot);
      jsonResponse(res, 200, { ok: true, data: worktrees, stats });
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
      const metrics = await readJsonlTail(metricsPath, 3000);
      const summary = summarizeTelemetry(metrics, days);
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
      const data = {
        executor: {
          mode: uiDeps.getExecutorMode?.() || "internal",
          maxParallel: status.maxParallel || 0,
          activeSlots: status.activeSlots || 0,
          paused: executor?.isPaused?.() || false,
        },
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
      const tail = await tailFile(filePath, lines);
      jsonResponse(res, 200, { ok: true, data: { file: fileName, content: tail } });
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

  // Use module-scope getWorkflowEngineModule() for cross-request caching.
  const getWorkflowEngine = getWorkflowEngineModule;

  if (path === "/api/workflows") {
    try {
      const wfMod = await getWorkflowEngine();
      if (!wfMod) { jsonResponse(res, 503, { ok: false, error: "Workflow engine not available" }); return; }
      const engine = wfMod.getWorkflowEngine();
      const all = engine.list();
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
      const wfMod = await getWorkflowEngine();
      if (!wfMod) { jsonResponse(res, 503, { ok: false, error: "Workflow engine not available" }); return; }
      const engine = wfMod.getWorkflowEngine();
      const saved = await engine.save(body);
      jsonResponse(res, 200, { ok: true, workflow: saved });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/templates") {
    try {
      const wfMod = await getWorkflowEngine();
      if (!wfMod) { jsonResponse(res, 503, { ok: false, error: "Workflow engine not available" }); return; }
      const tplMod = _wfTemplates;
      const list = tplMod.listTemplates();
      jsonResponse(res, 200, { ok: true, templates: list });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/install-template") {
    try {
      const body = await readJsonBody(req);
      const wfMod = await getWorkflowEngine();
      if (!wfMod) { jsonResponse(res, 503, { ok: false, error: "Workflow engine not available" }); return; }
      const tplMod = _wfTemplates;
      const engine = wfMod.getWorkflowEngine();
      const wf = await tplMod.installTemplate(body.templateId, engine, body.overrides);
      jsonResponse(res, 200, { ok: true, workflow: wf });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/node-types") {
    try {
      const wfMod = await getWorkflowEngine();
      if (!wfMod) { jsonResponse(res, 503, { ok: false, error: "Workflow engine not available" }); return; }
      const types = wfMod.listNodeTypes();
      jsonResponse(res, 200, { ok: true, nodeTypes: types.map(nt => ({
        type: nt.type,
        category: nt.type.split(".")[0],
        description: nt.description || "",
        schema: nt.schema || {},
      })) });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path === "/api/workflows/runs") {
    try {
      const wfMod = await getWorkflowEngine();
      if (!wfMod) { jsonResponse(res, 503, { ok: false, error: "Workflow engine not available" }); return; }
      const engine = wfMod.getWorkflowEngine();
      const rawLimit = Number(url.searchParams.get("limit"));
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, 500)
        : 200;
      const runs = engine.getRunHistory ? engine.getRunHistory(null, limit) : [];
      jsonResponse(res, 200, { ok: true, runs });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (path.startsWith("/api/workflows/runs/")) {
    try {
      const wfMod = await getWorkflowEngine();
      if (!wfMod) { jsonResponse(res, 503, { ok: false, error: "Workflow engine not available" }); return; }
      const engine = wfMod.getWorkflowEngine();
      const runId = decodeURIComponent(path.replace("/api/workflows/runs/", "")).trim();
      if (!runId) {
        jsonResponse(res, 400, { ok: false, error: "runId is required" });
        return;
      }
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
  if (path.startsWith("/api/workflows/") && !path.startsWith("/api/workflows/save") && !path.startsWith("/api/workflows/templates") && !path.startsWith("/api/workflows/install") && !path.startsWith("/api/workflows/node") && !path.startsWith("/api/workflows/runs")) {
    const segments = path.replace("/api/workflows/", "").split("/");
    const workflowId = segments[0];
    const action = segments[1] || "";

    try {
      const wfMod = await getWorkflowEngine();
      if (!wfMod) { jsonResponse(res, 503, { ok: false, error: "Workflow engine not available" }); return; }
      const engine = wfMod.getWorkflowEngine();

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

      if (action === "runs") {
        const rawLimit = Number(url.searchParams.get("limit"));
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, 500)
          : 200;
        const runs = engine.getRunHistory ? engine.getRunHistory(workflowId, limit) : [];
        jsonResponse(res, 200, { ok: true, runs });
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

  if (path === "/api/config") {
    const regionEnv = (process.env.EXECUTOR_REGIONS || "").trim();
    const regions = regionEnv ? regionEnv.split(",").map((r) => r.trim()).filter(Boolean) : ["auto"];
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));
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

    // Build public URLs from tunnel URL if available, else from request host
    const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
    const proto = uiServerTls || req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const baseUrl = `${proto}://${host}`;

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
      ];
      const cmdBase = command.split(/\s/)[0].toLowerCase();
      if (!ALLOWED_CMD_PREFIXES.some(p => cmdBase === p || cmdBase.startsWith(p + " "))) {
        jsonResponse(res, 400, { ok: false, error: `Command not allowed: ${cmdBase}` });
        return;
      }
      const handler = uiDeps.handleUiCommand;
      if (typeof handler === "function") {
        const result = await handler(command);
        jsonResponse(res, 200, { ok: true, data: result || null, command });
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
        reason: "command-executed",
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
      if (typeof adapter.updateTask === "function") {
        await adapter.updateTask(taskId, { status: "todo" });
      } else if (typeof adapter.updateTaskStatus === "function") {
        await adapter.updateTaskStatus(taskId, "todo");
      }
      executor.executeTask(task).catch((error) => {
        console.warn(
          `[telegram-ui] failed to retry task ${taskId}: ${error.message}`,
        );
      });
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
      const agents = getAvailableAgents();
      const active = getPrimaryAgentSelection();
      const mode = getAgentMode();
      jsonResponse(res, 200, { ok: true, agents, active, mode });
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
      const result = await execSdkCommand(command, args, adapter);
      const parsed = typeof result === "string" ? result : JSON.stringify(result);
      jsonResponse(res, 200, { ok: true, result: parsed, command, adapter: adapter || getPrimaryAgentName() });
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
      let sessions = tracker.listAllSessions();
      const typeFilter = url.searchParams.get("type");
      const statusFilter = url.searchParams.get("status");
      if (typeFilter) sessions = sessions.filter((s) => s.type === typeFilter);
      if (statusFilter) sessions = sessions.filter((s) => s.status === statusFilter);
      jsonResponse(res, 200, { ok: true, sessions });
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
      const tracker = getSessionTracker();
      const session = tracker.createSession({
        id,
        type,
        metadata: {
          prompt: body?.prompt,
          agent: body?.agent || getPrimaryAgentName(),
          mode: body?.mode || getAgentMode(),
          model: body?.model || undefined,
        },
      });
      jsonResponse(res, 200, { ok: true, session: { id: session.id, type: session.type, status: session.status, metadata: session.metadata } });
      broadcastUiEvent(["sessions"], "invalidate", { reason: "session-created", sessionId: id });
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

    if (!action && req.method === "GET") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionMessages(sessionId);
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        jsonResponse(res, 200, { ok: true, session });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "attachments" && req.method === "POST") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
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

    if (action === "message" && req.method === "POST") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        if (session.status === "paused" || session.status === "archived") {
          jsonResponse(res, 400, { ok: false, error: `Session is ${session.status}` });
          return;
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

        // Forward to primary agent if applicable (exec records user + assistant events)
        const exec = session.type === "primary" ? uiDeps.execPrimaryPrompt : null;
        if (exec) {
          // Don't record user event here — execPrimaryPrompt records it
          // Respond immediately so the UI doesn't block on agent execution
          jsonResponse(res, 200, { ok: true, messageId });
          broadcastUiEvent(["sessions"], "invalidate", { reason: "session-message", sessionId });
          // Fire-and-forget: run agent asynchronously so the request handler
          // doesn't block and the agent doesn't appear "busy" to subsequent
          // messages from chat, telegram, portal, or any other source.
          exec(messageContent, {
            sessionId,
            sessionType: "primary",
            mode: messageMode,
            model: messageModel,
            attachments,
            attachmentsAppended,
          }).then(() => {
            broadcastUiEvent(["sessions"], "invalidate", { reason: "agent-response", sessionId });
          }).catch((execErr) => {
            // Record error as system message so user sees feedback
            tracker.recordEvent(sessionId, {
              role: "system",
              type: "error",
              content: `Agent error: ${execErr.message || "Unknown error"}`,
              timestamp: new Date().toISOString(),
            });
            broadcastUiEvent(["sessions"], "invalidate", { reason: "agent-error", sessionId });
          });
        } else {
          // No agent — record user event and acknowledge
          tracker.recordEvent(sessionId, {
            role: "user",
            content: messageContent,
            attachments,
            timestamp: new Date().toISOString(),
          });
          jsonResponse(res, 200, { ok: true, messageId });
          broadcastUiEvent(["sessions"], "invalidate", { reason: "session-message", sessionId });
        }
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "archive" && req.method === "POST") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
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
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "resume" && req.method === "POST") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
        if (!session) {
          jsonResponse(res, 404, { ok: false, error: "Session not found" });
          return;
        }
        tracker.updateSessionStatus(sessionId, "active");
        jsonResponse(res, 200, { ok: true });
        broadcastUiEvent(["sessions"], "invalidate", { reason: "session-resumed", sessionId });
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "delete" && req.method === "POST") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
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
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "rename" && req.method === "POST") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
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
      } catch (err) {
        jsonResponse(res, 500, { ok: false, error: err.message });
      }
      return;
    }

    if (action === "diff" && req.method === "GET") {
      try {
        const tracker = getSessionTracker();
        const session = tracker.getSessionById(sessionId);
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
        const worktreePath = session.metadata?.worktreePath;
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

  jsonResponse(res, 404, { ok: false, error: "Unknown API endpoint" });
}

async function handleStatic(req, res, url) {
  if (!requireAuth(req)) {
    textResponse(res, 401, "Unauthorized");
    return;
  }

  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = resolve(uiRoot, `.${pathname}`);

  if (!filePath.startsWith(uiRoot)) {
    textResponse(res, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
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

  const rawPort = options.port ?? getDefaultPort();
  const configuredPort = Number(rawPort);
  const isTestRun =
    Boolean(process.env.VITEST) ||
    process.env.NODE_ENV === "test" ||
    Boolean(process.env.JEST_WORKER_ID);
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
  const portSource =
    shouldReusePersistedPort
      ? "cache.ui-last-port"
      : options.port != null
      ? "options.port"
      : process.env.TELEGRAM_UI_PORT
        ? "env.TELEGRAM_UI_PORT"
        : "default(0)";

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

  const autoOpenEnabled = ["1", "true", "yes", "on"].includes(
    String(process.env.BOSUN_UI_AUTO_OPEN_BROWSER || "")
      .trim()
      .toLowerCase(),
  );
  console.log(
    `[telegram-ui] startup config: port=${port} source=${portSource} autoOpen=${autoOpenEnabled ? "enabled" : "disabled"}`,
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
    const webhookPath = getGitHubWebhookPath();

    // Token exchange: ?token=<hex> → set session cookie and redirect to clean URL
    const qToken = url.searchParams.get("token");
    if (qToken && sessionToken) {
      const provided = Buffer.from(qToken);
      const expected = Buffer.from(sessionToken);
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        const secure = uiServerTls ? "; Secure" : "";
        res.writeHead(302, {
          "Set-Cookie": `ve_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`,
          Location: url.pathname || "/",
        });
        res.end();
        return;
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

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    // Vendor files (preact, htm, signals etc.) — served from node_modules, no auth needed
    if (url.pathname.startsWith("/vendor/")) {
      await handleVendor(req, res, url);
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
        const secure = uiServerTls ? "; Secure" : "";
        const cleanUrl = new URL(url.toString());
        cleanUrl.searchParams.delete("tgWebAppData");
        cleanUrl.searchParams.delete("initData");
        const redirectPath =
          cleanUrl.pathname + (cleanUrl.searchParams.toString() ? `?${cleanUrl.searchParams.toString()}` : "");
        res.writeHead(302, {
          "Set-Cookie": `ve_session=${sessionToken}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure}`,
          Location: redirectPath || "/",
        });
        res.end();
        return;
      }
    }
    await handleStatic(req, res, url);
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
    wsServer.on("connection", (socket) => {
      socket.__channels = new Set(["*"]);
      socket.__lastPong = Date.now();
      socket.__lastPing = null;
      socket.__missedPongs = 0;
      wsClients.add(socket);
      sendWsMessage(socket, {
        type: "hello",
        channels: ["*"],
        payload: { connected: true },
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
      if (!requireWsAuth(req, url)) {
        try {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        } catch {
          // no-op
        }
        socket.destroy();
        return;
      }
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit("connection", ws, req);
      });
    });

    // Reuse a recent session token when possible so browser sessions survive restarts.
    ensureSessionToken();

    await new Promise((resolveReady, rejectReady) => {
      uiServer.once("error", rejectReady);
      uiServer.listen(port, options.host || DEFAULT_HOST, () => {
        resolveReady();
      });
    });
  } catch (err) {
    releaseUiInstanceLock();
    throw err;
  }

  const publicHost = options.publicHost || process.env.TELEGRAM_UI_PUBLIC_HOST;
  const lanIp = getLocalLanIp();
  const host = publicHost || lanIp;
  const actualPort = uiServer.address().port;
  const protocol = uiServerTls
    ? "https"
    : publicHost &&
        !publicHost.startsWith("192.") &&
        !publicHost.startsWith("10.") &&
        !publicHost.startsWith("172.")
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
    const tunnelMode = (process.env.TELEGRAM_UI_TUNNEL || "auto").toLowerCase();
    const tunnelActive = tunnelMode !== "disabled" && tunnelMode !== "off" && tunnelMode !== "0";
    const border = "═".repeat(68);
    console.warn(`\n╔${border}╗`);
    console.warn(`║ ⛔  DANGER: TELEGRAM_UI_ALLOW_UNSAFE=true — ALL AUTH IS DISABLED   ║`);
    console.warn(`║                                                                    ║`);
    console.warn(`║  Anyone with your URL can control agents, read secrets, and        ║`);
    console.warn(`║  execute arbitrary commands on this machine.                        ║`);
    if (tunnelActive) {
      console.warn(`║                                                                    ║`);
      console.warn(`║  🔴  TUNNEL IS ACTIVE — your UI is exposed to the PUBLIC INTERNET  ║`);
      console.warn(`║  This means ANYONE can discover your URL and take control.         ║`);
      console.warn(`║  Set TELEGRAM_UI_TUNNEL=disabled or TELEGRAM_UI_ALLOW_UNSAFE=false ║`);
    }
    console.warn(`╚${border}╝\n`);
  }
  console.log(`[telegram-ui] LAN access: ${protocol}://${lanIp}:${actualPort}`);
  console.log(`[telegram-ui] Browser access: ${protocol}://${lanIp}:${actualPort}/?token=${sessionToken}`);

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

  // Check firewall rules for the UI port
  firewallState = await checkFirewall(actualPort);
  if (firewallState) {
    if (firewallState.blocked) {
      console.warn(
        `[telegram-ui] ⚠️  Port ${actualPort}/tcp appears BLOCKED by ${firewallState.firewall} for LAN access.`,
      );
      console.warn(
        `[telegram-ui] To fix, run: ${firewallState.allowCmd}`,
      );
    } else {
      console.log(`[telegram-ui] Firewall (${firewallState.firewall}): port ${actualPort}/tcp is allowed`);
    }
  }

    // Start cloudflared tunnel for trusted TLS (Telegram Mini App requires valid cert)
    const tUrl = await startTunnel(actualPort);
    if (tUrl) {
      console.log(`[telegram-ui] Telegram Mini App URL: ${tUrl}`);
      if (firewallState?.blocked) {
        console.log(
          `[telegram-ui] ℹ️  Tunnel active — Telegram Mini App works regardless of firewall. ` +
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
