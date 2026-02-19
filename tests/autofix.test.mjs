import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

vi.mock("node:child_process", () => {
  const spawn = vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });

  const execSync = vi.fn(() => "");
  return { spawn, execSync };
});

let autofixPromise = null;

async function loadAutofix() {
  if (!autofixPromise) {
    autofixPromise = import("../autofix.mjs");
  }
  return await autofixPromise;
}

describe("extractErrors", () => {
  it("parses PowerShell error format with column and Line block", async () => {
    const { extractErrors } = await loadAutofix();

    const log = [
      "RuntimeException: C:\\repo\\orchestrator.ps1:12:5",
      "Line |",
      " 12 |  $foo = bar",
      "    |  ~~~",
      "    | The term 'bar' is not recognized as the name of a cmdlet.",
    ].join("\n");

    const errors = extractErrors(log);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      errorType: "RuntimeException",
      file: "C:\\repo\\orchestrator.ps1",
      line: 12,
      column: 5,
      codeLine: "$foo = bar",
      message: "The term 'bar' is not recognized as the name of a cmdlet.",
    });
  });

  it("parses ParserError without column and uses last pipe message", async () => {
    const { extractErrors } = await loadAutofix();

    const log = [
      "ParserError: C:\\repo\\orchestrator.ps1:27",
      "Line |",
      " 27 |  if ($x -eq 1 {",
      "    |               ~",
      "    | Missing closing ')' in expression.",
    ].join("\n");

    const errors = extractErrors(log);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      errorType: "ParserError",
      file: "C:\\repo\\orchestrator.ps1",
      line: 27,
      column: null,
      codeLine: "if ($x -eq 1 {",
      message: "Missing closing ')' in expression.",
    });
  });

  it("parses At-line stack traces with plus blocks", async () => {
    const { extractErrors } = await loadAutofix();

    const log = [
      "At C:\\repo\\orchestrator.ps1:42 char:7",
      "+ $result = Invoke-Thing",
      "+           ~~~~~~~~~~~~~",
      '+ MethodInvocationException: Exception calling "Foo" with "1" argument(s): "bad"',
    ].join("\n");

    const errors = extractErrors(log);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      errorType: "MethodInvocationException",
      file: "C:\\repo\\orchestrator.ps1",
      line: 42,
      column: 7,
      codeLine: "$result = Invoke-Thing",
      message: 'Exception calling "Foo" with "1" argument(s): "bad"',
    });
  });

  it("parses generic error types like ParameterBindingException", async () => {
    const { extractErrors } = await loadAutofix();

    const log = [
      "ParameterBindingException: C:\\repo\\orchestrator.ps1:9:1",
      "Line |",
      "  9 |  Start-Process -FilePath",
      "    |  ~~~~~~~~~~~~~~~~~~~~~~~",
      "    | Missing an argument for parameter 'FilePath'.",
    ].join("\n");

    const errors = extractErrors(log);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      errorType: "ParameterBindingException",
      file: "C:\\repo\\orchestrator.ps1",
      line: 9,
      column: 1,
      codeLine: "Start-Process -FilePath",
      message: "Missing an argument for parameter 'FilePath'.",
    });
  });

  it("deduplicates signatures and ignores terminating errors without file info", async () => {
    const { extractErrors } = await loadAutofix();

    const log = [
      'TerminatingError(ExternalException): "Failed to open file"',
      "RuntimeException: C:\\repo\\orchestrator.ps1:12:5",
      "Line |",
      " 12 |  $foo = bar",
      "    |  ~~~",
      "    | The term 'bar' is not recognized as the name of a cmdlet.",
      "RuntimeException: C:\\repo\\orchestrator.ps1:12:5",
      "Line |",
      " 12 |  $foo = bar",
      "    |  ~~~",
      "    | The term 'bar' is not recognized as the name of a cmdlet.",
    ].join("\n");

    const errors = extractErrors(log);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      errorType: "RuntimeException",
      file: "C:\\repo\\orchestrator.ps1",
      line: 12,
      column: 5,
    });
  });

  it("returns empty array for empty input or warning-only logs", async () => {
    const { extractErrors } = await loadAutofix();

    expect(extractErrors("")).toEqual([]);
    expect(extractErrors("WARNING: all good\nNOTICE: continuing")).toEqual([]);
  });

  it("fails on raw ANSI logs but succeeds after stripping ANSI codes", async () => {
    const { extractErrors } = await loadAutofix();

    const rawLog = [
      "\u001b[31mRuntimeException: C:\\repo\\orchestrator.ps1:7:2\u001b[0m",
      "Line |",
      "  7 |  throw 'boom'",
      "    |  ~",
      "    | boom",
    ].join("\n");
    const stripped = rawLog.replace(/\u001b\[[0-9;]*m/g, "");

    expect(extractErrors(rawLog)).toEqual([]);

    const errors = extractErrors(stripped);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      errorType: "RuntimeException",
      line: 7,
      column: 2,
    });
  });
});

describe("extractFallbackContext", () => {
  it("handles empty logs", async () => {
    const { extractFallbackContext } = await loadAutofix();

    const result = extractFallbackContext("", "exit 1");

    expect(result.lineCount).toBe(0);
    expect(result.tail).toBe("");
    expect(result.errorLines).toEqual([]);
    expect(result.reason).toBe("exit 1");
  });

  it("returns full tail for short logs", async () => {
    const { extractFallbackContext } = await loadAutofix();

    const log = ["booting", "starting monitor", "failed to connect"].join("\n");
    const result = extractFallbackContext(log, "signal SIGTERM");

    expect(result.lineCount).toBe(3);
    expect(result.tail).toBe(log);
    expect(result.errorLines).toEqual(["failed to connect"]);
    expect(result.reason).toBe("signal SIGTERM");
  });

  it("extracts tail and error indicators from long logs", async () => {
    const { extractFallbackContext } = await loadAutofix();

    const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
    lines[85] = "ERROR: request failed";
    lines[95] = "unexpected shutdown";
    const log = lines.join("\n");

    const result = extractFallbackContext(log, "exit 42");

    expect(result.lineCount).toBe(120);
    expect(result.tail.split("\n")).toHaveLength(80);
    expect(result.errorLines).toEqual(
      expect.arrayContaining(["ERROR: request failed", "unexpected shutdown"]),
    );
    expect(result.reason).toBe("exit 42");
  });
});

describe("isDevMode + resetDevModeCache", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns true for AUTOFIX_MODE=dev", async () => {
    const { isDevMode, resetDevModeCache } = await loadAutofix();
    process.env.AUTOFIX_MODE = "dev";
    resetDevModeCache();

    expect(isDevMode()).toBe(true);
  });

  it("returns false for AUTOFIX_MODE=npm (analyze-only)", async () => {
    vi.resetModules();
    const { isDevMode, resetDevModeCache } = await loadAutofix();
    process.env.AUTOFIX_MODE = "npm";
    resetDevModeCache();

    expect(isDevMode()).toBe(false);
  });

  it("falls back to repo detection when mode is missing", async () => {
    vi.resetModules();
    const { isDevMode, resetDevModeCache } = await loadAutofix();
    delete process.env.AUTOFIX_MODE;
    resetDevModeCache();

    expect(isDevMode()).toBe(true);
  });

  it("returns false for explicit analyze-only modes", async () => {
    vi.resetModules();
    const { isDevMode, resetDevModeCache } = await loadAutofix();
    process.env.AUTOFIX_MODE = "analyze";
    resetDevModeCache();
    expect(isDevMode()).toBe(false);

    process.env.AUTOFIX_MODE = "suggest";
    resetDevModeCache();
    expect(isDevMode()).toBe(false);
  });

  it("resets cached value", async () => {
    const { isDevMode, resetDevModeCache } = await loadAutofix();

    process.env.AUTOFIX_MODE = "dev";
    resetDevModeCache();
    expect(isDevMode()).toBe(true);

    process.env.AUTOFIX_MODE = "analyze";
    expect(isDevMode()).toBe(true);

    // After reset, picks up new env value
    resetDevModeCache();
    expect(isDevMode()).toBe(false);
  });
});

describe("getFixAttemptCount", () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(os.tmpdir(), "autofix-test-"));
  });

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    vi.useRealTimers();
  });

  it("increments per signature", async () => {
    vi.useFakeTimers();

    const { getFixAttemptCount, fixLoopingError } = await loadAutofix();
    const signature = "loop:repeating error";

    expect(getFixAttemptCount(signature)).toBe(0);

    vi.setSystemTime(0);
    await fixLoopingError({
      errorLine: "repeating error",
      repeatCount: 2,
      repoRoot: tempDir,
      logDir: tempDir,
    });
    expect(getFixAttemptCount(signature)).toBe(1);

    vi.setSystemTime(5 * 60_000 + 1);
    await fixLoopingError({
      errorLine: "repeating error",
      repeatCount: 3,
      repoRoot: tempDir,
      logDir: tempDir,
    });
    expect(getFixAttemptCount(signature)).toBe(2);
  });

  it("keeps counts isolated per signature", async () => {
    vi.useFakeTimers();

    const { getFixAttemptCount, fixLoopingError } = await loadAutofix();

    vi.setSystemTime(0);
    await fixLoopingError({
      errorLine: "error A",
      repeatCount: 1,
      repoRoot: tempDir,
      logDir: tempDir,
    });

    vi.setSystemTime(61_000);
    await fixLoopingError({
      errorLine: "error B",
      repeatCount: 1,
      repoRoot: tempDir,
      logDir: tempDir,
    });

    expect(getFixAttemptCount("loop:error A")).toBe(1);
    expect(getFixAttemptCount("loop:error B")).toBe(1);
  });
});
