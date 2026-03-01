import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

test("startup monitor-tail window is narrower than normal interval window", () => {
  assert.match(src, /function resolveMonitorMonitorStartupErrorTailWindowMs\(baseWindowMs\)/);
  assert.match(src, /DEVMODE_MONITOR_MONITOR_STARTUP_ERROR_TAIL_WINDOW_MS/);
  assert.match(src, /process\.env\.DEVMODE_MONITOR_MONITOR_STARTUP_ERROR_TAIL_WINDOW_MS \|\| "120000"/);
  assert.match(src, /String\(trigger \|\| ""\)\.trim\(\)\.toLowerCase\(\) === "startup"/);
  assert.match(src, /resolveMonitorMonitorStartupErrorTailWindowMs\(monitorTailWindowMs\)/);
  assert.match(src, /windowMs:\s*effectiveMonitorTailWindowMs/);
});
