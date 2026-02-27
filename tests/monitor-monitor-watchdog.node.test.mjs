import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");
const runCycleStart = src.indexOf("async function runMonitorMonitorCycle(");
const runCycleEnd = src.indexOf("function startMonitorMonitorSupervisor()", runCycleStart);
const runCycleBlock =
  runCycleStart >= 0 && runCycleEnd > runCycleStart
    ? src.slice(runCycleStart, runCycleEnd)
    : "";

test("watchdog accelerated force-reset timer is guarded against stale runs", () => {
  assert.match(src, /MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS = parseEnvInteger\(/);
  assert.match(src, /DEVMODE_MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS/);
  assert.match(src, /watchdog\+\$\{Math\.round\(MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS \/ 1000\)\}s/);
  assert.match(src, /const watchdogRunHeartbeatAt = Number\(monitorMonitor\.heartbeatAt \|\| 0\)/);
  assert.match(src, /Number\(monitorMonitor\.heartbeatAt \|\| 0\) !== watchdogRunHeartbeatAt/);
  assert.match(src, /const runStaleThresholdMs =/);
  assert.match(src, /monitorMonitor\.timeoutMs \+ MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS/);
  assert.match(src, /runAge > runStaleThresholdMs/);
  assert.match(src, /Math\.round\(MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS \/ 1000\)/);
  assert.match(src, /\}, MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS\);/);
  assert.match(src, /Ignore stale timer from an earlier run/);
});

test("new monitor-monitor cycle clears prior watchdog force-reset timer", () => {
  assert.match(src, /function clearMonitorMonitorWatchdogTimer\(\{ preserveRunning = false \} = \{\}\) \{/);
  assert.match(src, /if \(!monitorMonitor\._watchdogForceResetTimer\) return;/);
  assert.match(src, /if \(preserveRunning && monitorMonitor\.running\) return;/);
  assert.match(src, /clearTimeout\(monitorMonitor\._watchdogForceResetTimer\);/);
  assert.match(src, /monitorMonitor\._watchdogForceResetTimer = null;/);
  assert.match(src, /monitorMonitor\.running = true;/);
  assert.match(runCycleBlock, /clearMonitorMonitorWatchdogTimer\(\{ preserveRunning: true \}\)/);
  assert.match(
    runCycleBlock,
    /clearMonitorMonitorWatchdogTimer\(\{ preserveRunning: true \}\);\s*monitorMonitor\.lastTrigger = trigger;[\s\S]*monitorMonitor\.running = true;/,
  );
  assert.doesNotMatch(
    runCycleBlock,
    /if \(!monitorMonitor\.enabled\) return;\s*monitorMonitor\.lastTrigger = trigger;/,
  );
  assert.doesNotMatch(runCycleBlock, /preserveRunning && monitorMonitor\.running/);
});

test("watchdog force-reset timer is cleaned up on run completion and supervisor stop", () => {
  assert.match(src, /}\s*finally \{/);
  assert.match(src, /clearMonitorMonitorWatchdogTimer\(\);[\s\S]*monitorMonitor\.lastRunAt = Date\.now\(\);/);
  assert.match(src, /function startMonitorMonitorSupervisor\(\) \{[\s\S]*clearMonitorMonitorWatchdogTimer\(\{ preserveRunning: true \}\);/);
  assert.match(src, /function stopMonitorMonitorSupervisor\(\{ preserveRunning = false \} = \{\}\) \{/);
  assert.match(src, /clearMonitorMonitorWatchdogTimer\(\{ preserveRunning \}\);/);
  assert.match(src, /MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS >= monitorMonitor\.intervalMs/);
  assert.match(src, /watchdog delay \(\$\{Math\.round\(MONITOR_MONITOR_WATCHDOG_FORCE_RESET_DELAY_MS \/ 1000\)\}s\) is >= run interval/);
});
