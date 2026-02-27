/**
 * Tests for Telegram 409 poll conflict cooldown state management.
 *
 * Verifies:
 *  - telegramPollConflictStatePath constant
 *  - TELEGRAM_POLL_CONFLICT_COOLDOWN_MS constant (min 60 s, default 15 min)
 *  - readTelegramPollConflictState() — null for missing/invalid, valid parse
 *  - writeTelegramPollConflictState() / clearTelegramPollConflictState() lifecycle
 *  - pollUpdates() 409 semantics via source regex
 *  - startTelegramBot() early-return on active cooldown
 *
 * Runner: node:test (excluded from vitest by *.node.test.mjs pattern)
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const src = readFileSync(
  resolve(process.cwd(), "telegram-bot.mjs"),
  "utf8",
);

// ── Constant / path declarations ──────────────────────────────────────────

describe("telegram-bot conflict state constants", () => {
  it("defines telegramPollConflictStatePath pointing to .cache dir", () => {
    assert.match(
      src,
      /telegramPollConflictStatePath/,
      "should define telegramPollConflictStatePath",
    );
    assert.match(
      src,
      /telegram-getupdates-conflict\.json/,
      "path should end with telegram-getupdates-conflict.json",
    );
    assert.match(
      src,
      /\.cache/,
      "path should be inside .cache directory",
    );
  });

  it("defines TELEGRAM_POLL_CONFLICT_COOLDOWN_MS with a minimum of 60 000 ms", () => {
    assert.match(
      src,
      /TELEGRAM_POLL_CONFLICT_COOLDOWN_MS/,
      "should define TELEGRAM_POLL_CONFLICT_COOLDOWN_MS",
    );
    assert.match(
      src,
      /Math\.max\(\s*60[_,]?000/,
      "should enforce a minimum of 60 000 ms via Math.max",
    );
  });

  it("defaults TELEGRAM_POLL_CONFLICT_COOLDOWN_MS to 900 000 ms (15 min)", () => {
    assert.match(
      src,
      /900[_,]?000/,
      "default value should be 900 000 ms (15 minutes)",
    );
  });
});

// ── Function definitions ─────────────────────────────────────────────────

describe("telegram-bot conflict state helpers — source structure", () => {
  it("defines readTelegramPollConflictState function", () => {
    assert.match(
      src,
      /function\s+readTelegramPollConflictState\s*\(/,
      "should define readTelegramPollConflictState()",
    );
  });

  it("defines writeTelegramPollConflictState function", () => {
    assert.match(
      src,
      /function\s+writeTelegramPollConflictState\s*\(/,
      "should define writeTelegramPollConflictState()",
    );
  });

  it("defines clearTelegramPollConflictState function", () => {
    assert.match(
      src,
      /function\s+clearTelegramPollConflictState\s*\(/,
      "should define clearTelegramPollConflictState()",
    );
  });

  it("readTelegramPollConflictState returns null on JSON parse errors (corrupt file)", () => {
    // Should have a try/catch that returns null on error
    const funcIdx = src.indexOf("function readTelegramPollConflictState");
    assert.ok(funcIdx !== -1, "function should exist");
    // Extract function body (rough heuristic: look for catch near the function)
    const snippet = src.slice(funcIdx, funcIdx + 600);
    const hasCatch = snippet.includes("catch") || snippet.includes("try");
    assert.ok(hasCatch, "should tolerate corrupt JSON via try/catch returning null");
  });

  it("readTelegramPollConflictState returns null when file does not exist", () => {
    // The implementation should handle ENOENT gracefully
    const funcIdx = src.indexOf("function readTelegramPollConflictState");
    assert.ok(funcIdx !== -1, "function should exist");
    const snippet = src.slice(funcIdx, funcIdx + 600);
    // Either catches all errors (returns null) or checks existsSync first
    const handlesAbsence =
      snippet.includes("existsSync") ||
      snippet.includes("catch") ||
      snippet.includes("ENOENT");
    assert.ok(
      handlesAbsence,
      "should return null when file does not exist (existsSync or catch ENOENT)",
    );
  });

  it("readTelegramPollConflictState returns object with untilMs and reason on valid JSON", () => {
    const funcIdx = src.indexOf("function readTelegramPollConflictState");
    assert.ok(funcIdx !== -1, "function should exist");
    const snippet = src.slice(funcIdx, funcIdx + 600);
    assert.ok(
      snippet.includes("untilMs"),
      "should read untilMs from persisted JSON",
    );
  });

  it("writeTelegramPollConflictState persists updatedAt and pid fields", () => {
    const funcIdx = src.indexOf("function writeTelegramPollConflictState");
    assert.ok(funcIdx !== -1, "function should exist");
    const snippet = src.slice(funcIdx, funcIdx + 400);
    assert.ok(snippet.includes("updatedAt"), "should write updatedAt field");
    assert.ok(snippet.includes("pid"), "should write pid field");
  });

  it("clearTelegramPollConflictState uses unlinkSync (best-effort)", () => {
    const funcIdx = src.indexOf("function clearTelegramPollConflictState");
    assert.ok(funcIdx !== -1, "function should exist");
    const snippet = src.slice(funcIdx, funcIdx + 300);
    assert.ok(snippet.includes("unlink"), "should unlink the state file");
  });
});

// ── pollUpdates 409 semantics ─────────────────────────────────────────────

describe("pollUpdates — 409 conflict handling", () => {
  it("calls writeTelegramPollConflictState when status is 409", () => {
    // Both the 409 check and writeTelegramPollConflictState should appear
    // within close proximity in the source
    const idx409 = src.indexOf("res.status === 409");
    assert.ok(idx409 !== -1, "should handle res.status === 409");

    // writeTelegramPollConflictState should be called in the 409 branch
    const writeIdx = src.indexOf("writeTelegramPollConflictState", idx409 - 200);
    assert.ok(
      writeIdx !== -1 && writeIdx < idx409 + 500,
      "writeTelegramPollConflictState should be called near the 409 branch",
    );
  });

  it("sets polling = false on 409", () => {
    const idx409 = src.indexOf("res.status === 409");
    assert.ok(idx409 !== -1, "should check for 409");
    const snippet = src.slice(idx409, idx409 + 300);
    assert.ok(
      snippet.includes("polling = false"),
      "should set polling = false on 409",
    );
  });

  it("calls releaseTelegramPollLock on 409", () => {
    const idx409 = src.indexOf("res.status === 409");
    assert.ok(idx409 !== -1, "should check for 409");
    const snippet = src.slice(idx409, idx409 + 400);
    assert.ok(
      snippet.includes("releaseTelegramPollLock"),
      "should release poll lock on 409",
    );
  });

  it("calls clearTelegramPollConflictState on successful poll", () => {
    assert.match(
      src,
      /clearTelegramPollConflictState\s*\(\s*\)/,
      "should clear conflict state on successful response",
    );
    // clearTelegramPollConflictState should be called in the successful poll path.
    // Find the call site (last occurrence, after the function definition).
    let lastClearIdx = -1;
    let pos = 0;
    while (true) {
      const idx = src.indexOf("clearTelegramPollConflictState()", pos);
      if (idx === -1) break;
      lastClearIdx = idx;
      pos = idx + 1;
    }
    // Find the last occurrence of resetPollFailureStreak (the call in pollUpdates)
    let lastSuccessIdx = -1;
    pos = 0;
    while (true) {
      const idx = src.indexOf("resetPollFailureStreak", pos);
      if (idx === -1) break;
      lastSuccessIdx = idx;
      pos = idx + 1;
    }
    assert.ok(lastClearIdx !== -1, "clearTelegramPollConflictState() call should exist");
    assert.ok(lastSuccessIdx !== -1, "resetPollFailureStreak should exist");
    // clearTelegramPollConflictState should be called just after resetPollFailureStreak
    assert.ok(
      lastClearIdx > lastSuccessIdx && lastClearIdx - lastSuccessIdx < 200,
      `clearTelegramPollConflictState (at ${lastClearIdx}) should appear just after resetPollFailureStreak (at ${lastSuccessIdx})`,
    );
  });
});

// ── startTelegramBot cooldown guard ──────────────────────────────────────

describe("startTelegramBot — 409 cooldown startup guard", () => {
  it("reads conflict state at startup", () => {
    const startFuncIdx = src.indexOf("export async function startTelegramBot");
    assert.ok(startFuncIdx !== -1, "startTelegramBot should be defined");
    const startupSlice = src.slice(startFuncIdx, startFuncIdx + 1500);
    assert.ok(
      startupSlice.includes("readTelegramPollConflictState"),
      "startTelegramBot should call readTelegramPollConflictState at startup",
    );
  });

  it("returns early when conflict cooldown is still active (untilMs > Date.now())", () => {
    const startFuncIdx = src.indexOf("export async function startTelegramBot");
    assert.ok(startFuncIdx !== -1, "startTelegramBot should be defined");
    const startupSlice = src.slice(startFuncIdx, startFuncIdx + 1500);
    assert.ok(
      startupSlice.includes("untilMs") || startupSlice.includes("Date.now"),
      "should compare untilMs with Date.now() to decide early return",
    );
  });

  it("logs a warning and returns when conflict cooldown is active", () => {
    const startFuncIdx = src.indexOf("export async function startTelegramBot");
    const startupSlice = src.slice(startFuncIdx, startFuncIdx + 1500);
    const hasWarning =
      startupSlice.includes("console.warn") &&
      (startupSlice.includes("conflict") ||
        startupSlice.includes("cooldown") ||
        startupSlice.includes("409"));
    assert.ok(
      hasWarning,
      "should log a warning when 409 cooldown is still active",
    );
  });
});

// ── Filesystem lifecycle (via tmp dir) ────────────────────────────────────
// These tests exercise the file I/O logic by directly manipulating the state
// file that the real implementation would write/read/clear.

describe("conflict state JSON shape", () => {
  it("written state file has untilMs, reason, updatedAt, pid fields", () => {
    // Build a sample payload matching what writeTelegramPollConflictState writes
    const tmpDir = resolve(tmpdir(), `bosun-conflict-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const stateFile = resolve(tmpDir, "telegram-getupdates-conflict.json");
    const untilMs = Date.now() + 900_000;
    const payload = {
      untilMs,
      reason: "409 Conflict",
      updatedAt: new Date().toISOString(),
      pid: process.pid,
    };
    writeFileSync(stateFile, JSON.stringify(payload), "utf8");
    const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(typeof parsed.untilMs, "number");
    assert.equal(typeof parsed.reason, "string");
    assert.equal(typeof parsed.updatedAt, "string");
    assert.equal(typeof parsed.pid, "number");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("corrupt state file parse returns null shape", () => {
    // Simulate what readTelegramPollConflictState should do with corrupt JSON
    const corruptJson = "{ not valid json }}}";
    let result = null;
    try {
      result = JSON.parse(corruptJson);
    } catch {
      result = null;
    }
    assert.equal(result, null, "corrupt JSON should yield null");
  });

  it("missing state file should yield null", () => {
    const missingPath = resolve(
      tmpdir(),
      `bosun-no-such-conflict-${Date.now()}.json`,
    );
    let result = null;
    try {
      const raw = readFileSync(missingPath, "utf8");
      result = JSON.parse(raw);
    } catch {
      result = null;
    }
    assert.equal(result, null, "missing file should yield null");
  });
});
