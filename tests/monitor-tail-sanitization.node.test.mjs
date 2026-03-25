import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const monitorSrc = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");
const sanitizerSrc = readFileSync(resolve(process.cwd(), "monitor-tail-sanitizer.mjs"), "utf8");

test("monitor prompt tail sanitizes benign sqlite/trace/dirty-diverged noise", () => {
  assert.match(monitorSrc, /sanitizeMonitorTailForPromptShared\(tail,\s*backend\)/);
  assert.match(sanitizerSrc, /const benignMonitorTailPatterns = \[/);
  assert.match(sanitizerSrc, /ExperimentalWarning:\\s\+SQLite is an experimental feature/i);
  assert.match(sanitizerSrc, /Use `node --trace-warnings \.\*` to show where the warning was created/i);
  assert.match(sanitizerSrc, /but has uncommitted changes\\s\+\[—-\]\\s\+skipping/i);
  assert.match(sanitizerSrc, /is checked out with uncommitted changes\\s\+\[—-\]\\s\+skipping pull/i);
  assert.match(sanitizerSrc, /workspace sync:\\s\+\\d\+\\s\+repo\\\(s\\\)\\s\+failed in\\s\+\[\^\(]\+\$/i);
  assert.match(sanitizerSrc, /quick tunnel exited with code\\s\+\(\?:-\?\\d\+\|null\|undefined\|unknown\)/i);
  assert.match(sanitizerSrc, /quick tunnel exited\\s\+\\\(code\\s\+\(\?:-\?\\d\+\|null\|undefined\|unknown\)/i);
  assert.ok(
    sanitizerSrc.includes("/(?:\\[task-store\\]\\s+)?Loaded\\s+\\d+\\s+tasks?\\s+from\\s+disk$/i"),
  );
  assert.match(sanitizerSrc, /restart scheduled/i);
  assert.match(sanitizerSrc, /const normalized = current/);
  assert.match(sanitizerSrc, /pattern\.test\(decolorized\)/);
  assert.match(sanitizerSrc, /pattern\.test\(normalizedDecolorized\)/);
  assert.match(sanitizerSrc, /const fixtureTokensLower = fixtureTokens\.map\(\(token\) =>/);
  assert.match(sanitizerSrc, /normalizedDecolorizedLower\.includes\(token\)/);
  assert.match(sanitizerSrc, /sanitized benign tail noise/);
});

test("monitor tail window defaults to 3x interval bounded to 10-20m", () => {
  assert.match(monitorSrc, /normalizedIntervalMs \* 3/);
  assert.match(monitorSrc, /Math\.max\(\s*10 \* 60_000,/);
  assert.match(monitorSrc, /Math\.min\(20 \* 60_000,\s*normalizedIntervalMs \* 3\)/);
});
