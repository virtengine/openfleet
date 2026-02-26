/**
 * Agent Work Stream Analyzer
 *
 * Tails agent-work-stream.jsonl in real-time, detects patterns, and emits alerts
 * for bosun to consume.
 *
 * Features:
 * - Error loop detection (same error N+ times)
 * - Tool loop detection (same tool called rapidly)
 * - Stuck agent detection (no progress for X minutes)
 * - Context window exhaustion prediction
 * - Cost anomaly detection (unusually expensive sessions)
 */

import { readFile, writeFile, appendFile, stat, watch, mkdir } from "fs/promises";
import { createReadStream, existsSync } from "fs";
import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { resolveRepoRoot } from "./repo-root.mjs";

const repoRoot = resolveRepoRoot({ cwd: process.cwd() });

// ── Configuration ───────────────────────────────────────────────────────────
const AGENT_WORK_STREAM = resolve(
  repoRoot,
  ".cache/agent-work-logs/agent-work-stream.jsonl",
);
const ALERTS_LOG = resolve(
  repoRoot,
  ".cache/agent-work-logs/agent-alerts.jsonl",
);

const ERROR_LOOP_THRESHOLD = Number(
  process.env.AGENT_ERROR_LOOP_THRESHOLD || "4",
);
const ERROR_LOOP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

const TOOL_LOOP_THRESHOLD = Number(
  process.env.AGENT_TOOL_LOOP_THRESHOLD || "10",
);
const TOOL_LOOP_WINDOW_MS = 60 * 1000; // 1 minute

const STUCK_DETECTION_THRESHOLD_MS = Number(
  process.env.AGENT_STUCK_THRESHOLD_MS || String(5 * 60 * 1000),
); // 5 minutes
const STUCK_SWEEP_INTERVAL_MS = Number(
  process.env.AGENT_STUCK_SWEEP_INTERVAL_MS || "30000",
); // 30 seconds
const INITIAL_REPLAY_MAX_SESSION_AGE_MS = Number(
  process.env.AGENT_INITIAL_REPLAY_MAX_SESSION_AGE_MS ||
    String(Math.max(STUCK_DETECTION_THRESHOLD_MS * 3, 15 * 60 * 1000)),
); // Trim stale sessions after startup replay

const COST_ANOMALY_THRESHOLD_USD = Number(
  process.env.AGENT_COST_ANOMALY_THRESHOLD || "1.0",
);

// ── State Tracking ──────────────────────────────────────────────────────────

// Active session state: sessionId -> { ... }
const activeSessions = new Map();

// Alert cooldowns: "alert_type:attempt_id" -> timestamp
const alertCooldowns = new Map();
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between same alert
const FAILED_SESSION_ALERT_MIN_COOLDOWN_MS = 60 * 60 * 1000; // Keep noisy failed-session summaries coarse-grained
const ALERT_COOLDOWN_RETENTION_MS = Math.max(
  FAILED_SESSION_ALERT_MIN_COOLDOWN_MS * 3,
  3 * 60 * 60 * 1000,
); // keep cooldown history bounded
const ALERT_COOLDOWN_REPLAY_MAX_BYTES = Math.max(
  256 * 1024,
  Number(process.env.AGENT_ALERT_COOLDOWN_REPLAY_MAX_BYTES || 2 * 1024 * 1024) || 2 * 1024 * 1024,
);

function getAlertCooldownMs(alert) {
  const type = String(alert?.type || "").trim().toLowerCase();
  if (type === "failed_session_high_errors") {
    return Math.max(ALERT_COOLDOWN_MS, FAILED_SESSION_ALERT_MIN_COOLDOWN_MS);
  }
  return Math.max(0, ALERT_COOLDOWN_MS);
}

function extractTaskToken(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  const prefixMatch = normalized.match(
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:-|$)/i,
  );
  return prefixMatch?.[1] || normalized;
}

function deriveAlertScopeId(alert) {
  const taskId = extractTaskToken(alert?.task_id);
  if (taskId) return taskId;
  return extractTaskToken(alert?.attempt_id);
}

function buildAlertCooldownKey(alert) {
  const type = String(alert?.type || "unknown").trim().toLowerCase() || "unknown";
  const scopeId = deriveAlertScopeId(alert);
  if (scopeId && (type === "failed_session_high_errors" || type === "stuck_agent")) {
    return `${type}:task:${scopeId}`;
  }
  return `${type}:${String(alert?.attempt_id || "unknown")}`;
}

function pruneStaleAlertCooldowns(nowMs = Date.now()) {
  const now = Number(nowMs) || Date.now();
  const cutoff = now - ALERT_COOLDOWN_RETENTION_MS;
  for (const [key, ts] of alertCooldowns.entries()) {
    const lastTs = Number(ts);
    if (!Number.isFinite(lastTs) || lastTs < cutoff) {
      alertCooldowns.delete(key);
    }
  }
}

async function hydrateAlertCooldownsFromLog() {
  if (!existsSync(ALERTS_LOG)) return;
  try {
    const fileStat = await stat(ALERTS_LOG);
    if (!fileStat.size) return;
    const start = Math.max(0, fileStat.size - ALERT_COOLDOWN_REPLAY_MAX_BYTES);
    const stream = createReadStream(ALERTS_LOG, { start, encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    const maxCooldownMs = Math.max(ALERT_COOLDOWN_MS, FAILED_SESSION_ALERT_MIN_COOLDOWN_MS);
    const cutoff = Date.now() - maxCooldownMs;
    for await (const line of rl) {
      const trimmed = String(line || "").trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        const ts = Date.parse(String(entry?.timestamp || ""));
        if (!Number.isFinite(ts) || ts < cutoff) continue;
        const cooldownMs = getAlertCooldownMs(entry);
        if (ts < Date.now() - cooldownMs) continue;
        const key = String(entry?._cooldown_key || "").trim() || buildAlertCooldownKey(entry);
        alertCooldowns.set(key, ts);
      } catch {
        // ignore malformed jsonl
      }
    }
  } catch {
    // best-effort hydration only
  }
}

// ── Log Tailing ─────────────────────────────────────────────────────────────

let filePosition = 0;
let isRunning = false;
let stuckSweepTimer = null;

function parseEnvBoolean(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

/**
 * Start the analyzer loop
 */
export async function startAnalyzer() {
  if (isRunning) return;
  isRunning = true;

  console.log("[agent-work-analyzer] Starting...");

  // Ensure parent directory and alerts log exist
  try {
    const alertsDir = dirname(ALERTS_LOG);
    if (!existsSync(alertsDir)) {
      await mkdir(alertsDir, { recursive: true });
    }
    if (!existsSync(ALERTS_LOG)) {
      await writeFile(ALERTS_LOG, "");
    }
    await hydrateAlertCooldownsFromLog();
  } catch (err) {
    console.warn(`[agent-work-analyzer] Failed to init alerts log: ${err.message}`);
  }

  // Initial positioning for existing log.
  // Default behavior is true tailing (start at EOF) to avoid replaying stale
  // historical sessions on monitor restart, which can re-emit old alerts and
  // trigger noisy false-positive loops. Operators can opt in to replay for
  // forensics via AGENT_ANALYZER_REPLAY_STARTUP=1.
  if (existsSync(AGENT_WORK_STREAM)) {
    const replayStartup = parseEnvBoolean(
      process.env.AGENT_ANALYZER_REPLAY_STARTUP,
      false,
    );
    if (replayStartup) {
      filePosition = await processLogFile(filePosition);
      pruneStaleSessionsAfterReplay();
    } else {
      const streamStats = await stat(AGENT_WORK_STREAM);
      filePosition = Math.max(0, Number(streamStats?.size || 0));
      activeSessions.clear();
    }
  } else {
    // Ensure the stream file exists so the watcher doesn't throw
    try {
      await writeFile(AGENT_WORK_STREAM, "");
    } catch {
      // May fail if another process creates it first — that's fine
    }
  }

  startStuckSweep();

  // Watch for changes — retry loop handles the case where the file
  // is deleted and recreated (e.g. log rotation).
  console.log(`[agent-work-analyzer] Watching: ${AGENT_WORK_STREAM}`);

  while (isRunning) {
    try {
      const watcher = watch(AGENT_WORK_STREAM, { persistent: true });
      for await (const event of watcher) {
        if (!isRunning) break;
        if (event.eventType === "change") {
          filePosition = await processLogFile(filePosition);
        }
      }
    } catch (err) {
      if (!isRunning) break;
      if (err.code === "ENOENT") {
        // File was deleted — wait a bit and retry
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      console.error(`[agent-work-analyzer] Watcher error: ${err.message}`);
      // Wait before retrying to avoid busy-loop
      await new Promise((r) => setTimeout(r, 10000));
    }
  }
}

/**
 * Stop the analyzer
 */
export function stopAnalyzer() {
  isRunning = false;
  if (stuckSweepTimer) {
    clearInterval(stuckSweepTimer);
    stuckSweepTimer = null;
  }
  console.log("[agent-work-analyzer] Stopped");
}

/**
 * Process log file from given position
 * @param {number} startPosition - Byte offset to start reading from
 * @returns {Promise<number>} New file position
 */
async function processLogFile(startPosition) {
  try {
    const stats = await stat(AGENT_WORK_STREAM);
    if (stats.size < startPosition) {
      // Log file was truncated/rotated. Reset offset so new entries are not
      // skipped forever after rotation.
      return 0;
    }
    if (stats.size === startPosition) {
      return startPosition; // No new data
    }

    const stream = createReadStream(AGENT_WORK_STREAM, {
      start: startPosition,
      encoding: "utf8",
    });

    const rl = createInterface({ input: stream });
    let bytesRead = startPosition;

    for await (const line of rl) {
      bytesRead += Buffer.byteLength(line, "utf8") + 1; // +1 for newline

      try {
        const event = JSON.parse(line);
        await analyzeEvent(event);
      } catch (err) {
        console.error(
          `[agent-work-analyzer] Failed to parse log line: ${err.message}`,
        );
      }
    }

    return bytesRead;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[agent-work-analyzer] Error reading log: ${err.message}`);
    }
    return startPosition;
  }
}

// ── Event Analysis ──────────────────────────────────────────────────────────

/**
 * Analyze a single log event
 * @param {Object} event - Parsed JSONL event
 */
async function analyzeEvent(event) {
  const { attempt_id, event_type, timestamp } = event;
  const parsedTs = Date.parse(timestamp);
  const eventTime = Number.isFinite(parsedTs) ? parsedTs : Date.now();
  const eventIso = new Date(eventTime).toISOString();

  // Initialize session state if needed
  if (!activeSessions.has(attempt_id)) {
    activeSessions.set(attempt_id, {
      attempt_id,
      errors: [],
      toolCalls: [],
      lastActivity: eventIso,
      startedAt: eventIso,
      taskId: event.task_id,
      executor: event.executor,
    });
  }

  const session = activeSessions.get(attempt_id);
  session.lastActivity = eventIso;

  // Route to specific analyzers
  switch (event_type) {
    case "error":
      await analyzeError(session, event);
      break;
    case "tool_call":
      await analyzeToolCall(session, event);
      break;
    case "session_start":
      await analyzeSessionStart(session, event);
      break;
    case "session_end":
      await analyzeSessionEnd(session, event);
      activeSessions.delete(attempt_id);
      break;
  }

  // Stuck checks are timer-driven to avoid replay-triggered false positives.
}

// ── Pattern Analyzers ───────────────────────────────────────────────────────

/**
 * Analyze error events for loops
 */
async function analyzeError(session, event) {
  const { error_fingerprint, error_message } = event.data;

  session.errors.push({
    fingerprint: error_fingerprint || "unknown",
    message: error_message,
    timestamp: event.timestamp,
  });

  // Check for error loops
  const cutoff = Date.now() - ERROR_LOOP_WINDOW_MS;
  const recentErrors = session.errors.filter(
    (e) => new Date(e.timestamp).getTime() >= cutoff,
  );

  const errorCounts = {};
  for (const err of recentErrors) {
    errorCounts[err.fingerprint] = (errorCounts[err.fingerprint] || 0) + 1;
  }

  // Alert if same error repeats N+ times
  for (const [fingerprint, count] of Object.entries(errorCounts)) {
    if (count >= ERROR_LOOP_THRESHOLD) {
      await emitAlert({
        type: "error_loop",
        attempt_id: session.attempt_id,
        task_id: session.taskId,
        executor: session.executor,
        error_fingerprint: fingerprint,
        occurrences: count,
        sample_message:
          recentErrors.find((e) => e.fingerprint === fingerprint)?.message ||
          "",
        recommendation: "trigger_ai_autofix",
        severity: "high",
      });
    }
  }
}

/**
 * Analyze tool call events for loops
 */
async function analyzeToolCall(session, event) {
  const { tool_name } = event.data;

  session.toolCalls.push({
    tool: tool_name,
    timestamp: event.timestamp,
  });

  // Check for tool loops
  const cutoff = Date.now() - TOOL_LOOP_WINDOW_MS;
  const recentCalls = session.toolCalls.filter(
    (c) => new Date(c.timestamp).getTime() >= cutoff,
  );

  const toolCounts = {};
  for (const call of recentCalls) {
    toolCounts[call.tool] = (toolCounts[call.tool] || 0) + 1;
  }

  // Alert if same tool called N+ times rapidly
  for (const [tool, count] of Object.entries(toolCounts)) {
    if (count >= TOOL_LOOP_THRESHOLD) {
      await emitAlert({
        type: "tool_loop",
        attempt_id: session.attempt_id,
        task_id: session.taskId,
        executor: session.executor,
        tool_name: tool,
        occurrences: count,
        window_ms: TOOL_LOOP_WINDOW_MS,
        recommendation: "fresh_session",
        severity: "medium",
      });
    }
  }
}

/**
 * Analyze session start events
 */
async function analyzeSessionStart(session, event) {
  const { prompt_type, followup_reason } = event.data;

  // Track session restarts
  if (prompt_type === "followup" || prompt_type === "retry") {
    session.restartCount = (session.restartCount || 0) + 1;

    // Alert if too many restarts
    if (session.restartCount >= 3) {
      await emitAlert({
        type: "excessive_restarts",
        attempt_id: session.attempt_id,
        task_id: session.taskId,
        executor: session.executor,
        restart_count: session.restartCount,
        last_reason: followup_reason,
        recommendation: "manual_review",
        severity: "medium",
      });
    }
  }
}

/**
 * Analyze session end events
 */
async function analyzeSessionEnd(session, event) {
  const { completion_status, duration_ms, cost_usd } = event.data;

  // Cost anomaly detection
  if (cost_usd && cost_usd > COST_ANOMALY_THRESHOLD_USD) {
    await emitAlert({
      type: "cost_anomaly",
      attempt_id: session.attempt_id,
      task_id: session.taskId,
      executor: session.executor,
      cost_usd,
      duration_ms,
      threshold_usd: COST_ANOMALY_THRESHOLD_USD,
      recommendation: "review_prompt_efficiency",
      severity: "low",
    });
  }

  // Failed session with many errors
  if (
    completion_status === "failed" &&
    session.errors.length >= ERROR_LOOP_THRESHOLD
  ) {
    await emitAlert({
      type: "failed_session_high_errors",
      attempt_id: session.attempt_id,
      task_id: session.taskId,
      executor: session.executor,
      error_count: session.errors.length,
      error_fingerprints: [
        ...new Set(session.errors.map((e) => e.fingerprint)),
      ],
      recommendation: "analyze_root_cause",
      severity: "high",
    });
  }
}

/**
 * Check if agent appears stuck (no activity for X minutes)
 */
async function checkStuckAgent(session, nowMs = Date.now()) {
  const lastActivityTime = new Date(session.lastActivity).getTime();
  if (!Number.isFinite(lastActivityTime)) return;
  const timeSinceActivity = nowMs - lastActivityTime;

  if (timeSinceActivity > STUCK_DETECTION_THRESHOLD_MS) {
    await emitAlert({
      type: "stuck_agent",
      attempt_id: session.attempt_id,
      task_id: session.taskId,
      executor: session.executor,
      idle_time_ms: timeSinceActivity,
      threshold_ms: STUCK_DETECTION_THRESHOLD_MS,
      recommendation: "check_agent_health",
      severity: "medium",
    });
  }
}

function pruneStaleSessionsAfterReplay() {
  const now = Date.now();
  for (const [attemptId, session] of activeSessions.entries()) {
    const lastActivityTime = new Date(session.lastActivity).getTime();
    if (
      !Number.isFinite(lastActivityTime) ||
      now - lastActivityTime > INITIAL_REPLAY_MAX_SESSION_AGE_MS
    ) {
      activeSessions.delete(attemptId);
    }
  }
}

async function runStuckSweep() {
  if (!isRunning) return;
  const now = Date.now();
  for (const session of activeSessions.values()) {
    await checkStuckAgent(session, now);
  }
}

function startStuckSweep() {
  if (stuckSweepTimer) return;
  stuckSweepTimer = setInterval(() => {
    runStuckSweep().catch((err) => {
      console.error(
        "[agent-work-analyzer] Stuck sweep failed: " + (err?.message || err),
      );
    });
  }, STUCK_SWEEP_INTERVAL_MS);
  stuckSweepTimer.unref?.();
}

// ── Alert System ────────────────────────────────────────────────────────────

/**
 * Emit an alert to the alerts log
 * @param {Object} alert - Alert data
 */
async function emitAlert(alert) {
  const alertKey = buildAlertCooldownKey(alert);
  const cooldownMs = getAlertCooldownMs(alert);

  // Check cooldown
  const lastAlert = alertCooldowns.get(alertKey);
  if (lastAlert && Date.now() - lastAlert < cooldownMs) {
    return; // Skip duplicate alerts
  }

  alertCooldowns.set(alertKey, Date.now());

  const alertEntry = {
    timestamp: new Date().toISOString(),
    _cooldown_key: alertKey,
    ...alert,
  };

  console.error(`[ALERT] ${alert.type}: ${alert.attempt_id}`);

  // Append to alerts log
  try {
    await appendFile(ALERTS_LOG, JSON.stringify(alertEntry) + "\n");
  } catch (err) {
    console.error(`[agent-work-analyzer] Failed to write alert: ${err.message}`);
  }
}

// ── Cleanup Old Sessions ────────────────────────────────────────────────────

const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour

  for (const [attemptId, session] of activeSessions.entries()) {
    const lastActivityTime = new Date(session.lastActivity).getTime();
    if (lastActivityTime < cutoff) {
      activeSessions.delete(attemptId);
    }
  }
  pruneStaleAlertCooldowns();
}, 10 * 60 * 1000); // Cleanup every 10 minutes
cleanupTimer.unref?.();

// ── Exports ─────────────────────────────────────────────────────────────────
