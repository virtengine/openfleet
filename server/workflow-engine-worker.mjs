/**
 * workflow-engine-worker.mjs
 *
 * Worker thread that hosts the Bosun workflow engine, completely isolated from
 * the UI server's HTTP / WebSocket event loop.
 *
 * Protocol (parentPort messages):
 *
 * Parent → Worker:
 *   { type: "init",    workerData: { repoRoot, workflowDir, runsDir } }
 *   { type: "call",    callId, method, args }      — proxied engine method call
 *   { type: "svc-res", callId, result?, error? }   — response to a service call
 *
 * Worker → Parent:
 *   { type: "ready" }                              — engine fully initialised
 *   { type: "result",  callId, result }            — successful engine call
 *   { type: "error",   callId, error, stack? }     — failed engine call
 *   { type: "event",   eventName, payload }        — forwarded engine event
 *   { type: "svc-call",callId, method, args }      — request main-thread service
 */

import { parentPort, workerData } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = workerData?.repoRoot || resolve(__dirname, "..");

// ── Pending service calls (worker awaiting main-thread response) ──────────────
const pendingSvcCalls = new Map();

function sanitiseServiceArgs(value, depth = 0, seen = new WeakSet()) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "function") return undefined;
  if (typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((entry) => sanitiseServiceArgs(entry, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    const next = sanitiseServiceArgs(entry, depth + 1, seen);
    if (next !== undefined) out[key] = next;
  }
  seen.delete(value);
  return out;
}

function callMainService(method, args) {
  return new Promise((resolve, reject) => {
    const callId = randomUUID();
    pendingSvcCalls.set(callId, { resolve, reject });
    parentPort.postMessage({
      type: "svc-call",
      callId,
      method,
      args: sanitiseServiceArgs(args),
    });
  });
}

// ── Load workflow modules ──────────────────────────────────────────────────────
let engine = null;

async function initEngine(cfg = {}) {
  const base = pathToFileURL(repoRoot + "/").href;

  const [wfEngineMod, wfNodesMod, wfTemplatesMod] = await Promise.all([
    import(new URL("./workflow/workflow-engine.mjs", base).href),
    import(new URL("./workflow/workflow-nodes.mjs",  base).href),
    import(new URL("./workflow/workflow-templates.mjs", base).href),
  ]);

  if (typeof wfNodesMod?.ensureWorkflowNodeTypesLoaded === "function") {
    await wfNodesMod.ensureWorkflowNodeTypesLoaded({ repoRoot });
  }

  // ── Build proxied service bundle ──────────────────────────────────────────
  const telegram = {
    async sendMessage(chatId, text, opts = {}) {
      return callMainService("telegram.sendMessage", [chatId, text, opts]);
    },
  };

  const agentPool = {
    async launchEphemeralThread(prompt, cwd, timeout, opts) {
      return callMainService("agentPool.launchEphemeralThread", [prompt, cwd, timeout, opts]);
    },
    async launchOrResumeThread(prompt, cwd, timeout, opts) {
      return callMainService("agentPool.launchOrResumeThread", [prompt, cwd, timeout, opts]);
    },
    async execWithRetry(prompt, opts) {
      return callMainService("agentPool.execWithRetry", [prompt, opts]);
    },
    async continueSession(sessionId, prompt, opts) {
      return callMainService("agentPool.continueSession", [sessionId, prompt, opts]);
    },
    async killSession(sessionId) {
      return callMainService("agentPool.killSession", [sessionId]);
    },
  };

  const kanban = {
    async createTask(projectIdOrData, taskData) {
      return callMainService("kanban.createTask", [projectIdOrData, taskData]);
    },
    async updateTaskStatus(taskId, status, opts) {
      return callMainService("kanban.updateTaskStatus", [taskId, status, opts]);
    },
    async listTasks(projectId, filters) {
      return callMainService("kanban.listTasks", [projectId, filters]);
    },
    async getTask(taskId) {
      return callMainService("kanban.getTask", [taskId]);
    },
  };

  const meeting = {
    async schedule(...args) { return callMainService("meeting.schedule", args); },
    async cancel(...args)   { return callMainService("meeting.cancel",   args); },
    async get(...args)      { return callMainService("meeting.get",      args); },
  };

  const services = { telegram, agentPool, kanban, meeting };

  // ── Create engine ─────────────────────────────────────────────────────────
  engine = wfEngineMod.getWorkflowEngine({
    workflowDir: cfg.workflowDir,
    runsDir:     cfg.runsDir,
    services,
  });

  // ── Forward engine events to main thread ──────────────────────────────────
  const FORWARDED_EVENTS = [
    "run:start", "run:end", "run:error", "run:cancel:requested",
    "node:start", "node:complete", "node:error", "node:skip",
    "edge:flow",
  ];
  for (const eventName of FORWARDED_EVENTS) {
    engine.on(eventName, (payload) => {
      try {
        parentPort.postMessage({ type: "event", eventName, payload: sanitise(payload) });
      } catch { /* best-effort */ }
    });
  }

  // ── Install recommended templates ─────────────────────────────────────────
  if (typeof wfTemplatesMod?.installRecommendedWorkflowTemplates === "function") {
    try {
      await wfTemplatesMod.installRecommendedWorkflowTemplates(engine);
    } catch { /* non-fatal */ }
  }

  // ── Resume interrupted runs ────────────────────────────────────────────────
  if (typeof engine.resumeInterruptedRuns === "function") {
    setTimeout(() => engine.resumeInterruptedRuns().catch(() => {}), 0);
  }
}

// ── Serialize engine return values for structured clone ────────────────────────
function sanitise(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "function") return "[Function]";
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => sanitise(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith("_") && depth > 0) continue;
    out[k] = sanitise(v, depth + 1);
  }
  return out;
}

// ── Engine method dispatcher ──────────────────────────────────────────────────
async function dispatch(method, args) {
  if (!engine) throw new Error("Workflow engine not yet initialised");
  switch (method) {
    case "execute": {
      const [workflowId, input, opts] = args;
      const ctx = await engine.execute(workflowId, input, opts);
      /* Return only the fields the main thread needs to avoid serialisation issues */
      return {
        id:         ctx?.id,
        workflowId: ctx?.workflowId,
        status:     ctx?.status,
        errors:     ctx?.errors || [],
        data:       sanitise(ctx?.data),
      };
    }
    case "evaluateTriggers":
      return engine.evaluateTriggers(...args);
    case "get":
      return sanitise(engine.get(...args));
    case "list":
      return sanitise(engine.list(...args));
    case "getRunHistory":
      return sanitise(await engine.getRunHistory?.(...args));
    case "getRunHistoryPage":
      return sanitise(await engine.getRunHistoryPage?.(...args));
    case "getRunDetail":
      return sanitise(await engine.getRunDetail?.(...args));
    case "getRunForensics":
      return sanitise(await engine.getRunForensics?.(...args));
    case "getNodeForensics":
      return sanitise(await engine.getNodeForensics?.(...args));
    case "getRetryOptions":
      return sanitise(await engine.getRetryOptions?.(...args));
    case "retryRun": {
      const retryResult = await engine.retryRun(...args);
      return sanitise({
        retryRunId: retryResult?.retryRunId || retryResult?.ctx?.id || null,
        originalRunId: retryResult?.originalRunId || null,
        mode: retryResult?.mode || null,
        ctx: retryResult?.ctx
          ? {
              id: retryResult.ctx.id,
              workflowId: retryResult.ctx.workflowId,
              status: retryResult.ctx.status,
              errors: retryResult.ctx.errors || [],
              data: sanitise(retryResult.ctx.data),
            }
          : null,
      });
    }
    case "restoreFromSnapshot": {
      const ctx = await engine.restoreFromSnapshot?.(...args);
      return { id: ctx?.id, workflowId: ctx?.workflowId, status: ctx?.status, errors: ctx?.errors || [] };
    }
    case "cancelRun":
      return engine.cancelRun?.(...args);
    case "createRunSnapshot":
      return engine.createRunSnapshot?.(...args);
    case "listSnapshots":
      return sanitise(engine.listSnapshots?.(...args));
    case "save":
      return engine.save(...args);
    case "import":
      return sanitise(engine.import(...args));
    case "delete":
      return engine.delete?.(...args);
    case "getConcurrencyStats":
      return sanitise(engine.getConcurrencyStats?.());
    case "getTaskTraceEvents":
      return sanitise(await engine.getTaskTraceEvents?.(...args));
    case "load":
      return engine.load?.();
    case "resumeInterruptedRuns":
      return engine.resumeInterruptedRuns?.();
    case "registerTaskTraceHook":
      /* Hooks cannot cross thread boundaries; silently ignore */
      return null;
    default:
      throw new Error(`Unknown engine method: ${method}`);
  }
}

// ── Message handler ────────────────────────────────────────────────────────────
parentPort.on("message", async (msg) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "init") {
    try {
      await initEngine(msg.workerData || {});
      parentPort.postMessage({ type: "ready" });
    } catch (err) {
      parentPort.postMessage({ type: "error", callId: null, error: err.message, stack: err.stack });
    }
    return;
  }

  if (msg.type === "svc-res") {
    const pending = pendingSvcCalls.get(msg.callId);
    if (pending) {
      pendingSvcCalls.delete(msg.callId);
      if (msg.error) pending.reject(Object.assign(new Error(msg.error), { code: msg.code }));
      else pending.resolve(msg.result);
    }
    return;
  }

  if (msg.type === "call") {
    const { callId, method, args } = msg;
    try {
      const result = await dispatch(method, args || []);
      parentPort.postMessage({ type: "result", callId, result });
    } catch (err) {
      parentPort.postMessage({ type: "error", callId, error: err.message, stack: err.stack });
    }
  }
});
