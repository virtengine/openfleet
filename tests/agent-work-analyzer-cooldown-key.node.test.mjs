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
  assert.match(src, /_cooldown_key:\s*alertKey/);
});

test("cooldowns hydrate from alert log on startup to survive restarts", () => {
  assert.match(src, /const ALERT_COOLDOWN_REPLAY_MAX_BYTES = Math\.max\(/);
  assert.match(src, /AGENT_ALERT_COOLDOWN_REPLAY_MAX_BYTES/);
  assert.match(src, /async function hydrateAlertCooldownsFromLog\(\)/);
  assert.match(src, /const maxCooldownMs = Math\.max\(ALERT_COOLDOWN_MS, FAILED_SESSION_ALERT_MIN_COOLDOWN_MS\)/);
  assert.match(src, /const key = String\(entry\?\._cooldown_key \|\| ""\)\.trim\(\) \|\| buildAlertCooldownKey\(entry\)/);
  assert.match(src, /await hydrateAlertCooldownsFromLog\(\);/);
});

test("stale alert cooldown entries are periodically pruned to bound memory", () => {
  assert.match(src, /const ALERT_COOLDOWN_RETENTION_MS = Math\.max\(/);
  assert.match(src, /function pruneStaleAlertCooldowns\(nowMs = Date\.now\(\)\)/);
  assert.match(src, /for \(const \[key, ts\] of alertCooldowns\.entries\(\)\)/);
  assert.match(src, /alertCooldowns\.delete\(key\)/);
  assert.match(src, /pruneStaleAlertCooldowns\(\);/);
  assert.match(src, /const cleanupTimer = setInterval\(\(\) => \{/);
  assert.match(src, /cleanupTimer\.unref\?\.\(\);/);
});
