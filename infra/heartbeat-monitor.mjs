import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
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

function normalizeUiProbeHost(host) {
  const normalized = String(host || "").trim().toLowerCase();
  if (
    !normalized ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]" ||
    normalized === "::0"
  ) {
    return "127.0.0.1";
  }
  return normalized === "localhost" ? "127.0.0.1" : normalized;
}

function buildProbeUrl({ protocol = "http", host = "127.0.0.1", port = 0, healthPath = "/healthz" } = {}) {
  const safeProtocol = String(protocol || "").trim().toLowerCase() === "https" ? "https" : "http";
  const safeHost = normalizeUiProbeHost(host);
  const safePort = Number(port);
  if (!Number.isFinite(safePort) || safePort <= 0 || safePort > 65535) return null;
  const safeHealthPath = String(healthPath || "/healthz").startsWith("/")
    ? String(healthPath || "/healthz")
    : `/${String(healthPath || "healthz")}`;
  return `${safeProtocol}://${safeHost}:${Math.trunc(safePort)}${safeHealthPath}`;
}

function readUiProbeTarget(configDir, fallbackHost = "127.0.0.1", healthPath = "/healthz") {
  try {
    const portPath = resolveUiLastPortPath(configDir);
    if (!existsSync(portPath)) {
      return {
        port: 0,
        host: normalizeUiProbeHost(fallbackHost),
        protocol: "http",
        url: null,
      };
    }
    const payload = JSON.parse(readFileSync(portPath, "utf8"));
    const port = Number(payload?.port || 0);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      return {
        port: 0,
        host: normalizeUiProbeHost(fallbackHost),
        protocol: "http",
        url: null,
      };
    }
    let protocol = String(payload?.protocol || "").trim().toLowerCase() === "https" ? "https" : "http";
    let host = normalizeUiProbeHost(payload?.host || fallbackHost);
    const rawUrl = String(payload?.url || "").trim();
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl);
        if (parsed.port) {
          const parsedPort = Number(parsed.port);
          if (Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort <= 65535) {
            host = normalizeUiProbeHost(parsed.hostname || host);
            protocol = parsed.protocol === "https:" ? "https" : "http";
          }
        }
      } catch {
        // Fall back to discrete metadata fields.
      }
    }
    return {
      port: Math.trunc(port),
      host,
      protocol,
      url: buildProbeUrl({ protocol, host, port, healthPath }),
    };
  } catch {
    return {
      port: 0,
      host: normalizeUiProbeHost(fallbackHost),
      protocol: "http",
      url: null,
    };
  }
}

async function probeWithNodeRequest(target, timeoutMs) {
  const requestImpl = target.protocol === "https" ? httpsRequest : httpRequest;
  return await new Promise((resolveProbe, rejectProbe) => {
    const req = requestImpl(
      {
        protocol: target.protocol === "https" ? "https:" : "http:",
        host: target.host,
        port: target.port,
        path: target.path,
        method: "GET",
        timeout: timeoutMs,
        headers: { accept: "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let payload = null;
          try {
            payload = text ? JSON.parse(text) : null;
          } catch {
            payload = text ? { raw: text } : null;
          }
          resolveProbe({
            ok: Number(res.statusCode || 0) >= 200 && Number(res.statusCode || 0) < 300,
            status: Number(res.statusCode || 0),
            text: async () => text,
            payload,
          });
        });
      },
    );
    req.on("error", rejectProbe);
    req.on("timeout", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      try { req.destroy(error); } catch { /* best effort */ }
    });
    req.end();
  });
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
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : null;
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
      const target = readUiProbeTarget(configDir, options.host || host, healthPath);
      const port = Number(target?.port || 0);
      const baseEntry = {
        ts: new Date(startedAt).toISOString(),
        trigger,
        port,
        url: target?.url || null,
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
        const response = typeof fetchImpl === "function"
          ? await fetchImpl(target.url, {
              signal: controller.signal,
              headers: { accept: "application/json" },
            })
          : await probeWithNodeRequest(
              {
                protocol: target.protocol,
                host: target.host,
                port: target.port,
                path: String(healthPath || "/healthz").startsWith("/")
                  ? String(healthPath || "/healthz")
                  : `/${String(healthPath || "healthz")}`,
              },
              timeoutMs,
            );
        statusCode = Number(response?.status || 0);
        if (response?.payload !== undefined) {
          payload = response.payload;
        } else {
          const text = await response.text();
          try {
            payload = text ? JSON.parse(text) : null;
          } catch {
            payload = text ? { raw: text } : null;
          }
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
