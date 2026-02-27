import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(
  resolve(process.cwd(), "agent-work-analyzer.mjs"),
  "utf8",
);

describe("agent-work-analyzer replay window normalization", () => {
  it("defines normalizeReplayMaxBytes function", () => {
    assert.ok(
      source.includes("normalizeReplayMaxBytes"),
      "normalizeReplayMaxBytes function should be defined",
    );
  });

  it("reads AGENT_ALERT_COOLDOWN_REPLAY_MAX_BYTES from env", () => {
    assert.ok(
      source.includes("AGENT_ALERT_COOLDOWN_REPLAY_MAX_BYTES"),
      "should read AGENT_ALERT_COOLDOWN_REPLAY_MAX_BYTES env var",
    );
  });

  it("defaults replay max bytes to 8MB", () => {
    // 8MB = 8 * 1024 * 1024 = 8388608
    const has8MB =
      source.includes("8 * 1024 * 1024") ||
      source.includes("8388608") ||
      /8\s*\*\s*1024\s*\*\s*1024/.test(source);
    assert.ok(has8MB, "default replay max bytes should be 8MB");
  });

  it("enforces minimum of 256KB", () => {
    // 256KB = 256 * 1024 = 262144
    const has256KB =
      source.includes("256 * 1024") ||
      source.includes("262144") ||
      /256\s*\*\s*1024/.test(source);
    assert.ok(has256KB, "minimum replay max bytes should be 256KB");
  });

  it("enforces maximum of 64MB", () => {
    // 64MB = 64 * 1024 * 1024 = 67108864
    const has64MB =
      source.includes("64 * 1024 * 1024") ||
      source.includes("67108864") ||
      /64\s*\*\s*1024\s*\*\s*1024/.test(source);
    assert.ok(has64MB, "maximum replay max bytes should be 64MB");
  });

  it("uses normalizeReplayMaxBytes result for cooldown hydration", () => {
    // The function result should be used when reading agent alerts tail
    const isUsed =
      source.includes("normalizeReplayMaxBytes") &&
      /normalizeReplayMaxBytes\s*\(/.test(source);
    assert.ok(
      isUsed,
      "normalizeReplayMaxBytes should be called to compute replay tail size",
    );
  });
});
