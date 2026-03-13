import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "infra/monitor.mjs"), "utf8");

test("watcher debounce timers use safeSetTimeout wrappers", () => {
  assert.match(src, /watcherDebounce = safeSetTimeout\("watcher-file-change-debounce"/);
  assert.match(src, /envWatcherDebounce = safeSetTimeout\("env-reload-debounce"/);
  assert.match(src, /ENV_RELOAD_DELAY_MS/);
  assert.match(src, /Number\(process\.env\.ENV_RELOAD_DELAY_MS \|\| "5000"\)/);
  assert.doesNotMatch(src, /watcherDebounce = setTimeout\(/);
  assert.doesNotMatch(src, /envWatcherDebounce = setTimeout\(/);
});
