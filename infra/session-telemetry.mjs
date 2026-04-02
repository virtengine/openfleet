import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { LiveEventProjector } from "./live-event-projector.mjs";
import { ProviderUsageLedger } from "./provider-usage-ledger.mjs";
import { RuntimeMetrics } from "./runtime-metrics.mjs";
import { exportHarnessTrace } from "./trace-export.mjs";
import {
  cloneHotPathValue,
  getBosunHotPathStatus,
} from "../lib/hot-path-runtime.mjs";
import { createHarnessTelemetryRuntime } from "./session-telemetry-runtime.mjs";

const DEFAULT_MAX_IN_MEMORY_EVENTS = 20_000;
const OBSERVABILITY_SPINES = new Map();

function asText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const cloneValue = cloneHotPathValue;

function isLikelyTestRuntime() {
  if (process.env.BOSUN_TEST_SANDBOX === "1") return true;
  if (process.env.VITEST) return true;
  if (process.env.VITEST_POOL_ID) return true;
  if (process.env.VITEST_WORKER_ID) return true;
  if (process.env.NODE_ENV === "test") return true;
  const argv = Array.isArray(process.argv) ? process.argv.join(" ").toLowerCase() : "";
  return argv.includes("vitest") || argv.includes("--test");
}

function normalizeTimestamp(value) {
  const text = asText(value);
  if (text) return text;
  return new Date().toISOString();
}

function normalizeTokenUsage(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const inputTokens = asNumber(
    source.inputTokens
    ?? source.promptTokens
    ?? source.prompt_tokens
    ?? source.input_tokens,
  ) || 0;
  const outputTokens = asNumber(
    source.outputTokens
    ?? source.completionTokens
    ?? source.completion_tokens
    ?? source.output_tokens,
  ) || 0;
  const totalTokens = asNumber(
    source.totalTokens
    ?? source.total_tokens
    ?? source.total,
  ) || (inputTokens + outputTokens);
  if (inputTokens === 0 && outputTokens === 0 && totalTokens === 0) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function normalizeJsonObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return cloneValue(value);
}

function pickText(...values) {
  for (const value of values) {
    const text = asText(value);
    if (text) return text;
  }
  return null;
}

function pickNumber(...values) {
  for (const value of values) {
    const numeric = asNumber(value);
    if (numeric != null) return numeric;
  }
  return null;
}

function inferCategory(eventType, source) {
  const normalizedType = String(eventType || "").trim().toLowerCase();
  const normalizedSource = String(source || "").trim().toLowerCase();
  if (normalizedSource.includes("workflow") || normalizedType.startsWith("node.") || normalizedType.startsWith("run.")) {
    return "workflow";
  }
  if (
    normalizedType.includes("artifact")
    || normalizedType.includes("patch")
    || normalizedType.includes("file.")
    || normalizedType.includes("mutation")
  ) return "artifact";
  if (
    normalizedType.includes("subagent")
    || normalizedType.includes("delegate")
    || normalizedSource.includes("subagent")
  ) return "subagent";
  if (normalizedType.includes("approval")) return "approval";
  if (normalizedType.includes("tool")) return "tool";
  if (normalizedType.includes("provider") || normalizedType.includes("model") || normalizedType.includes("token")) return "provider";
  if (normalizedSource.includes("session")) return "session";
  if (normalizedSource.includes("agent")) return "agent";
  if (normalizedSource.includes("telegram")) return "telegram";
  if (normalizedSource.includes("tui")) return "tui";
  return "runtime";
}

function trimUndefinedEntries(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function normalizeFilterTimestamp(value) {
  if (value == null || value === "") return null;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function resolveHarnessTelemetryPaths(configDir) {
  const root = resolve(String(configDir || process.cwd()), ".cache", "harness", "observability");
  return {
    root,
    eventsPath: resolve(root, "events.jsonl"),
  };
}

export function normalizeCanonicalHarnessEvent(input = {}) {
  const timestamp = normalizeTimestamp(input.timestamp || input.ts);
  const payload = normalizeJsonObject(input.payload);
  const meta = normalizeJsonObject(input.meta);
  const tokenUsage = normalizeTokenUsage(
    input.tokenUsage
    || input.usage
    || payload?.usage
    || meta?.usage,
  );
  const eventType = asText(input.eventType || input.type || payload?.type) || "event";
  const source = asText(input.source || meta?.source) || "unknown";
  const category = asText(input.category) || inferCategory(eventType, source);
  const taskId = pickText(input.taskId, payload?.taskId, meta?.taskId, input.session?.taskId);
  const sessionId = pickText(input.sessionId, payload?.sessionId, meta?.sessionId, input.session?.id) || taskId;
  return trimUndefinedEntries({
    id: asText(input.id || input.eventId) || randomUUID(),
    timestamp,
    ts: asNumber(input.ts) || Date.parse(timestamp),
    eventType,
    type: asText(input.type) || eventType,
    category,
    source,
    taskId,
    sessionId,
    rootTaskId: pickText(input.rootTaskId, payload?.rootTaskId, meta?.rootTaskId),
    parentTaskId: pickText(input.parentTaskId, payload?.parentTaskId, meta?.parentTaskId),
    childTaskId: pickText(input.childTaskId, payload?.childTaskId, meta?.childTaskId),
    delegationDepth: pickNumber(input.delegationDepth, payload?.delegationDepth, meta?.delegationDepth),
    threadId: pickText(input.threadId, payload?.threadId, meta?.threadId),
    turnId: pickText(input.turnId, payload?.turnId, meta?.turnId),
    runId: pickText(input.runId, payload?.runId, meta?.runId),
    rootRunId: pickText(input.rootRunId, payload?.rootRunId, meta?.rootRunId),
    parentRunId: pickText(input.parentRunId, payload?.parentRunId, meta?.parentRunId),
    childRunId: pickText(input.childRunId, payload?.childRunId, meta?.childRunId),
    workflowId: pickText(input.workflowId, payload?.workflowId, meta?.workflowId),
    workflowName: pickText(input.workflowName, payload?.workflowName, meta?.workflowName),
    nodeId: pickText(input.nodeId, payload?.nodeId, meta?.nodeId),
    nodeType: pickText(input.nodeType, payload?.nodeType, meta?.nodeType),
    nodeLabel: pickText(input.nodeLabel, payload?.nodeLabel, meta?.nodeLabel),
    stageId: pickText(input.stageId, payload?.stageId, meta?.stageId),
    stageType: pickText(input.stageType, payload?.stageType, meta?.stageType),
    providerId: pickText(input.providerId, input.provider, payload?.providerId, payload?.provider, meta?.providerId),
    providerKind: pickText(input.providerKind, payload?.providerKind, meta?.providerKind),
    providerTurnId: pickText(input.providerTurnId, payload?.providerTurnId, meta?.providerTurnId),
    modelId: pickText(input.modelId, payload?.modelId, meta?.modelId),
    requestId: pickText(input.requestId, payload?.requestId, meta?.requestId),
    traceId: pickText(input.traceId, payload?.traceId, meta?.traceId),
    spanId: pickText(input.spanId, payload?.spanId, meta?.spanId),
    parentSpanId: pickText(input.parentSpanId, payload?.parentSpanId, meta?.parentSpanId),
    executionId: pickText(input.executionId, payload?.executionId, meta?.executionId),
    executionKey: pickText(input.executionKey, payload?.executionKey, meta?.executionKey),
    executionKind: pickText(input.executionKind, payload?.executionKind, meta?.executionKind),
    executionLabel: pickText(input.executionLabel, payload?.executionLabel, meta?.executionLabel),
    parentExecutionId: pickText(input.parentExecutionId, payload?.parentExecutionId, meta?.parentExecutionId),
    causedByExecutionId: pickText(input.causedByExecutionId, payload?.causedByExecutionId, meta?.causedByExecutionId),
    rootSessionId: pickText(input.rootSessionId, payload?.rootSessionId, meta?.rootSessionId),
    parentSessionId: pickText(input.parentSessionId, payload?.parentSessionId, meta?.parentSessionId),
    childSessionId: pickText(input.childSessionId, payload?.childSessionId, meta?.childSessionId),
    subagentId: pickText(input.subagentId, payload?.subagentId, meta?.subagentId),
    toolId: pickText(input.toolId, payload?.toolId, meta?.toolId),
    toolName: pickText(input.toolName, input.name, payload?.toolName, payload?.name, meta?.toolName),
    approvalId: pickText(input.approvalId, payload?.approvalId, meta?.approvalId),
    artifactId: pickText(input.artifactId, payload?.artifactId, meta?.artifactId),
    artifactPath: pickText(input.artifactPath, input.filePath, payload?.artifactPath, payload?.filePath, meta?.artifactPath, meta?.filePath),
    filePath: pickText(input.filePath, payload?.filePath, meta?.filePath, input.artifactPath, payload?.artifactPath, meta?.artifactPath),
    fileHash: pickText(input.fileHash, payload?.fileHash, meta?.fileHash),
    patchHash: pickText(input.patchHash, payload?.patchHash, meta?.patchHash),
    commandId: pickText(input.commandId, payload?.commandId, meta?.commandId),
    commandName: pickText(input.commandName, payload?.commandName, meta?.commandName),
    surface: pickText(input.surface, payload?.surface, meta?.surface),
    channel: pickText(input.channel, payload?.channel, meta?.channel),
    action: pickText(input.action, payload?.action, meta?.action),
    workspaceId: pickText(input.workspaceId, payload?.workspaceId, meta?.workspaceId),
    repoRoot: pickText(input.repoRoot, payload?.repoRoot, meta?.repoRoot),
    branch: pickText(input.branch, payload?.branch, meta?.branch),
    prNumber: pickNumber(input.prNumber, payload?.prNumber, meta?.prNumber),
    prUrl: pickText(input.prUrl, payload?.prUrl, meta?.prUrl),
    actor: pickText(input.actor, payload?.actor, meta?.actor),
    status: pickText(input.status, payload?.status, meta?.status),
    attempt: pickNumber(input.attempt, payload?.attempt, meta?.attempt),
    retryCount: pickNumber(input.retryCount, payload?.retryCount, meta?.retryCount),
    durationMs: pickNumber(input.durationMs, payload?.durationMs, meta?.durationMs),
    latencyMs: pickNumber(input.latencyMs, input.durationMs, payload?.latencyMs, payload?.durationMs, meta?.latencyMs, meta?.durationMs),
    costUsd: pickNumber(input.costUsd, input.cost, payload?.costUsd, payload?.cost, meta?.costUsd, meta?.cost),
    tokenUsage,
    summary: asText(input.summary || payload?.summary || meta?.summary),
    reason: asText(input.reason || payload?.reason || meta?.reason),
    message: asText(input.message || input.content || payload?.message || payload?.content),
    payload,
    meta,
  });
}

export class HarnessObservabilitySpine {
  constructor(options = {}) {
    this.configDir = options.configDir;
    this.persist = options.persist ?? !isLikelyTestRuntime();
    this.maxInMemoryEvents = Math.max(
      100,
      Math.trunc(Number(options.maxInMemoryEvents) || DEFAULT_MAX_IN_MEMORY_EVENTS),
    );
    this.maxPersistBatchEvents = Math.max(
      1,
      Math.trunc(Number(options.maxPersistBatchEvents) || 512),
    );
    this.paths = resolveHarnessTelemetryPaths(this.configDir);
    this.projector = new LiveEventProjector(options);
    this.metrics = new RuntimeMetrics();
    this.providerUsage = new ProviderUsageLedger();
    this.runtime = createHarnessTelemetryRuntime({
      persist: this.persist,
      maxInMemoryEvents: this.maxInMemoryEvents,
      maxPersistBatchEvents: this.maxPersistBatchEvents,
      paths: this.paths,
      projector: this.projector,
      metrics: this.metrics,
      providerUsage: this.providerUsage,
    });
    this._loaded = false;
  }

  _loadOnce() {
    if (this._loaded) return;
    this._loaded = true;
    if (!this.persist) return;
    this.runtime.load(readJsonLines(this.paths.eventsPath));
  }

  _ingest(event, options = {}) {
    const normalized = normalizeCanonicalHarnessEvent(event);
    if (options.persist === false) {
      this.runtime.load([normalized]);
      return normalized;
    }
    this.runtime.record(normalized);
    return normalized;
  }

  recordEvent(event = {}) {
    this._loadOnce();
    return this._ingest(event, { persist: true });
  }

  listEvents(filter = {}) {
    this._loadOnce();
    const since = normalizeFilterTimestamp(filter.since);
    let events = this.runtime.getEvents();
    const exactFilterMap = [
      ["source", ["source"]],
      ["type", ["eventType", "type"]],
      ["category", ["category"]],
      ["taskId", ["taskId", "rootTaskId", "parentTaskId", "childTaskId"]],
      ["sessionId", ["sessionId", "rootSessionId", "parentSessionId", "childSessionId", "threadId"]],
      ["runId", ["runId", "rootRunId", "parentRunId", "childRunId"]],
      ["workflowId", ["workflowId"]],
      ["providerId", ["providerId"]],
      ["modelId", ["modelId"]],
      ["toolName", ["toolName", "toolId"]],
      ["approvalId", ["approvalId"]],
      ["actor", ["actor"]],
      ["filePath", ["filePath", "artifactPath"]],
      ["artifactId", ["artifactId"]],
      ["childSessionId", ["childSessionId"]],
      ["childTaskId", ["childTaskId"]],
      ["traceId", ["traceId"]],
      ["spanId", ["spanId", "parentSpanId"]],
      ["executionId", ["executionId", "parentExecutionId", "causedByExecutionId"]],
      ["surface", ["surface"]],
      ["channel", ["channel"]],
      ["action", ["action", "commandName"]],
      ["workspaceId", ["workspaceId"]],
      ["nodeId", ["nodeId"]],
      ["subagentId", ["subagentId"]],
    ];
    for (const [filterKey, candidateKeys] of exactFilterMap) {
      const expected = String(filter[filterKey] || "").trim();
      if (!expected) continue;
      events = events.filter((entry) => candidateKeys.some((key) => String(entry?.[key] || "").trim() === expected));
    }
    if (since != null) {
      events = events.filter((entry) => Number(entry.ts || Date.parse(entry.timestamp || 0)) >= since);
    }
    const limit = Number.isFinite(Number(filter.limit)) && Number(filter.limit) > 0
      ? Math.trunc(Number(filter.limit))
      : null;
    const sliced = limit ? events.slice(-limit) : events;
    return sliced.map(cloneValue);
  }

  getLiveSnapshot() {
    this._loadOnce();
    this.runtime.flushForeground();
    return this.projector.getSnapshot();
  }

  getMetricsSummary() {
    this._loadOnce();
    this.runtime.flushForeground();
    return this.metrics.getSummary();
  }

  getProviderUsageSummary() {
    this._loadOnce();
    this.runtime.flushForeground();
    return this.providerUsage.getUsageSummary();
  }

  getSummary() {
    this._loadOnce();
    const events = this.runtime.getEvents();
    const lastEvent = events.at(-1) || null;
    return {
      eventCount: events.length,
      lastEventAt: lastEvent?.timestamp || null,
      live: this.getLiveSnapshot(),
      metrics: this.getMetricsSummary(),
      providers: this.getProviderUsageSummary(),
      hotPath: {
        ...getBosunHotPathStatus(),
        telemetry: this.runtime.getStatus(),
      },
    };
  }

  exportTrace(filter = {}) {
    this._loadOnce();
    return exportHarnessTrace(this.listEvents(filter), filter);
  }

  async flush() {
    this._loadOnce();
    await this.runtime.flush();
  }

  reset() {
    this._loaded = false;
    this.runtime.reset();
    this.projector.reset();
    this.metrics.reset();
    this.providerUsage.reset();
  }
}

export function getHarnessObservabilitySpine(options = {}) {
  const persist = options.persist ?? !isLikelyTestRuntime();
  const key = `${resolveHarnessTelemetryPaths(options.configDir).root}|${persist ? "persist" : "memory"}`;
  if (!OBSERVABILITY_SPINES.has(key)) {
    OBSERVABILITY_SPINES.set(key, new HarnessObservabilitySpine(options));
  }
  return OBSERVABILITY_SPINES.get(key);
}

export function createHarnessObservabilitySpine(options = {}) {
  return new HarnessObservabilitySpine(options);
}

export function recordHarnessTelemetryEvent(event, options = {}) {
  return getHarnessObservabilitySpine(options).recordEvent(event);
}

export function listHarnessTelemetryEvents(filter = {}, options = {}) {
  return getHarnessObservabilitySpine(options).listEvents(filter);
}

export function getHarnessTelemetrySummary(options = {}) {
  return getHarnessObservabilitySpine(options).getSummary();
}

export function getHarnessLiveTelemetrySnapshot(options = {}) {
  return getHarnessObservabilitySpine(options).getLiveSnapshot();
}

export function getHarnessProviderUsageSummary(options = {}) {
  return getHarnessObservabilitySpine(options).getProviderUsageSummary();
}

export function exportHarnessTelemetryTrace(filter = {}, options = {}) {
  return getHarnessObservabilitySpine(options).exportTrace(filter);
}

export function getHarnessHotPathStatus(options = {}) {
  return getHarnessObservabilitySpine(options).getSummary().hotPath;
}

export async function flushHarnessTelemetryRuntimeForTests() {
  await Promise.all(
    [...OBSERVABILITY_SPINES.values()].map((spine) => spine.flush()),
  );
}

export function resetHarnessObservabilitySpinesForTests() {
  for (const spine of OBSERVABILITY_SPINES.values()) {
    spine.reset();
  }
  OBSERVABILITY_SPINES.clear();
}
