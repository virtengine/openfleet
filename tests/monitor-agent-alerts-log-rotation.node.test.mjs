import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

describe("monitor agent alerts log rotation detection", () => {
  it("detects log rotation by checking if data.length < agentAlertsOffset", () => {
    // Log rotation means the file is shorter than our last known offset
    const hasRotationCheck =
      source.includes("agentAlertsOffset") &&
      (source.includes("data.length <") ||
        source.includes("< agentAlertsOffset") ||
        /length\s*<\s*agentAlertsOffset|agentAlertsOffset.*length/.test(source));
    assert.ok(
      hasRotationCheck,
      "should detect log rotation by comparing data.length to agentAlertsOffset",
    );
  });

  it("resets agentAlertsOffset to 0 on log rotation", () => {
    // When rotation detected, start reading from the beginning
    const hasReset =
      source.includes("agentAlertsOffset") &&
      (source.includes("agentAlertsOffset = 0") ||
        /agentAlertsOffset\s*=\s*0/.test(source));
    assert.ok(
      hasReset,
      "agentAlertsOffset should reset to 0 when log rotation is detected",
    );
  });

  it("logs a message when log rotation is detected", () => {
    // Should log about the rotation for observability
    const hasLog =
      source.includes("agentAlertsOffset") &&
      (source.includes("rotation") || source.includes("rotated") ||
        source.includes("reset"));
    assert.ok(
      hasLog,
      "should log a message when agent alerts log rotation is detected",
    );
  });
});
