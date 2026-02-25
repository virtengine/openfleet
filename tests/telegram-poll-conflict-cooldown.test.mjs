import assert from "node:assert/strict";
import vm from "node:vm";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const repoRoot = process.cwd();
const botSource = readFileSync(resolve(repoRoot, "telegram-bot.mjs"), "utf8");
const testCacheDir = resolve(repoRoot, ".cache", "tests");
const testConflictPath = resolve(testCacheDir, "telegram-getupdates-conflict.test.json");

function extractFunctionSource(source, functionName) {
  const signature = `function ${functionName}(`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing function ${functionName}`);

  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `missing body for ${functionName}`);

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (!inDouble && !inTemplate && ch === "'" && !inSingle) {
      inSingle = true;
      continue;
    }
    if (inSingle && ch === "'") {
      inSingle = false;
      continue;
    }
    if (!inSingle && !inTemplate && ch === '"' && !inDouble) {
      inDouble = true;
      continue;
    }
    if (inDouble && ch === '"') {
      inDouble = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "`" && !inTemplate) {
      inTemplate = true;
      continue;
    }
    if (inTemplate && ch === "`") {
      inTemplate = false;
      continue;
    }
    if (inSingle || inDouble || inTemplate) continue;

    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error(`failed to parse function ${functionName}`);
}

function buildConflictHelpersHarness(filePath, pid = 12345) {
  const readFn = extractFunctionSource(botSource, "readTelegramPollConflictState");
  const writeFn = extractFunctionSource(botSource, "writeTelegramPollConflictState");
  const clearFn = extractFunctionSource(botSource, "clearTelegramPollConflictState");

  const context = {
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    unlinkSync,
    dirname,
    telegramPollConflictStatePath: filePath,
    process: { pid },
    Date,
    JSON,
    globalThis: {},
  };

  vm.runInNewContext(
    `${readFn}\n${writeFn}\n${clearFn}\n` +
      "globalThis.helpers = { readTelegramPollConflictState, writeTelegramPollConflictState, clearTelegramPollConflictState };",
    context,
  );
  return context.globalThis.helpers;
}

describe("telegram polling 409 conflict cooldown", () => {
  beforeEach(() => {
    mkdirSync(testCacheDir, { recursive: true });
    rmSync(testConflictPath, { force: true });
  });

  afterEach(() => {
    rmSync(testConflictPath, { force: true });
  });

  it("writes, reads, and clears conflict state safely", () => {
    const helpers = buildConflictHelpersHarness(testConflictPath, 777);

    helpers.writeTelegramPollConflictState(123_456, "conflict reason");
    assert.equal(existsSync(testConflictPath), true);

    const state = helpers.readTelegramPollConflictState();
    assert.equal(JSON.stringify(state), JSON.stringify({ untilMs: 123_456, reason: "conflict reason" }));

    helpers.clearTelegramPollConflictState();
    assert.equal(existsSync(testConflictPath), false);
    assert.equal(helpers.readTelegramPollConflictState(), null);
  });

  it("returns null for corrupt or invalid conflict state", () => {
    const helpers = buildConflictHelpersHarness(testConflictPath, 888);

    writeFileSync(testConflictPath, "not-json", "utf8");
    assert.equal(helpers.readTelegramPollConflictState(), null);

    writeFileSync(testConflictPath, JSON.stringify({ untilMs: "bad" }), "utf8");
    assert.equal(helpers.readTelegramPollConflictState(), null);

    writeFileSync(testConflictPath, JSON.stringify({ untilMs: 0 }), "utf8");
    assert.equal(helpers.readTelegramPollConflictState(), null);
  });

  it("implements 409 handling semantics in pollUpdates and startup guard", () => {
    assert.match(
      botSource,
      /const TELEGRAM_POLL_CONFLICT_COOLDOWN_MS = Math\.max\([\s\S]*60_000[\s\S]*process\.env\.TELEGRAM_POLL_CONFLICT_COOLDOWN_MS/,
    );
    assert.match(
      botSource,
      /if \(res\.status === 409\) \{[\s\S]*writeTelegramPollConflictState\(untilMs, body\);[\s\S]*polling = false;[\s\S]*await releaseTelegramPollLock\(\);[\s\S]*return \[];/,
    );
    assert.match(
      botSource,
      /const pollConflict = readTelegramPollConflictState\(\);[\s\S]*polling temporarily disabled due to recent 409 conflict/,
    );
    assert.match(botSource, /clearTelegramPollConflictState\(\);/);
  });
});
