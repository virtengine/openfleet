/**
 * context-shredding-config.mjs — Configurable Context Shredding System
 *
 * "Context Shredding" is the process of pruning/compressing historical context
 * in agent sessions to prevent token overflow and reduce API costs while
 * preserving what matters most.
 *
 * SCOPE:
 *   - Agent-pool sessions (automated tasks, workflow nodes) — via agent-pool.mjs
 *   - Primary SDK sessions (Codex, Copilot, Claude, OpenCode, Gemini shells)
 *     — via maybeCompressSessionItems() in context-cache.mjs
 *   - NOT applied to: direct CLI invocations of agent binaries where the CLI
 *     process manages its own context window independently
 *
 * This module provides:
 *   - Type enumerations for agent types, interaction types, content types
 *   - Default configuration values (matching the hard-coded defaults in context-cache.mjs)
 *   - Config loading from environment variables (CONTEXT_SHREDDING_*)
 *   - Per-session option resolution based on agent type + interaction type
 *   - JSON profile support for fine-grained per-type overrides
 *
 * EXPORTS:
 *   AGENT_TYPES         — Supported agent SDK identifiers
 *   INTERACTION_TYPES   — Session/interaction type identifiers
 *   CONTENT_TYPES       — Content categories subject to shredding
 *   DEFAULT_SHREDDING_CONFIG — Sensible defaults (mirrors context-cache.mjs)
 *   loadContextShreddingConfig()     → Reads process.env, returns merged config
 *   resolveContextShreddingOptions(sessionType?, agentType?) → options for compressAllItems
 *   getDefaultOptions()              → Default options object for compressAllItems
 */

// ---------------------------------------------------------------------------
// Type Enumerations
// ---------------------------------------------------------------------------

/**
 * Supported AI SDK / agent type identifiers.
 * Mirrors the values in bosun.schema.json and PRIMARY_AGENT setting.
 */
export const AGENT_TYPES = Object.freeze([
  "codex-sdk",
  "copilot-sdk",
  "claude-sdk",
  "gemini-sdk",
  "opencode-sdk",
]);

/**
 * Interaction / session type identifiers.
 * Corresponds to session types tracked in session-tracker.mjs.
 */
export const INTERACTION_TYPES = Object.freeze([
  "task",        // Kanban task execution (agent-pool)
  "manual",      // Manual agent invocations
  "primary",     // Primary agent SDK sessions (long-running)
  "chat",        // Chat sessions via Telegram/Web
  "voice",       // Voice assistant sessions
  "flow",        // Workflow/multi-step flows
  "sdk-session", // Direct SDK shell sessions (codex, copilot, claude, opencode, gemini)
]);

/**
 * Content categories that shredding can target.
 */
export const CONTENT_TYPES = Object.freeze([
  "tool_output",    // Tool call results (file reads, searches, etc.)
  "agent_message",  // Agent reasoning/thinking messages
  "user_message",   // User prompt messages
]);

// ---------------------------------------------------------------------------
// Default Configuration
// ---------------------------------------------------------------------------

/**
 * Default Context Shredding configuration.
 *
 * Values mirror the hard-coded constants in context-cache.mjs so that
 * behaviour is unchanged when no overrides are set.
 *
 * @typedef {Object} ShreddingConfig
 * @property {boolean} enabled              - Master switch for context shredding
 * @property {number}  fullContextTurns     - Turns to keep tool outputs uncompressed (Tier 0)
 * @property {number}  tier1MaxAge          - Turns threshold for light compression (Tier 1)
 * @property {number}  tier2MaxAge          - Turns threshold for moderate compression (Tier 2)
 * @property {number}  tier1HeadChars       - Head chars to keep in Tier 1 compression
 * @property {number}  tier1TailChars       - Tail chars to keep in Tier 1 compression
 * @property {number}  tier2HeadChars       - Head chars to keep in Tier 2 compression
 * @property {number}  tier2TailChars       - Tail chars to keep in Tier 2 compression
 * @property {number}  scoreHighThreshold   - Score >= this: protect from compression
 * @property {number}  scoreLowThreshold    - Score < this: accelerate compression
 * @property {boolean} compressMessages     - Enable agent/user message compression
 * @property {number}  msgTier0MaxAge       - Turns to keep agent messages uncompressed
 * @property {number}  msgTier1MaxAge       - Turns threshold for moderate message compression
 * @property {number}  msgMinCompressChars  - Minimum chars before we bother compressing a message
 * @property {number}  userMsgFullTurns     - Turns the full user message is kept (>=1)
 * @property {boolean} compressToolOutputs  - Enable tool output compression
 * @property {boolean} compressAgentMessages - Enable agent message compression
 * @property {boolean} compressUserMessages - Enable user message compression
 * @property {boolean} liveToolCompactionEnabled - Enable command-aware live compaction before history shredding
 * @property {string}  liveToolCompactionMode - off|auto|aggressive smart mode for live compaction
 * @property {number}  liveToolCompactionMinChars - Minimum output chars before live compaction is considered
 * @property {number}  liveToolCompactionTargetChars - Target maximum chars for live-compacted outputs
 * @property {number}  liveToolCompactionMinSavingsPct - Minimum savings percentage required to keep a compacted result
 * @property {number}  liveToolCompactionMinRuntimeMs - Minimum runtime before live compaction is allowed when duration metadata exists
 * @property {boolean} liveToolCompactionBlockStructured - Disable live compaction for likely structured outputs
 * @property {string[]} liveToolCompactionAllowCommands - Command/tool allowlist for live compaction
 * @property {Object}  perType             - Per interaction-type overrides (keyed by INTERACTION_TYPES)
 * @property {Object}  perAgent            - Per agent-type overrides (keyed by AGENT_TYPES)
 */
export const DEFAULT_SHREDDING_CONFIG = Object.freeze({
  enabled: true,

  // ── Context-usage-based trigger ──────────────────────────────
  // Shredding only activates once estimated context fill exceeds the
  // threshold.  Below this percentage, items pass through uncompressed.
  contextUsageThreshold: 0.50,  // start shredding at 50% context fill
  contextUsageTarget:    0.40,  // target: compress down toward 40%
  contextUsageCritical:  0.70,  // above 70%: maximum aggression

  // ── Tool output tier boundaries ──────────────────────────────
  fullContextTurns: 3,    // last N turns: full output (Tier 0)
  tier1MaxAge: 5,          // turns 3–5: light compression
  tier2MaxAge: 9,          // turns 6–9: moderate compression
                           // turns 10+: skeleton (Tier 3)

  // ── Tool output compression sizes ────────────────────────────
  tier1HeadChars: 2000,
  tier1TailChars: 800,
  tier2HeadChars: 600,
  tier2TailChars: 300,

  // ── Content-aware scoring thresholds ─────────────────────────
  scoreHighThreshold: 70,  // protect high-value items (shift tier down)
  scoreLowThreshold: 30,   // accelerate low-value items (shift tier up)

  // ── Message compression ───────────────────────────────────────
  compressMessages: true,
  compressToolOutputs: true,
  compressAgentMessages: true,
  compressUserMessages: true,

  msgTier0MaxAge: 1,       // current + previous turn: full text
  msgTier1MaxAge: 4,       // turns 2–4: moderate summary
                           // turns 5+: breadcrumb only
  msgMinCompressChars: 120,
  userMsgFullTurns: 1,     // only the current turn keeps the full user prompt

  // ── Live command/tool compaction ─────────────────────────────
  liveToolCompactionEnabled: false,
  liveToolCompactionMode: "auto",
  liveToolCompactionMinChars: 4000,
  liveToolCompactionTargetChars: 1800,
  liveToolCompactionMinSavingsPct: 15,
  liveToolCompactionMinRuntimeMs: 2000,
  liveToolCompactionBlockStructured: true,
  liveToolCompactionAllowCommands: [
    "grep", "rg", "find", "git", "go", "npm", "pnpm", "yarn", "node",
    "python", "python3", "pytest", "docker", "kubectl", "cargo", "gradle",
    "maven", "mvn", "javac", "tsc", "jest", "vitest", "deno",
  ],

  // ── Per-type overrides (empty = use base config) ─────────────
  /** @type {Record<string, Partial<ShreddingConfig>>} */
  perType: {},
  /** @type {Record<string, Partial<ShreddingConfig>>} */
  perAgent: {},
});

// ---------------------------------------------------------------------------
// Environment Variable Loading
// ---------------------------------------------------------------------------

/** Prefix for all Context Shredding env vars */
const ENV_PREFIX = "CONTEXT_SHREDDING_";

/**
 * Parse a boolean environment variable value.
 * "1", "true", "yes", "on" → true; anything else → false
 * Returns undefined if value is not set.
 *
 * @param {string|undefined} val
 * @returns {boolean|undefined}
 */
function parseEnvBool(val) {
  if (val == null || val === "") return undefined;
  return ["1", "true", "yes", "on"].includes(val.toLowerCase().trim());
}

/**
 * Parse an integer environment variable value.
 * Returns undefined if value is not set or NaN.
 *
 * @param {string|undefined} val
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number|undefined}
 */
function parseEnvInt(val, min, max) {
  if (val == null || val === "") return undefined;
  const n = Number.parseInt(val, 10);
  if (Number.isNaN(n)) return undefined;
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

/**
 * Parse a float environment variable value.
 * Returns undefined if value is not set or NaN.
 *
 * @param {string|undefined} val
 * @param {number} [min]
 * @param {number} [max]
 * @returns {number|undefined}
 */
function parseEnvFloat(val, min, max) {
  if (val == null || val === "") return undefined;
  const n = Number.parseFloat(val);
  if (Number.isNaN(n)) return undefined;
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

/**
 * Load Context Shredding configuration from environment variables.
 *
 * Environment variables:
 *   CONTEXT_SHREDDING_ENABLED                — "true"/"false"
 *   CONTEXT_SHREDDING_FULL_CONTEXT_TURNS      — integer
 *   CONTEXT_SHREDDING_TIER1_MAX_AGE           — integer
 *   CONTEXT_SHREDDING_TIER2_MAX_AGE           — integer
 *   CONTEXT_SHREDDING_TIER1_HEAD_CHARS        — integer
 *   CONTEXT_SHREDDING_TIER1_TAIL_CHARS        — integer
 *   CONTEXT_SHREDDING_TIER2_HEAD_CHARS        — integer
 *   CONTEXT_SHREDDING_TIER2_TAIL_CHARS        — integer
 *   CONTEXT_SHREDDING_SCORE_HIGH              — integer 0-100
 *   CONTEXT_SHREDDING_SCORE_LOW               — integer 0-100
 *   CONTEXT_SHREDDING_COMPRESS_MESSAGES       — "true"/"false"
 *   CONTEXT_SHREDDING_COMPRESS_TOOL_OUTPUTS   — "true"/"false"
 *   CONTEXT_SHREDDING_COMPRESS_AGENT_MESSAGES — "true"/"false"
 *   CONTEXT_SHREDDING_COMPRESS_USER_MESSAGES  — "true"/"false"
 *   CONTEXT_SHREDDING_MSG_TIER0_MAX_AGE       — integer
 *   CONTEXT_SHREDDING_MSG_TIER1_MAX_AGE       — integer
 *   CONTEXT_SHREDDING_MSG_MIN_COMPRESS_CHARS  — integer
 *   CONTEXT_SHREDDING_USER_MSG_FULL_TURNS     — integer
 *   CONTEXT_SHREDDING_PROFILES                — JSON blob (per-type overrides)
 *
 * @returns {ShreddingConfig}  Fully merged configuration
 */
export function loadContextShreddingConfig() {
  const env = process.env;
  const cfg = { ...DEFAULT_SHREDDING_CONFIG };

  // ── Master switch ─────────────────────────────────────────────
  const enabled = parseEnvBool(env[`${ENV_PREFIX}ENABLED`]);
  if (enabled != null) cfg.enabled = enabled;

  // ── Context-usage thresholds ──────────────────────────────────
  const usageThreshold = parseEnvFloat(env[`${ENV_PREFIX}USAGE_THRESHOLD`], 0.1, 1.0);
  if (usageThreshold != null) cfg.contextUsageThreshold = usageThreshold;

  const usageTarget = parseEnvFloat(env[`${ENV_PREFIX}USAGE_TARGET`], 0.1, 0.9);
  if (usageTarget != null) cfg.contextUsageTarget = usageTarget;

  const usageCritical = parseEnvFloat(env[`${ENV_PREFIX}USAGE_CRITICAL`], 0.3, 1.0);
  if (usageCritical != null) cfg.contextUsageCritical = usageCritical;

  // ── Tier boundaries ───────────────────────────────────────────
  const fullTurns = parseEnvInt(env[`${ENV_PREFIX}FULL_CONTEXT_TURNS`], 1, 20);
  if (fullTurns != null) cfg.fullContextTurns = fullTurns;

  const tier1Age = parseEnvInt(env[`${ENV_PREFIX}TIER1_MAX_AGE`], 1, 50);
  if (tier1Age != null) cfg.tier1MaxAge = tier1Age;

  const tier2Age = parseEnvInt(env[`${ENV_PREFIX}TIER2_MAX_AGE`], 1, 100);
  if (tier2Age != null) cfg.tier2MaxAge = tier2Age;

  // ── Compression sizes ─────────────────────────────────────────
  const t1Head = parseEnvInt(env[`${ENV_PREFIX}TIER1_HEAD_CHARS`], 100, 10000);
  if (t1Head != null) cfg.tier1HeadChars = t1Head;

  const t1Tail = parseEnvInt(env[`${ENV_PREFIX}TIER1_TAIL_CHARS`], 0, 5000);
  if (t1Tail != null) cfg.tier1TailChars = t1Tail;

  const t2Head = parseEnvInt(env[`${ENV_PREFIX}TIER2_HEAD_CHARS`], 50, 5000);
  if (t2Head != null) cfg.tier2HeadChars = t2Head;

  const t2Tail = parseEnvInt(env[`${ENV_PREFIX}TIER2_TAIL_CHARS`], 0, 2000);
  if (t2Tail != null) cfg.tier2TailChars = t2Tail;

  // ── Score thresholds ──────────────────────────────────────────
  const scoreHigh = parseEnvInt(env[`${ENV_PREFIX}SCORE_HIGH`], 1, 100);
  if (scoreHigh != null) cfg.scoreHighThreshold = scoreHigh;

  const scoreLow = parseEnvInt(env[`${ENV_PREFIX}SCORE_LOW`], 0, 99);
  if (scoreLow != null) cfg.scoreLowThreshold = scoreLow;

  // ── Message compression toggles ───────────────────────────────
  const compMsgs = parseEnvBool(env[`${ENV_PREFIX}COMPRESS_MESSAGES`]);
  if (compMsgs != null) cfg.compressMessages = compMsgs;

  const compTools = parseEnvBool(env[`${ENV_PREFIX}COMPRESS_TOOL_OUTPUTS`]);
  if (compTools != null) cfg.compressToolOutputs = compTools;

  const compAgent = parseEnvBool(env[`${ENV_PREFIX}COMPRESS_AGENT_MESSAGES`]);
  if (compAgent != null) cfg.compressAgentMessages = compAgent;

  const compUser = parseEnvBool(env[`${ENV_PREFIX}COMPRESS_USER_MESSAGES`]);
  if (compUser != null) cfg.compressUserMessages = compUser;

  // ── Message tier parameters ───────────────────────────────────
  const msgTier0 = parseEnvInt(env[`${ENV_PREFIX}MSG_TIER0_MAX_AGE`], 0, 10);
  if (msgTier0 != null) cfg.msgTier0MaxAge = msgTier0;

  const msgTier1 = parseEnvInt(env[`${ENV_PREFIX}MSG_TIER1_MAX_AGE`], 1, 20);
  if (msgTier1 != null) cfg.msgTier1MaxAge = msgTier1;

  const msgMin = parseEnvInt(env[`${ENV_PREFIX}MSG_MIN_COMPRESS_CHARS`], 0, 2000);
  if (msgMin != null) cfg.msgMinCompressChars = msgMin;

  const userFull = parseEnvInt(env[`${ENV_PREFIX}USER_MSG_FULL_TURNS`], 0, 10);
  if (userFull != null) cfg.userMsgFullTurns = userFull;

  // ── Live command/tool compaction ─────────────────────────────
  const liveToolCompactionEnabled = parseEnvBool(env[`${ENV_PREFIX}LIVE_TOOL_COMPACTION_ENABLED`]);
  if (liveToolCompactionEnabled != null) cfg.liveToolCompactionEnabled = liveToolCompactionEnabled;

  const liveToolCompactionMode = String(env[`${ENV_PREFIX}LIVE_TOOL_COMPACTION_MODE`] || "").trim().toLowerCase();
  if (["off", "auto", "aggressive"].includes(liveToolCompactionMode)) {
    cfg.liveToolCompactionMode = liveToolCompactionMode;
  }

  const liveToolCompactionMinChars = parseEnvInt(env[`${ENV_PREFIX}LIVE_TOOL_COMPACTION_MIN_CHARS`], 500, 500000);
  if (liveToolCompactionMinChars != null) cfg.liveToolCompactionMinChars = liveToolCompactionMinChars;

  const liveToolCompactionTargetChars = parseEnvInt(env[`${ENV_PREFIX}LIVE_TOOL_COMPACTION_TARGET_CHARS`], 200, 50000);
  if (liveToolCompactionTargetChars != null) cfg.liveToolCompactionTargetChars = liveToolCompactionTargetChars;

  const liveToolCompactionMinSavingsPct = parseEnvInt(env[`${ENV_PREFIX}LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT`], 0, 95);
  if (liveToolCompactionMinSavingsPct != null) cfg.liveToolCompactionMinSavingsPct = liveToolCompactionMinSavingsPct;

  const liveToolCompactionMinRuntimeMs = parseEnvInt(env[`${ENV_PREFIX}LIVE_TOOL_COMPACTION_MIN_RUNTIME_MS`], 0, 60 * 60 * 1000);
  if (liveToolCompactionMinRuntimeMs != null) cfg.liveToolCompactionMinRuntimeMs = liveToolCompactionMinRuntimeMs;

  const liveToolCompactionBlockStructured = parseEnvBool(env[`${ENV_PREFIX}LIVE_TOOL_COMPACTION_BLOCK_STRUCTURED_OUTPUT`]);
  if (liveToolCompactionBlockStructured != null) cfg.liveToolCompactionBlockStructured = liveToolCompactionBlockStructured;

  const liveToolCompactionAllowCommands = String(env[`${ENV_PREFIX}LIVE_TOOL_COMPACTION_ALLOW_COMMANDS`] || "").trim();
  if (liveToolCompactionAllowCommands) {
    cfg.liveToolCompactionAllowCommands = liveToolCompactionAllowCommands
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }

  // ── Per-type JSON profiles ────────────────────────────────────
  const profilesEnv = env[`${ENV_PREFIX}PROFILES`];
  if (profilesEnv) {
    try {
      const profiles = JSON.parse(profilesEnv);
      if (profiles && typeof profiles === "object") {
        const { perType, perAgent, ...rest } = profiles;
        // Allow flat profile keys that are interaction/agent types
        if (perType && typeof perType === "object") {
          cfg.perType = { ...DEFAULT_SHREDDING_CONFIG.perType, ...perType };
        }
        if (perAgent && typeof perAgent === "object") {
          cfg.perAgent = { ...DEFAULT_SHREDDING_CONFIG.perAgent, ...perAgent };
        }
        // Merge flat overrides (top-level keys) into base config
        const knownKeys = new Set(Object.keys(DEFAULT_SHREDDING_CONFIG));
        for (const [k, v] of Object.entries(rest)) {
          if (knownKeys.has(k) && k !== "perType" && k !== "perAgent") {
            cfg[k] = v;
          }
        }
      }
    } catch {
      // Invalid JSON — silently ignore profile overrides
    }
  }

  return cfg;
}

// ---------------------------------------------------------------------------
// Module-scope cache for the loaded config
// (Reset on each call to loadContextShreddingConfig for testability)
// ---------------------------------------------------------------------------

/** @type {ShreddingConfig|null} */
let _cachedConfig = null;

/**
 * Get the loaded config, reading from env once per process lifetime.
 * Call loadContextShreddingConfig() directly to force a re-read.
 *
 * @returns {ShreddingConfig}
 */
export function getContextShreddingConfig() {
  if (_cachedConfig == null) {
    _cachedConfig = loadContextShreddingConfig();
  }
  return _cachedConfig;
}

/**
 * Reset the module-scope config cache.
 * Exposed for test isolation only — do not call in production code.
 */
export function _resetConfigCache() {
  _cachedConfig = null;
}

// ---------------------------------------------------------------------------
// Option Resolution
// ---------------------------------------------------------------------------

/**
 * Merge a partial config override into a base config.
 *
 * @param {ShreddingConfig} base
 * @param {Partial<ShreddingConfig>} override
 * @returns {ShreddingConfig}
 */
function mergeConfig(base, override) {
  if (!override || typeof override !== "object") return base;
  return { ...base, ...override };
}

/**
 * Resolve compression options for a specific session context.
 *
 * Merges:
 *   1. Global default config (env vars applied)
 *   2. Per-interaction-type override (if any)
 *   3. Per-agent-type override (if any)
 *
 * Returns an options object shaped for `compressAllItems()`.
 *
 * @param {string} [sessionType]  - Interaction type (e.g. "task", "chat", "voice")
 * @param {string} [agentType]    - Agent SDK type (e.g. "codex-sdk", "claude-sdk")
 * @returns {object}              - Options object for compressAllItems
 */
export function resolveContextShreddingOptions(sessionType, agentType) {
  const base = getContextShreddingConfig();

  // Not enabled — return a minimal "skip everything" options object
  if (!base.enabled) {
    return { _skip: true };
  }

  // Apply per-interaction-type override
  let cfg = base;
  if (sessionType && base.perType && base.perType[sessionType]) {
    cfg = mergeConfig(cfg, base.perType[sessionType]);
  }

  // Apply per-agent-type override
  if (agentType && cfg.perAgent && cfg.perAgent[agentType]) {
    cfg = mergeConfig(cfg, cfg.perAgent[agentType]);
  }

  return configToOptions(cfg);
}

/**
 * Convert a ShreddingConfig into the options object expected by
 * `compressAllItems` in context-cache.mjs.
 *
 * @param {ShreddingConfig} cfg
 * @returns {object}
 */
function configToOptions(cfg) {
  return {
    // Context-usage-based trigger
    contextUsageThreshold: cfg.contextUsageThreshold,
    contextUsageTarget: cfg.contextUsageTarget,
    contextUsageCritical: cfg.contextUsageCritical,

    // Tier boundaries
    fullContextTurns: cfg.fullContextTurns,
    tier1MaxAge: cfg.tier1MaxAge,
    tier2MaxAge: cfg.tier2MaxAge,

    // Compression sizes
    tier1HeadChars: cfg.tier1HeadChars,
    tier1TailChars: cfg.tier1TailChars,
    tier2HeadChars: cfg.tier2HeadChars,
    tier2TailChars: cfg.tier2TailChars,

    // Score thresholds
    scoreHighThreshold: cfg.scoreHighThreshold,
    scoreLowThreshold: cfg.scoreLowThreshold,

    // Message compression
    compressMessages: cfg.compressMessages,
    compressToolOutputs: cfg.compressToolOutputs,
    compressAgentMessages: cfg.compressAgentMessages,
    compressUserMessages: cfg.compressUserMessages,
    msgTier0MaxAge: cfg.msgTier0MaxAge,
    msgTier1MaxAge: cfg.msgTier1MaxAge,
    msgMinCompressChars: cfg.msgMinCompressChars,
    userMsgFullTurns: cfg.userMsgFullTurns,
    liveToolCompactionEnabled: cfg.liveToolCompactionEnabled,
    liveToolCompactionMode: cfg.liveToolCompactionMode,
    liveToolCompactionMinChars: cfg.liveToolCompactionMinChars,
    liveToolCompactionTargetChars: cfg.liveToolCompactionTargetChars,
    liveToolCompactionMinSavingsPct: cfg.liveToolCompactionMinSavingsPct,
    liveToolCompactionMinRuntimeMs: cfg.liveToolCompactionMinRuntimeMs,
    liveToolCompactionBlockStructured: cfg.liveToolCompactionBlockStructured,
    liveToolCompactionAllowCommands: [...(cfg.liveToolCompactionAllowCommands || [])],
  };
}

/**
 * Get the default options object (using defaults, no env overrides).
 * Useful for testing and default comparisons.
 *
 * @returns {object}
 */
export function getDefaultOptions() {
  return configToOptions(DEFAULT_SHREDDING_CONFIG);
}

// ---------------------------------------------------------------------------
// ENV var list (for setup wizard + settings UI enumeration)
// ---------------------------------------------------------------------------

/**
 * Metadata about each CONTEXT_SHREDDING_* environment variable.
 * Used by the settings UI and setup wizard.
 *
 * @type {Array<{key: string, label: string, type: 'boolean'|'number'|'json', default: *, description: string, min?: number, max?: number, unit?: string, advanced?: boolean}>}
 */
export const CONTEXT_SHREDDING_ENV_DEFS = [
  {
    key: "CONTEXT_SHREDDING_ENABLED",
    label: "Enable Context Shredding",
    type: "boolean",
    default: true,
    description: "Master switch for context compression. Applies to: agent-pool sessions (automated tasks, workflow nodes), primary SDK sessions (Codex, Copilot, Claude, OpenCode). Does NOT apply to: direct CLI invocations of agent binaries (context is managed by the CLI process itself). When off, agents receive their full history every turn (increases cost and risk of context overflow).",
  },
  {
    key: "CONTEXT_SHREDDING_USAGE_THRESHOLD",
    label: "Usage Threshold",
    type: "number",
    default: 0.50,
    min: 0.1,
    max: 1.0,
    description: "Context fill percentage (0.0–1.0) at which shredding activates. Below this level, items pass through uncompressed. Default: 0.50 (50%).",
  },
  {
    key: "CONTEXT_SHREDDING_USAGE_TARGET",
    label: "Usage Target",
    type: "number",
    default: 0.40,
    min: 0.1,
    max: 0.9,
    description: "Target context fill percentage. Shredding aims to compress items down toward this level. Default: 0.40 (40%).",
  },
  {
    key: "CONTEXT_SHREDDING_USAGE_CRITICAL",
    label: "Usage Critical",
    type: "number",
    default: 0.70,
    min: 0.3,
    max: 1.0,
    description: "Context fill percentage above which maximum shredding aggression applies — all tier boundaries are halved and oldest items are aggressively compressed. Default: 0.70 (70%).",
  },
  {
    key: "CONTEXT_SHREDDING_FULL_CONTEXT_TURNS",
    label: "Full Context Turns (Tier 0)",
    type: "number",
    default: 3,
    min: 1,
    max: 20,
    description: "Number of most-recent turns to keep completely uncompressed. Higher values use more tokens but improve agent coherence on rapid back-and-forth.",
  },
  {
    key: "CONTEXT_SHREDDING_TIER1_MAX_AGE",
    label: "Tier 1 Max Age",
    type: "number",
    default: 5,
    min: 1,
    max: 50,
    unit: "turns",
    description: "Turns threshold for light compression (head+tail truncation). Items older than Tier 0 but within this age get light compression.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_TIER2_MAX_AGE",
    label: "Tier 2 Max Age",
    type: "number",
    default: 9,
    min: 2,
    max: 100,
    unit: "turns",
    description: "Turns threshold for moderate compression. Items older than Tier 1 but within this age get heavy head+tail truncation.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_TIER1_HEAD_CHARS",
    label: "Tier 1 Head Characters",
    type: "number",
    default: 2000,
    min: 100,
    max: 10000,
    unit: "chars",
    description: "Maximum characters to keep from the start of a tool output in Tier 1 compression.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_TIER1_TAIL_CHARS",
    label: "Tier 1 Tail Characters",
    type: "number",
    default: 800,
    min: 0,
    max: 5000,
    unit: "chars",
    description: "Maximum characters to keep from the end of a tool output in Tier 1 compression.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_TIER2_HEAD_CHARS",
    label: "Tier 2 Head Characters",
    type: "number",
    default: 600,
    min: 50,
    max: 5000,
    unit: "chars",
    description: "Maximum characters to keep from the start of a tool output in Tier 2 compression.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_TIER2_TAIL_CHARS",
    label: "Tier 2 Tail Characters",
    type: "number",
    default: 300,
    min: 0,
    max: 2000,
    unit: "chars",
    description: "Maximum characters to keep from the end of a tool output in Tier 2 compression.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_SCORE_HIGH",
    label: "High-Value Score Threshold",
    type: "number",
    default: 70,
    min: 1,
    max: 100,
    description: "Items scored at or above this threshold are protected from compression (tier shifted down). Higher = protect more items.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_SCORE_LOW",
    label: "Low-Value Score Threshold",
    type: "number",
    default: 30,
    min: 0,
    max: 99,
    description: "Items scored below this threshold are compressed more aggressively (tier shifted up). Lower = compress fewer items early.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_COMPRESS_MESSAGES",
    label: "Compress Agent & User Messages",
    type: "boolean",
    default: true,
    description: "Compress agent reasoning messages and user prompts as they age out. Prevents long planning monologues from occupying context permanently.",
  },
  {
    key: "CONTEXT_SHREDDING_COMPRESS_TOOL_OUTPUTS",
    label: "Compress Tool Outputs",
    type: "boolean",
    default: true,
    description: "Enable tiered compression for tool call outputs (file reads, search results, etc.).",
  },
  {
    key: "CONTEXT_SHREDDING_COMPRESS_AGENT_MESSAGES",
    label: "Compress Agent Messages",
    type: "boolean",
    default: true,
    description: "Compress verbose agent thinking/planning messages after they age out of the active window.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_COMPRESS_USER_MESSAGES",
    label: "Compress User Messages",
    type: "boolean",
    default: true,
    description: "Compress old user prompt messages to a short breadcrumb. The current turn's prompt is always kept in full.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_MSG_TIER0_MAX_AGE",
    label: "Message Full-Text Turns",
    type: "number",
    default: 1,
    min: 0,
    max: 10,
    unit: "turns",
    description: "Number of most-recent turns to preserve agent messages in full text (no compression).",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_MSG_TIER1_MAX_AGE",
    label: "Message Summary Turns",
    type: "number",
    default: 4,
    min: 1,
    max: 20,
    unit: "turns",
    description: "Turns within which agent messages get a moderate summary. Messages older than this become a one-line breadcrumb.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_MSG_MIN_COMPRESS_CHARS",
    label: "Min Message Chars to Compress",
    type: "number",
    default: 120,
    min: 0,
    max: 2000,
    unit: "chars",
    description: "Agent messages shorter than this are never compressed (they're already concise).",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_USER_MSG_FULL_TURNS",
    label: "User Message Full-Text Turns",
    type: "number",
    default: 1,
    min: 0,
    max: 10,
    unit: "turns",
    description: "Turns during which the full user prompt is preserved. After this, only a short summary is kept.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ENABLED",
    label: "Live Tool Compaction",
    type: "boolean",
    default: false,
    description: "Enable command-aware compaction of large tool outputs before they are stored in the active turn. Falls back to raw output on low confidence or unsafe shapes.",
  },
  {
    key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MODE",
    label: "Live Compaction Mode",
    type: "select",
    default: "auto",
    options: ["off", "auto", "aggressive"],
    description: "off disables live compaction, auto compacts only when pressure or signal justify it, and aggressive favors stronger reduction for noisy command families.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_CHARS",
    label: "Live Compaction Minimum Size",
    type: "number",
    default: 4000,
    min: 500,
    max: 500000,
    unit: "chars",
    description: "Minimum output size before live compaction is considered.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_TARGET_CHARS",
    label: "Live Compaction Target Size",
    type: "number",
    default: 1800,
    min: 200,
    max: 50000,
    unit: "chars",
    description: "Target upper bound for compacted live command output before retrieval hints and metadata.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_SAVINGS_PCT",
    label: "Live Compaction Min Savings",
    type: "number",
    default: 15,
    min: 0,
    max: 95,
    unit: "%",
    description: "Discard compacted output if it does not save at least this much space.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_MIN_RUNTIME_MS",
    label: "Live Compaction Min Runtime",
    type: "number",
    default: 2000,
    min: 0,
    max: 3600000,
    unit: "ms",
    description: "When command duration metadata is present, require at least this runtime before compacting in auto mode.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_BLOCK_STRUCTURED_OUTPUT",
    label: "Skip Structured Output",
    type: "boolean",
    default: true,
    description: "Avoid live compaction for likely JSON or other structured outputs where exact bytes matter more than size.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_LIVE_TOOL_COMPACTION_ALLOW_COMMANDS",
    label: "Live Compaction Allowlist",
    type: "text",
    default: "grep,rg,find,git,go,npm,pnpm,yarn,node,python,python3,pytest,docker,kubectl,cargo,gradle,maven,mvn,javac,tsc,jest,vitest,deno",
    description: "Comma-separated command or tool families eligible for live compaction. Commands outside the allowlist pass through untouched.",
    advanced: true,
  },
  {
    key: "CONTEXT_SHREDDING_PROFILES",
    label: "Per-Type Profiles (JSON)",
    type: "json",
    default: "",
    description: "JSON object with per-interaction-type or per-agent-type overrides. Format: { \"perType\": { \"voice\": { \"fullContextTurns\": 5 } }, \"perAgent\": { \"claude-sdk\": { \"tier1MaxAge\": 8 } } }",
    advanced: true,
  },
];
