/**
 * cron-scheduler.mjs — Pure-JS Cron Expression Parser & Scheduler
 *
 * Implements a standard 5-field cron expression parser (min hour dom mon dow)
 * and a lightweight polling scheduler that fires callbacks at the right times.
 *
 * No external dependencies — uses only Node.js built-ins.
 *
 * EXPORTS:
 *   parseCronExpression(expr)  — parse a cron string, returns { next(from) → Date }
 *   CronScheduler              — register/unregister cron jobs, start/stop polling
 */

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
     * Returns a Date in UTC.
     *
     * Safety: caps at 4 years of searching to prevent infinite loops
     * on impossible expressions (e.g. Feb 31).
     */
    next(from) {
      const d = from instanceof Date ? new Date(from.getTime()) : new Date();
      // Advance by 1 minute to ensure we always move forward
      d.setUTCSeconds(0, 0);
      d.setUTCMinutes(d.getUTCMinutes() + 1);

      const maxIterations = 366 * 24 * 60; // ~1 year of minutes
      for (let i = 0; i < maxIterations; i++) {
        if (!fields.month.includes(d.getUTCMonth() + 1)) {
          // Jump to next valid month
          d.setUTCMonth(d.getUTCMonth() + 1, 1);
          d.setUTCHours(0, 0, 0, 0);
          continue;
        }
        if (!fields.dayOfMonth.includes(d.getUTCDate()) || !fields.dayOfWeek.includes(d.getUTCDay())) {
          d.setUTCDate(d.getUTCDate() + 1);
          d.setUTCHours(0, 0, 0, 0);
          continue;
        }
        if (!fields.hour.includes(d.getUTCHours())) {
          d.setUTCHours(d.getUTCHours() + 1, 0, 0, 0);
          continue;
        }
        if (!fields.minute.includes(d.getUTCMinutes())) {
          d.setUTCMinutes(d.getUTCMinutes() + 1, 0, 0);
          continue;
        }
        // Match found
        return new Date(d.getTime());
      }

      throw new Error(`Unable to find next cron match within search window for: "${expr}"`);
    },
  };
}

// ── CronScheduler class ─────────────────────────────────────────────────────

export class CronScheduler {
  /** @type {Map<string, { cronExpr: string, parsed: ReturnType<typeof parseCronExpression>, callback: Function, nextRunAt: Date }>} */
  #jobs = new Map();
  #timer = null;
  #pollIntervalMs = 15000;

  /**
   * Register a cron job.
   * @param {string} id       — unique job identifier
   * @param {string} cronExpr — 5-field cron expression
   * @param {Function} callback — called when the cron fires
   */
  register(id, cronExpr, callback) {
    if (typeof id !== "string" || !id.trim()) {
      throw new Error("Job ID must be a non-empty string");
    }
    if (typeof callback !== "function") {
      throw new Error("Callback must be a function");
    }
    const parsed = parseCronExpression(cronExpr);
    const nextRunAt = parsed.next(new Date());
    this.#jobs.set(id, { cronExpr, parsed, callback, nextRunAt });
  }

  /**
   * Remove a registered cron job.
   * @param {string} id
   * @returns {boolean} true if the job existed
   */
  unregister(id) {
    return this.#jobs.delete(id);
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
   * @returns {Array<{ id: string, cronExpr: string, nextRunAt: string }>}
   */
  getStatus() {
    const result = [];
    for (const [id, job] of this.#jobs) {
      result.push({
        id,
        cronExpr: job.cronExpr,
        nextRunAt: job.nextRunAt ? job.nextRunAt.toISOString() : null,
      });
    }
    return result;
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
    for (const [id, job] of this.#jobs) {
      if (job.nextRunAt && now >= job.nextRunAt) {
        try {
          job.callback(id);
        } catch (err) {
          console.warn(`${TAG} cron job "${id}" threw: ${err?.message || err}`);
        }
        // Advance to the next occurrence
        try {
          job.nextRunAt = job.parsed.next(now);
        } catch (err) {
          console.warn(`${TAG} cron job "${id}" next-run computation failed: ${err?.message || err}`);
          job.nextRunAt = null;
        }
      }
    }
  }
}
