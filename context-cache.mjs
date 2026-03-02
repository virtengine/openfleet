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
const TOOL_LOG_DIR = resolve(__dirname, ".cache", "tool-logs");

/** Default max age for cached entries: 24 hours */
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Monotonic counter — reset per process, files use timestamp + counter */
let _logCounter = 0;

/** In-memory index: logId → { file, ts, toolName, argsPreview } */
const _logIndex = new Map();

// ── Tier boundaries (measured in "age" = currentTurn - itemTurn) ──────────
const TIER_0_MAX_AGE = 2;  // last 3 turns: full context
const TIER_1_MAX_AGE = 5;  // turns 3-5: light compression
const TIER_2_MAX_AGE = 9;  // turns 6-9: moderate compression

// ── Compression parameters ────────────────────────────────────────────────
const TIER_1_HEAD_CHARS = 2000;
const TIER_1_TAIL_CHARS = 800;
const TIER_2_HEAD_CHARS = 600;
const TIER_2_TAIL_CHARS = 300;

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

// ---------------------------------------------------------------------------
// Tiered Compression
// ---------------------------------------------------------------------------

/**
 * Light compression (Tier 1): keep head + tail of output.
 * ~20% reduction for typical outputs.
 */
function compressTier1(text, logId) {
  if (typeof text !== "string" || text.length <= TIER_1_HEAD_CHARS + TIER_1_TAIL_CHARS + 200) {
    return text; // small enough already
  }
  const head = text.slice(0, TIER_1_HEAD_CHARS);
  const tail = text.slice(-TIER_1_TAIL_CHARS);
  const omitted = text.length - TIER_1_HEAD_CHARS - TIER_1_TAIL_CHARS;
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
function compressTier2(text, logId) {
  if (typeof text !== "string" || text.length <= TIER_2_HEAD_CHARS + TIER_2_TAIL_CHARS + 200) {
    return text;
  }
  const head = text.slice(0, TIER_2_HEAD_CHARS);
  const tail = text.slice(-TIER_2_TAIL_CHARS);
  const omitted = text.length - TIER_2_HEAD_CHARS - TIER_2_TAIL_CHARS;
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
function applyCompression(item, logId, tier) {
  if (!item || typeof item !== "object") return item;

  if (tier === 3) {
    // Skeleton — replace the entire item with a minimal summary
    return {
      type: item.type || "context_compressed",
      _cachedLogId: logId,
      text: compressTier3(item, logId),
    };
  }

  const compressor = tier === 1 ? compressTier1 : compressTier2;
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
function resolveTier(age) {
  if (age <= TIER_1_MAX_AGE) return 1;
  if (age <= TIER_2_MAX_AGE) return 2;
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

// ---------------------------------------------------------------------------
// Main Entry Point
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

  const fullContextTurns = options.fullContextTurns ?? 3;
  const turnItems = assignTurns(items);
  const maxTurn = turnItems.reduce((m, t) => Math.max(m, t.turn), 0);

  // Nothing to compress if we don't have enough turns yet
  if (maxTurn < fullContextTurns) return items;

  const result = [];
  const cachePromises = [];

  for (const { item, turn } of turnItems) {
    const age = maxTurn - turn;

    // Tier 0: keep full
    if (age <= TIER_0_MAX_AGE) {
      result.push(item);
      continue;
    }

    // Skip items that have no meaningful text to compress
    if (!isCompressCandidate(item)) {
      result.push(item);
      continue;
    }

    // Already compressed? (has _cachedLogId)
    if (item._cachedLogId) {
      // Re-apply compression at potentially more aggressive tier
      const tier = resolveTier(age);
      result.push(applyCompression(item, item._cachedLogId, tier));
      continue;
    }

    // Determine tier
    const tier = resolveTier(age);

    // Cache the original, then compress
    const toolName = extractToolName(item);
    const argsPreview = extractArgsPreview(item);

    // We need to write to cache before compressing — capture the promise
    const cacheIdx = result.length;
    result.push(item); // placeholder — will be replaced

    cachePromises.push(
      writeToCache(item, toolName, argsPreview).then((logId) => {
        result[cacheIdx] = applyCompression(item, logId, tier);
      }),
    );
  }

  // Await all cache writes in parallel
  if (cachePromises.length > 0) {
    await Promise.all(cachePromises);
  }

  return result;
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
  PINNED_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
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
    .replace(/```[\s\S]*?```/g, "[code block]")                  // code fences
    .replace(/^\s*[-*•]\s+/gm, "")                                // bullet lists
    .replace(/^\s*\d+[.)]\s+/gm, "")                              // numbered lists
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")                      // markdown links
    .replace(/#{1,6}\s+/g, "")                                    // headings
    .replace(/[`*_~]+/g, "")                                      // inline formatting
    .replace(/\n{2,}/g, ". ")                                     // paragraph breaks → period
    .replace(/\n/g, " ")                                          // newlines → space
    .replace(/\s{2,}/g, " ")                                      // collapse whitespace
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
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/#{1,6}\s+/g, "")
    .replace(/[`*_~]+/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
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
 * @param {Array}  items       The full accumulated items array
 * @param {object} [options]   Optional overrides
 * @param {number} [options.fullContextTurns=3]  Turns to keep tool outputs full
 * @returns {Promise<Array>}   Compressed items array
 */
export async function compressAllItems(items, options = {}) {
  if (!Array.isArray(items) || items.length === 0) return items;

  // Step 1: Apply tool output compression (existing system)
  let result = await cacheAndCompressItems(items, options);

  // Step 2: Apply message compression to agent + user messages
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
      return compressAgentMessage(item, age);
    }

    // User messages: compress after the current turn
    if (kind === "user_msg") {
      return compressUserMessage(item, age);
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
function compressAgentMessage(item, age) {
  const text = getItemText(item);
  if (!text || text.length < MSG_MIN_COMPRESS_CHARS) return item;

  // Tier 0: full text (current + previous turn)
  if (age <= MSG_TIER_0_MAX_AGE) return item;

  // Tier 1: moderate — keep first 200 chars + summary
  if (age <= MSG_TIER_1_MAX_AGE) {
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
function compressUserMessage(item, age) {
  const text = getItemText(item);
  if (!text || text.length < MSG_MIN_COMPRESS_CHARS) return item;

  // Current turn: keep full
  if (age <= USER_MSG_FULL_TURNS) return item;

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
 * Returns the absolute path to the tool log cache directory.
 */
export function getToolLogDir() {
  return TOOL_LOG_DIR;
}
