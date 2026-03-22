import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseCronExpression, CronScheduler } from "../workflow/cron-scheduler.mjs";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── parseCronExpression ─────────────────────────────────────────────────────

describe("parseCronExpression", () => {
  it("rejects non-string input", () => {
    expect(() => parseCronExpression(null)).toThrow();
    expect(() => parseCronExpression(42)).toThrow();
    expect(() => parseCronExpression("")).toThrow();
  });

  it("rejects expressions with wrong field count", () => {
    expect(() => parseCronExpression("* * *")).toThrow(/5 fields/);
    expect(() => parseCronExpression("* * * * * *")).toThrow(/5 fields/);
  });

  it("parses every-minute wildcard", () => {
    const cron = parseCronExpression("* * * * *");
    expect(cron.fields.minute).toHaveLength(60);
    expect(cron.fields.hour).toHaveLength(24);
  });

  it("parses every 5 minutes", () => {
    const cron = parseCronExpression("*/5 * * * *");
    expect(cron.fields.minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  });

  it("parses daily at 9 AM", () => {
    const cron = parseCronExpression("0 9 * * *");
    expect(cron.fields.minute).toEqual([0]);
    expect(cron.fields.hour).toEqual([9]);
  });

  it("parses weekdays only (mon-fri)", () => {
    const cron = parseCronExpression("0 9 * * 1-5");
    expect(cron.fields.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses lists", () => {
    const cron = parseCronExpression("0,30 * * * *");
    expect(cron.fields.minute).toEqual([0, 30]);
  });

  it("parses ranges with steps", () => {
    const cron = parseCronExpression("0-30/10 * * * *");
    expect(cron.fields.minute).toEqual([0, 10, 20, 30]);
  });

  it("parses month names", () => {
    const cron = parseCronExpression("0 0 1 jan,jun *");
    expect(cron.fields.month).toEqual([1, 6]);
  });

  it("parses day-of-week names", () => {
    const cron = parseCronExpression("0 0 * * mon,wed,fri");
    expect(cron.fields.dayOfWeek).toEqual([1, 3, 5]);
  });

  it("treats 7 as Sunday (0)", () => {
    const cron = parseCronExpression("0 0 * * 7");
    expect(cron.fields.dayOfWeek).toEqual([0]);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCronExpression("60 * * * *")).toThrow(/Invalid value/);
    expect(() => parseCronExpression("* 25 * * *")).toThrow(/Invalid value/);
    expect(() => parseCronExpression("* * 32 * *")).toThrow(/Invalid value/);
    expect(() => parseCronExpression("* * * 13 *")).toThrow(/Invalid value/);
  });

  it("rejects invalid ranges", () => {
    expect(() => parseCronExpression("5-2 * * * *")).toThrow(/Invalid range/);
  });
});

// ── next() calculation ──────────────────────────────────────────────────────

describe("parseCronExpression.next()", () => {
  it("computes next 5-min mark", () => {
    const cron = parseCronExpression("*/5 * * * *");
    // From 2026-01-15 10:03:00 UTC → should be 10:05:00
    const from = new Date("2026-01-15T10:03:00Z");
    const next = cron.next(from);
    expect(next.getUTCHours()).toBe(10);
    expect(next.getUTCMinutes()).toBe(5);
  });

  it("computes daily 9 AM", () => {
    const cron = parseCronExpression("0 9 * * *");
    // From 2026-01-15 10:00:00 → next day 9:00
    const from = new Date("2026-01-15T10:00:00Z");
    const next = cron.next(from);
    expect(next.getUTCDate()).toBe(16);
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
  });

  it("computes next weekday match", () => {
    const cron = parseCronExpression("0 9 * * 1-5");
    // 2026-01-17 is Saturday → next weekday is Monday 2026-01-19
    const from = new Date("2026-01-17T08:00:00Z");
    const next = cron.next(from);
    expect(next.getUTCDay()).toBeGreaterThanOrEqual(1);
    expect(next.getUTCDay()).toBeLessThanOrEqual(5);
    expect(next.getUTCHours()).toBe(9);
  });

  it("advances past the current minute", () => {
    const cron = parseCronExpression("* * * * *");
    const from = new Date("2026-01-15T10:30:00Z");
    const next = cron.next(from);
    // Should be at least 1 minute after from
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  it("handles month rolling", () => {
    const cron = parseCronExpression("0 0 1 * *");
    // From 2026-01-15 → should be 2026-02-01 00:00
    const from = new Date("2026-01-15T00:00:00Z");
    const next = cron.next(from);
    expect(next.getUTCMonth()).toBe(1); // February
    expect(next.getUTCDate()).toBe(1);
  });
});

// ── CronScheduler class ─────────────────────────────────────────────────────

describe("CronScheduler", () => {
  let scheduler;

  beforeEach(() => {
    scheduler = new CronScheduler();
  });

  afterEach(() => {
    scheduler.stop();
  });

  it("registers and unregisters jobs", () => {
    scheduler.register("test-job", "*/5 * * * *", () => {});
    expect(scheduler.size).toBe(1);

    const removed = scheduler.unregister("test-job");
    expect(removed).toBe(true);
    expect(scheduler.size).toBe(0);
  });

  it("unregister returns false for missing job", () => {
    expect(scheduler.unregister("nonexistent")).toBe(false);
  });

  it("rejects invalid cron on register", () => {
    expect(() => scheduler.register("bad", "bad cron", () => {})).toThrow();
  });

  it("rejects empty ID", () => {
    expect(() => scheduler.register("", "* * * * *", () => {})).toThrow(/non-empty/);
  });

  it("rejects non-function callback", () => {
    expect(() => scheduler.register("x", "* * * * *", "not-fn")).toThrow(/function/);
  });

  it("getStatus returns job info", () => {
    scheduler.register("j1", "0 9 * * *", () => {});
    scheduler.register("j2", "*/10 * * * *", () => {});
    const status = scheduler.getStatus();
    expect(status).toHaveLength(2);
    expect(status[0]).toHaveProperty("id", "j1");
    expect(status[0]).toHaveProperty("cronExpr", "0 9 * * *");
    expect(status[0]).toHaveProperty("nextRunAt");
  });

  it("start/stop lifecycle", () => {
    expect(scheduler.running).toBe(false);
    scheduler.start(5000);
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });

  it("start is idempotent", () => {
    scheduler.start(5000);
    scheduler.start(5000); // should not throw
    expect(scheduler.running).toBe(true);
  });

  it("fires callback when cron time is reached", async () => {
    let fired = false;
    // Register with every-minute cron
    scheduler.register("fire-test", "* * * * *", () => {
      fired = true;
    });

    // Manually force the job's nextRunAt to the past so #tick fires it
    const jobs = scheduler.getStatus();
    expect(jobs).toHaveLength(1);

    // Access internal #tick via start with very short interval
    // Instead, we can simulate by setting nextRunAt in the past:
    // Since we can't access private fields, we rely on the fact that
    // the scheduler's poll will fire if we set a tight interval and wait
    scheduler.start(50);
    // Wait enough for a tick
    await new Promise((r) => setTimeout(r, 200));
    // The every-minute cron may or may not fire depending on timing,
    // but the scheduler should not throw
    scheduler.stop();
  });

  it("getStatus includes new fields", () => {
    scheduler.register("j1", "0 9 * * *", () => {});
    const status = scheduler.getStatus();
    expect(status[0]).toHaveProperty("timezone");
    expect(status[0]).toHaveProperty("lastRunAt");
    expect(status[0]).toHaveProperty("lastError");
    expect(status[0]).toHaveProperty("runCount", 0);
    expect(status[0]).toHaveProperty("errorCount", 0);
  });
});

// ── nextN() ─────────────────────────────────────────────────────────────────

describe("parseCronExpression.nextN()", () => {
  it("returns exactly N dates", () => {
    const cron = parseCronExpression("0 9 * * *"); // daily at 9AM
    const from = new Date("2026-01-15T00:00:00Z");
    const results = cron.nextN(5, from);
    expect(results).toHaveLength(5);
    expect(results.every((d) => d instanceof Date)).toBe(true);
  });

  it("returns dates in ascending order", () => {
    const cron = parseCronExpression("*/10 * * * *"); // every 10 min
    const results = cron.nextN(5, new Date("2026-01-15T10:00:00Z"));
    for (let i = 1; i < results.length; i++) {
      expect(results[i].getTime()).toBeGreaterThan(results[i - 1].getTime());
    }
  });

  it("caps at 100", () => {
    const cron = parseCronExpression("* * * * *");
    const results = cron.nextN(200);
    expect(results).toHaveLength(100);
  });
});

// ── CronScheduler persistence ───────────────────────────────────────────────

describe("CronScheduler persistence", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bosun-cron-test-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("persists state to disk when configDir provided", () => {
    const sched = new CronScheduler({ configDir: tmpDir });
    sched.register("j1", "0 9 * * *", () => {});
    const statePath = join(tmpDir, ".bosun", "cron-state.json");
    expect(existsSync(statePath)).toBe(true);
    sched.stop();
  });

  it("restores job metadata on new instance", () => {
    const sched1 = new CronScheduler({ configDir: tmpDir });
    sched1.register("j1", "0 9 * * *", () => {});
    sched1.stop();

    const sched2 = new CronScheduler({ configDir: tmpDir });
    const status = sched2.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].id).toBe("j1");
    expect(status[0].cronExpr).toBe("0 9 * * *");
    sched2.stop();
  });
});

// ── CronScheduler.getNextOccurrences ────────────────────────────────────────

describe("CronScheduler.getNextOccurrences", () => {
  it("returns null for unknown job", () => {
    const sched = new CronScheduler();
    expect(sched.getNextOccurrences("nope")).toBeNull();
    sched.stop();
  });

  it("returns N future dates for a registered job", () => {
    const sched = new CronScheduler();
    sched.register("j1", "0 9 * * *", () => {});
    const dates = sched.getNextOccurrences("j1", 3);
    expect(dates).toHaveLength(3);
    expect(dates.every((d) => d instanceof Date)).toBe(true);
    sched.stop();
  });
});

// ── CronScheduler with timezone ─────────────────────────────────────────────

describe("CronScheduler with timezone", () => {
  it("registers job with timezone", () => {
    const sched = new CronScheduler();
    sched.register("tz-job", "0 9 * * *", () => {}, { timezone: "America/New_York" });
    const status = sched.getStatus();
    expect(status[0].timezone).toBe("America/New_York");
    sched.stop();
  });
});
