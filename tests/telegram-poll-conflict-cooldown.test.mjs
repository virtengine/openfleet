import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";

const repoRoot = process.cwd();
const conflictPath = resolve(repoRoot, ".cache", "telegram-getupdates-conflict.json");
const botSource = readFileSync(resolve(repoRoot, "telegram-bot.mjs"), "utf8");

function extractFunction(functionName) {
  const signature = `function ${functionName}(`;
  const startIndex = botSource.indexOf(signature);
  assert.notEqual(startIndex, -1, `missing function: ${functionName}`);

  const openBraceIndex = botSource.indexOf("{", startIndex);
  assert.notEqual(openBraceIndex, -1, `missing opening brace: ${functionName}`);

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = openBraceIndex; i < botSource.length; i += 1) {
    const ch = botSource[i];

    if (inSingleQuote) {
      if (!escaped && ch === "'") inSingleQuote = false;
      escaped = !escaped && ch === "\\";
      continue;
    }
    if (inDoubleQuote) {
      if (!escaped && ch === '"') inDoubleQuote = false;
      escaped = !escaped && ch === "\\";
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      escaped = false;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      escaped = false;
      continue;
    }

    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return botSource.slice(startIndex, i + 1);
      }
    }
  }

  throw new Error(`unable to extract function: ${functionName}`);
}

function createMemoryFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  const mkdirCalls = [];

  return {
    files,
    mkdirCalls,
    existsSync(path) {
      return files.has(path);
    },
    readFileSync(path) {
      if (!files.has(path)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return files.get(path);
    },
    writeFileSync(path, content) {
      files.set(path, String(content));
    },
    mkdirSync(path, options) {
      mkdirCalls.push({ path, options });
    },
    unlinkSync(path) {
      if (!files.has(path)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      files.delete(path);
    },
  };
}

function loadConflictStateHelpers(fsImpl, pid = 4242) {
  const scriptSource = [
    `const telegramPollConflictStatePath = ${JSON.stringify(conflictPath)};`,
    extractFunction("readTelegramPollConflictState"),
    extractFunction("writeTelegramPollConflictState"),
    extractFunction("clearTelegramPollConflictState"),
    "result = { readTelegramPollConflictState, writeTelegramPollConflictState, clearTelegramPollConflictState };",
  ].join("\n\n");

  const context = {
    Number,
    JSON,
    Date,
    String,
    dirname,
    existsSync: fsImpl.existsSync,
    readFileSync: fsImpl.readFileSync,
    writeFileSync: fsImpl.writeFileSync,
    mkdirSync: fsImpl.mkdirSync,
    unlinkSync: fsImpl.unlinkSync,
    process: {
      pid,
    },
    result: null,
  };

  vm.createContext(context);
  new vm.Script(scriptSource).runInContext(context);
  return context.result;
}

test("readTelegramPollConflictState returns null for missing and invalid payloads", () => {
  const fs = createMemoryFs();
  const helpers = loadConflictStateHelpers(fs);

  assert.equal(helpers.readTelegramPollConflictState(), null);

  fs.files.set(conflictPath, "");
  assert.equal(helpers.readTelegramPollConflictState(), null);

  fs.files.set(conflictPath, "{not-json");
  assert.equal(helpers.readTelegramPollConflictState(), null);

  fs.files.set(conflictPath, JSON.stringify({ untilMs: 0 }));
  assert.equal(helpers.readTelegramPollConflictState(), null);

  fs.files.set(conflictPath, JSON.stringify({ untilMs: "NaN" }));
  assert.equal(helpers.readTelegramPollConflictState(), null);
});

test("readTelegramPollConflictState parses valid state and normalizes reason", () => {
  const fs = createMemoryFs({
    [conflictPath]: JSON.stringify({ untilMs: 1234567890, reason: 409 }),
  });
  const helpers = loadConflictStateHelpers(fs);

  const state = helpers.readTelegramPollConflictState();
  assert.equal(state?.untilMs, 1234567890);
  assert.equal(state?.reason, "409");
});

test("writeTelegramPollConflictState persists payload and ensures parent directory", () => {
  const fs = createMemoryFs();
  const helpers = loadConflictStateHelpers(fs, 7777);

  helpers.writeTelegramPollConflictState(987654321, "conflict body");

  const written = String(fs.files.get(conflictPath) || "");
  const parsed = JSON.parse(written);
  assert.equal(parsed.untilMs, 987654321);
  assert.equal(parsed.reason, "conflict body");
  assert.equal(parsed.pid, 7777);
  assert.equal(typeof parsed.updatedAt, "string");
  assert.ok(parsed.updatedAt.length > 0);
  assert.equal(fs.mkdirCalls.length >= 1, true);
  assert.equal(fs.mkdirCalls[0].options?.recursive, true);
});

test("clearTelegramPollConflictState removes state and swallows unlink failures", () => {
  const fs = createMemoryFs({ [conflictPath]: "{}" });
  const helpers = loadConflictStateHelpers(fs);

  helpers.clearTelegramPollConflictState();
  assert.equal(fs.files.has(conflictPath), false);

  const throwingFs = createMemoryFs();
  throwingFs.unlinkSync = () => {
    throw new Error("unlink failed");
  };
  const throwingHelpers = loadConflictStateHelpers(throwingFs);
  assert.doesNotThrow(() => throwingHelpers.clearTelegramPollConflictState());
});

test("polling 409 path and startup cooldown guard are wired into source", () => {
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
  assert.match(
    botSource,
    /clearTelegramPollConflictState\(\);[\s\S]*const lockOk = await acquireTelegramPollLock\("telegram-bot"\);/,
  );
});
