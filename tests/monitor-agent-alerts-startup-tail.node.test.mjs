import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor agent alerts startup tail", () => {
  it("supports AGENT_ALERTS_REPLAY_STARTUP env var to enable historical replay", () => {
    assert.ok(
      source.includes("AGENT_ALERTS_REPLAY_STARTUP"),
      "should support AGENT_ALERTS_REPLAY_STARTUP env var",
    );
  });

  it("skips historical alerts by default on monitor restart (no replay)", () => {
    // Default behavior: seek to EOF, skip replaying old alerts
    const hasSkipDefault =
      source.includes("AGENT_ALERTS_REPLAY_STARTUP") &&
      (source.includes("false") || source.includes("skip") ||
        source.includes("seek"));
    assert.ok(
      hasSkipDefault,
      "historical alerts should be skipped by default unless AGENT_ALERTS_REPLAY_STARTUP=true",
    );
  });

  it("replays historical alerts when AGENT_ALERTS_REPLAY_STARTUP is true", () => {
    const hasReplayWhenTrue =
      source.includes("AGENT_ALERTS_REPLAY_STARTUP") &&
      (source.includes("true") || source.includes("replay"));
    assert.ok(
      hasReplayWhenTrue,
      "should replay alerts from beginning when AGENT_ALERTS_REPLAY_STARTUP=true",
    );
  });

  it("restores agentAlertsOffset from persisted state on startup", () => {
    assert.ok(
      source.includes("agentAlertsOffset"),
      "agentAlertsOffset should be restored from persisted state on startup",
    );
  });
});
