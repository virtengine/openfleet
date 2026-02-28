import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("update-check uncaughtException handler suppresses stream noise and avoids manual re-emit", () => {
  const src = readFileSync(resolve(process.cwd(), "update-check.mjs"), "utf8");

  assert.match(src, /function isSuppressedStreamNoiseError\(err\)/);
  assert.match(src, /msg\.includes\("setRawMode EIO"\)/);
  assert.match(src, /\[auto-update\] suppressed stream noise \(uncaughtException\):/);

  // Node dispatches all uncaughtException listeners itself; auto-update should
  // not capture and manually invoke prior listeners.
  assert.doesNotMatch(src, /originalUncaughtException/);
  assert.doesNotMatch(src, /for \(const handler of originalUncaughtException\)/);
});

test("update-check promptConfirm avoids raw-mode and never throws on close failures", () => {
  const src = readFileSync(resolve(process.cwd(), "update-check.mjs"), "utf8");

  assert.match(src, /function promptConfirm\(question\)/);
  assert.match(src, /terminal:\s*false/);
  assert.match(src, /\[auto-update\] suppressed stream noise \(readline close\):/);
  assert.doesNotMatch(src, /if \(!msg\.includes\("setRawMode EIO"\)\) \{\s*throw err;/);
});
