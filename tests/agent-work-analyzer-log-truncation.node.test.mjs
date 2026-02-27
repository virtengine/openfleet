import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "agent-work-analyzer.mjs"), "utf8");

test("processLogFile resets offset when stream log is truncated", () => {
  assert.match(src, /if \(stats\.size < startPosition\) \{/);
  assert.match(src, /return 0;/);
  assert.match(src, /if \(stats\.size === startPosition\) \{/);
  assert.match(src, /return startPosition; \/\/ No new data/);
  assert.match(src, /const lastNewlineIdx = chunkText\.lastIndexOf\("\\n"\);/);
  assert.match(src, /const trailingTrimmed = String\(trailing \|\| ""\)\.trim\(\);/);
  assert.match(src, /return startPosition \+ Buffer\.byteLength\(processText, "utf8"\);/);
  assert.match(src, /return startPosition \+ Buffer\.byteLength\(chunkText, "utf8"\);/);
});
