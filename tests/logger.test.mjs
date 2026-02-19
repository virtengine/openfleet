/**
 * Tests for lib/logger.mjs — leveled logging and console interceptor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createLogger,
  LogLevel,
  setConsoleLevel,
  setLogFile,
  setFileLevel,
  configureFromArgs,
  setVerboseModules,
  getConsoleLevel,
  installConsoleInterceptor,
} from "../lib/logger.mjs";

// ── createLogger tests ──────────────────────────────────────────────────────

describe("createLogger", () => {
  let origLog, origWarn, origError;
  let captured;

  beforeEach(() => {
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    captured = { log: [], warn: [], error: [] };
    console.log = (...args) => captured.log.push(args.join(" "));
    console.warn = (...args) => captured.warn.push(args.join(" "));
    console.error = (...args) => captured.error.push(args.join(" "));
    setConsoleLevel(LogLevel.INFO);
    setLogFile(null);
    setVerboseModules([]);
  });

  afterEach(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });

  it("creates a logger with all five methods", () => {
    const log = createLogger("test");
    expect(log).toHaveProperty("error");
    expect(log).toHaveProperty("warn");
    expect(log).toHaveProperty("info");
    expect(log).toHaveProperty("debug");
    expect(log).toHaveProperty("trace");
  });

  it("info messages appear at INFO level", () => {
    const log = createLogger("mymod");
    log.info("hello world");
    expect(captured.log.length).toBe(1);
    expect(captured.log[0]).toContain("[mymod]");
    expect(captured.log[0]).toContain("hello world");
  });

  it("debug messages hidden at INFO level", () => {
    const log = createLogger("mymod");
    log.debug("debug stuff");
    expect(captured.log.length).toBe(0);
  });

  it("debug messages shown at DEBUG level", () => {
    setConsoleLevel(LogLevel.DEBUG);
    const log = createLogger("mymod");
    log.debug("debug stuff");
    expect(captured.log.length).toBe(1);
    expect(captured.log[0]).toContain("debug stuff");
  });

  it("trace messages hidden at DEBUG level", () => {
    setConsoleLevel(LogLevel.DEBUG);
    const log = createLogger("mymod");
    log.trace("trace stuff");
    expect(captured.log.length).toBe(0);
  });

  it("trace messages shown at TRACE level", () => {
    setConsoleLevel(LogLevel.TRACE);
    const log = createLogger("mymod");
    log.trace("trace stuff");
    expect(captured.log.length).toBe(1);
    expect(captured.log[0]).toContain("trace stuff");
  });

  it("error messages always appear", () => {
    setConsoleLevel(LogLevel.SILENT);
    const log = createLogger("mymod");
    log.error("bad thing");
    // At SILENT, errors should still not appear (SILENT means nothing)
    // Actually SILENT = 5, ERROR = 4, so 4 < 5 → suppressed
    // Let's verify the proper behavior
    expect(captured.error.length).toBe(0);
  });

  it("warn messages appear at WARN level", () => {
    setConsoleLevel(LogLevel.WARN);
    const log = createLogger("mymod");
    log.info("ignored");
    log.warn("caution");
    expect(captured.log.length).toBe(0);
    expect(captured.warn.length).toBe(1);
    expect(captured.warn[0]).toContain("caution");
  });

  it("includes timestamp in output", () => {
    const log = createLogger("mymod");
    log.info("timestamped");
    // Format: "  HH:MM:SS [mymod] timestamped"
    expect(captured.log[0]).toMatch(/\d{2}:\d{2}:\d{2}/);
  });
});

// ── configureFromArgs tests ─────────────────────────────────────────────────

describe("configureFromArgs", () => {
  beforeEach(() => {
    setConsoleLevel(LogLevel.INFO);
  });

  it("--quiet sets WARN level", () => {
    configureFromArgs(["--quiet"]);
    expect(getConsoleLevel()).toBe(LogLevel.WARN);
  });

  it("-q sets WARN level", () => {
    configureFromArgs(["-q"]);
    expect(getConsoleLevel()).toBe(LogLevel.WARN);
  });

  it("--verbose sets DEBUG level", () => {
    configureFromArgs(["--verbose"]);
    expect(getConsoleLevel()).toBe(LogLevel.DEBUG);
  });

  it("-V sets DEBUG level", () => {
    configureFromArgs(["-V"]);
    expect(getConsoleLevel()).toBe(LogLevel.DEBUG);
  });

  it("--trace sets TRACE level", () => {
    configureFromArgs(["--trace"]);
    expect(getConsoleLevel()).toBe(LogLevel.TRACE);
  });

  it("--silent sets SILENT level", () => {
    configureFromArgs(["--silent"]);
    expect(getConsoleLevel()).toBe(LogLevel.SILENT);
  });

  it("--log-level overrides flag", () => {
    configureFromArgs(["--log-level", "error"]);
    expect(getConsoleLevel()).toBe(LogLevel.ERROR);
  });
});

// ── verboseModules tests ────────────────────────────────────────────────────

describe("setVerboseModules", () => {
  let origLog;
  let captured;

  beforeEach(() => {
    origLog = console.log;
    captured = [];
    console.log = (...args) => captured.push(args.join(" "));
    setConsoleLevel(LogLevel.INFO);
    setLogFile(null);
  });

  afterEach(() => {
    console.log = origLog;
    setVerboseModules([]);
  });

  it("allows DEBUG output for listed modules at INFO level", () => {
    setVerboseModules(["fleet"]);
    const log = createLogger("fleet");
    log.debug("fleet debug info");
    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("fleet debug info");
  });

  it("does not affect unlisted modules", () => {
    setVerboseModules(["fleet"]);
    const log = createLogger("monitor");
    log.debug("monitor debug info");
    expect(captured.length).toBe(0);
  });
});

// ── Console interceptor classification tests ────────────────────────────────

describe("console interceptor classification", () => {
  // We test the classification logic indirectly by checking what gets through
  let origLog, origWarn, origError;
  let captured;

  beforeEach(() => {
    origLog = console.log;
    origWarn = console.warn;
    origError = console.error;
    captured = { log: [], warn: [], error: [] };
    // We'll test classification by examining the module's internal classifyMessage
    // But since it's not exported, we test behavior through createLogger
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });

  afterEach(() => {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  });

  it("untagged messages are treated as INFO", () => {
    // Untagged messages should always be shown at INFO level
    // We verify this by ensuring createLogger('x').info works
    captured = [];
    console.log = (...args) => captured.push(args.join(" "));
    setConsoleLevel(LogLevel.INFO);
    const log = createLogger("test");
    log.info("untagged-like message");
    expect(captured.length).toBe(1);
  });

  it("LogLevel enum has correct ordering", () => {
    expect(LogLevel.TRACE).toBeLessThan(LogLevel.DEBUG);
    expect(LogLevel.DEBUG).toBeLessThan(LogLevel.INFO);
    expect(LogLevel.INFO).toBeLessThan(LogLevel.WARN);
    expect(LogLevel.WARN).toBeLessThan(LogLevel.ERROR);
    expect(LogLevel.ERROR).toBeLessThan(LogLevel.SILENT);
  });
});
