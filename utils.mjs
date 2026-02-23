/**
 * Pure utility functions for bosun
 * Extracted for unit testing (no I/O, no side effects)
 */

/**
 * Normalize text for deduplication by stripping timestamps and IDs
 * @param {string} text - Input text to normalize
 * @returns {string} Normalized text with numbers replaced by N
 */
export function normalizeDedupKey(text) {
  return (
    String(text || "")
      .trim()
      // Replace numbers (integers and decimals) with N, preserving surrounding text
      .replaceAll(/\d+(\.\d+)?/g, "N")
      // Collapse any resulting multi-N sequences (e.g., "N.N" → "N")
      .replaceAll(/N[.\-/:]N/g, "N")
      // Collapse whitespace
      .replaceAll(/\s+/g, " ")
  );
}

/**
 * Strip ANSI escape codes from text
 * PowerShell and colored CLI output includes \x1b[...m sequences that show
 * as garbage in Telegram messages.
 * @param {string} text - Input text with potential ANSI codes
 * @returns {string} Clean text without ANSI codes
 */
export function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\[\d+;?\d*m/g, "");
}

/**
 * Check if a line mentions "error" in a benign/summary context
 * (e.g. "errors=0", "0 errors", "no errors found").
 * Shared by isErrorLine() and autofix fallback to avoid false positives.
 * @param {string} line - Log line to check
 * @returns {boolean} True if the "error" mention is benign
 */
export function isBenignErrorMention(line) {
  const benign = [
    /errors?[=:]\s*0\b/i,
    /\b0\s+errors?\b/i,
    /\bno\s+errors?\b/i,
    /\bcomplete\b.*\berrors?[=:]\s*0/i,
    /\bpassed\b.*\berrors?\b/i,
    /\bclean\b.*\berrors?\b/i,
    /\bsuccess\b.*\berrors?\b/i,
    /errors?\s*(count|total|sum|rate)\s*[=:]\s*0/i,
  ];
  return benign.some((rx) => rx.test(line));
}

/**
 * Check if a line matches error patterns (excluding noise patterns)
 * @param {string} line - Log line to check
 * @param {RegExp[]} errorPatterns - Patterns that indicate errors
 * @param {RegExp[]} errorNoisePatterns - Patterns to exclude from error detection
 * @returns {boolean} True if line is an error
 */
export function isErrorLine(line, errorPatterns, errorNoisePatterns) {
  if (errorNoisePatterns.some((pattern) => pattern.test(line))) {
    return false;
  }
  if (isBenignErrorMention(line)) {
    return false;
  }
  return errorPatterns.some((pattern) => pattern.test(line));
}

/**
 * Escape HTML special characters
 * @param {any} value - Value to escape
 * @returns {string} HTML-escaped string
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Format an HTML link with proper escaping
 * @param {string} url - URL for the link
 * @param {string} label - Display text for the link
 * @returns {string} HTML anchor tag or escaped label if no URL
 */
export function formatHtmlLink(url, label) {
  if (!url) {
    return escapeHtml(label);
  }
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/**
 * Generate a normalized fingerprint for an error line (for deduplication)
 * Strips timestamps, attempt IDs, and branch-specific parts
 * @param {string} line - Error line to fingerprint
 * @returns {string} Normalized fingerprint
 */
export function getErrorFingerprint(line) {
  // Normalize: strip timestamps, attempt IDs, branch-specific parts
  return line
    .replace(/\[\d{2}:\d{2}:\d{2}\]\s*/g, "")
    .replace(/\b[0-9a-f]{8}\b/gi, "<ID>") // attempt IDs
    .replace(/ve\/[\w.-]+/g, "ve/<BRANCH>") // branch names
    .trim();
}

/**
 * Parse -MaxParallel argument from command line arguments
 * Supports: -MaxParallel N, --maxparallel=N, --max-parallel N
 * Falls back to VK_MAX_PARALLEL or MAX_PARALLEL env vars
 * @param {string[]} argsList - Command line arguments array
 * @returns {number|null} Maximum parallel value or null if not found
 */
export function getMaxParallelFromArgs(argsList) {
  if (!Array.isArray(argsList)) {
    return null;
  }
  for (let i = 0; i < argsList.length; i += 1) {
    const arg = String(argsList[i] ?? "");
    const directMatch =
      arg.match(/^-{1,2}maxparallel(?:=|:)?(\d+)$/i) ||
      arg.match(/^--max-parallel(?:=|:)?(\d+)$/i);
    if (directMatch) {
      const value = Number(directMatch[1]);
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    const normalized = arg.toLowerCase();
    if (
      normalized === "-maxparallel" ||
      normalized === "--maxparallel" ||
      normalized === "--max-parallel"
    ) {
      const next = Number(argsList[i + 1]);
      if (Number.isFinite(next) && next > 0) {
        return next;
      }
    }
  }
  const envValue = Number(
    process.env.VK_MAX_PARALLEL || process.env.MAX_PARALLEL,
  );
  if (Number.isFinite(envValue) && envValue > 0) {
    return envValue;
  }
  return null;
}

/**
 * Extract PR number from a GitHub pull request URL
 * @param {string} url - GitHub PR URL
 * @returns {number|null} PR number or null if not found
 */
export function parsePrNumberFromUrl(url) {
  if (!url) return null;
  const match = String(url).match(/\/pull\/(\d+)/i);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

// ── Async process helpers ─────────────────────────────────────────────────

/**
 * spawnAsync — Promise-based alternative to spawnSync.
 * Doesn't block the event loop. Resolves { stdout, stderr, status }
 * or rejects with an Error enriched with those same properties.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 * @returns {Promise<{ stdout: string, stderr: string, status: number }>}
 */
export async function spawnAsync(cmd, args = [], options = {}) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const proc = spawn(cmd, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d) => stdoutChunks.push(d));
    proc.stderr.on("data", (d) => stderrChunks.push(d));
    proc.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (code !== 0) {
        const err = Object.assign(
          new Error(`spawnAsync: ${cmd} ${args.join(" ")} exited ${code}\n${stderr || stdout}`),
          { stdout, stderr, status: code },
        );
        reject(err);
      } else {
        resolve({ stdout, stderr, status: code });
      }
    });
    proc.on("error", reject);
  });
}

/**
 * yieldToEventLoop — allow other microtasks/macrotasks to proceed.
 * Use between iterations of long synchronous-ish loops to prevent
 * event loop starvation when many agent slots are active.
 * @returns {Promise<void>}
 */
export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * withRetry — run an async fn with exponential backoff on failure.
 *
 * @template T
 * @param {() => Promise<T>} fn         — async operation to retry
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts=3]  — total attempts
 * @param {number} [opts.baseMs=1000]    — initial delay
 * @param {number} [opts.maxMs=30000]    — cap delay
 * @param {(err: Error, attempt: number) => boolean} [opts.retryIf] — optional guard
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const { maxAttempts = 3, baseMs = 1000, maxMs = 30000, retryIf } = opts;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts) break;
      if (retryIf && !retryIf(err, attempt)) break;
      const jitter = Math.random() * 0.3 + 0.85; // 0.85–1.15x
      const delay = Math.min(baseMs * Math.pow(2, attempt - 1) * jitter, maxMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * memoizeWithTtl — cache the result of a zero-args async factory for `ttlMs`.
 * Returns a getter function that resolves the cached value or refreshes it.
 *
 * @template T
 * @param {() => Promise<T>} factory
 * @param {number} ttlMs
 * @returns {() => Promise<T>}
 */
export function memoizeWithTtl(factory, ttlMs) {
  let cache = null;
  let expiry = 0;
  let pending = null;
  return async function get() {
    const now = Date.now();
    if (cache !== null && now < expiry) return cache;
    if (pending) return pending;
    pending = factory().then((v) => {
      cache = v;
      expiry = Date.now() + ttlMs;
      pending = null;
      return v;
    }).catch((e) => {
      pending = null;
      throw e;
    });
    return pending;
  };
}
