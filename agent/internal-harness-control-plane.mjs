import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { compileInternalHarnessProfile } from "./internal-harness-profile.mjs";
import {
  getHarnessRunFromStateLedger,
  listHarnessRunsFromStateLedger,
  writeHarnessRunToStateLedger,
} from "../lib/state-ledger-sqlite.mjs";
import { recordHarnessTelemetryEvent } from "../infra/session-telemetry.mjs";

function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function normalizeValidationMode(value) {
  const normalized = toTrimmedString(value).toLowerCase();
  return ["off", "report", "enforce"].includes(normalized) ? normalized : "report";
}

export function resolveHarnessControlPlanePaths(configDir) {
  const root = resolve(String(configDir || process.cwd()), ".cache", "harness");
  return {
    root,
    compiledDir: resolve(root, "compiled"),
    runsDir: resolve(root, "runs"),
    activeStatePath: resolve(root, "active-harness.json"),
  };
}

function resolveHarnessLedgerOptions(configDir) {
  return {
    anchorPath: resolveHarnessControlPlanePaths(configDir).runsDir,
  };
}

export function resolveHarnessSourcePath(sourcePath, options = {}) {
  const raw = toTrimmedString(sourcePath);
  if (!raw) return "";
  const candidates = [];
  if (/^[a-zA-Z]:[\\/]|^\//.test(raw)) {
    candidates.push(resolve(raw));
  } else {
    if (options.repoRoot) candidates.push(resolve(options.repoRoot, raw));
    if (options.configDir) candidates.push(resolve(options.configDir, raw));
    candidates.push(resolve(raw));
  }
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0] || "";
}

export function readHarnessSourceFromPath(sourcePath, options = {}) {
  const resolvedPath = resolveHarnessSourcePath(sourcePath, options);
  if (!resolvedPath || !existsSync(resolvedPath)) {
    throw new Error(`Harness source file not found: ${sourcePath}`);
  }
  return {
    sourcePath: resolvedPath,
    source: readFileSync(resolvedPath, "utf8"),
  };
}

function writeJson(filePath, data) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export function readHarnessArtifact(artifactPath) {
  const resolvedPath = resolve(String(artifactPath || ""));
  if (!existsSync(resolvedPath)) {
    throw new Error(`Harness artifact not found: ${artifactPath}`);
  }
  return JSON.parse(readFileSync(resolvedPath, "utf8"));
}

export function readActiveHarnessState(configDir) {
  const { activeStatePath } = resolveHarnessControlPlanePaths(configDir);
  if (!existsSync(activeStatePath)) return null;
  return JSON.parse(readFileSync(activeStatePath, "utf8"));
}

export function readHarnessRunRecord(runPath) {
  const resolvedPath = resolve(String(runPath || ""));
  const runId = basename(resolvedPath, ".json");
  const configDir = resolve(dirname(resolvedPath), "..", "..", "..");
  try {
    const sqlRecord = getHarnessRunFromStateLedger(runId, resolveHarnessLedgerOptions(configDir));
    if (sqlRecord) return sqlRecord;
  } catch {
    // fall back to legacy JSON record below
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`Harness run record not found: ${runPath}`);
  }
  return JSON.parse(readFileSync(resolvedPath, "utf8"));
}

export function readHarnessRunRecordById(configDir, runId) {
  const normalizedRunId = toTrimmedString(runId);
  if (!normalizedRunId) {
    throw new Error("Harness runId is required");
  }
  const sqlRecord = getHarnessRunFromStateLedger(normalizedRunId, resolveHarnessLedgerOptions(configDir));
  if (sqlRecord) return sqlRecord;
  const { runsDir } = resolveHarnessControlPlanePaths(configDir);
  return readHarnessRunRecord(resolve(runsDir, `${normalizedRunId}.json`));
}

function buildHarnessRunSummary(runRecord) {
  return {
    runId: runRecord.runId,
    taskId: runRecord.taskId || null,
    taskKey: runRecord.taskKey || null,
    mode: runRecord.mode,
    dryRun: runRecord.dryRun === true,
    success: runRecord.result?.success === true,
    status: runRecord.result?.status || null,
    startedAt: runRecord.startedAt,
    finishedAt: runRecord.finishedAt,
    artifactId: runRecord.artifactId || null,
    agentId: runRecord.compiledProfile?.agentId || null,
    eventCount: Array.isArray(runRecord.events) ? runRecord.events.length : 0,
    observability: runRecord.observability || null,
  };
}

function summarizeHarnessObservability(events = []) {
  const summary = {
    categories: {},
    eventTypes: {},
    approvals: 0,
    tools: 0,
    subagents: 0,
    fileMutations: 0,
    patchApplications: 0,
  };
  for (const event of Array.isArray(events) ? events : []) {
    const category = toTrimmedString(event?.category || "") || "runtime";
    const type = toTrimmedString(event?.type || event?.eventType || "") || "event";
    summary.categories[category] = Number(summary.categories[category] || 0) + 1;
    summary.eventTypes[type] = Number(summary.eventTypes[type] || 0) + 1;
    if (toTrimmedString(event?.approvalId || "")) summary.approvals += 1;
    if (toTrimmedString(event?.toolId || event?.toolName || "")) summary.tools += 1;
    if (/subagent/i.test(category) || /subagent/i.test(type)) summary.subagents += 1;
    if (
      /artifact|patch|file\.|mutation/i.test(category)
      || /artifact|patch|file\.|mutation/i.test(type)
      || toTrimmedString(event?.filePath || event?.artifactPath || event?.patchHash || "")
    ) {
      summary.fileMutations += 1;
    }
    if (/patch/i.test(type) || toTrimmedString(event?.patchHash || "")) {
      summary.patchApplications += 1;
    }
  }
  return summary;
}

function recordHarnessRunObservabilityEvents(runRecord, configDir) {
  const events = Array.isArray(runRecord?.events) ? runRecord.events : [];
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== "object") continue;
    const eventType = toTrimmedString(rawEvent.eventType || rawEvent.type) || "event";
    recordHarnessTelemetryEvent({
      ...rawEvent,
      id: toTrimmedString(rawEvent.id || "") || undefined,
      timestamp: toTrimmedString(rawEvent.timestamp || "") || runRecord.recordedAt,
      eventType,
      type: eventType,
      source: toTrimmedString(rawEvent.source || "internal-harness-control-plane") || "internal-harness-control-plane",
      taskId: toTrimmedString(rawEvent.taskId || runRecord.taskId || "") || null,
      sessionId: toTrimmedString(rawEvent.sessionId || runRecord.runId || runRecord.taskId || "") || null,
      runId: toTrimmedString(rawEvent.runId || runRecord.runId || "") || null,
      actor: toTrimmedString(rawEvent.actor || runRecord.actor || "") || null,
      summary: toTrimmedString(rawEvent.summary || rawEvent.reason || rawEvent.message || "") || null,
      payload: rawEvent,
      meta: {
        sourceOrigin: runRecord.sourceOrigin || null,
        artifactId: runRecord.artifactId || null,
        controlPlaneRunId: runRecord.runId,
      },
    }, { configDir });
  }
}

export function compileHarnessSourceToArtifact(source, options = {}) {
  const validationMode = normalizeValidationMode(options.validationMode);
  const compileResult = compileInternalHarnessProfile(source, options);
  const paths = resolveHarnessControlPlanePaths(options.configDir);
  ensureDir(paths.compiledDir);
  const artifactId = `${compileResult.agentId}-${compileResult.sourceHash.slice(0, 12)}`;
  const artifactPath = resolve(paths.compiledDir, `${artifactId}.json`);
  const artifact = {
    schemaVersion: 1,
    kind: "bosun-harness-artifact",
    artifactId,
    artifactPath,
    compiledAt: compileResult.compiledProfile.metadata.compiledAt,
    sourceOrigin: toTrimmedString(options.sourceOrigin || "inline") || "inline",
    sourcePath: toTrimmedString(options.sourcePath || "") || null,
    validationMode,
    isValid: compileResult.isValid,
    validationReport: compileResult.validationReport,
    compiledProfile: compileResult.compiledProfile,
    compiledProfileJson: compileResult.compiledProfileJson,
  };
  writeJson(artifactPath, artifact);
  recordHarnessTelemetryEvent({
    timestamp: artifact.compiledAt,
    eventType: "harness.artifact.compiled",
    type: "harness.artifact.compiled",
    source: "internal-harness-control-plane",
    category: "artifact",
    actor: toTrimmedString(options.actor || "api") || "api",
    artifactId,
    artifactPath,
    status: artifact.isValid === true ? "compiled" : "invalid",
    summary: artifact.compiledProfile?.name || artifact.compiledProfile?.agentId || "harness artifact",
    payload: {
      sourceOrigin: artifact.sourceOrigin,
      sourcePath: artifact.sourcePath,
      validationMode: artifact.validationMode,
      isValid: artifact.isValid,
      agentId: artifact.compiledProfile?.agentId || null,
      entryStageId: artifact.compiledProfile?.entryStageId || null,
    },
    meta: {
      source: "internal-harness-control-plane",
      sourceOrigin: artifact.sourceOrigin,
    },
  }, { configDir: options.configDir });
  return {
    ...compileResult,
    artifact,
    artifactId,
    artifactPath,
  };
}

export function activateHarnessArtifact(artifactPath, options = {}) {
  const artifact = readHarnessArtifact(artifactPath);
  const paths = resolveHarnessControlPlanePaths(options.configDir);
  const activeState = {
    schemaVersion: 1,
    kind: "bosun-active-harness",
    activatedAt: new Date().toISOString(),
    actor: toTrimmedString(options.actor || "api") || "api",
    artifactId: artifact.artifactId,
    artifactPath: resolve(String(artifact.artifactPath || artifactPath)),
    sourceOrigin: artifact.sourceOrigin || "inline",
    sourcePath: artifact.sourcePath || null,
    validationMode: artifact.validationMode || "report",
    isValid: artifact.isValid === true,
    lastRun: null,
    compiledProfile: {
      agentId: artifact.compiledProfile?.agentId || null,
      name: artifact.compiledProfile?.name || null,
      entryStageId: artifact.compiledProfile?.entryStageId || null,
      metadata: artifact.compiledProfile?.metadata || {},
    },
  };
  writeJson(paths.activeStatePath, activeState);
  recordHarnessTelemetryEvent({
    timestamp: activeState.activatedAt,
    eventType: "harness.artifact.activated",
    type: "harness.artifact.activated",
    source: "internal-harness-control-plane",
    category: "artifact",
    actor: activeState.actor,
    artifactId: activeState.artifactId,
    artifactPath: activeState.artifactPath,
    status: activeState.isValid === true ? "active" : "invalid",
    summary: activeState.compiledProfile?.name || activeState.compiledProfile?.agentId || "active harness",
    payload: {
      sourceOrigin: activeState.sourceOrigin,
      sourcePath: activeState.sourcePath,
      validationMode: activeState.validationMode,
      isValid: activeState.isValid,
      entryStageId: activeState.compiledProfile?.entryStageId || null,
    },
    meta: {
      source: "internal-harness-control-plane",
      sourceOrigin: activeState.sourceOrigin,
    },
  }, { configDir: options.configDir });
  return activeState;
}

export function compileAndActivateHarnessSource(source, options = {}) {
  const compiled = compileHarnessSourceToArtifact(source, options);
  const activeState = activateHarnessArtifact(compiled.artifactPath, options);
  return { ...compiled, activeState };
}

export function recordHarnessRun(runInput, options = {}) {
  const paths = resolveHarnessControlPlanePaths(options.configDir);
  ensureDir(paths.runsDir);
  const runId = toTrimmedString(options.runId || runInput?.runId || randomUUID());
  const startedAt = toTrimmedString(runInput?.startedAt || "") || new Date().toISOString();
  const finishedAt = toTrimmedString(runInput?.finishedAt || "") || new Date().toISOString();
  const runRecord = {
    schemaVersion: 1,
    kind: "bosun-harness-run-record",
    runId,
    taskId: toTrimmedString(runInput?.taskId || "") || null,
    taskKey: toTrimmedString(runInput?.taskKey || "") || null,
    actor: toTrimmedString(options.actor || runInput?.actor || "api") || "api",
    recordedAt: new Date().toISOString(),
    startedAt,
    finishedAt,
    mode: toTrimmedString(runInput?.mode || (runInput?.result?.dryRun ? "dry-run" : "run")) || "run",
    dryRun: runInput?.dryRun === true || runInput?.result?.dryRun === true,
    sourceOrigin: toTrimmedString(runInput?.sourceOrigin || "") || null,
    sourcePath: toTrimmedString(runInput?.sourcePath || "") || null,
    artifactId: toTrimmedString(runInput?.artifactId || "") || null,
    artifactPath: toTrimmedString(runInput?.artifactPath || "") || null,
    compiledProfile: runInput?.compiledProfile && typeof runInput.compiledProfile === "object"
      ? {
          agentId: runInput.compiledProfile.agentId || null,
          name: runInput.compiledProfile.name || null,
          entryStageId: runInput.compiledProfile.entryStageId || null,
          metadata: runInput.compiledProfile.metadata || {},
        }
      : null,
    result: runInput?.result && typeof runInput.result === "object"
      ? JSON.parse(JSON.stringify(runInput.result))
      : null,
    events: Array.isArray(runInput?.events)
      ? JSON.parse(JSON.stringify(runInput.events))
      : [],
    observability: summarizeHarnessObservability(runInput?.events),
  };
  const runPath = resolve(paths.runsDir, `${runId}.json`);
  writeJson(runPath, runRecord);
  try {
    writeHarnessRunToStateLedger(runRecord, resolveHarnessLedgerOptions(options.configDir));
  } catch {
    // best effort during SQL migration; JSON record remains the fallback source
  }
  recordHarnessRunObservabilityEvents(runRecord, options.configDir);
  recordHarnessTelemetryEvent({
    timestamp: runRecord.recordedAt,
    eventType: "harness.run.recorded",
    type: "harness.run.recorded",
    source: "internal-harness-control-plane",
    category: "control-plane",
    taskId: runRecord.taskId,
    sessionId: runRecord.runId,
    runId: runRecord.runId,
    actor: runRecord.actor,
    status: runRecord.result?.status || null,
    summary: runRecord.compiledProfile?.name || runRecord.compiledProfile?.agentId || "harness run",
    payload: {
      artifactId: runRecord.artifactId,
      dryRun: runRecord.dryRun,
      eventCount: Array.isArray(runRecord.events) ? runRecord.events.length : 0,
      observability: runRecord.observability,
    },
    meta: {
      source: "internal-harness-control-plane",
      sourceOrigin: runRecord.sourceOrigin,
    },
  }, { configDir: options.configDir });

  const activeState = readActiveHarnessState(options.configDir);
  if (
    activeState &&
    runRecord.artifactPath &&
    resolve(String(activeState.artifactPath || "")) === resolve(runRecord.artifactPath)
  ) {
    const nextActiveState = {
      ...activeState,
      lastRun: buildHarnessRunSummary(runRecord),
    };
    writeJson(paths.activeStatePath, nextActiveState);
  }

  return {
    ...runRecord,
    runPath,
  };
}

export function listHarnessRuns(configDir, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.trunc(Number(options.limit))
    : 25;
  try {
    const sqlRecords = listHarnessRunsFromStateLedger({
      ...resolveHarnessLedgerOptions(configDir),
      limit,
    });
    if (Array.isArray(sqlRecords) && sqlRecords.length > 0) {
      return sqlRecords.map((record) => ({
        ...buildHarnessRunSummary(record),
        runRecord: record,
      }));
    }
  } catch {
    // fall back to legacy JSON records below
  }
  const { runsDir } = resolveHarnessControlPlanePaths(configDir);
  if (!existsSync(runsDir)) return [];
  const records = [];
  for (const fileName of readdirSync(runsDir)) {
    if (!fileName.endsWith(".json")) continue;
    const runPath = resolve(runsDir, fileName);
    try {
      const record = readHarnessRunRecord(runPath);
      records.push({
        ...buildHarnessRunSummary(record),
        runPath,
      });
    } catch {
      // Ignore malformed run records so one bad file does not break the control plane.
    }
  }
  records.sort((left, right) => {
    const rightTime = Date.parse(right.finishedAt || right.startedAt || 0);
    const leftTime = Date.parse(left.finishedAt || left.startedAt || 0);
    return rightTime - leftTime;
  });
  return records.slice(0, limit);
}

export function summarizeHarnessRuns(configDir, options = {}) {
  const recentRuns = listHarnessRuns(configDir, {
    limit: Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
      ? Math.trunc(Number(options.limit))
      : 10,
  });
  const activeState = readActiveHarnessState(configDir);
  const totals = {
    total: recentRuns.length,
    successful: recentRuns.filter((run) => run.success === true).length,
    failed: recentRuns.filter((run) => run.success === false).length,
    dryRuns: recentRuns.filter((run) => run.dryRun === true).length,
  };
  return {
    enabled: activeState?.isValid === true || Boolean(activeState?.artifactPath),
    activeArtifactId: activeState?.artifactId || null,
    activeArtifactPath: activeState?.artifactPath || null,
    activeProfile: activeState?.compiledProfile || null,
    validationMode: activeState?.validationMode || null,
    totals,
    lastRun: activeState?.lastRun || recentRuns[0] || null,
    recentRuns,
  };
}

export function shouldEnforceHarnessValidation(validationMode) {
  return normalizeValidationMode(validationMode) === "enforce";
}
