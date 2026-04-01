import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const JOURNAL_VERSION = 1;
const DEFAULT_ROOT_BASENAME = "execution-journal";

function nowIso() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeSegment(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
  return normalized || fallback;
}

function atomicWriteText(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, text, "utf8");
  renameSync(tmpPath, filePath);
}

function normalizeArtifactRef(rawArtifact, index = 0) {
  if (rawArtifact == null) return null;
  if (typeof rawArtifact === "string") {
    const trimmed = rawArtifact.trim();
    if (!trimmed) return null;
    return {
      id: `artifact-${index + 1}`,
      label: trimmed,
      path: trimmed,
      url: null,
      type: "path",
      mimeType: null,
      sizeBytes: null,
      source: "run",
      meta: {},
    };
  }
  if (!isPlainObject(rawArtifact)) return null;
  const path = String(rawArtifact.path ?? rawArtifact.filePath ?? rawArtifact.localPath ?? "").trim() || null;
  const url = String(rawArtifact.url ?? rawArtifact.uri ?? "").trim() || null;
  const label = String(rawArtifact.label ?? rawArtifact.name ?? rawArtifact.title ?? path ?? url ?? `artifact-${index + 1}`).trim();
  if (!label && !path && !url) return null;
  const sizeNumber = Number(rawArtifact.sizeBytes ?? rawArtifact.size ?? NaN);
  return {
    id: String(rawArtifact.id || `artifact-${index + 1}`),
    label: label || `artifact-${index + 1}`,
    path,
    url,
    type: String(rawArtifact.type || (url ? "url" : path ? "path" : "artifact")),
    mimeType: rawArtifact.mimeType != null ? String(rawArtifact.mimeType) : null,
    sizeBytes: Number.isFinite(sizeNumber) ? sizeNumber : null,
    source: rawArtifact.source != null ? String(rawArtifact.source) : "run",
    meta: isPlainObject(rawArtifact.meta) ? { ...rawArtifact.meta } : {},
  };
}

function artifactKey(artifact) {
  if (artifact.path) return `path:${artifact.path}`;
  if (artifact.url) return `url:${artifact.url}`;
  return `id:${artifact.id}:${artifact.label}`;
}

function collectArtifactsFromContainer(container, collector) {
  if (!isPlainObject(container)) return;
  const directCandidates = [container.artifact, container.file, container.attachment];
  for (const candidate of directCandidates) {
    if (candidate != null) collector.push(candidate);
  }
  for (const key of ["artifacts", "files", "attachments"]) {
    if (Array.isArray(container[key])) {
      collector.push(...container[key]);
    }
  }
}

function extractTaskRunArtifacts(run) {
  const rawArtifacts = [];
  if (Array.isArray(run?.artifacts)) rawArtifacts.push(...run.artifacts);
  if (Array.isArray(run?.meta?.artifacts)) rawArtifacts.push(...run.meta.artifacts);
  for (const step of Array.isArray(run?.steps) ? run.steps : []) {
    collectArtifactsFromContainer(step?.payload, rawArtifacts);
    collectArtifactsFromContainer(step?.event, rawArtifacts);
  }
  const normalized = [];
  const seen = new Set();
  rawArtifacts.forEach((artifact, index) => {
    const next = normalizeArtifactRef(artifact, index);
    if (!next) return;
    const key = artifactKey(next);
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push(next);
  });
  return normalized;
}

export function resolveExecutionJournalRoot(options = {}) {
  const explicit = String(options.rootDir || "").trim();
  if (explicit) return resolve(explicit);
  const taskStorePath = String(options.taskStorePath || "").trim();
  if (taskStorePath) {
    return resolve(dirname(taskStorePath), DEFAULT_ROOT_BASENAME);
  }
  return resolve(process.cwd(), ".bosun", ".cache", DEFAULT_ROOT_BASENAME);
}

export function buildTaskRunJournalRef(taskId, runId, options = {}) {
  const normalizedTaskId = String(taskId || "").trim();
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedTaskId || !normalizedRunId) return null;
  return {
    version: JOURNAL_VERSION,
    taskId: normalizedTaskId,
    runId: normalizedRunId,
    root: DEFAULT_ROOT_BASENAME,
    relativeDir: join(
      "tasks",
      safeSegment(normalizedTaskId, "task"),
      "runs",
      safeSegment(normalizedRunId, "run"),
    ),
    runFile: "run.json",
    stepsFile: "steps.jsonl",
    artifactsFile: "artifacts.json",
    persistedAt: nowIso(),
    ...(options.includeRootDir === true
      ? { rootDir: resolveExecutionJournalRoot(options) }
      : {}),
  };
}

export function normalizeTaskRunJournalRef(rawRef, options = {}) {
  if (!isPlainObject(rawRef)) return null;
  const taskId = String(rawRef.taskId || "").trim();
  const runId = String(rawRef.runId || "").trim();
  const relativeDir = String(rawRef.relativeDir || "").trim();
  if (!taskId || !runId || !relativeDir) return null;
  return {
    version: Number.isFinite(Number(rawRef.version)) ? Number(rawRef.version) : JOURNAL_VERSION,
    taskId,
    runId,
    root: DEFAULT_ROOT_BASENAME,
    relativeDir,
    runFile: String(rawRef.runFile || "run.json"),
    stepsFile: String(rawRef.stepsFile || "steps.jsonl"),
    artifactsFile: String(rawRef.artifactsFile || "artifacts.json"),
    persistedAt: String(rawRef.persistedAt || nowIso()),
    stepCount: Number.isFinite(Number(rawRef.stepCount)) ? Number(rawRef.stepCount) : 0,
    artifactCount: Number.isFinite(Number(rawRef.artifactCount)) ? Number(rawRef.artifactCount) : 0,
    ...(options.includeRootDir === true
      ? { rootDir: resolveExecutionJournalRoot({ ...options, rootDir: rawRef.rootDir }) }
      : {}),
  };
}

export function resolveTaskRunJournalPaths(journalRef, options = {}) {
  const ref = normalizeTaskRunJournalRef(journalRef, options);
  if (!ref) return null;
  const rootDir = resolveExecutionJournalRoot({
    rootDir: options.rootDir || ref.rootDir,
    taskStorePath: options.taskStorePath,
  });
  const journalDir = resolve(rootDir, ref.relativeDir);
  return {
    rootDir,
    journalDir,
    runFile: resolve(journalDir, ref.runFile),
    stepsFile: resolve(journalDir, ref.stepsFile),
    artifactsFile: resolve(journalDir, ref.artifactsFile),
  };
}

export function persistTaskRunJournal(taskId, run, options = {}) {
  const ref = buildTaskRunJournalRef(taskId, run?.runId || run?.id, options);
  if (!ref) {
    throw new Error("persistTaskRunJournal requires taskId and runId");
  }
  const paths = resolveTaskRunJournalPaths(ref, {
    rootDir: options.rootDir,
    taskStorePath: options.taskStorePath,
  });
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const artifacts = extractTaskRunArtifacts(run);
  const runRecord = {
    version: JOURNAL_VERSION,
    taskId: ref.taskId,
    runId: ref.runId,
    startedAt: String(run?.startedAt || run?.createdAt || nowIso()),
    endedAt: run?.endedAt != null ? String(run.endedAt) : null,
    status: String(run?.status || "running"),
    outcome: run?.outcome != null ? String(run.outcome) : null,
    summary: run?.summary != null ? String(run.summary) : null,
    sdk: run?.sdk != null ? String(run.sdk) : null,
    threadId: run?.threadId != null ? String(run.threadId) : null,
    resumeThreadId: run?.resumeThreadId != null ? String(run.resumeThreadId) : null,
    replayable: run?.replayable !== false,
    taskKey: run?.taskKey != null ? String(run.taskKey) : null,
    stepCount: steps.length,
    artifactCount: artifacts.length,
    persistedAt: ref.persistedAt,
    meta: isPlainObject(run?.meta) ? { ...run.meta } : {},
  };

  atomicWriteText(paths.runFile, `${JSON.stringify(runRecord, null, 2)}\n`);
  atomicWriteText(
    paths.stepsFile,
    steps.map((step) => JSON.stringify(step)).join("\n") + (steps.length ? "\n" : ""),
  );
  atomicWriteText(paths.artifactsFile, `${JSON.stringify(artifacts, null, 2)}\n`);

  return normalizeTaskRunJournalRef({
    ...ref,
    stepCount: steps.length,
    artifactCount: artifacts.length,
  });
}

export function readTaskRunJournal(journalRef, options = {}) {
  const ref = normalizeTaskRunJournalRef(journalRef, {
    includeRootDir: true,
    taskStorePath: options.taskStorePath,
    rootDir: options.rootDir,
  });
  if (!ref) return null;
  const paths = resolveTaskRunJournalPaths(ref, options);
  if (!paths || !existsSync(paths.runFile)) return null;
  const run = JSON.parse(readFileSync(paths.runFile, "utf8"));
  const steps = existsSync(paths.stepsFile)
    ? readFileSync(paths.stepsFile, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const artifacts = existsSync(paths.artifactsFile)
    ? JSON.parse(readFileSync(paths.artifactsFile, "utf8"))
    : [];
  return { journal: { ...ref, paths }, run, steps, artifacts };
}
