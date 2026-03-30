// CLAUDE:SUMMARY — discovers OpenCode providers/models via SDK and CLI fallbacks, normalizing snapshots and tolerating ignorable model-listing failures.
/**
 * opencode-providers.mjs  — Dynamic OpenCode provider & model discovery
 *
 * Queries the live OpenCode server (via SDK) or CLI for available providers
 * and models. Caches results with a configurable TTL so repeated calls during
 * the same setup wizard / runtime cycle are fast.
 *
 * Design principles (from AGENTS.md):
 *  - Module-scope caching for lazy singletons / memoization.
 *  - Async safety: every async call is awaited or .catch()-guarded.
 *  - Error boundaries: every top-level function returns safe fallbacks.
 */

import { execFile, exec } from "node:child_process";

function execFileAsync(...args) {
  return new Promise((resolve, reject) => {
    execFile(...args, (error, stdout = "", stderr = "") => {
      if (error) {
        if (stdout !== undefined) error.stdout = stdout;
        if (stderr !== undefined) error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function execAsync(...args) {
  return new Promise((resolve, reject) => {
    exec(...args, (error, stdout = "", stderr = "") => {
      if (error) {
        if (stdout !== undefined) error.stdout = stdout;
        if (stderr !== undefined) error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// ── Module-scope cache (lives at module scope per AGENTS.md) ──────────────────

/** @type {{ data: ProviderSnapshot|null, ts: number }} */
let _providerCache = { data: null, ts: 0 };
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** @type {import("@opencode-ai/sdk").default|null} */
let _sdk = null;

// ── Types (JSDoc) ────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DiscoveredModel
 * @property {string} id          - Full model id (e.g. "claude-sonnet-4-20250514")
 * @property {string} name        - Display name
 * @property {string} providerID  - Provider that owns this model
 * @property {string} fullId      - "providerID/id" composite key
 * @property {string} status      - "active"|"beta"|"alpha"|"deprecated"
 * @property {boolean} reasoning  - Supports reasoning/chain-of-thought
 * @property {boolean} toolcall   - Supports tool calling
 * @property {{ context: number, output: number }} limit - Token limits
 * @property {{ input: number, output: number }} cost    - Per-million-token costs
 */

/**
 * @typedef {Object} DiscoveredProvider
 * @property {string}  id        - Provider key (e.g. "anthropic", "openai")
 * @property {string}  name      - Display name
 * @property {string}  source    - "env"|"config"|"custom"|"api"
 * @property {string[]} env      - Env var names that configure credentials
 * @property {boolean} connected - Whether credentials are configured
 * @property {DiscoveredModel[]} models - Available models
 * @property {Array<{type: string, label: string}>} authMethods - Auth methods
 */

/**
 * @typedef {Object} ProviderSnapshot
 * @property {DiscoveredProvider[]} providers  - All known providers
 * @property {DiscoveredProvider[]} connected  - Providers with credentials configured
 * @property {string[]} connectedIds           - Just the connected provider IDs
 * @property {Record<string, string>} defaults - Default model per provider
 * @property {DiscoveredModel[]} allModels     - Flat list of all models
 * @property {number} timestamp                - When this snapshot was taken
 */

// ── SDK Loading ──────────────────────────────────────────────────────────────

async function loadSDK() {
  if (_sdk) return _sdk;
  try {
    _sdk = await import("@opencode-ai/sdk");
    return _sdk;
  } catch {
    return null;
  }
}

function shouldRetryProviderQueryWithoutDirectory(err) {
  const status = Number(
    err?.status ?? err?.response?.status ?? err?.cause?.status ?? NaN,
  );
  if (status === 400) return true;

  const message = String(err?.message || "").toLowerCase();
  const stderrText = String(err?.stderr || "").toLowerCase();
  const responseText = String(
    err?.response?.data?.error?.message
    || err?.response?.data?.message
    || err?.cause?.message
    || "",
  ).toLowerCase();
  const haystack = `${message} ${stderrText} ${responseText}`;
  return (
    haystack.includes(" 400") ||
    haystack.includes("failed to list models: 400") ||
    haystack.includes("bad request") ||
    haystack.includes("directory") ||
    haystack.includes("invalid url") ||
    haystack.includes("unsupported") ||
    haystack.includes("deployment") ||
    haystack.includes("api version")
  );
}

function isIgnorableModelDiscoveryError(err) {
  if (!err) return false;

  if (isIgnorableModelDiscoveryCause(err?.cause)) return true;

  const status = Number(
    err?.status ?? err?.response?.status ?? err?.cause?.status ?? NaN,
  );
  if (status === 400) return true;

  const message = String(err?.message || "").toLowerCase();
  const stderrText = String(err?.stderr || "").toLowerCase();
  const responseText = String(
    err?.response?.data?.error?.message
    || err?.response?.data?.message
    || err?.cause?.message
    || "",
  ).toLowerCase();
  const haystack = `${message} ${stderrText} ${responseText}`;
  return (
    haystack.includes("failed to list models: 400") ||
    haystack.includes("bad request") ||
    haystack.includes("/models") ||
    haystack.includes("list models") ||
    haystack.includes("invalid url") ||
    haystack.includes("deployment") ||
    haystack.includes("api version")
  );
}

function isIgnorableModelDiscoveryCause(cause) {
  if (!cause) return false;

  const code = String(cause?.code || "").toUpperCase();
  const statusCode = Number(cause?.statusCode ?? cause?.status ?? cause?.response?.status ?? cause?.response?.statusCode ?? cause?.response?.data?.status ?? cause?.response?.data?.statusCode ?? NaN);
  if (statusCode === 400) return true;

  const bodyText = String(
    cause?.body
    ?? cause?.responseBody
    ?? cause?.response?.body
    ?? cause?.response?.data?.error?.message
    ?? cause?.response?.data?.message
    ?? "",
  ).toLowerCase();
  const message = String(cause?.message || "").toLowerCase();
  const haystack = `${code} ${message} ${bodyText}`;
  return (
    haystack.includes("failed to list models: 400") ||
    haystack.includes(" 400") ||
    haystack.includes("status code 400") ||
    haystack.includes("bad request") ||
    haystack.includes("/models") ||
    haystack.includes("invalid url") ||
    haystack.includes("deployment") ||
    haystack.includes("api version")
  );
}

function buildEmptySnapshot() {
  return {
    providers: [],
    connected: [],
    connectedIds: [],
    defaults: {},
    allModels: [],
    timestamp: Date.now(),
  };
}

function hasIgnorableCliStderr(text) {
  const stderrText = String(text || "").trim();
  if (!stderrText) return false;
  return isIgnorableModelDiscoveryError({
    message: stderrText,
    stderr: stderrText,
  });
}

function hasIgnorableModelDiscoverySignal(err) {
  if (isIgnorableModelDiscoveryError(err)) return true;

  const stderrText = String(err?.stderr || "").trim();
  const stdoutText = String(err?.stdout || "").trim();
  return (
    !stdoutText
    && !!stderrText
    && isIgnorableModelDiscoveryError({
      message: stderrText,
      stderr: stderrText,
      status: err?.status,
      response: err?.response,
      cause: err?.cause,
    })
  );
}

function hasIgnorableModelDiscoveryText(stdout = "", stderr = "") {
  const stdoutText = String(stdout || "").trim();
  const stderrText = String(stderr || "").trim();
  if (!stderrText) return false;

  return isIgnorableModelDiscoveryError({
    message: !stdoutText ? stderrText : "",
    stdout: stdoutText,
    stderr: stderrText,
  });
}

function extractRecoverySnapshot(err) {
  const payload = err?.response?.data;
  if (!payload || typeof payload !== "object") return null;
  try {
    const snapshot = normalizeSDKProviders(payload);
    return isEmptySnapshot(snapshot) ? null : snapshot;
  } catch {
    return null;
  }
}

function isEmptySnapshot(snapshot) {
  return Boolean(
    snapshot
    && Array.isArray(snapshot.providers)
    && snapshot.providers.length === 0
    && Array.isArray(snapshot.allModels)
    && snapshot.allModels.length === 0,
  );
}

function normalizeProviderMetadataEntry(entry, connectedSet, authMethods) {
  if (!entry || typeof entry !== "object" || !entry.id) return null;

  const models = Object.entries(entry.models || {}).map(([modelKey, modelValue]) => ({
    id: modelValue?.id || modelKey,
    name: modelValue?.name || modelKey,
    providerID: entry.id,
    fullId: `${entry.id}/${modelValue?.id || modelKey}`,
    status: modelValue?.status || "active",
    reasoning: modelValue?.reasoning ?? false,
    toolcall: modelValue?.tool_call ?? false,
    limit: modelValue?.limit || { context: 0, output: 0 },
    cost: modelValue?.cost
      ? { input: modelValue.cost.input || 0, output: modelValue.cost.output || 0 }
      : { input: 0, output: 0 },
  }));

  return {
    id: entry.id,
    name: entry.name || entry.id,
    source: "api",
    env: Array.isArray(entry.env) ? entry.env : [],
    connected: connectedSet.has(entry.id),
    models,
    authMethods: authMethods?.[entry.id] || [],
  };
}

function buildSnapshotFromNormalizedProviderData(normalizedProviderData, authMethods = {}) {
  if (!normalizedProviderData) return null;

  const {
    all: rawProviders = [],
    connected: connectedIds = [],
    default: defaults = {},
  } = normalizedProviderData;

  const connectedSet = new Set(connectedIds);
  const providers = rawProviders
    .map((entry) => normalizeProviderMetadataEntry(entry, connectedSet, authMethods))
    .filter(Boolean);

  return {
    providers,
    connected: providers.filter((provider) => provider.connected),
    connectedIds: [...connectedSet],
    defaults,
    allModels: providers.flatMap((provider) => provider.models),
    timestamp: Date.now(),
  };
}

async function invokeProviderEndpoint(endpoint, requestOptions, context = null) {
  if (typeof endpoint !== "function") return null;

  const callEndpoint = (...args) => (
    context ? endpoint.call(context, ...args) : endpoint(...args)
  );

  if (requestOptions) {
    try {
      return await callEndpoint(requestOptions);
    } catch (err) {
      if (!shouldRetryProviderQueryWithoutDirectory(err)) {
        throw err;
      }
    }
  }

  return await callEndpoint();
}

function normalizeProviderListData(data) {
  if (!data || typeof data !== "object") return null;

  if (Array.isArray(data.all)) {
    return {
      all: data.all,
      connected: Array.isArray(data.connected) ? data.connected : [],
      default: data.default && typeof data.default === "object" ? data.default : {},
    };
  }

  if (Array.isArray(data.providers)) {
    return {
      all: data.providers,
      connected: Array.isArray(data.connectedIds)
        ? data.connectedIds
        : Array.isArray(data.connected)
          ? data.connected
          : [],
      default: data.defaults && typeof data.defaults === "object" ? data.defaults : {},
    };
  }

  return null;
}

// ── SDK-based discovery (preferred — uses running OpenCode server) ────────────

/**
 * Query providers via the OpenCode SDK REST API.
 * Requires a running OpenCode server (started by opencode-shell.mjs).
 * @param {import("@opencode-ai/sdk").Client} [existingClient] - Optional pre-existing SDK client
 * @returns {Promise<ProviderSnapshot|null>}
 */
async function discoverViaSDK(existingClient = null) {
  const sdk = await loadSDK();
  if (!sdk) return null;

  let client = existingClient;
  if (!client) {
    // Try to connect to an already-running server
    try {
      const port = Number(process.env.OPENCODE_PORT || "4096");
      try {
        client = sdk.createOpencodeClient({
          baseUrl: `http://127.0.0.1:${port}`,
          timeout: 5_000,
        });
      } catch {
        client = sdk.createOpencodeClient({
          hostname: "127.0.0.1",
          port,
          timeout: 5_000,
        });
      }
    } catch {
      return null;
    }
  }

  try {
    const directory = process.cwd();
    const requestOptions = directory
      ? { query: { directory } }
      : undefined;

    const providerPromise = invokeProviderEndpoint(client?.provider?.list, requestOptions, client?.provider);
    const authPromise = invokeProviderEndpoint(client?.provider?.auth, requestOptions, client?.provider);
    const [providerResult, authResult] = await Promise.allSettled([providerPromise, authPromise]);

    const normalizedProviderData = normalizeProviderListData(
      providerResult.status === "fulfilled"
        ? providerResult.value?.data
        : providerResult.reason?.response?.data || providerResult.reason?.cause?.response?.data,
    );
    if (!normalizedProviderData) {
      const providerError = providerResult.status === "rejected" ? providerResult.reason : null;
      const recoveredSnapshot = extractRecoverySnapshot(providerError);
      if (recoveredSnapshot) {
        console.warn("[opencode-providers] recovering provider metadata from SDK error payload");
        return recoveredSnapshot;
      }
      if (providerError) {
        if (hasIgnorableModelDiscoverySignal(providerError)) {
          console.warn(`[opencode-providers] SDK discovery hit ignorable provider error: ${providerError.message}`);
        } else {
          console.warn(`[opencode-providers] SDK discovery failed: ${providerError.message}`);
        }
      }
      return null;
    }

    if (providerResult.status === "rejected") {
      console.warn("[opencode-providers] recovering provider metadata from SDK error payload");
    }

    const authMethods = authResult.status === "fulfilled"
      ? (authResult.value?.data || {})
      : {};
    return buildSnapshotFromNormalizedProviderData(normalizedProviderData, authMethods);
  } catch (err) {
    console.warn(`[opencode-providers] SDK discovery failed: ${err.message}`);
    return null;
  }
}

// ── CLI-based discovery (fallback — no running server needed) ─────────────────

/**
 * Resolve the opencode binary path.
 * @returns {string}
 */
function resolveOpencodeBin() {
  return process.env.OPENCODE_BIN || "opencode";
}

/**
 * Execute the opencode CLI with given args.
 * Uses exec() (shell-based) on Windows to handle .cmd/.ps1 wrappers.
 * Uses execFile() (no shell) on other platforms for safety.
 * @param {string[]} args
 * @param {object} [execOpts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function execOpencode(args, execOpts = {}) {
  const bin = resolveOpencodeBin();
  const isWindows = process.platform === "win32";
  const baseOpts = {
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: "utf-8",
    windowsHide: process.platform === "win32",
    ...execOpts,
  };
  const escaped = args.map((a) => `"${a}"`).join(" ");
  const commandText = `"${bin}" ${escaped}`;
  if (isWindows) {
    // Use exec() on Windows to properly handle .cmd wrappers
    const result = await execAsync(commandText, baseOpts);
    const normalized = typeof result === "string"
      ? { stdout: result, stderr: "" }
      : { stdout: result.stdout || "", stderr: result.stderr || "" };
    if (!normalized.stdout.trim() && normalized.stderr.trim() && !hasIgnorableModelDiscoveryText(normalized.stdout, normalized.stderr)) {
      const err = new Error(normalized.stderr.trim());
      err.stderr = normalized.stderr;
      throw err;
    }
    return normalized;
  }
  try {
    const result = await execFileAsync(bin, args, baseOpts);
    const normalized = typeof result === "string"
      ? { stdout: result, stderr: "" }
      : { stdout: result.stdout || "", stderr: result.stderr || "" };
    if (!normalized.stdout.trim() && normalized.stderr.trim() && !hasIgnorableModelDiscoveryText(normalized.stdout, normalized.stderr)) {
      const err = new Error(normalized.stderr.trim());
      err.stderr = normalized.stderr;
      throw err;
    }
    return normalized;
  } catch {
    const result = await execAsync(commandText, baseOpts);
    const normalized = typeof result === "string"
      ? { stdout: result, stderr: "" }
      : { stdout: result.stdout || "", stderr: result.stderr || "" };
    if (!normalized.stdout.trim() && normalized.stderr.trim() && !hasIgnorableModelDiscoveryText(normalized.stdout, normalized.stderr)) {
      const err = new Error(normalized.stderr.trim());
      err.stderr = normalized.stderr;
      throw err;
    }
    return normalized;
  }
}

/**
 * Parse the multi-line verbose output from `opencode models --verbose`.
 * Format: each model has a "provider/id" header line followed by a JSON block.
 * @param {string} stdout
 * @returns {{ providerMap: Map, allModels: DiscoveredModel[] }}
 */
function parseVerboseModelsOutput(stdout) {
  const providerMap = new Map();
  const allModels = [];

  // Normalize line endings
  const normalized = stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Split into blocks: each block starts with a "provider/model" header line
  // followed by a JSON object (may span multiple lines).
  const blocks = normalized.split(/\n(?=[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.:*-]+\n)/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    // Find the JSON object in the block
    const jsonStart = trimmed.indexOf("{");
    if (jsonStart < 0) continue;

    // Extract the header line (provider/model)
    const headerLine = trimmed.slice(0, jsonStart).trim();

    try {
      const jsonStr = trimmed.slice(jsonStart);
      const model = JSON.parse(jsonStr);
      if (!model.id) continue;

      const providerID = model.providerID || headerLine.split("/")[0] || "unknown";
      const fullId = `${providerID}/${model.id}`;

      const discovered = {
        id: model.id,
        name: model.name || model.id,
        providerID,
        fullId,
        status: model.status || "active",
        reasoning: model.capabilities?.reasoning ?? false,
        toolcall: model.capabilities?.toolcall ?? false,
        limit: model.limit || { context: 0, output: 0 },
        cost: model.cost
          ? { input: model.cost.input || 0, output: model.cost.output || 0 }
          : { input: 0, output: 0 },
      };

      allModels.push(discovered);

      if (!providerMap.has(providerID)) {
        providerMap.set(providerID, {
          id: providerID,
          name: providerID,
          source: "cli",
          env: [],
          connected: true, // CLI only shows connected providers
          models: [],
          authMethods: [],
        });
      }
      providerMap.get(providerID).models.push(discovered);
    } catch {
      // Skip unparseable blocks
    }
  }

  return { providerMap, allModels };
}

/**
 * Parse the basic line-based output from `opencode models`.
 * Format: one `provider/model` entry per line.
 * @param {string} stdout
 * @returns {{ providerMap: Map, allModels: DiscoveredModel[] }}
 */
function parseBasicModelsOutput(stdout) {
  const providerMap = new Map();
  const allModels = [];
  const normalized = String(stdout || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trim();
    if (!line || !line.includes("/")) continue;

    const slashIdx = line.indexOf("/");
    const providerID = line.slice(0, slashIdx).trim();
    const modelID = line.slice(slashIdx + 1).trim();
    if (!providerID || !modelID) continue;

    const discovered = {
      id: modelID,
      name: modelID,
      providerID,
      fullId: `${providerID}/${modelID}`,
      status: "active",
      reasoning: false,
      toolcall: false,
      limit: { context: 0, output: 0 },
      cost: { input: 0, output: 0 },
    };

    allModels.push(discovered);

    if (!providerMap.has(providerID)) {
      providerMap.set(providerID, {
        id: providerID,
        name: providerID,
        source: "cli",
        env: [],
        connected: true,
        models: [],
        authMethods: [],
      });
    }

    providerMap.get(providerID).models.push(discovered);
  }

  return { providerMap, allModels };
}

function buildCliSnapshot(providerMap, allModels) {
  const providers = [...providerMap.values()];
  return {
    providers,
    connected: providers,
    connectedIds: providers.map((p) => p.id),
    defaults: {},
    allModels,
    timestamp: Date.now(),
  };
}

/**
 * Query providers via `opencode models --verbose` CLI command.
 * Works even without a running server. Falls back gracefully.
 * @returns {Promise<ProviderSnapshot|null>}
 */
async function discoverViaCLI() {
  try {
    const { stdout } = await execOpencode(["models", "--verbose"]);
    const { providerMap, allModels } = parseVerboseModelsOutput(stdout);
    if (allModels.length > 0) {
      return buildCliSnapshot(providerMap, allModels);
    }

    const fallback = await execOpencode(["models"]);
    const parsedFallback = parseBasicModelsOutput(fallback.stdout);
    if (parsedFallback.allModels.length > 0) {
      return buildCliSnapshot(parsedFallback.providerMap, parsedFallback.allModels);
    }

    console.warn("[opencode-providers] CLI discovery returned no parseable models");
    return buildEmptySnapshot();
  } catch (err) {
    try {
      const fallback = await execOpencode(["models"]);
      const parsedFallback = parseBasicModelsOutput(fallback.stdout);
      if (parsedFallback.allModels.length > 0) {
        console.warn(
          `[opencode-providers] verbose model discovery failed; using basic model list instead: ${err.message}` ,
        );
        return buildCliSnapshot(parsedFallback.providerMap, parsedFallback.allModels);
      }
    } catch {
      // fall through to the original verbose failure below
    }

    if (hasIgnorableModelDiscoverySignal(err)) {
      console.warn(
        `[opencode-providers] CLI model discovery hit ignorable provider error with no basic fallback data: ${err.message}` ,
      );
      return buildEmptySnapshot();
    }

    console.warn(`[opencode-providers] CLI discovery failed: ${err.message}`);
    return buildEmptySnapshot();
  }
}
/**
 * Get ALL providers (including unconnected) via `opencode models --refresh`.
 * This queries models.dev for the full catalog.
 * @returns {Promise<ProviderSnapshot|null>}
 */
async function discoverAllViaCLI() {
  try {
    const { stdout } = await execOpencode(["models", "--refresh", "--verbose"], {
      timeout: 60_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const { providerMap, allModels } = parseVerboseModelsOutput(stdout);

    return {
      providers: [...providerMap.values()],
      connected: [],
      connectedIds: [],
      defaults: {},
      allModels,
      timestamp: Date.now(),
    };
  } catch (err) {
    try {
      const fallback = await execOpencode(["models", "--refresh"], {
        timeout: 60_000,
        maxBuffer: 20 * 1024 * 1024,
      });
      const { providerMap, allModels } = parseBasicModelsOutput(fallback.stdout);
      if (allModels.length > 0) {
        console.warn(
          `[opencode-providers] verbose catalog discovery failed; using basic model list instead: ${err.message}`,
        );
        return {
          providers: [...providerMap.values()],
          connected: [],
          connectedIds: [],
          defaults: {},
          allModels,
          timestamp: Date.now(),
        };
      }
    } catch {
      // fall through to the original verbose failure below
    }

    if (hasIgnorableModelDiscoverySignal(err)) {
      console.warn(
        `[opencode-providers] catalog discovery hit ignorable provider error with no basic fallback data: ${err.message}`,
      );
      return buildEmptySnapshot();
    }

    console.warn(`[opencode-providers] catalog discovery failed: ${err.message}`);
    return null;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Discover available OpenCode providers and models.
 * Tries SDK first (fast, richer data), falls back to CLI.
 * Results are cached for CACHE_TTL_MS.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false]       - Bypass cache
 * @param {object}  [opts.client]            - Pre-existing SDK client
 * @param {boolean} [opts.includeCatalog]    - Include full models.dev catalog (slow)
 * @returns {Promise<ProviderSnapshot>}
 */
export async function discoverProviders(opts = {}) {
  const { force = false, client = null, includeCatalog = false } = opts;

  // Return cached if fresh
  if (!force && _providerCache.data && Date.now() - _providerCache.ts < CACHE_TTL_MS) {
    return _providerCache.data;
  }

  // Try SDK first (requires running server)
  let snapshot = null;
  try {
    snapshot = await discoverViaSDK(client);
  } catch (err) {
    const recoveredSnapshot = extractRecoverySnapshot(err);
    if (recoveredSnapshot) {
      snapshot = recoveredSnapshot;
    }
    if (!hasIgnorableModelDiscoverySignal(err)) {
      throw err;
    }
    if (!recoveredSnapshot) {
      console.warn(
        `[opencode-providers] SDK discovery hit ignorable provider error; falling back to CLI: ${err.message}`,
      );
      snapshot = null;
    }
  }

  const sdkDiscoveryFailed = snapshot == null;

  // Fall back to CLI only when SDK discovery was unavailable or failed.
  // A successful-but-empty SDK response is authoritative for older SDK
  // compatibility probes and disconnected environments.
  if (sdkDiscoveryFailed) {
    snapshot = await discoverViaCLI();
  }

  // If also including full catalog, merge unconnected providers
  if (snapshot && includeCatalog) {
    const catalog = await discoverAllViaCLI();
    if (catalog) {
      const existingIds = new Set(snapshot.providers.map((p) => p.id));
      for (const cp of catalog.providers) {
        if (!existingIds.has(cp.id)) {
          cp.connected = false;
          snapshot.providers.push(cp);
        }
      }
    }
  }

  if (!snapshot) {
    // Return empty snapshot — graceful degradation
    snapshot = buildEmptySnapshot();
  }

  if (isEmptySnapshot(snapshot)) {
    return buildEmptySnapshot();
  }

  _providerCache = { data: snapshot, ts: Date.now() };
  return snapshot;
}

/**
 * Get just the connected (credential-configured) providers.
 * Lightweight wrapper around discoverProviders().
 * @param {object} [opts]
 * @returns {Promise<DiscoveredProvider[]>}
 */
export async function getConnectedProviders(opts = {}) {
  const snapshot = await discoverProviders(opts);
  return snapshot.connected;
}

/**
 * Get models for a specific provider.
 * @param {string} providerID
 * @param {object} [opts]
 * @returns {Promise<DiscoveredModel[]>}
 */
export async function getProviderModels(providerID, opts = {}) {
  const snapshot = await discoverProviders(opts);
  const provider = snapshot.providers.find((p) => p.id === providerID);
  return provider?.models || [];
}

/**
 * Check if a provider is connected (has credentials configured).
 * @param {string} providerID
 * @param {object} [opts]
 * @returns {Promise<boolean>}
 */
export async function isProviderConnected(providerID, opts = {}) {
  const snapshot = await discoverProviders(opts);
  return snapshot.connectedIds.includes(providerID);
}

/**
 * Format a provider list for display in the setup wizard.
 * Returns an array of formatted strings suitable for use in choose() prompts.
 * @param {DiscoveredProvider[]} providers
 * @param {object} [opts]
 * @param {boolean} [opts.showModelCount=true]
 * @param {boolean} [opts.showConnected=true]
 * @returns {string[]}
 */
export function formatProvidersForMenu(providers, opts = {}) {
  const { showModelCount = true, showConnected = true } = opts;
  return providers.map((p) => {
    const parts = [p.name || p.id];
    if (showConnected) {
      parts.push(p.connected ? " ✓" : " ○");
    }
    if (showModelCount && p.models?.length) {
      parts.push(` (${p.models.length} models)`);
    }
    return parts.join("");
  });
}

/**
 * Format a model list for display in the setup wizard.
 * Returns an array of formatted strings suitable for use in choose() prompts.
 * @param {DiscoveredModel[]} models
 * @returns {string[]}
 */
export function formatModelsForMenu(models) {
  return models.map((m) => {
    const parts = [m.fullId];
    if (m.reasoning) parts.push(" 🧠");
    if (m.toolcall) parts.push(" 🔧");
    if (m.limit?.context) parts.push(` (${Math.round(m.limit.context / 1000)}k ctx)`);
    if (m.cost?.input > 0) parts.push(` $${m.cost.input.toFixed(2)}/M in`);
    return parts.join("");
  });
}

/**
 * Build an executor entry dict from a provider + model selection.
 * Returns the shape expected by bosun.config.json executors array.
 * @param {string} providerID
 * @param {string} modelFullId - "provider/model" format
 * @param {object} [overrides]
 * @returns {object}
 */
export function buildExecutorEntry(providerID, modelFullId, overrides = {}) {
  return {
    name: `opencode-${providerID}`,
    executor: "OPENCODE",
    weight: overrides.weight ?? 100,
    provider: providerID,
    providerConfig: {
      model: modelFullId,
      ...(overrides.baseUrl ? { baseUrl: overrides.baseUrl } : {}),
      ...(overrides.apiKey ? { apiKey: overrides.apiKey } : {}),
      ...(overrides.port ? { port: overrides.port } : {}),
      ...(overrides.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {}),
    },
  };
}

/**
 * Invalidate the provider cache, forcing a fresh query on next call.
 */
export function invalidateCache() {
  _providerCache = { data: null, ts: 0 };
}












