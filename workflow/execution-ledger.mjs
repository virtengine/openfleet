import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const TAG = "[execution-ledger]";
const LEDGER_DIR_NAME = "execution-ledger";

function normalizeLedgerDocument(runId, doc = {}) {
  return {
    version: 3,
    runId,
    workflowId: doc.workflowId || null,
    workflowName: doc.workflowName || null,
    rootRunId: doc.rootRunId || runId,
    parentRunId: doc.parentRunId || null,
    retryOf: doc.retryOf || null,
    retryMode: doc.retryMode || null,
    startedAt: doc.startedAt || null,
    endedAt: doc.endedAt || null,
    status: doc.status || null,
    updatedAt: doc.updatedAt || null,
    meta: doc.meta && typeof doc.meta === "object" ? doc.meta : {},
    events: Array.isArray(doc.events) ? doc.events : [],
  };
}

function cleanObject(value = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function toIsoTimestamp(value) {
  const normalized = String(value || "").trim();
  return normalized || new Date().toISOString();
}

function compareIso(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function isTerminalEvent(eventType) {
  return eventType === "run.end" || eventType === "run.error" || eventType === "run.cancelled";
}

function mergeMeta(base = {}, extra = {}) {
  return {
    ...(base && typeof base === "object" ? base : {}),
    ...(extra && typeof extra === "object" ? extra : {}),
  };
}

function dedupeEdges(edges = []) {
  const out = [];
  const seen = new Set();
  for (const edge of edges) {
    const key = JSON.stringify(edge);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(edge);
  }
  return out;
}

function isRunEndStatus(status) {
  return ["completed", "failed", "cancelled", "paused"].includes(String(status || "").trim().toLowerCase());
}

function isActiveRunStatus(status) {
  const normalized = String(status || "").trim().toLowerCase();
  return normalized === "running" || normalized === "paused";
}

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
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

  listRunIds() {
    if (!existsSync(this.ledgerDir)) return [];
    return readdirSync(this.ledgerDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .sort();
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

  ensureRun(meta = {}) {
    const runId = String(meta.runId || "").trim();
    if (!runId) throw new Error(`${TAG} runId is required`);

    this._ensureDir();
    const existing = this.getRunLedger(runId);
    const merged = normalizeLedgerDocument(runId, {
      ...existing,
      ...cleanObject(meta),
      rootRunId: meta.rootRunId || existing?.rootRunId || runId,
      meta: mergeMeta(existing?.meta, meta.meta),
      events: existing?.events || [],
    });
    writeFileSync(this._ledgerPath(runId), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    return merged;
  }

  appendEvent(event = {}) {
    const runId = String(event.runId || "").trim();
    if (!runId) throw new Error(`${TAG} event.runId is required`);

    const timestamp = toIsoTimestamp(event.timestamp);
    const ledger = this.ensureRun({
      runId,
      workflowId: event.workflowId || null,
      workflowName: event.workflowName || null,
      rootRunId: event.rootRunId || runId,
      parentRunId: event.parentRunId || null,
      retryOf: event.retryOf || null,
      retryMode: event.retryMode || null,
      startedAt: event.eventType === "run.start" ? timestamp : undefined,
      endedAt: isTerminalEvent(event.eventType) ? timestamp : undefined,
      status: event.status || undefined,
      updatedAt: timestamp,
      meta: event.meta,
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
      nodeId: event.nodeId || null,
      nodeType: event.nodeType || null,
      nodeLabel: event.nodeLabel || null,
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
    ledger.meta = mergeMeta(ledger.meta, payload.meta);
    if (payload.eventType === "run.start" && !ledger.startedAt) ledger.startedAt = timestamp;
    if (isTerminalEvent(payload.eventType)) {
      ledger.endedAt = timestamp;
      ledger.status = payload.status || ledger.status || null;
    } else if (payload.status && !String(payload.eventType).startsWith("node.")) {
      ledger.status = payload.status;
      if (isRunEndStatus(payload.status)) ledger.endedAt ||= timestamp;
    }

    writeFileSync(this._ledgerPath(runId), `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    return payload;
  }

  replayRun(runId) {
    const run = this.getRunLedger(runId);
    if (!run) return null;
    const timeline = [...run.events].sort((a, b) => {
      const tsCmp = compareIso(a.timestamp, b.timestamp);
      return tsCmp !== 0 ? tsCmp : (a.seq || 0) - (b.seq || 0);
    });
    const nodes = {};
    for (const event of timeline) {
      if (!event.nodeId) continue;
      const node = nodes[event.nodeId] || {
        nodeId: event.nodeId,
        nodeType: event.nodeType || null,
        nodeLabel: event.nodeLabel || null,
        status: null,
        startedAt: null,
        endedAt: null,
        attempts: 0,
        tools: [],
        events: [],
      };
      node.events.push(event);
      if (event.nodeType && !node.nodeType) node.nodeType = event.nodeType;
      if (event.nodeLabel && !node.nodeLabel) node.nodeLabel = event.nodeLabel;
      if (event.eventType === "node.started" || event.eventType === "node.start") {
        node.startedAt ||= event.timestamp;
        node.status = event.status || "running";
      }
      if (event.eventType === "node.completed" || event.eventType === "node.end") {
        node.endedAt = event.timestamp;
        node.status = event.status || "completed";
      }
      if (event.eventType === "node.error") {
        node.endedAt = event.timestamp;
        node.status = event.status || "failed";
      }
      if (event.eventType === "node.retry") {
        node.attempts = Math.max(node.attempts, Number(event.attempt) || 0);
        node.status = "retrying";
      }
      if (event.eventType === "tool.execution") {
        node.tools.push({
          timestamp: event.timestamp,
          toolName: event.meta?.toolName || null,
          invocationId: event.meta?.invocationId || null,
          meta: event.meta || {},
        });
      }
      nodes[event.nodeId] = node;
    }
    return { run, timeline, nodes };
  }

  getRunGraph(runId) {
    return this.rebuildRunGraph(runId);
  }

  _getRunsForRoot(rootRunId) {
    return this.listRunIds()
      .map((id) => this.getRunLedger(id))
      .filter(Boolean)
      .filter((entry) => (entry.rootRunId || entry.runId) === rootRunId);
  }

  rebuildRunGraph(runId) {
    const root = this.getRunLedger(runId);
    if (!root) return null;
    const rootRunId = root.rootRunId || root.runId;
    const runs = this._getRunsForRoot(rootRunId);

    const edges = [];
    for (const run of runs) {
      if (run.parentRunId) {
        edges.push({
          fromRunId: run.parentRunId,
          toRunId: run.runId,
          edgeType: run.meta?.edgeType || (run.meta?.runKind === "agent" ? "delegated" : "parent-child"),
          nodeId: run.meta?.parentNodeId || null,
        });
      }
      if (run.retryOf) {
        edges.push({
          fromRunId: run.retryOf,
          toRunId: run.runId,
          edgeType: "recovery",
          retryMode: run.retryMode || null,
        });
      }
      for (const event of run.events) {
        if (event.eventType === "child.run.spawned" && event.meta?.childRunId) {
          edges.push({
            fromRunId: run.runId,
            toRunId: event.meta.childRunId,
            edgeType: event.meta.edgeType || "child",
            nodeId: event.nodeId || event.meta.parentNodeId || null,
          });
        }
        if (event.eventType === "run.recovery_scheduled" && event.meta?.recoveryRunId) {
          edges.push({
            fromRunId: run.runId,
            toRunId: event.meta.recoveryRunId,
            edgeType: "recovery",
            attempt: event.attempt || null,
            reason: event.reason || null,
          });
        }
      }
    }

    const runsById = Object.fromEntries(runs.map((run) => [run.runId, run]));
    const childRunIdsByParent = {};
    for (const edge of dedupeEdges(edges)) {
      if (!edge.fromRunId || !edge.toRunId) continue;
      if (!childRunIdsByParent[edge.fromRunId]) childRunIdsByParent[edge.fromRunId] = [];
      if (!childRunIdsByParent[edge.fromRunId].includes(edge.toRunId)) {
        childRunIdsByParent[edge.fromRunId].push(edge.toRunId);
      }
    }

    return {
      rootRunId,
      runs: runs.map((run) => ({
        runId: run.runId,
        rootRunId: run.rootRunId,
        parentRunId: run.parentRunId,
        retryOf: run.retryOf,
        retryMode: run.retryMode,
        workflowId: run.workflowId,
        workflowName: run.workflowName,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        runKind: run.meta?.runKind || null,
        dedupKey: run.meta?.dedupKey || null,
        recovery: run.retryOf || run.meta?.recoveryAttempt
          ? {
              attempt: Number(run.meta?.recoveryAttempt || 0) || null,
              retryOf: run.retryOf || null,
              retryMode: run.retryMode || null,
            }
          : null,
        eventCount: run.events.length,
        childRunIds: childRunIdsByParent[run.runId] || [],
      })).sort((a, b) => compareIso(a.startedAt, b.startedAt)),
      edges: dedupeEdges(edges),
      childrenByRunId: childRunIdsByParent,
      summaries: this.listRunSummaries({ rootRunId, includeGraphs: false, _runs: runsById }),
    };
  }

  diffRuns(beforeRunId, afterRunId) {
    const before = this.replayRun(beforeRunId);
    const after = this.replayRun(afterRunId);
    if (!before || !after) return null;
    const beforeNodes = new Set(Object.keys(before.nodes));
    const afterNodes = new Set(Object.keys(after.nodes));
    return {
      beforeRunId,
      afterRunId,
      addedNodeIds: [...afterNodes].filter((nodeId) => !beforeNodes.has(nodeId)).sort(),
      removedNodeIds: [...beforeNodes].filter((nodeId) => !afterNodes.has(nodeId)).sort(),
      changedNodeIds: [...afterNodes].filter((nodeId) => beforeNodes.has(nodeId) && stableStringify(before.nodes[nodeId]) !== stableStringify(after.nodes[nodeId])).sort(),
      eventDelta: after.timeline.length - before.timeline.length,
      statusChanged: before.run.status !== after.run.status,
      graphDelta: this.diffRunGraphs(beforeRunId, afterRunId),
    };
  }

  diffRunGraphs(beforeRunId, afterRunId) {
    const before = this.rebuildRunGraph(beforeRunId);
    const after = this.rebuildRunGraph(afterRunId);
    if (!before || !after) return null;
    const beforeRunIds = new Set(before.runs.map((run) => run.runId));
    const afterRunIds = new Set(after.runs.map((run) => run.runId));
    const beforeEdges = new Set(before.edges.map((edge) => stableStringify(edge)));
    const afterEdges = new Set(after.edges.map((edge) => stableStringify(edge)));
    return {
      beforeRootRunId: before.rootRunId,
      afterRootRunId: after.rootRunId,
      addedRunIds: [...afterRunIds].filter((runId) => !beforeRunIds.has(runId)).sort(),
      removedRunIds: [...beforeRunIds].filter((runId) => !afterRunIds.has(runId)).sort(),
      addedEdges: after.edges.filter((edge) => !beforeEdges.has(stableStringify(edge))),
      removedEdges: before.edges.filter((edge) => !afterEdges.has(stableStringify(edge))),
    };
  }

  listRunSummaries(options = {}) {
    const rootRunId = String(options.rootRunId || "").trim();
    const workflowId = String(options.workflowId || "").trim();
    const taskId = String(options.taskId || "").trim();
    const dedupKey = String(options.dedupKey || "").trim();
    const includeGraphs = options.includeGraphs !== false;
    const providedRuns = options._runs && typeof options._runs === "object" ? Object.values(options._runs) : null;
    const runs = (providedRuns || this.listRunIds().map((id) => this.getRunLedger(id)).filter(Boolean))
      .filter((run) => !rootRunId || (run.rootRunId || run.runId) === rootRunId)
      .filter((run) => !workflowId || run.workflowId === workflowId)
      .filter((run) => !taskId || String(run.meta?.taskId || "") === taskId)
      .filter((run) => !dedupKey || String(run.meta?.dedupKey || "") === dedupKey)
      .sort((a, b) => compareIso(b.startedAt, a.startedAt));

    return runs.map((run) => {
      const graph = includeGraphs ? this.rebuildRunGraph(run.runId) : null;
      const childRuns = Array.isArray(graph?.childrenByRunId?.[run.runId]) ? graph.childrenByRunId[run.runId] : [];
      return {
        runId: run.runId,
        rootRunId: run.rootRunId || run.runId,
        parentRunId: run.parentRunId || null,
        retryOf: run.retryOf || null,
        retryMode: run.retryMode || null,
        workflowId: run.workflowId || null,
        workflowName: run.workflowName || null,
        status: run.status || null,
        startedAt: run.startedAt || null,
        endedAt: run.endedAt || null,
        updatedAt: run.updatedAt || null,
        taskId: run.meta?.taskId || null,
        taskTitle: run.meta?.taskTitle || null,
        runKind: run.meta?.runKind || null,
        dedupKey: run.meta?.dedupKey || null,
        parentNodeId: run.meta?.parentNodeId || null,
        edgeType: run.meta?.edgeType || null,
        recoveryAttempt: Number(run.meta?.recoveryAttempt || 0) || null,
        resumeResult: run.meta?.resumeResult || null,
        active: isActiveRunStatus(run.status),
        childRunCount: childRuns.length,
        eventCount: Array.isArray(run.events) ? run.events.length : 0,
        latestEventType: run.events.at(-1)?.eventType || null,
        latestSummary: run.events.at(-1)?.summary || null,
      };
    });
  }

  listActiveRunSummaries(options = {}) {
    return this.listRunSummaries(options).filter((run) => run.active);
  }

  getLatestTaskRun(taskId, options = {}) {
    const normalizedTaskId = String(taskId || "").trim();
    if (!normalizedTaskId) return null;
    return this.listRunSummaries({
      ...options,
      taskId: normalizedTaskId,
      includeGraphs: false,
    })[0] || null;
  }

  getLatestActiveTaskRun(taskId, options = {}) {
    const normalizedTaskId = String(taskId || "").trim();
    if (!normalizedTaskId) return null;
    return this.listActiveRunSummaries({
      ...options,
      taskId: normalizedTaskId,
      includeGraphs: false,
    })[0] || null;
  }

  getRecoveryAttempts(runId) {
    const graph = this.rebuildRunGraph(runId);
    if (!graph) return [];
    return graph.runs
      .filter((entry) => entry.retryOf || entry.recovery?.retryOf || entry.recovery?.attempt)
      .sort((a, b) => compareIso(a.startedAt, b.startedAt));
  }

  findDuplicateRuns(dedupKey) {
    const targetKey = String(dedupKey || "").trim();
    if (!targetKey) return { dedupKey: targetKey, latestRunId: null, duplicateRunIds: [] };
    const matches = this.listRunIds()
      .map((id) => this.getRunLedger(id))
      .filter(Boolean)
      .filter((run) => String(run.meta?.dedupKey || "").trim() === targetKey)
      .sort((a, b) => compareIso(a.startedAt, b.startedAt));
    if (matches.length === 0) return { dedupKey: targetKey, latestRunId: null, duplicateRunIds: [] };
    const latest = matches[matches.length - 1];
    return {
      dedupKey: targetKey,
      latestRunId: latest.runId,
      duplicateRunIds: matches.slice(0, -1).map((run) => run.runId),
      runs: matches.map((run) => ({
        runId: run.runId,
        status: run.status || null,
        startedAt: run.startedAt || null,
        endedAt: run.endedAt || null,
        rootRunId: run.rootRunId || run.runId,
      })),
    };
  }

  findDuplicateActiveRuns(query = {}) {
    const dedupKey = String(query?.dedupKey || query?.taskId || "").trim();
    return this.findDuplicateRuns(dedupKey);
  }
}


