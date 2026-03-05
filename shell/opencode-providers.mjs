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
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

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
      const result = sdk.createOpencodeClient({
        hostname: "127.0.0.1",
        port,
        timeout: 5_000,
      });
      client = result;
    } catch {
      return null;
    }
  }

  try {
    // Fetch provider list + auth methods in parallel
    const [providerRes, authRes] = await Promise.all([
      client.provider.list().catch(() => null),
      client.provider.auth().catch(() => null),
    ]);

    if (!providerRes?.data) return null;

    const { all: rawProviders = [], connected: connectedIds = [], default: defaults = {} } =
      providerRes.data;
    const authMethods = authRes?.data || {};
    const connectedSet = new Set(connectedIds);

    const providers = rawProviders.map((p) => {
      const models = Object.entries(p.models || {}).map(([modelKey, m]) => ({
        id: m.id || modelKey,
        name: m.name || modelKey,
        providerID: p.id,
        fullId: `${p.id}/${m.id || modelKey}`,
        status: m.status || "active",
        reasoning: m.reasoning ?? false,
        toolcall: m.tool_call ?? false,
        limit: m.limit || { context: 0, output: 0 },
        cost: m.cost
          ? { input: m.cost.input || 0, output: m.cost.output || 0 }
          : { input: 0, output: 0 },
      }));

      return {
        id: p.id,
        name: p.name || p.id,
        source: "api",
        env: p.env || [],
        connected: connectedSet.has(p.id),
        models,
        authMethods: authMethods[p.id] || [],
      };
    });

    const allModels = providers.flatMap((p) => p.models);

    return {
      providers,
      connected: providers.filter((p) => p.connected),
      connectedIds: [...connectedSet],
      defaults,
      allModels,
      timestamp: Date.now(),
    };
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
    ...execOpts,
  };

  if (isWindows) {
    // Use exec() on Windows to properly handle .cmd wrappers
    const escaped = args.map((a) => `"${a}"`).join(" ");
    return execAsync(`"${bin}" ${escaped}`, baseOpts);
  }
  return execFileAsync(bin, args, baseOpts);
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
 * Query providers via `opencode models --verbose` CLI command.
 * Works even without a running server. Falls back gracefully.
 * @returns {Promise<ProviderSnapshot|null>}
 */
async function discoverViaCLI() {
  try {
    const { stdout } = await execOpencode(["models", "--verbose"]);
    const { providerMap, allModels } = parseVerboseModelsOutput(stdout);
    const providers = [...providerMap.values()];

    return {
      providers,
      connected: providers, // CLI only returns connected providers
      connectedIds: providers.map((p) => p.id),
      defaults: {},
      allModels,
      timestamp: Date.now(),
    };
  } catch (err) {
    console.warn(`[opencode-providers] CLI discovery failed: ${err.message}`);
    return null;
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
  let snapshot = await discoverViaSDK(client);

  // Fall back to CLI
  if (!snapshot) {
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
    snapshot = {
      providers: [],
      connected: [],
      connectedIds: [],
      defaults: {},
      allModels: [],
      timestamp: Date.now(),
    };
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
