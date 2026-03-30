import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";

const TAG = "[execution-ledger]";
const LEDGER_DIR_NAME = "execution-ledger";

function normalizeLedgerDocument(runId, doc = {}) {
  return {
    version: 2,
    runId,
    workflowId: doc.workflowId || null,
    workflowName: doc.workflowName || null,
    rootRunId: doc.rootRunId || runId,
    parentRunId: doc.parentRunId || null,
    retryOf: doc.retryOf || null,
    retryMode: doc.retryMode || null,
    runKind: doc.runKind || null,
    startedAt: doc.startedAt || null,
    endedAt: doc.endedAt || null,
    status: doc.status || null,
    updatedAt: doc.updatedAt || null,
    events: Array.isArray(doc.events) ? doc.events : [],
  };
}

function cleanObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function toTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value || "").trim();
  if (!text) return 0;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function trimEdgeDashes(value) {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "-") start += 1;
  while (end > start && value[end - 1] === "-") end -= 1;
  return start === 0 && end === value.length ? value : value.slice(start, end);
}

function stableKeyPart(value, fallback = "unknown") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-");
  const trimmed = trimEdgeDashes(normalized);
  return trimmed || fallback;
}

function pickRunKind(ledger) {
  const events = Array.isArray(ledger?.events) ? [...ledger.events].reverse() : [];
  for (const event of events) {
    const kind = String(event?.runKind || event?.meta?.runKind || event?.meta?.sessionType || "").trim();
    if (kind) return kind;
  }
  return ledger?.runKind || null;
}

function collectTaskIdentityFromLedger(ledger) {
  const events = Array.isArray(ledger?.events) ? [...ledger.events].reverse() : [];
  for (const event of events) {
    const meta = event?.meta && typeof event.meta === "object" ? event.meta : null;
    const taskId = String(
      meta?.taskId || meta?.task?.id || meta?.taskInfo?.id || meta?.taskDetail?.id || "",
    ).trim();
    if (taskId) {
      return {
        taskId,
        taskTitle: String(
          meta?.taskTitle || meta?.task?.title || meta?.taskInfo?.title || meta?.taskDetail?.title || "",
        ).trim() || null,
        source: "ledger",
      };
    }
  }
  return null;
}

function collectSessionIdentityFromLedger(ledger) {
  const events = Array.isArray(ledger?.events) ? [...ledger.events].reverse() : [];
  for (const event of events) {
    const meta = event?.meta && typeof event.meta === "object" ? event.meta : null;
    const sessionId = String(
      meta?.sessionId || meta?.threadId || meta?.chatSessionId || event?.sessionId || event?.threadId || "",
    ).trim();
    if (!sessionId) continue;
    return {
      sessionId,
      sessionType: String(meta?.sessionType || meta?.runKind || "").trim() || null,
      source: "ledger",
    };
  }
  return null;
}

function inferExecutionShape(runId, event = {}) {
  const eventType = String(event?.eventType || "event").trim() || "event";
  const explicitKind = String(event?.executionKind || "").trim() || null;
  const nodeId = String(event?.nodeId || "").trim();
  const toolId = String(event?.toolId || "").trim();
  const toolName = String(event?.toolName || "").trim();
  const serverId = String(event?.serverId || event?.server || "").trim();
  const strategy = String(event?.meta?.strategy || event?.strategy || "").trim();
  const attempt = Number(event?.attempt || event?.meta?.attempt || 0);

  let executionKind = explicitKind;
  if (!executionKind) {
    if (eventType.startsWith("node.")) executionKind = "node";
    else if (eventType.startsWith("tool.")) executionKind = "tool";
    else if (eventType.startsWith("agent.")) executionKind = "agent";
    else if (eventType.startsWith("recovery.")) executionKind = "recovery";
    else executionKind = "run";
  }

  let executionId = String(event?.executionId || "").trim();
  let executionKey = String(event?.executionKey || "").trim();
  let executionLabel = String(event?.executionLabel || "").trim() || null;
  let parentExecutionId = String(event?.parentExecutionId || "").trim() || null;

  if (!executionId) {
    switch (executionKind) {
      case "node": {
        const resolvedNodeId = nodeId || "unknown";
        executionId = `node:${runId}:${resolvedNodeId}`;
        executionKey = executionKey || `node:${resolvedNodeId}`;
        executionLabel = executionLabel || event?.nodeLabel || resolvedNodeId;
        parentExecutionId = parentExecutionId || `run:${runId}`;
        break;
      }
      case "tool": {
        const toolKey = stableKeyPart(toolName || toolId || `${serverId}:${toolName}` || "tool");
        executionId = `tool:${runId}:${nodeId || "run"}:${toolKey}`;
        executionKey = executionKey || `tool:${nodeId || "run"}:${toolKey}`;
        executionLabel = executionLabel || toolName || toolId || (serverId && toolName ? `${serverId}/${toolName}` : "tool");
        parentExecutionId = parentExecutionId || (nodeId ? `node:${runId}:${nodeId}` : `run:${runId}`);
        break;
      }
      case "agent": {
        const agentKey = stableKeyPart(event?.agentId || event?.sdk || nodeId || "agent");
        executionId = `agent:${runId}:${nodeId || "run"}:${agentKey}`;
        executionKey = executionKey || `agent:${nodeId || "run"}:${agentKey}`;
        executionLabel = executionLabel || event?.agentLabel || event?.sdk || event?.nodeLabel || nodeId || "agent";
        parentExecutionId = parentExecutionId || (nodeId ? `node:${runId}:${nodeId}` : `run:${runId}`);
        break;
      }
      case "recovery": {
        const strategyKey = stableKeyPart(strategy || eventType || "recovery");
        const attemptKey = Number.isFinite(attempt) && attempt > 0 ? `:${attempt}` : "";
        executionId = `recovery:${runId}:${nodeId || "run"}:${strategyKey}${attemptKey}`;
        executionKey = executionKey || `recovery:${nodeId || "run"}:${strategyKey}`;
        executionLabel = executionLabel || strategy || eventType;
        parentExecutionId = parentExecutionId || (nodeId ? `agent:${runId}:${nodeId}:${stableKeyPart(event?.sdk || nodeId || "agent")}` : `run:${runId}`);
        break;
      }
      case "run":
      default:
        executionId = `run:${runId}`;
        executionKey = executionKey || `run:${event?.workflowId || runId}`;
        executionLabel = executionLabel || event?.workflowName || event?.workflowId || runId;
        parentExecutionId = parentExecutionId || null;
        break;
    }
  }

  if (!executionKey) executionKey = executionId;

  return {
    executionKind,
    executionId,
    executionKey,
    executionLabel,
    parentExecutionId,
  };
}

function shouldMarkStarted(eventType) {
  return [
    "run.start",
    "node.started",
    "tool.started",
    "agent.started",
    "recovery.attempted",
  ].includes(String(eventType || ""));
}

function shouldMarkEnded(eventType) {
  const normalized = String(eventType || "");
  return [
    "run.end",
    "run.error",
    "run.cancelled",
    "node.completed",
    "node.failed",
    "node.skipped",
    "tool.completed",
    "tool.failed",
    "agent.completed",
    "agent.failed",
    "agent.cancelled",
    "recovery.succeeded",
    "recovery.failed",
  ].includes(normalized);
}

function summarizeExecutionDiff(left, right) {
  return (
    (left?.status || null) !== (right?.status || null)
    || Number(left?.attempt || 0) !== Number(right?.attempt || 0)
    || Number(left?.childRunIds?.length || 0) !== Number(right?.childRunIds?.length || 0)
  );
}

export class WorkflowExecutionLedger {
  constructor({ runsDir } = {}) {
    this.runsDir = resolve(String(runsDir || process.cwd()));
    this.ledgerDir = resolve(this.runsDir, LEDGER_DIR_NAME);
  }

  _ensureDir() {
    mkdirSync(this.ledgerDir, { recursive: true });
  }

  _ledgerPath(runId) {
    return resolve(this.ledgerDir, `${runId}.json`);
  }

  getRunLedger(runId) {
    const normalizedRunId = String(runId || "").trim();
    if (!normalizedRunId) return null;
    const filePath = this._ledgerPath(normalizedRunId);
    if (!existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      return normalizeLedgerDocument(normalizedRunId, parsed);
    } catch {
      return null;
    }
  }

  listRunLedgers() {
    if (!existsSync(this.ledgerDir)) return [];
    try {
      return readdirSync(this.ledgerDir)
        .filter((file) => extname(file).toLowerCase() === ".json")
        .map((file) => this.getRunLedger(basename(file, ".json")))
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  getRunFamily(runId) {
    const ledger = this.getRunLedger(runId);
    if (!ledger) return [];
    const rootRunId = ledger.rootRunId || ledger.runId;
    return this.listRunLedgers()
      .filter((entry) => (entry?.rootRunId || entry?.runId) === rootRunId)
      .sort((left, right) => {
        const delta = toTimestamp(left?.startedAt || left?.updatedAt) - toTimestamp(right?.startedAt || right?.updatedAt);
        if (delta !== 0) return delta;
        return String(left?.runId || "").localeCompare(String(right?.runId || ""));
      });
  }

  getTaskIdentity(runId) {
    const ledger = this.getRunLedger(runId);
    if (!ledger) return null;
    return collectTaskIdentityFromLedger(ledger);
  }

  getSessionIdentity(runId) {
    const ledger = this.getRunLedger(runId);
    if (!ledger) return null;
    return collectSessionIdentityFromLedger(ledger);
  }

  listTaskRunEntries() {
    return this.listRunLedgers()
      .map((ledger) => {
        const taskIdentity = collectTaskIdentityFromLedger(ledger);
        if (!taskIdentity?.taskId) return null;
        return {
          runId: ledger.runId,
          rootRunId: ledger.rootRunId || ledger.runId,
          taskId: taskIdentity.taskId,
          taskTitle: taskIdentity.taskTitle || null,
          startedAt: ledger.startedAt || null,
          updatedAt: ledger.updatedAt || null,
          status: ledger.status || null,
        };
      })
      .filter(Boolean);
  }

  buildRunGraph(runId) {
    const family = this.getRunFamily(runId);
    if (!family.length) return null;

    const requested = this.getRunLedger(runId) || family.find((entry) => entry?.runId === runId) || family[0];
    const rootRunId = requested?.rootRunId || requested?.runId || String(runId || "").trim() || null;
    const runs = family.map((ledger) => {
      const taskIdentity = collectTaskIdentityFromLedger(ledger);
      const sessionIdentity = collectSessionIdentityFromLedger(ledger);
      return {
        runId: ledger.runId,
        workflowId: ledger.workflowId || null,
        workflowName: ledger.workflowName || null,
        rootRunId: ledger.rootRunId || ledger.runId,
        parentRunId: ledger.parentRunId || null,
        retryOf: ledger.retryOf || null,
        retryMode: ledger.retryMode || null,
        runKind: pickRunKind(ledger),
        startedAt: ledger.startedAt || null,
        endedAt: ledger.endedAt || null,
        updatedAt: ledger.updatedAt || null,
        status: ledger.status || null,
        taskId: taskIdentity?.taskId || null,
        taskTitle: taskIdentity?.taskTitle || null,
        sessionId: sessionIdentity?.sessionId || null,
        sessionType: sessionIdentity?.sessionType || null,
      };
    });

    const timeline = family
      .flatMap((ledger) =>
        (Array.isArray(ledger?.events) ? ledger.events : []).map((event) => ({
          ...event,
          runId: event?.runId || ledger.runId,
          rootRunId: event?.rootRunId || ledger.rootRunId || ledger.runId,
          parentRunId: event?.parentRunId || ledger.parentRunId || null,
        })),
      )
      .sort((left, right) => {
        const delta = toTimestamp(left?.timestamp) - toTimestamp(right?.timestamp);
        if (delta !== 0) return delta;
        const seqDelta = Number(left?.seq || 0) - Number(right?.seq || 0);
        if (seqDelta !== 0) return seqDelta;
        return String(left?.runId || "").localeCompare(String(right?.runId || ""));
      });

    const edges = [];
    const seenEdgeKeys = new Set();
    const pushEdge = (edge) => {
      const key = JSON.stringify(edge);
      if (seenEdgeKeys.has(key)) return;
      seenEdgeKeys.add(key);
      edges.push(edge);
    };

    for (const ledger of family) {
      if (ledger?.parentRunId) {
        pushEdge({
          type: "parent-child",
          parentRunId: ledger.parentRunId,
          childRunId: ledger.runId,
          rootRunId: ledger.rootRunId || ledger.runId,
        });
      }
      if (ledger?.retryOf) {
        pushEdge({
          type: "retry",
          parentRunId: ledger.retryOf,
          childRunId: ledger.runId,
          mode: ledger.retryMode || null,
          rootRunId: ledger.rootRunId || ledger.runId,
        });
      }
    }

    const executionMap = new Map();
    for (const event of timeline) {
      const executionId = String(event?.executionId || "").trim();
      const resolvedExecutionId = executionId || inferExecutionShape(event?.runId || requested?.runId || rootRunId, event).executionId;
      const shape = inferExecutionShape(event?.runId || requested?.runId || rootRunId, {
        ...event,
        executionId: resolvedExecutionId,
      });
      const current = executionMap.get(shape.executionId) || {
        executionId: shape.executionId,
        executionKey: shape.executionKey,
        executionKind: shape.executionKind,
        executionLabel: shape.executionLabel,
        nodeId: event?.nodeId || null,
        nodeType: event?.nodeType || null,
        nodeLabel: event?.nodeLabel || null,
        toolId: event?.toolId || null,
        toolName: event?.toolName || null,
        serverId: event?.serverId || event?.server || null,
        runId: event?.runId || null,
        rootRunId: event?.rootRunId || null,
        parentRunId: event?.parentRunId || null,
        parentExecutionId: shape.parentExecutionId || null,
        causedByExecutionId: event?.causedByExecutionId || null,
        childRunIds: [],
        retryOf: event?.retryOf || null,
        retryMode: event?.retryMode || null,
        status: null,
        startedAt: null,
        endedAt: null,
        attempt: 0,
        eventTypes: [],
        errors: [],
      };
      current.executionKey = current.executionKey || shape.executionKey;
      current.executionKind = current.executionKind || shape.executionKind;
      current.executionLabel = current.executionLabel || shape.executionLabel;
      current.nodeId = current.nodeId || event?.nodeId || null;
      current.nodeType = current.nodeType || event?.nodeType || null;
      current.nodeLabel = current.nodeLabel || event?.nodeLabel || null;
      current.toolId = current.toolId || event?.toolId || null;
      current.toolName = current.toolName || event?.toolName || null;
      current.serverId = current.serverId || event?.serverId || event?.server || null;
      current.runId = current.runId || event?.runId || null;
      current.rootRunId = current.rootRunId || event?.rootRunId || null;
      current.parentRunId = current.parentRunId || event?.parentRunId || null;
      current.parentExecutionId = current.parentExecutionId || shape.parentExecutionId || null;
      current.causedByExecutionId = current.causedByExecutionId || event?.causedByExecutionId || null;
      current.retryOf = current.retryOf || event?.retryOf || null;
      current.retryMode = current.retryMode || event?.retryMode || null;
      current.eventTypes.push(String(event?.eventType || "event"));
      current.attempt = Math.max(current.attempt, Number(event?.attempt || 0));
      if (shouldMarkStarted(event?.eventType) && !current.startedAt) {
        current.startedAt = event.timestamp || null;
      }
      if (shouldMarkEnded(event?.eventType)) {
        current.endedAt = event.timestamp || current.endedAt || null;
        current.status = event?.status || current.status || null;
      } else if (event?.status) {
        current.status = event.status;
      }
      if (event?.error) current.errors.push(String(event.error));
      if (event?.childRunId && !current.childRunIds.includes(event.childRunId)) {
        current.childRunIds.push(event.childRunId);
      }
      executionMap.set(shape.executionId, current);

      if (shape.parentExecutionId) {
        pushEdge({
          type: "execution",
          parentExecutionId: shape.parentExecutionId,
          childExecutionId: shape.executionId,
          runId: event?.runId || null,
          rootRunId: event?.rootRunId || null,
        });
      }
      if (event?.causedByExecutionId) {
        pushEdge({
          type: "causal",
          parentExecutionId: event.causedByExecutionId,
          childExecutionId: shape.executionId,
          runId: event?.runId || null,
          rootRunId: event?.rootRunId || null,
        });
      }
      if (event?.childRunId) {
        pushEdge({
          type: "execution-run",
          parentExecutionId: shape.executionId,
          childRunId: event.childRunId,
          runId: event?.runId || null,
          rootRunId: event?.rootRunId || null,
        });
      }
    }

    const executions = Array.from(executionMap.values()).sort((left, right) => {
      const delta = toTimestamp(left?.startedAt || left?.endedAt) - toTimestamp(right?.startedAt || right?.endedAt);
      if (delta !== 0) return delta;
      return String(left?.executionId || "").localeCompare(String(right?.executionId || ""));
    });

    return {
      requestedRunId: requested?.runId || null,
      rootRunId,
      runs,
      edges,
      timeline,
      executions,
    };
  }

  diffRunGraphs(baseRunId, comparisonRunId) {
    const baseLedger = this.getRunLedger(baseRunId);
    const comparisonLedger = this.getRunLedger(comparisonRunId);
    if (!baseLedger || !comparisonLedger) return null;

    const toExecutionMap = (ledger) => {
      const map = new Map();
      for (const event of Array.isArray(ledger?.events) ? ledger.events : []) {
        const shape = inferExecutionShape(ledger.runId, event);
        const key = shape.executionKey || shape.executionId;
        const current = map.get(key) || {
          executionId: shape.executionId,
          executionKey: key,
          executionKind: shape.executionKind,
          executionLabel: shape.executionLabel,
          nodeId: event?.nodeId || null,
          runId: ledger.runId,
          status: null,
          attempt: 0,
          childRunIds: [],
        };
        current.status = event?.status || current.status || null;
        current.attempt = Math.max(current.attempt, Number(event?.attempt || 0));
        if (event?.childRunId && !current.childRunIds.includes(event.childRunId)) {
          current.childRunIds.push(event.childRunId);
        }
        map.set(key, current);
      }
      return map;
    };

    const baseExecutions = toExecutionMap(baseLedger);
    const comparisonExecutions = toExecutionMap(comparisonLedger);
    const allIds = new Set([...baseExecutions.keys(), ...comparisonExecutions.keys()]);
    const added = [];
    const removed = [];
    const changed = [];

    for (const executionKey of allIds) {
      const left = baseExecutions.get(executionKey) || null;
      const right = comparisonExecutions.get(executionKey) || null;
      if (!left && right) {
        added.push({
          executionKey,
          executionKind: right.executionKind || null,
          comparisonStatus: right.status || null,
          nodeId: right.nodeId || null,
        });
        continue;
      }
      if (left && !right) {
        removed.push({
          executionKey,
          executionKind: left.executionKind || null,
          baseStatus: left.status || null,
          nodeId: left.nodeId || null,
        });
        continue;
      }
      if (!left || !right) continue;
      if (summarizeExecutionDiff(left, right)) {
        changed.push({
          executionKey,
          executionKind: left.executionKind || right.executionKind || null,
          nodeId: left.nodeId || right.nodeId || null,
          baseStatus: left.status || null,
          comparisonStatus: right.status || null,
          baseAttempt: Number(left.attempt || 0),
          comparisonAttempt: Number(right.attempt || 0),
          baseChildRunCount: Number(left.childRunIds?.length || 0),
          comparisonChildRunCount: Number(right.childRunIds?.length || 0),
        });
      }
    }

    return {
      baseRunId: baseLedger.runId,
      comparisonRunId: comparisonLedger.runId,
      executionDelta: {
        added,
        removed,
        changed,
      },
    };
  }

  ensureRun(meta = {}) {
    const runId = String(meta.runId || "").trim();
    if (!runId) {
      throw new Error(`${TAG} runId is required`);
    }

    this._ensureDir();
    const existing = this.getRunLedger(runId);
    const merged = normalizeLedgerDocument(runId, {
      ...existing,
      ...cleanObject(meta),
      rootRunId: meta.rootRunId || existing?.rootRunId || runId,
      events: existing?.events || [],
    });
    writeFileSync(this._ledgerPath(runId), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    return merged;
  }

  appendEvent(event = {}) {
    const runId = String(event.runId || "").trim();
    if (!runId) {
      throw new Error(`${TAG} event.runId is required`);
    }

    const timestamp = String(event.timestamp || new Date().toISOString()).trim() || new Date().toISOString();
    const shape = inferExecutionShape(runId, event);
    this._ensureDir();
    const existing = this.getRunLedger(runId);
    const ledger = normalizeLedgerDocument(runId, {
      ...existing,
      runId,
      workflowId: event.workflowId || null,
      workflowName: event.workflowName || null,
      rootRunId: event.rootRunId || existing?.rootRunId || runId,
      parentRunId: event.parentRunId || existing?.parentRunId || null,
      retryOf: event.retryOf || existing?.retryOf || null,
      retryMode: event.retryMode || existing?.retryMode || null,
      runKind: event.runKind || event.meta?.runKind || existing?.runKind || undefined,
      startedAt: event.eventType === "run.start"
        ? timestamp
        : (existing?.startedAt || undefined),
      endedAt: event.eventType === "run.end" || event.eventType === "run.error" || event.eventType === "run.cancelled"
        ? timestamp
        : (existing?.endedAt || undefined),
      status: event.status || existing?.status || undefined,
      updatedAt: timestamp,
      events: Array.isArray(existing?.events) ? existing.events : [],
    });

    const nextSeq = (ledger.events.at(-1)?.seq || 0) + 1;
    const payload = cleanObject({
      id: randomUUID(),
      seq: nextSeq,
      timestamp,
      eventType: String(event.eventType || "event").trim() || "event",
      runId,
      workflowId: event.workflowId || ledger.workflowId || null,
      workflowName: event.workflowName || ledger.workflowName || null,
      rootRunId: event.rootRunId || ledger.rootRunId || runId,
      parentRunId: event.parentRunId || ledger.parentRunId || null,
      retryOf: event.retryOf || ledger.retryOf || null,
      retryMode: event.retryMode || ledger.retryMode || null,
      runKind: event.runKind || event.meta?.runKind || ledger.runKind || null,
      executionId: shape.executionId,
      executionKey: shape.executionKey,
      executionKind: shape.executionKind,
      executionLabel: shape.executionLabel,
      parentExecutionId: event.parentExecutionId || shape.parentExecutionId || null,
      causedByExecutionId: event.causedByExecutionId || null,
      childRunId: event.childRunId || null,
      nodeId: event.nodeId || null,
      nodeType: event.nodeType || null,
      nodeLabel: event.nodeLabel || null,
      toolId: event.toolId || null,
      toolName: event.toolName || null,
      serverId: event.serverId || event.server || null,
      status: event.status || null,
      attempt: Number.isFinite(Number(event.attempt)) ? Number(event.attempt) : undefined,
      durationMs: Number.isFinite(Number(event.durationMs)) ? Number(event.durationMs) : undefined,
      error: event.error ? String(event.error) : null,
      summary: event.summary ? String(event.summary) : null,
      reason: event.reason ? String(event.reason) : null,
      meta: event.meta && typeof event.meta === "object" ? event.meta : undefined,
    });

    ledger.events.push(payload);
    ledger.updatedAt = timestamp;
    if (payload.eventType === "run.start" && !ledger.startedAt) {
      ledger.startedAt = timestamp;
    }
    if (payload.runKind && !ledger.runKind) ledger.runKind = payload.runKind;
    if (payload.eventType === "run.end" || payload.eventType === "run.error" || payload.eventType === "run.cancelled") {
      ledger.endedAt = timestamp;
      ledger.status = payload.status || ledger.status || null;
    } else if (payload.status && !String(payload.eventType).startsWith("node.")) {
      ledger.status = payload.status;
    }

    writeFileSync(this._ledgerPath(runId), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    return payload;
  }
}
