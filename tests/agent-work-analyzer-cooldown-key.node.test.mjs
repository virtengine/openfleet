import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "agent-work-analyzer.mjs"), "utf8");

test("failed-session alerts use task-scoped cooldown key and 1h cooldown floor", () => {
  assert.match(src, /const FAILED_SESSION_ALERT_MIN_COOLDOWN_MS = 60 \* 60 \* 1000/);
  assert.match(src, /function getAlertCooldownMs\(alert\)/);
  assert.match(src, /type === "failed_session_high_errors"/);
  assert.match(src, /Math\.max\(ALERT_COOLDOWN_MS, FAILED_SESSION_ALERT_MIN_COOLDOWN_MS\)/);
  assert.match(src, /function buildAlertCooldownKey\(alert\)/);
  assert.match(src, /failed_session_high_errors/);
  assert.match(src, /return `\$\{type\}:task:\$\{scopeId\}`/);
});

test("emitAlert uses cooldown key builder and per-alert cooldown window", () => {
  assert.match(src, /const alertKey = buildAlertCooldownKey\(alert\);/);
  assert.match(src, /const cooldownMs = getAlertCooldownMs\(alert\);/);
  assert.match(src, /Date\.now\(\) - lastAlert < cooldownMs/);
});
