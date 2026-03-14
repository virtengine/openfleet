import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { basename, resolve } from "node:path";
import {
  getNodeTypeMeta,
  registerNodeType,
  unregisterNodeType,
} from "../workflow-engine.mjs";
import { resolveRepoRoot } from "../../config/repo-root.mjs";

const TAG = "[workflow-custom-nodes]";
export const CUSTOM_NODE_DIR_NAME = "custom-nodes";

let activeRepoRoot = "";
let activeCustomDir = "";
let watcher = null;
let watcherTimer = null;
const fileVersions = new Map();
const fileNodeTypes = new Map();

function logWarn(message) {
  console.warn(`${TAG} ${message}`);
}

function sanitizeNodeName(name = "") {
  const raw = String(name || "").trim().toLowerCase();
  let normalized = "";
  let lastWasDash = false;
  for (const ch of raw) {
    const isSafe =
      (ch >= "a" && ch <= "z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "." ||
      ch === "_" ||
      ch === "-";
    const out = isSafe ? ch : "-";
    if (out === "-") {
      if (lastWasDash || normalized.length === 0) continue;
      lastWasDash = true;
      normalized += "-";
      continue;
    }
    lastWasDash = false;
    normalized += out;
  }
  return normalized.endsWith("-") ? normalized.slice(0, -1) : normalized;
}

function toTypeName(name = "") {
  const normalized = sanitizeNodeName(name).replace(/-/g, "_");
  return normalized.startsWith("custom.") ? normalized : `custom.${normalized}`;
}

function defaultRepoRoot(repoRoot = "") {
  return resolve(repoRoot || resolveRepoRoot());
}

function resolveCustomNodeDir(repoRoot = "") {
  return resolve(defaultRepoRoot(repoRoot), CUSTOM_NODE_DIR_NAME);
}

function isValidStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim());
}

function normalizeNodeExport(mod, filePath) {
  const candidate = mod?.default && typeof mod.default === "object"
    ? { ...mod.default, ...mod }
    : mod;
  const type = String(candidate?.type || "").trim();
  if (!type) throw new Error("missing string export: type");
  if (typeof candidate.execute !== "function") throw new Error("missing execute(node, ctx, engine) function");
  if (typeof candidate.describe !== "function") throw new Error("missing describe() function");
  if (!isValidStringArray(candidate.inputs || [])) throw new Error("inputs must be an array of strings");
  if (!isValidStringArray(candidate.outputs || [])) throw new Error("outputs must be an array of strings");
  if (candidate.schema != null) {
    if (typeof candidate.schema !== "object" || Array.isArray(candidate.schema)) {
      throw new Error("schema must be an object when provided");
    }
    if (candidate.schema.type && candidate.schema.type !== "object") {
      throw new Error("schema.type must be 'object' when provided");
    }
  }
  return {
    type,
    inputs: [...(candidate.inputs || [])],
    outputs: [...(candidate.outputs || [])],
    execute: candidate.execute,
    describe: candidate.describe,
    schema: candidate.schema || {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    filePath,
    source: "custom",
    badge: "custom",
  };
}

function unloadFileTypes(filePath) {
  const previousTypes = fileNodeTypes.get(filePath) || [];
  for (const type of previousTypes) unregisterNodeType(type);
  fileNodeTypes.delete(filePath);
  fileVersions.delete(filePath);
}

async function loadCustomNodeFile(filePath) {
  unloadFileTypes(filePath);
  const version = statSync(filePath).mtimeMs;
  const imported = await import(`${pathToFileURL(filePath).href}?v=${version}`);
  const nodeDef = normalizeNodeExport(imported, filePath);
  const existingMeta = getNodeTypeMeta(nodeDef.type);
  if (existingMeta && existingMeta.filePath !== filePath) {
    throw new Error(`duplicate node type '${nodeDef.type}' already registered from ${existingMeta.filePath || existingMeta.source}`);
  }
  registerNodeType(nodeDef.type, nodeDef, {
    source: "custom",
    badge: "custom",
    inputs: nodeDef.inputs,
    outputs: nodeDef.outputs,
    filePath,
  });
  fileVersions.set(filePath, version);
  fileNodeTypes.set(filePath, [nodeDef.type]);
  return nodeDef;
}

function clearRemovedFiles(customDir) {
  for (const filePath of [...fileNodeTypes.keys()]) {
    if (!filePath.startsWith(customDir)) continue;
    if (!existsSync(filePath)) unloadFileTypes(filePath);
  }
}

export async function ensureCustomWorkflowNodesLoaded(options = {}) {
  const repoRoot = defaultRepoRoot(options.repoRoot);
  const customDir = resolveCustomNodeDir(repoRoot);
  activeRepoRoot = repoRoot;
  activeCustomDir = customDir;
  if (!existsSync(customDir)) return [];
  clearRemovedFiles(customDir);
  const loaded = [];
  for (const filePath of readdirSync(customDir)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => resolve(customDir, name))
    .sort()) {
    try {
      const version = statSync(filePath).mtimeMs;
      if (!options.forceReload && fileVersions.get(filePath) === version && fileNodeTypes.has(filePath)) {
        loaded.push(...(fileNodeTypes.get(filePath) || []));
        continue;
      }
      const def = await loadCustomNodeFile(filePath);
      loaded.push(def.type);
    } catch (error) {
      logWarn(`Skipping ${basename(filePath)}: ${error?.message || String(error)}`);
    }
  }
  return loaded;
}

function isDevMode() {
  if (process.env.VITEST) return false;
  return String(process.env.NODE_ENV || "development").toLowerCase() !== "production";
}

export function startCustomNodeDiscovery(options = {}) {
  if (!isDevMode()) return null;
  const repoRoot = defaultRepoRoot(options.repoRoot || activeRepoRoot);
  const customDir = resolveCustomNodeDir(repoRoot);
  activeRepoRoot = repoRoot;
  activeCustomDir = customDir;
  mkdirSync(customDir, { recursive: true });
  if (watcher) return watcher;
  watcher = watch(customDir, { persistent: true }, () => {
    clearTimeout(watcherTimer);
    watcherTimer = setTimeout(() => {
      ensureCustomWorkflowNodesLoaded({ repoRoot, forceReload: true }).catch((error) => {
        logWarn(`Hot reload failed: ${error?.message || String(error)}`);
      });
    }, 150);
  });
  watcher.on("error", (error) => logWarn(`watch error: ${error?.message || String(error)}`));
  return watcher;
}

export function stopCustomNodeDiscovery() {
  if (watcher) watcher.close();
  watcher = null;
  if (watcherTimer) clearTimeout(watcherTimer);
  watcherTimer = null;
}

export function getCustomNodeDir(repoRoot = "") {
  return resolveCustomNodeDir(repoRoot || activeRepoRoot);
}

export function scaffoldCustomNodeFile(name, options = {}) {
  const repoRoot = defaultRepoRoot(options.repoRoot);
  const customDir = resolveCustomNodeDir(repoRoot);
  const safeName = sanitizeNodeName(name);
  if (!safeName) throw new Error("Node name is required");
  mkdirSync(customDir, { recursive: true });
  const filePath = resolve(customDir, `${safeName}.mjs`);
  if (existsSync(filePath)) throw new Error(`Custom node already exists: ${filePath}`);
  const type = toTypeName(safeName);
  const title = safeName.replace(/[-_]+/g, " ");
  const contents = [
    `export const type = ${JSON.stringify(type)};`,
    'export const inputs = ["message"];',
    'export const outputs = ["success", "error"];',
    'export const schema = {',
    '  type: "object",',
    '  properties: {',
    '    message: {',
    '      type: "string",',
    '      description: "Message payload for this custom node.",',
    '    },',
    '  },',
    '  additionalProperties: true,',
    '};',
    '',
    'export function describe() {',
    `  return ${JSON.stringify(`Custom node: ${title}`)};`,
    '}',
    '',
    'export async function execute(node, ctx) {',
    `  const message = String(node?.config?.message || ${JSON.stringify(`hello from ${type}`)});`,
    `  ctx?.log?.(node?.id || type, "[custom-node] ${type}: " + message, "info");`,
    '  return {',
    '    success: true,',
    '    port: "success",',
    '    type,',
    '    message,',
    '  };',
    '}',
    '',
  ].join("\n");
  writeFileSync(filePath, contents, "utf8");
  return { filePath, type, customDir, repoRoot };
}

