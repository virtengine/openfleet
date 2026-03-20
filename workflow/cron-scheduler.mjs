/**
 * cron-scheduler.mjs — Pure-JS Cron Expression Parser & Scheduler
 *
 * Implements a standard 5-field cron expression parser (min hour dom mon dow)
 * and a lightweight polling scheduler that fires callbacks at the right times.
 *
 * No external dependencies — uses only Node.js built-ins.
 *
 * Features:
 *   - IANA timezone support (via Intl.DateTimeFormat)
 *   - Persistence layer (serialize/restore job state to disk)
 *   - Last-run tracking with error history
 *   - Next-N preview (getNextOccurrences)
 *   - Overdue coalescing (fire once for missed ticks)
 *   - Configurable jitter per job
 *
 * EXPORTS:
 *   parseCronExpression(expr)  — parse a cron string, returns { next(from) → Date }
 *   CronScheduler              — register/unregister cron jobs, start/stop polling
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TAG = "[cron-scheduler]";

// ── Field definitions ───────────────────────────────────────────────────────

const FIELD_DEFS = [
  { name: "minute",     min: 0, max: 59 },
  { name: "hour",       min: 0, max: 23 },
  { name: "dayOfMonth", min: 1, max: 31 },
  { name: "month",      min: 1, max: 12 },
  { name: "dayOfWeek",  min: 0, max: 6 },   // 0 = Sunday
];

const MONTH_NAMES = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

// ── Parser helpers ──────────────────────────────────────────────────────────

/**
 * Replace named month/dow tokens with their numeric equivalents.
 */
function substituteNames(token, fieldIndex) {
  let t = token.toLowerCase();
  if (fieldIndex === 3) {
    for (const [name, num] of Object.entries(MONTH_NAMES)) {
      t = t.replaceAll(name, String(num));
    }
  }
  if (fieldIndex === 4) {
    for (const [name, num] of Object.entries(DOW_NAMES)) {
      t = t.replaceAll(name, String(num));
    }
    // Treat 7 as Sunday (alias used in some cron implementations)
    t = t.replace(/\b7\b/g, "0");
  }
  return t;
}

/**
 * Parse a single cron field token into a sorted array of valid integer values.
 * Supports: *, lists (1,5), ranges (1-5), steps (wildcard/5, 1-10/2).
 */
function parseField(raw, fieldDef) {
  const { name, min, max } = fieldDef;
  const values = new Set();

  const parts = raw.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new Error(`Empty sub-expression in cron field "${name}"`);
    }

    // Step: */N or A-B/N or N-M/S
    const stepMatch = trimmed.match(/^(.+)\/(\d+)$/);
    let base = stepMatch ? stepMatch[1] : trimmed;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (step < 1) {
      throw new Error(`Invalid step value in cron field "${name}": ${trimmed}`);
    }

    if (base === "*") {
      for (let i = min; i <= max; i += step) {
        values.add(i);
      }
      continue;
    }

    // Range: A-B
    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start < min || end > max || start > end) {
        throw new Error(
          `Invalid range ${start}-${end} in cron field "${name}" (valid: ${min}-${max})`,
        );
      }
      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
      continue;
    }

    // Single value
    const num = Number(base);
    if (!Number.isFinite(num) || num < min || num > max || num !== Math.floor(num)) {
      throw new Error(
        `Invalid value "${base}" in cron field "${name}" (valid: ${min}-${max})`,
      );
    }
    values.add(num);
  }

  if (values.size === 0) {
    throw new Error(`Cron field "${name}" resolved to empty set: ${raw}`);
  }

  return [...values].sort((a, b) => a - b);
}

// ── Core parser ─────────────────────────────────────────────────────────────

/**
 * Parse a standard 5-field cron expression.
 *
 * @param {string} expr — e.g. "0 9 * * 1-5" (9 AM weekdays)
 * @returns {{ fields: object, next: (from: Date) => Date }}
 * @throws on invalid expression
 */
export function parseCronExpression(expr) {
  if (typeof expr !== "string" || !expr.trim()) {
    throw new Error("Cron expression must be a non-empty string");
  }

  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error(
      `Cron expression must have exactly 5 fields (minute hour dom month dow), got ${tokens.length}: "${expr}"`,
    );
  }

  const substituted = tokens.map((t, i) => substituteNames(t, i));
  const parsed = substituted.map((t, i) => parseField(t, FIELD_DEFS[i]));
  const fields = {
    minute:     parsed[0],
    hour:       parsed[1],
    dayOfMonth: parsed[2],
    month:      parsed[3],
    dayOfWeek:  parsed[4],
  };

  return {
    fields,
    /**
     * Compute the next occurrence after `from`.
     *
     * @param {Date} [from] — reference time (defaults to now)
     * @param {string} [timezone] — IANA timezone (e.g. "America/New_York"). Defaults to UTC.
     * @returns {Date} — always in UTC but matching the cron fields in the specified timezone
     *
     * Safety: caps at ~1 year of minute scanning to prevent infinite loops.
     */
    next(from, timezone) {
      const useTz = typeof timezone === "string" && timezone !== "UTC";
      const d = from instanceof Date ? new Date(from.getTime()) : new Date();
      // Advance by 1 minute to ensure we always move forward
      d.setUTCSeconds(0, 0);
      d.setUTCMinutes(d.getUTCMinutes() + 1);

      const maxIterations = 366 * 24 * 60; // ~1 year of minutes

      // Helper: get date parts in the target timezone
      const getParts = useTz ? (date) => {
        const fmt = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit",
          hour12: false,
        });
        const parts = {};
        for (const { type, value } of fmt.formatToParts(date)) {
          parts[type] = Number(value);
        }
        return {
          month: parts.month,       // 1-12
          day: parts.day,           // 1-31
          hour: parts.hour === 24 ? 0 : parts.hour, // handle midnight
          minute: parts.minute,
          // getDay equivalent via a separate formatter
          dow: date.getDay !== undefined ? new Date(
            Date.UTC(parts.year, parts.month - 1, parts.day)
          ).getUTCDay() : 0,
        };
      } : null;

      for (let i = 0; i < maxIterations; i++) {
        const month = useTz ? getParts(d).month        : (d.getUTCMonth() + 1);
        const day   = useTz ? getParts(d).day           : d.getUTCDate();
        const dow   = useTz ? getParts(d).dow           : d.getUTCDay();
        const hour  = useTz ? getParts(d).hour          : d.getUTCHours();
        const min   = useTz ? getParts(d).minute        : d.getUTCMinutes();

        if (!fields.month.includes(month)) {
          d.setUTCMonth(d.getUTCMonth() + 1, 1);
          d.setUTCHours(0, 0, 0, 0);
          continue;
        }
        if (!fields.dayOfMonth.includes(day) || !fields.dayOfWeek.includes(dow)) {
          d.setUTCDate(d.getUTCDate() + 1);
          d.setUTCHours(0, 0, 0, 0);
          continue;
        }
        if (!fields.hour.includes(hour)) {
          d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
          continue;
        }
        if (!fields.minute.includes(min)) {
          d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
          continue;
        }
        // Match found
        return new Date(d.getTime());
      }

      throw new Error(`Unable to find next cron match within search window for: "${expr}"`);
    },

    /**
     * Get the next N occurrences starting from `from`.
     * @param {number} n — how many
     * @param {Date} [from]
     * @param {string} [timezone]
     * @returns {Date[]}
     */
    nextN(n, from, timezone) {
      const results = [];
      let cursor = from instanceof Date ? new Date(from.getTime()) : new Date();
      const count = Math.max(1, Math.min(100, n));
      for (let i = 0; i < count; i++) {
        const next = this.next(cursor, timezone);
        results.push(next);
        cursor = next;
      }
      return results;
    },
  };
}

// ── CronScheduler class ─────────────────────────────────────────────────────

export class CronScheduler {
  /** @type {Map<string, { cronExpr: string, parsed: ReturnType<typeof parseCronExpression>, callback: Function, nextRunAt: Date, timezone: string|null, lastRunAt: Date|null, lastError: string|null, runCount: number, errorCount: number, jitterMs: number, coalesce: boolean }>} */
  #jobs = new Map();
  #timer = null;
  #pollIntervalMs = 15000;
  #persistPath = null;

  /**
   * @param {object} [opts]
   * @param {string} [opts.configDir] — enables persistence to {configDir}/.bosun/cron-state.json
   */
  constructor({ configDir } = {}) {
    if (configDir) {
      const bosunDir = resolve(configDir, ".bosun");
      this.#persistPath = resolve(bosunDir, "cron-state.json");
      this.#loadState();
    }
  }

  /**
   * Register a cron job.
   * @param {string} id       — unique job identifier
   * @param {string} cronExpr — 5-field cron expression
   * @param {Function} callback — called when the cron fires
   * @param {object} [opts]
   * @param {string} [opts.timezone] — IANA timezone (e.g. "America/New_York")
   * @param {number} [opts.jitterMs=0] — random jitter added to fire time (0 = none)
   * @param {boolean} [opts.coalesce=true] — if true, fire only once for missed ticks
   */
  register(id, cronExpr, callback, { timezone, jitterMs, coalesce } = {}) {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Job ID must be a non-empty string");
    }
    if (typeof callback !== "function") {
      throw new Error("Callback must be a function");
    }
    const parsed = parseCronExpression(cronExpr);
    const tz = timezone || null;
    const nextRunAt = parsed.next(new Date(), tz);

    // Preserve history from a previous registration / loaded state
    const prev = this.#jobs.get(id);
    this.#jobs.set(id, {
      cronExpr,
      parsed,
      callback,
      nextRunAt,
      timezone: tz,
      lastRunAt: prev?.lastRunAt || null,
      lastError: prev?.lastError || null,
      runCount: prev?.runCount || 0,
      errorCount: prev?.errorCount || 0,
      jitterMs: Math.max(0, jitterMs || 0),
      coalesce: coalesce !== false,
    });
    this.#saveState();
  }

  /**
   * Remove a registered cron job.
   * @param {string} id
   * @returns {boolean} true if the job existed
   */
  unregister(id) {
    const existed = this.#jobs.delete(id);
    if (existed) this.#saveState();
    return existed;
  }

  /**
   * Start the polling loop.
   * @param {number} [pollIntervalMs=15000]
   */
  start(pollIntervalMs = 15000) {
    if (this.#timer) return;
    this.#pollIntervalMs = Math.max(1000, pollIntervalMs);
    this.#timer = setInterval(() => this.#tick(), this.#pollIntervalMs);
    // Prevent the timer from keeping Node alive
    if (typeof this.#timer.unref === "function") {
      this.#timer.unref();
    }
  }

  /**
   * Stop the polling loop.
   */
  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  /**
   * Get status of all registered jobs.
   * @returns {Array<{ id: string, cronExpr: string, nextRunAt: string, timezone: string|null, lastRunAt: string|null, lastError: string|null, runCount: number, errorCount: number }>}
   */
  getStatus() {
    const result = [];
    for (const [id, job] of this.#jobs) {
      result.push({
        id,
        cronExpr: job.cronExpr,
        nextRunAt: job.nextRunAt ? job.nextRunAt.toISOString() : null,
        timezone: job.timezone,
        lastRunAt: job.lastRunAt ? (job.lastRunAt instanceof Date ? job.lastRunAt.toISOString() : job.lastRunAt) : null,
        lastError: job.lastError,
        runCount: job.runCount,
        errorCount: job.errorCount,
      });
    }
    return result;
  }

  /**
   * Get the next N scheduled times for a job.
   * @param {string} id
   * @param {number} [n=5]
   * @returns {Date[]|null}
   */
  getNextOccurrences(id, n = 5) {
    const job = this.#jobs.get(id);
    if (!job) return null;
    return job.parsed.nextN(n, new Date(), job.timezone);
  }

  /** @returns {number} */
  get size() {
    return this.#jobs.size;
  }

  /** @returns {boolean} */
  get running() {
    return this.#timer !== null;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  #tick() {
    const now = new Date();
    let stateChanged = false;

    for (const [id, job] of this.#jobs) {
      if (!job.nextRunAt || now < job.nextRunAt) continue;

      // Coalesce: skip intermediate missed ticks — fire once and jump ahead
      if (job.coalesce) {
        // Advance nextRunAt past now so we only fire once
        let nextCandidate = job.nextRunAt;
        try {
          while (nextCandidate && nextCandidate <= now) {
            nextCandidate = job.parsed.next(nextCandidate, job.timezone);
          }
        } catch { nextCandidate = null; }
        // Fire the callback once for the overdue window
        this.#fireJob(id, job);
        job.nextRunAt = nextCandidate;
      } else {
        this.#fireJob(id, job);
        try {
          job.nextRunAt = job.parsed.next(now, job.timezone);
        } catch (err) {
          console.warn(`${TAG} cron job "${id}" next-run computation failed: ${err?.message || err}`);
          job.nextRunAt = null;
        }
      }
      stateChanged = true;
    }

    if (stateChanged) this.#saveState();
  }

  #fireJob(id, job) {
    // Apply jitter
    const jitter = job.jitterMs > 0 ? Math.floor(Math.random() * job.jitterMs) : 0;
    const fire = () => {
      try {
        job.callback(id);
        job.runCount++;
        job.lastRunAt = new Date();
        job.lastError = null;
      } catch (err) {
        job.errorCount++;
        job.lastRunAt = new Date();
        job.lastError = String(err?.message || err);
        console.warn(`${TAG} cron job "${id}" threw: ${job.lastError}`);
      }
    };
    if (jitter > 0) {
      setTimeout(fire, jitter);
    } else {
      fire();
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────

  #saveState() {
    if (!this.#persistPath) return;
    try {
      const dir = dirname(this.#persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data = {};
      for (const [id, job] of this.#jobs) {
        data[id] = {
          cronExpr: job.cronExpr,
          timezone: job.timezone,
          nextRunAt: job.nextRunAt?.toISOString() || null,
          lastRunAt: job.lastRunAt instanceof Date ? job.lastRunAt.toISOString() : (job.lastRunAt || null),
          lastError: job.lastError,
          runCount: job.runCount,
          errorCount: job.errorCount,
          jitterMs: job.jitterMs,
          coalesce: job.coalesce,
        };
      }
      writeFileSync(this.#persistPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.warn(`${TAG} failed to save cron state: ${err?.message || err}`);
    }
  }

  #loadState() {
    if (!this.#persistPath) return;
    try {
      if (!existsSync(this.#persistPath)) return;
      const raw = readFileSync(this.#persistPath, "utf8");
      const data = JSON.parse(raw);
      if (!data || typeof data !== "object") return;
      // Restore metadata only — callbacks must be re-registered
      for (const [id, entry] of Object.entries(data)) {
        if (!entry?.cronExpr) continue;
        // Store partial state; register() or a subsequent call will supply the callback
        this.#jobs.set(id, {
          cronExpr: entry.cronExpr,
          parsed: parseCronExpression(entry.cronExpr),
          callback: () => { console.warn(`${TAG} cron job "${id}" fired but has no callback (not re-registered)`); },
          nextRunAt: entry.nextRunAt ? new Date(entry.nextRunAt) : null,
          timezone: entry.timezone || null,
          lastRunAt: entry.lastRunAt ? new Date(entry.lastRunAt) : null,
          lastError: entry.lastError || null,
          runCount: entry.runCount || 0,
          errorCount: entry.errorCount || 0,
          jitterMs: entry.jitterMs || 0,
          coalesce: entry.coalesce !== false,
        });
      }
    } catch (err) {
      console.warn(`${TAG} failed to load cron state: ${err?.message || err}`);
    }
  }
}
