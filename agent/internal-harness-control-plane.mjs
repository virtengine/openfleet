import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { compileInternalHarnessProfile } from "./internal-harness-profile.mjs";
import {
  getHarnessRunFromStateLedger,
  listHarnessRunsFromStateLedger,
  writeHarnessRunToStateLedger,
} from "../lib/state-ledger-sqlite.mjs";

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
  };
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
  };
  const runPath = resolve(paths.runsDir, `${runId}.json`);
  writeJson(runPath, runRecord);
  try {
    writeHarnessRunToStateLedger(runRecord, resolveHarnessLedgerOptions(options.configDir));
  } catch {
    // best effort during SQL migration; JSON record remains the fallback source
  }

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
