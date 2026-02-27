/**
 * workflow-engine.mjs — Bosun Workflow Engine
 *
 * A modular, declarative workflow execution engine that replaces hardcoded
 * supervisor logic with composable, user-editable workflow definitions.
 *
 * Workflows are directed acyclic graphs (DAGs) of nodes. Each node has a
 * type (trigger, condition, action, validation, transform) and connects
 * to downstream nodes via edges. The engine evaluates triggers, routes
 * through conditions, executes actions, and validates results.
 *
 * Users define workflows via JSON (or the visual builder UI) — no custom
 * code required. Built-in templates cover common patterns like:
 *   - Task Planner (auto-replenish backlog when tasks run low)
 *   - Frontend Agent (screenshot validation before task completion)
 *   - Review Agent (automated PR review flow)
 *   - Custom agent profiles with validation gates
 *
 * EXPORTS:
 *   WorkflowEngine    — main engine class
 *   loadWorkflows()   — load all workflow definitions from disk
 *   saveWorkflow()    — persist a workflow definition
 *   deleteWorkflow()  — remove a workflow
 *   listWorkflows()   — list all available workflows
 *   getWorkflow()     — get a single workflow by ID
 *   executeWorkflow() — run a workflow by ID with given context
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

// ── Constants ───────────────────────────────────────────────────────────────

const TAG = "[workflow-engine]";
const WORKFLOW_DIR_NAME = "workflows";
const WORKFLOW_RUNS_DIR = "workflow-runs";
function readBoundedEnvInt(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.round(parsed);
  return Math.min(max, Math.max(min, rounded));
}

const MAX_NODE_RETRIES = readBoundedEnvInt("WORKFLOW_NODE_MAX_RETRIES", 3, {
  min: 0,
  max: 20,
});
const NODE_TIMEOUT_MIN_MS = 1000;
const NODE_TIMEOUT_MAX_MS = 21_600_000;
const NODE_TIMEOUT_MS = readBoundedEnvInt("WORKFLOW_NODE_TIMEOUT_MS", 10 * 60 * 1000, {
  min: NODE_TIMEOUT_MIN_MS,
  max: NODE_TIMEOUT_MAX_MS,
});
const MAX_CONCURRENT_BRANCHES = readBoundedEnvInt("WORKFLOW_MAX_CONCURRENT_BRANCHES", 8, {
  min: 1,
  max: 64,
});
const MAX_PERSISTED_RUNS = readBoundedEnvInt("WORKFLOW_MAX_PERSISTED_RUNS", 200, {
  min: 20,
  max: 5000,
});
const DEFAULT_RUN_STUCK_THRESHOLD_MS = readBoundedEnvInt(
  "WORKFLOW_RUN_STUCK_THRESHOLD_MS",
  5 * 60 * 1000,
  { min: 10000, max: 7_200_000 },
);

function resolveNodeTimeoutMs(node, resolvedConfig) {
  const candidates = [
    resolvedConfig?.timeout,
    resolvedConfig?.timeoutMs,
    node?.timeout,
    node?.timeoutMs,
    NODE_TIMEOUT_MS,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return Math.min(
      NODE_TIMEOUT_MAX_MS,
      Math.max(1, Math.round(parsed)),
    );
  }

  return NODE_TIMEOUT_MS;
}

// ── Node Status ─────────────────────────────────────────────────────────────

export const NodeStatus = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  SKIPPED: "skipped",
  WAITING: "waiting",
});

export const WorkflowStatus = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  PAUSED: "paused",
});

// ── Node Type Registry ──────────────────────────────────────────────────────

const _nodeTypeRegistry = new Map();

/**
 * Register a node type handler.
 * @param {string} type - Node type identifier (e.g., "trigger.task_low", "action.run_agent")
 * @param {object} handler - { execute(node, context, engine), validate?(node), describe?() }
 */
export function registerNodeType(type, handler) {
  if (!handler || typeof handler.execute !== "function") {
    throw new Error(`${TAG} Node type "${type}" must have an execute function`);
  }
  _nodeTypeRegistry.set(type, handler);
}

/**
 * Get a registered node type handler.
 * @param {string} type
 * @returns {object|null}
 */
export function getNodeType(type) {
  return _nodeTypeRegistry.get(type) || null;
}

/**
 * List all registered node types with metadata.
 * @returns {Array<{type: string, category: string, description: string}>}
 */
export function listNodeTypes() {
  const result = [];
  for (const [type, handler] of _nodeTypeRegistry) {
    const [category] = type.split(".");
    result.push({
      type,
      category,
      description: handler.describe?.() || type,
      schema: handler.schema || null,
    });
  }
  return result;
}

// ── Workflow Definition Schema ──────────────────────────────────────────────

/**
 * @typedef {object} WorkflowNode
 * @property {string} id - Unique node identifier
 * @property {string} type - Node type from registry (e.g., "trigger.task_low")
 * @property {string} label - Display label
 * @property {object} config - Node-specific configuration
 * @property {object} position - {x, y} canvas position for visual builder
 * @property {string[]} [outputs] - Named output ports (default: ["default"])
 */

/**
 * @typedef {object} WorkflowEdge
 * @property {string} id - Unique edge identifier
 * @property {string} source - Source node ID
 * @property {string} target - Target node ID
 * @property {string} [sourcePort] - Output port name (default: "default")
 * @property {string} [condition] - Optional JS expression for conditional routing
 */

/**
 * @typedef {object} WorkflowDefinition
 * @property {string} id - Unique workflow identifier
 * @property {string} name - Human-readable name
 * @property {string} [description] - What this workflow does
 * @property {string} [category] - Grouping category
 * @property {boolean} [enabled] - Whether this workflow is active
 * @property {string} [trigger] - Primary trigger type
 * @property {WorkflowNode[]} nodes - All nodes in the workflow
 * @property {WorkflowEdge[]} edges - Connections between nodes
 * @property {object} [variables] - Workflow-level variables/defaults
 * @property {object} [metadata] - Version, author, timestamps
 */

// ── Workflow Execution Context ──────────────────────────────────────────────

/**
 * Runtime context passed through workflow execution.
 * Accumulates data from each node's output.
 */
export class WorkflowContext {
  constructor(initialData = {}) {
    this.id = randomUUID();
    this.startedAt = Date.now();
    this.data = { ...initialData };
    this.nodeOutputs = new Map();
    this.nodeStatuses = new Map();
    this.logs = [];
    this.errors = [];
    this.nodeStatusEvents = [];
    this.variables = {};
    this.retryAttempts = new Map();
  }

  /** Get current retry count for a node */
  getRetryCount(nodeId) {
    return this.retryAttempts.get(nodeId) || 0;
  }

  /** Increment and return the new retry count for a node */
  incrementRetry(nodeId) {
    const count = this.getRetryCount(nodeId) + 1;
    this.retryAttempts.set(nodeId, count);
    return count;
  }

  /**
   * Fork this context for sub-execution (e.g. loop iteration).
   * Creates a shallow clone with deep-copied data and fresh node tracking.
   */
  fork(overrides = {}) {
    const forked = new WorkflowContext({ ...this.data, ...overrides });
    forked.id = this.id; // Same run
    forked.startedAt = this.startedAt;
    forked.variables = { ...this.variables };
    // Copy existing node outputs so forked context can reference upstream nodes
    for (const [k, v] of this.nodeOutputs) {
      forked.nodeOutputs.set(k, v);
    }
    return forked;
  }

  /** Set output from a node */
  setNodeOutput(nodeId, output) {
    this.nodeOutputs.set(nodeId, output);
  }

  /** Get output from a previously executed node */
  getNodeOutput(nodeId) {
    return this.nodeOutputs.get(nodeId);
  }

  /** Set node execution status */
  setNodeStatus(nodeId, status) {
    this.nodeStatuses.set(nodeId, status);
    this.nodeStatusEvents.push({ nodeId, status, timestamp: Date.now() });
  }

  /** Get node execution status */
  getNodeStatus(nodeId) {
    return this.nodeStatuses.get(nodeId) || NodeStatus.PENDING;
  }

  /** Add a log entry */
  log(nodeId, message, level = "info") {
    this.logs.push({ nodeId, message, level, timestamp: Date.now() });
  }

  /** Record an error */
  error(nodeId, error) {
    const msg = error instanceof Error ? error.message : String(error);
    this.errors.push({ nodeId, error: msg, timestamp: Date.now() });
    this.log(nodeId, `ERROR: ${msg}`, "error");
  }

  /** Resolve a template string against context data */
  resolve(template) {
    if (typeof template !== "string") return template;
    return template.replace(/\{\{(\w[\w.]*)\}\}/g, (match, path) => {
      const parts = path.split(".");

      // Try context data first
      let value = this.data;
      for (const part of parts) {
        if (value == null) break;
        value = value[part];
      }
      if (value != null) return String(value);

      // Fall back to node outputs (e.g. {{step1.count}} → nodeOutputs["step1"].count)
      const [nodeId, ...rest] = parts;
      const nodeOut = this.nodeOutputs.get(nodeId);
      if (nodeOut != null) {
        let val = nodeOut;
        for (const p of rest) {
          if (val == null) return match;
          val = val[p];
        }
        if (val != null) return String(val);
      }
      return match;
    });
  }

  /** Get a serializable summary of the execution */
  toJSON(endedAt = Date.now()) {
    const finishedAt = Number.isFinite(endedAt) ? endedAt : Date.now();
    return {
      id: this.id,
      startedAt: this.startedAt,
      endedAt: finishedAt,
      duration: Math.max(0, finishedAt - this.startedAt),
      data: this.data,
      nodeOutputs: Object.fromEntries(this.nodeOutputs),
      nodeStatuses: Object.fromEntries(this.nodeStatuses),
      retryAttempts: Object.fromEntries(this.retryAttempts),
      logs: this.logs,
      errors: this.errors,
      nodeStatusEvents: this.nodeStatusEvents,
    };
  }
}

// ── Workflow Engine ─────────────────────────────────────────────────────────

export class WorkflowEngine extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.workflowDir - Directory to store workflow definitions
   * @param {string} [opts.runsDir] - Directory to store execution logs
   * @param {object} [opts.services] - Injected service references (kanban, agent-pool, etc.)
   */
  constructor(opts = {}) {
    super();
    this.workflowDir = opts.workflowDir || resolve(process.cwd(), ".bosun", WORKFLOW_DIR_NAME);
    this.runsDir = opts.runsDir || resolve(process.cwd(), ".bosun", WORKFLOW_RUNS_DIR);
    this.services = opts.services || {};
    this._workflows = new Map();
    this._activeRuns = new Map();
    this._triggerSubscriptions = new Map();
    this._loaded = false;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Load all workflow definitions from disk */
  load() {
    this._ensureDirs();
    this._workflows.clear();
    if (!existsSync(this.workflowDir)) return;

    const files = readdirSync(this.workflowDir).filter(
      (f) => extname(f) === ".json"
    );
    for (const file of files) {
      try {
        const raw = readFileSync(resolve(this.workflowDir, file), "utf8");
        const def = JSON.parse(raw);
        if (def.id) {
          this._workflows.set(def.id, def);
        }
      } catch (err) {
        console.error(`${TAG} Failed to load workflow ${file}:`, err.message);
      }
    }
    this._loaded = true;
    this.emit("loaded", { count: this._workflows.size });
  }

  /** Ensure storage directories exist */
  _ensureDirs() {
    mkdirSync(this.workflowDir, { recursive: true });
    mkdirSync(this.runsDir, { recursive: true });
  }

  // ── CRUD ────────────────────────────────────────────────────────────────

  /** List all workflows */
  list() {
    if (!this._loaded) this.load();
    return Array.from(this._workflows.values()).map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      category: w.category,
      enabled: w.enabled !== false,
      trigger: w.trigger,
      nodeCount: w.nodes?.length || 0,
      edgeCount: w.edges?.length || 0,
      metadata: w.metadata,
    }));
  }

  /** Get a single workflow definition */
  get(id) {
    if (!this._loaded) this.load();
    return this._workflows.get(id) || null;
  }

  /** Save (create or update) a workflow definition */
  save(def) {
    if (!def.id) def.id = randomUUID();
    if (!def.metadata) def.metadata = {};
    def.metadata.updatedAt = new Date().toISOString();
    if (!def.metadata.createdAt) {
      def.metadata.createdAt = def.metadata.updatedAt;
    }
    def.metadata.version = (def.metadata.version || 0) + 1;

    this._ensureDirs();
    this._workflows.set(def.id, def);
    const filePath = resolve(this.workflowDir, `${def.id}.json`);
    writeFileSync(filePath, JSON.stringify(def, null, 2), "utf8");
    this.emit("saved", { id: def.id, name: def.name });
    return def;
  }

  /** Delete a workflow */
  delete(id) {
    this._workflows.delete(id);
    const filePath = resolve(this.workflowDir, `${id}.json`);
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch { /* ignore */ }
    this.emit("deleted", { id });
    return true;
  }

  /** Import a workflow from JSON */
  import(json) {
    const def = typeof json === "string" ? JSON.parse(json) : json;
    def.id = randomUUID(); // Always assign new ID on import
    return this.save(def);
  }

  /** Export a workflow as JSON string */
  export(id) {
    const def = this.get(id);
    if (!def) throw new Error(`Workflow "${id}" not found`);
    return JSON.stringify(def, null, 2);
  }

  // ── Execution ─────────────────────────────────────────────────────────

  /**
   * Execute a workflow with given input data.
   * @param {string} workflowId
   * @param {object} inputData - Initial context data
   * @param {object} [opts] - { dryRun, timeout }
   * @returns {Promise<WorkflowContext>}
   */
  async execute(workflowId, inputData = {}, opts = {}) {
    const def = this.get(workflowId);
    if (!def) throw new Error(`${TAG} Workflow "${workflowId}" not found`);
    if (def.enabled === false && !opts.force) {
      throw new Error(`${TAG} Workflow "${def.name}" is disabled`);
    }

    const ctx = new WorkflowContext({
      ...def.variables,
      ...inputData,
      _workflowId: workflowId,
      _workflowName: def.name,
    });
    ctx.variables = { ...def.variables };

    const runId = ctx.id;
    this._activeRuns.set(runId, {
      workflowId,
      workflowName: def.name,
      ctx,
      startedAt: ctx.startedAt,
      status: WorkflowStatus.RUNNING,
    });
    this.emit("run:start", { runId, workflowId, name: def.name });

    try {
      // Build adjacency map
      const adjacency = this._buildAdjacency(def);

      // Find trigger/entry nodes (nodes with no incoming edges)
      const entryNodes = this._findEntryNodes(def);
      if (entryNodes.length === 0) {
        throw new Error("Workflow has no entry nodes (no triggers or unconnected nodes)");
      }

      // Execute the DAG
      await this._executeDag(def, entryNodes, adjacency, ctx, opts);

      const status = ctx.errors.length > 0 ? WorkflowStatus.FAILED : WorkflowStatus.COMPLETED;
      this._activeRuns.get(runId).status = status;
      this.emit("run:end", { runId, workflowId, status, duration: Date.now() - ctx.startedAt });
    } catch (err) {
      ctx.error("_engine", err);
      this._activeRuns.get(runId).status = WorkflowStatus.FAILED;
      this.emit("run:error", { runId, workflowId, error: err.message });
    }

    // Persist run log
    this._persistRun(runId, workflowId, ctx);
    this._activeRuns.delete(runId);
    return ctx;
  }

  /**
   * Evaluate trigger conditions to see if a workflow should fire.
   * Called by the supervisor loop or event bus.
   */
  async evaluateTriggers(eventType, eventData = {}) {
    if (!this._loaded) this.load();

    const triggered = [];
    for (const [id, def] of this._workflows) {
      if (def.enabled === false) continue;

      // Find trigger nodes
      const triggerNodes = (def.nodes || []).filter((n) =>
        n.type.startsWith("trigger.")
      );
      for (const tNode of triggerNodes) {
        // Event-driven evaluation should only run event-capable trigger types.
        // Polling/manual triggers (schedule, task_low, manual, scheduled_once)
        // are intentionally excluded here.
        if (
          tNode.type !== "trigger.event" &&
          tNode.type !== "trigger.pr_event" &&
          tNode.type !== "trigger.task_assigned" &&
          tNode.type !== "trigger.anomaly" &&
          tNode.type !== "trigger.webhook"
        ) {
          continue;
        }
        if (tNode.type === "trigger.pr_event") {
          const hasPrSignal =
            String(eventType || "").startsWith("pr.") ||
            !!eventData?.prEvent;
          if (!hasPrSignal) continue;
        }
        if (tNode.type === "trigger.task_assigned" && eventType !== "task.assigned") {
          continue;
        }
        if (tNode.type === "trigger.anomaly") {
          const anomalyEvent =
            eventType === "anomaly" ||
            eventType === "agent.anomaly";
          if (!anomalyEvent) continue;
        }
        if (tNode.type === "trigger.webhook" && !String(eventType || "").startsWith("webhook")) {
          continue;
        }

        const handler = getNodeType(tNode.type);
        if (!handler) continue;

        try {
          const shouldFire = await handler.execute(tNode, {
            data: eventData,
            eventType,
          });
          if (shouldFire?.triggered) {
            triggered.push({ workflowId: id, triggeredBy: tNode.id, eventData });
          }
        } catch {
          // Trigger evaluation errors are non-fatal
        }
      }
    }
    return triggered;
  }

  /** Get status of active runs */
  getActiveRuns() {
    return Array.from(this._activeRuns.entries())
      .map(([runId, info]) => this._buildActiveRunSummary(runId, info))
      .filter(Boolean);
  }

  /** Get historical run logs */
  getRunHistory(workflowId, limit = 20) {
    const persisted = this._readRunIndex()
      .map((entry) => this._normalizeRunSummary(entry))
      .filter(Boolean);
    const active = this.getActiveRuns();
    const activeRunIds = new Set(active.map((run) => run.runId));

    let runs = [...active, ...persisted.filter((run) => !activeRunIds.has(run.runId))];
    if (workflowId) runs = runs.filter((r) => r.workflowId === workflowId);
    runs.sort((a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0));
    const normalizedLimit = Number(limit);
    if (Number.isFinite(normalizedLimit) && normalizedLimit > 0) {
      return runs.slice(0, normalizedLimit);
    }
    return runs;
  }

  /** Get full run detail for a specific runId */
  getRunDetail(runId) {
    const normalizedRunId = basename(String(runId || "")).replace(/\.json$/i, "");
    if (!normalizedRunId) return null;

    const activeRun = this._activeRuns.get(normalizedRunId);
    if (activeRun?.ctx) {
      const summary = this._buildActiveRunSummary(normalizedRunId, activeRun);
      if (!summary) return null;
      return {
        ...summary,
        detail: this._serializeRunContext(activeRun.ctx, true),
      };
    }

    const detailPath = resolve(this.runsDir, `${normalizedRunId}.json`);
    if (!existsSync(detailPath)) return null;

    try {
      const detail = JSON.parse(readFileSync(detailPath, "utf8"));
      const summary = this._normalizeRunSummary(
        this._readRunIndex().find((entry) => entry?.runId === normalizedRunId) || null,
      );
      if (summary) {
        const recomputed = this._buildSummaryFromDetail({
          runId: normalizedRunId,
          workflowId: summary.workflowId,
          workflowName: summary.workflowName,
          status: summary.status || WorkflowStatus.COMPLETED,
          detail,
        });
        return { ...summary, ...recomputed, detail };
      }
      const status = Array.isArray(detail?.errors) && detail.errors.length > 0
        ? WorkflowStatus.FAILED
        : WorkflowStatus.COMPLETED;
      const computed = this._buildSummaryFromDetail({
        runId: normalizedRunId,
        workflowId: detail?.data?._workflowId || null,
        workflowName: detail?.data?._workflowName || null,
        status,
        detail,
      });
      return { ...computed, detail };
    } catch {
      return null;
    }
  }

  // ── Internal DAG Execution ────────────────────────────────────────────

  _buildAdjacency(def) {
    const adj = new Map();
    for (const node of def.nodes || []) {
      adj.set(node.id, []);
    }
    for (const edge of def.edges || []) {
      const list = adj.get(edge.source) || [];
      list.push(edge);
      adj.set(edge.source, list);
    }
    return adj;
  }

  _findEntryNodes(def) {
    const hasIncoming = new Set();
    for (const edge of def.edges || []) {
      hasIncoming.add(edge.target);
    }
    return (def.nodes || []).filter((n) => !hasIncoming.has(n.id));
  }

  async _executeDag(def, entryNodes, adjacency, ctx, opts) {
    // BFS execution with respect for dependencies
    const executed = new Set();
    const queue = [...entryNodes.map((n) => n.id)];
    const nodeMap = new Map((def.nodes || []).map((n) => [n.id, n]));

    // Track in-degree for proper scheduling
    const inDegree = new Map();
    for (const node of def.nodes || []) {
      inDegree.set(node.id, 0);
    }
    for (const edge of def.edges || []) {
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }

    // Ready set = nodes with all dependencies met
    const ready = new Set(queue);

    while (ready.size > 0) {
      // Execute ready nodes in bounded parallel batches.
      const pendingReady = Array.from(ready);
      const batch = pendingReady.slice(0, MAX_CONCURRENT_BRANCHES);
      ready.clear();
      for (const deferredNodeId of pendingReady.slice(MAX_CONCURRENT_BRANCHES)) {
        ready.add(deferredNodeId);
      }

      const results = await Promise.allSettled(
        batch.map(async (nodeId) => {
          if (executed.has(nodeId)) return;
          const node = nodeMap.get(nodeId);
          if (!node) return;

          ctx.setNodeStatus(nodeId, NodeStatus.RUNNING);
          this.emit("node:start", { nodeId, type: node.type, label: node.label });

          // Retry loop — uses per-node maxRetries/retryDelayMs with global fallbacks.
          const resolvedMaxRetriesRaw =
            node.config?.maxRetries !== undefined
              ? Number(ctx.resolve(node.config.maxRetries))
              : MAX_NODE_RETRIES;
          const maxRetries = node.config?.retryable === false
            ? 0
            : Number.isFinite(resolvedMaxRetriesRaw)
              ? Math.max(0, Math.trunc(resolvedMaxRetriesRaw))
              : MAX_NODE_RETRIES;
          const resolvedRetryDelayRaw =
            node.config?.retryDelayMs !== undefined
              ? Number(ctx.resolve(node.config.retryDelayMs))
              : 1000;
          const baseRetryDelay = Number.isFinite(resolvedRetryDelayRaw)
            ? Math.max(0, Math.trunc(resolvedRetryDelayRaw))
            : 1000;
          let lastErr;

          for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
              if (attempt > 0) {
                ctx.incrementRetry(nodeId);
                const backoffMs = Math.min(baseRetryDelay * Math.pow(2, attempt - 1), 30000);
                ctx.log(nodeId, `Retry ${attempt}/${maxRetries} after ${backoffMs}ms`, "warn");
                this.emit("node:retry", { nodeId, attempt, maxRetries, backoffMs });
                await new Promise((r) => setTimeout(r, backoffMs));
                ctx.setNodeStatus(nodeId, NodeStatus.RUNNING);
              }
              const result = await this._executeNode(node, ctx, opts);
              ctx.setNodeOutput(nodeId, result);
              ctx.setNodeStatus(nodeId, NodeStatus.COMPLETED);
              executed.add(nodeId);
              this.emit("node:complete", { nodeId, type: node.type });
              lastErr = null;
              return { nodeId, result };
            } catch (err) {
              lastErr = err;
            }
          }

          // All retries exhausted
          ctx.error(nodeId, lastErr);
          ctx.setNodeStatus(nodeId, NodeStatus.FAILED);
          executed.add(nodeId);
          this.emit("node:error", { nodeId, error: lastErr.message, retries: ctx.getRetryCount(nodeId) });

          // Check if node has error handling config
          if (node.config?.continueOnError) {
            ctx.setNodeOutput(nodeId, { error: lastErr.message, _failed: true });
            return { nodeId, result: null, error: lastErr.message };
          }
          throw lastErr; // Propagate to stop workflow
        })
      );

      // Check for hard failures (non-continueOnError)
      for (const r of results) {
        if (r.status === "rejected") {
          // If any node fails hard, mark remaining as skipped
          for (const [nid] of nodeMap) {
            if (!executed.has(nid)) {
              ctx.setNodeStatus(nid, NodeStatus.SKIPPED);
            }
          }
          return;
        }
      }

      // Find newly ready nodes (all incoming edges satisfied)
      for (const nodeId of batch) {
        const node = nodeMap.get(nodeId);
        const edges = adjacency.get(nodeId) || [];
        const sourceOutput = ctx.getNodeOutput(nodeId);
        const selectedPortRaw =
          sourceOutput?.matchedPort ??
          sourceOutput?.port ??
          null;
        const selectedPort =
          typeof selectedPortRaw === "string" && selectedPortRaw.trim()
            ? selectedPortRaw.trim()
            : null;

        // Handle loop.for_each: iterate downstream subgraph per item
        if (node?.type === "loop.for_each" && ctx.getNodeStatus(nodeId) === NodeStatus.COMPLETED) {
          const loopOutput = ctx.getNodeOutput(nodeId);
          const items = loopOutput?.items || [];
          const varName = loopOutput?.variable || "item";

          if (items.length > 0) {
            // Collect direct downstream target IDs from this loop node
            const downstreamIds = edges.map((e) => e.target);
            const iterationResults = [];

            for (let i = 0; i < items.length; i++) {
              const item = items[i];
              this.emit("loop:iteration", { nodeId, index: i, total: items.length });

              // Fork context with loop variable injected
              const forked = ctx.fork({ [varName]: item, _loopIndex: i, _loopTotal: items.length });

              // Execute each downstream node in the forked context
              for (const targetId of downstreamIds) {
                const targetNode = nodeMap.get(targetId);
                if (!targetNode) continue;
                try {
                  forked.setNodeStatus(targetId, NodeStatus.RUNNING);
                  const result = await this._executeNode(targetNode, forked, opts);
                  forked.setNodeOutput(targetId, result);
                  forked.setNodeStatus(targetId, NodeStatus.COMPLETED);
                } catch (err) {
                  forked.error(targetId, err);
                  forked.setNodeStatus(targetId, NodeStatus.FAILED);
                  if (!targetNode.config?.continueOnError) break;
                }
              }
              iterationResults.push(forked.data);
              // Merge forked logs/errors back
              ctx.logs.push(...forked.logs);
              ctx.errors.push(...forked.errors);
            }

            // Mark downstream nodes as completed in main context & store aggregated results
            for (const targetId of downstreamIds) {
              executed.add(targetId);
              ctx.setNodeStatus(targetId, NodeStatus.COMPLETED);
              ctx.setNodeOutput(targetId, { _loopResults: iterationResults, iterations: items.length });
            }
            // Also queue any nodes downstream of the loop body
            for (const targetId of downstreamIds) {
              const targetEdges = adjacency.get(targetId) || [];
              for (const te of targetEdges) {
                const nd = (inDegree.get(te.target) || 1) - 1;
                inDegree.set(te.target, nd);
                if (nd <= 0 && !executed.has(te.target)) ready.add(te.target);
              }
            }
            continue; // Skip normal edge processing for loop node
          }
        }

        for (const edge of edges) {
          const edgePort = String(edge?.sourcePort || "default").trim() || "default";
          if (selectedPort && edgePort !== selectedPort) {
            continue;
          }

          // Check edge condition
          if (edge.condition) {
            try {
              const condResult = this._evaluateCondition(edge.condition, ctx, nodeId);
              if (!condResult) {
                ctx.setNodeStatus(edge.target, NodeStatus.SKIPPED);
                executed.add(edge.target);
                continue;
              }
            } catch {
              continue;
            }
          }

          // Decrement in-degree
          const newDegree = (inDegree.get(edge.target) || 1) - 1;
          inDegree.set(edge.target, newDegree);
          if (newDegree <= 0 && !executed.has(edge.target)) {
            ready.add(edge.target);
          }
        }
      }
    }
  }

  async _executeNode(node, ctx, opts = {}) {
    const handler = getNodeType(node.type);
    if (!handler) {
      throw new Error(`Unknown node type: "${node.type}". Register it with registerNodeType().`);
    }

    // Resolve config templates against context
    const resolvedConfig = this._resolveConfig(node.config || {}, ctx);

    // Dry run — just validate
    if (opts.dryRun) {
      ctx.log(node.id, `[dry-run] Would execute ${node.type}`, "info");
      return { _dryRun: true, type: node.type, config: resolvedConfig };
    }

    // Execute with timeout — clear timer on completion to avoid resource leaks
    const timeout = resolveNodeTimeoutMs(node, resolvedConfig);
    let timer;
    try {
      const result = await Promise.race([
        handler.execute(
          { ...node, config: resolvedConfig },
          ctx,
          this
        ),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Node "${node.label || node.id}" timed out after ${timeout}ms`)), timeout);
        }),
      ]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  _resolveConfig(config, ctx) {
    const resolved = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string") {
        resolved[key] = ctx.resolve(value);
      } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        resolved[key] = this._resolveConfig(value, ctx);
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  _evaluateCondition(condition, ctx, sourceNodeId) {
    // Simple expression evaluator — supports basic comparisons
    // Variables: $output (source node output), $data (context data), $status
    const output = ctx.getNodeOutput(sourceNodeId);
    const data = ctx.data;
    const status = ctx.getNodeStatus(sourceNodeId);

    // Safe subset evaluation
    try {
      const fn = new Function("$output", "$data", "$status", "$ctx", `return (${condition});`);
      return fn(output, data, status, ctx);
    } catch {
      return false;
    }
  }

  _readRunIndex() {
    const indexPath = resolve(this.runsDir, "index.json");
    if (!existsSync(indexPath)) return [];
    try {
      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      return Array.isArray(index?.runs) ? index.runs : [];
    } catch {
      return [];
    }
  }

  _getRunStuckThresholdMs() {
    const raw = Number(process.env.WORKFLOW_RUN_STUCK_THRESHOLD_MS);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return DEFAULT_RUN_STUCK_THRESHOLD_MS;
  }

  _getLastLogAt(logs = []) {
    let latest = 0;
    for (const entry of Array.isArray(logs) ? logs : []) {
      const ts = Number(entry?.timestamp);
      if (Number.isFinite(ts) && ts > latest) latest = ts;
    }
    return latest > 0 ? latest : null;
  }

  _getLastProgressAt(nodeStatusEvents = [], startedAt = null) {
    let latest = 0;
    for (const event of Array.isArray(nodeStatusEvents) ? nodeStatusEvents : []) {
      const ts = Number(event?.timestamp);
      if (Number.isFinite(ts) && ts > latest) latest = ts;
    }
    if (latest > 0) return latest;
    const normalizedStart = Number(startedAt);
    return Number.isFinite(normalizedStart) && normalizedStart > 0 ? normalizedStart : null;
  }

  _countNodeStatuses(nodeStatuses = {}) {
    const values = Object.values(nodeStatuses || {});
    return {
      nodeCount: values.length,
      completedCount: values.filter((value) => value === NodeStatus.COMPLETED).length,
      failedCount: values.filter((value) => value === NodeStatus.FAILED).length,
      skippedCount: values.filter((value) => value === NodeStatus.SKIPPED).length,
      activeNodeCount: values.filter(
        (value) => value === NodeStatus.RUNNING || value === NodeStatus.WAITING,
      ).length,
    };
  }

  _serializeRunContext(ctx, isRunning = false) {
    const detail = ctx.toJSON(Date.now());
    if (isRunning) {
      detail.endedAt = null;
      detail.duration = Math.max(0, Date.now() - Number(ctx?.startedAt || Date.now()));
    }
    return detail;
  }

  _buildSummaryFromDetail({ runId, workflowId, workflowName, status, detail }) {
    const startedAt = Number(detail?.startedAt) || null;
    const endedAtRaw = Number(detail?.endedAt);
    const normalizedStatus = status || WorkflowStatus.COMPLETED;
    const endedAt = normalizedStatus === WorkflowStatus.RUNNING
      ? null
      : (Number.isFinite(endedAtRaw) ? endedAtRaw : null);
    const duration = normalizedStatus === WorkflowStatus.RUNNING
      ? (startedAt ? Math.max(0, Date.now() - startedAt) : null)
      : (Number.isFinite(Number(detail?.duration)) ? Number(detail?.duration) : (startedAt && endedAt ? Math.max(0, endedAt - startedAt) : null));
    const nodeStatuses = detail?.nodeStatuses || {};
    const counts = this._countNodeStatuses(nodeStatuses);
    const errorCount = Array.isArray(detail?.errors) ? detail.errors.length : 0;
    const logCount = Array.isArray(detail?.logs) ? detail.logs.length : 0;
    const lastLogAt = this._getLastLogAt(detail?.logs || []);
    const lastProgressAt = this._getLastProgressAt(detail?.nodeStatusEvents || [], startedAt);
    const threshold = this._getRunStuckThresholdMs();
    const activityRef = Math.max(lastLogAt || 0, lastProgressAt || 0, startedAt || 0);
    const isRunning = normalizedStatus === WorkflowStatus.RUNNING;
    const stuckMs = isRunning && activityRef > 0 ? Math.max(0, Date.now() - activityRef) : 0;
    const isStuck = isRunning && stuckMs >= threshold;
    const triggerEvent =
      detail?.data?._triggerEventType ||
      detail?.data?.eventType ||
      null;
    const triggerSource =
      detail?.data?._triggerSource ||
      (triggerEvent ? "event" : "manual");
    const triggeredBy = detail?.data?._triggeredBy || null;

    return {
      runId,
      workflowId,
      workflowName: workflowName || workflowId || null,
      startedAt,
      endedAt,
      duration,
      status: normalizedStatus,
      errorCount,
      logCount,
      nodeCount: counts.nodeCount,
      completedCount: counts.completedCount,
      failedCount: counts.failedCount,
      skippedCount: counts.skippedCount,
      activeNodeCount: counts.activeNodeCount,
      lastLogAt,
      lastProgressAt,
      isStuck,
      stuckMs,
      stuckThresholdMs: threshold,
      triggerEvent,
      triggerSource,
      triggeredBy,
    };
  }

  _buildActiveRunSummary(runId, info) {
    if (!info?.ctx) return null;
    const detail = this._serializeRunContext(info.ctx, true);
    return this._buildSummaryFromDetail({
      runId,
      workflowId: info.workflowId,
      workflowName: info.workflowName || info.ctx?.data?._workflowName || info.workflowId,
      status: WorkflowStatus.RUNNING,
      detail,
    });
  }

  _normalizeRunSummary(summary) {
    if (!summary || !summary.runId) return null;
    const normalized = {
      ...summary,
      runId: String(summary.runId),
      status: summary.status || WorkflowStatus.COMPLETED,
    };
    if (!Number.isFinite(Number(normalized.stuckThresholdMs))) {
      normalized.stuckThresholdMs = this._getRunStuckThresholdMs();
    }
    if (!Number.isFinite(Number(normalized.activeNodeCount))) {
      normalized.activeNodeCount = 0;
    }
    if (normalized.status !== WorkflowStatus.RUNNING) {
      normalized.isStuck = false;
      normalized.stuckMs = 0;
      return normalized;
    }
    const startedAt = Number(normalized.startedAt) || 0;
    const activityRef = Math.max(
      Number(normalized.lastLogAt) || 0,
      Number(normalized.lastProgressAt) || 0,
      startedAt,
    );
    normalized.stuckMs = activityRef > 0 ? Math.max(0, Date.now() - activityRef) : 0;
    normalized.isStuck = normalized.stuckMs >= Number(normalized.stuckThresholdMs);
    return normalized;
  }

  _persistRun(runId, workflowId, ctx) {
    try {
      this._ensureDirs();
      const workflow = this.get(workflowId);
      const detail = this._serializeRunContext(ctx, false);
      const summary = this._buildSummaryFromDetail({
        runId,
        workflowId,
        workflowName: workflow?.name || ctx.data?._workflowName || workflowId,
        status: ctx.errors.length > 0 ? WorkflowStatus.FAILED : WorkflowStatus.COMPLETED,
        detail,
      });

      // Append to index
      const indexPath = resolve(this.runsDir, "index.json");
      let index = { runs: this._readRunIndex() };

      index.runs.push(summary);
      // Keep last N runs
      if (index.runs.length > MAX_PERSISTED_RUNS) index.runs = index.runs.slice(-MAX_PERSISTED_RUNS);
      writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf8");

      // Save full run detail
      const detailPath = resolve(this.runsDir, `${runId}.json`);
      writeFileSync(detailPath, JSON.stringify(detail, null, 2), "utf8");
    } catch (err) {
      console.error(`${TAG} Failed to persist run log:`, err.message);
    }
  }
}

// ── Module-level convenience functions ──────────────────────────────────────

let _defaultEngine = null;

/**
 * Get or create the default workflow engine instance.
 * @param {object} [opts]
 * @returns {WorkflowEngine}
 */
export function getWorkflowEngine(opts = {}) {
  if (!_defaultEngine) {
    _defaultEngine = new WorkflowEngine(opts);
    _defaultEngine.load();
  }
  return _defaultEngine;
}

/** Reset the default engine (for testing) */
export function resetWorkflowEngine() {
  _defaultEngine = null;
}

export function loadWorkflows(opts) { return getWorkflowEngine(opts).list(); }
export function saveWorkflow(def, opts) { return getWorkflowEngine(opts).save(def); }
export function deleteWorkflow(id, opts) { return getWorkflowEngine(opts).delete(id); }
export function listWorkflows(opts) { return getWorkflowEngine(opts).list(); }
export function getWorkflow(id, opts) { return getWorkflowEngine(opts).get(id); }
export async function executeWorkflow(id, data, opts) { return getWorkflowEngine(opts).execute(id, data, opts); }
