import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { dirname, resolve } from "node:path";

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_SUCCESS_LOG_INTERVAL_MS = 10 * 60_000;
const DEFAULT_EVENT_LOOP_WARN_MS = 1_000;
const DEFAULT_TAIL_LINES = 40;
const DEFAULT_TAIL_BYTES = 16 * 1024;
const HEARTBEAT_LOG_FILE = "heartbeat-monitor.log";
const UI_LAST_PORT_FILE = "ui-last-port.json";

function clampPositiveNumber(value, fallback, min = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min) return fallback;
  return Math.trunc(numeric);
}

function summarizeEventLoopDelay(histogram) {
  if (!histogram) {
    return { meanMs: 0, maxMs: 0, p99Ms: 0 };
  }
  return {
    meanMs: Number((histogram.mean / 1e6).toFixed(3)) || 0,
    maxMs: Number((histogram.max / 1e6).toFixed(3)) || 0,
    p99Ms: Number((histogram.percentile(99) / 1e6).toFixed(3)) || 0,
  };
}

function isAbortTimeoutError(error) {
  const name = String(error?.name || "").trim().toLowerCase();
  const message = String(error?.message || "").trim().toLowerCase();
  return name === "aborterror" || message.includes("aborted");
}

function resolveHeartbeatLogPath(logDir) {
  return resolve(String(logDir || process.cwd()), HEARTBEAT_LOG_FILE);
}

function resolveUiLastPortPath(configDir) {
  return resolve(String(configDir || process.cwd()), ".cache", UI_LAST_PORT_FILE);
}

function readUiLastPort(configDir) {
  try {
    const portPath = resolveUiLastPortPath(configDir);
    if (!existsSync(portPath)) return 0;
    const payload = JSON.parse(readFileSync(portPath, "utf8"));
    const port = Number(payload?.port || 0);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return 0;
    return Math.trunc(port);
  } catch {
    return 0;
  }
}

async function readTail(filePath, { maxLines = DEFAULT_TAIL_LINES, maxBytes = DEFAULT_TAIL_BYTES } = {}) {
  try {
    if (!existsSync(filePath)) return "";
    const handle = await open(filePath, "r");
    try {
      const info = await handle.stat();
      const size = Number(info?.size || 0);
      if (!Number.isFinite(size) || size <= 0) return "";
      const length = Math.max(1, Math.min(size, clampPositiveNumber(maxBytes, DEFAULT_TAIL_BYTES)));
      const offset = Math.max(0, size - length);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      let text = buffer.toString("utf8");
      if (offset > 0) {
        const firstNewline = text.indexOf("\n");
        if (firstNewline >= 0) text = text.slice(firstNewline + 1);
      }
      const lines = text.split(/\r?\n/).filter(Boolean);
      return lines.slice(-Math.max(1, clampPositiveNumber(maxLines, DEFAULT_TAIL_LINES))).join("\n");
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {
    return "";
  }
}

async function readCorrelatedLogContext(logDir, options = {}) {
  const monitorLogTail = await readTail(resolve(String(logDir || process.cwd()), "monitor.log"), options);
  const monitorErrorLogTail = await readTail(resolve(String(logDir || process.cwd()), "monitor-error.log"), options);
  return {
    monitorLogTail,
    monitorErrorLogTail,
  };
}

export function createHeartbeatMonitor(options = {}) {
  const configDir = String(options.configDir || process.cwd());
  const logDir = String(options.logDir || process.cwd());
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  const logger = options.logger && typeof options.logger === "object" ? options.logger : console;
  const host = String(options.host || "127.0.0.1");
  const healthPath = String(options.healthPath || "/healthz");
  const intervalMs = clampPositiveNumber(options.intervalMs, DEFAULT_INTERVAL_MS, 1000);
  const timeoutMs = clampPositiveNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 100);
  const successLogIntervalMs = clampPositiveNumber(
    options.successLogIntervalMs,
    DEFAULT_SUCCESS_LOG_INTERVAL_MS,
    1000,
  );
  const eventLoopWarnMs = clampPositiveNumber(
    options.eventLoopWarnMs,
    DEFAULT_EVENT_LOOP_WARN_MS,
    1,
  );
  const correlationOptions = {
    maxLines: clampPositiveNumber(options.correlationMaxLines, DEFAULT_TAIL_LINES, 1),
    maxBytes: clampPositiveNumber(options.correlationMaxBytes, DEFAULT_TAIL_BYTES, 1024),
  };

  let timer = null;
  let running = false;
  let inflight = null;
  let lastOutcome = "";
  let lastSuccessLogAt = 0;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  const state = {
    lastProbeAt: 0,
    lastSuccessAt: 0,
    lastFailureAt: 0,
    lastOutcome: "not_started",
    lastError: "",
  };

  const logPath = resolveHeartbeatLogPath(logDir);

  function appendLog(entry) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
    } catch {
      // best effort
    }
  }

  async function probeNow(trigger = "interval") {
    if (inflight) return inflight;
    inflight = (async () => {
      const startedAt = Date.now();
      const eventLoop = summarizeEventLoopDelay(histogram);
      histogram.reset();
      const port = readUiLastPort(configDir);
      const baseEntry = {
        ts: new Date(startedAt).toISOString(),
        trigger,
        port,
        url: port > 0 ? `http://${host}:${port}${healthPath}` : null,
        timeoutMs,
        eventLoop,
      };

      if (!port) {
        state.lastProbeAt = startedAt;
        state.lastFailureAt = startedAt;
        state.lastOutcome = "port_missing";
        state.lastError = "ui_last_port_missing";
        const outcome = "port_missing";
        if (outcome !== lastOutcome) {
          appendLog({
            ...baseEntry,
            level: "warn",
            outcome,
            error: "No persisted UI port found for heartbeat probe",
          });
          lastOutcome = outcome;
        }
        return { ok: false, outcome };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      if (typeof timeout.unref === "function") timeout.unref();

      let outcome = "ok";
      let level = "info";
      let statusCode = 0;
      let payload = null;
      let errorMessage = "";
      try {
        const response = await fetchImpl(`http://${host}:${port}${healthPath}`, {
          signal: controller.signal,
          headers: { accept: "application/json" },
        });
        statusCode = Number(response?.status || 0);
        const text = await response.text();
        try {
          payload = text ? JSON.parse(text) : null;
        } catch {
          payload = text ? { raw: text } : null;
        }
        if (!response.ok) {
          outcome = "http_error";
          level = "warn";
        } else if (String(payload?.status || "").trim().toLowerCase() === "degraded") {
          outcome = "degraded";
          level = "warn";
        }
      } catch (error) {
        errorMessage = String(error?.message || error || "");
        outcome = isAbortTimeoutError(error) ? "timeout" : "fetch_error";
        level = "error";
      } finally {
        clearTimeout(timeout);
      }

      const durationMs = Date.now() - startedAt;
      const lagWarning = eventLoop.maxMs >= eventLoopWarnMs || eventLoop.p99Ms >= eventLoopWarnMs;
      const needsCorrelation = outcome !== "ok" || lagWarning;
      const correlatedLogs = needsCorrelation
        ? await readCorrelatedLogContext(logDir, correlationOptions)
        : null;
      const recovered = outcome === "ok" && lastOutcome && lastOutcome !== "ok";
      const shouldLogSuccess =
        outcome === "ok" &&
        (recovered || startedAt - lastSuccessLogAt >= successLogIntervalMs || lagWarning);
      const shouldLog = outcome !== "ok" || shouldLogSuccess || outcome !== lastOutcome;

      state.lastProbeAt = startedAt;
      state.lastOutcome = outcome;
      state.lastError = errorMessage;
      if (outcome === "ok") {
        state.lastSuccessAt = startedAt;
        lastSuccessLogAt = startedAt;
      } else {
        state.lastFailureAt = startedAt;
      }

      if (shouldLog) {
        appendLog({
          ...baseEntry,
          durationMs,
          level,
          outcome: recovered ? "recovered" : outcome,
          previousOutcome: lastOutcome || null,
          statusCode: statusCode || null,
          payload,
          error: errorMessage || null,
          lagWarning,
          correlatedLogs,
        });
      }
      lastOutcome = outcome;

      if (outcome !== "ok" && typeof logger?.warn === "function") {
        logger.warn(
          `[heartbeat] ${outcome} ${baseEntry.url || "(missing url)"} after ${durationMs}ms`,
        );
      }

      return {
        ok: outcome === "ok",
        outcome,
        durationMs,
        statusCode,
        payload,
        error: errorMessage || null,
        lagWarning,
      };
    })().finally(() => {
      inflight = null;
    });

    return inflight;
  }

  return {
    start() {
      if (running) return;
      running = true;
      histogram.enable();
      timer = setInterval(() => {
        void probeNow("interval");
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
      void probeNow("startup");
    },
    stop() {
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      histogram.disable();
    },
    probeNow,
    getSnapshot() {
      return {
        ...state,
        running,
        intervalMs,
        timeoutMs,
        logPath,
      };
    },
  };
}
