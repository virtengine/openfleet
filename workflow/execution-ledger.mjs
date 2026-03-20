import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const TAG = "[execution-ledger]";
const LEDGER_DIR_NAME = "execution-ledger";

function normalizeLedgerDocument(runId, doc = {}) {
  return {
    version: 1,
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
    events: Array.isArray(doc.events) ? doc.events : [],
  };
}

function cleanObject(value = {}) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
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
    const ledger = this.ensureRun({
      runId,
      workflowId: event.workflowId || null,
      workflowName: event.workflowName || null,
      rootRunId: event.rootRunId || runId,
      parentRunId: event.parentRunId || null,
      retryOf: event.retryOf || null,
      retryMode: event.retryMode || null,
      startedAt: event.eventType === "run.start" ? timestamp : undefined,
      endedAt: event.eventType === "run.end" || event.eventType === "run.error" || event.eventType === "run.cancelled"
        ? timestamp
        : undefined,
      status: event.status || undefined,
      updatedAt: timestamp,
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
    if (payload.eventType === "run.start" && !ledger.startedAt) {
      ledger.startedAt = timestamp;
    }
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
