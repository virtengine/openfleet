import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");

test("watcher debounce timers use safeSetTimeout wrappers", () => {
  assert.match(src, /watcherDebounce = safeSetTimeout\("watcher-file-change-debounce"/);
  assert.match(src, /envWatcherDebounce = safeSetTimeout\("env-reload-debounce"/);
  assert.doesNotMatch(src, /watcherDebounce = setTimeout\(/);
  assert.doesNotMatch(src, /envWatcherDebounce = setTimeout\(/);
});
