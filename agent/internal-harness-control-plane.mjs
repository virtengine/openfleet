import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { compileInternalHarnessProfile } from "./internal-harness-profile.mjs";

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
    activeStatePath: resolve(root, "active-harness.json"),
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

export function shouldEnforceHarnessValidation(validationMode) {
  return normalizeValidationMode(validationMode) === "enforce";
}
