/**
 * context-cache.mjs — Tiered Context Compression with Disk-Backed Cache
 *
 * WHY THIS EXISTS:
 * ────────────────
 * Tool call outputs dominate agent context windows. A 20-turn session can
 * accumulate 200K+ tokens of tool outputs that are re-sent with every API
 * call.  This module implements a tiered compression strategy:
 *
 *   Tier 0 (turns N, N-1, N-2):  Full output — untouched
 *   Tier 1 (turns N-3 to N-5):   Light compression (~20% reduction)
 *   Tier 2 (turns N-6 to N-9):   Moderate compression (~60% reduction)
 *   Tier 3 (turns N-10+):        Skeleton — tool name, args summary, char count
 *
 * Before ANY compression, the full original output is persisted to
 * `.cache/tool-logs/` with a monotonic ID. The compressed placeholder
 * includes `bosun --tool-log <ID>` so agents can retrieve the full
 * output back into context on demand.
 *
 * EXPORTS:
 *   cacheAndCompressItems(items, currentTurnIndex)
 *     → Takes the accumulated items array and the current turn index,
 *       caches old outputs to disk, returns a new items array with
 *       tiered compression applied.
 *
 *   retrieveToolLog(id)
 *     → Reads the full cached output for the given numeric ID.
 *
 *   pruneToolLogCache(maxAgeMs?)
 *     → Deletes cache entries older than maxAgeMs (default 24h).
 *
 *   getToolLogDir()
 *     → Returns the absolute path to the cache directory.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TAG = "[context-cache]";

/** Cache directory lives alongside bosun's logs/ directory */
const TOOL_LOG_DIR = resolve(__dirname, "..", ".cache", "tool-logs");

/** Default max age for cached entries: 24 hours */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Monotonic counter — reset per process, files use timestamp + counter */
let _logCounter = 0;

/** In-memory index: logId → { file, ts, toolName, argsPreview } */
const _logIndex = new Map();

// ---------------------------------------------------------------------------
// Shredding Telemetry Ring Buffer
// ---------------------------------------------------------------------------

/** Max events to keep in the in-process ring buffer */
const MAX_SHREDDING_BUFFER = 500;

/**
 * @typedef {Object} ShreddingEvent
 * @property {string}  timestamp       - ISO timestamp
 * @property {number}  originalChars   - Chars before compression
 * @property {number}  compressedChars - Chars after compression
 * @property {number}  savedChars      - Difference
 * @property {number}  savedPct        - % reduction
 * @property {string}  [agentType]     - SDK / agent type
 * @property {string}  [attemptId]     - Task attempt ID
 * @property {string}  [taskId]        - Task ID
 */

/** @type {ShreddingEvent[]} */
const _shreddingRingBuffer = [];

/** Absolute path to the persistent shredding stats log */
const SHREDDING_LOG_FILE = resolve(__dirname, "..", ".cache", "agent-work-logs", "shredding-stats.jsonl");

// ---------------------------------------------------------------------------
// Tool-Log Memory Cache
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MemCacheEntry
 * @property {object} entry      - The full parsed tool log entry
 * @property {number} sizeBytes  - Byte size of serialized entry
 * @property {number} addedAt    - Unix ms when cached
 */

/** logId → MemCacheEntry */
const _contentCache = new Map();

/** Total bytes across all in-memory cached entries */
let _contentCacheTotalBytes = 0;

/** @type {{ enabled: boolean, maxSizeBytes: number, archiveSizeLimitBytes: number }} */
const _contentCacheConfig = {
  enabled: false,
  maxSizeBytes: 50 * 1024 * 1024,           // 50 MB default in-memory limit
  archiveSizeLimitBytes: 200 * 1024 * 1024,  // 200 MB disk prune trigger
};

// ── Tier boundaries (measured in "age" = currentTurn - itemTurn) ──────────
const TIER_0_MAX_AGE = 2;  // last 3 turns: full context
const TIER_1_MAX_AGE = 5;  // turns 3-5: light compression
const TIER_2_MAX_AGE = 9;  // turns 6-9: moderate compression
const DEFAULT_GIT_OUTPUT_MAX_CHARS = 8000;

// ── Compression parameters ────────────────────────────────────────────────
const TIER_1_HEAD_CHARS = 2000;
const TIER_1_TAIL_CHARS = 800;
const TIER_2_HEAD_CHARS = 600;
const TIER_2_TAIL_CHARS = 300;

// ---------------------------------------------------------------------------
// Options Resolver — converts caller-supplied options into a full opts object
// with all fields defaulting to the module-scope constants above.
// ---------------------------------------------------------------------------

/**
 * Resolve caller-supplied compression options into a complete object.
 * All fields default to the module-scope constants.
 *
 * @param {object} [options]
 * @returns {object}  Fully populated internal options
 */
function resolveOpts(options = {}) {
  return {
    contextUsageThreshold: options.contextUsageThreshold ?? 0.50,
    contextUsageTarget:    options.contextUsageTarget    ?? 0.40,
    contextUsageCritical:  options.contextUsageCritical  ?? 0.70,
    fullContextTurns:     options.fullContextTurns     ?? 3,
    tier1MaxAge:          options.tier1MaxAge          ?? TIER_1_MAX_AGE,
    tier2MaxAge:          options.tier2MaxAge          ?? TIER_2_MAX_AGE,
    tier0MaxAge:          TIER_0_MAX_AGE, // not currently overridable, kept for symmetry
    tier1HeadChars:       options.tier1HeadChars       ?? TIER_1_HEAD_CHARS,
    tier1TailChars:       options.tier1TailChars       ?? TIER_1_TAIL_CHARS,
    tier2HeadChars:       options.tier2HeadChars       ?? TIER_2_HEAD_CHARS,
    tier2TailChars:       options.tier2TailChars       ?? TIER_2_TAIL_CHARS,
    scoreHighThreshold:   options.scoreHighThreshold   ?? SCORE_HIGH_DEFAULT,
    scoreLowThreshold:    options.scoreLowThreshold    ?? SCORE_LOW_DEFAULT,
    compressToolOutputs:  options.compressToolOutputs  ?? true,
    compressMessages:     options.compressMessages     ?? true,
    compressAgentMessages: options.compressAgentMessages ?? true,
    compressUserMessages:  options.compressUserMessages  ?? true,
    msgTier0MaxAge:       options.msgTier0MaxAge       ?? MSG_TIER_0_MAX_AGE,
    msgTier1MaxAge:       options.msgTier1MaxAge       ?? MSG_TIER_1_MAX_AGE,
    msgMinCompressChars:  options.msgMinCompressChars  ?? MSG_MIN_COMPRESS_CHARS,
    userMsgFullTurns:     options.userMsgFullTurns     ?? USER_MSG_FULL_TURNS,
    gitOutputMaxChars:    options.gitOutputMaxChars    ?? getGitOutputMaxCharsFromEnv(),
  };
}

function getGitOutputMaxCharsFromEnv() {
  const raw = process.env.BOSUN_GIT_OUTPUT_MAX_CHARS;
  if (raw === undefined || raw === null || raw === "") {
    return DEFAULT_GIT_OUTPUT_MAX_CHARS;
  }
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_GIT_OUTPUT_MAX_CHARS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Filesystem helpers (lazy-loaded to avoid top-level async)
// ---------------------------------------------------------------------------

let _fsPromises = null;
async function getFs() {
  if (!_fsPromises) {
    _fsPromises = await import("node:fs/promises");
  }
  return _fsPromises;
}

async function ensureCacheDir() {
  const fs = await getFs();
  await fs.mkdir(TOOL_LOG_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Cache Write
// ---------------------------------------------------------------------------

/**
 * Persist a tool output to disk and return a numeric log ID.
 *
 * @param {object} item        The original item object (has text/output/etc.)
 * @param {string} toolName    Name of the tool call
 * @param {string} argsPreview Short summary of arguments
 * @returns {Promise<number>}  The assigned log ID
 */
async function writeToCache(item, toolName, argsPreview) {
  await ensureCacheDir();
  const fs = await getFs();

  _logCounter += 1;
  const logId = Date.now() * 1000 + _logCounter; // unique, sortable
  const filename = `${logId}.json`;
  const filepath = resolve(TOOL_LOG_DIR, filename);

  const entry = {
    id: logId,
    ts: Date.now(),
    toolName: toolName || "unknown",
    argsPreview: argsPreview || "",
    item,
  };

  try {
    await fs.writeFile(filepath, JSON.stringify(entry), "utf8");
    _logIndex.set(logId, {
      file: filepath,
      ts: entry.ts,
      toolName: entry.toolName,
      argsPreview: entry.argsPreview,
    });

    // Optionally keep full content in memory for fast retrieval
    if (_contentCacheConfig.enabled) {
      const serialized = JSON.stringify(entry);
      const sizeBytes = serialized.length * 2; // rough UTF-16 estimate
      _contentCache.set(logId, { entry, sizeBytes, addedAt: Date.now() });
      _contentCacheTotalBytes += sizeBytes;
      // Evict oldest entries if over the size cap
      if (_contentCacheTotalBytes > _contentCacheConfig.maxSizeBytes) {
        _evictContentCacheBySize();
      }
    }
  } catch (err) {
    console.warn(`${TAG} failed to cache tool log ${logId}: ${err.message}`);
  }

  return logId;
}

// ---------------------------------------------------------------------------
// Cache Read
// ---------------------------------------------------------------------------

/**
 * Retrieve the full original tool output for a given log ID.
 *
 * @param {number|string} id  The numeric log ID
 * @returns {Promise<{ found: boolean, entry?: object, error?: string }>}
 */
export async function retrieveToolLog(id) {
  const numId = Number(id);
  if (!Number.isFinite(numId) || numId < 1) {
    return { found: false, error: "Invalid log ID" };
  }

  // Fast path: in-memory content cache (only populated when toolLogCache.enabled = true)
  const memEntry = _contentCache.get(numId);
  if (memEntry) {
    return { found: true, entry: memEntry.entry, fromMemCache: true };
  }

  // Try in-memory index first
  const indexEntry = _logIndex.get(numId);
  const filepath = indexEntry?.file || resolve(TOOL_LOG_DIR, `${numId}.json`);

  try {
    const fs = await getFs();
    const raw = await fs.readFile(filepath, "utf8");
    const entry = JSON.parse(raw);
    return { found: true, entry };
  } catch (err) {
    if (err.code === "ENOENT") {
      return { found: false, error: `Tool log ${numId} not found (may have been pruned)` };
    }
    return { found: false, error: `Failed to read tool log ${numId}: ${err.message}` };
  }
}

/**
 * List available cached tool logs (most recent first).
 *
 * @param {number} [limit=20]  Max entries to return
 * @returns {Promise<Array<{ id: number, ts: number, toolName: string, argsPreview: string }>>}
 */
export async function listToolLogs(limit = 20) {
  try {
    const fs = await getFs();
    await ensureCacheDir();
    const files = await fs.readdir(TOOL_LOG_DIR);
    const jsonFiles = files
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, limit);

    const results = [];
    for (const f of jsonFiles) {
      try {
        const raw = await fs.readFile(resolve(TOOL_LOG_DIR, f), "utf8");
        const entry = JSON.parse(raw);
        results.push({
          id: entry.id,
          ts: entry.ts,
          toolName: entry.toolName,
          argsPreview: entry.argsPreview,
        });
      } catch {
        // skip corrupt entries
      }
    }
    return results;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cache Pruning
// ---------------------------------------------------------------------------

/**
 * Delete cache entries older than maxAgeMs.
 *
 * @param {number} [maxAgeMs=86400000]  Max age in milliseconds (default 24h)
 * @returns {Promise<number>}  Count of pruned entries
 */
export async function pruneToolLogCache(maxAgeMs = DEFAULT_MAX_AGE_MS) {
  try {
    const fs = await getFs();
    await ensureCacheDir();
    const files = await fs.readdir(TOOL_LOG_DIR);
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;

    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const filepath = resolve(TOOL_LOG_DIR, f);
      try {
        const stat = await fs.stat(filepath);
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(filepath);
          pruned++;
          // Also remove from in-memory index
          const numId = Number(f.replace(".json", ""));
          if (Number.isFinite(numId)) _logIndex.delete(numId);
        }
      } catch {
        // skip
      }
    }

    if (pruned > 0) {
      console.log(`${TAG} pruned ${pruned} expired tool log(s)`);
    }
    return pruned;
  } catch (err) {
    console.warn(`${TAG} prune failed: ${err.message}`);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Item Inspection Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the primary text content from an item (checks multiple fields).
 */
function getItemText(item) {
  if (!item || typeof item !== "object") return "";
  return (
    item.text ||
    item.output ||
    item.aggregated_output ||
    item.result ||
    item.message ||
    (item.error && typeof item.error === "object" ? item.error.message : "") ||
    ""
  );
}

/**
 * Set the text content on a tool output item, matching whichever field
 * the item originally uses (text, output, aggregated_output, etc.).
 * @param {object} item
 * @param {string} newText
 */
function setItemText(item, newText) {
  if (!item || typeof item !== "object") return;
  if (item.text !== undefined) { item.text = newText; return; }
  if (item.output !== undefined) { item.output = newText; return; }
  if (item.aggregated_output !== undefined) { item.aggregated_output = newText; return; }
  if (item.result !== undefined) { item.result = newText; return; }
  if (item.message !== undefined) { item.message = newText; return; }
  // Fallback: set .output
  item.output = newText;
}

/**
 * Get a human-readable size for text.
 */
function charLabel(text) {
  const len = typeof text === "string" ? text.length : 0;
  if (len < 1024) return `${len} chars`;
  return `${(len / 1024).toFixed(1)}K chars`;
}

/**
 * Extract tool name from an item.
 */
function extractToolName(item) {
  if (!item || typeof item !== "object") return "unknown";
  return (
    item.tool_name ||
    item.toolName ||
    item.name ||
    item.call?.name ||
    item.type ||
    "unknown"
  );
}

/**
 * Build a short preview of tool arguments.
 */
function extractArgsPreview(item) {
  if (!item || typeof item !== "object") return "";
  const args = item.arguments || item.args || item.call?.arguments;
  if (!args) return "";
  if (typeof args === "string") {
    return args.length > 120 ? args.slice(0, 120) + "…" : args;
  }
  if (typeof args === "object") {
    // Keep file paths and short values, truncate long ones
    const parts = [];
    for (const [k, v] of Object.entries(args)) {
      const sv = String(v ?? "");
      if (sv.length > 80) {
        parts.push(`${k}: "${sv.slice(0, 60)}…"`);
      } else {
        parts.push(`${k}: "${sv}"`);
      }
      if (parts.join(", ").length > 120) break;
    }
    return parts.join(", ");
  }
  return "";
}

function extractCommandText(item) {
  if (!item || typeof item !== "object") return "";

  const directCommand = typeof item.command === "string" ? item.command : "";
  if (directCommand) return directCommand;

  const args = item.arguments || item.args || item.call?.arguments;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) return "";
    const parsed = safeParse(args);
    if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
      return extractCommandText({ arguments: parsed });
    }
    return trimmed;
  }

  if (Array.isArray(args)) {
    return args.map((part) => String(part ?? "")).join(" ").trim();
  }

  const argsObj = args;
  if (!argsObj || typeof argsObj !== "object") return "";

  for (const key of ["command", "cmd", "argv", "args"]) {
    const value = argsObj[key];
    if (typeof value === "string" && value.trim()) return value;
    if (Array.isArray(value)) return value.map((part) => String(part ?? "")).join(" ").trim();
  }

  return "";
}

function normalizeGitDescriptor(item) {
  const toolName = extractToolName(item);
  const commandText = extractCommandText(item);
  return `${toolName} ${commandText}`
    .toLowerCase()
    .replaceAll(/_+/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function classifyImmediateGitOutput(item, opts) {
  const maxChars = opts?.gitOutputMaxChars ?? DEFAULT_GIT_OUTPUT_MAX_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return null;

  const text = getItemText(item);
  if (typeof text !== "string" || text.length <= maxChars) return null;

  const descriptor = normalizeGitDescriptor(item);
  if (!descriptor.includes("git")) return null;

  if (/\bgit\s+log\b/.test(descriptor)) return { kind: "log", text };
  if (/\bgit\s+shortlog\b/.test(descriptor)) return { kind: "shortlog", text };
  if (/\bgit\s+reflog\b/.test(descriptor)) return { kind: "reflog", text };

  if (/\bgit\s+diff\b/.test(descriptor)) {
    const boundedDiff = /(?:^|\s)--(?:stat|shortstat|numstat|name-only|name-status|summary)\b/.test(descriptor);
    if (!boundedDiff) return { kind: "diff", text };
  }

  return null;
}

function compressImmediateGitText(text, logId, opts) {
  const headChars = opts?.tier2HeadChars ?? TIER_2_HEAD_CHARS;
  const tailChars = opts?.tier2TailChars ?? TIER_2_TAIL_CHARS;
  if (typeof text !== "string" || text.length <= headChars + tailChars + 200) {
    return text;
  }

  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  const omitted = text.length - headChars - (tailChars > 0 ? tailChars : 0);
  const lineCount = text.length === 0 ? 0 : text.split("\n").length;
  const note = `\n\n[…git capped: ${lineCount} lines, ${omitted} chars hidden. Full: bosun --tool-log ${logId}]\n\n`;
  return head + note + tail;
}

function applyImmediateGitCompression(item, logId, opts) {
  const compressed = { ...item, _cachedLogId: logId, _compressed: "git_tier2" };
  setItemText(compressed, compressImmediateGitText(getItemText(item), logId, opts));
  return compressed;
}

// ---------------------------------------------------------------------------
// Tiered Compression
// ---------------------------------------------------------------------------

/**
 * Light compression (Tier 1): keep head + tail of output.
 * ~20% reduction for typical outputs.
 */
function compressTier1(text, logId, opts) {
  const headChars = opts?.tier1HeadChars ?? TIER_1_HEAD_CHARS;
  const tailChars = opts?.tier1TailChars ?? TIER_1_TAIL_CHARS;
  if (typeof text !== "string" || text.length <= headChars + tailChars + 200) {
    return text; // small enough already
  }
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  const omitted = text.length - headChars - (tailChars > 0 ? tailChars : 0);
  return (
    head +
    `\n\n[…${omitted} chars compressed — full output: bosun --tool-log ${logId}]\n\n` +
    tail
  );
}

/**
 * Moderate compression (Tier 2): smaller head + tail.
 * ~60% reduction for typical outputs.
 */
function compressTier2(text, logId, opts) {
  const headChars = opts?.tier2HeadChars ?? TIER_2_HEAD_CHARS;
  const tailChars = opts?.tier2TailChars ?? TIER_2_TAIL_CHARS;
  if (typeof text !== "string" || text.length <= headChars + tailChars + 200) {
    return text;
  }
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  const omitted = text.length - headChars - (tailChars > 0 ? tailChars : 0);
  return (
    head +
    `\n\n[…${omitted} chars compressed — full output: bosun --tool-log ${logId}]\n\n` +
    tail
  );
}

/**
 * Maximum compression (Tier 3): skeleton only.
 * Just tool name, args preview, output size, and retrieval command.
 */
function compressTier3(item, logId) {
  const toolName = extractToolName(item);
  const argsPreview = extractArgsPreview(item);
  const text = getItemText(item);
  const size = charLabel(text);
  return `[Cached tool call] ${toolName}(${argsPreview}) → ${size} | Retrieve: bosun --tool-log ${logId}`;
}

/**
 * Apply compression to an item at the appropriate tier, replacing text content.
 *
 * @param {object} item      The original item
 * @param {number} logId     The cache log ID
 * @param {number} tier      Compression tier (1, 2, or 3)
 * @returns {object}         New item with compressed text
 */
function applyCompression(item, logId, tier, opts) {
  if (!item || typeof item !== "object") return item;

  if (tier === 3) {
    // Skeleton — replace the entire item with a minimal summary
    return {
      type: item.type || "context_compressed",
      _cachedLogId: logId,
      text: compressTier3(item, logId),
    };
  }

  const compressor = tier === 1
    ? (text, id) => compressTier1(text, id, opts)
    : (text, id) => compressTier2(text, id, opts);
  const next = { ...item };
  next._cachedLogId = logId;

  // Compress all text-bearing fields
  const textKeys = ["text", "output", "aggregated_output", "result", "message"];
  for (const key of textKeys) {
    if (typeof next[key] === "string" && next[key].length > 200) {
      next[key] = compressor(next[key], logId);
    }
  }

  if (Array.isArray(next.content)) {
    next.content = next.content.map((entry) => {
      if (entry && typeof entry === "object" && typeof entry.text === "string" && entry.text.length > 200) {
        return { ...entry, text: compressor(entry.text, logId) };
      }
      return entry;
    });
  }

  return next;
}

// ---------------------------------------------------------------------------
// Assign Turns to Items
// ---------------------------------------------------------------------------

/**
 * Determine the "turn" of an item based on its position in the items array.
 * Items generated by tool calls that produce output are grouped into turns.
 *
 * We use a simple heuristic: each "tool_call" / "function_call" or
 * "item.completed" with tool output increments the turn counter.
 *
 * @param {Array} items  The full items array
 * @returns {Array<{ item: object, turn: number, index: number }>}
 */
function assignTurns(items) {
  let currentTurn = 0;
  const result = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      result.push({ item, turn: currentTurn });
      continue;
    }

    // Detect turn boundaries: tool outputs, agent messages
    const isToolOutput =
      item.type === "function_call_output" ||
      item.type === "tool_result" ||
      item.type === "tool_output" ||
      item.type === "command_output" ||
      (item.type === "item.completed" && item.item?.type !== "agent_message");

    if (isToolOutput) {
      currentTurn++;
    }

    result.push({ item, turn: currentTurn });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers — extracted for readability
// ---------------------------------------------------------------------------

/**
 * Determine compression tier from item age.
 * @param {number} age  currentTurn - itemTurn
 * @returns {1|2|3}
 */
function resolveTier(age, opts) {
  const t1 = opts?.tier1MaxAge ?? TIER_1_MAX_AGE;
  const t2 = opts?.tier2MaxAge ?? TIER_2_MAX_AGE;
  if (age <= t1) return 1;
  if (age <= t2) return 2;
  return 3;
}

/**
 * Decide whether an item is a candidate for compression (has enough text).
 * @param {object} item
 * @returns {boolean}
 */
function isCompressCandidate(item) {
  const text = getItemText(item);
  return Boolean(text && text.length >= 200);
}

// ===========================================================================
// CONTENT-AWARE RELEVANCE SCORING
// ===========================================================================
//
// Age-based compression is necessary but insufficient.  A 3-line file read
// from 8 turns ago might be the critical method definition the agent is
// currently modifying, while a 400-result grep search from 2 turns ago is
// 99% noise.
//
// This system scores each tool output's "value density" on a 0-100 scale,
// then uses that score to shift the compression tier:
//
//   High score (70-100) → protect: shift tier down by 2 (delay compression)
//   Normal     (30-69)  → default: use age-based tier as-is
//   Low score  (0-29)   → accelerate: shift tier up by 1 (compress sooner)
//
// Additionally, RETROSPECTIVE RELEVANCE scans subsequent items to detect
// which parts of a large output the agent actually used (by matching file
// paths, symbol names, etc.).
//
// Everything is deterministic — zero API cost, zero latency.
// ---------------------------------------------------------------------------

// ── Score thresholds ──────────────────────────────────────────────────────
// These module-scope constants are the defaults; opts can override them.
const SCORE_HIGH_DEFAULT = 70;   // protect from compression
const SCORE_LOW_DEFAULT = 30;    // accelerate compression
/** @deprecated use SCORE_HIGH_DEFAULT; kept for backward-compat references */
const SCORE_HIGH = SCORE_HIGH_DEFAULT;
/** @deprecated use SCORE_LOW_DEFAULT; kept for backward-compat references */
const SCORE_LOW = SCORE_LOW_DEFAULT;
const TIER_SHIFT_PROTECT = -2;
const TIER_SHIFT_ACCELERATE = 1;

// ── Tool type scoring profiles ────────────────────────────────────────────
// Maps tool types / names to baseline value density.
// Specific reads are high-value; broad searches are low-value.
const TOOL_SCORE_PROFILES = {
  // High-value: targeted, specific reads
  read_file:                85,
  readFile:                 85,
  file_read:                85,

  // High-value: the agent is actively changing code
  replace_string_in_file:   90,
  create_file:              90,
  edit_file:                90,
  file_change:              85,

  // Medium-value: errors/diagnostics the agent might need
  get_errors:               75,
  command_execution:        50,  // varies — adjusted by exit code & output size
  run_in_terminal:          50,

  // Low-value: broad discovery — most results are noise
  grep_search:              30,
  semantic_search:          25,
  file_search:              20,
  search_subagent:          25,
  web_search:               20,
  list_dir:                 35,
  list_directory:           35,

  // Medium: MCP tools (vary widely, default to medium)
  mcp_tool_call:            45,
};

/**
 * Score a tool output item's inherent value density (0-100).
 *
 * Uses multiple signals:
 *   1. Tool type (baseline from TOOL_SCORE_PROFILES)
 *   2. Output size (small = higher density, large = lower density)
 *   3. Specificity signals (line ranges, single file vs. many matches)
 *   4. Error/success status
 *
 * @param {object} item  The tool output item
 * @returns {number}     Score 0-100
 */
export function scoreToolOutput(item) {
  if (!item || typeof item !== "object") return 50;

  const toolName = extractToolName(item);
  const text = getItemText(item);
  const textLen = text?.length || 0;

  // 1. Baseline from tool type
  let score = resolveBaseScore(toolName);

  // 2. Size adjustment — small outputs are denser
  score += scoreSizeAdjustment(textLen);

  // 3. Specificity signals
  score += scoreSpecificityAdjustment(item, toolName, textLen);

  // 4. Error/success signal
  score += scoreErrorAdjustment(item);

  // Clamp to 0-100
  return Math.max(0, Math.min(100, score));
}

/**
 * Resolve a baseline score from tool name, with fuzzy matching.
 * @param {string} toolName
 * @returns {number}
 */
function resolveBaseScore(toolName) {
  if (!toolName) return 50;
  const lower = toolName.toLowerCase();

  // Direct match
  if (TOOL_SCORE_PROFILES[toolName] !== undefined) {
    return TOOL_SCORE_PROFILES[toolName];
  }

  // Fuzzy match: check if any profile key is contained in the tool name
  for (const [key, val] of Object.entries(TOOL_SCORE_PROFILES)) {
    if (lower.includes(key.toLowerCase())) return val;
  }

  // Check for common patterns
  if (lower.includes("read") || lower.includes("get_file")) return 80;
  if (lower.includes("search") || lower.includes("find")) return 25;
  if (lower.includes("edit") || lower.includes("write") || lower.includes("replace")) return 85;
  if (lower.includes("list") || lower.includes("dir")) return 35;
  if (lower.includes("run") || lower.includes("exec") || lower.includes("terminal")) return 50;

  return 50; // unknown tool — neutral
}

/**
 * Adjust score based on output size.
 * Small outputs (< 500 chars) are almost always high-value.
 * Very large outputs (> 10K) are almost always search dumps.
 *
 * @param {number} textLen
 * @returns {number}  Adjustment (-20 to +20)
 */
function scoreSizeAdjustment(textLen) {
  if (textLen < 200)   return 20;   // tiny → almost certainly targeted
  if (textLen < 500)   return 15;   // small → probably a specific read
  if (textLen < 2000)  return 5;    // medium → neutral
  if (textLen < 5000)  return 0;    // normal
  if (textLen < 10000) return -5;   // large → getting noisy
  if (textLen < 20000) return -10;  // very large → likely search dump
  return -20;                        // huge → almost certainly bulk results
}

/**
 * Adjust score based on specificity signals in the item.
 *
 * @param {object} item
 * @param {string} toolName
 * @param {number} textLen
 * @returns {number}  Adjustment (-15 to +15)
 */
function scoreSpecificityAdjustment(item, toolName, textLen) {
  let adj = 0;
  const args = item.arguments || item.args || item.call?.arguments || {};
  const argsObj = typeof args === "string" ? safeParse(args) : args;

  // File reads with narrow line ranges are highly specific
  if (argsObj.startLine && argsObj.endLine) {
    const range = Number(argsObj.endLine) - Number(argsObj.startLine);
    if (range <= 30) adj += 15;       // reading ≤30 lines = very targeted
    else if (range <= 100) adj += 5;  // reading ≤100 lines = moderately targeted
    else adj -= 5;                     // reading 200+ lines = broad
  }

  // Single file path = more specific than no path
  if (argsObj.filePath || argsObj.file || argsObj.path) {
    adj += 5;
  }

  // Search results: count match lines as a noise indicator
  const lower = toolName.toLowerCase();
  if (lower.includes("search") || lower.includes("grep") || lower.includes("find")) {
    const matchCount = countSearchMatches(item);
    if (matchCount > 50) adj -= 15;       // 50+ matches = very noisy
    else if (matchCount > 20) adj -= 10;  // 20+ = noisy
    else if (matchCount > 5) adj -= 5;    // 5+ = moderate
    else if (matchCount <= 3) adj += 5;   // ≤3 = highly specific
  }

  return adj;
}

/**
 * Adjust score based on error/success signals.
 *
 * @param {object} item
 * @returns {number}  Adjustment (-10 to +10)
 */
function scoreErrorAdjustment(item) {
  // Command execution with non-zero exit → errors are valuable for debugging
  if (item.exit_code !== undefined) {
    if (item.exit_code !== 0) return 10;  // error output is important
    // Successful commands with tiny output → just need to know it worked
    const text = getItemText(item);
    if (text && text.length < 100) return 5; // compact success
  }

  // Items with error fields are diagnostic — preserve longer
  if (item.error) return 10;

  return 0;
}

/**
 * Count the number of search match lines in a tool output.
 * Heuristic: count lines matching common search result patterns.
 *
 * @param {object} item
 * @returns {number}
 */
function countSearchMatches(item) {
  const text = getItemText(item);
  if (!text) return 0;

  // Count lines that look like search results:
  //   - "path/file.ts:123: matched text"  (grep format)
  //   - "<match path="..." line=N>"       (XML match format)
  //   - "  src/foo.ts"                    (file search format)
  let count = 0;
  const lines = text.split("\n");
  for (const line of lines) {
    if (
      /^\s*\S+\.\w+:\d+/.test(line) ||          // grep: file.ts:123
      /<match\s+path=/.test(line) ||             // XML match
      /^\d+\s+match/.test(line) ||               // "N matches"
      /^\s+\S+\.\w+\s*$/.test(line)              // bare file path
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Safely parse JSON, returning empty object on failure.
 * @param {string} str
 * @returns {object}
 */
function safeParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Retrospective Relevance
// ---------------------------------------------------------------------------
//
// After scoring each item individually, scan SUBSEQUENT items to detect
// which earlier tool outputs the agent actually acted on.
//
// Signals:
//   - Agent reads file X → any earlier search mentioning file X is relevant
//   - Agent edits file X at line Y → any earlier read of X around line Y
//     is highly relevant
//   - Agent references a symbol name → outputs containing that symbol
//     are relevant
//
// Items identified as "retrospectively relevant" get their score boosted.
// ---------------------------------------------------------------------------

/**
 * Try to extract a path value from an argument key.
 * @returns {string|null}  normalised path or null
 */
function extractPathFromArg(argsObj, key) {
  const val = argsObj[key];
  if (typeof val !== "string" || val.length <= 2 || val.length >= 300) return null;
  if (/[/\\]/.test(val) || /\.\w{1,6}$/.test(val)) {
    return normalizePathForMatching(val);
  }
  return null;
}

/**
 * Extract file paths and line numbers from an item's arguments.
 *
 * @param {object} item
 * @returns {{ paths: string[], lines: number[] }}
 */
function extractItemTargets(item) {
  if (!item || typeof item !== "object") return { paths: [], lines: [] };

  const args = item.arguments || item.args || item.call?.arguments || {};
  const argsObj = typeof args === "string" ? safeParse(args) : args;

  const paths = [];
  const lines = [];

  // Collect file paths from various fields
  for (const key of ["filePath", "file", "path", "includePattern", "query"]) {
    const p = extractPathFromArg(argsObj, key);
    if (p) paths.push(p);
  }

  // Collect line numbers
  for (const key of ["startLine", "endLine", "line"]) {
    const val = Number(argsObj[key]);
    if (Number.isFinite(val) && val > 0) lines.push(val);
  }

  // Also extract paths from file_change items
  if (Array.isArray(item.changes)) {
    for (const ch of item.changes) {
      if (ch?.path) paths.push(normalizePathForMatching(ch.path));
    }
  }

  return { paths, lines };
}

/**
 * Normalize a file path for fuzzy matching: lowercase, forward slashes,
 * strip leading ./ or absolute prefix.
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePathForMatching(p) {
  return p
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .toLowerCase();
}

/**
 * Build a retrospective relevance map for a sequence of turn-tagged items.
 *
 * Scans items from newest to oldest. For each item that acts on a file path
 * (read, edit, terminal command referencing a path), marks any OLDER item
 * that mentions that path in its output as "retrospectively relevant."
 *
 * @param {Array<{item: object, turn: number}>} turnItems
 * @returns {Map<object, number>}  item → bonus score (0-30)
 */
function buildRetrospectiveRelevanceMap(turnItems) {
  const bonusMap = new Map();

  // Phase 1: Collect all "action paths" — files the agent explicitly targeted
  //          in reads, edits, or commands.
  const actionPaths = new Set();
  for (const { item } of turnItems) {
    const { paths } = extractItemTargets(item);
    for (const p of paths) actionPaths.add(p);
  }

  if (actionPaths.size === 0) return bonusMap;

  // Phase 2: For each older item, check if its OUTPUT mentions any action path.
  //          If yes, that item's output contained something the agent later used.
  for (const { item } of turnItems) {
    const text = getItemText(item);
    if (!text || text.length < 50) continue;

    const textLower = text.toLowerCase().replaceAll("\\", "/");
    let matchCount = 0;

    for (const actionPath of actionPaths) {
      // Use just the filename or last 2 segments for matching
      // to avoid false negatives from different absolute path prefixes
      const segments = actionPath.split("/");
      const shortPath = segments.slice(-2).join("/");
      if (shortPath.length >= 4 && textLower.includes(shortPath)) {
        matchCount++;
      }
    }

    if (matchCount > 0) {
      // Bonus proportional to how many action paths this output mentions
      // Cap at 30 to avoid over-protecting search results that mention
      // half the codebase
      const bonus = Math.min(30, matchCount * 10);
      bonusMap.set(item, bonus);
    }
  }

  return bonusMap;
}

/**
 * Apply score-based tier adjustment.
 *
 * High scores protect items from compression (shift tier down).
 * Low scores accelerate compression (shift tier up).
 *
 * @param {number} baseTier  The age-based tier (1, 2, or 3)
 * @param {number} score     The content-aware score (0-100)
 * @returns {number}         Adjusted tier (0, 1, 2, or 3)
 */
function adjustTierByScore(baseTier, score, opts) {
  const high = opts?.scoreHighThreshold ?? SCORE_HIGH_DEFAULT;
  const low  = opts?.scoreLowThreshold  ?? SCORE_LOW_DEFAULT;
  if (score >= high) {
    // Protect: shift tier down (less compression)
    return Math.max(0, baseTier + TIER_SHIFT_PROTECT);
  }
  if (score < low) {
    // Accelerate: shift tier up (more compression)
    return Math.min(3, baseTier + TIER_SHIFT_ACCELERATE);
  }
  return baseTier; // Normal: use age-based tier as-is
}

// ---------------------------------------------------------------------------
// Smart Search Result Compression
// ---------------------------------------------------------------------------
//
// For large search outputs (grep_search with 50+ results), instead of
// just head/tail truncation, extract only the results that the agent
// actually used (by matching against subsequent file reads/edits).
// ---------------------------------------------------------------------------

/**
 * Smart-compress a large search result by keeping only relevant matches.
 *
 * @param {string}    text         The full search output
 * @param {Set<string>} actionPaths  Paths the agent later acted on
 * @param {number}    logId        Cache log ID for retrieval command
 * @returns {string}               Compressed output with relevant matches preserved
 */
function smartCompressSearchResult(text, actionPaths, logId) {
  if (!text || actionPaths.size === 0) return null; // fall back to standard compression

  const lines = text.split("\n");
  const keptLines = [];
  let droppedCount = 0;

  for (const line of lines) {
    const lineLower = line.toLowerCase().replaceAll("\\", "/");
    let isRelevant = false;

    // Keep lines that mention any action path
    for (const actionPath of actionPaths) {
      const segments = actionPath.split("/");
      const shortPath = segments.slice(-2).join("/");
      if (shortPath.length >= 4 && lineLower.includes(shortPath)) {
        isRelevant = true;
        break;
      }
    }

    // Also keep header/summary lines (first 2, last 1)
    if (keptLines.length < 2 || lines.indexOf(line) >= lines.length - 1) {
      isRelevant = true;
    }

    if (isRelevant) {
      keptLines.push(line);
    } else {
      droppedCount++;
    }
  }

  // Only use smart compression if we actually filtered something significant
  if (droppedCount < 5) return null; // not worth it — fall back to standard

  const compressed = keptLines.join("\n");
  return (
    compressed +
    `\n\n[…${droppedCount} irrelevant search results filtered — full output: bosun --tool-log ${logId}]`
  );
}

// ---------------------------------------------------------------------------
// Main Entry Point (Content-Aware)
// ---------------------------------------------------------------------------

/**
 * Cache old tool outputs to disk and apply tiered compression.
 *
 * This is the main API. Call it with the accumulated items array and the
 * system returns a new array with old items compressed and cache-backed.
 *
 * Items that are NOT tool outputs (agent messages, stream notices) are
 * passed through untouched.
 *
 * @param {Array}  items       The full accumulated items array
 * @param {object} [options]   Optional overrides
 * @param {number} [options.fullContextTurns=3]  Turns to keep in full
 * @returns {Promise<Array>}   New items array with compression applied
 */
export async function cacheAndCompressItems(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return items;

  // If shredding is explicitly disabled, pass through unchanged
  if (options._skip === true) return items;

  const opts = resolveOpts(options);

  // Skip tool output compression if disabled
  if (!opts.compressToolOutputs) {
    return items;
  }

  const turnItems = assignTurns(items);
  const maxTurn = turnItems.reduce((m, t) => Math.max(m, t.turn), 0);

  // ── Content-aware scoring pass ──────────────────────────────────────────
  // Phase 1: Score every item's inherent value density
  const scores = new Map();
  for (const { item } of turnItems) {
    scores.set(item, scoreToolOutput(item));
  }

  // Phase 2: Retrospective relevance — boost items whose output the agent
  //          later acted on (read/edited a file mentioned in search results)
  const retroBonus = buildRetrospectiveRelevanceMap(turnItems);
  for (const [item, bonus] of retroBonus) {
    const current = scores.get(item) || 50;
    scores.set(item, Math.min(100, current + bonus));
  }

  // Collect all action paths for smart search compression
  const actionPaths = new Set();
  for (const { item } of turnItems) {
    const { paths } = extractItemTargets(item);
    for (const p of paths) actionPaths.add(p);
  }

  const result = [];
  const cachePromises = [];

  for (const { item, turn } of turnItems) {
    const age = maxTurn - turn;
    processCompressItem(
      item, age, scores, actionPaths, result, cachePromises, opts,
    );
  }

  // Await all cache writes in parallel
  if (cachePromises.length > 0) {
    await Promise.all(cachePromises);
  }

  return result;
}

/**
 * Process a single item for the compression pipeline (extracted to keep
 * `cacheAndCompressItems` under cognitive-complexity limit).
 * @param {object} item
 * @param {number} age
 * @param {Map} scores
 * @param {Set} actionPaths
 * @param {Array} result     Mutated — items are pushed here
 * @param {Array} cachePromises  Mutated — cache promises pushed here
 */
function processCompressItem(item, age, scores, actionPaths, result, cachePromises, opts) {
  const immediateGitOutput = classifyImmediateGitOutput(item, opts);
  if (immediateGitOutput && !item._cachedLogId) {
    const toolName = extractToolName(item);
    const argsPreview = extractArgsPreview(item);
    const cacheIdx = result.length;
    result.push(item);
    cachePromises.push(
      writeToCache(item, toolName, argsPreview).then((logId) => {
        result[cacheIdx] = applyImmediateGitCompression(item, logId, opts);
      }),
    );
    return;
  }

  // Tier 0: keep full
  const tier0Limit = opts?.tier0MaxAge ?? TIER_0_MAX_AGE;
  if (age <= tier0Limit) { result.push(item); return; }

  // Skip items that have no meaningful text to compress
  if (!isCompressCandidate(item)) { result.push(item); return; }

  // Content-aware tier resolution
  const itemScore = scores.get(item) ?? 50;
  const baseTier = resolveTier(age, opts);
  const tier = adjustTierByScore(baseTier, itemScore, opts);

  // Tier 0 after score adjustment: item is valuable enough to protect
  if (tier === 0) { result.push(item); return; }

  // Already compressed? Re-apply at potentially more aggressive tier
  if (item._cachedLogId) {
    result.push(applyCompression(item, item._cachedLogId, tier, opts));
    return;
  }

  // Cache the original, then compress
  const toolName = extractToolName(item);
  const argsPreview = extractArgsPreview(item);
  const cacheIdx = result.length;
  result.push(item); // placeholder — will be replaced

  cachePromises.push(
    writeToCache(item, toolName, argsPreview).then((logId) => {
      const smartResult = trySmartSearchCompress(item, toolName, itemScore, actionPaths, logId, opts);
      result[cacheIdx] = smartResult || applyCompression(item, logId, tier, opts);
    }),
  );
}

/**
 * Attempt smart search result compression for low-score search outputs.
 * Returns null if smart compression is not applicable.
 */
function trySmartSearchCompress(item, toolName, itemScore, actionPaths, logId, opts) {
  const scoreLow = opts?.scoreLowThreshold ?? SCORE_LOW_DEFAULT;
  if (itemScore >= scoreLow || actionPaths.size === 0) return null;
  const lower = (toolName || "").toLowerCase();
  const isSearch =
    lower.includes("search") || lower.includes("grep") || lower.includes("find");
  if (!isSearch) return null;

  const text = getItemText(item);
  const smartText = smartCompressSearchResult(text, actionPaths, logId);
  if (!smartText) return null;

  const compressed = { ...item, _cachedLogId: logId };
  setItemText(compressed, smartText);
  return compressed;
}

// ===========================================================================
// MESSAGE COMPRESSION — Agent & User Text
// ===========================================================================
//
// Tool outputs are already handled above.  This section compresses the
// *other* two categories that bloat long-running sessions:
//
//   1. Agent "thinking" messages — verbose planning, narration, step lists.
//      Example:  "Now let me implement the integration.  I need to:\n
//        1. Import cacheAndCompressItems…\n  2. Apply compression…"
//      Compressed:  "Implement context-cache integration across 5 files"
//
//   2. User request messages — the original prompt.  Critical for the
//      current turn, but nearly zero value once the task is complete.
//      Compressed:  "[User request: implement tiered context compression]"
//
//   3. Pinned content — instructions, AGENTS.md rules, system directives.
//      These are NEVER compressed, regardless of age.
//
// All compression is deterministic (zero API cost, zero latency).
// ---------------------------------------------------------------------------

// ── Instruction-pinning keywords ──────────────────────────────────────────
// If an item's text contains ANY of these markers (case-insensitive),
// it is classified as "pinned" and exempt from compression.
const PINNED_KEYWORDS = [
  "AGENTS.md",
  "CRITICAL",
  "MUST NOT",
  "MUST NEVER",
  "NEVER use",
  "ALWAYS use",
  "MANDATORY",
  "HARD RULE",
  "## Instructions",
  "## Rules",
  "# AGENT DIRECTIVE",
  "Pre-commit",
  "Pre-push",
  "Commit Conventions",
  "conventional commits",
  "--no-verify",
  "permanently banned",
  "Module-scope caching",
  "Async safety",
  "Error boundaries",
  "Test quality",
  "No architectural shortcuts",
  "_pinned",
];

/** Pre-compiled regex for pinned detection (case-insensitive) */
const PINNED_RE = new RegExp(
  PINNED_KEYWORDS.map((k) => k.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)).join("|"),
  "i",
);

// ── Agent message compression parameters ──────────────────────────────────
// Age thresholds for agent messages (turns since the message was produced)
const MSG_TIER_0_MAX_AGE = 1;   // current + previous turn: full text
const MSG_TIER_1_MAX_AGE = 4;   // turns 2-4: moderate compression
                                 // turns 5+:  breadcrumb only

// Minimum text length to bother compressing
const MSG_MIN_COMPRESS_CHARS = 120;

// ── User message compression parameters ──────────────────────────────────
const USER_MSG_FULL_TURNS = 1;  // only the CURRENT turn keeps the full user prompt
const USER_MSG_BREADCRUMB_MAX = 100; // max chars for the breadcrumb summary

// ---------------------------------------------------------------------------
// Pinning Detection
// ---------------------------------------------------------------------------

/**
 * Check if an item contains instruction/rule content that must be preserved.
 *
 * Detects:
 *   - Explicit `_pinned: true` flag
 *   - AGENTS.md content / repo rules
 *   - System directives (CRITICAL, MUST, NEVER, etc.)
 *   - Commit conventions, pre-push rules, etc.
 *
 * @param {object} item
 * @returns {boolean}
 */
export function isItemPinned(item) {
  if (!item || typeof item !== "object") return false;

  // Explicit pin flag
  if (item._pinned === true) return true;

  // Check text content
  const text = getItemText(item);
  if (!text) return false;

  return PINNED_RE.test(text);
}

// ---------------------------------------------------------------------------
// Deterministic Agent Message Summarization
// ---------------------------------------------------------------------------

/**
 * Extract a short action summary from verbose agent "thinking" text.
 *
 * Strategy (deterministic, no LLM):
 *   1. Strip markdown formatting / numbered lists
 *   2. Extract the first sentence (usually states the intent)
 *   3. Truncate to ~80 chars, keeping whole words
 *
 * @param {string} text  The agent message text
 * @returns {string}     Short summary (≤80 chars)
 */
function summarizeAgentMessage(text) {
  if (!text || typeof text !== "string") return "";

  // Strip markdown fences, bullet/number lists, extra whitespace
  let clean = text
    .replaceAll(/```[\s\S]*?```/g, "[code block]")                // code fences
    .replaceAll(/^\s*[-*•]\s+/gm, "")                              // bullet lists
    .replaceAll(/^\s*\d+[.)]\s+/gm, "")                            // numbered lists
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")                    // markdown links
    .replaceAll(/#{1,6}\s+/g, "")                                  // headings
    .replaceAll(/[`*_~]+/g, "")                                    // inline formatting
    .replaceAll(/\n{2,}/g, ". ")                                   // paragraph breaks → period
    .replaceAll("\n", " ")                                           // newlines → space
    .replaceAll(/\s{2,}/g, " ")                                    // collapse whitespace
    .trim();

  // Take only the first "sentence" (up to first period, colon, or dash boundary)
  const sentenceEnd = clean.search(/[.!?]\s|:\s*\n|—\s/);
  if (sentenceEnd > 10 && sentenceEnd < 100) {
    clean = clean.slice(0, sentenceEnd + 1).trim();
  }

  // Truncate to ~80 chars at a word boundary
  if (clean.length > 80) {
    const cut = clean.lastIndexOf(" ", 78);
    clean = clean.slice(0, cut > 20 ? cut : 78) + "…";
  }

  return clean || text.slice(0, 60).trim() + "…";
}

/**
 * Extract the core intent from a user prompt.
 *
 * Takes the first meaningful sentence and strips formatting.
 * Result is wrapped in [User request: …] brackets.
 *
 * @param {string} text  The user's prompt text
 * @returns {string}     Bracketed summary
 */
function summarizeUserMessage(text) {
  if (!text || typeof text !== "string") return "[User request]";

  // Strip the TOOL_OUTPUT_GUARDRAIL suffix if present
  const guardrailIdx = text.indexOf("[Tool Output Guardrail]");
  const rawText = guardrailIdx > 0 ? text.slice(0, guardrailIdx).trim() : text;

  // Remove code blocks and markdown
  let clean = rawText
    .replaceAll(/```[\s\S]*?```/g, "")
    .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/#{1,6}\s+/g, "")
    .replaceAll(/[`*_~]+/g, "")
    .replaceAll(/\n{2,}/g, ". ")
    .replaceAll("\n", " ")
    .replaceAll(/\s{2,}/g, " ")
    .trim();

  // If there's a system prompt prepended, skip to the user's actual content
  const directiveIdx = clean.indexOf("---");
  if (directiveIdx > 0 && directiveIdx < clean.length - 10) {
    clean = clean.slice(directiveIdx + 3).trim();
  }

  // Take the core intent — first substantial sentence
  const firstPeriod = clean.search(/[.!?]\s/);
  if (firstPeriod > 5 && firstPeriod < USER_MSG_BREADCRUMB_MAX) {
    clean = clean.slice(0, firstPeriod + 1);
  } else if (clean.length > USER_MSG_BREADCRUMB_MAX) {
    const cut = clean.lastIndexOf(" ", USER_MSG_BREADCRUMB_MAX - 3);
    clean = clean.slice(0, cut > 20 ? cut : USER_MSG_BREADCRUMB_MAX - 3) + "…";
  }

  return `[User request: ${clean}]`;
}

// ---------------------------------------------------------------------------
// Message Classification
// ---------------------------------------------------------------------------

/**
 * Classify an item for message compression purposes.
 *
 * @param {object} item
 * @returns {"pinned"|"agent_msg"|"user_msg"|"tool_output"|"other"}
 */
function classifyItem(item) {
  if (!item || typeof item !== "object") return "other";

  // Check pinned first — takes priority over everything
  if (isItemPinned(item)) return "pinned";

  // Agent thinking/response messages
  if (
    item.type === "agent_message" ||
    item.type === "assistant" ||
    item.role === "assistant"
  ) {
    return "agent_msg";
  }

  // User messages / prompts
  if (item.role === "user" || item.type === "user_message") {
    return "user_msg";
  }

  // Tool outputs (handled by the tool compression system)
  if (
    item.type === "function_call_output" ||
    item.type === "tool_result" ||
    item.type === "tool_output" ||
    item.type === "command_output"
  ) {
    return "tool_output";
  }

  return "other";
}

// ---------------------------------------------------------------------------
// Unified Compression Entry Point
// ---------------------------------------------------------------------------

/**
 * Compress ALL item types: tool outputs (existing), agent messages (new),
 * and user messages (new).  Pinned items are never touched.
 *
 * This wraps `cacheAndCompressItems` (tool output compression) and adds
 * agent + user message compression on top.
 *
 * Context-usage-aware behaviour:
 *   When `options.contextUsagePct` is provided (0.0–1.0), shredding only
 *   activates if usage >= `contextUsageThreshold` (default 0.50).
 *   Aggression scales linearly from the threshold to the critical level
 *   (default 0.70).  Above the critical level, tier boundaries are halved
 *   — meaning items are compressed much earlier.
 *
 * @param {Array}  items       The full accumulated items array
 * @param {object} [options]   Optional overrides
 * @param {number} [options.fullContextTurns=3]  Turns to keep tool outputs full
 * @param {number} [options.contextUsagePct]     Estimated context fill (0.0–1.0)
 * @returns {Promise<Array>}   Compressed items array
 */
export async function compressAllItems(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return items;

  // If shredding is explicitly disabled, pass through unchanged
  if (options._skip === true) return items;

  const opts = resolveOpts(options);

  // ── Context-usage-based gating ──────────────────────────────
  const usagePct = typeof options.contextUsagePct === "number"
    ? options.contextUsagePct
    : null;
  const threshold = opts.contextUsageThreshold ?? 0.50;
  const target    = opts.contextUsageTarget    ?? 0.40;
  const critical  = opts.contextUsageCritical  ?? 0.70;

  // When context usage info is available and below threshold, skip shredding
  if (usagePct !== null && usagePct < threshold) {
    return items;
  }

  // ── Progressive aggression ──────────────────────────────────
  // When usage info is available, tighten tier boundaries proportionally.
  // aggression ranges from 0.0 (at threshold) to 1.0 (at critical).
  // At 1.0+, all tier boundaries are halved — items age out 2× faster.
  if (usagePct !== null && usagePct >= threshold) {
    const range = Math.max(critical - threshold, 0.01);
    const aggression = Math.min((usagePct - threshold) / range, 1.5);
    // Scale tier boundaries down — more aggression means earlier compression
    // At aggression 0.0: original values (1× multiplier)
    // At aggression 1.0: halved (0.5× multiplier)
    // At aggression 1.5: quartered (0.25× multiplier) — emergency mode
    const scaleFactor = Math.max(1 - aggression * 0.5, 0.25);
    opts.fullContextTurns = Math.max(1, Math.round(opts.fullContextTurns * scaleFactor));
    opts.tier1MaxAge      = Math.max(2, Math.round(opts.tier1MaxAge * scaleFactor));
    opts.tier2MaxAge      = Math.max(3, Math.round(opts.tier2MaxAge * scaleFactor));
    opts.msgTier0MaxAge   = Math.max(0, Math.round(opts.msgTier0MaxAge * scaleFactor));
    opts.msgTier1MaxAge   = Math.max(1, Math.round(opts.msgTier1MaxAge * scaleFactor));

    // Also shrink the char limits for heavy compression at high aggression
    if (aggression >= 0.8) {
      const charScale = Math.max(1 - (aggression - 0.8) * 1.5, 0.3);
      opts.tier1HeadChars = Math.round(opts.tier1HeadChars * charScale);
      opts.tier1TailChars = Math.round(opts.tier1TailChars * charScale);
      opts.tier2HeadChars = Math.round(opts.tier2HeadChars * charScale);
      opts.tier2TailChars = Math.round(opts.tier2TailChars * charScale);
    }
  }

  // Step 1: Apply tool output compression (existing system)
  let result = await cacheAndCompressItems(items, opts);

  // Step 2: Apply message compression to agent + user messages
  // Skip entirely if message compression is turned off
  if (!opts.compressMessages) return result;

  const turnItems = assignTurns(result);
  const maxTurn = turnItems.reduce((m, t) => Math.max(m, t.turn), 0);

  // Not enough turns to need message compression yet
  if (maxTurn < 2) return result;

  result = turnItems.map(({ item, turn }) => {
    const age = maxTurn - turn;
    const kind = classifyItem(item);

    // Pinned: never compress
    if (kind === "pinned") return item;

    // Tool outputs: already compressed by cacheAndCompressItems
    if (kind === "tool_output") return item;

    // Other/unknown: pass through
    if (kind === "other") return item;

    // Agent messages: tiered compression based on age
    if (kind === "agent_msg") {
      if (!opts.compressAgentMessages) return item;
      return compressAgentMessage(item, age, opts);
    }

    // User messages: compress after the current turn
    if (kind === "user_msg") {
      if (!opts.compressUserMessages) return item;
      return compressUserMessage(item, age, opts);
    }

    return item;
  });

  return result;
}

/**
 * Apply tiered compression to an agent message item.
 *
 * @param {object} item  The agent_message item
 * @param {number} age   Turns since this message
 * @returns {object}     Possibly compressed item
 */
function compressAgentMessage(item, age, opts) {
  const minChars = opts?.msgMinCompressChars ?? MSG_MIN_COMPRESS_CHARS;
  const tier0Age  = opts?.msgTier0MaxAge     ?? MSG_TIER_0_MAX_AGE;
  const tier1Age  = opts?.msgTier1MaxAge     ?? MSG_TIER_1_MAX_AGE;

  const text = getItemText(item);
  if (!text || text.length < minChars) return item;

  // Tier 0: full text (current + previous turn)
  if (age <= tier0Age) return item;

  // Tier 1: moderate — keep first 200 chars + summary
  if (age <= tier1Age) {
    const summary = summarizeAgentMessage(text);
    const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
    if (preview.length >= text.length - 20) return item; // not worth compressing
    return {
      ...item,
      text: `${summary}\n\n[…${text.length - 200} chars of agent reasoning compressed]`,
      _originalLength: text.length,
      _compressed: "agent_tier1",
    };
  }

  // Tier 2: breadcrumb only (5+ turns old)
  const summary = summarizeAgentMessage(text);
  return {
    type: item.type || "agent_message",
    text: `[Agent: ${summary}]`,
    _originalLength: text.length,
    _compressed: "agent_tier2",
  };
}

/**
 * Apply compression to a user message item.
 *
 * @param {object} item  The user message item
 * @param {number} age   Turns since this message
 * @returns {object}     Possibly compressed item
 */
function compressUserMessage(item, age, opts) {
  const minChars  = opts?.msgMinCompressChars ?? MSG_MIN_COMPRESS_CHARS;
  const fullTurns = opts?.userMsgFullTurns    ?? USER_MSG_FULL_TURNS;

  const text = getItemText(item);
  if (!text || text.length < minChars) return item;

  // Current turn: keep full
  if (age <= fullTurns) return item;

  // Strip the TOOL_OUTPUT_GUARDRAIL and system prompt before summarizing
  // so the breadcrumb only captures the user's actual request
  const summary = summarizeUserMessage(text);
  return {
    type: item.type || "user_message",
    role: item.role,
    text: summary,
    _originalLength: text.length,
    _compressed: "user_breadcrumb",
  };
}

// ---------------------------------------------------------------------------
// Public API — Estimations & Diagnostics
// ---------------------------------------------------------------------------

/**
 * Convenience: estimate the token savings from compression.
 *
 * @param {Array} original     Items before compression
 * @param {Array} compressed   Items after compression
 * @returns {{ originalChars: number, compressedChars: number, savedChars: number, savedPct: number }}
 */
export function estimateSavings(original, compressed) {
  const countChars = (items) =>
    items.reduce((sum, item) => sum + (getItemText(item)?.length || 0), 0);
  const originalChars = countChars(original);
  const compressedChars = countChars(compressed);
  const savedChars = originalChars - compressedChars;
  const savedPct = originalChars > 0 ? Math.round((savedChars / originalChars) * 100) : 0;
  return { originalChars, compressedChars, savedChars, savedPct };
}

/**
 * Estimate the context usage percentage for an items array.
 *
 * Uses a chars-to-tokens heuristic (1 token ≈ 4 chars) and the model's
 * context window size.  Falls back to 128K tokens as the default window.
 *
 * @param {Array}  items               The items array to estimate
 * @param {number} [contextWindowTokens=128000]  Model context window in tokens
 * @returns {number}  Estimated fill ratio (0.0–1.0)
 */
export function estimateContextUsagePct(items, contextWindowTokens = 128_000) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  const CHARS_PER_TOKEN = 4;
  const totalChars = items.reduce(
    (sum, item) => sum + (getItemText(item)?.length || 0),
    0,
  );
  const estimatedTokens = totalChars / CHARS_PER_TOKEN;
  return Math.min(estimatedTokens / contextWindowTokens, 1.0);
}

/**
 * Returns the absolute path to the tool log cache directory.
 */
export function getToolLogDir() {
  return TOOL_LOG_DIR;
}

/**
 * Returns the default options object for `compressAllItems` / `cacheAndCompressItems`.
 * Useful for tests and documentation — shows all configurable fields with defaults.
 *
 * @returns {object}
 */
export function getDefaultCompressOptions() {
  return resolveOpts({});
}

// ---------------------------------------------------------------------------
// Tool-Log Memory Cache — Public API
// ---------------------------------------------------------------------------

/**
 * Evict the oldest content-cache entries until we're under the size limit.
 * Internal helper — called automatically on write.
 */
function _evictContentCacheBySize() {
  if (!_contentCache.size) return;
  const sorted = [..._contentCache.entries()].sort((a, b) => a[1].addedAt - b[1].addedAt);
  let idx = 0;
  while (_contentCacheTotalBytes > _contentCacheConfig.maxSizeBytes && idx < sorted.length) {
    const [logId, entry] = sorted[idx++];
    _contentCacheTotalBytes = Math.max(0, _contentCacheTotalBytes - entry.sizeBytes);
    _contentCache.delete(logId);
  }
}

/**
 * Configure the tool-log in-memory content cache.
 *
 * Supported options:
 *   - `enabled` {boolean}              — master switch (default: false)
 *   - `maxSizeBytes` {number}          — max total bytes in cache (default: 50MB)
 *   - `archiveSizeLimitBytes` {number} — triggers disk pruning when exceeded (default: 200MB)
 *
 * @param {{ enabled?: boolean, maxSizeBytes?: number, archiveSizeLimitBytes?: number }} opts
 */
export function configureToolLogMemCache(opts = {}) {
  if (typeof opts.enabled === "boolean") _contentCacheConfig.enabled = opts.enabled;
  if (typeof opts.maxSizeBytes === "number" && opts.maxSizeBytes > 0) {
    _contentCacheConfig.maxSizeBytes = opts.maxSizeBytes;
  }
  if (typeof opts.archiveSizeLimitBytes === "number" && opts.archiveSizeLimitBytes > 0) {
    _contentCacheConfig.archiveSizeLimitBytes = opts.archiveSizeLimitBytes;
  }
  // Trim if new limit is smaller than current usage
  if (_contentCacheTotalBytes > _contentCacheConfig.maxSizeBytes) {
    _evictContentCacheBySize();
  }
}

/**
 * Evict tool-log memory cache entries that are older than `maxAgeMs`,
 * or all entries if `all` is true.
 *
 * @param {{ maxAgeMs?: number, all?: boolean }} [opts]
 * @returns {number} Number of entries evicted
 */
export function evictToolLogMemCache({ maxAgeMs, all = false } = {}) {
  if (all) {
    const count = _contentCache.size;
    _contentCache.clear();
    _contentCacheTotalBytes = 0;
    return count;
  }
  if (!maxAgeMs || !Number.isFinite(maxAgeMs)) return 0;
  const cutoff = Date.now() - maxAgeMs;
  let evicted = 0;
  for (const [logId, entry] of _contentCache.entries()) {
    if (entry.addedAt < cutoff) {
      _contentCacheTotalBytes = Math.max(0, _contentCacheTotalBytes - entry.sizeBytes);
      _contentCache.delete(logId);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Return statistics about the current in-memory tool-log content cache.
 *
 * @returns {{ enabled: boolean, count: number, totalBytes: number, maxSizeBytes: number, archiveSizeLimitBytes: number }}
 */
export function getToolLogMemCacheStats() {
  return {
    enabled: _contentCacheConfig.enabled,
    count: _contentCache.size,
    totalBytes: _contentCacheTotalBytes,
    maxSizeBytes: _contentCacheConfig.maxSizeBytes,
    archiveSizeLimitBytes: _contentCacheConfig.archiveSizeLimitBytes,
  };
}

// ---------------------------------------------------------------------------
// Context Shredding Telemetry
// ---------------------------------------------------------------------------

/**
 * Append a shredding event to the ring buffer and persist to disk.
 *
 * @param {{ originalChars: number, compressedChars: number, savedChars: number, savedPct: number,
 *           agentType?: string, attemptId?: string, taskId?: string }} stats
 */
export function recordShreddingEvent(stats) {
  if (!stats || typeof stats !== "object") return;
  const { originalChars = 0, compressedChars = 0, savedChars = 0, savedPct = 0,
          agentType = null, attemptId = null, taskId = null } = stats;

  // Skip no-op events (nothing to report)
  if (originalChars === 0 && compressedChars === 0) return;

  const event = {
    timestamp: new Date().toISOString(),
    originalChars,
    compressedChars,
    savedChars,
    savedPct,
    ...(agentType  ? { agentType }  : {}),
    ...(attemptId  ? { attemptId }  : {}),
    ...(taskId     ? { taskId }     : {}),
  };

  // Ring buffer — evict oldest when full
  _shreddingRingBuffer.push(event);
  if (_shreddingRingBuffer.length > MAX_SHREDDING_BUFFER) {
    _shreddingRingBuffer.shift();
  }

  // Persist to disk (fire-and-forget, non-blocking)
  _appendShreddingEventToDisk(event).catch((err) => {
    console.warn(`${TAG} failed to persist shredding event: ${err.message}`);
  });
}

/** @returns {ShreddingEvent[]} Copy of the ring buffer */
export function getShreddingStats() {
  return [..._shreddingRingBuffer];
}

/** Clear ring buffer — intended for tests only */
export function clearShreddingStats() {
  _shreddingRingBuffer.length = 0;
}

/**
 * Append a shredding event JSON line to the shredding log file.
 * Creates the parent directory if needed.
 * @param {ShreddingEvent} event
 */
async function _appendShreddingEventToDisk(event) {
  const fs = await getFs();
  const { resolve: nodeResolve } = await import("node:path");
  const dir = nodeResolve(SHREDDING_LOG_FILE, "..");
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(SHREDDING_LOG_FILE, JSON.stringify(event) + "\n", "utf8");
}

/**
 * Returns the absolute path to the shredding stats log file.
 */
export function getShreddingLogFile() {
  return SHREDDING_LOG_FILE;
}

// ---------------------------------------------------------------------------
// High-Level Convenience — maybeCompressSessionItems
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper for SDK shell adapters and any execution path that
 * collects an items array and wants context-shredding applied.
 *
 * Resolves shredding configuration for the given session/agent type, checks
 * context usage against the configured threshold, compresses items when
 * warranted, and records shredding stats.  Returns the (possibly compressed)
 * items array — safe to call even when shredding is disabled.
 *
 * @param {Array}  items              The collected items array from the agent turn
 * @param {object} [opts]
 * @param {string} [opts.sessionType="primary"]  Interaction type (task, primary, chat, voice, …)
 * @param {string} [opts.agentType=""]           Agent SDK identifier (codex-sdk, claude-sdk, …)
 * @param {boolean} [opts.force=false]           Force compression even if below threshold
 * @param {boolean} [opts.skip=false]            Skip compression entirely
 * @returns {Promise<Array>}  Compressed (or unchanged) items array
 */
export async function maybeCompressSessionItems(
  items,
  { sessionType = "primary", agentType = "", force = false, skip = false } = {},
) {
  if (!Array.isArray(items) || items.length === 0) return items;
  if (skip) return items;

  // Lazy-import config to avoid circular dependency
  const { resolveContextShreddingOptions } = await import(
    "../config/context-shredding-config.mjs"
  );

  const shreddingOpts = resolveContextShreddingOptions(sessionType, agentType);
  if (shreddingOpts?._skip === true && !force) return items;

  const usagePct = estimateContextUsagePct(items);
  const threshold = Number.isFinite(shreddingOpts?.contextUsageThreshold)
    ? Number(shreddingOpts.contextUsageThreshold)
    : 0.5;

  if (!force && usagePct < threshold) return items;

  shreddingOpts.contextUsagePct = usagePct;
  const compressedItems = await compressAllItems(items, shreddingOpts);

  try {
    const savings = estimateSavings(items, compressedItems);
    if (savings.savedChars > 0) {
      recordShreddingEvent({ ...savings, agentType: agentType || "unknown" });
    }
  } catch {
    /* non-fatal */
  }

  return compressedItems;
}
