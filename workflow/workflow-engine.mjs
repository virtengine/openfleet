/**
 * workflow-engine.mjs — Bosun Workflow Engine
 *
 * A modular, declarative workflow execution engine that replaces hardcoded
 * supervisor logic with composable, user-editable workflow definitions.
 *
 * Workflows are directed graphs of nodes. Each node has a type (trigger,
 * condition, action, validation, transform, loop) and connects to
 * downstream nodes via edges. The engine evaluates triggers, routes
 * through conditions, executes actions, and validates results.
 *
 * While most workflows are DAGs, the engine supports back-edges
 * (edges with `backEdge: true`) for convergence loops. Back-edges
 * allow downstream nodes to route execution back to an upstream node,
 * enabling iterative patterns like generate→verify→revise cycles.
 * Back-edges are capped at a configurable iteration limit to prevent
 * infinite loops.
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

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { resolve, basename, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  ensureTestRuntimeSandbox,
  resolvePathForTestRuntime,
} from "../infra/test-runtime.mjs";
import { getTemplate } from "./workflow-templates.mjs";
import { WorkflowExecutionLedger } from "./execution-ledger.mjs";
import { buildWorkflowStatusPayload } from "../infra/tui-bridge.mjs";
import { getCurrentTraceContext, traceWorkflowNode, traceWorkflowRun } from "../infra/tracing.mjs";

// Lazy-loaded workspace manager for workspace-aware scheduling
let _workspaceManagerMod = null;
async function ensureWorkspaceManager() {
  if (_workspaceManagerMod) return _workspaceManagerMod;
  try {
    _workspaceManagerMod = await import("../workspace/workspace-manager.mjs");
  } catch {
    _workspaceManagerMod = null;
  }
  return _workspaceManagerMod;
}
function ensureWorkspaceManagerSync() {
  if (_workspaceManagerMod) return _workspaceManagerMod;
  return null;
}

// ── Constants ───────────────────────────────────────────────────────────────

const TAG = "[workflow-engine]";
const WORKFLOW_DIR_NAME = "workflows";
const WORKFLOW_RUNS_DIR = "workflow-runs";
const WORKFLOW_TRAJECTORIES_DIR = "trajectories";
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
const MAX_CONCURRENT_RUNS = readBoundedEnvInt("WORKFLOW_MAX_CONCURRENT_RUNS", 16, {
  min: 1,
  max: 256,
});
const MAX_PERSISTED_RUNS = readBoundedEnvInt("WORKFLOW_MAX_PERSISTED_RUNS", 2000, {
  min: 20,
  max: 20000,
});
const MAX_INTERRUPTED_ORPHAN_SCAN_FILES = readBoundedEnvInt(
  "WORKFLOW_INTERRUPTED_ORPHAN_SCAN_MAX_FILES",
  200,
  { min: 0, max: 5000 },
);
const INTERRUPTED_ORPHAN_SCAN_WINDOW_MS = readBoundedEnvInt(
  "WORKFLOW_INTERRUPTED_ORPHAN_SCAN_WINDOW_MS",
  7 * 24 * 60 * 60 * 1000,
  { min: 0, max: 90 * 24 * 60 * 60 * 1000 },
);
const DEFAULT_RUN_STUCK_THRESHOLD_MS = readBoundedEnvInt(
  "WORKFLOW_RUN_STUCK_THRESHOLD_MS",
  5 * 60 * 1000,
  { min: 10000, max: 7_200_000 },
);
const MAX_BACK_EDGE_ITERATIONS = readBoundedEnvInt(
  "WORKFLOW_MAX_BACK_EDGE_ITERATIONS",
  20,
  { min: 1, max: 200 },
);

// ── Auto-Retry Defaults ─────────────────────────────────────────────────────
const DEFAULT_AUTO_RETRY_MAX_ATTEMPTS = readBoundedEnvInt(
  "WORKFLOW_AUTO_RETRY_MAX_ATTEMPTS",
  3,
  { min: 0, max: 10 },
);
const DEFAULT_AUTO_RETRY_COOLDOWN_MS = readBoundedEnvInt(
  "WORKFLOW_AUTO_RETRY_COOLDOWN_MS",
  20 * 60 * 1000, // 20 minutes
  { min: 0, max: 3_600_000 },
);
const CHECKPOINT_DEBOUNCE_MS = readBoundedEnvInt(
  "WORKFLOW_CHECKPOINT_DEBOUNCE_MS",
  500,
  { min: 50, max: 10000 },
);
const ACTIVE_RUNS_INDEX = "_active-runs.json";const MAX_TASK_TRACE_EVENTS_PER_RUN = readBoundedEnvInt(
  "WORKFLOW_TASK_TRACE_MAX_EVENTS",
  250,
  { min: 20, max: 5000 },
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

function resolveTraceTaskId(data = {}) {
  return String(
    data?.taskId ||
      data?.task?.id ||
      data?.taskDetail?.id ||
      data?.taskInfo?.id ||
      "",
  ).trim() || null;
}

function resolveTraceAgentId(data = {}, fallback = "") {
  return String(
    data?.agentId ||
      data?.agentProfile ||
      data?.task?.assignee ||
      data?.taskDetail?.assignee ||
      data?.taskInfo?.assignee ||
      fallback ||
      "",
  ).trim() || null;
}

// ── Node Status ─────────────────────────────────────────────────────────────

function normalizeDelegationTrail(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({ ...entry }))
    .sort((a, b) => {
      const aTime = Number(a?.at || a?.timestamp || 0);
      const bTime = Number(b?.at || b?.timestamp || 0);
      return aTime - bTime;
    });
}

function normalizeDelegationGuardMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(([key, value]) => String(key || "").trim() && value && typeof value === "object")
      .map(([key, value]) => [String(key).trim(), { ...value }]),
  );
}

function extractDelegationGuardMap(detail, run = null) {
  return normalizeDelegationGuardMap(
    detail?.data?._delegationTransitionGuards ??
    run?.detail?.data?._delegationTransitionGuards ??
    run?.delegationTransitionGuards,
  );
}

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
const _nodeTypeMetaRegistry = new Map();
const _normalizedHandlerCache = new WeakMap();

function clonePortDescriptor(port) {
  if (!port || typeof port !== "object") return null;
  return {
    name: String(port.name || "default").trim() || "default",
    label: String(port.label || port.name || "default").trim() || "default",
    type: String(port.type || "Any").trim() || "Any",
    description: String(port.description || "").trim(),
    color: typeof port.color === "string" && port.color.trim() ? port.color.trim() : null,
    accepts: Array.isArray(port.accepts)
      ? Array.from(new Set(port.accepts.map((value) => String(value || "").trim()).filter(Boolean)))
      : [],
  };
}

function normalizePortDescriptor(port, direction, index) {
  const fallbackName = index === 0 ? "default" : `${direction}-${index + 1}`;
  if (typeof port === "string") {
    return {
      name: fallbackName,
      label: fallbackName,
      type: port,
      description: "",
      color: null,
      accepts: [],
    };
  }

  if (!port || typeof port !== "object") {
    return {
      name: fallbackName,
      label: fallbackName,
      type: "Any",
      description: "",
      color: null,
      accepts: [],
    };
  }

  return clonePortDescriptor({
    ...port,
    name: port.name || fallbackName,
    label: port.label || port.name || fallbackName,
    type: port.type || "Any",
  });
}

function normalizePortList(ports, direction) {
  if (!Array.isArray(ports)) return [];
  return ports
    .map((port, index) => normalizePortDescriptor(port, direction, index))
    .filter(Boolean);
}

function normalizeNodeUi(ui = {}) {
  const primaryFields = Array.isArray(ui?.primaryFields)
    ? Array.from(new Set(ui.primaryFields.map((value) => String(value || "").trim()).filter(Boolean)))
    : [];
  return {
    ...ui,
    primaryFields,
  };
}

function normalizeHandlerMetadata(handler) {
  if (_normalizedHandlerCache.has(handler)) {
    return _normalizedHandlerCache.get(handler);
  }

  const inputPorts = normalizePortList(handler?.inputs ?? handler?.ports?.inputs, "input");
  const outputPorts = normalizePortList(handler?.outputs ?? handler?.ports?.outputs, "output");

  const normalized = {
    ...handler,
    ports: {
      inputs: inputPorts,
      outputs: outputPorts,
    },
    ui: normalizeNodeUi(handler?.ui),
  };
  _normalizedHandlerCache.set(handler, normalized);
  return normalized;
}

function buildNamedPorts(names = [], direction = "output") {
  return Array.from(new Set((Array.isArray(names) ? names : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)))
    .map((name, index) => normalizePortDescriptor({ name, label: name, type: "Any" }, direction, index));
}

function inferLlmParseOutputPorts(node) {
  const outputPortField = String(node?.config?.outputPort || "").trim();
  if (!outputPortField) return [];

  const keywordPorts = Array.isArray(node?.config?.keywords?.[outputPortField])
    ? node.config.keywords[outputPortField]
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
    : [];

  const pattern = String(node?.config?.patterns?.[outputPortField] || "").trim();
  const match = pattern.match(/\(([^()]+)\)/);
  const patternPorts = match
    ? match[1]
      .split("|")
      .map((value) => value.replace(/^\?:/, "").trim().toLowerCase())
      .filter((value) => value && !value.includes("\\"))
    : [];

  return Array.from(new Set([...keywordPorts, ...patternPorts]));
}

function getConfiguredNodeInputs(node) {
  return buildNamedPorts(node?.inputs, "input");
}

function getConfiguredNodeOutputs(node) {
  const explicitOutputNames = Array.isArray(node?.outputs)
    ? Array.from(new Set(node.outputs.map((value) => String(value || "").trim()).filter(Boolean)))
    : [];

  if (node?.type === "condition.switch") {
    const caseOutputs = Object.values(node?.config?.cases || {})
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const mergedOutputs = Array.from(new Set([
      ...(explicitOutputNames.length > 0 ? explicitOutputNames : ["default"]),
      ...caseOutputs,
    ]));
    return buildNamedPorts(mergedOutputs, "output");
  }

  if (String(node?.type || "").startsWith("condition.")) {
    const mergedOutputs = Array.from(new Set([
      "default",
      ...(explicitOutputNames.length > 0 ? explicitOutputNames : []),
      "yes",
      "no",
    ]));
    return buildNamedPorts(mergedOutputs, "output");
  }

  if (node?.type === "transform.llm_parse") {
    const inferredOutputs = inferLlmParseOutputPorts(node);
    const mergedOutputs = Array.from(new Set([
      ...(explicitOutputNames.length > 0 ? explicitOutputNames : ["default"]),
      ...inferredOutputs,
    ]));
    return buildNamedPorts(mergedOutputs, "output");
  }

  return buildNamedPorts(explicitOutputNames, "output");
}

function resolveNodePorts(node) {
  const rawHandler = node?.type ? _nodeTypeRegistry.get(node.type) : null;
  const handler = rawHandler ? normalizeHandlerMetadata(rawHandler) : null;
  const handlerPorts = handler?.ports || {};
  const inputPorts = normalizePortList(node?.inputPorts, "input");
  const outputPorts = normalizePortList(node?.outputPorts, "output");
  const configuredInputs = getConfiguredNodeInputs(node);
  const configuredOutputs = getConfiguredNodeOutputs(node);
  const handlerInputs = normalizePortList(handlerPorts.inputs, "input");
  const handlerOutputs = normalizePortList(handlerPorts.outputs, "output");

  // Merge explicit outputPorts with configuredOutputs so that type-specific
  // ports (yes/no for conditions, case names for switches, etc.) are always
  // present even when outputPorts was auto-persisted with only "default".
  let resolvedOutputs;
  if (outputPorts.length > 0 && configuredOutputs.length > 0) {
    const existingNames = new Set(outputPorts.map((p) => p.name));
    const additional = configuredOutputs.filter((p) => !existingNames.has(p.name));
    resolvedOutputs = [...outputPorts, ...additional];
  } else if (outputPorts.length > 0) {
    resolvedOutputs = outputPorts;
  } else if (configuredOutputs.length > 0) {
    resolvedOutputs = configuredOutputs;
  } else if (handlerOutputs.length > 0) {
    resolvedOutputs = handlerOutputs;
  } else {
    resolvedOutputs = [normalizePortDescriptor({ name: "default", label: "default", type: "Any" }, "output", 0)];
  }

  return {
    inputs: inputPorts.length > 0
      ? inputPorts
      : (configuredInputs.length > 0
        ? configuredInputs
        : (handlerInputs.length > 0
          ? handlerInputs
          : [normalizePortDescriptor({ name: "default", label: "default", type: "Any" }, "input", 0)])),
    outputs: resolvedOutputs,
  };
}

function resolvePortByName(ports, requestedName, direction) {
  if (!Array.isArray(ports) || ports.length === 0) return null;
  const normalizedName = String(requestedName || "").trim();
  if (!normalizedName) return ports[0];
  const directMatch = ports.find((port) => port.name === normalizedName);
  if (directMatch) return directMatch;

  if (direction === "output") {
    if (normalizedName === "true") {
      return ports.find((port) => port.name === "yes") || null;
    }
    if (normalizedName === "false") {
      return ports.find((port) => port.name === "no") || null;
    }
  }

  return null;
}

function resolveRequestedPortName(edge, key, alias) {
  return String(edge?.[key] ?? edge?.[alias] ?? "").trim();
}

function buildUnknownPortValidationIssue(edge, direction, requestedPortName, availablePorts = []) {
  const safeRequestedPortName = String(requestedPortName || "").trim() || "default";
  const portLabel = direction === "output" ? "output" : "input";
  const availableNames = (Array.isArray(availablePorts) ? availablePorts : [])
    .map((port) => String(port?.name || "").trim())
    .filter(Boolean);
  const availableSuffix = availableNames.length
    ? ` Available ${portLabel} ports: ${availableNames.join(", ")}.`
    : "";

  return {
    edgeId: edge.id || `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    sourcePort: direction === "output"
      ? safeRequestedPortName
      : String(resolveRequestedPortName(edge, "sourcePort", "fromPort") || "default").trim() || "default",
    targetPort: direction === "input"
      ? safeRequestedPortName
      : String(resolveRequestedPortName(edge, "targetPort", "toPort") || "default").trim() || "default",
    sourceType: null,
    targetType: null,
    severity: "error",
    message: `Unknown ${portLabel} port "${safeRequestedPortName}" on edge ${edge.id || `${edge.source}->${edge.target}`}.${availableSuffix}`,
  };
}

function isWildcardPortType(type) {
  const normalized = String(type || "").trim();
  return normalized === "*" || normalized === "Any";
}

export function isPortConnectionCompatible(sourcePort, targetPort) {
  if (!sourcePort || !targetPort) {
    return { compatible: true, reason: null };
  }

  const sourceType = String(sourcePort.type || "Any").trim() || "Any";
  const targetType = String(targetPort.type || "Any").trim() || "Any";
  const accepted = new Set(
    [targetType, ...(Array.isArray(targetPort.accepts) ? targetPort.accepts : [])]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );

  if (isWildcardPortType(sourceType) || isWildcardPortType(targetType) || accepted.has("*") || accepted.has("Any")) {
    return { compatible: true, reason: null };
  }

  if (sourceType === targetType || accepted.has(sourceType)) {
    return { compatible: true, reason: null };
  }

  return {
    compatible: false,
    reason: `${sourcePort.label || sourcePort.name} emits ${sourceType}, but ${targetPort.label || targetPort.name} expects ${targetType}`,
  };
}

function getExplicitNodeOutputs(node) {
  return Array.isArray(node?.outputs)
    ? Array.from(new Set(node.outputs.map((value) => String(value || "").trim()).filter(Boolean)))
    : undefined;
}

function hydrateWorkflowNode(node, nodeMap) {
  const ports = resolveNodePorts(node);
  const explicitOutputs = getExplicitNodeOutputs(node);
  const nextNode = {
    ...node,
    inputPorts: ports.inputs.map((port) => clonePortDescriptor(port)),
    outputPorts: ports.outputs.map((port) => clonePortDescriptor(port)),
    ...(explicitOutputs !== undefined ? { outputs: explicitOutputs } : {}),
  };
  nodeMap.set(nextNode.id, nextNode);
  return nextNode;
}

function buildPortValidationIssue(edge, sourcePort, targetPort, compatibility) {
  return {
    edgeId: edge.id || `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    sourcePort: sourcePort?.name || "default",
    targetPort: targetPort?.name || "default",
    sourceType: sourcePort?.type || null,
    targetType: targetPort?.type || null,
    severity: "error",
    message: compatibility.reason,
  };
}

function hydrateWorkflowEdge(edge, nodeMap, issues) {
  const sourceNode = nodeMap.get(edge.source);
  const targetNode = nodeMap.get(edge.target);
  const sourcePorts = resolveNodePorts(sourceNode);
  const targetPorts = resolveNodePorts(targetNode);
  const requestedSourcePortName = resolveRequestedPortName(edge, "sourcePort", "fromPort");
  const requestedTargetPortName = resolveRequestedPortName(edge, "targetPort", "toPort");
  const sourcePort = resolvePortByName(
    sourcePorts.outputs,
    requestedSourcePortName || "default",
    "output",
  );
  const targetPort = resolvePortByName(
    targetPorts.inputs,
    requestedTargetPortName || "default",
    "input",
  );

  if (requestedSourcePortName && !sourcePort) {
    issues.push(buildUnknownPortValidationIssue(edge, "output", requestedSourcePortName, sourcePorts.outputs));
  }
  if (requestedTargetPortName && !targetPort) {
    issues.push(buildUnknownPortValidationIssue(edge, "input", requestedTargetPortName, targetPorts.inputs));
  }

  if (sourcePort && targetPort) {
    const compatibility = isPortConnectionCompatible(sourcePort, targetPort);
    if (!compatibility.compatible) {
      issues.push(buildPortValidationIssue(edge, sourcePort, targetPort, compatibility));
    }
  }

  return {
    ...edge,
    sourcePort: sourcePort?.name || requestedSourcePortName || "default",
    targetPort: targetPort?.name || requestedTargetPortName || "default",
    sourcePortType: sourcePort?.type || null,
    targetPortType: targetPort?.type || null,
  };
}

function hydrateWorkflowDefinition(def, { strict = false } = {}) {
  const normalized = {
    ...(def || {}),
    nodes: Array.isArray(def?.nodes) ? def.nodes.map((node) => ({ ...node })) : [],
    edges: Array.isArray(def?.edges) ? def.edges.map((edge) => ({ ...edge })) : [],
    metadata: { ...(def?.metadata || {}) },
  };

  const nodeMap = new Map();
  normalized.nodes = normalized.nodes.map((node) => hydrateWorkflowNode(node, nodeMap));

  const issues = [];
  normalized.edges = normalized.edges.map((edge) => hydrateWorkflowEdge(edge, nodeMap, issues));
  normalized.metadata.validationIssues = issues;

  if (strict && issues.length > 0) {
    throw new Error(`Workflow port validation failed: ${issues.map((issue) => issue.message).join("; ")}`);
  }

  return normalized;
}

function cloneRunSnapshot(value) {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {}
  return JSON.parse(JSON.stringify(value));
}

function cleanObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function normalizeDagText(value, maxLength = 240) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (!Number.isFinite(maxLength) || maxLength <= 0 || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function cloneDagGraphNode(node = {}) {
  return {
    nodeId: String(node.nodeId || "").trim(),
    label: node.label || null,
    type: node.type || null,
    status: node.status || NodeStatus.PENDING,
    dependencies: Array.isArray(node.dependencies) ? [...node.dependencies] : [],
    attempts: Number(node.attempts || 0) || 0,
    lastError: node.lastError || null,
    issueFindingCount: Array.isArray(node.issueFindings) ? node.issueFindings.length : 0,
    completionEvidenceCount: Array.isArray(node.completionEvidence) ? node.completionEvidence.length : 0,
  };
}

function buildDagGraphSnapshot(dagState = {}) {
  const nodes = Object.values(dagState?.nodes || {})
    .map((node) => cloneDagGraphNode(node))
    .filter((node) => node.nodeId);
  const edges = Array.isArray(dagState?.edges)
    ? dagState.edges
      .map((edge) => ({
        edgeId: String(edge?.edgeId || edge?.id || `${edge?.source || ""}->${edge?.target || ""}`).trim(),
        source: String(edge?.source || "").trim(),
        target: String(edge?.target || "").trim(),
        label: edge?.label || null,
        condition: edge?.condition || null,
      }))
      .filter((edge) => edge.source && edge.target)
    : [];
  return { nodes, edges };
}

function detectDagFindingSource(node = {}, result = {}, errorMessage = "") {
  const nodeType = String(node?.type || "").trim().toLowerCase();
  const reason = String(result?.reason || "").trim().toLowerCase();
  const combined = `${errorMessage} ${result?.output || ""} ${result?.stderr || ""} ${result?.reviewOutput || ""}`.toLowerCase();

  if (nodeType.includes("model_review") || reason.includes("manual_review") || combined.includes("changes requested")) {
    return "review";
  }
  if (
    nodeType.startsWith("validation.") ||
    combined.includes("validation") ||
    combined.includes("tests red") ||
    combined.includes("test failed")
  ) {
    return "validation";
  }
  if (
    combined.includes("dependency") ||
    combined.includes("module not found") ||
    combined.includes("cannot find module") ||
    combined.includes("api changed") ||
    combined.includes("contract") ||
    combined.includes("schema")
  ) {
    return "workflow_diagnostics";
  }
  return "execution";
}

function detectDagRecommendedAction(node = {}, result = {}, errorMessage = "") {
  const reason = String(result?.reason || "").trim().toLowerCase();
  const combined = `${errorMessage} ${result?.output || ""} ${result?.stderr || ""} ${result?.reviewOutput || ""}`.toLowerCase();
  const source = detectDagFindingSource(node, result, errorMessage);

  if (
    combined.includes("timeout") ||
    combined.includes("timed out") ||
    combined.includes("temporar") ||
    combined.includes("network") ||
    combined.includes("econnreset") ||
    combined.includes("service unavailable") ||
    combined.includes("rate limit")
  ) {
    return "rerun_same_step";
  }
  if (source === "review") {
    return "spawn_fix_step";
  }
  if (
    source === "workflow_diagnostics" ||
    combined.includes("dependency") ||
    combined.includes("module not found") ||
    combined.includes("cannot find module") ||
    combined.includes("api changed") ||
    combined.includes("schema") ||
    combined.includes("contract")
  ) {
    return "replan_subgraph";
  }
  if (reason === "manual_review_required") {
    return "spawn_fix_step";
  }
  if (source === "validation") {
    return "replan_from_failed";
  }
  return "inspect_failure";
}

function collectDagIssueFindings(node = {}, result = undefined, errorMessage = "") {
  const output = result && typeof result === "object" ? result : {};
  const message = normalizeDagText(
    errorMessage || output?.reviewOutput || output?.stderr || output?.output || output?.reason || "",
    260,
  );
  const failed = Boolean(errorMessage) || output?.passed === false || output?._failed === true;
  if (!failed || !message) return [];

  const source = detectDagFindingSource(node, output, message);
  const recommendedAction = detectDagRecommendedAction(node, output, message);
  return [cleanObject({
    nodeId: node?.id || node?.nodeId || null,
    label: node?.label || null,
    source,
    severity: source === "review" ? "high" : (source === "workflow_diagnostics" ? "high" : "medium"),
    summary: message,
    reason: output?.reason || null,
    exitCode: Number.isFinite(Number(output?.exitCode)) ? Number(output.exitCode) : null,
    command: normalizeDagText(output?.command || "", 140) || null,
    recommendedAction,
    suggestedRerun: output?.outputSuggestedRerun || output?.outputDiagnostics?.suggestedRerun || null,
  })];
}

function collectDagCompletionEvidence(node = {}, result = undefined) {
  const output = result && typeof result === "object" ? result : {};
  const passed = output?.passed !== false && output?._failed !== true;
  if (!passed) return [];

  const evidence = [];
  const summary = normalizeDagText(
    output?.summary || output?.outputHint || output?.narrative || output?.output || output?.reviewPath || "",
    220,
  );
  if (summary) {
    evidence.push({
      nodeId: node?.id || node?.nodeId || null,
      label: node?.label || null,
      kind: "summary",
      summary,
    });
  }
  const command = normalizeDagText(output?.command || "", 140);
  if (command) {
    evidence.push(cleanObject({
      nodeId: node?.id || node?.nodeId || null,
      label: node?.label || null,
      kind: "command",
      command,
      exitCode: Number.isFinite(Number(output?.exitCode)) ? Number(output.exitCode) : 0,
    }));
  }
  const artifactPath = normalizeDagText(output?.reviewPath || output?.evidenceDir || output?.path || "", 180);
  if (artifactPath) {
    evidence.push({
      nodeId: node?.id || node?.nodeId || null,
      label: node?.label || null,
      kind: "artifact",
      path: artifactPath,
    });
  }
  return evidence;
}

function summarizeDagEvidence(evidence = [], limit = 3) {
  if (!Array.isArray(evidence) || evidence.length === 0) return [];
  return evidence.slice(0, Math.max(1, limit)).map((entry) => {
    if (entry?.summary) return entry.summary;
    if (entry?.command) return `Command: ${entry.command}`;
    if (entry?.path) return `Artifact: ${entry.path}`;
    return normalizeDagText(JSON.stringify(entry), 140);
  }).filter(Boolean);
}
/**
 * Register a node type handler.
 * @param {string} type - Node type identifier (e.g., "trigger.task_low", "action.run_agent")
 * @param {object} handler - { execute(node, context, engine), validate?(node), describe?() }
 */
export function registerNodeType(type, handler, options = {}) {
  if (!handler || typeof handler.execute !== "function") {
    throw new Error(`${TAG} Node type "${type}" must have an execute function`);
  }
  const normalized = normalizeHandlerMetadata(handler);
  _nodeTypeRegistry.set(type, normalized);
  _nodeTypeMetaRegistry.set(type, {
    source: String(options.source || handler.source || "builtin"),
    badge: options.badge || handler.badge || null,
    isCustom: options.isCustom === true || handler.isCustom === true || String(options.source || handler.source || "").toLowerCase() === "custom",
    filePath: options.filePath || handler.filePath || null,
    inputs: Array.isArray(options.inputs)
      ? options.inputs
      : Array.isArray(handler.inputs)
        ? handler.inputs
        : (normalized.ports?.inputs || []).map((port) => port?.name || "default"),
    outputs: Array.isArray(options.outputs)
      ? options.outputs
      : Array.isArray(handler.outputs)
        ? handler.outputs
        : (normalized.ports?.outputs || []).map((port) => port?.name || "default"),
  });
}

/**
 * Get a registered node type handler.
 * @param {string} type
 * @returns {object|null}
 */
export function getNodeType(type) {
  return _nodeTypeRegistry.get(type) || null;
}

export function getNodeTypeMeta(type) {
  return _nodeTypeMetaRegistry.get(type) || null;
}

export function unregisterNodeType(type) {
  _nodeTypeRegistry.delete(type);
  _nodeTypeMetaRegistry.delete(type);
}

/**
 * List all registered node types with metadata.
 * @returns {Array<{type: string, category: string, description: string}>}
 */
export function listNodeTypes() {
  const result = [];
  for (const [type, handler] of _nodeTypeRegistry) {
    const [category] = type.split(".");
    const metadata = _nodeTypeMetaRegistry.get(type) || {};
    result.push({
      type,
      category,
      description: handler.describe?.() || type,
      schema: handler.schema || null,
      source: metadata.source || "builtin",
      badge: metadata.badge || null,
      isCustom: metadata.isCustom === true,
      filePath: metadata.filePath || null,
      inputs: Array.isArray(metadata.inputs) ? [...metadata.inputs] : [],
      outputs: Array.isArray(metadata.outputs) ? [...metadata.outputs] : [],
      ports: {
        inputs: (handler.ports?.inputs || []).map((port) => clonePortDescriptor(port)),
        outputs: (handler.ports?.outputs || []).map((port) => clonePortDescriptor(port)),
      },
      ui: normalizeNodeUi(handler.ui),
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
 * @property {boolean} [backEdge] - When true, this edge routes execution back
 *   to a previously-executed node, creating a convergence loop. Back-edges
 *   are excluded from in-degree calculation and have a per-edge iteration
 *   cap (default: MAX_BACK_EDGE_ITERATIONS).
 * @property {number} [maxIterations] - Override iteration cap for this back-edge
 */

/**
 * @typedef {object} WorkflowDefinition
 * @property {string} id - Unique workflow identifier
 * @property {string} name - Human-readable name
 * @property {string} [description] - What this workflow does
 * @property {string} [category] - Grouping category
 * @property {boolean} [enabled] - Whether this workflow is active
 * @property {boolean} [core] - Core workflows cannot be disabled or deleted
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
function collectValidationFailures(detail = {}) {
  const nodeOutputs = detail?.nodeOutputs && typeof detail.nodeOutputs === "object"
    ? detail.nodeOutputs
    : {};
  const dagNodes = detail?.dagState?.nodes && typeof detail.dagState.nodes === "object"
    ? detail.dagState.nodes
    : {};
  return Object.entries(nodeOutputs)
    .map(([nodeId, output]) => {
      if (!output || typeof output !== "object") return null;
      const diagnostic = output.failureDiagnostic && typeof output.failureDiagnostic === "object"
        ? output.failureDiagnostic
        : null;
      const failureKind = String(output.failureKind || diagnostic?.category || "").trim();
      const hasRetryability = typeof output.retryable === "boolean" || typeof diagnostic?.retryable === "boolean";
      if (!failureKind && !diagnostic && !hasRetryability) return null;
      return {
        nodeId,
        nodeType: dagNodes?.[nodeId]?.type || null,
        nodeLabel: dagNodes?.[nodeId]?.label || null,
        failureKind: failureKind || diagnostic?.category || null,
        retryable: typeof output.retryable === "boolean"
          ? output.retryable
          : diagnostic?.retryable === true,
        blocked: output.blocked === true || diagnostic?.blocked === true,
        exitCode: diagnostic?.exitCode ?? output.exitCode ?? null,
        summary:
          diagnostic?.summary ||
          output.outputHint ||
          output.outputDiagnostics?.summary ||
          null,
        detail: diagnostic?.detail || null,
      };
    })
    .filter(Boolean);
}

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
    this._nodeTimings = Object.create(null);
    this._nodeInputs = Object.create(null);
  }

  /** Target repo for multi-repo workspaces (convenience accessor) */
  get targetRepo() {
    return this.data._targetRepo || "";
  }

  /** Trigger variables passed from a caller workflow or manual dispatch */
  get triggerVars() {
    return this.data._triggerVars || {};
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

  /** Set a timing field for a node (startedAt / endedAt) */
  setNodeTiming(nodeId, field, value) {
    const key = String(nodeId);
    const fieldKey = String(field);
    if (!this._nodeTimings[key] || typeof this._nodeTimings[key] !== "object") {
      this._nodeTimings[key] = Object.create(null);
    }
    this._nodeTimings[key][fieldKey] = value;
  }

  /** Get timing data for a node */
  getNodeTiming(nodeId) {
    return this._nodeTimings[String(nodeId)] || null;
  }

  /** Store the resolved input snapshot for a node */
  setNodeInput(nodeId, input) {
    this._nodeInputs[String(nodeId)] = input;
  }

  /** Get the stored input snapshot for a node */
  getNodeInput(nodeId) {
    return this._nodeInputs[String(nodeId)] || null;
  }

  /** Merge metadata into an existing DAGState node entry */
  annotateDagNode(nodeId, patch = {}) {
    const dagState = this.data?._dagState;
    if (!dagState || typeof dagState !== "object" || !dagState.nodes || typeof dagState.nodes !== "object") {
      return;
    }
    const existing = dagState.nodes[nodeId];
    if (!existing || typeof existing !== "object") return;
    dagState.nodes[nodeId] = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
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
    const dagNode = this.data?._dagState?.nodes?.[nodeId];
    if (dagNode && typeof dagNode === "object") {
      dagNode.status = status;
      dagNode.lastStatusAt = new Date().toISOString();
    }
  }

  /** Get node execution status */
  getNodeStatus(nodeId) {
    return this.nodeStatuses.get(nodeId) || NodeStatus.PENDING;
  }

  /** Add a log entry */
  log(nodeId, message, level = "info") {
    this.logs.push({ nodeId, message, level, timestamp: Date.now() });
  }

  getDelegationAuditTrail() {
    return normalizeDelegationTrail(
      this.data?._delegationAuditTrail ??
      this.data?._workflowDelegationTrail ??
      this.data?._delegationTrail,
    );
  }

  recordDelegationEvent(event = {}) {
    if (!this.data || typeof this.data !== "object") this.data = {};
    this.data._delegationTransitionGuards = normalizeDelegationGuardMap(this.data._delegationTransitionGuards);
    const entry = {
      ...event,
      type: String(event?.type || event?.eventType || "").trim() || "unknown",
      eventType: String(event?.eventType || event?.type || "").trim() || "unknown",
      at: Number(event?.at) || Date.now(),
      timestamp: event?.timestamp || new Date().toISOString(),
    };
    const key = String(event?.transitionKey || event?.idempotencyKey || "").trim();
    if (key) {
      if (!this.data._delegationTransitionGuards || typeof this.data._delegationTransitionGuards !== "object") {
        this.data._delegationTransitionGuards = {};
      }
      if (this.data._delegationTransitionGuards[key]) {
        return {
          ...this.data._delegationTransitionGuards[key],
          recorded: false,
        };
      }
      entry.transitionKey = entry.transitionKey || key;
      entry.idempotencyKey = entry.idempotencyKey || key;
      this.data._delegationTransitionGuards[key] = entry;
    }
    const nextTrail = normalizeDelegationTrail([...this.getDelegationAuditTrail(), entry]);
    this.data._delegationAuditTrail = nextTrail;
    this.data._workflowDelegationTrail = nextTrail;
    this.data._delegationTrail = nextTrail;
    return {
      ...entry,
      recorded: true,
    };
  }

  getDelegationTransitionGuard(key) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return null;
    const guards = normalizeDelegationGuardMap(this.data?._delegationTransitionGuards);
    return guards[normalizedKey] ? { ...guards[normalizedKey] } : null;
  }

  setDelegationTransitionGuard(key, value = {}) {
    const normalizedKey = String(key || "").trim();
    if (!normalizedKey) return null;
    if (!this.data || typeof this.data !== "object") this.data = {};
    const guards = normalizeDelegationGuardMap(this.data._delegationTransitionGuards);
    const nextValue = { ...value, transitionKey: value?.transitionKey || normalizedKey };
    guards[normalizedKey] = nextValue;
    this.data._delegationTransitionGuards = guards;
    return { ...nextValue };
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
    const resolvePathValue = (path) => {
      const parts = path.split(".");

      // Try context data first
      let value = this.data;
      for (const part of parts) {
        if (value == null) break;
        value = value[part];
      }
      if (value != null) return value;

      // Fall back to node outputs (e.g. {{step1.count}} → nodeOutputs["step1"].count)
      const [nodeId, ...rest] = parts;
      const nodeOut = this.nodeOutputs.get(nodeId);
      if (nodeOut != null) {
        let val = nodeOut;
        for (const p of rest) {
          if (val == null) return undefined;
          val = val[p];
        }
        if (val != null) return val;
      }
      return undefined;
    };

    // If template is exactly one placeholder, preserve raw value type.
    // This allows numbers/booleans/objects to flow into node configs.
    const exactMatch = template.match(/^\{\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\}$/);
    if (exactMatch) {
      const raw = resolvePathValue(exactMatch[1]);
      return raw != null ? raw : template;
    }

    return template.replace(/\{\{([A-Za-z0-9_][A-Za-z0-9_.-]*)\}\}/g, (match, path) => {
      const value = resolvePathValue(path);
      if (value == null) return match;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
      try { return JSON.stringify(value); } catch { return String(value); }
    });
  }

  /** Get a serializable summary of the execution */
  toJSON(endedAt = Date.now()) {
    const finishedAt = Number.isFinite(endedAt) ? endedAt : Date.now();
    const detail = {
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
      nodeTimings: { ...this._nodeTimings },
      nodeInputs: { ...this._nodeInputs },
      dagState: this.data?._dagState || null,
      issueAdvisor: this.data?._issueAdvisor || null,
      replayTrajectory: this.data?._replayTrajectory || null,
      delegationAuditTrail: this.getDelegationAuditTrail(),
      delegationTrail: this.getDelegationAuditTrail(),
      delegationTransitionGuards:
        this.data?._delegationTransitionGuards && typeof this.data._delegationTransitionGuards === "object"
          ? { ...this.data._delegationTransitionGuards }
          : {},
      stepSummaries: Array.isArray(this.data?._replayTrajectory?.steps)
        ? this.data._replayTrajectory.steps.map((s) => ({
            nodeId: s.nodeId,
            label: s.label,
            status: s.status,
            summary: s.summary,
          }))
        : [],
    };
    const validationFailures = collectValidationFailures(detail);
    if (validationFailures.length > 0) {
      detail.validationFailures = validationFailures;
      detail.latestValidationFailure = validationFailures.at(-1) || null;
    }
    return detail;
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
    const sandbox = ensureTestRuntimeSandbox();
    const defaultWorkflowDir = resolve(process.cwd(), ".bosun", WORKFLOW_DIR_NAME);
    const defaultRunsDir = resolve(process.cwd(), ".bosun", WORKFLOW_RUNS_DIR);
    this.workflowDir = resolvePathForTestRuntime(
      opts.workflowDir || defaultWorkflowDir,
      defaultWorkflowDir,
      sandbox?.workflowDir,
    );
    this.runsDir = resolvePathForTestRuntime(
      opts.runsDir || defaultRunsDir,
      defaultRunsDir,
      sandbox?.runsDir,
    );
    this._configDir = opts.configDir || process.cwd();
    this.detectInterruptedRuns = opts.detectInterruptedRuns !== false &&
      process.env.WORKFLOW_DETECT_INTERRUPTED_RUNS !== "0" &&
      process.env.WORKFLOW_DETECT_INTERRUPTED_RUNS !== "false";
    this.services = opts.services || {};
    this._workflows = new Map();
    this._activeRuns = new Map();
    this._triggerSubscriptions = new Map();
    this._loaded = false;
    this._checkpointTimers = new Map(); // runId → debounce timer
    this._resumingRuns = false;
    this._taskTraceHooks = new Set();
    if (typeof opts.onTaskWorkflowEvent === "function") {
      this._taskTraceHooks.add(opts.onTaskWorkflowEvent);
    }
    if (typeof opts.taskTraceHook === "function") {
      this._taskTraceHooks.add(opts.taskTraceHook);
    }
    if (Array.isArray(opts.taskTraceHooks)) {
      for (const hook of opts.taskTraceHooks) {
        if (typeof hook === "function") this._taskTraceHooks.add(hook);
      }
    }

    // ── Concurrency control ───────────────────────────────────────────
    this._runSlots = 0;              // current number of executing runs
    this._runQueue = [];             // FIFO queue of { resolve, reject, args }
    this._runIndexCache = null;      // cached run index (invalidated on writes)
    this._runIndexCacheMtime = 0;    // mtime of the cached index file
    this._executionLedger = new WorkflowExecutionLedger({ runsDir: this.runsDir });

    // Lazy-load workspace manager for schedule evaluation
    void ensureWorkspaceManager().catch(() => {});
  }
  _emitWorkflowStatus(payload = {}) {
    const event = buildWorkflowStatusPayload(payload);
    if (!event.runId || !event.workflowId || !event.eventType) return;
    this.emit("workflow:status", event);
  }


  _initializeDagState(def, ctx, extra = {}) {
    const dependencyMap = new Map();
    const edges = [];
    for (const node of def?.nodes || []) {
      dependencyMap.set(node.id, []);
    }
    for (const edge of def?.edges || []) {
      if (!edge?.source || !edge?.target || edge.backEdge === true) continue;
      const deps = dependencyMap.get(edge.target) || [];
      deps.push(edge.source);
      dependencyMap.set(edge.target, deps);
      edges.push({
        edgeId: String(edge.id || `${edge.source}->${edge.target}`),
        source: edge.source,
        target: edge.target,
        label: edge.label || null,
        condition: edge.condition || null,
      });
    }

    const nowIso = new Date(ctx.startedAt).toISOString();
    const dagState = {
      version: 1,
      runId: ctx.id,
      workflowId: def?.id || ctx.data?._workflowId || null,
      workflowName: def?.name || ctx.data?._workflowName || null,
      rootRunId: extra.rootRunId || ctx.data?._workflowRootRunId || ctx.id,
      parentRunId: extra.parentRunId || ctx.data?._workflowParentRunId || null,
      retryOf: extra.retryOf || ctx.data?._retryOf || null,
      retryMode: extra.retryMode || null,
      revisionReason: extra.revisionReason || null,
      createdAt: nowIso,
      updatedAt: nowIso,
      status: WorkflowStatus.RUNNING,
      revisions: [],
      counts: {
        total: Array.isArray(def?.nodes) ? def.nodes.length : 0,
        pending: Array.isArray(def?.nodes) ? def.nodes.length : 0,
        running: 0,
        completed: 0,
        failed: 0,
        skipped: 0,
      },
      edges,
      nodes: Object.fromEntries(
        (def?.nodes || []).map((node) => [
          node.id,
          {
            nodeId: node.id,
            type: node.type,
            label: node.label || null,
            status: NodeStatus.PENDING,
            dependencies: dependencyMap.get(node.id) || [],
            attempts: 0,
            lastError: null,
            outputSummary: null,
            issueFindings: [],
            completionEvidence: [],
            startedAt: null,
            endedAt: null,
            updatedAt: nowIso,
          },
        ]),
      ),
    };
    ctx.data._workflowRootRunId = dagState.rootRunId;
    if (dagState.parentRunId) ctx.data._workflowParentRunId = dagState.parentRunId;
    ctx.data._dagState = dagState;
    this._refreshDagState(ctx, dagState.status);
    return dagState;
  }

  _recordDagRevision(ctx, revision = {}) {
    const dagState = ctx?.data?._dagState;
    if (!dagState || typeof dagState !== "object" || !dagState.nodes || typeof dagState.nodes !== "object") {
      return null;
    }
    if (!Array.isArray(dagState.revisions)) dagState.revisions = [];
    const nodes = Object.values(dagState.nodes);
    const counts = {
      total: nodes.length,
      pending: nodes.filter((node) => node?.status === NodeStatus.PENDING).length,
      running: nodes.filter((node) => node?.status === NodeStatus.RUNNING || node?.status === NodeStatus.WAITING).length,
      completed: nodes.filter((node) => node?.status === NodeStatus.COMPLETED).length,
      failed: nodes.filter((node) => node?.status === NodeStatus.FAILED).length,
      skipped: nodes.filter((node) => node?.status === NodeStatus.SKIPPED).length,
    };
    const completedNodeIds = nodes.filter((node) => node?.status === NodeStatus.COMPLETED).map((node) => node.nodeId);
    const failedNodeIds = nodes.filter((node) => node?.status === NodeStatus.FAILED).map((node) => node.nodeId);
    const pendingNodeIds = nodes
      .filter((node) => node?.status === NodeStatus.PENDING || node?.status === NodeStatus.WAITING)
      .map((node) => node.nodeId);
    const graphBefore = revision.graphBefore && typeof revision.graphBefore === "object"
      ? revision.graphBefore
      : (dagState.revisions.length > 0 ? dagState.revisions[dagState.revisions.length - 1]?.graphAfter || null : null);
    const graphAfter = revision.graphAfter && typeof revision.graphAfter === "object"
      ? revision.graphAfter
      : buildDagGraphSnapshot(dagState);
    const issueFindings = nodes.flatMap((node) => Array.isArray(node?.issueFindings) ? node.issueFindings : []);
    const completionEvidence = nodes.flatMap((node) => Array.isArray(node?.completionEvidence) ? node.completionEvidence : []);
    const snapshot = {
      index: dagState.revisions.length,
      recordedAt: new Date().toISOString(),
      reason: revision.reason || "update",
      sourceRunId: revision.sourceRunId || null,
      retryMode: dagState.retryMode || null,
      status: dagState.status || WorkflowStatus.RUNNING,
      counts,
      preservedCompletedNodeIds: Array.isArray(revision.preservedCompletedNodeIds)
        ? [...new Set(revision.preservedCompletedNodeIds.map((id) => String(id || "").trim()).filter(Boolean))]
        : completedNodeIds,
      focusNodeIds: Array.isArray(revision.focusNodeIds)
        ? [...new Set(revision.focusNodeIds.map((id) => String(id || "").trim()).filter(Boolean))]
        : (failedNodeIds.length ? failedNodeIds : pendingNodeIds),
      failedNodeIds,
      pendingNodeIds,
      issueFindingCount: issueFindings.length,
      completionEvidenceCount: completionEvidence.length,
      issueFindingsPreview: issueFindings.slice(0, 6),
      completionEvidencePreview: completionEvidence.slice(0, 6),
      graphBefore,
      graphAfter,
      edgeCount: Array.isArray(dagState.edges) ? dagState.edges.length : 0,
      nodeCount: nodes.length,
    };
    dagState.revisions.push(snapshot);
    dagState.updatedAt = snapshot.recordedAt;
    return snapshot;
  }
  _refreshDagState(ctx, status = null) {
    const dagState = ctx?.data?._dagState;
    if (!dagState || typeof dagState !== "object" || !dagState.nodes || typeof dagState.nodes !== "object") {
      return null;
    }
    const nodes = Object.values(dagState.nodes);
    const counts = {
      total: nodes.length,
      pending: nodes.filter((node) => node?.status === NodeStatus.PENDING).length,
      running: nodes.filter((node) => node?.status === NodeStatus.RUNNING || node?.status === NodeStatus.WAITING).length,
      completed: nodes.filter((node) => node?.status === NodeStatus.COMPLETED).length,
      failed: nodes.filter((node) => node?.status === NodeStatus.FAILED).length,
      skipped: nodes.filter((node) => node?.status === NodeStatus.SKIPPED).length,
    };
    dagState.counts = counts;
    dagState.status = status || dagState.status || WorkflowStatus.RUNNING;
    dagState.updatedAt = new Date().toISOString();

    const failedNodes = nodes.filter((node) => node?.status === NodeStatus.FAILED);
    const pendingNodes = nodes.filter((node) => node?.status === NodeStatus.PENDING || node?.status === NodeStatus.WAITING);
    const firstFailed = failedNodes[0] || null;
    const firstPending = pendingNodes[0] || null;
    const issueFindings = nodes.flatMap((node) => Array.isArray(node?.issueFindings) ? node.issueFindings : []);
    const completionEvidence = nodes.flatMap((node) => Array.isArray(node?.completionEvidence) ? node.completionEvidence : []);
    const firstFinding = issueFindings[0] || null;

    let recommendedAction = "continue";
    let summary = "Workflow is ready to continue.";
    if (failedNodes.length > 0) {
      const preferredAction = firstFinding?.recommendedAction || null;
      recommendedAction = preferredAction;
      if (!recommendedAction || (recommendedAction === "inspect_failure" && counts.completed > 0)) {
        recommendedAction = counts.completed > 0 ? "replan_from_failed" : "inspect_failure";
      }
      summary = firstFinding?.summary
        ? `Failed at ${firstFailed?.label || firstFailed?.nodeId || "a workflow step"}: ${firstFinding.summary}`
        : (firstFailed?.lastError
            ? `Failed at ${firstFailed.label || firstFailed.nodeId}: ${firstFailed.lastError}`
            : `Workflow has ${failedNodes.length} failed node(s).`);
    } else if (pendingNodes.length > 0 && counts.completed > 0) {
      recommendedAction = "resume_remaining";
      summary = `Resume from ${firstPending?.label || firstPending?.nodeId || "the next pending node"}.`;
    }

    const nextStepGuidance = failedNodes.length > 0
      ? [
        recommendedAction === "rerun_same_step"
          ? "Preserve completed work and rerun the same failed step with the suggested command or fix."
          : (recommendedAction === "spawn_fix_step"
              ? "Preserve completed work and insert a targeted fix step before resuming downstream execution."
              : (recommendedAction === "replan_subgraph"
                  ? "Preserve completed work and replan the impacted downstream subgraph before continuing."
                  : "Preserve completed work and replan from the failed boundary.")),
        firstFailed?.label ? `Focus next on ${firstFailed.label}.` : null,
        firstFinding?.suggestedRerun ? `Suggested rerun: ${firstFinding.suggestedRerun}` : null,
        firstFailed?.lastError ? `Address failure: ${firstFailed.lastError}` : null,
      ].filter(Boolean).join(" ")
      : (pendingNodes.length > 0 && counts.completed > 0
        ? [
          "Preserve completed work and continue from the next pending node.",
          firstPending?.label ? `Next step: ${firstPending.label}.` : null,
        ].filter(Boolean).join(" ")
        : "Plan is healthy; continue executing the remaining graph.");

    const issueAdvisor = {
      status: dagState.status,
      summary,
      recommendedAction,
      failedNodeCount: failedNodes.length,
      pendingNodeCount: pendingNodes.length,
      completedNodeCount: counts.completed,
      suggestedRerun: firstFailed?.suggestedRerun || firstFinding?.suggestedRerun || null,
      retryDecisionClass:
        recommendedAction === "rerun_same_step"
          ? "rerun_same_step"
          : (recommendedAction === "spawn_fix_step"
              ? "spawn_fix_step"
              : ((recommendedAction === "replan_subgraph" || recommendedAction === "replan_from_failed")
                  ? "replan_entire_subgraph"
                  : "inspect_failure")),
      failedNodes: failedNodes.slice(0, 6).map((node) => ({
        nodeId: node.nodeId,
        label: node.label || null,
        error: node.lastError || null,
        attempts: node.attempts || 0,
        issueFindings: Array.isArray(node.issueFindings) ? node.issueFindings.slice(0, 3) : [],
        completionEvidence: Array.isArray(node.completionEvidence) ? node.completionEvidence.slice(0, 3) : [],
      })),
      issueFindings: issueFindings.slice(0, 8),
      completionEvidence: completionEvidence.slice(0, 8),
      updatedAt: dagState.updatedAt,
      nextStepGuidance,
      dagRevisionCount: Array.isArray(dagState.revisions) ? dagState.revisions.length : 0,
    };

    ctx.data._issueAdvisor = issueAdvisor;
    const existingFeedback =
      ctx.data?._plannerFeedback && typeof ctx.data._plannerFeedback === "object" && !Array.isArray(ctx.data._plannerFeedback)
        ? ctx.data._plannerFeedback
        : {};
    ctx.data._plannerFeedback = {
      ...existingFeedback,
      issueAdvisor,
      issueAdvisorSummary: [summary, nextStepGuidance].filter(Boolean).join("\n"),
      dagStateSummary: {
        revisionCount: Array.isArray(dagState.revisions) ? dagState.revisions.length : 0,
        runId: dagState.runId,
        workflowId: dagState.workflowId,
        status: dagState.status,
        counts,
        issueFindingCount: issueFindings.length,
        completionEvidenceCount: completionEvidence.length,
        graph: buildDagGraphSnapshot(dagState),
      },
    };
    return issueAdvisor;
  }

  _buildStepSummary(node, { status = null, result = undefined, error = null } = {}) {
    const nodeId = String(node?.id || "").trim() || null;
    const label = String(node?.label || nodeId || "step").trim();
    const normalizedStatus = String(status || "unknown").trim().toLowerCase() || "unknown";
    let detail = null;
    if (error) {
      detail = String(error).trim();
    } else if (result !== undefined) {
      detail = this._summarizeTaskTraceNodeResult(result);
    }
    if (!detail) {
      detail = normalizedStatus === "completed"
        ? "Step completed successfully."
        : (normalizedStatus === "failed" ? "Step failed." : `Step ${normalizedStatus}.`);
    }
    return {
      nodeId,
      label,
      status: normalizedStatus,
      summary: `${label}: ${detail}`,
    };
  }

  _appendReplayTrajectoryStep(ctx, node, { status = null, result = undefined, error = null, attempt = undefined } = {}) {
    if (!ctx || !node?.id) return;
    const timing = ctx.getNodeTiming(node.id) || {};
    const outputSummary = result !== undefined ? this._summarizeTaskTraceNodeResult(result) : null;
    const replay =
      ctx.data?._replayTrajectory && typeof ctx.data._replayTrajectory === "object"
        ? ctx.data._replayTrajectory
        : { runId: ctx.id, restoredFrom: ctx.data?._restoredFrom || null, steps: [] };
    const step = {
      nodeId: node.id,
      type: node.type || null,
      label: node.label || null,
      status: status || null,
      attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : ctx.getRetryCount(node.id),
      startedAt: Number.isFinite(Number(timing.startedAt)) ? Number(timing.startedAt) : null,
      endedAt: Number.isFinite(Number(timing.endedAt)) ? Number(timing.endedAt) : null,
      input: ctx.getNodeInput(node.id) || null,
      outputSummary,
      error: error ? String(error) : null,
      summary: this._buildStepSummary(node, { status, result, error }).summary,
    };
    replay.runId = ctx.id;
    replay.restoredFrom = ctx.data?._restoredFrom || replay.restoredFrom || null;
    replay.steps = Array.isArray(replay.steps) ? replay.steps.filter((entry) => entry?.nodeId !== node.id) : [];
    replay.steps.push(step);
    ctx.data._replayTrajectory = replay;
  }

  _recordDagNodeOutcome(ctx, node, {
    status,
    result = undefined,
    error = null,
    attempt = undefined,
  } = {}) {
    if (!ctx || !node?.id) return;
    const timing = ctx.getNodeTiming(node.id) || {};
    const issueFindings = collectDagIssueFindings(node, result, error ? String(error) : "");
    const completionEvidence = collectDagCompletionEvidence(node, result);
    const existingDagNode = ctx.data?._dagState?.nodes?.[node.id] || {};
    const nodePatch = cleanObject({
      status,
      attempts: Number.isFinite(Number(attempt)) ? Number(attempt) : ctx.getRetryCount(node.id),
      lastError: error ? String(error) : null,
      outputSummary: result !== undefined ? this._summarizeTaskTraceNodeResult(result) : undefined,
      issueFindings: issueFindings.length > 0 ? issueFindings : (status === NodeStatus.COMPLETED ? [] : (existingDagNode.issueFindings || undefined)),
      completionEvidence: completionEvidence.length > 0
        ? [...(Array.isArray(existingDagNode.completionEvidence) ? existingDagNode.completionEvidence : []), ...completionEvidence]
        : (status === NodeStatus.FAILED ? (existingDagNode.completionEvidence || undefined) : undefined),
      startedAt: Number.isFinite(Number(timing.startedAt)) ? new Date(Number(timing.startedAt)).toISOString() : null,
      endedAt: Number.isFinite(Number(timing.endedAt)) ? new Date(Number(timing.endedAt)).toISOString() : null,
      suggestedRerun:
        result && typeof result === "object"
          ? (result.outputSuggestedRerun || result.outputDiagnostics?.suggestedRerun || undefined)
          : undefined,
      outputHint:
        result && typeof result === "object" && result.outputHint
          ? String(result.outputHint)
          : undefined,
      outputDeltaSummary:
        result && typeof result === "object" && result.outputDeltaSummary
          ? String(result.outputDeltaSummary)
          : undefined,
      outputBudgetPolicy:
        result && typeof result === "object" && result.outputBudgetPolicy
          ? String(result.outputBudgetPolicy)
          : undefined,
      outputBudgetReason:
        result && typeof result === "object" && result.outputBudgetReason
          ? String(result.outputBudgetReason)
          : undefined,
    });
    ctx.annotateDagNode(node.id, nodePatch);
    this._appendReplayTrajectoryStep(ctx, node, { status, result, error, attempt });
    const workflowStatus = error
      ? WorkflowStatus.FAILED
      : (ctx.data?._workflowTerminalStatus || WorkflowStatus.RUNNING);
    this._refreshDagState(ctx, workflowStatus);
  }

  _recordLedgerEvent(event = {}) {
    try {
      this._executionLedger.appendEvent(event);
    } catch (err) {
      console.warn(`${TAG} execution ledger write failed: ${String(err?.message || err)}`);
    }
  }

  _buildLedgerTaskMeta(ctx, extra = {}) {
    const taskId = String(
      ctx?.data?.taskId ||
      ctx?.data?.task?.id ||
      ctx?.data?.taskInfo?.id ||
      ctx?.data?.taskDetail?.id ||
      "",
    ).trim();
    const taskTitle = String(
      ctx?.data?.taskTitle ||
      ctx?.data?.task?.title ||
      ctx?.data?.taskInfo?.title ||
      ctx?.data?.taskDetail?.title ||
      "",
    ).trim();
    return cleanObject({
      ...extra,
      taskId: taskId || undefined,
      taskTitle: taskTitle || undefined,
    });
  }


  /**
   * Register a per-engine hook for task-linked workflow trace events.
   * The hook is invoked only when a task context is resolved.
   * @param {(event: object) => (void|Promise<void>)} hook
   * @returns {() => void} unsubscribe function
   */
  registerTaskTraceHook(hook) {
    if (typeof hook !== "function") return () => {};
    this._taskTraceHooks.add(hook);
    return () => {
      this._taskTraceHooks.delete(hook);
    };
  }

  _sanitizeTaskId(value) {
    const normalized = String(value ?? "").trim();
    return normalized || "";
  }

  _resolveTemplateDefaultVariable(def, key) {
    if (!def || typeof def !== "object") return undefined;
    if (def?.metadata?.templateState?.isCustomized === true) return undefined;
    const templateId = String(def?.metadata?.installedFrom || "").trim();
    if (!templateId) return undefined;
    const template = getTemplate(templateId);
    if (!template?.variables || typeof template.variables !== "object") return undefined;
    return Object.prototype.hasOwnProperty.call(template.variables, key)
      ? template.variables[key]
      : undefined;
  }

  _applyResumeInputMigrations(def, data = {}) {
    if (!data || typeof data !== "object") return data;
    const next = { ...data };
    const templateId = String(def?.metadata?.installedFrom || "").trim();
    if (templateId === "template-task-lifecycle") {
      const currentValue = next.prePrValidationCommand;
      const nextDefault =
        this._resolveTemplateDefaultVariable(def, "prePrValidationCommand")
        ?? def?.variables?.prePrValidationCommand;
      if (currentValue === "npm run prepush:check" && nextDefault === "auto") {
        next.prePrValidationCommand = nextDefault;
      }
    }
    return next;
  }

  _resolveTaskTraceContext(ctx, node = null, result = null) {
    const nodeTaskIdCandidate = (() => {
      if (!node?.config || typeof node.config !== "object") return "";
      try {
        const resolved = ctx.resolve(node.config.taskId || node.config.id || "");
        return this._sanitizeTaskId(resolved);
      } catch {
        return "";
      }
    })();

    const resultTaskId = this._sanitizeTaskId(
      result?.taskId ||
      result?.id ||
      result?.task?.id ||
      result?.task?.task_id,
    );
    const taskId = this._sanitizeTaskId(
      ctx?.data?.taskId ||
      ctx?.data?.activeTaskId ||
      ctx?.data?.task?.id ||
      ctx?.data?.task?.task_id ||
      nodeTaskIdCandidate ||
      resultTaskId,
    );
    if (!taskId) return null;

    const nodeTaskTitleCandidate = (() => {
      if (!node?.config || typeof node.config !== "object") return "";
      try {
        const resolved = ctx.resolve(node.config.taskTitle || node.config.title || "");
        return String(resolved || "").trim();
      } catch {
        return "";
      }
    })();

    const taskTitle = String(
      ctx?.data?.taskTitle ||
      ctx?.data?.task?.title ||
      result?.taskTitle ||
      result?.title ||
      result?.task?.title ||
      nodeTaskTitleCandidate ||
      "",
    ).trim() || null;

    return {
      taskId,
      taskTitle,
      branch: String(
        ctx?.data?.branch ||
        ctx?.data?.branchName ||
        result?.branch ||
        result?.branchName ||
        "",
      ).trim() || null,
      prNumber: String(
        ctx?.data?.prNumber ||
        result?.prNumber ||
        "",
      ).trim() || null,
      prUrl: String(
        ctx?.data?.prUrl ||
        result?.prUrl ||
        "",
      ).trim() || null,
    };
  }

  _summarizeTaskTraceNodeResult(result) {
    if (result == null) return null;
    if (typeof result === "string") {
      const text = result.trim();
      return text.length > 240 ? `${text.slice(0, 239)}…` : text;
    }
    if (typeof result === "number" || typeof result === "boolean") {
      return String(result);
    }
    if (Array.isArray(result)) {
      return `array(${result.length})`;
    }
    if (typeof result === "object") {
      if (result.error) return String(result.error);
      if (result.message) return String(result.message);
      if (result.output && typeof result.output === "string") {
        const text = result.output.trim();
        return text.length > 240 ? `${text.slice(0, 239)}…` : text;
      }
      const keys = Object.keys(result).filter(Boolean).slice(0, 8);
      return keys.length ? `object{${keys.join(",")}}` : "object";
    }
    return null;
  }

  _appendTaskTraceToContext(ctx, event) {
    if (!ctx?.data || typeof ctx.data !== "object") return;
    const existing = Array.isArray(ctx.data._taskWorkflowEvents)
      ? ctx.data._taskWorkflowEvents
      : [];
    existing.push(event);
    if (existing.length > MAX_TASK_TRACE_EVENTS_PER_RUN) {
      ctx.data._taskWorkflowEvents = existing.slice(-MAX_TASK_TRACE_EVENTS_PER_RUN);
      return;
    }
    ctx.data._taskWorkflowEvents = existing;
  }

  async _dispatchTaskTrace(event) {
    const handlers = [];
    for (const hook of this._taskTraceHooks) {
      if (typeof hook === "function") handlers.push(hook);
    }

    const directHandler = this.services?.onTaskWorkflowEvent;
    if (typeof directHandler === "function") handlers.push(directHandler);

    const serviceObjects = [
      this.services?.taskTraceCollector,
      this.services?.taskTimeline,
      this.services?.taskEvents,
      this.services?.taskState,
    ].filter(Boolean);
    const methodNames = [
      "onTaskWorkflowEvent",
      "collectTaskWorkflowEvent",
      "appendWorkflowEvent",
      "collect",
      "append",
      "handleEvent",
    ];
    for (const service of serviceObjects) {
      for (const methodName of methodNames) {
        const fn = service?.[methodName];
        if (typeof fn === "function") {
          handlers.push((payload) => fn.call(service, payload));
          break;
        }
      }
    }

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (err) {
        console.warn(
          `${TAG} task trace handler failed: ${String(err?.message || err)}`,
        );
      }
    }
  }

  async _emitTaskTraceEvent(kind, {
    ctx,
    workflowId,
    workflowName,
    runId,
    node = null,
    result = null,
    status = null,
    error = null,
    durationMs = null,
    extra = null,
  } = {}) {
    const taskContext = this._resolveTaskTraceContext(ctx, node, result);
    if (!taskContext) return null;

    const nowMs = Date.now();
    const activeTrace = getCurrentTraceContext();
    const event = {
      eventType: String(kind || "").trim(),
      timestamp: new Date(nowMs).toISOString(),
      timestampMs: nowMs,
      taskId: taskContext.taskId,
      taskTitle: taskContext.taskTitle,
      workflowId: workflowId || ctx?.data?._workflowId || null,
      workflowName: workflowName || ctx?.data?._workflowName || null,
      runId: runId || ctx?.id || null,
      status: status || null,
      nodeId: node?.id || null,
      nodeType: node?.type || null,
      nodeLabel: node?.label || null,
      summary: this._summarizeTaskTraceNodeResult(result),
      error: error ? String(error) : null,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : null,
      branch: taskContext.branch,
      prNumber: taskContext.prNumber,
      prUrl: taskContext.prUrl,
      traceId: activeTrace?.traceId || null,
      spanId: activeTrace?.spanId || null,
      parentSpanId: activeTrace?.parentSpanId || null,
      meta: extra && typeof extra === "object" ? extra : null,
    };

    this._appendTaskTraceToContext(ctx, event);
    this.emit("task:trace", event);
    await this._dispatchTaskTrace(event);
    return event;
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
        const def = hydrateWorkflowDefinition(JSON.parse(raw));
        if (def.id) {
          this._workflows.set(def.id, def);
        }
      } catch (err) {
        console.error(`${TAG} Failed to load workflow ${file}:`, err.message);
      }
    }
    this._loaded = true;
    this.emit("loaded", { count: this._workflows.size });

    // Detect runs that were interrupted by a previous shutdown.
    // These are runs persisted to disk with status=RUNNING that are
    // NOT in our in-memory _activeRuns (because we just booted).
    if (this.detectInterruptedRuns) {
      this._detectInterruptedRuns();
    }
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
      core: w.core === true,
      trigger: w.trigger,
      nodeCount: w.nodes?.length || 0,
      edgeCount: w.edges?.length || 0,
      metadata: w.metadata,
    }));
  }

  /** Get a single workflow definition */
  get(id) {
    if (!this._loaded) this.load();
    const workflowId = String(id || "").trim();
    if (!workflowId) return null;
    const exact = this._workflows.get(workflowId);
    if (exact) return exact;
    for (const workflow of this._workflows.values()) {
      if (workflow?.metadata?.installedFrom === workflowId) {
        return workflow;
      }
    }
    return null;
  }

  /** Save (create or update) a workflow definition */
  save(def) {
    def = hydrateWorkflowDefinition(def, { strict: true });
    if (!def.id) def.id = randomUUID();
    if (!def.metadata) def.metadata = {};
    def.metadata.updatedAt = new Date().toISOString();
    if (!def.metadata.createdAt) {
      def.metadata.createdAt = def.metadata.updatedAt;
    }
    def.metadata.version = (def.metadata.version || 0) + 1;

    // Prevent disabling core workflows
    const existing = this._workflows.get(def.id);
    if (existing?.core === true && def.enabled === false) {
      def.enabled = true;
    }
    // Preserve core flag — cannot be removed via save
    if (existing?.core === true) {
      def.core = true;
    }

    this._ensureDirs();
    this._workflows.set(def.id, def);
    const filePath = resolve(this.workflowDir, `${def.id}.json`);
    writeFileSync(filePath, JSON.stringify(def, null, 2), "utf8");
    this.emit("saved", { id: def.id, name: def.name });

    // ── Grouped flows: auto-enable required sibling workflows ───────────
    // When a template-backed workflow is enabled, ensure all workflows from
    // its requiredTemplates group are also enabled so chains don't break.
    if (def.enabled !== false && def.metadata?.installedFrom) {
      this._autoEnableGroupedWorkflows(def);
    }

    return def;
  }

  /**
   * When a workflow from a grouped template is enabled, find sibling
   * workflows installed from that template's requiredTemplates and enable
   * them if they're currently disabled.
   * @private
   */
  _autoEnableGroupedWorkflows(def) {
    try {
      // requiredTemplates is stored in the workflow's own metadata
      // (carried over from the template definition during install)
      const requiredIds = def.metadata?.requiredTemplates;
      if (!Array.isArray(requiredIds) || requiredIds.length === 0) return;

      for (const depId of requiredIds) {
        for (const [, wf] of this._workflows) {
          if (wf.metadata?.installedFrom === depId && wf.enabled === false) {
            wf.enabled = true;
            wf.metadata.updatedAt = new Date().toISOString();
            wf.metadata.version = (wf.metadata.version || 0) + 1;
            const fp = resolve(this.workflowDir, `${wf.id}.json`);
            writeFileSync(fp, JSON.stringify(wf, null, 2), "utf8");
            this.emit("saved", { id: wf.id, name: wf.name });
          }
        }
      }
    } catch {
      /* best-effort — should not crash save() */
    }
  }

  /** Delete a workflow */
  delete(id) {
    const existing = this._workflows.get(id);
    if (existing?.core === true) {
      throw new Error(`Cannot delete core workflow "${existing.name || id}"`);
    }
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

  // ── Concurrency Stats ───────────────────────────────────────────────

  /**
   * Return live concurrency stats for monitoring / dashboards.
   * @returns {{ activeRuns: number, maxConcurrentRuns: number, queuedRuns: number, maxConcurrentBranches: number }}
   */
  getConcurrencyStats() {
    return {
      activeRuns: this._runSlots,
      maxConcurrentRuns: MAX_CONCURRENT_RUNS,
      queuedRuns: this._runQueue.length,
      maxConcurrentBranches: MAX_CONCURRENT_BRANCHES,
    };
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
    const persistedDef = this.get(workflowId);
    if (!persistedDef) throw new Error(`${TAG} Workflow "${workflowId}" not found`);
    const def = hydrateWorkflowDefinition(persistedDef, { strict: true });
    if (def.enabled === false && !opts.force) {
      throw new Error(`${TAG} Workflow "${def.name}" is disabled`);
    }

    // ── Concurrency gate ──────────────────────────────────────────────
    // If we're at capacity, queue this run and wait for a slot.
    if (this._runSlots >= MAX_CONCURRENT_RUNS) {
      this.emit("run:queued", { workflowId, name: def.name, queueDepth: this._runQueue.length + 1 });
      await new Promise((resolve, reject) => {
        this._runQueue.push({ resolve, reject });
      });
    }
    this._runSlots++;

    try {
      return await traceWorkflowRun(
        {
          workflowId,
          name: def.name,
          triggerSource: inputData?._triggerSource || null,
          taskId: resolveTraceTaskId(inputData),
          agentId: resolveTraceAgentId(inputData),
          parentRunId: opts._parentRunId || inputData?._workflowParentRunId || inputData?._parentRunId || null,
          rootRunId: opts._rootRunId || inputData?._workflowRootRunId || inputData?._rootRunId || null,
        },
        async (span) => {
          const ctx = await this._executeInner(def, workflowId, inputData, opts);
          span.attributes["bosun.workflow.run_id"] = ctx?.id || span.attributes["bosun.workflow.run_id"];
          span.attributes["bosun.workflow.parent_run_id"] =
            ctx?.data?._workflowParentRunId || span.attributes["bosun.workflow.parent_run_id"];
          span.attributes["bosun.workflow.root_run_id"] =
            ctx?.data?._workflowRootRunId || ctx?.id || span.attributes["bosun.workflow.root_run_id"];
          return ctx;
        },
      );
    } finally {
      this._runSlots--;
      // Wake the next queued run, if any
      if (this._runQueue.length > 0) {
        const next = this._runQueue.shift();
        next.resolve();
      }
    }
  }

  /**
   * Execute an ephemeral workflow definition without saving it to the registry.
   * Useful for inline/embedded workflow composition where the child flow should
   * have its own run/context history but not become an installed workflow.
   *
   * @param {object} workflowDef
   * @param {object} inputData
   * @param {object} [opts]
   * @returns {Promise<WorkflowContext>}
   */
  async executeDefinition(workflowDef, inputData = {}, opts = {}) {
    const requestedId = String(workflowDef?.id || opts.inlineWorkflowId || "").trim();
    const workflowId = requestedId || `inline:${randomUUID()}`;
    const normalized = hydrateWorkflowDefinition({
      enabled: true,
      trigger: workflowDef?.trigger || "trigger.workflow_call",
      ...workflowDef,
      id: workflowId,
      name: String(workflowDef?.name || opts.inlineWorkflowName || workflowId).trim() || workflowId,
      metadata: {
        ...(workflowDef?.metadata || {}),
        inline: true,
        ephemeral: true,
        sourceNodeId: opts.sourceNodeId || workflowDef?.metadata?.sourceNodeId || null,
      },
    }, { strict: true });

    if (normalized.enabled === false && !opts.force) {
      throw new Error(`${TAG} Inline workflow "${normalized.name}" is disabled`);
    }

    if (this._runSlots >= MAX_CONCURRENT_RUNS) {
      this.emit("run:queued", { workflowId: normalized.id, name: normalized.name, queueDepth: this._runQueue.length + 1 });
      await new Promise((resolve, reject) => {
        this._runQueue.push({ resolve, reject });
      });
    }
    this._runSlots++;

    try {
      return await traceWorkflowRun(
        {
          workflowId: normalized.id,
          name: normalized.name,
          triggerSource: inputData?._triggerSource || normalized.trigger || null,
          taskId: resolveTraceTaskId(inputData),
          agentId: resolveTraceAgentId(inputData, opts.sourceNodeId || ""),
          parentRunId: opts._parentRunId || inputData?._workflowParentRunId || inputData?._parentRunId || null,
          rootRunId: opts._rootRunId || inputData?._workflowRootRunId || inputData?._rootRunId || null,
        },
        async (span) => {
          const ctx = await this._executeInner(normalized, normalized.id, inputData, {
            ...opts,
            force: true,
          });
          span.attributes["bosun.workflow.run_id"] = ctx?.id || span.attributes["bosun.workflow.run_id"];
          span.attributes["bosun.workflow.parent_run_id"] =
            ctx?.data?._workflowParentRunId || span.attributes["bosun.workflow.parent_run_id"];
          span.attributes["bosun.workflow.root_run_id"] =
            ctx?.data?._workflowRootRunId || ctx?.id || span.attributes["bosun.workflow.root_run_id"];
          return ctx;
        },
      );
    } finally {
      this._runSlots--;
      if (this._runQueue.length > 0) {
        const next = this._runQueue.shift();
        next.resolve();
      }
    }
  }

  /**
   * Inner execute logic — called only once a concurrency slot is acquired.
   * @private
   */
  async _executeInner(def, workflowId, inputData, opts) {
    const initialData = this._applyResumeInputMigrations(def, {
      ...def.variables,
      ...inputData,
    });

    const ctx = new WorkflowContext({
      ...initialData,
      _workflowId: workflowId,
      _workflowName: def.name,
      _workflowDefinitionSnapshot: cloneRunSnapshot(def),
      ...(opts._decisionReason ? { _retryDecisionReason: opts._decisionReason } : {}),
      ...(opts._parentExecutionId ? { _workflowParentExecutionId: opts._parentExecutionId } : {}),
    });
    ctx.variables = { ...def.variables };
    this._initializeDagState(def, ctx, {
      rootRunId:
        opts._rootRunId ||
        initialData._workflowRootRunId ||
        initialData._rootRunId ||
        null,
      parentRunId:
        opts._parentRunId ||
        initialData._workflowParentRunId ||
        initialData._parentRunId ||
        null,
      retryOf: opts._originalRunId || initialData._retryOf || null,
      retryMode: opts._retryMode || null,
    });

    const runId = ctx.id;
    this._activeRuns.set(runId, {
      workflowId,
      workflowName: def.name,
      ctx,
      startedAt: ctx.startedAt,
      status: WorkflowStatus.RUNNING,
    });

    // ── Persist run immediately so it survives process restarts ──────
    this._persistActiveRunState(runId, workflowId, def.name, ctx);

    this.emit("run:start", { runId, workflowId, name: def.name });
    this._emitWorkflowStatus({
      runId,
      workflowId,
      workflowName: def.name,
      eventType: "run:start",
      status: WorkflowStatus.RUNNING,
      meta: {
        triggerSource: ctx.data?._triggerSource || null,
      },
    });
    this._recordLedgerEvent({
      eventType: "run.start",
      runId,
      workflowId,
      workflowName: def.name,
      rootRunId: ctx.data?._workflowRootRunId || runId,
      parentRunId: ctx.data?._workflowParentRunId || null,
      retryOf: ctx.data?._retryOf || null,
      retryMode: opts._retryMode || null,
      parentExecutionId: ctx.data?._workflowParentExecutionId || null,
      status: WorkflowStatus.RUNNING,
      meta: this._buildLedgerTaskMeta(ctx, {
        triggerSource: ctx.data?._triggerSource || null,
        targetRepo: ctx.data?._targetRepo || null,
        decisionReason: opts._decisionReason || null,
      }),
    });
    await this._emitTaskTraceEvent("workflow.run.start", {
      ctx,
      runId,
      workflowId,
      workflowName: def.name,
      status: WorkflowStatus.RUNNING,
    });

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

      const status = this._resolveWorkflowStatus(ctx);
      this._activeRuns.get(runId).status = status;
      this._refreshDagState(ctx, status);
      const terminalError = Array.isArray(ctx.errors) && ctx.errors.length
        ? String(ctx.errors[ctx.errors.length - 1]?.error || "").trim()
        : "";
      if (status === WorkflowStatus.FAILED && terminalError) {
        this.emit("run:error", { runId, workflowId, error: terminalError });
        this._emitWorkflowStatus({
          runId,
          workflowId,
          workflowName: def.name,
          eventType: "run:error",
          status: WorkflowStatus.FAILED,
          error: terminalError,
          durationMs: Date.now() - ctx.startedAt,
        });
      }
      this.emit("run:end", { runId, workflowId, status, duration: Date.now() - ctx.startedAt });
      this._emitWorkflowStatus({
        runId,
        workflowId,
        workflowName: def.name,
        eventType: "run:end",
        status,
        durationMs: Date.now() - ctx.startedAt,
      });
      this._recordLedgerEvent({
        eventType: "run.end",
        runId,
        workflowId,
        workflowName: def.name,
        rootRunId: ctx.data?._workflowRootRunId || runId,
        parentRunId: ctx.data?._workflowParentRunId || null,
        retryOf: ctx.data?._retryOf || null,
        retryMode: opts._retryMode || null,
        parentExecutionId: ctx.data?._workflowParentExecutionId || null,
        status,
        durationMs: Date.now() - ctx.startedAt,
        summary: ctx.data?._issueAdvisor?.summary || null,
        meta: this._buildLedgerTaskMeta(ctx, {
          decisionReason: opts._decisionReason || null,
        }),
      });
      await this._emitTaskTraceEvent("workflow.run.end", {
        ctx,
        runId,
        workflowId,
        workflowName: def.name,
        status,
        durationMs: Date.now() - ctx.startedAt,
      });
    } catch (err) {
      ctx.error("_engine", err);
      this._activeRuns.get(runId).status = WorkflowStatus.FAILED;
      this._refreshDagState(ctx, WorkflowStatus.FAILED);
      this.emit("run:error", { runId, workflowId, error: err.message });
      this._emitWorkflowStatus({
        runId,
        workflowId,
        workflowName: def.name,
        eventType: "run:error",
        status: WorkflowStatus.FAILED,
        error: err.message,
        durationMs: Date.now() - ctx.startedAt,
      });
      this._recordLedgerEvent({
        eventType: "run.error",
        runId,
        workflowId,
        workflowName: def.name,
        rootRunId: ctx.data?._workflowRootRunId || runId,
        parentRunId: ctx.data?._workflowParentRunId || null,
        retryOf: ctx.data?._retryOf || null,
        retryMode: opts._retryMode || null,
        parentExecutionId: ctx.data?._workflowParentExecutionId || null,
        status: WorkflowStatus.FAILED,
        durationMs: Date.now() - ctx.startedAt,
        error: err.message,
        summary: ctx.data?._issueAdvisor?.summary || null,
        meta: this._buildLedgerTaskMeta(ctx, {
          decisionReason: opts._decisionReason || null,
        }),
      });
      await this._emitTaskTraceEvent("workflow.run.error", {
        ctx,
        runId,
        workflowId,
        workflowName: def.name,
        status: WorkflowStatus.FAILED,
        error: err?.message || String(err),
        durationMs: Date.now() - ctx.startedAt,
      });
    }

    // Persist final run log and remove from active-runs index
    this._persistRun(runId, workflowId, ctx);
    this._clearActiveRunState(runId);
    this._activeRuns.delete(runId);

    // ── Auto-retry on failure ───────────────────────────────────────────
    // If the workflow failed and auto-retry is enabled, kick off the
    // escalating retry strategy asynchronously. The caller still receives the
    // original (failed) context immediately so we never block the event loop.
    const finalStatus = this._resolveWorkflowStatus(ctx);
    if (finalStatus === WorkflowStatus.FAILED && !opts._isRetry) {
      const retryConfig = this._resolveAutoRetryConfig(def);
      if (retryConfig.enabled) {
        // Fire-and-forget — errors are logged, never thrown.
        this._autoRetryLoop(runId, workflowId, inputData, retryConfig, opts).catch((err) => {
          console.error(`${TAG} Auto-retry loop error for run ${runId}:`, err.message);
        });
      }
    }

    return ctx;
  }

  // ── Run Retry ───────────────────────────────────────────────────────────

  /**
   * Retry a previously completed (failed) run.
   *
   * @param {string} runId - The original run ID to retry.
   * @param {object} [retryOpts]
   * @param {"from_failed"|"from_scratch"} [retryOpts.mode="from_failed"]
   *   - `"from_failed"` — re-execute starting from the first failed node,
   *     pre-populating the context with already-completed node outputs.
   *   - `"from_scratch"` — re-execute the entire workflow from the beginning
   *     with the same input data that was used originally.
   * @returns {Promise<{retryRunId: string, mode: string, ctx: WorkflowContext}>}
   */
  async retryRun(runId, retryOpts = {}) {
    const mode = retryOpts.mode === "from_scratch" ? "from_scratch" : "from_failed";
    const decisionReason = String(retryOpts._decisionReason || "").trim() || null;
    const originalRun = this.getRunDetail(runId);
    if (!originalRun) {
      throw new Error(`${TAG} Run "${runId}" not found — cannot retry`);
    }

    const workflowId = originalRun.workflowId || originalRun.detail?.data?._workflowId;
    if (!workflowId) {
      throw new Error(`${TAG} Cannot determine workflowId from run "${runId}"`);
    }

    const def = this.get(workflowId);
    if (!def) {
      throw new Error(`${TAG} Workflow "${workflowId}" no longer exists — cannot retry`);
    }

    // Recover original input data (strip internal enrichment keys).
    const originalData = { ...(originalRun.detail?.data || {}) };
    delete originalData._workflowId;
    delete originalData._workflowName;
    const retryData = this._applyResumeInputMigrations(def, originalData);

    this.emit("run:retry", {
      originalRunId: runId,
      workflowId,
      mode,
      attempt: retryOpts._attempt || 1,
      decisionReason,
    });

    if (mode === "from_scratch") {
      const originalRootRunId =
        originalRun.detail?.dagState?.rootRunId ||
        originalRun.detail?.data?._workflowRootRunId ||
        originalRun.runId ||
        runId;
      const ctx = await this.execute(workflowId, retryData, {
        ...retryOpts,
        _isRetry: true,
        _originalRunId: runId,
        _parentRunId: runId,
        _rootRunId: originalRootRunId,
        _retryMode: mode,
        _dagRevisionReason: "retry_replan_subgraph",
        force: true,
      });
      return { retryRunId: ctx.id, mode, originalRunId: runId, ctx };
    }

    // ── "from_failed" — resume from the first failed node ────────────
    const detail = originalRun.detail || {};
    const nodeStatuses = detail.nodeStatuses || {};
    const nodeOutputs = detail.nodeOutputs || {};

    // Build a fresh context but pre-seed completed node outputs.
    const ctx = new WorkflowContext({
      ...def.variables,
      ...retryData,
      _workflowId: workflowId,
      _workflowName: def.name,
      _retryOf: runId,
    });
    ctx.variables = { ...def.variables };
    this._initializeDagState(def, ctx, {
      rootRunId:
        originalRun.detail?.dagState?.rootRunId ||
        originalRun.detail?.data?._workflowRootRunId ||
        runId,
      parentRunId: runId,
      retryOf: runId,
      retryMode: mode,
    });

    // Pre-populate nodes that already succeeded.
    const preservedCompletedNodeIds = [];
    const focusNodeIds = [];
    for (const [nodeId, status] of Object.entries(nodeStatuses)) {
      if (status === NodeStatus.COMPLETED) {
        preservedCompletedNodeIds.push(nodeId);
        ctx.setNodeStatus(nodeId, NodeStatus.COMPLETED);
        if (nodeOutputs[nodeId] !== undefined) {
          ctx.setNodeOutput(nodeId, nodeOutputs[nodeId]);
        }
        this._recordDagNodeOutcome(ctx, { id: nodeId }, {
          status: NodeStatus.COMPLETED,
          result: nodeOutputs[nodeId],
        });
      } else if (status) {
        focusNodeIds.push(nodeId);
      }
      // Reset failed / skipped nodes so the DAG will re-run them.
    }

    this._recordDagRevision(ctx, {
      reason: "retry_resume",
      sourceRunId: runId,
      preservedCompletedNodeIds,
    });

    this._recordDagRevision(ctx, {
      reason: mode === "from_failed" ? "retry_replan_from_failed" : `retry_${mode}`,
      sourceRunId: runId,
      preservedCompletedNodeIds,
      focusNodeIds,
    });

    const retryRunId = ctx.id;
    this._activeRuns.set(retryRunId, {
      workflowId,
      workflowName: def.name,
      ctx,
      startedAt: ctx.startedAt,
      status: WorkflowStatus.RUNNING,
    });
    this._persistActiveRunState(retryRunId, workflowId, def.name, ctx);
    this.emit("run:start", { runId: retryRunId, workflowId, name: def.name, retryOf: runId, mode });
    this._emitWorkflowStatus({
      runId: retryRunId,
      workflowId,
      workflowName: def.name,
      eventType: "run:start",
      status: WorkflowStatus.RUNNING,
      meta: { retryOf: runId, mode },
    });
    this._recordLedgerEvent({
      eventType: "run.start",
      runId: retryRunId,
      workflowId,
      workflowName: def.name,
      rootRunId: ctx.data?._workflowRootRunId || retryRunId,
      parentRunId: runId,
      retryOf: runId,
      retryMode: mode,
      status: WorkflowStatus.RUNNING,
      meta: this._buildLedgerTaskMeta(ctx, {
        decisionReason,
      }),
    });
    await this._emitTaskTraceEvent("workflow.run.start", {
      ctx,
      runId: retryRunId,
      workflowId,
      workflowName: def.name,
      status: WorkflowStatus.RUNNING,
      extra: { retryOf: runId, mode },
    });

    try {
      const adjacency = this._buildAdjacency(def);
      const entryNodes = this._findEntryNodes(def);
      if (entryNodes.length === 0) {
        throw new Error("Workflow has no entry nodes (no triggers or unconnected nodes)");
      }

      // _executeDag naturally skips nodes that are already COMPLETED because
      // they were pre-seeded above, so it resumes from the failed point.
      await this._executeDag(def, entryNodes, adjacency, ctx, { ...retryOpts, _isRetry: true });

      const status = this._resolveWorkflowStatus(ctx);
      this._activeRuns.get(retryRunId).status = status;
      this._refreshDagState(ctx, status);
      this.emit("run:end", {
        runId: retryRunId,
        workflowId,
        status,
        duration: Date.now() - ctx.startedAt,
        retryOf: runId,
        mode,
      });
      this._emitWorkflowStatus({
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        eventType: "run:end",
        status,
        durationMs: Date.now() - ctx.startedAt,
        meta: { retryOf: runId, mode },
      });
      this._recordLedgerEvent({
        eventType: "run.end",
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        rootRunId: ctx.data?._workflowRootRunId || retryRunId,
        parentRunId: runId,
        retryOf: runId,
        retryMode: mode,
        status,
        durationMs: Date.now() - ctx.startedAt,
        summary: ctx.data?._issueAdvisor?.summary || null,
        meta: {
          decisionReason,
        },
      });
      await this._emitTaskTraceEvent("workflow.run.end", {
        ctx,
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        status,
        durationMs: Date.now() - ctx.startedAt,
        extra: { retryOf: runId, mode },
      });
    } catch (err) {
      ctx.error("_engine", err);
      this._activeRuns.get(retryRunId).status = WorkflowStatus.FAILED;
      this._refreshDagState(ctx, WorkflowStatus.FAILED);
      this.emit("run:error", { runId: retryRunId, workflowId, error: err.message, retryOf: runId });
      this._emitWorkflowStatus({
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        eventType: "run:error",
        status: WorkflowStatus.FAILED,
        error: err.message,
        durationMs: Date.now() - ctx.startedAt,
        meta: { retryOf: runId, mode },
      });
      this._recordLedgerEvent({
        eventType: "run.error",
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        rootRunId: ctx.data?._workflowRootRunId || retryRunId,
        parentRunId: runId,
        retryOf: runId,
        retryMode: mode,
        status: WorkflowStatus.FAILED,
        durationMs: Date.now() - ctx.startedAt,
        error: err.message,
        summary: ctx.data?._issueAdvisor?.summary || null,
        meta: {
          decisionReason,
        },
      });
      await this._emitTaskTraceEvent("workflow.run.error", {
        ctx,
        runId: retryRunId,
        workflowId,
        workflowName: def.name,
        status: WorkflowStatus.FAILED,
        error: err?.message || String(err),
        durationMs: Date.now() - ctx.startedAt,
        extra: { retryOf: runId, mode },
      });
    }

    this._persistRun(retryRunId, workflowId, ctx);
    this._clearActiveRunState(retryRunId);
    this._activeRuns.delete(retryRunId);

    return { retryRunId, mode, originalRunId: runId, ctx };
  }

  // ── Auto-retry escalating strategy ───────────────────────────────────

  /**
   * Resolve the auto-retry configuration for a workflow definition.
   * Supports per-workflow overrides via `def.autoRetry`.
   */
  _resolveAutoRetryConfig(def) {
    const raw = def?.autoRetry || {};
    // Auto-retry is opt-in: workflows must explicitly set autoRetry.enabled = true.
    // This prevents unexpected background retries for workflows that don't want them.
    const enabled = Boolean(raw.enabled);
    const maxAttempts = Number.isFinite(Number(raw.maxAttempts))
      ? Math.max(0, Math.trunc(Number(raw.maxAttempts)))
      : DEFAULT_AUTO_RETRY_MAX_ATTEMPTS;
    const cooldownMs = Number.isFinite(Number(raw.cooldownMs))
      ? Math.max(0, Math.trunc(Number(raw.cooldownMs)))
      : DEFAULT_AUTO_RETRY_COOLDOWN_MS;
    return { enabled: enabled && maxAttempts > 0, maxAttempts, cooldownMs };
  }

  _resolveWorkflowStatus(ctx) {
    const terminalRaw = String(ctx?.data?._workflowTerminalStatus || "")
      .trim()
      .toLowerCase();
    if (terminalRaw === WorkflowStatus.FAILED || terminalRaw === "error") {
      return WorkflowStatus.FAILED;
    }
    if (terminalRaw === WorkflowStatus.CANCELLED) {
      return WorkflowStatus.CANCELLED;
    }
    if (terminalRaw === WorkflowStatus.COMPLETED || terminalRaw === "success") {
      return WorkflowStatus.COMPLETED;
    }
    return ctx.errors.length > 0 ? WorkflowStatus.FAILED : WorkflowStatus.COMPLETED;
  }

  _chooseRetryModeFromDetail(detail, options = {}) {
    const fallbackMode = options.fallbackMode === "from_scratch"
      ? "from_scratch"
      : "from_failed";
    const issueAdvisor =
      detail?.issueAdvisor && typeof detail.issueAdvisor === "object"
        ? detail.issueAdvisor
        : null;
    const dagCounts =
      detail?.dagState?.counts && typeof detail.dagState.counts === "object"
        ? detail.dagState.counts
        : null;
    const counts = dagCounts || this._countNodeStatuses(detail?.nodeStatuses || {});
    const completedCount = Number(counts.completed ?? counts.completedCount ?? 0) || 0;
    const failedCount = Number(counts.failed ?? counts.failedCount ?? 0) || 0;

    let mode = fallbackMode;
    let reason = `fallback:${fallbackMode}`;

    if (issueAdvisor?.recommendedAction === "resume_remaining") {
      mode = "from_failed";
      reason = "issue_advisor.resume_remaining";
    } else if (issueAdvisor?.recommendedAction === "rerun_same_step") {
      mode = "from_failed";
      reason = "issue_advisor.rerun_same_step";
    } else if (issueAdvisor?.recommendedAction === "spawn_fix_step") {
      mode = "from_failed";
      reason = "issue_advisor.spawn_fix_step";
    } else if (issueAdvisor?.recommendedAction === "replan_subgraph") {
      mode = "from_scratch";
      reason = "issue_advisor.replan_subgraph";
    } else if (issueAdvisor?.recommendedAction === "replan_from_failed") {
      mode = "from_scratch";
      reason = "issue_advisor.replan_from_failed";
    } else if (issueAdvisor?.recommendedAction === "inspect_failure") {
      mode = "from_scratch";
      reason = "issue_advisor.inspect_failure";
    } else if (completedCount <= 0) {
      mode = "from_scratch";
      reason = "dag_state.no_completed_nodes";
    } else if (failedCount > 1) {
      mode = "from_scratch";
      reason = "dag_state.multiple_failures";
    } else if (completedCount > 0) {
      mode = "from_failed";
      reason = "dag_state.localized_resume";
    }

    return {
      mode,
      reason,
      fallbackMode,
      completedCount,
      failedCount,
      issueAdvisorRecommendation: issueAdvisor?.recommendedAction || null,
      issueAdvisorSummary: issueAdvisor?.summary || null,
    };
  }

  _chooseRetryModeForRun(runDetail, options = {}) {
    return this._chooseRetryModeFromDetail(runDetail?.detail || {}, options);
  }

  /**
   * Escalating auto-retry loop.
   *
   * Strategy (configurable, defaults to 3 attempts):
   *   Attempt 1 → from_failed (immediate)
   *   Attempt 2 → from_scratch (immediate)
   *   Attempt 3 → from_scratch (after cooldown period, default 20 min)
   *
   * If the workflow succeeds at any point the loop stops.
   * Results are persisted as separate runs linked via `_retryOf`.
   */
  async _autoRetryLoop(originalRunId, workflowId, inputData, retryConfig, baseOpts) {
    const { maxAttempts, cooldownMs } = retryConfig;
    const originalRun = this.getRunDetail(originalRunId);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const retryDecision = this._chooseRetryModeForRun(originalRun, {
        fallbackMode: attempt === 1 ? "from_failed" : "from_scratch",
      });
      const mode = attempt === 1 ? retryDecision.mode : "from_scratch";
      const needsCooldown = attempt >= 3 && cooldownMs > 0;

      if (needsCooldown) {
        console.log(
          `${TAG} Auto-retry attempt ${attempt}/${maxAttempts} for run ${originalRunId} ` +
          `— cooling down for ${Math.round(cooldownMs / 1000)}s before retry`,
        );
        this.emit("run:retry:cooldown", {
          originalRunId,
          workflowId,
          attempt,
          cooldownMs,
        });
        await new Promise((r) => setTimeout(r, cooldownMs));
      }

      console.log(
        `${TAG} Auto-retry attempt ${attempt}/${maxAttempts} for run ${originalRunId} ` +
        `(mode=${mode}, reason=${retryDecision.reason})`,
      );

      try {
        const { ctx, retryRunId } = await this.retryRun(originalRunId, {
          mode,
          _isRetry: true,
          _attempt: attempt,
          _decisionReason: retryDecision.reason,
        });

        if (!ctx.errors || ctx.errors.length === 0) {
          console.log(
            `${TAG} Auto-retry succeeded on attempt ${attempt}/${maxAttempts} ` +
            `for run ${originalRunId} → new run ${retryRunId}`,
          );
          this.emit("run:retry:success", {
            originalRunId,
            retryRunId,
            workflowId,
            attempt,
            mode,
            decisionReason: retryDecision.reason,
          });
          return; // Success — stop retrying
        }

        console.warn(
          `${TAG} Auto-retry attempt ${attempt}/${maxAttempts} failed ` +
          `for run ${originalRunId} → new run ${retryRunId}`,
        );
        this.emit("run:retry:failed", {
          originalRunId,
          retryRunId,
          workflowId,
          attempt,
          mode,
          decisionReason: retryDecision.reason,
          errors: ctx.errors,
        });
      } catch (err) {
        console.error(
          `${TAG} Auto-retry attempt ${attempt}/${maxAttempts} threw for run ${originalRunId}:`,
          err.message,
        );
        this.emit("run:retry:failed", {
          originalRunId,
          workflowId,
          attempt,
          mode,
          decisionReason: retryDecision.reason,
          errors: [{ error: err.message }],
        });
      }
    }

    console.error(
      `${TAG} All ${maxAttempts} auto-retry attempts exhausted for run ${originalRunId}`,
    );
    this.emit("run:retry:exhausted", { originalRunId, workflowId, maxAttempts });
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
          tNode.type !== "trigger.webhook" &&
          tNode.type !== "trigger.meeting.wake_phrase"
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
        if (tNode.type === "trigger.meeting.wake_phrase") {
          const meetingEvent =
            eventType === "meeting.transcript" ||
            eventType === "voice.transcript" ||
            eventType === "meeting.wake_phrase";
          if (!meetingEvent) continue;
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

  // ── Schedule trigger evaluation ──────────────────────────────────────────

  /**
   * Evaluate polling workflows.
   * Unlike evaluateTriggers() (event-driven), this is polling-based and should
   * be called periodically (e.g. every 60s) by the monitor.
   *
   * Returns an array of { workflowId, triggeredBy, workspaceId } for workflows
   * whose polling interval has elapsed since their last completed run.
   *
   * @param {{ configDir?: string }} [opts] Options for workspace-aware evaluation.
   */
  evaluateScheduleTriggers(opts = {}) {
    if (!this._loaded) this.load();

    const triggered = [];
    const runIndex = this._readRunIndex();

    // Load workspace state for filtering
    const wsMgr = ensureWorkspaceManagerSync();
    const configDir = opts?.configDir || this._configDir || process.cwd();
    let workspaceSummary = null;
    if (wsMgr?.getWorkspaceStateSummary) {
      try {
        workspaceSummary = wsMgr.getWorkspaceStateSummary(configDir);
      } catch { /* workspace manager not available — skip workspace filtering */ }
    }

    for (const [id, def] of this._workflows) {
      if (def.enabled === false) continue;

      // ── Workspace gate ──────────────────────────────────────────────
      const wfWorkspaceId = def.workspaceId || def.workspace || null;
      if (wfWorkspaceId && workspaceSummary) {
        const ws = workspaceSummary.find((w) => w.id === wfWorkspaceId);
        if (ws && !ws.isActive) {
          continue; // workspace paused or disabled — skip
        }
        if (ws && wsMgr?.isWorkflowAllowedForWorkspace) {
          const fullWs = wsMgr.getWorkspace(configDir, wfWorkspaceId);
          if (fullWs && !wsMgr.isWorkflowAllowedForWorkspace(fullWs, id)) {
            continue; // workflow blacklisted or not in whitelist for this workspace
          }
        }
      }

      // Skip workflows that are already running
      const alreadyRunning = Array.from(this._activeRuns.values()).some(
        (info) => info?.workflowId === id,
      );
      if (alreadyRunning) continue;

      const triggerNodes = (def.nodes || []).filter((n) =>
        n.type === "trigger.schedule"
        || n.type === "trigger.scheduled_once"
        || n.type === "trigger.task_available"
        || n.type === "trigger.task_low",
      );

      const scheduleCtx = new WorkflowContext({
        ...(def.variables || {}),
        ...(def.data || {}),
      });

      const resolvePositiveInterval = (rawValue, fallbackMs) => {
        const resolved = scheduleCtx.resolve(rawValue);
        const parsed = Number(resolved);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
      };

      for (const tNode of triggerNodes) {
        let intervalMs = 3600000;
        if (tNode.type === "trigger.task_available") {
          intervalMs = resolvePositiveInterval(tNode.config?.pollIntervalMs, 30000);
        } else if (tNode.type === "trigger.task_low") {
          intervalMs = resolvePositiveInterval(tNode.config?.pollIntervalMs, 60000);
        } else {
          intervalMs = resolvePositiveInterval(tNode.config?.intervalMs, 3600000);
        }

        // Find the most recent completed run for this workflow
        let lastRunAt = 0;
        for (const entry of runIndex) {
          if (entry?.workflowId !== id) continue;
          const ts = Number(entry?.startedAt || entry?.completedAt || 0);
          if (ts > lastRunAt) lastRunAt = ts;
        }

        const elapsed = Date.now() - lastRunAt;
        if (elapsed >= intervalMs) {
          triggered.push({ workflowId: id, triggeredBy: tNode.id, workspaceId: wfWorkspaceId });

          // For scheduled_once, only fire if never run before
          if (tNode.type === "trigger.scheduled_once" && lastRunAt > 0) {
            triggered.pop(); // undo — already ran once
          }
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
  getRunHistory(workflowId, limit = null) {
    const normalizedLimit = Number(limit);
    const hasLimit = Number.isFinite(normalizedLimit) && normalizedLimit > 0;
    const targetCount = hasLimit
      ? Math.min(MAX_PERSISTED_RUNS, Math.max(Math.floor(normalizedLimit), 200))
      : MAX_PERSISTED_RUNS;
    const persisted = this._hydrateRunIndexFromDetails(targetCount)
      .map((entry) => this._normalizeRunSummary(entry))
      .filter(Boolean);
    const active = this.getActiveRuns();
    const activeRunIds = new Set(active.map((run) => run.runId));

    let runs = [...active, ...persisted.filter((run) => !activeRunIds.has(run.runId))];
    if (workflowId) runs = runs.filter((r) => r.workflowId === workflowId);
    runs = runs.map((run) => this.getRunDetail(run.runId) || run);
    runs.sort((a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0));
    if (hasLimit) {
      return runs.slice(0, Math.floor(normalizedLimit));
    }
    return runs;
  }

  getRunHistoryPage(workflowId, options = {}) {
    const rawOffset = Number(options?.offset);
    const rawLimit = Number(options?.limit);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0
      ? Math.max(0, Math.floor(rawOffset))
      : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(MAX_PERSISTED_RUNS, Math.max(1, Math.floor(rawLimit)))
      : 20;
    const allRuns = this.getRunHistory(workflowId);
    const total = allRuns.length;
    const runs = allRuns.slice(offset, offset + limit);
    const nextOffset = offset + runs.length;
    return {
      runs,
      total,
      offset,
      limit,
      count: runs.length,
      hasMore: nextOffset < total,
      nextOffset: nextOffset < total ? nextOffset : null,
    };
  }

  _hydrateRunIndexFromDetails(targetCount = MAX_PERSISTED_RUNS) {
    const normalizedTarget = Number.isFinite(Number(targetCount)) && Number(targetCount) > 0
      ? Math.min(MAX_PERSISTED_RUNS, Math.max(20, Math.floor(Number(targetCount))))
      : MAX_PERSISTED_RUNS;
    const runs = this._readRunIndex();
    if (runs.length >= normalizedTarget) return runs;
    if (!existsSync(this.runsDir)) return runs;

    try {
      const seen = new Set(
        runs
          .map((entry) => String(entry?.runId || "").trim())
          .filter(Boolean),
      );
      const detailFiles = readdirSync(this.runsDir)
        .filter((file) =>
          extname(file) === ".json" &&
          file !== "index.json" &&
          file !== ACTIVE_RUNS_INDEX,
        )
        .map((file) => {
          const detailPath = resolve(this.runsDir, file);
          let mtimeMs = 0;
          try {
            mtimeMs = statSync(detailPath).mtimeMs || 0;
          } catch {
            mtimeMs = 0;
          }
          return { file, detailPath, mtimeMs };
        })
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

      let didHydrate = false;
      for (const detailFile of detailFiles) {
        if (runs.length >= normalizedTarget) break;
        const runId = basename(detailFile.file, ".json");
        if (!runId || seen.has(runId)) continue;
        try {
          const detail = JSON.parse(readFileSync(detailFile.detailPath, "utf8"));
          const summary = this._buildSummaryFromDetail({
            runId,
            workflowId: detail?.data?._workflowId || null,
            workflowName: detail?.data?._workflowName || null,
            status: detail?.status || WorkflowStatus.COMPLETED,
            detail,
          });
          if (!summary) continue;
          runs.push(summary);
          seen.add(runId);
          didHydrate = true;
        } catch {
          // ignore malformed legacy run files
        }
      }

      if (!didHydrate) return runs;

      runs.sort((a, b) => Number(a?.startedAt || 0) - Number(b?.startedAt || 0));
      if (runs.length > MAX_PERSISTED_RUNS) {
        runs.splice(0, runs.length - MAX_PERSISTED_RUNS);
      }
      const indexPath = resolve(this.runsDir, "index.json");
      writeFileSync(indexPath, JSON.stringify({ runs }, null, 2), "utf8");
      return runs;
    } catch {
      return runs;
    }
  }

  /**
   * Request cancellation for a running workflow run.
   * Cancellation is cooperative: currently running nodes are allowed to finish,
   * then the DAG exits with status "cancelled" before scheduling new work.
   */
  cancelRun(runId, opts = {}) {
    const normalizedRunId = basename(String(runId || "")).replace(/\.json$/i, "");
    if (!normalizedRunId) {
      return { ok: false, error: "runId is required" };
    }

    const active = this._activeRuns.get(normalizedRunId);
    if (!active) {
      const existing = this.getRunDetail(normalizedRunId);
      if (!existing) {
        return { ok: false, error: "Workflow run not found", runId: normalizedRunId };
      }
      return {
        ok: false,
        error: `Workflow run is not active (status=${existing.status || "unknown"})`,
        runId: normalizedRunId,
        status: existing.status || "unknown",
      };
    }

    if (active.cancelRequested) {
      return {
        ok: true,
        alreadyRequested: true,
        runId: normalizedRunId,
        status: active.status || WorkflowStatus.RUNNING,
        cancelRequestedAt: active.cancelRequestedAt || Date.now(),
      };
    }

    const reason = String(opts?.reason || "Run cancelled by user").trim() || "Run cancelled by user";
    active.cancelRequested = true;
    active.cancelRequestedAt = Date.now();
    active.cancelReason = reason;
    if (active.ctx?.data && typeof active.ctx.data === "object") {
      active.ctx.data._workflowCancelRequested = true;
      active.ctx.data._workflowCancelReason = reason;
      active.ctx.data._workflowCancelRequestedAt = active.cancelRequestedAt;
    }
    this.emit("run:cancel:requested", {
      runId: normalizedRunId,
      workflowId: active.workflowId || null,
      workflowName: active.workflowName || null,
      reason,
      requestedAt: active.cancelRequestedAt,
    });
    this._recordLedgerEvent({
      eventType: "run.cancel.requested",
      runId: normalizedRunId,
      workflowId: active.workflowId || null,
      workflowName: active.workflowName || null,
      rootRunId: active.ctx?.data?._workflowRootRunId || normalizedRunId,
      parentRunId: active.ctx?.data?._workflowParentRunId || null,
      retryOf: active.ctx?.data?._retryOf || null,
      status: active.status || WorkflowStatus.RUNNING,
      reason,
    });
    if (active.ctx) this._checkpointRun(active.ctx);

    return {
      ok: true,
      runId: normalizedRunId,
      status: active.status || WorkflowStatus.RUNNING,
      cancelRequested: true,
      cancelRequestedAt: active.cancelRequestedAt,
      reason,
    };
  }

  _buildExecutionTree(runGraph, startRunId) {
    if (!runGraph || !Array.isArray(runGraph.runs) || runGraph.runs.length === 0) return null;
    const runMap = new Map(runGraph.runs.map((entry) => [entry.runId, { ...entry, children: [] }]));
    for (const edge of Array.isArray(runGraph.edges) ? runGraph.edges : []) {
      if (edge?.type !== "parent-child") continue;
      const parent = runMap.get(edge.parentRunId);
      const child = runMap.get(edge.childRunId);
      if (parent && child) parent.children.push(child);
    }
    const requestedRunId = String(startRunId || runGraph.requestedRunId || runGraph.rootRunId || "").trim();
    return runMap.get(requestedRunId) || runMap.get(runGraph.rootRunId) || null;
  }

  _extractDelegationTrail(detail, run = null) {
    const candidates = [
      detail?.data?._workflowDelegationTrail,
      run?.detail?.data?._workflowDelegationTrail,
      run?.delegationTrail,
    ];
    const trail = candidates.find((value) => Array.isArray(value)) || [];
    return trail
      .filter((entry) => entry && typeof entry === "object")
      .slice()
      .sort((a, b) => String(a?.timestamp || "").localeCompare(String(b?.timestamp || "")));
  }

  _decorateRunDetail(run) {
    if (!run?.runId) return run;
    const runGraph = this.getRunGraph(run.runId);
    const delegationTrail = this._extractDelegationTrail(run?.detail, run);
    return {
      ...run,
      runGraph,
      executionTree: this._buildExecutionTree(runGraph, run.runId),
      delegationTrail,
    };
  }

  /** Get full run detail for a specific runId */
  getRunDetail(runId) {
    const normalizedRunId = basename(String(runId || "")).replace(/\.json$/i, "");
    if (!normalizedRunId) return null;
    const ledger = this.getRunLedger(normalizedRunId);

    const activeRun = this._activeRuns.get(normalizedRunId);
    if (activeRun?.ctx) {
      const summary = this._buildActiveRunSummary(normalizedRunId, activeRun);
      if (!summary) return null;
      return this._decorateRunDetail({
        ...summary,
        detail: this._serializeRunContext(activeRun.ctx, true),
        ledger,
      });
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
        return this._decorateRunDetail({ ...summary, ...recomputed, detail, ledger });
      }
      const terminalRaw = String(detail?.data?._workflowTerminalStatus || "")
        .trim()
        .toLowerCase();
      const status = terminalRaw === WorkflowStatus.FAILED || terminalRaw === "error"
        ? WorkflowStatus.FAILED
        : (terminalRaw === WorkflowStatus.CANCELLED
            ? WorkflowStatus.CANCELLED
            : (Array.isArray(detail?.errors) && detail.errors.length > 0
                ? WorkflowStatus.FAILED
                : WorkflowStatus.COMPLETED));
      const computed = this._buildSummaryFromDetail({
        runId: normalizedRunId,
        workflowId: detail?.data?._workflowId || null,
        workflowName: detail?.data?._workflowName || null,
        status,
        detail,
      });
      return this._decorateRunDetail({ ...computed, detail, ledger });
    } catch {
      return null;
    }
  }

  getRunLedger(runId) {
    const normalizedRunId = basename(String(runId || "")).replace(/\.json$/i, "");
    if (!normalizedRunId) return null;
    return this._executionLedger.getRunLedger(normalizedRunId);
  }

  getRunGraph(runId) {
    const normalizedRunId = basename(String(runId || "")).replace(/\.json$/i, "");
    if (!normalizedRunId) return null;
    return this._executionLedger.buildRunGraph(normalizedRunId);
  }

  diffRunGraphs(baseRunId, comparisonRunId) {
    const normalizedBaseRunId = basename(String(baseRunId || "")).replace(/\.json$/i, "");
    const normalizedComparisonRunId = basename(String(comparisonRunId || "")).replace(/\.json$/i, "");
    if (!normalizedBaseRunId || !normalizedComparisonRunId) return null;
    return this._executionLedger.diffRunGraphs(normalizedBaseRunId, normalizedComparisonRunId);
  }

  getRetryOptions(runId) {
    const run = this.getRunDetail(runId);
    if (!run) return null;
    const issueAdvisor =
      run?.detail?.issueAdvisor && typeof run.detail.issueAdvisor === "object"
        ? run.detail.issueAdvisor
        : null;
    const nodeStatuses =
      run?.detail?.nodeStatuses && typeof run.detail.nodeStatuses === "object"
        ? run.detail.nodeStatuses
        : {};
    const failedNodesFromAdvisor = Array.isArray(issueAdvisor?.failedNodes)
      ? issueAdvisor.failedNodes
          .map((entry) => String(entry?.nodeId || "").trim())
          .filter(Boolean)
      : [];
    const failedNodesFromStatuses = Object.entries(nodeStatuses)
      .filter(([, status]) => String(status || "").trim().toLowerCase() === NodeStatus.FAILED)
      .map(([nodeId]) => String(nodeId || "").trim())
      .filter(Boolean);
    const failedNodes = Array.from(new Set([
      ...failedNodesFromAdvisor,
      ...failedNodesFromStatuses,
    ]));
    const retryDecision = this._chooseRetryModeForRun(run, {
      fallbackMode: "from_failed",
    });
    const canResumeFromFailed = retryDecision.completedCount > 0 || failedNodes.length > 0;

    return {
      runId: run.runId,
      status: run.status,
      recommendedMode: retryDecision.mode,
      recommendedReason: retryDecision.reason,
      recommendedAction: retryDecision.issueAdvisorRecommendation,
      summary: retryDecision.issueAdvisorSummary,
      failedNodes,
      options: [
        {
          mode: "from_failed",
          label: "Retry from last failed step",
          description: canResumeFromFailed
            ? "Reuse already completed node outputs and resume remaining workflow work."
            : "Resume state is limited; this may behave similarly to a fresh rerun.",
          recommended: retryDecision.mode === "from_failed",
          reason: retryDecision.mode === "from_failed" ? retryDecision.reason : null,
          available: canResumeFromFailed,
          failedNodes,
        },
        {
          mode: "from_scratch",
          label: "Retry from scratch",
          description: "Re-run the workflow from the beginning with the original input data.",
          recommended: retryDecision.mode === "from_scratch",
          reason: retryDecision.mode === "from_scratch" ? retryDecision.reason : null,
          available: true,
          failedNodes,
        },
      ],
    };
  }


  /**
   * Get task-linked workflow trace events for a run.
   * Returns [] when run is unknown or has no task trace data.
   *
   * @param {string} runId
   * @returns {Array<object>}
   */
  getTaskTraceEvents(runId) {
    const detail = this.getRunDetail(runId)?.detail;
    const events = Array.isArray(detail?.data?._taskWorkflowEvents)
      ? detail.data._taskWorkflowEvents
      : [];
    return events.map((event) => ({ ...event }));
  }

  /**
   * Get detailed forensics for a single node in a run.
   * @param {string} runId
   * @param {string} nodeId
   * @returns {object|null}
   */
  getNodeForensics(runId, nodeId) {
    const run = this.getRunDetail(runId);
    if (!run) return null;
    const detail = run.detail || {};
    const nodeStatuses = detail.nodeStatuses || {};
    if (!(nodeId in nodeStatuses)) return null;

    const timings = detail.nodeTimings?.[nodeId] || {};
    const startedAt = timings.startedAt || null;
    const endedAt = timings.endedAt || null;
    const durationMs = startedAt && endedAt ? Math.max(0, endedAt - startedAt) : null;

    return {
      nodeId,
      status: nodeStatuses[nodeId] || null,
      startedAt,
      endedAt,
      durationMs,
      input: detail.nodeInputs?.[nodeId] || null,
      output: detail.nodeOutputs?.[nodeId] || null,
      errors: (detail.errors || []).filter((e) => e.nodeId === nodeId),
      retryAttempts: detail.retryAttempts?.[nodeId] || 0,
      statusEvents: (detail.nodeStatusEvents || []).filter((e) => e.nodeId === nodeId),
    };
  }

  /**
   * Get forensics for all nodes in a run.
   * @param {string} runId
   * @returns {object|null}
   */
  getRunForensics(runId) {
    const run = this.getRunDetail(runId);
    if (!run) return null;
    const detail = run.detail || {};
    const nodeStatuses = detail.nodeStatuses || {};
    const nodes = {};
    for (const nodeId of Object.keys(nodeStatuses)) {
      nodes[nodeId] = this.getNodeForensics(runId, nodeId);
    }
    return {
      runId,
      status: run.status || null,
      startedAt: detail.startedAt || null,
      endedAt: detail.endedAt || null,
      durationMs: detail.duration || null,
      nodes,
    };
  }

  /**
   * Create a snapshot of a completed run for later restore.
   * @param {string} runId
   * @returns {{ snapshotId: string, path: string }|null}
   */
  createRunSnapshot(runId) {
    const run = this.getRunDetail(runId);
    if (!run) return null;
    const detail = run.detail || {};
    const workflowId = run.workflowId || detail.data?._workflowId;
    const snapshotsDir = resolve(this.runsDir, "snapshots");
    const trajectoriesDir = resolve(this.runsDir, WORKFLOW_TRAJECTORIES_DIR);
    mkdirSync(snapshotsDir, { recursive: true });
    mkdirSync(trajectoriesDir, { recursive: true });
    const snapshotId = runId;
    const snapshotPath = resolve(snapshotsDir, `${snapshotId}.json`);
    const trajectoryPath = resolve(trajectoriesDir, `${snapshotId}.json`);
    const replayTrajectory =
      detail.replayTrajectory && typeof detail.replayTrajectory === "object"
        ? detail.replayTrajectory
        : { runId, restoredFrom: detail?.data?._restoredFrom || null, steps: [] };
    const snapshot = {
      snapshotId,
      runId,
      workflowId,
      createdAt: Date.now(),
      nodeStatuses: detail.nodeStatuses || {},
      nodeOutputs: detail.nodeOutputs || {},
      nodeTimings: detail.nodeTimings || {},
      nodeInputs: detail.nodeInputs || {},
      retryAttempts: detail.retryAttempts || {},
      variables: detail.data || {},
      errors: detail.errors || [],
      replayTrajectory,
      stepSummaries: detail.stepSummaries || [],
    };
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), "utf8");
    writeFileSync(trajectoryPath, JSON.stringify(replayTrajectory, null, 2), "utf8");
    return { snapshotId, path: snapshotPath, trajectoryPath };
  }

  /**
   * Restore a run from a snapshot — creates a new execution pre-seeded
   * with completed node state from the snapshot.
   * @param {string} snapshotId
   * @param {object} [opts]
   * @param {object} [opts.variables] - Override variables
   * @returns {Promise<object>}
   */
  async restoreFromSnapshot(snapshotId, opts = {}) {
    const snapshotPath = resolve(this.runsDir, "snapshots", `${snapshotId}.json`);
    if (!existsSync(snapshotPath)) {
      throw new Error(`Snapshot "${snapshotId}" not found`);
    }
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
    const workflowId = snapshot.workflowId;
    const def = this.get(workflowId);
    if (!def) {
      throw new Error(`Workflow "${workflowId}" no longer exists — cannot restore`);
    }

    const inputData = {
      ...def.variables,
      ...(snapshot.variables || {}),
      ...(opts.variables || {}),
      _workflowId: workflowId,
      _workflowName: def.name,
      _restoredFrom: snapshotId,
    };

    // Remove internal keys that should be regenerated
    delete inputData._workflowId;
    delete inputData._workflowName;

    const ctx = new WorkflowContext(inputData);
    ctx.data._workflowId = workflowId;
    ctx.data._workflowName = def.name;
    ctx.data._restoredFrom = snapshotId;
    ctx.data._replayTrajectory = {
      runId: ctx.id,
      restoredFrom: snapshotId,
      steps: Array.isArray(snapshot.replayTrajectory?.steps)
        ? snapshot.replayTrajectory.steps.map((step) => ({ ...step }))
        : [],
    };
    ctx.variables = { ...def.variables, ...(opts.variables || {}) };

    // Pre-seed completed nodes from snapshot
    const nodeStatuses = snapshot.nodeStatuses || {};
    const nodeOutputs = snapshot.nodeOutputs || {};
    const preservedCompletedNodeIds = [];
    const focusNodeIds = [];
    for (const [nodeId, status] of Object.entries(nodeStatuses)) {
      if (status === "completed") {
        preservedCompletedNodeIds.push(nodeId);
        ctx.setNodeStatus(nodeId, NodeStatus.COMPLETED);
        if (nodeOutputs[nodeId] !== undefined) {
          ctx.setNodeOutput(nodeId, nodeOutputs[nodeId]);
        }
      }
    }

    this._recordDagRevision(ctx, {
      reason: (opts.mode === "from_failed") ? "retry_replan_from_failed" : `retry_${opts.mode || "snapshot"}`,
      sourceRunId: snapshotId,
      preservedCompletedNodeIds,
      focusNodeIds,
    });

    const retryRunId = ctx.id;
    this._activeRuns.set(retryRunId, {
      workflowId,
      workflowName: def.name,
      ctx,
      startedAt: ctx.startedAt,
      status: WorkflowStatus.RUNNING,
    });
    this.emit("run:start", { runId: retryRunId, workflowId, name: def.name, restoredFrom: snapshotId });
    this._emitWorkflowStatus({
      runId: retryRunId,
      workflowId,
      workflowName: def.name,
      eventType: "run:start",
      status: WorkflowStatus.RUNNING,
      meta: { restoredFrom: snapshotId },
    });

    try {
      const adjacency = this._buildAdjacency(def);
      const entryNodes = this._findEntryNodes(def);
      await this._executeDag(def, entryNodes, adjacency, ctx, opts);
      const finalStatus = ctx.errors.length > 0 ? WorkflowStatus.FAILED : WorkflowStatus.COMPLETED;
      this._persistRun(retryRunId, workflowId, ctx);
      this._activeRuns.delete(retryRunId);
      return { runId: retryRunId, snapshotId, workflowId, ctx, status: finalStatus };
    } catch (err) {
      this._persistRun(retryRunId, workflowId, ctx);
      this._activeRuns.delete(retryRunId);
      throw err;
    }
  }

  /**
   * List available snapshots, optionally filtered by workflowId.
   * @param {string} [workflowId]
   * @returns {Array<object>}
   */
  listSnapshots(workflowId) {
    const snapshotsDir = resolve(this.runsDir, "snapshots");
    if (!existsSync(snapshotsDir)) return [];
    const files = readdirSync(snapshotsDir).filter((f) => f.endsWith(".json"));
    const snapshots = [];
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(resolve(snapshotsDir, file), "utf8"));
        if (workflowId && data.workflowId !== workflowId) continue;
        const trajectoryFile = resolve(snapshotsDir, "..", WORKFLOW_TRAJECTORIES_DIR, `${data.snapshotId}.json`);
        snapshots.push({
          snapshotId: data.snapshotId,
          runId: data.runId,
          workflowId: data.workflowId,
          createdAt: data.createdAt,
          hasTrajectory: existsSync(trajectoryFile),
        });
      } catch {
        // skip corrupt snapshot files
      }
    }
    return snapshots.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
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

  /**
   * Collect the set of node IDs reachable from `startId` via forward
   * (non-back) edges.  Used by back-edge handling to know which nodes
   * must be reset when a loop cycles.
   */
  _collectSubgraph(startId, adjacency) {
    const visited = new Set();
    const stack = [startId];
    while (stack.length > 0) {
      const nid = stack.pop();
      if (visited.has(nid)) continue;
      visited.add(nid);
      for (const edge of adjacency.get(nid) || []) {
        if (!edge.backEdge) stack.push(edge.target);
      }
    }
    return visited;
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
    const workflowId = ctx?.data?._workflowId || null;
    const workflowName = ctx?.data?._workflowName || null;
    const emitNodeEvent = (type, node, payload = {}) => {
      this.emit(type, {
        runId: ctx.id,
        workflowId,
        workflowName,
        nodeId: node?.id || payload?.nodeId || null,
        nodeType: node?.type || payload?.nodeType || null,
        nodeLabel: node?.label || payload?.nodeLabel || null,
        ...payload,
      });
    };
    const emitEdgeFlow = (edge, payload = {}) => {
      if (!edge) return;
      this.emit("edge:flow", {
        runId: ctx.id,
        workflowId,
        workflowName,
        edgeId: edge.id || `${edge.source}->${edge.target}`,
        source: edge.source,
        target: edge.target,
        sourcePort: String(edge.sourcePort || "default").trim() || "default",
        backEdge: edge.backEdge === true,
        ...payload,
      });
    };
    const markNodeSkipped = (nodeId, reason = "skipped", payload = {}) => {
      if (ctx.getNodeStatus(nodeId) === NodeStatus.COMPLETED) return;
      const node = nodeMap.get(nodeId) || null;
      ctx.setNodeStatus(nodeId, NodeStatus.SKIPPED);
      this._recordDagNodeOutcome(ctx, node || { id: nodeId }, {
        status: NodeStatus.SKIPPED,
        error: payload?.error || null,
      });
      emitNodeEvent("node:skip", node, {
        status: NodeStatus.SKIPPED,
        reason,
        ...payload,
      });
      this._recordLedgerEvent({
        eventType: "node.skipped",
        runId: ctx.id,
        workflowId,
        workflowName,
        rootRunId: ctx.data?._workflowRootRunId || ctx.id,
        parentRunId: ctx.data?._workflowParentRunId || null,
        retryOf: ctx.data?._retryOf || null,
        nodeId,
        nodeType: node?.type || null,
        nodeLabel: node?.label || null,
        status: NodeStatus.SKIPPED,
        reason,
        meta: payload && typeof payload === "object" ? payload : undefined,
      });
    };

    // ── Resume support (retry from_failed) ──────────────────────────────
    // If nodes are already marked COMPLETED in the context (pre-seeded by
    // retryRun), treat them as already executed so the DAG skips them and
    // begins from the first un-completed node.
    const preservedCompletedNodeIds = [];
    for (const [nodeId, status] of ctx.nodeStatuses) {
      if (status === NodeStatus.COMPLETED) {
        preservedCompletedNodeIds.push(nodeId);
        executed.add(nodeId);
      }
    }

    // Track in-degree for proper scheduling (exclude back-edges)
    const inDegree = new Map();
    const incomingSatisfiedCount = new Map();
    for (const node of def.nodes || []) {
      inDegree.set(node.id, 0);
      incomingSatisfiedCount.set(node.id, 0);
    }
    for (const edge of def.edges || []) {
      if (!edge.backEdge) {
        inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
      }
    }

    // Back-edge iteration counters: Map<edgeId, number>
    const backEdgeIterations = new Map();

    // ── Adjust in-degree for pre-completed nodes (retry resume) ─────────
    // When resuming from a failed step, pre-completed source nodes have
    // already satisfied their downstream edges. Decrement the in-degree for
    // each target so successors become ready once all live deps are met.
    for (const nodeId of executed) {
      const edges = adjacency.get(nodeId) || [];
      for (const edge of edges) {
        const deg = (inDegree.get(edge.target) || 1) - 1;
        inDegree.set(edge.target, Math.max(0, deg));
      }
    }

    // Ready set = entry nodes (or nodes with no remaining unsatisfied deps)
    const ready = new Set();
    for (const nid of queue) {
      if (!executed.has(nid)) {
        ready.add(nid);
      }
    }
    // Also add any non-entry nodes whose in-degree is now 0 due to pre-
    // completed predecessors (this makes "from_failed" resume work).
    for (const [nid, deg] of inDegree) {
      if (deg <= 0 && !executed.has(nid) && !ready.has(nid)) {
        ready.add(nid);
      }
    }

    while (ready.size > 0) {
      const activeRun = this._activeRuns.get(ctx.id);
      if (activeRun?.cancelRequested) {
        ctx.data._workflowTerminalStatus = WorkflowStatus.CANCELLED;
        ctx.data._workflowTerminalMessage = String(activeRun.cancelReason || "Run cancelled by user");
        ctx.data._workflowTerminalAt = Date.now();
        for (const [nid] of nodeMap) {
          if (!executed.has(nid)) {
            markNodeSkipped(nid, "run-cancelled");
            executed.add(nid);
          }
        }
        return;
      }
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

          const activeInfo = this._activeRuns.get(ctx.id);
          if (activeInfo?.cancelRequested) {
            markNodeSkipped(nodeId, "run-cancelled");
            executed.add(nodeId);
            return { nodeId, result: null, skipped: true };
          }

          ctx.setNodeStatus(nodeId, NodeStatus.RUNNING);
          this._recordDagNodeOutcome(ctx, node, {
            status: NodeStatus.RUNNING,
            attempt: ctx.getRetryCount(nodeId),
          });
          const isTriggerNode = node.type?.startsWith("trigger.");
          if (!isTriggerNode) {
            console.log(`${TAG} node:start ${nodeId} (${node.type}) [${node.label || ""}] wf=${ctx.data?._workflowName || ctx.data?._workflowId || "?"}`);
          }
          emitNodeEvent("node:start", node, { status: NodeStatus.RUNNING });
          this._recordLedgerEvent({
            eventType: "node.started",
            runId: ctx.id,
            workflowId,
            workflowName,
            rootRunId: ctx.data?._workflowRootRunId || ctx.id,
            parentRunId: ctx.data?._workflowParentRunId || null,
            retryOf: ctx.data?._retryOf || null,
            nodeId,
            nodeType: node?.type || null,
            nodeLabel: node?.label || null,
            status: NodeStatus.RUNNING,
          });
          await this._emitTaskTraceEvent("workflow.node.start", {
            ctx,
            runId: ctx.id,
            workflowId,
            workflowName,
            node,
            status: NodeStatus.RUNNING,
          });

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
                emitNodeEvent("node:retry", node, { attempt, maxRetries, backoffMs });
                this._recordLedgerEvent({
                  eventType: "node.retry",
                  runId: ctx.id,
                  workflowId,
                  workflowName,
                  rootRunId: ctx.data?._workflowRootRunId || ctx.id,
                  parentRunId: ctx.data?._workflowParentRunId || null,
                  retryOf: ctx.data?._retryOf || null,
                  nodeId,
                  nodeType: node?.type || null,
                  nodeLabel: node?.label || null,
                  status: NodeStatus.RUNNING,
                  attempt,
                  meta: { maxRetries, backoffMs },
                });
                await new Promise((r) => setTimeout(r, backoffMs));
                ctx.setNodeStatus(nodeId, NodeStatus.RUNNING);
                this._recordDagNodeOutcome(ctx, node, {
                  status: NodeStatus.RUNNING,
                  attempt: ctx.getRetryCount(nodeId),
                });
              }
              const result = await this._executeNode(node, ctx, opts);
              ctx.setNodeOutput(nodeId, result);
              ctx.setNodeStatus(nodeId, NodeStatus.COMPLETED);
              this._recordDagNodeOutcome(ctx, node, {
                status: NodeStatus.COMPLETED,
                result,
                attempt: ctx.getRetryCount(nodeId),
              });
              executed.add(nodeId);
              // Quiet mode for trigger nodes: only log when they actually fire
              if (isTriggerNode) {
                if (result?.triggered === true) {
                  console.log(`${TAG} trigger:fired ${nodeId} (${node.type}) [${node.label || ""}] wf=${ctx.data?._workflowName || ctx.data?._workflowId || "?"}`);
                }
                // triggered: false → silent (reduces noise from non-firing polls)
              } else {
                const resultSuffix = node.type?.startsWith("condition.") ? ` result=${JSON.stringify(result?.result ?? result)}` : "";
                console.log(`${TAG} node:complete ${nodeId} (${node.type}) [${node.label || ""}]${resultSuffix}`);
              }
              emitNodeEvent("node:complete", node, {
                status: NodeStatus.COMPLETED,
                output: result,
              });
              this._emitWorkflowStatus({
                runId: ctx.id,
                workflowId,
                workflowName,
                eventType: "node:complete",
                status: NodeStatus.COMPLETED,
                nodeId,
                nodeType: node?.type || null,
                nodeLabel: node?.label || null,
                meta: { attempt: ctx.getRetryCount(nodeId) },
              });
              this._recordLedgerEvent({
                eventType: "node.completed",
                runId: ctx.id,
                workflowId,
                workflowName,
                rootRunId: ctx.data?._workflowRootRunId || ctx.id,
                parentRunId: ctx.data?._workflowParentRunId || null,
                retryOf: ctx.data?._retryOf || null,
                nodeId,
                nodeType: node?.type || null,
                nodeLabel: node?.label || null,
                status: NodeStatus.COMPLETED,
                attempt: ctx.getRetryCount(nodeId),
                durationMs: Number(ctx.getNodeTiming(nodeId)?.endedAt || 0) - Number(ctx.getNodeTiming(nodeId)?.startedAt || 0),
                summary: this._summarizeTaskTraceNodeResult(result),
              });
              await this._emitTaskTraceEvent("workflow.node.complete", {
                ctx,
                runId: ctx.id,
                workflowId,
                workflowName,
                node,
                result,
                status: NodeStatus.COMPLETED,
              });

              // Checkpoint progress to disk (debounced) so the run can
              // be resumed from here if the process is interrupted.
              this._checkpointRun(ctx);

              lastErr = null;
              return { nodeId, result };
            } catch (err) {
              lastErr = err;
              if (err.retryable === false) break; // permanent error — skip remaining retry attempts
            }
          }

          // All retries exhausted
          ctx.error(nodeId, lastErr);
          ctx.setNodeStatus(nodeId, NodeStatus.FAILED);
          this._recordDagNodeOutcome(ctx, node, {
            status: NodeStatus.FAILED,
            error: lastErr?.message || String(lastErr),
            attempt: ctx.getRetryCount(nodeId),
          });
          executed.add(nodeId);
          console.warn(`${TAG} node:FAILED ${nodeId} (${node.type}) [${node.label || ""}]: ${lastErr?.message || lastErr}`);
          emitNodeEvent("node:error", node, {
            status: NodeStatus.FAILED,
            error: lastErr.message,
            retries: ctx.getRetryCount(nodeId),
          });
          this._recordLedgerEvent({
            eventType: "node.failed",
            runId: ctx.id,
            workflowId,
            workflowName,
            rootRunId: ctx.data?._workflowRootRunId || ctx.id,
            parentRunId: ctx.data?._workflowParentRunId || null,
            retryOf: ctx.data?._retryOf || null,
            nodeId,
            nodeType: node?.type || null,
            nodeLabel: node?.label || null,
            status: NodeStatus.FAILED,
            attempt: ctx.getRetryCount(nodeId),
            error: lastErr?.message || String(lastErr),
          });
          await this._emitTaskTraceEvent("workflow.node.error", {
            ctx,
            runId: ctx.id,
            workflowId,
            workflowName,
            node,
            status: NodeStatus.FAILED,
            error: lastErr?.message || String(lastErr),
            extra: {
              retries: ctx.getRetryCount(nodeId),
            },
          });

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
              markNodeSkipped(nid, "upstream-failed");
            }
          }
          return;
        }
      }

      const activeAfterBatch = this._activeRuns.get(ctx.id);
      if (activeAfterBatch?.cancelRequested) {
        ctx.data._workflowTerminalStatus = WorkflowStatus.CANCELLED;
        ctx.data._workflowTerminalMessage = String(activeAfterBatch.cancelReason || "Run cancelled by user");
        ctx.data._workflowTerminalAt = Date.now();
        for (const [nid] of nodeMap) {
          if (!executed.has(nid)) {
            markNodeSkipped(nid, "run-cancelled");
            executed.add(nid);
          }
        }
        return;
      }
      // Check for explicit terminal node requests (e.g. flow.end)
      let terminalSignal = null;
      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        const signal = r.value?.result;
        if (signal && signal._workflowEnd === true) {
          terminalSignal = signal;
          break;
        }
      }
      if (terminalSignal) {
        const terminalStatus = String(terminalSignal.status || WorkflowStatus.COMPLETED)
          .trim()
          .toLowerCase();
        ctx.data._workflowTerminalStatus = terminalStatus === WorkflowStatus.FAILED
          ? WorkflowStatus.FAILED
          : WorkflowStatus.COMPLETED;
        if (terminalSignal.message) ctx.data._workflowTerminalMessage = String(terminalSignal.message);
        if (terminalSignal.output !== undefined) ctx.data._workflowTerminalOutput = terminalSignal.output;
        if (terminalSignal.nodeId) ctx.data._workflowTerminalNodeId = terminalSignal.nodeId;
        ctx.data._workflowTerminalAt = Date.now();

        for (const [nid] of nodeMap) {
          if (!executed.has(nid)) {
            markNodeSkipped(nid, "workflow-ended");
            executed.add(nid);
          }
        }
        return;
      }

      // Find newly ready nodes (all incoming edges satisfied)
      for (const nodeId of batch) {
        const node = nodeMap.get(nodeId);
        const edges = adjacency.get(nodeId) || [];
        const sourceOutput = ctx.getNodeOutput(nodeId);
        const triggerBlocked = node?.type?.startsWith("trigger.") && sourceOutput?.triggered === false;
        const explicitEdgePorts = new Set(
          edges
            .map((edge) => String(edge?.sourcePort || "default").trim() || "default")
            .filter((portName) => portName && portName !== "default"),
        );
        const inferredConditionPort =
          !sourceOutput?.matchedPort
          && !sourceOutput?.port
          && node?.type?.startsWith("condition.")
          && typeof sourceOutput?.result === "boolean"
          ? (sourceOutput.result ? "yes" : "no")
          : null;
        const selectedPortRaw =
          sourceOutput?.matchedPort ??
          sourceOutput?.port ??
          (inferredConditionPort && explicitEdgePorts.has(inferredConditionPort) ? inferredConditionPort : null);
        const selectedPort =
          typeof selectedPortRaw === "string" && selectedPortRaw.trim()
            ? selectedPortRaw.trim()
            : null;

        if (triggerBlocked) {
          for (const edge of edges) {
            if (edge.backEdge) continue;
            const newDegree = (inDegree.get(edge.target) || 1) - 1;
            inDegree.set(edge.target, newDegree);
            if (newDegree <= 0 && !executed.has(edge.target)) {
              markNodeSkipped(edge.target, "trigger-not-fired", { sourceNodeId: nodeId });
              executed.add(edge.target);
            }
          }
          continue;
        }

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

        const countForwardIncomingEdges = (targetNodeId) =>
          (def.edges || []).filter((edge) => edge.target === targetNodeId && !edge.backEdge).length;

        const propagateSkippedDependencies = (skippedNodeId) => {
          if (countForwardIncomingEdges(skippedNodeId) > 1) return;
          const skippedEdges = adjacency.get(skippedNodeId) || [];
          for (const skippedEdge of skippedEdges) {
            if (skippedEdge.backEdge) continue;
            consumeEdgeDependency(skippedEdge.target, false, {
              reason: "upstream-skipped",
              payload: {
                sourceNodeId: skippedNodeId,
                edgeId: skippedEdge.id || `${skippedEdge.source}->${skippedEdge.target}`,
              },
            });
          }
        };

        const consumeEdgeDependency = (targetNodeId, matched, skipInfo = null) => {
          const nextDegree = (inDegree.get(targetNodeId) || 1) - 1;
          inDegree.set(targetNodeId, nextDegree);
          if (matched) {
            incomingSatisfiedCount.set(
              targetNodeId,
              (incomingSatisfiedCount.get(targetNodeId) || 0) + 1,
            );
          }
          if (nextDegree <= 0 && !executed.has(targetNodeId)) {
            if ((incomingSatisfiedCount.get(targetNodeId) || 0) > 0) {
              ready.add(targetNodeId);
            } else {
              const priorStatus = ctx.getNodeStatus(targetNodeId);
              if (!matched && priorStatus === NodeStatus.COMPLETED) {
                executed.add(targetNodeId);
                return;
              }
              markNodeSkipped(targetNodeId, skipInfo?.reason || "skipped", skipInfo?.payload || {});
              executed.add(targetNodeId);
              const skippedNode = nodeMap.get(targetNodeId);
              console.log(`${TAG} node:SKIPPED ${targetNodeId} (${skippedNode?.type || "?"}) [${skippedNode?.label || ""}] — no satisfied edges`);
              propagateSkippedDependencies(targetNodeId);
            }
          }
        };

        for (const edge of edges) {
          const edgePort = String(edge?.sourcePort || "default").trim() || "default";
          if (selectedPort && edgePort !== selectedPort) {
            if (!edge.backEdge) {
              consumeEdgeDependency(edge.target, false, {
                reason: "edge-port-mismatch",
                payload: {
                  sourceNodeId: nodeId,
                  edgeId: edge.id || `${edge.source}->${edge.target}`,
                },
              });
            }
            continue;
          }

          // Check edge condition
          if (edge.condition) {
            try {
              const condResult = this._evaluateCondition(edge.condition, ctx, nodeId);
              if (!condResult) {
                // For back-edges, a false condition simply means "don't loop"
                if (!edge.backEdge) {
                  consumeEdgeDependency(edge.target, false, {
                    reason: "edge-condition-false",
                    payload: {
                      sourceNodeId: nodeId,
                      edgeId: edge.id || `${edge.source}->${edge.target}`,
                    },
                  });
                }
                continue;
              }
            } catch {
              continue;
            }
          }

          // ── Back-edge handling (convergence loops) ──────────────────────
          if (edge.backEdge) {
            const edgeKey = edge.id || `${edge.source}->${edge.target}`;
            const iterCount = (backEdgeIterations.get(edgeKey) || 0) + 1;
            // During dry-run, conditions return stub objects instead of real
            // booleans so loop-exit expressions never fire.  Cap iterations
            // to a small number (2) to validate the loop structure without
            // executing hundreds of iterations.
            const DRY_RUN_BACK_EDGE_CAP = 2;
            const maxIter = opts.dryRun
              ? Math.min(Number(edge.maxIterations) || MAX_BACK_EDGE_ITERATIONS, DRY_RUN_BACK_EDGE_CAP)
              : (Number(edge.maxIterations) || MAX_BACK_EDGE_ITERATIONS);

            if (iterCount > maxIter) {
              ctx.log(nodeId,
                `Back-edge "${edgeKey}" reached max iterations (${maxIter}) — stopping loop`,
                "warn");
              this.emit("loop:exhausted", { edgeId: edgeKey, iterations: maxIter, nodeId });
              continue; // Don't follow this back-edge
            }

            backEdgeIterations.set(edgeKey, iterCount);
            emitEdgeFlow(edge, {
              reason: "back-edge",
              iteration: iterCount,
              maxIterations: maxIter,
            });
            this.emit("loop:back_edge", {
              edgeId: edgeKey,
              source: edge.source,
              target: edge.target,
              iteration: iterCount,
              maxIterations: maxIter,
            });
            ctx.log(nodeId,
              `Back-edge → ${edge.target} (iteration ${iterCount}/${maxIter})`,
              "info");

            // Reset the target node and all forward-reachable nodes from it
            // so the sub-graph can be re-executed.
            const subgraph = this._collectSubgraph(edge.target, adjacency);
            for (const nid of subgraph) {
              executed.delete(nid);
              const priorStatus = ctx.getNodeStatus(nid);
              if (nid === edge.target || priorStatus !== NodeStatus.COMPLETED) {
                ctx.setNodeStatus(nid, NodeStatus.PENDING);
              }
              incomingSatisfiedCount.set(nid, 0);
              // Restore in-degree for nodes in the subgraph so they schedule
              // correctly on this new iteration.
              let deg = 0;
              for (const e of def.edges || []) {
                if (e.target === nid && !e.backEdge) deg++;
              }
              // Subtract 1 for each predecessor in the subgraph that will
              // re-execute (its edge will re-satisfy the in-degree).
              // But do NOT subtract for the back-edge source — the back-edge
              // itself is what triggers the target to be ready now.
              for (const e of def.edges || []) {
                if (e.target === nid && !e.backEdge && subgraph.has(e.source)) {
                  deg--;
                }
              }
              // The back-edge target itself has a satisfied edge (the back-edge)
              if (nid === edge.target) deg = 0;
              inDegree.set(nid, Math.max(0, deg));
            }
            ready.add(edge.target);
            continue;
          }

          // Decrement in-degree (forward edges only)
          emitEdgeFlow(edge, {
            reason: selectedPort ? "selected-port" : "forward",
          });
          consumeEdgeDependency(edge.target, true);
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

    // Capture resolved input snapshot for forensics
    ctx.setNodeInput(node.id, resolvedConfig);

    // Dry run — skip capability checks and handler execution.
    // Services aren't needed for simulation; this keeps dry-run tests fast.
    if (opts.dryRun) {
      ctx.log(node.id, `[dry-run] Would execute ${node.type}`, "info");
      return { _dryRun: true, type: node.type, config: resolvedConfig };
    }

    return traceWorkflowNode(
      {
        workflowId: ctx?.data?._workflowId || null,
        workflowRunId: ctx?.id || null,
        rootRunId: ctx?.data?._workflowRootRunId || ctx?.id || null,
        parentRunId: ctx?.data?._workflowParentRunId || null,
        nodeId: node.id,
        nodeType: node.type,
        nodeLabel: node.label || null,
        taskId: resolveTraceTaskId(ctx?.data),
        agentId: resolveTraceAgentId(ctx?.data, resolvedConfig?.agentProfile || node.id),
      },
      async () => {
        // ── Capability pre-flight check ──────────────────────────────────────
        // Verify required services are present AFTER the dryRun early-return so
        // dry-run tests work without needing real service dependencies wired up.
        const requiredCapabilities = this._getNodeRequiredCapabilities(node.type);
        const missingCapabilities = [];
        for (const cap of requiredCapabilities) {
          if (!this._hasCapability(cap)) {
            missingCapabilities.push(cap);
          }
        }
        if (missingCapabilities.length > 0) {
          const detail = `Node "${node.label || node.id}" (${node.type}) requires capabilities: [${missingCapabilities.join(", ")}] which are not available. ` +
            `Check that the required services (agent pool, kanban adapter, etc.) are configured and the agent has the necessary permissions.`;
          ctx.log(node.id, detail, "error");
          const capErr = new Error(detail);
          capErr.retryable = false; // missing service is permanent — don't waste time retrying
          throw capErr;
        }

        // Execute with timeout — clear timer on completion to avoid resource leaks
        const timeout = resolveNodeTimeoutMs(node, resolvedConfig);
        let timer;
        ctx.setNodeTiming(node.id, "startedAt", Date.now());
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
          ctx.setNodeTiming(node.id, "endedAt", Date.now());
          return result;
        } catch (err) {
          ctx.setNodeTiming(node.id, "endedAt", Date.now());
          throw err;
        } finally {
          clearTimeout(timer);
        }
      },
    );
  }

  _resolveConfig(config, ctx) {
    if (Array.isArray(config)) {
      return config.map((item) => this._resolveConfig(item, ctx));
    }
    if (config == null || typeof config !== "object") {
      return config;
    }
    const resolved = {};
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === "string") {
        resolved[key] = ctx.resolve(value);
      } else if (typeof value === "object" && value !== null) {
        resolved[key] = this._resolveConfig(value, ctx);
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  // ── Capability helpers ──────────────────────────────────────────────────
  // Map node-type prefixes / names to the engine.services keys they need.
  // This lets _executeNode fail-fast with a clear message instead of letting
  // the handler throw a cryptic "cannot read property X of undefined".

  /** @returns {string[]} service keys the node type needs (may be empty) */
  _getNodeRequiredCapabilities(nodeType) {
    // Agent nodes need the agentPool service
    if (nodeType.startsWith("agent.") || nodeType === "action.run_agent") {
      return ["agentPool"];
    }
    // Session continuation / restart also need agentPool
    if (nodeType === "action.continue_session" || nodeType === "action.restart_agent") {
      return ["agentPool"];
    }
    // Child workflow execution needs a live engine instance.
    if (nodeType === "action.execute_workflow") {
      return ["workflowEngine"];
    }
    // Meeting workflow nodes require the meeting service bridge.
    if (nodeType.startsWith("meeting.")) {
      return ["meeting"];
    }
    // Task-management nodes need kanban
    if (
      nodeType === "action.create_task" ||
      nodeType === "action.update_task_status" ||
      nodeType === "action.materialize_planner_tasks"
    ) {
      return ["kanban"];
    }
    // Telegram notification
    if (nodeType === "notify.telegram") {
      return ["telegram"];
    }
    // condition.task_has_tag reads from kanban
    if (nodeType === "condition.task_has_tag") {
      return ["kanban"];
    }
    // No special service required (file I/O, git, transforms, logs, etc.)
    return [];
  }

  /** Check whether a named capability (service key) is available */
  _hasCapability(cap) {
    if (cap === "workflowEngine") {
      return typeof this.execute === "function" && typeof this.get === "function";
    }
    const svc = this.services?.[cap];
    // A capability is "present" when its value is a non-null object or function.
    return svc != null && (typeof svc === "object" || typeof svc === "function");
  }

  _evaluateCondition(condition, ctx, sourceNodeId) {
    // Simple expression evaluator — supports basic comparisons
    // Variables: $output (source node output), $data (context data), $status
    const output = ctx.getNodeOutput(sourceNodeId);
    const data = ctx.data;
    const status = ctx.getNodeStatus(sourceNodeId);
    const resolvedCondition = typeof condition === "string" ? ctx.resolve(condition) : condition;
    if (typeof resolvedCondition === "boolean") return resolvedCondition;
    if (resolvedCondition == null) return false;
    const expression = String(resolvedCondition).trim();
    if (!expression) return false;

    // Safe subset evaluation
    try {
      const fn = new Function("$output", "$data", "$status", "$ctx", `return (${expression});`);
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

  _getInterruptedOrphanRunCandidates() {
    if (!existsSync(this.runsDir)) return [];
    if (MAX_INTERRUPTED_ORPHAN_SCAN_FILES <= 0) return [];

    const cutoffMs = INTERRUPTED_ORPHAN_SCAN_WINDOW_MS > 0
      ? Date.now() - INTERRUPTED_ORPHAN_SCAN_WINDOW_MS
      : 0;
    const candidates = [];
    let totalCandidates = 0;

    try {
      for (const file of readdirSync(this.runsDir)) {
        if (
          extname(file) !== ".json" ||
          file === "index.json" ||
          file === ACTIVE_RUNS_INDEX
        ) {
          continue;
        }
        const detailPath = resolve(this.runsDir, file);
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(detailPath).mtimeMs || 0;
        } catch {
          continue;
        }
        if (cutoffMs > 0 && mtimeMs < cutoffMs) continue;
        totalCandidates += 1;
        candidates.push({ file, detailPath, mtimeMs });
      }
    } catch {
      return [];
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (candidates.length > MAX_INTERRUPTED_ORPHAN_SCAN_FILES) {
      console.warn(
        `${TAG} Orphan interrupted-run scan limited to ${MAX_INTERRUPTED_ORPHAN_SCAN_FILES} recent files ` +
          `(${totalCandidates} candidate files in retention window)`,
      );
      candidates.length = MAX_INTERRUPTED_ORPHAN_SCAN_FILES;
    }
    return candidates;
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
    if (ctx?.data?._dagState) detail.dagState = ctx.data._dagState;
    if (ctx?.data?._issueAdvisor) detail.issueAdvisor = ctx.data._issueAdvisor;
    if (Array.isArray(ctx?.data?._workflowDelegationTrail)) {
      detail.data._workflowDelegationTrail = ctx.data._workflowDelegationTrail.map((entry) => ({ ...entry }));
    }
    if (ctx?.data?._workflowDefinitionSnapshot) {
      detail.workflowDefinition = cloneRunSnapshot(ctx.data._workflowDefinitionSnapshot);
    }
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
    const targetRepo = detail?.data?._targetRepo || null;
    const triggerVars = detail?.data?._triggerVars || null;
    const delegationTrail = normalizeDelegationTrail(detail?.delegationAuditTrail ?? detail?.delegationTrail ?? detail?.data?._delegationAuditTrail ?? detail?.data?._workflowDelegationTrail ?? detail?.data?._delegationTrail);
    const rootRunId =
      detail?.dagState?.rootRunId ||
      detail?.data?._workflowRootRunId ||
      null;
    const parentRunId =
      detail?.dagState?.parentRunId ||
      detail?.data?._workflowParentRunId ||
      null;
    const retryOf =
      detail?.dagState?.retryOf ||
      detail?.data?._retryOf ||
      null;
    const retryMode =
      detail?.dagState?.retryMode ||
      detail?.data?._retryMode ||
      null;
    const retryDecisionReason = detail?.data?._retryDecisionReason || null;
    const issueAdvisorRecommendation = detail?.issueAdvisor?.recommendedAction || null;
    const issueAdvisorSummary = detail?.issueAdvisor?.summary || null;
    const dagRevisionCount = Array.isArray(detail?.dagState?.revisions) ? detail.dagState.revisions.length : 0;
    const validationFailures = collectValidationFailures(detail);

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
      delegationTrail,
      triggerEvent,
      triggerSource,
      triggeredBy,
      targetRepo,
      triggerVars,
      rootRunId,
      parentRunId,
      retryOf,
      retryMode,
      retryDecisionReason,
      issueAdvisorRecommendation,
      issueAdvisorSummary,
      dagRevisionCount,
      ...(validationFailures.length > 0
        ? {
            validationFailures,
            latestValidationFailure: validationFailures.at(-1) || null,
          }
        : {}),
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
      normalized.activeNodeCount = 0;
      if (!Number.isFinite(Number(normalized.endedAt))) {
        const fallbackEndedAt = Math.max(
          Number(normalized.interruptedAt) || 0,
          Number(normalized.lastProgressAt) || 0,
          Number(normalized.lastLogAt) || 0,
          Number(normalized.startedAt) || 0,
        );
        normalized.endedAt = fallbackEndedAt > 0 ? fallbackEndedAt : null;
      }
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

  // ── Active-runs persistence (crash recovery) ─────────────────────────

  /**
   * Read the active-runs index (_active-runs.json).
   * Returns an array of { runId, workflowId, workflowName, startedAt }.
   */
  _readActiveRunsIndex() {
    try {
      const p = resolve(this.runsDir, ACTIVE_RUNS_INDEX);
      if (!existsSync(p)) return [];
      const raw = JSON.parse(readFileSync(p, "utf8"));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  /** Write the active-runs index atomically. */
  _writeActiveRunsIndex(entries) {
    try {
      this._ensureDirs();
      const p = resolve(this.runsDir, ACTIVE_RUNS_INDEX);
      writeFileSync(p, JSON.stringify(entries, null, 2), "utf8");
    } catch (err) {
      console.error(`${TAG} Failed to write active-runs index:`, err.message);
    }
  }

  /**
   * Persist a run to the active-runs index AND write an initial detail file.
   * Called at the very start of execute() / retryRun() so the run is on disk
   * before any node executes.
   */
  _persistActiveRunState(runId, workflowId, workflowName, ctx) {
    try {
      this._ensureDirs();

      // Add to active-runs index
      const entries = this._readActiveRunsIndex().filter((e) => e.runId !== runId);
      entries.push({ runId, workflowId, workflowName, startedAt: ctx.startedAt });
      this._writeActiveRunsIndex(entries);

      // Write initial detail file so we can resume from it
      const detail = this._serializeRunContext(ctx, true);
      this._writeRunDetail(runId, detail);

      // Also ensure the run appears in the main index (with RUNNING status)
      // so that getRunDetail() can find it even before completion.
      this._ensureRunInIndex(runId, workflowId, workflowName, detail);
    } catch (err) {
      console.error(`${TAG} Failed to persist active run state:`, err.message);
    }
  }

  /**
   * Debounced checkpoint — writes the current run context to disk after each
   * node completes.  Debounced at CHECKPOINT_DEBOUNCE_MS to avoid disk
   * thrashing when many nodes finish in quick succession.
   */
  _checkpointRun(ctx) {
    const runId = ctx.id;
    // Clear any pending timer for this run
    const existing = this._checkpointTimers.get(runId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this._checkpointTimers.delete(runId);
      try {
        // If the run has already been finalized/removed, skip writing a
        // late checkpoint snapshot that could overwrite terminal detail.
        if (!this._activeRuns.has(runId)) return;
        this._ensureDirs();
        const detail = this._serializeRunContext(ctx, true);
        this._writeRunDetail(runId, detail);
      } catch (err) {
        console.error(`${TAG} Checkpoint failed for run ${runId}:`, err.message);
      }
    }, CHECKPOINT_DEBOUNCE_MS);

    // Don't let the timer prevent clean process exit
    if (timer.unref) timer.unref();
    this._checkpointTimers.set(runId, timer);
  }

  /**
   * Remove a run from the active-runs index and clear its checkpoint timer.
   * Called after a run completes (success or failure) so it won't be
   * mistakenly resumed on next boot.
   */
  _clearActiveRunState(runId) {
    try {
      // Clear debounce timer
      const timer = this._checkpointTimers.get(runId);
      if (timer) {
        clearTimeout(timer);
        this._checkpointTimers.delete(runId);
      }
      // Remove from active-runs index
      const entries = this._readActiveRunsIndex().filter((e) => e.runId !== runId);
      this._writeActiveRunsIndex(entries);
    } catch (err) {
      console.error(`${TAG} Failed to clear active run state:`, err.message);
    }
  }

  /**
   * Ensure a run entry exists in the main runs index (index.json).
   * Deduplicates by runId — if the run already exists, updates it in place.
   */
  _ensureRunInIndex(runId, workflowId, workflowName, detail) {
    try {
      const indexPath = resolve(this.runsDir, "index.json");
      const runs = this._readRunIndex();
      const existingIdx = runs.findIndex((r) => r.runId === runId);

      const summary = this._buildSummaryFromDetail({
        runId,
        workflowId,
        workflowName,
        status: WorkflowStatus.RUNNING,
        detail,
      });

      if (existingIdx >= 0) {
        runs[existingIdx] = summary;
      } else {
        runs.push(summary);
      }
      if (runs.length > MAX_PERSISTED_RUNS) runs.splice(0, runs.length - MAX_PERSISTED_RUNS);
      writeFileSync(indexPath, JSON.stringify({ runs }, null, 2), "utf8");
    } catch (err) {
      console.error(`${TAG} Failed to ensure run in index:`, err.message);
    }
  }

  /**
   * Detect runs that were interrupted by a previous shutdown.
   * Scans the _active-runs.json index for entries that are NOT in our
   * in-memory _activeRuns map (which is empty on fresh boot). Marks them
   * as PAUSED in the main index and clears the active-runs index.
   */
  _detectInterruptedRuns() {
    try {
      const activeEntries = this._readActiveRunsIndex();
      const interrupted = [];
      const now = Date.now();
      const runs = this._readRunIndex();
      const runsById = new Map(
        runs
          .filter((run) => run?.runId)
          .map((run) => [String(run.runId), run]),
      );
      const maxResumableStaleRunsRaw = Number(process.env.WORKFLOW_INTERRUPTED_RESUME_MAX_RUNS);
      const maxResumableStaleRuns = Number.isFinite(maxResumableStaleRunsRaw)
        ? Math.max(1, Math.min(500, Math.floor(maxResumableStaleRunsRaw)))
        : 25;
      let resumableStaleRunsAssigned = 0;

      const markInterrupted = (runId, workflowId = null, workflowName = null, options = {}) => {
        const normalizedRunId = String(runId || "").trim();
        if (!normalizedRunId || interrupted.some((entry) => entry.runId === normalizedRunId)) return;
        let summary = runsById.get(normalizedRunId) || null;
        if (!summary) {
          const detailPath = resolve(this.runsDir, `${normalizedRunId}.json`);
          if (existsSync(detailPath)) {
            try {
              const detail = JSON.parse(readFileSync(detailPath, "utf8"));
              summary = this._buildSummaryFromDetail({
                runId: normalizedRunId,
                workflowId: workflowId || detail?.data?._workflowId || null,
                workflowName: workflowName || detail?.data?._workflowName || workflowId || null,
                status: WorkflowStatus.PAUSED,
                detail,
              });
              runs.push(summary);
              runsById.set(normalizedRunId, summary);
            } catch {
              // best-effort hydration only
            }
          }
        }
        const wantsResumable = options?.resumable !== false;
        const forceResumable = options?.forceResumable === true;
        const canResume = wantsResumable && (forceResumable || resumableStaleRunsAssigned < maxResumableStaleRuns);
        if (summary) {
          summary.status = WorkflowStatus.PAUSED;
          summary.resumable = canResume;
          summary.interruptedAt = now;
          summary.activeNodeCount = 0;
          if (!Number.isFinite(Number(summary.endedAt))) {
            summary.endedAt = now;
          }
          if (!canResume) summary.resumeResult = "recovery_cap_exceeded";
        }
        if (canResume && !forceResumable) resumableStaleRunsAssigned += 1;
        interrupted.push({
          runId: normalizedRunId,
          workflowId: workflowId || summary?.workflowId || null,
          workflowName: workflowName || summary?.workflowName || null,
        });
      };

      // Primary source: persisted active-runs index from the previous process.
      for (const entry of activeEntries) {
        const runId = String(entry?.runId || "").trim();
        if (!runId || this._activeRuns.has(runId)) continue;
        markInterrupted(runId, entry.workflowId, entry.workflowName, { forceResumable: true });
      }

      // Secondary source: index entries still marked RUNNING with no active execution.
      for (const run of runs) {
        const runId = String(run?.runId || "").trim();
        if (!runId) continue;
        if (run.status !== WorkflowStatus.RUNNING) continue;
        if (this._activeRuns.has(runId)) continue;
        markInterrupted(runId, run.workflowId, run.workflowName);
      }

      // Tertiary source: orphan detail files with no index entry and no end marker.
      // This is bounded to a recent subset so old archived run details cannot
      // stall startup when workflow-runs contains thousands of historical files.
      const orphanCandidates = this._getInterruptedOrphanRunCandidates();
      for (const candidate of orphanCandidates) {
        const runId = basename(candidate.file, ".json");
        if (!runId || this._activeRuns.has(runId) || runsById.has(runId)) continue;
        try {
          const detail = JSON.parse(readFileSync(candidate.detailPath, "utf8"));
          const hasRunningNode = Object.values(detail?.nodeStatuses || {}).some(
            (status) => status === NodeStatus.RUNNING || status === NodeStatus.WAITING,
          );
          if (detail?.endedAt != null && !hasRunningNode) continue;
          markInterrupted(
            runId,
            detail?.data?._workflowId || null,
            detail?.data?._workflowName || null,
          );
        } catch {
          // ignore malformed detail files
        }
      }

      if (interrupted.length > 0) {
        const indexPath = resolve(this.runsDir, "index.json");
        if (runs.length > MAX_PERSISTED_RUNS) runs.splice(0, runs.length - MAX_PERSISTED_RUNS);
        writeFileSync(indexPath, JSON.stringify({ runs }, null, 2), "utf8");
      }

      // Clear the active-runs index — we've handled recoverable entries.
      this._writeActiveRunsIndex([]);

      if (interrupted.length > 0) {
        const sample = interrupted.slice(0, 20).map((entry) => entry.runId).join(", ");
        const suffix = interrupted.length > 20 ? ", ..." : "";
        console.log(
          `${TAG} Detected ${interrupted.length} interrupted run(s): ${sample}${suffix}`,
        );
        this.emit("runs:interrupted", { runs: interrupted });
      }
    } catch (err) {
      console.error(`${TAG} Failed to detect interrupted runs:`, err.message);
    }
  }

  /**
   * Resume all interrupted (PAUSED + resumable) runs.
   * Should be called AFTER services are wired up (e.g. after workflow
   * engine is fully initialized with node executors).
   */
  async resumeInterruptedRuns() {
    if (this._resumingRuns) return;
    if (!this.detectInterruptedRuns) return;
    this._resumingRuns = true;

    try {
      const allRuns = this._readRunIndex();
      const runs = allRuns.filter(
        (r) => r.status === WorkflowStatus.PAUSED && r.resumable,
      );

      if (!runs.length) {
        this._resumingRuns = false;
        return;
      }

      console.log(`${TAG} Resuming ${runs.length} interrupted run(s)...`);

      // ── Deduplicate by taskId: keep only the most recent run per task ────
      // After N crash/restart cycles, N run entries accumulate for the same
      // taskId. Resuming all of them causes competing workflow runs that race
      // to claim the task → "claim was stolen" errors on every restart.
      // Solution: pre-scan detail files, keep latest startedAt per taskId,
      // and mark older duplicates as not-resumable before we even try them.
      const runDetailCache = new Map(); // runId → parsed detail
      const latestByTaskId = new Map(); // taskId → run entry (highest startedAt)
      const ledgerTaskEntries = this._executionLedger.listTaskRunEntries();
      const ledgerTaskIdByRunId = new Map();
      for (const entry of ledgerTaskEntries) {
        if (!entry?.runId || !entry?.taskId) continue;
        ledgerTaskIdByRunId.set(entry.runId, entry.taskId);
        const previous = latestByTaskId.get(entry.taskId);
        const entryTime = typeof entry.startedAt === "number"
          ? entry.startedAt
          : (Date.parse(entry.startedAt || entry.updatedAt || "") || 0);
        const previousTime = previous
          ? (typeof previous.startedAt === "number"
              ? previous.startedAt
              : (Date.parse(previous.startedAt || previous.updatedAt || "") || 0))
          : 0;
        const candidate = {
          runId: entry.runId,
          startedAt: entry.startedAt || entry.updatedAt || null,
          updatedAt: entry.updatedAt || null,
          status: entry.status || null,
        };
        if (!previous || entryTime >= previousTime) {
          latestByTaskId.set(entry.taskId, candidate);
        }
      }
      for (const run of allRuns) {
        const dp = resolve(this.runsDir, `${run.runId}.json`);
        if (!existsSync(dp)) continue;
        try {
          const d = JSON.parse(readFileSync(dp, "utf8"));
          runDetailCache.set(run.runId, d);
          const tid = ledgerTaskIdByRunId.get(run.runId) || this._resolveRunTaskIdentity(run, d)?.taskId || "";
          if (!tid) continue;
          const prev = latestByTaskId.get(tid);
          if (!prev || (run.startedAt || 0) >= (prev.startedAt || 0)) {
            latestByTaskId.set(tid, run);
          }
        } catch {
          /* unreadable detail — handled in the main loop below */
        }
      }

      // Mark older duplicate runs as not-resumable before entering the loop
      let dedupedCount = 0;
      for (const run of runs) {
        const d = runDetailCache.get(run.runId);
        const tid = this._resolveRunTaskIdentity(run, d)?.taskId || "";
        if (!tid) continue;
        const latest = latestByTaskId.get(tid);
        if (latest && latest.runId !== run.runId) {
          this._markRunUnresumable(run.runId, "duplicate_task_run");
          dedupedCount++;
        }
      }
      if (dedupedCount > 0) {
        console.log(
          `${TAG} Skipped ${dedupedCount} duplicate interrupted run(s) (kept latest per taskId)`,
        );
      }

      for (const run of runs) {
        // Skip runs that were marked as duplicates above
        const _runDetail = runDetailCache.get(run.runId);
        const _tid = this._resolveRunTaskIdentity(run, _runDetail)?.taskId || "";
        if (_tid) {
          const latest = latestByTaskId.get(_tid);
          if (latest && latest.runId !== run.runId) continue;
        }

        try {
          // Check if the workflow definition still exists
          const def = this.get(run.workflowId);
          if (!def) {
            console.warn(`${TAG} Cannot resume run ${run.runId}: workflow "${run.workflowId}" no longer exists`);
            this._markRunUnresumable(run.runId, "workflow_deleted");
            continue;
          }

          // Load the persisted detail file to get the context state
          const detailPath = resolve(this.runsDir, `${run.runId}.json`);
          if (!existsSync(detailPath)) {
            console.warn(`${TAG} Cannot resume run ${run.runId}: no detail file found`);
            this._markRunUnresumable(run.runId, "no_detail_file");
            continue;
          }

          // Reuse cached detail if available (already parsed above)
          const detail = runDetailCache.get(run.runId) ?? JSON.parse(readFileSync(detailPath, "utf8"));
          const retryDecision = this._chooseRetryModeFromDetail(detail, {
            fallbackMode: "from_scratch",
          });

          console.log(
            `${TAG} Resuming run ${run.runId} via retryRun(${retryDecision.mode}) ` +
            `[${retryDecision.reason}]...`,
          );
          await this.retryRun(run.runId, {
            mode: retryDecision.mode,
            _decisionReason: retryDecision.reason,
          }).catch((err) => {
            console.error(`${TAG} Failed to resume run ${run.runId}:`, err.message);
            this._markRunUnresumable(run.runId, `retry_error: ${err.message}`);
          });

          // Mark the original interrupted run as no longer resumable
          // (the retry/re-execute created a new run)
          this._markRunUnresumable(run.runId, "resumed");
        } catch (err) {
          console.error(`${TAG} Error resuming run ${run.runId}:`, err.message);
          this._markRunUnresumable(run.runId, `error: ${err.message}`);
        }
      }
    } finally {
      this._resumingRuns = false;
    }
  }

  _resolveRunTaskIdentity(runSummary, detail = null) {
    const detailTaskId = String(
      detail?.data?.taskId || detail?.inputData?.taskId || detail?.taskId || "",
    ).trim();
    if (detailTaskId) {
      return {
        taskId: detailTaskId,
        taskTitle: String(detail?.data?.taskTitle || detail?.inputData?.taskTitle || "").trim() || null,
        source: "detail",
      };
    }
    const ledgerIdentity = this._executionLedger.getTaskIdentity(runSummary?.runId || detail?.id || "");
    if (ledgerIdentity?.taskId) return ledgerIdentity;
    return null;
  }

  /**
   * Mark a run as no longer resumable in the main index.
   */
  _markRunUnresumable(runId, reason) {
    try {
      const indexPath = resolve(this.runsDir, "index.json");
      const runs = this._readRunIndex();
      const idx = runs.findIndex((r) => r.runId === runId);
      if (idx >= 0) {
        runs[idx].resumable = false;
        runs[idx].resumeResult = reason;
        writeFileSync(indexPath, JSON.stringify({ runs }, null, 2), "utf8");
      }
    } catch (err) {
      console.error(`${TAG} Failed to mark run unresumable:`, err.message);
    }
  }

  // ── Persist completed run ─────────────────────────────────────────────

  _persistRun(runId, workflowId, ctx) {
    try {
      this._ensureDirs();
      const workflow = this.get(workflowId);
      const detail = this._serializeRunContext(ctx, false);
      const summary = this._buildSummaryFromDetail({
        runId,
        workflowId,
        workflowName: workflow?.name || ctx.data?._workflowName || workflowId,
        status: this._resolveWorkflowStatus(ctx),
        detail,
      });

      // Deduplicate: remove any existing entry for this runId before appending
      const indexPath = resolve(this.runsDir, "index.json");
      let runs = this._readRunIndex().filter((r) => r.runId !== runId);
      runs.push(summary);
      // Keep last N runs
      if (runs.length > MAX_PERSISTED_RUNS) runs = runs.slice(-MAX_PERSISTED_RUNS);
      writeFileSync(indexPath, JSON.stringify({ runs }, null, 2), "utf8");

      // Save full run detail
      this._writeRunDetail(runId, detail);
    } catch (err) {
      console.error(`${TAG} Failed to persist run log:`, err.message);
    }
  }

  _writeRunDetail(runId, detail) {
    const detailPath = resolve(this.runsDir, `${runId}.json`);
    writeFileSync(detailPath, JSON.stringify(detail, null, 2), "utf8");
  }
}

// ── Module-level convenience functions ──────────────────────────────────────

let _defaultEngine = null;

function shouldDisableDefaultInterruptedRunDetection(opts = {}) {
  const isTestProcess = Boolean(process.env.VITEST) || process.env.NODE_ENV === "test";
  return isTestProcess && !opts.workflowDir && !opts.runsDir;
}

function mergeWorkflowServices(currentServices, incomingServices) {
  const current =
    currentServices && typeof currentServices === "object"
      ? { ...currentServices }
      : {};
  if (!incomingServices || typeof incomingServices !== "object") return current;

  for (const [key, value] of Object.entries(incomingServices)) {
    if (value === undefined) continue;
    if (value === null && current[key] != null) continue;
    current[key] = value;
  }
  return current;
}

/**
 * Get or create the default workflow engine instance.
 * @param {object} [opts]
 * @returns {WorkflowEngine}
 */
export function getWorkflowEngine(opts = {}) {
  if (!_defaultEngine) {
    const engineOpts = opts && typeof opts === "object" ? { ...opts } : {};
    if (
      engineOpts.detectInterruptedRuns === undefined &&
      shouldDisableDefaultInterruptedRunDetection(engineOpts)
    ) {
      engineOpts.detectInterruptedRuns = false;
    }
    _defaultEngine = new WorkflowEngine(engineOpts);
    _defaultEngine.load();
  } else if (opts && typeof opts === "object") {
    const workflowDir = typeof opts.workflowDir === "string" && opts.workflowDir
      ? resolve(opts.workflowDir)
      : null;
    const runsDir = typeof opts.runsDir === "string" && opts.runsDir
      ? resolve(opts.runsDir)
      : null;
    const configDir = typeof opts.configDir === "string" && opts.configDir
      ? resolve(opts.configDir)
      : null;
    const shouldReinitialize =
      (workflowDir && workflowDir !== _defaultEngine.workflowDir) ||
      (runsDir && runsDir !== _defaultEngine.runsDir) ||
      (configDir && configDir !== resolve(_defaultEngine._configDir || process.cwd()));

    if (shouldReinitialize) {
      const engineOpts = {
        ...opts,
        services: mergeWorkflowServices(_defaultEngine.services, opts.services || {}),
      };
      if (
        engineOpts.detectInterruptedRuns === undefined &&
        shouldDisableDefaultInterruptedRunDetection(engineOpts)
      ) {
        engineOpts.detectInterruptedRuns = false;
      }
      _defaultEngine = new WorkflowEngine(engineOpts);
      _defaultEngine.load();
    } else if (opts.services && typeof opts.services === "object") {
      _defaultEngine.services = mergeWorkflowServices(
        _defaultEngine.services,
        opts.services,
      );
    }
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
export async function retryWorkflowRun(runId, retryOpts, engineOpts) { return getWorkflowEngine(engineOpts).retryRun(runId, retryOpts); }








