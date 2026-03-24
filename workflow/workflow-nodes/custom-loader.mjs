import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
const fileReports = new Map();

function logWarn(message) {
  console.warn(`${TAG} ${message}`);
}

function createDiagnostic(code, message, severity = "error") {
  return { code, message, severity };
}

function cloneDiagnostic(diagnostic) {
  if (!diagnostic || typeof diagnostic !== "object") return diagnostic || null;
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    severity: diagnostic.severity,
  };
}

function clonePluginReport(report) {
  if (!report || typeof report !== "object") return report;
  return {
    ...report,
    nodeTypes: Array.isArray(report.nodeTypes) ? [...report.nodeTypes] : [],
    diagnostics: Array.isArray(report.diagnostics) ? report.diagnostics.map(cloneDiagnostic) : [],
    manifest: report.manifest ? { ...report.manifest } : null,
    smokeTest: report.smokeTest ? { ...report.smokeTest } : null,
  };
}

function createLoaderError(code, message) {
  const error = new Error(message);
  error.pluginDiagnostic = createDiagnostic(code, message);
  return error;
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

function normalizeManifest(manifest, filePath, inferredType = "") {
  if (manifest == null) {
    return {
      id: basename(filePath, ".mjs"),
      name: inferredType || basename(filePath, ".mjs"),
      version: "0.1.0",
      inferred: true,
      description: null,
    };
  }
  if (typeof manifest !== "object" || Array.isArray(manifest)) {
    throw createLoaderError("invalid-manifest", "manifest must be an object with string id, name, and version");
  }
  const id = String(manifest.id || "").trim();
  const name = String(manifest.name || "").trim();
  const version = String(manifest.version || "").trim();
  if (!id || !name || !version) {
    throw createLoaderError("invalid-manifest", "manifest.id, manifest.name, and manifest.version are required strings");
  }
  return {
    id,
    name,
    version,
    inferred: false,
    description: String(manifest.description || "").trim() || null,
  };
}

function normalizeNodeExport(mod, filePath) {
  const candidate = mod?.default && typeof mod.default === "object"
    ? { ...mod.default, ...mod }
    : mod;
  const type = String(candidate?.type || "").trim();
  if (!type) throw createLoaderError("missing-type", "missing string export: type");
  if (typeof candidate.execute !== "function") {
    throw createLoaderError("missing-execute", "missing execute(node, ctx, engine) function");
  }
  if (typeof candidate.describe !== "function") {
    throw createLoaderError("missing-describe", "missing describe() function");
  }
  if (!isValidStringArray(candidate.inputs || [])) {
    throw createLoaderError("invalid-inputs", "inputs must be an array of strings");
  }
  if (!isValidStringArray(candidate.outputs || [])) {
    throw createLoaderError("invalid-outputs", "outputs must be an array of strings");
  }
  if (candidate.schema != null) {
    if (typeof candidate.schema !== "object" || Array.isArray(candidate.schema)) {
      throw createLoaderError("invalid-schema", "schema must be an object when provided");
    }
    if (candidate.schema.type && candidate.schema.type !== "object") {
      throw createLoaderError("invalid-schema", "schema.type must be 'object' when provided");
    }
  }
  return {
    candidate,
    nodeDef: {
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
    },
  };
}

function unloadFileTypes(filePath) {
  const previousTypes = fileNodeTypes.get(filePath) || [];
  for (const type of previousTypes) unregisterNodeType(type);
  fileNodeTypes.delete(filePath);
  fileVersions.delete(filePath);
  fileReports.delete(filePath);
}

function clearRemovedFiles(customDir) {
  for (const filePath of new Set([...fileNodeTypes.keys(), ...fileReports.keys()])) {
    if (!filePath.startsWith(customDir)) continue;
    if (!existsSync(filePath)) unloadFileTypes(filePath);
  }
}

async function importCustomNodeModule(filePath) {
  const version = statSync(filePath).mtimeMs;
  const imported = await import(`${pathToFileURL(filePath).href}?v=${version}`);
  return { imported, version };
}

function describeDiagnostic(diagnostic) {
  if (!diagnostic) return "unknown plugin error";
  return diagnostic.message || diagnostic.code || "unknown plugin error";
}

async function runPluginSmokeTest(candidate, nodeDef, pluginReport) {
  if (typeof candidate.smokeTest !== "function") {
    return { status: "skipped", message: "No smokeTest() export provided" };
  }
  try {
    const result = await candidate.smokeTest({
      type: nodeDef.type,
      manifest: pluginReport.manifest,
      filePath: pluginReport.filePath,
    });
    if (result === false || result?.success === false || result?.passed === false) {
      return {
        status: "failed",
        message: String(result?.message || result?.error || "smoke test returned a failing result"),
      };
    }
    return {
      status: "passed",
      message: String(result?.message || "Smoke test passed"),
    };
  } catch (error) {
    return {
      status: "failed",
      message: error?.message || String(error),
    };
  }
}

async function inspectCustomNodeFile(filePath, options = {}) {
  const version = statSync(filePath).mtimeMs;
  const cached = fileReports.get(filePath);
  if (
    !options.forceReload &&
    fileVersions.get(filePath) === version &&
    cached &&
    (!options.runSmokeTests || cached.smokeTest != null)
  ) {
    return clonePluginReport(cached);
  }

  unloadFileTypes(filePath);
  const pluginReport = {
    filePath,
    fileName: basename(filePath),
    status: "loaded",
    nodeTypes: [],
    diagnostics: [],
    manifest: null,
    smokeTest: null,
  };

  try {
    const { imported, version: importedVersion } = await importCustomNodeModule(filePath);
    const { candidate, nodeDef } = normalizeNodeExport(imported, filePath);
    pluginReport.manifest = normalizeManifest(candidate.manifest, filePath, nodeDef.type);

    const existingMeta = getNodeTypeMeta(nodeDef.type);
    if (existingMeta && existingMeta.filePath !== filePath) {
      throw createLoaderError(
        "duplicate-node-id",
        `duplicate node type '${nodeDef.type}' already registered from ${existingMeta.filePath || existingMeta.source}`,
      );
    }

    registerNodeType(nodeDef.type, nodeDef, {
      source: "custom",
      badge: "custom",
      inputs: nodeDef.inputs,
      outputs: nodeDef.outputs,
      filePath,
    });
    fileVersions.set(filePath, importedVersion);
    fileNodeTypes.set(filePath, [nodeDef.type]);
    pluginReport.nodeTypes = [nodeDef.type];

    if (options.runSmokeTests) {
      pluginReport.smokeTest = await runPluginSmokeTest(candidate, nodeDef, pluginReport);
      if (pluginReport.smokeTest.status === "failed") {
        pluginReport.diagnostics.push(createDiagnostic("smoke-test-failed", pluginReport.smokeTest.message));
      }
    }
  } catch (error) {
    unloadFileTypes(filePath);
    pluginReport.status = "skipped";
    const diagnostic = error?.pluginDiagnostic || createDiagnostic("load-failed", error?.message || String(error));
    pluginReport.diagnostics.push(diagnostic);
  }

  const storedReport = clonePluginReport(pluginReport);
  fileReports.set(filePath, storedReport);
  return clonePluginReport(storedReport);
}

export async function inspectCustomWorkflowNodePlugins(options = {}) {
  const repoRoot = defaultRepoRoot(options.repoRoot);
  const customDir = resolveCustomNodeDir(repoRoot);
  activeRepoRoot = repoRoot;
  activeCustomDir = customDir;

  const report = {
    repoRoot,
    customDir,
    ok: true,
    plugins: [],
    summary: {
      discovered: 0,
      loaded: 0,
      skipped: 0,
      smokePassed: 0,
      smokeFailed: 0,
      duplicateNodeIds: 0,
    },
  };

  if (!existsSync(customDir)) return report;

  clearRemovedFiles(customDir);
  const filePaths = readdirSync(customDir)
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => resolve(customDir, name))
    .sort();

  report.summary.discovered = filePaths.length;
  for (const filePath of filePaths) {
    const pluginReport = await inspectCustomNodeFile(filePath, options);
    report.plugins.push(pluginReport);
    if (pluginReport.status === "loaded") report.summary.loaded += 1;
    if (pluginReport.status === "skipped") report.summary.skipped += 1;
    if (pluginReport.smokeTest?.status === "passed") report.summary.smokePassed += 1;
    if (pluginReport.smokeTest?.status === "failed") report.summary.smokeFailed += 1;
    if (pluginReport.diagnostics.some((entry) => entry.code === "duplicate-node-id")) {
      report.summary.duplicateNodeIds += 1;
    }
    if (options.logWarnings !== false && pluginReport.diagnostics.length > 0) {
      logWarn(`Skipping ${pluginReport.fileName}: ${describeDiagnostic(pluginReport.diagnostics[0])}`);
    }
  }

  report.ok = report.summary.skipped === 0 && report.summary.smokeFailed === 0;
  return report;
}

export async function ensureCustomWorkflowNodesLoaded(options = {}) {
  const report = await inspectCustomWorkflowNodePlugins({ ...options, logWarnings: true });
  return report.plugins.flatMap((plugin) => plugin.nodeTypes || []);
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
    "export const manifest = {",
    `  id: ${JSON.stringify(safeName)},`,
    `  name: ${JSON.stringify(title)},`,
    '  version: "1.0.0",',
    `  description: ${JSON.stringify(`Scaffolded custom node plugin for ${title}`)},`,
    "};",
    "",
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
    'export async function smokeTest() {',
    '  const result = await execute({ id: "smoke-test", config: { message: "smoke ok" } }, { log() {} });',
    '  if (!result || result.success !== true || result.port !== "success") {',
    '    throw new Error("Expected execute() to return a successful smoke-test result");',
    '  }',
    '  return { success: true, message: "Scaffold smoke test passed" };',
    '}',
    '',
  ].join("\n");
  writeFileSync(filePath, contents, "utf8");
  return { filePath, type, customDir, repoRoot };
}
