/**
 * Tests for monitor-monitor SDK cooldown bypass in agent-pool.mjs.
 *
 * Verifies that the monitor-monitor task automatically gets
 * `ignoreSdkCooldown: true` so it can always attempt to run
 * even during cascading SDK cooldowns.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = process.cwd();
const AGENT_POOL_PATH = resolve(repoRoot, "agent-pool.mjs");

test("launchOrResumeThread auto-sets ignoreSdkCooldown for monitor-monitor", async () => {
  const src = await readFile(AGENT_POOL_PATH, "utf8");

  // Verify the MONITOR_MONITOR_TASK_KEY guard exists in launchOrResumeThread
  assert.ok(
    src.includes("MONITOR_MONITOR_TASK_KEY") &&
      src.includes("ignoreSdkCooldown"),
    "Should reference MONITOR_MONITOR_TASK_KEY and ignoreSdkCooldown",
  );

  // Verify the auto-set logic only activates for monitor-monitor
  assert.ok(
    /taskKey.*===\s*MONITOR_MONITOR_TASK_KEY/.test(src.replace(/\n/g, " ")),
    "Should guard the cooldown bypass with taskKey === MONITOR_MONITOR_TASK_KEY",
  );

  // Verify it only sets when not explicitly provided (respects caller override)
  assert.ok(
    src.includes("ignoreSdkCooldown === undefined"),
    "Should only auto-set when not explicitly provided by caller",
  );
});

test("monitor-monitor cooldown bypass is in launchOrResumeThread scope", async () => {
  const src = await readFile(AGENT_POOL_PATH, "utf8");

  // Find the function — the bypass must be between function start and the
  // "No taskKey" pure ephemeral guard (line after the bypass)
  const funcStart = src.indexOf("export async function launchOrResumeThread(");
  assert.ok(funcStart >= 0, "launchOrResumeThread should exist");

  const funcBody = src.slice(funcStart, funcStart + 2000);

  // The bypass should appear before the first launchEphemeralThread call
  const bypassIdx = funcBody.indexOf("MONITOR_MONITOR_TASK_KEY");
  const ephemeralIdx = funcBody.indexOf("launchEphemeralThread");
  assert.ok(bypassIdx >= 0, "MONITOR_MONITOR_TASK_KEY guard should be in function");
  assert.ok(ephemeralIdx >= 0, "launchEphemeralThread call should be in function");
  assert.ok(
    bypassIdx < ephemeralIdx,
    "Cooldown bypass should be set BEFORE launchEphemeralThread is called",
  );
});

test("ignoreSdkCooldown is consumed in launchEphemeralThread", async () => {
  const src = await readFile(AGENT_POOL_PATH, "utf8");

  // Verify that launchEphemeralThread reads ignoreSdkCooldown from extra
  const ephFuncStart = src.indexOf(
    "export async function launchEphemeralThread(",
  );
  assert.ok(ephFuncStart >= 0, "launchEphemeralThread should exist");

  const ephBody = src.slice(ephFuncStart, ephFuncStart + 2000);
  assert.ok(
    ephBody.includes("ignoreSdkCooldown"),
    "launchEphemeralThread should read ignoreSdkCooldown from extra",
  );

  // Verify that when ignoreSdkCooldown is true, cooldown is set to 0
  assert.ok(
    /ignoreSdkCooldown\s*\?\s*0/.test(ephBody.replace(/\n/g, " ")),
    "Should set cooldownRemainingMs to 0 when ignoreSdkCooldown is true",
  );
});
