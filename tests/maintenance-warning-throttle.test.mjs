import { describe, expect, it } from "vitest";

import { evaluateThrottledWarning } from "../maintenance.mjs";

describe("evaluateThrottledWarning", () => {
  it("logs first occurrence, suppresses repeats, then emits with suppressed count", () => {
    const state = new Map();

    expect(evaluateThrottledWarning(state, "dirty:main", 1_000, 60_000)).toEqual({
      shouldLog: true,
      suppressed: 0,
    });

    expect(evaluateThrottledWarning(state, "dirty:main", 2_000, 60_000)).toEqual({
      shouldLog: false,
      suppressed: 1,
    });

    expect(evaluateThrottledWarning(state, "dirty:main", 3_000, 60_000)).toEqual({
      shouldLog: false,
      suppressed: 2,
    });

    expect(evaluateThrottledWarning(state, "dirty:main", 61_100, 60_000)).toEqual({
      shouldLog: true,
      suppressed: 2,
    });
  });

  it("enforces a minimum throttle window", () => {
    const state = new Map();

    expect(evaluateThrottledWarning(state, "diverged:main", 1_000, 10)).toEqual({
      shouldLog: true,
      suppressed: 0,
    });

    expect(evaluateThrottledWarning(state, "diverged:main", 1_500, 10)).toEqual({
      shouldLog: false,
      suppressed: 1,
    });

    expect(evaluateThrottledWarning(state, "diverged:main", 2_050, 10)).toEqual({
      shouldLog: true,
      suppressed: 1,
    });
  });

  it("tracks keys independently", () => {
    const state = new Map();

    expect(evaluateThrottledWarning(state, "dirty:main", 1_000, 60_000).shouldLog).toBe(
      true,
    );
    expect(
      evaluateThrottledWarning(state, "dirty:main", 2_000, 60_000).shouldLog,
    ).toBe(false);
    expect(
      evaluateThrottledWarning(state, "diverged:main", 2_000, 60_000).shouldLog,
    ).toBe(true);
  });
});
