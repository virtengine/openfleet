/**
 * Agent Work Stream Analyzer
 *
 * Tails agent-work-stream.jsonl in real-time, detects patterns, and emits alerts
 * for openfleet to consume.
 *
 * Features:
 * - Error loop detection (same error N+ times)
 * - Tool loop detection (same tool called rapidly)
 * - Stuck agent detection (no progress for X minutes)
 * - Context window exhaustion prediction
 * - Cost anomaly detection (unusually expensive sessions)
 */

import { readFile, writeFile, appendFile, stat, watch } from "fs/promises";
import { createReadStream, existsSync } from "fs";
import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

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

const COST_ANOMALY_THRESHOLD_USD = Number(
  process.env.AGENT_COST_ANOMALY_THRESHOLD || "1.0",
);

// ── State Tracking ──────────────────────────────────────────────────────────

// Active session state: sessionId -> { ... }
const activeSessions = new Map();

// Alert cooldowns: "alert_type:attempt_id" -> timestamp
const alertCooldowns = new Map();
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between same alert

// ── Log Tailing ─────────────────────────────────────────────────────────────

let filePosition = 0;
let isRunning = false;

/**
 * Start the analyzer loop
 */
export async function startAnalyzer() {
  if (isRunning) return;
  isRunning = true;

  console.log("[agent-work-analyzer] Starting...");

  // Ensure alerts log exists
  if (!existsSync(ALERTS_LOG)) {
    await writeFile(ALERTS_LOG, "");
  }

  // Initial read of existing log
  if (existsSync(AGENT_WORK_STREAM)) {
    filePosition = await processLogFile(filePosition);
  }

  // Watch for changes
  console.log(`[agent-work-analyzer] Watching: ${AGENT_WORK_STREAM}`);

  const watcher = watch(AGENT_WORK_STREAM, { persistent: true });

  try {
    for await (const event of watcher) {
      if (event.eventType === "change") {
        filePosition = await processLogFile(filePosition);
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[agent-work-analyzer] Watcher error: ${err.message}`);
    }
  }
}

/**
 * Stop the analyzer
 */
export function stopAnalyzer() {
  isRunning = false;
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
    if (stats.size <= startPosition) {
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
  const { attempt_id, event_type, timestamp, data } = event;

  // Initialize session state if needed
  if (!activeSessions.has(attempt_id)) {
    activeSessions.set(attempt_id, {
      attempt_id,
      errors: [],
      toolCalls: [],
      lastActivity: timestamp,
      startedAt: timestamp,
      taskId: event.task_id,
      executor: event.executor,
    });
  }

  const session = activeSessions.get(attempt_id);
  session.lastActivity = timestamp;

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

  // Continuous checks
  await checkStuckAgent(session, event);
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
async function checkStuckAgent(session, event) {
  const lastActivityTime = new Date(session.lastActivity).getTime();
  const timeSinceActivity = Date.now() - lastActivityTime;

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

// ── Alert System ────────────────────────────────────────────────────────────

/**
 * Emit an alert to the alerts log
 * @param {Object} alert - Alert data
 */
async function emitAlert(alert) {
  const alertKey = `${alert.type}:${alert.attempt_id}`;

  // Check cooldown
  const lastAlert = alertCooldowns.get(alertKey);
  if (lastAlert && Date.now() - lastAlert < ALERT_COOLDOWN_MS) {
    return; // Skip duplicate alerts
  }

  alertCooldowns.set(alertKey, Date.now());

  const alertEntry = {
    timestamp: new Date().toISOString(),
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

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000; // 1 hour

  for (const [attemptId, session] of activeSessions.entries()) {
    const lastActivityTime = new Date(session.lastActivity).getTime();
    if (lastActivityTime < cutoff) {
      activeSessions.delete(attemptId);
    }
  }
}, 10 * 60 * 1000); // Cleanup every 10 minutes

// ── Exports ─────────────────────────────────────────────────────────────────

