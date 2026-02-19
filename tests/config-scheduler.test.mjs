import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExecutorScheduler } from "../config.mjs";

const baseFailover = {
  strategy: "next-in-line",
  maxRetries: 3,
  cooldownMinutes: 5,
  disableOnConsecutiveFailures: 3,
};

const executorList = (overrides = []) =>
  [
    {
      name: "primary",
      executor: "CODEX",
      variant: "DEFAULT",
      weight: 50,
      role: "primary",
      enabled: true,
    },
    {
      name: "backup",
      executor: "COPILOT",
      variant: "CLAUDE",
      weight: 50,
      role: "backup",
      enabled: true,
    },
  ].map((executor, idx) => ({ ...executor, ...(overrides[idx] || {}) }));

const makeScheduler = ({
  executors = executorList(),
  distribution = "weighted",
  failover = baseFailover,
} = {}) =>
  new ExecutorScheduler({
    executors,
    distribution,
    failover,
  });

const seedRandom = (values) => {
  const spy = vi.spyOn(Math, "random");
  values.forEach((value) => spy.mockReturnValueOnce(value));
  return spy;
};

describe("ExecutorScheduler constructor", () => {
  it("filters out disabled executors and stores config", () => {
    const scheduler = makeScheduler({
      executors: executorList([{ enabled: false }]),
      distribution: "round-robin",
    });

    expect(scheduler.executors).toHaveLength(1);
    expect(scheduler.executors[0].name).toBe("backup");
    expect(scheduler.distribution).toBe("round-robin");
    expect(scheduler.failover).toEqual(baseFailover);
  });

  it("handles an empty executor list without throwing", () => {
    const scheduler = makeScheduler({ executors: [] });
    expect(scheduler.executors).toEqual([]);
    expect(() => scheduler.next()).not.toThrow();
    expect(scheduler.next()).toBeUndefined();
  });
});

describe("ExecutorScheduler next()", () => {
  it("always returns the single executor", () => {
    const scheduler = makeScheduler({
      executors: executorList([{ name: "solo" }]).slice(0, 1),
    });

    expect(scheduler.next().name).toBe("solo");
    expect(scheduler.next().name).toBe("solo");
  });

  it("round-robins evenly with two 50/50 executors", () => {
    const scheduler = makeScheduler({ distribution: "round-robin" });

    expect(scheduler.next().name).toBe("primary");
    expect(scheduler.next().name).toBe("backup");
    expect(scheduler.next().name).toBe("primary");
  });

  it("uses weighted selection when distribution is weighted", () => {
    const scheduler = makeScheduler({
      distribution: "weighted",
      executors: executorList([
        { name: "light", weight: 1 },
        { name: "heavy", weight: 3 },
      ]),
    });

    const randomSpy = seedRandom([0.0, 0.99]);

    expect(scheduler.next().name).toBe("light");
    expect(scheduler.next().name).toBe("heavy");

    randomSpy.mockRestore();
  });
});

describe("ExecutorScheduler success/failure tracking", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("records failures and applies cooldown after threshold", () => {
    const scheduler = makeScheduler({
      distribution: "primary-only",
      failover: { ...baseFailover, disableOnConsecutiveFailures: 2 },
    });

    scheduler.recordFailure("primary");
    scheduler.recordFailure("primary");

    expect(scheduler._isDisabled("primary")).toBe(true);
    expect(scheduler.getSummary()[0].status).toBe("cooldown");
    expect(scheduler.next().name).toBe("backup");
  });

  it("recovers after cooldown elapses", () => {
    const scheduler = makeScheduler({
      distribution: "primary-only",
      failover: { ...baseFailover, disableOnConsecutiveFailures: 1 },
    });

    scheduler.recordFailure("primary");

    expect(scheduler._isDisabled("primary")).toBe(true);

    vi.advanceTimersByTime(baseFailover.cooldownMinutes * 60 * 1000 + 1);

    expect(scheduler._isDisabled("primary")).toBe(false);
    expect(scheduler.next().name).toBe("primary");
  });

  it("recordSuccess resets failure counters and cooldown", () => {
    const scheduler = makeScheduler({
      failover: { ...baseFailover, disableOnConsecutiveFailures: 1 },
    });

    scheduler.recordFailure("primary");
    expect(scheduler._isDisabled("primary")).toBe(true);

    scheduler.recordSuccess("primary");

    expect(scheduler._failureCounts.get("primary")).toBe(0);
    expect(scheduler._isDisabled("primary")).toBe(false);
  });

  it("exposes remaining cooldown via internal timestamp", () => {
    const scheduler = makeScheduler({
      failover: { ...baseFailover, disableOnConsecutiveFailures: 1 },
    });

    scheduler.recordFailure("primary");

    const cooldownUntil = scheduler._disabledUntil.get("primary");
    const remainingMs = cooldownUntil - Date.now();

    expect(remainingMs).toBe(baseFailover.cooldownMinutes * 60 * 1000);
  });
});

describe("ExecutorScheduler failover behavior", () => {
  it("picks the next role when current executor is unavailable", () => {
    const scheduler = makeScheduler({
      failover: { ...baseFailover, strategy: "next-in-line" },
    });

    scheduler._disabledUntil.set("primary", Date.now() + 60_000);

    const failover = scheduler.getFailover("primary");

    expect(failover.name).toBe("backup");
  });

  it("uses weighted-random strategy for failover", () => {
    const scheduler = makeScheduler({
      failover: { ...baseFailover, strategy: "weighted-random" },
    });

    const randomSpy = seedRandom([0.9]);
    const failover = scheduler.getFailover("primary");

    expect(failover.name).toBe("backup");

    randomSpy.mockRestore();
  });

  it("clears cooldowns and returns primary when all are cooled down", () => {
    const scheduler = makeScheduler({
      failover: { ...baseFailover, disableOnConsecutiveFailures: 1 },
    });

    scheduler.recordFailure("primary");
    scheduler.recordFailure("backup");

    expect(scheduler._getAvailable()).toEqual([]);

    const next = scheduler.next();

    expect(next.name).toBe("primary");
    expect(scheduler._disabledUntil.size).toBe(0);
    expect(scheduler._failureCounts.size).toBe(0);
  });
});

describe("ExecutorScheduler summary and status", () => {
  it("reports percentages and statuses", () => {
    const scheduler = makeScheduler({
      executors: executorList([
        { name: "alpha", weight: 30 },
        { name: "beta", weight: 70 },
      ]),
    });

    const summary = scheduler.getSummary();

    expect(summary[0].percentage).toBe(30);
    expect(summary[1].percentage).toBe(70);
    expect(summary[0].status).toBe("active");
    expect(summary[1].status).toBe("active");
  });
});
