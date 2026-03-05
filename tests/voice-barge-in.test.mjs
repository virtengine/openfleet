import { describe, expect, it } from "vitest";

import {
  shouldAutoBargeIn,
  shouldAutoBargeInFromMicLevel,
} from "../ui/modules/voice-barge-in.js";

describe("voice-barge-in policy", () => {
  it("triggers only when audio is active and cooldown elapsed", () => {
    expect(shouldAutoBargeIn({
      muted: false,
      audioActive: true,
      now: 10_000,
      lastTriggeredAt: 9_000,
      minIntervalMs: 700,
    })).toBe(true);
    expect(shouldAutoBargeIn({
      muted: false,
      audioActive: true,
      now: 10_000,
      lastTriggeredAt: 9_600,
      minIntervalMs: 700,
    })).toBe(false);
    expect(shouldAutoBargeIn({
      muted: true,
      audioActive: true,
      now: 10_000,
      lastTriggeredAt: 0,
      minIntervalMs: 700,
    })).toBe(false);
    expect(shouldAutoBargeIn({
      muted: false,
      audioActive: false,
      now: 10_000,
      lastTriggeredAt: 0,
      minIntervalMs: 700,
    })).toBe(false);
  });

  it("triggers from mic level only when assistant is speaking and level crosses threshold", () => {
    expect(shouldAutoBargeInFromMicLevel({
      speaking: true,
      level: 0.11,
      threshold: 0.08,
    })).toBe(true);
    expect(shouldAutoBargeInFromMicLevel({
      speaking: true,
      level: 0.03,
      threshold: 0.08,
    })).toBe(false);
    expect(shouldAutoBargeInFromMicLevel({
      speaking: false,
      level: 0.2,
      threshold: 0.08,
    })).toBe(false);
  });
});
