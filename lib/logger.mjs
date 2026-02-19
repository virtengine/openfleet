/**
 * logger.mjs — Centralized logging for openfleet.
 *
 * Provides leveled logging that separates human-facing CLI output from
 * debug/trace noise. All messages are always written to the log file;
 * only messages at or above the configured console level appear in the terminal.
 *
 * Levels (lowest to highest):
 *   TRACE → DEBUG → INFO → WARN → ERROR → SILENT
 *
 * Usage:
 *   import { createLogger, setLogLevel, setLogFile } from "./lib/logger.mjs";
 *
 *   const log = createLogger("monitor");
 *   log.info("Task completed");     // Shown in terminal (default)
 *   log.debug("Cache hit ratio: 0.95"); // Hidden in terminal, written to log file
 *   log.trace("Processing line 42");    // Only in log file at TRACE level
 *   log.error("Fatal: no config");      // Always shown
 *
 * The module prefix (e.g. [monitor]) is automatically prepended.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { stripAnsi } from "../utils.mjs";

// ── Log levels ──────────────────────────────────────────────────────────────

export const LogLevel = /** @type {const} */ ({
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  SILENT: 5,
});

/** @type {Record<string, number>} */
const LEVEL_MAP = {
  trace: LogLevel.TRACE,
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
  silent: LogLevel.SILENT,
};

// ── Global state ────────────────────────────────────────────────────────────

/** @type {number} Console output threshold — messages below this level are suppressed in terminal */
let consoleLevel = LogLevel.INFO;

/** @type {number} File output threshold — messages below this level are not written to log file */
let fileLevel = LogLevel.DEBUG;

/** @type {string|null} Path to the log file */
let logFilePath = null;

/** @type {string|null} Path to the dedicated error/stderr log file */
let errorLogFilePath = null;

/** @type {boolean} Whether the log file directory has been ensured */
let logDirEnsured = false;

/** @type {boolean} Whether the error log directory has been ensured */
let errorLogDirEnsured = false;

/** @type {Set<string>} Modules to always show at DEBUG level even when console is at INFO */
const verboseModules = new Set();

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * Set the minimum console log level.
 * @param {string|number} level - Level name ("trace", "debug", "info", "warn", "error", "silent") or LogLevel value
 */
export function setConsoleLevel(level) {
  if (typeof level === "string") {
    consoleLevel = LEVEL_MAP[level.toLowerCase()] ?? LogLevel.INFO;
  } else {
    consoleLevel = level;
  }
}

/**
 * Set the minimum file log level.
 * @param {string|number} level
 */
export function setFileLevel(level) {
  if (typeof level === "string") {
    fileLevel = LEVEL_MAP[level.toLowerCase()] ?? LogLevel.DEBUG;
  } else {
    fileLevel = level;
  }
}

/**
 * Set the log file path. All messages at or above the file level are appended here.
 * @param {string|null} path
 */
export function setLogFile(path) {
  logFilePath = path;
  logDirEnsured = false;
  ensureLogFile(logFilePath, (value) => {
    logDirEnsured = value;
  });
}

/**
 * Set the dedicated error log file path.
 * WARN, ERROR, uncaughtException/unhandledRejection, and raw stderr writes are appended here.
 * @param {string|null} path
 */
export function setErrorLogFile(path) {
  errorLogFilePath = path;
  errorLogDirEnsured = false;
  ensureLogFile(errorLogFilePath, (value) => {
    errorLogDirEnsured = value;
  });
}

/**
 * Get the current error log file path.
 * @returns {string|null}
 */
export function getErrorLogFilePath() {
  return errorLogFilePath;
}

/**
 * Parse CLI args for logging flags and configure accordingly.
 * Call this once at startup before any logging.
 *
 * Flags:
 *   --quiet        Only show errors and warnings
 *   --verbose      Show debug messages too
 *   --trace        Show everything
 *   --silent       No console output
 *   --log-level X  Set explicit level
 *
 * @param {string[]} argv
 */
export function configureFromArgs(argv) {
  if (argv.includes("--silent")) {
    setConsoleLevel(LogLevel.SILENT);
  } else if (argv.includes("--quiet") || argv.includes("-q")) {
    setConsoleLevel(LogLevel.WARN);
  } else if (argv.includes("--trace")) {
    setConsoleLevel(LogLevel.TRACE);
  } else if (argv.includes("--verbose") || argv.includes("-V")) {
    setConsoleLevel(LogLevel.DEBUG);
  }

  const levelIdx = argv.indexOf("--log-level");
  if (levelIdx !== -1 && argv[levelIdx + 1]) {
    setConsoleLevel(argv[levelIdx + 1]);
  }
}

/**
 * Enable verbose (DEBUG-level) output for specific modules even at INFO level.
 * @param {string[]} modules
 */
export function setVerboseModules(modules) {
  verboseModules.clear();
  for (const m of modules) verboseModules.add(m.toLowerCase());
}

/**
 * Get the current console log level.
 * @returns {number}
 */
export function getConsoleLevel() {
  return consoleLevel;
}

// ── Timestamp ───────────────────────────────────────────────────────────────

function timestamp() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function datestamp() {
  return new Date().toISOString();
}

function ensureLogFile(path, markEnsured) {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, "");
    if (markEnsured) markEnsured(true);
  } catch {
    if (markEnsured) markEnsured(false);
  }
}

// ── File writing ────────────────────────────────────────────────────────────

function writeToFile(levelName, module, msg) {
  if (!logFilePath) return;
  if (!logDirEnsured) {
    try {
      mkdirSync(dirname(logFilePath), { recursive: true });
    } catch {
      /* best effort */
    }
    logDirEnsured = true;
  }
  const clean = typeof msg === "string" ? stripAnsi(msg) : String(msg);
  const line = `${datestamp()} [${levelName}] [${module}] ${clean}\n`;
  try {
    appendFileSync(logFilePath, line);
  } catch {
    /* best effort */
  }
}

/**
 * Write a message to the dedicated error log file.
 * Called for WARN, ERROR, and raw stderr writes.
 * @param {string} levelName
 * @param {string} module
 * @param {string} msg
 */
function writeToErrorFile(levelName, module, msg) {
  if (!errorLogFilePath) return;
  if (!errorLogDirEnsured) {
    try {
      mkdirSync(dirname(errorLogFilePath), { recursive: true });
    } catch {
      /* best effort */
    }
    errorLogDirEnsured = true;
  }
  const clean = typeof msg === "string" ? stripAnsi(msg) : String(msg);
  const line = `${datestamp()} [${levelName}] [${module}] ${clean}\n`;
  try {
    appendFileSync(errorLogFilePath, line);
  } catch {
    /* best effort */
  }
}

// ── Logger factory ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} Logger
 * @property {(...args: any[]) => void} error - Always shown in terminal
 * @property {(...args: any[]) => void} warn  - Shown at WARN+ level
 * @property {(...args: any[]) => void} info  - Shown at INFO+ level (default)
 * @property {(...args: any[]) => void} debug - Shown at DEBUG+ level or via --verbose
 * @property {(...args: any[]) => void} trace - Shown at TRACE+ level or via --trace
 */

/**
 * Create a logger for a specific module.
 *
 * @param {string} module - Module name (e.g. "monitor", "fleet", "telegram-bot")
 * @returns {Logger}
 */
export function createLogger(module) {
  const prefix = `[${module}]`;
  const moduleLower = module.toLowerCase();

  function emit(level, levelName, consoleFn, args) {
    const msg = args
      .map((a) => (typeof a === "string" ? a : String(a)))
      .join(" ");

    // Always write to file if above file threshold
    if (level >= fileLevel) {
      writeToFile(levelName, module, msg);
    }

    // Console output: check level threshold
    // Module-specific verbose override: show DEBUG for this module even at INFO level
    const effectiveLevel =
      level === LogLevel.DEBUG && verboseModules.has(moduleLower)
        ? LogLevel.INFO
        : level;

    if (effectiveLevel >= consoleLevel) {
      const ts = timestamp();
      consoleFn(`  ${ts} ${prefix} ${msg}`);
    }
  }

  return {
    error: (...args) => emit(LogLevel.ERROR, "ERROR", console.error, args),
    warn: (...args) => emit(LogLevel.WARN, "WARN", console.warn, args),
    info: (...args) => emit(LogLevel.INFO, "INFO", console.log, args),
    debug: (...args) => emit(LogLevel.DEBUG, "DEBUG", console.log, args),
    trace: (...args) => emit(LogLevel.TRACE, "TRACE", console.log, args),
  };
}

// ── Console interceptor ─────────────────────────────────────────────────────
//
// Intercepts console.log / console.warn / console.error globally and routes
// messages through the leveled logger.  This lets us filter 700+ existing
// console.* calls without touching every call-site.
//
// Classification rules:
//   1. Messages starting with `[tag] ` are auto-classified by tag + keywords.
//   2. Messages without a tag prefix pass through as INFO (human-facing output).
//   3. console.warn → WARN, console.error → ERROR (always pass through).
//

/** @type {boolean} */
let interceptorInstalled = false;

// Keywords that promote a tagged message to INFO — MUST be narrow.
// Only truly human-critical events that require operator attention.
const INFO_KEYWORDS = [
  "fatal",
  "crash",
  "circuit breaker",
  "self-restart",
  "shutting down",
  "all tasks complete",
  "stuck",
  "preflight failed",
  "manual resolution",
  "backlog empty",
  "permanently failed",
  "retries exhausted",
];

// Keywords that push a tagged message down to TRACE (very noisy internals)
const TRACE_KEYWORDS = [
  "skipping",
  "dedup",
  "rate limit",
  "throttl",
  "already in progress",
  "no change",
  "unchanged",
  "cache miss",
  "cache hit",
  "nothing to",
  "same as last",
  "too soon",
  "polling",
  "heartbeat",
  "ping",
  "byte",
  "chunk",
  "offset",
  "cursor",
  "checking port",
  "line count",
  "no old completed",
  "cooldown",
  "score:",
  "attempt ",
];

// Modules whose tagged messages default to DEBUG unless INFO_KEYWORDS match
const DEBUG_MODULES = new Set([
  "monitor",
  "fleet",
  "telegram-bot",
  "telegram",
  "vk",
  "vk-log",
  "vk-dispatch",
  "workspace-monitor",
  "maintenance",
  "autofix",
  "config",
  "conflict",
  "merge-strategy",
  "task-complexity",
  "shared-knowledge",
  "preflight",
  "codex-config",
  "task-archiver",
  "update-check",
  "restart-controller",
  "sdk-conflict",
  "fleet-coordinator",
  "conflict-resolver",
  "primary-agent",
  "task-assessment",
  "setup",
  "analyze",
]);

// Pattern: [tag] message  or  [tag]  message (extra space)
const TAG_RE = /^\[([^\]]+)\]\s*/;

/**
 * Classify a console.log message into a LogLevel.
 * @param {string} msg - The first argument to console.log
 * @returns {number} LogLevel
 */
function classifyMessage(msg) {
  if (typeof msg !== "string") return LogLevel.INFO;

  const tagMatch = msg.match(TAG_RE);
  if (!tagMatch) {
    // No [tag] prefix — human-facing output, always INFO
    return LogLevel.INFO;
  }

  const tag = tagMatch[1].toLowerCase();
  const body = msg.slice(tagMatch[0].length).toLowerCase();

  // Check for TRACE keywords first (most restrictive)
  for (const kw of TRACE_KEYWORDS) {
    if (body.includes(kw)) return LogLevel.TRACE;
  }

  // Check for INFO keywords (important events worth showing)
  for (const kw of INFO_KEYWORDS) {
    if (body.includes(kw)) return LogLevel.INFO;
  }

  // If the module is in our DEBUG set, default to DEBUG
  if (DEBUG_MODULES.has(tag)) return LogLevel.DEBUG;

  // Unknown tags → INFO (assume user-facing)
  return LogLevel.INFO;
}

/**
 * Install the global console interceptor.
 * Call once at startup before any significant logging.
 *
 * This replaces console.log / console.warn / console.error with filtered
 * versions that respect the configured console level.
 *
 * - console.error → always ERROR level (passes through)
 * - console.warn  → always WARN level
 * - console.log   → auto-classified by tag/content
 *
 * @param {Object} [opts]
 * @param {string} [opts.logFile] - Path to the log file
 */
export function installConsoleInterceptor(opts = {}) {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  if (opts.logFile) setLogFile(opts.logFile);

  const _origLog = console.log.bind(console);
  const _origWarn = console.warn.bind(console);
  const _origError = console.error.bind(console);

  // Replace console.log with filtered version
  console.log = (...args) => {
    const first = args[0];
    const level = classifyMessage(first);

    // Always write to file
    if (logFilePath && level >= fileLevel) {
      const msg = args
        .map((a) => (typeof a === "string" ? a : String(a)))
        .join(" ");
      const tagMatch = typeof first === "string" ? first.match(TAG_RE) : null;
      const mod = tagMatch ? tagMatch[1] : "stdout";
      const levelName =
        Object.keys(LogLevel).find((k) => LogLevel[k] === level) || "INFO";
      writeToFile(levelName, mod, msg);
    }

    // Console output
    if (level >= consoleLevel) {
      _origLog(...args);
    }
  };

  // console.warn → always WARN level
  console.warn = (...args) => {
    _inInterceptor = true;
    try {
      const msg = args
        .map((a) => (typeof a === "string" ? a : String(a)))
        .join(" ");
      const tagMatch = typeof msg === "string" ? msg.match(TAG_RE) : null;
      const mod = tagMatch?.[1] || "stderr";
      if (logFilePath && LogLevel.WARN >= fileLevel) {
        writeToFile("WARN", mod, msg);
      }
      // Also write to dedicated error log
      writeToErrorFile("WARN", mod, msg);
      if (LogLevel.WARN >= consoleLevel) {
        _origWarn(...args);
      }
    } finally {
      _inInterceptor = false;
    }
  };

  // console.error → always ERROR level (always passes through)
  console.error = (...args) => {
    _inInterceptor = true;
    try {
      const msg = args
        .map((a) => {
          if (a instanceof Error) return a.stack || a.message;
          return typeof a === "string" ? a : String(a);
        })
        .join(" ");
      const tagMatch = typeof msg === "string" ? msg.match(TAG_RE) : null;
      const mod = tagMatch?.[1] || "stderr";
      if (logFilePath && LogLevel.ERROR >= fileLevel) {
        writeToFile("ERROR", mod, msg);
      }
      // Also write to dedicated error log
      writeToErrorFile("ERROR", mod, msg);
      // Errors always pass through
      _origError(...args);
    } finally {
      _inInterceptor = false;
    }
  };

  // ── Intercept raw process.stderr.write ────────────────────────────────
  // Some code (uncaughtException handlers, native Node errors, child_process
  // stderr leaks) writes to process.stderr directly, bypassing console.
  // Tee those writes to the error log file, but skip writes that originate
  // from our own console.warn/error interceptors to avoid duplicates.
  let _inInterceptor = false;
  const _origStderrWrite = process.stderr.write.bind(process.stderr);
  let _stderrBroken = false;
  const isBenignStderrError = (err) =>
    !!(
      err &&
      (err.code === "EPIPE" ||
        err.code === "EIO" ||
        err.code === "ERR_STREAM_DESTROYED" ||
        err.code === "ERR_STREAM_WRITE_AFTER_END" ||
        /\bEIO\b/.test(err.message) ||
        /\bEPIPE\b/.test(err.message))
    );
  const markStderrBroken = (err) => {
    if (_stderrBroken) return true;
    if (isBenignStderrError(err)) {
      _stderrBroken = true;
      return true;
    }
    return false;
  };
  process.stderr.on("error", (err) => {
    if (markStderrBroken(err)) {
      writeToErrorFile("STDERR", "process", `stderr error: ${err?.message || err}`);
      return;
    }
    // If stderr errors for an unexpected reason, record it but avoid crashing.
    writeToErrorFile("STDERR", "process", `stderr unexpected error: ${err?.message || err}`);
  });
  const safeStderrWrite = (chunk, ...rest) => {
    if (
      _stderrBroken ||
      !process.stderr.writable ||
      process.stderr.destroyed ||
      process.stderr.writableEnded
    ) {
      _stderrBroken = true;
      return false;
    }
    try {
      return _origStderrWrite(chunk, ...rest);
    } catch (err) {
      if (markStderrBroken(err)) {
        return false;
      }
      throw err;
    }
  };
  process.stderr.write = (chunk, ...rest) => {
    if (!_inInterceptor) {
      const text = typeof chunk === "string" ? chunk : chunk?.toString?.("utf8") || "";
      if (text.trim()) {
        writeToErrorFile("STDERR", "process", text.replace(/\n$/, ""));
      }
    }
    return safeStderrWrite(chunk, ...rest);
  };

  // ── Harden stdout against broken pipes ────────────────────────────────
  const _origStdoutWrite = process.stdout.write.bind(process.stdout);
  let _stdoutBroken = false;
  const isBenignStdoutError = (err) =>
    !!(
      err &&
      (err.code === "EPIPE" ||
        err.code === "EIO" ||
        err.code === "ERR_STREAM_DESTROYED" ||
        err.code === "ERR_STREAM_WRITE_AFTER_END" ||
        /\bEIO\b/.test(err.message) ||
        /\bEPIPE\b/.test(err.message))
    );
  const markStdoutBroken = (err) => {
    if (_stdoutBroken) return true;
    if (isBenignStdoutError(err)) {
      _stdoutBroken = true;
      return true;
    }
    return false;
  };
  process.stdout.on("error", (err) => {
    if (markStdoutBroken(err)) {
      writeToErrorFile("STDOUT", "process", `stdout error: ${err?.message || err}`);
      return;
    }
    writeToErrorFile("STDOUT", "process", `stdout unexpected error: ${err?.message || err}`);
  });
  const safeStdoutWrite = (chunk, ...rest) => {
    if (
      _stdoutBroken ||
      !process.stdout.writable ||
      process.stdout.destroyed ||
      process.stdout.writableEnded
    ) {
      _stdoutBroken = true;
      return false;
    }
    try {
      return _origStdoutWrite(chunk, ...rest);
    } catch (err) {
      if (markStdoutBroken(err)) {
        return false;
      }
      throw err;
    }
  };
  process.stdout.write = (chunk, ...rest) => safeStdoutWrite(chunk, ...rest);
}

/**
 * Restore original console methods (for testing).
 */
export function uninstallConsoleInterceptor() {
  // Can't easily restore — this is a best-effort for tests
  interceptorInstalled = false;
}

export default createLogger;
