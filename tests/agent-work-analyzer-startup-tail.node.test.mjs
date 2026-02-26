import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const src = readFileSync(resolve(process.cwd(), "agent-work-analyzer.mjs"), "utf8");

test("agent-work-analyzer defaults to tailing startup log from EOF", () => {
  assert.match(src, /function parseEnvBoolean\(value, fallback = false\)/);
  assert.match(src, /AGENT_ANALYZER_REPLAY_STARTUP/);
  assert.match(src, /const replayStartup = parseEnvBoolean\(/);
  assert.match(src, /if \(replayStartup\) \{/);
  assert.match(src, /filePosition = await processLogFile\(filePosition\);/);
  assert.match(src, /const streamStats = await stat\(AGENT_WORK_STREAM\);/);
  assert.match(src, /filePosition = Math\.max\(0, Number\(streamStats\?\.size \|\| 0\)\);/);
});

test("startup tail mode clears replayed in-memory sessions", () => {
  assert.match(src, /activeSessions\.clear\(\);/);
});
