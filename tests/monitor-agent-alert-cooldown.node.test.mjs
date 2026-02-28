import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

test("monitor applies cooldown for both high-error and transient failed-session alerts", () => {
  assert.match(src, /alert\.type === "failed_session_high_errors"/);
  assert.match(src, /alert\.type === "failed_session_transient_errors"/);
  assert.match(src, /const cooldownMs = alert\.type === "failed_session_transient_errors"/);
  assert.match(src, /\? 30 \* 60_000/);
  assert.match(src, /: 15 \* 60_000/);
  assert.match(src, /applyTaskCooldown/);
});
