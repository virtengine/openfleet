import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

test("monitor prompt tail sanitizes benign sqlite/trace/dirty-diverged noise", () => {
  assert.match(src, /const benignMonitorTailPatterns = \[/);
  assert.match(src, /ExperimentalWarning:\\s\+SQLite is an experimental feature/i);
  assert.match(src, /Use `node --trace-warnings \.\*` to show where the warning was created/i);
  assert.match(src, /but has uncommitted changes\\s\+\[—-\]\\s\+skipping/i);
  assert.match(src, /workspace sync:\\s\+\\d\+\\s\+repo\\\(s\\\)\\s\+failed in\\s\+\[\^\(]\+\$/i);
  assert.match(src, /const normalized = current/);
  assert.match(src, /pattern\.test\(current\) \|\| pattern\.test\(normalized\)/);
  assert.match(src, /const fixtureTokensLower = fixtureTokens\.map\(\(token\) =>/);
  assert.match(src, /currentLower\.includes\(token\) \|\| normalizedLower\.includes\(token\)/);
  assert.match(src, /sanitized benign tail noise for non-VK backend/);
});

test("monitor tail window defaults to 3x interval bounded to 10-20m", () => {
  assert.match(src, /normalizedIntervalMs \* 3/);
  assert.match(src, /Math\.max\(\s*10 \* 60_000,/);
  assert.match(src, /Math\.min\(20 \* 60_000,\s*normalizedIntervalMs \* 3\)/);
});
