import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeMonitorTailForPrompt } from "../monitor-tail-sanitizer.mjs";

test("sanitizes duplicated telegram-ui quick tunnel exit warning", () => {
  const sample =
    "2026-03-01T08:17:53.702Z [WARN] [telegram-ui] [telegram-ui] quick tunnel exited with code 1";
  const sanitized = sanitizeMonitorTailForPrompt(sample, "internal");
  assert.equal(
    sanitized,
    "[monitor] (sanitized benign tail noise)",
  );
});

test("sanitizes signal-only quick tunnel exit variants", () => {
  const sample =
    "2026-03-01T08:17:53.702Z [INFO] [telegram-ui] [telegram-ui] quick tunnel exited with code null signal SIGTERM; restart scheduled";
  const sanitized = sanitizeMonitorTailForPrompt(sample, "internal");
  assert.equal(
    sanitized,
    "[monitor] (sanitized benign tail noise)",
  );
});

test("sanitizes parenthesized quick tunnel exit variants", () => {
  const sample =
    "2026-03-01T08:17:53.702Z [INFO] [telegram-ui] [telegram-ui] quick tunnel exited (code undefined, signal SIGKILL); restart scheduled";
  const sanitized = sanitizeMonitorTailForPrompt(sample, "internal");
  assert.equal(
    sanitized,
    "[monitor] (sanitized benign tail noise)",
  );
});

test("sanitizes ANSI-colored quick tunnel restart noise", () => {
  const sample =
    "\u001b[33m2026-03-01T08:17:53.702Z [WARN] [telegram-ui] [telegram-ui] quick tunnel exited with code 1; restart scheduled\u001b[0m";
  const sanitized = sanitizeMonitorTailForPrompt(sample, "internal");
  assert.equal(
    sanitized,
    "[monitor] (sanitized benign tail noise)",
  );
});

test("sanitizes benign task-store load lines", () => {
  const sample =
    "2026-03-01T08:49:15.811Z [ERROR] [task-store] [task-store] Loaded 2 tasks from disk";
  const sanitized = sanitizeMonitorTailForPrompt(sample, "internal");
  assert.equal(
    sanitized,
    "[monitor] (sanitized benign tail noise)",
  );
});

test("sanitizes normalized task-store load lines", () => {
  const sample = "Loaded 2 tasks from disk";
  const sanitized = sanitizeMonitorTailForPrompt(sample, "internal");
  assert.equal(
    sanitized,
    "[monitor] (sanitized benign tail noise)",
  );
});

test("sanitizes maintenance uncommitted-changes pull-skip lines", () => {
  const sample =
    "2026-03-01T08:56:27.066Z [WARN] [maintenance] [maintenance] 'main' is checked out with uncommitted changes — skipping pull";
  const sanitized = sanitizeMonitorTailForPrompt(sample, "internal");
  assert.equal(
    sanitized,
    "[monitor] (sanitized benign tail noise)",
  );
});
