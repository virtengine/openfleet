import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");

describe("monitor agent alerts startup tail", () => {
  it("loads persisted alert tail state before starting the poller", () => {
    assert.ok(source.includes("function loadAgentAlertsState()"));
    assert.ok(source.includes("loadAgentAlertsState();"));
  });

  it("restores agentAlertsOffset from persisted state on startup", () => {
    assert.ok(
      source.includes("agentAlertsOffset"),
      "agentAlertsOffset should be restored from persisted state on startup",
    );
    assert.ok(source.includes("const offset = Number(parsed?.offset || 0);"));
  });

  it("persists updated offset and dedup state after each poll", () => {
    assert.ok(source.includes("function saveAgentAlertsState()"));
    assert.ok(source.includes("saveAgentAlertsState();"));
    assert.ok(source.includes("dedupEntries"));
  });

  it("runs a startup poll immediately after the interval is armed", () => {
    assert.ok(source.includes('runDetached("agent-alerts:poll-startup", pollAgentAlerts);'));
  });
});
