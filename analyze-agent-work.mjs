#!/usr/bin/env node
/**
 * Agent Work Analytics CLI
 *
 * Offline analysis of agent work logs for:
 * - Backlog task analysis
 * - Task planning insights
 * - Executor performance comparison
 * - Error clustering
 * - Success metrics
 *
 * Usage:
 *   node analyze-agent-work.mjs --backlog-tasks 10
 *   node analyze-agent-work.mjs --error-clustering --days 7
 *   node analyze-agent-work.mjs --executor-comparison CODEX COPILOT
 *   node analyze-agent-work.mjs --task-planning --failed-only
 *   node analyze-agent-work.mjs --weekly-report
 */

import { readFile, readdir } from "fs/promises";
import { createReadStream, existsSync } from "fs";
import { createInterface } from "readline";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../..");

// ── Log Paths ───────────────────────────────────────────────────────────────
const LOG_DIR = resolve(repoRoot, ".cache/agent-work-logs");
const STREAM_LOG = resolve(LOG_DIR, "agent-work-stream.jsonl");
const ERRORS_LOG = resolve(LOG_DIR, "agent-errors.jsonl");
const METRICS_LOG = resolve(LOG_DIR, "agent-metrics.jsonl");
const SESSIONS_DIR = resolve(LOG_DIR, "agent-sessions");

// ── Data Loaders ────────────────────────────────────────────────────────────

/**
 * Load all events from stream log
 */
async function loadEvents(options = {}) {
  const events = [];

  if (!existsSync(STREAM_LOG)) {
    return events;
  }

  const stream = createReadStream(STREAM_LOG, { encoding: "utf8" });
  const rl = createInterface({ input: stream });

  for await (const line of rl) {
    try {
      const event = JSON.parse(line);

      // Filter by date if specified
      if (options.days) {
        const cutoff = Date.now() - options.days * 24 * 60 * 60 * 1000;
        if (new Date(event.timestamp).getTime() < cutoff) continue;
      }

      events.push(event);
    } catch (err) {
      // Skip malformed lines
    }
  }

  return events;
}

/**
 * Load all session metrics
 */
async function loadMetrics(options = {}) {
  const metrics = [];

  if (!existsSync(METRICS_LOG)) {
    return metrics;
  }

  const stream = createReadStream(METRICS_LOG, { encoding: "utf8" });
  const rl = createInterface({ input: stream });

  for await (const line of rl) {
    try {
      const metric = JSON.parse(line);

      // Filter by date
      if (options.days) {
        const cutoff = Date.now() - options.days * 24 * 60 * 60 * 1000;
        if (new Date(metric.timestamp).getTime() < cutoff) continue;
      }

      metrics.push(metric);
    } catch (err) {
      // Skip malformed lines
    }
  }

  return metrics;
}

/**
 * Load errors from error log
 */
async function loadErrors(options = {}) {
  const errors = [];

  if (!existsSync(ERRORS_LOG)) {
    return errors;
  }

  const stream = createReadStream(ERRORS_LOG, { encoding: "utf8" });
  const rl = createInterface({ input: stream });

  for await (const line of rl) {
    try {
      const error = JSON.parse(line);

      // Filter by date
      if (options.days) {
        const cutoff = Date.now() - options.days * 24 * 60 * 60 * 1000;
        if (new Date(error.timestamp).getTime() < cutoff) continue;
      }

      errors.push(error);
    } catch (err) {
      // Skip malformed lines
    }
  }

  return errors;
}

/**
 * Load events for a specific session
 */
async function loadSessionEvents(attemptId) {
  const events = [];
  const sessionLog = resolve(SESSIONS_DIR, `${attemptId}.jsonl`);

  if (!existsSync(sessionLog)) {
    return events;
  }

  const stream = createReadStream(sessionLog, { encoding: "utf8" });
  const rl = createInterface({ input: stream });

  for await (const line of rl) {
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      // Skip malformed lines
    }
  }

  return events;
}

// ── Utility Functions ───────────────────────────────────────────────────────

function groupBy(array, keyFn) {
  const groups = {};
  for (const item of array) {
    const key = typeof keyFn === "function" ? keyFn(item) : item[keyFn];
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function average(numbers) {
  if (numbers.length === 0) return 0;
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function sum(numbers) {
  return numbers.reduce((a, b) => a + b, 0);
}

function percentage(array, predicate) {
  if (array.length === 0) return 0;
  const count = array.filter(predicate).length;
  return (count * 100.0) / array.length;
}

function countFrequency(array) {
  const freq = {};
  for (const item of array) {
    freq[item] = (freq[item] || 0) + 1;
  }
  return freq;
}

function topN(obj, n) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

// ── Analysis Commands ───────────────────────────────────────────────────────

/**
 * Analyze backlog tasks
 */
async function analyzeBacklog(options) {
  console.log("\n=== Backlog Task Analysis ===\n");

  const metrics = await loadMetrics({ days: options.days || 30 });

  if (metrics.length === 0) {
    console.log("No metrics data found");
    return;
  }

  // Group by task
  const byTask = groupBy(metrics, "task_id");

  // Sort by most attempts first
  const taskSummaries = Object.entries(byTask)
    .map(([taskId, sessions]) => {
      const firstSession = sessions[0];
      const completed = sessions.some((s) => s.outcome?.status === "completed");
      const firstShotSuccess =
        sessions.length === 1 && sessions[0].outcome?.status === "completed";

      return {
        task_id: taskId,
        task_title: firstSession.task_id, // Would need to join with VK task data
        attempts: sessions.length,
        success: completed,
        first_shot_success: firstShotSuccess,
        total_duration_ms: sum(sessions.map((s) => s.metrics?.duration_ms || 0)),
        total_cost: sum(sessions.map((s) => s.metrics?.cost_usd || 0)),
        total_errors: sum(sessions.map((s) => s.error_summary?.total_errors || 0)),
        executors: [...new Set(sessions.map((s) => s.executor))],
        error_fingerprints: [
          ...new Set(
            sessions.flatMap((s) => s.error_summary?.error_fingerprints || []),
          ),
        ],
      };
    })
    .sort((a, b) => b.attempts - a.attempts);

  // Show top N tasks
  const limit = options.limit || 10;
  const topTasks = taskSummaries.slice(0, limit);

  for (const task of topTasks) {
    console.log(`\nTask: ${task.task_id}`);
    console.log(`  Attempts: ${task.attempts}`);
    console.log(`  Success: ${task.success ? "✓" : "✗"}`);
    console.log(
      `  First-shot: ${task.first_shot_success ? "✓" : "✗"}`,
    );
    console.log(
      `  Duration: ${Math.round(task.total_duration_ms / 1000)}s`,
    );
    console.log(`  Cost: $${task.total_cost.toFixed(3)}`);
    console.log(`  Errors: ${task.total_errors}`);
    console.log(`  Executors: ${task.executors.join(", ")}`);

    if (task.error_fingerprints.length > 0) {
      console.log(`  Common errors: ${task.error_fingerprints.slice(0, 3).join(", ")}`);
    }
  }

  // Summary stats
  console.log("\n=== Summary ===");
  console.log(`Total unique tasks: ${taskSummaries.length}`);
  console.log(
    `Success rate: ${percentage(taskSummaries, (t) => t.success).toFixed(1)}%`,
  );
  console.log(
    `First-shot rate: ${percentage(taskSummaries, (t) => t.first_shot_success).toFixed(1)}%`,
  );
  console.log(
    `Avg attempts per task: ${average(taskSummaries.map((t) => t.attempts)).toFixed(1)}`,
  );
}

/**
 * Cluster errors by fingerprint
 */
async function clusterErrors(options) {
  console.log("\n=== Error Clustering Analysis ===\n");

  const errors = await loadErrors({ days: options.days || 7 });

  if (errors.length === 0) {
    console.log("No error data found");
    return;
  }

  // Group by fingerprint
  const byFingerprint = groupBy(
    errors,
    (e) => e.data?.error_fingerprint || "unknown",
  );

  // Build clusters
  const clusters = Object.entries(byFingerprint)
    .map(([fingerprint, events]) => ({
      fingerprint,
      count: events.length,
      affected_tasks: new Set(events.map((e) => e.task_id)).size,
      affected_attempts: new Set(events.map((e) => e.attempt_id)).size,
      first_seen: events[0].timestamp,
      last_seen: events[events.length - 1].timestamp,
      sample_message: events[0].data?.error_message || "",
      categories: [
        ...new Set(events.map((e) => e.data?.error_category).filter(Boolean)),
      ],
    }))
    .sort((a, b) => b.count - a.count);

  // Show top N clusters
  const topN = options.top || 10;
  const topClusters = clusters.slice(0, topN);

  for (const cluster of topClusters) {
    console.log(`\n${cluster.fingerprint}`);
    console.log(`  Occurrences: ${cluster.count}`);
    console.log(`  Affected tasks: ${cluster.affected_tasks}`);
    console.log(`  Affected attempts: ${cluster.affected_attempts}`);
    console.log(`  Categories: ${cluster.categories.join(", ") || "unknown"}`);
    console.log(
      `  Sample: ${cluster.sample_message.slice(0, 100)}${cluster.sample_message.length > 100 ? "..." : ""}`,
    );
    console.log(
      `  First seen: ${new Date(cluster.first_seen).toISOString()}`,
    );
    console.log(
      `  Last seen: ${new Date(cluster.last_seen).toISOString()}`,
    );
  }

  console.log(`\n\nTotal unique error types: ${clusters.length}`);
  console.log(`Total error events: ${errors.length}`);
}

/**
 * Compare executor performance
 */
async function compareExecutors(executors) {
  console.log("\n=== Executor Performance Comparison ===\n");

  const metrics = await loadMetrics({ days: 30 });

  if (metrics.length === 0) {
    console.log("No metrics data found");
    return;
  }

  const comparison = {};

  for (const executor of executors) {
    const executorSessions = metrics.filter((m) => m.executor === executor);

    if (executorSessions.length === 0) {
      console.log(`No data for executor: ${executor}`);
      continue;
    }

    comparison[executor] = {
      total_sessions: executorSessions.length,
      success_rate: percentage(
        executorSessions,
        (s) => s.outcome?.status === "completed",
      ),
      first_shot_rate: percentage(
        executorSessions,
        (s) => s.metrics?.first_shot_success === true,
      ),
      avg_duration_s: average(
        executorSessions.map((s) => (s.metrics?.duration_ms || 0) / 1000),
      ),
      avg_cost_usd: average(
        executorSessions.map((s) => s.metrics?.cost_usd || 0),
      ),
      avg_tokens: average(
        executorSessions.map((s) => s.metrics?.total_tokens || 0),
      ),
      avg_errors: average(
        executorSessions.map((s) => s.error_summary?.total_errors || 0),
      ),
      total_cost_usd: sum(executorSessions.map((s) => s.metrics?.cost_usd || 0)),
    };
  }

  // Display as table
  console.log(
    "┌────────────┬──────────┬───────────┬──────────────┬──────────┬──────────┬────────────┐",
  );
  console.log(
    "│ Executor   │ Sessions │ Success % │ First-shot % │ Avg Time │ Avg Cost │ Total Cost │",
  );
  console.log(
    "├────────────┼──────────┼───────────┼──────────────┼──────────┼──────────┼────────────┤",
  );

  for (const [executor, stats] of Object.entries(comparison)) {
    console.log(
      `│ ${executor.padEnd(10)} │ ${String(stats.total_sessions).padStart(8)} │ ${stats.success_rate.toFixed(1).padStart(8)}% │ ${stats.first_shot_rate.toFixed(1).padStart(11)}% │ ${stats.avg_duration_s.toFixed(1).padStart(7)}s │ ${stats.avg_cost_usd.toFixed(3).padStart(8)} │ ${stats.total_cost_usd.toFixed(2).padStart(10)} │`,
    );
  }

  console.log(
    "└────────────┴──────────┴───────────┴──────────────┴──────────┴──────────┴────────────┘",
  );

  // Additional stats
  console.log("\nDetailed Stats:");
  for (const [executor, stats] of Object.entries(comparison)) {
    console.log(`\n${executor}:`);
    console.log(`  Avg tokens: ${Math.round(stats.avg_tokens)}`);
    console.log(`  Avg errors: ${stats.avg_errors.toFixed(1)}`);
  }
}

/**
 * Analyze task planning effectiveness
 */
async function analyzePlanning(options) {
  console.log("\n=== Task Planning Analysis ===\n");

  const metrics = await loadMetrics({ days: 30 });

  if (metrics.length === 0) {
    console.log("No metrics data found");
    return;
  }

  // Group by task
  const byTask = groupBy(metrics, "task_id");

  // Filter to failed/problematic tasks
  const problematicTasks = Object.entries(byTask)
    .map(([taskId, sessions]) => {
      const completed = sessions.some((s) => s.outcome?.status === "completed");
      const multipleAttempts = sessions.length > 1;

      return {
        task_id: taskId,
        sessions,
        completed,
        multipleAttempts,
      };
    })
    .filter((t) => (options.failedOnly ? !t.completed : t.multipleAttempts));

  if (problematicTasks.length === 0) {
    console.log("No problematic tasks found");
    return;
  }

  for (const task of problematicTasks) {
    console.log(`\n=== Task: ${task.task_id} ===`);
    console.log(`Status: ${task.completed ? "completed" : "failed"}`);
    console.log(`Attempts: ${task.sessions.length}`);

    // Analyze error patterns
    const allErrors = task.sessions.flatMap(
      (s) => s.error_summary?.error_categories || [],
    );
    const errorFreq = countFrequency(allErrors);

    if (Object.keys(errorFreq).length > 0) {
      console.log("\nRoot Cause Categories:");
      for (const [category, count] of Object.entries(errorFreq)) {
        console.log(`  ${category}: ${count}`);
      }
    }

    // Identify planning issues
    const planningIssues = [];

    if (errorFreq["dependency"]) {
      planningIssues.push("Missing dependency setup in task description");
    }
    if (errorFreq["api_key"] || errorFreq["auth"]) {
      planningIssues.push("Missing environment/auth setup instructions");
    }
    if (errorFreq["context_window"]) {
      planningIssues.push(
        "Task scope too large, should be broken into subtasks",
      );
    }
    if (errorFreq["test"]) {
      planningIssues.push("Missing test setup or test data requirements");
    }
    if (errorFreq["build"]) {
      planningIssues.push("Missing build configuration or tooling setup");
    }
    if (task.sessions.length >= 3 && !task.completed) {
      planningIssues.push(
        "Task may be too complex or poorly specified for automation",
      );
    }

    // Executor switching analysis
    const executors = task.sessions.map((s) => s.executor);
    const uniqueExecutors = [...new Set(executors)];
    if (uniqueExecutors.length > 1) {
      planningIssues.push(
        `Executor switching detected (${uniqueExecutors.join(" → ")}) - may indicate persistent issues`,
      );
    }

    if (planningIssues.length > 0) {
      console.log("\n💡 Planning Improvements:");
      for (const issue of planningIssues) {
        console.log(`  - ${issue}`);
      }
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Analyzed ${problematicTasks.length} tasks`);

  const allPlanningIssues = problematicTasks.flatMap((t) => {
    const issues = [];
    const errorFreq = countFrequency(
      t.sessions.flatMap((s) => s.error_summary?.error_categories || []),
    );

    if (errorFreq["dependency"]) issues.push("dependency");
    if (errorFreq["api_key"] || errorFreq["auth"]) issues.push("auth");
    if (errorFreq["context_window"]) issues.push("scope");
    if (t.sessions.length >= 3 && !t.completed) issues.push("complexity");

    return issues;
  });

  const issueFreq = countFrequency(allPlanningIssues);
  console.log("\nMost common planning issues:");
  for (const [issue, count] of topN(issueFreq, 5)) {
    console.log(`  ${issue}: ${count} tasks`);
  }
}

/**
 * Generate weekly report
 */
async function generateWeeklyReport() {
  console.log("\n=== Weekly Agent Work Report ===\n");

  const metrics = await loadMetrics({ days: 7 });

  if (metrics.length === 0) {
    console.log("No data for the past 7 days");
    return;
  }

  // Overall stats
  const totalSessions = metrics.length;
  const completedSessions = metrics.filter(
    (m) => m.outcome?.status === "completed",
  ).length;
  const successRate = (completedSessions * 100.0) / totalSessions;

  const totalDuration = sum(
    metrics.map((m) => (m.metrics?.duration_ms || 0) / 1000),
  );
  const totalCost = sum(metrics.map((m) => m.metrics?.cost_usd || 0));
  const totalErrors = sum(metrics.map((m) => m.error_summary?.total_errors || 0));

  console.log("Period: Last 7 days");
  console.log(`Generated: ${new Date().toISOString()}\n`);

  console.log("📊 Overall Metrics:");
  console.log(`  Total Sessions: ${totalSessions}`);
  console.log(`  Completed: ${completedSessions} (${successRate.toFixed(1)}%)`);
  console.log(`  Total Duration: ${Math.round(totalDuration / 60)} minutes`);
  console.log(`  Total Cost: $${totalCost.toFixed(2)}`);
  console.log(`  Total Errors: ${totalErrors}`);

  // Executor comparison
  const byExecutor = groupBy(metrics, "executor");
  console.log("\n🤖 By Executor:");
  for (const [executor, sessions] of Object.entries(byExecutor)) {
    const execSuccessRate = percentage(
      sessions,
      (s) => s.outcome?.status === "completed",
    );
    console.log(
      `  ${executor}: ${sessions.length} sessions, ${execSuccessRate.toFixed(1)}% success`,
    );
  }

  // Top errors
  const errors = await loadErrors({ days: 7 });
  const byFingerprint = groupBy(
    errors,
    (e) => e.data?.error_fingerprint || "unknown",
  );
  const topErrors = topN(
    Object.fromEntries(
      Object.entries(byFingerprint).map(([k, v]) => [k, v.length]),
    ),
    5,
  );

  console.log("\n❌ Top Errors:");
  for (const [fingerprint, count] of topErrors) {
    console.log(`  ${fingerprint}: ${count} occurrences`);
  }

  // Recommendations
  console.log("\n💡 Recommendations:");

  if (successRate < 70) {
    console.log("  - Success rate is below 70% - review task planning");
  }
  if (totalCost / totalSessions > 0.1) {
    console.log(
      "  - Average cost per session is high - consider prompt optimization",
    );
  }
  if (totalErrors / totalSessions > 2) {
    console.log("  - High error rate - investigate common failure patterns");
  }
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (!command) {
  console.log(`
Agent Work Analytics CLI

Usage:
  node analyze-agent-work.mjs --backlog-tasks [N] [--days N]
  node analyze-agent-work.mjs --error-clustering [--days N] [--top N]
  node analyze-agent-work.mjs --executor-comparison <executor1> <executor2> ...
  node analyze-agent-work.mjs --task-planning [--failed-only]
  node analyze-agent-work.mjs --weekly-report

Examples:
  node analyze-agent-work.mjs --backlog-tasks 10 --days 30
  node analyze-agent-work.mjs --error-clustering --days 7 --top 15
  node analyze-agent-work.mjs --executor-comparison CODEX COPILOT
  node analyze-agent-work.mjs --task-planning --failed-only
  `);
  process.exit(0);
}

// Parse options
const options = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) {
    const key = args[i].slice(2);
    const value = args[i + 1];
    if (value && !value.startsWith("--")) {
      options[key] = isNaN(value) ? value : Number(value);
      i++;
    } else {
      options[key] = true;
    }
  }
}

// Execute command
try {
  switch (command) {
    case "--backlog-tasks":
      await analyzeBacklog({
        limit: args[1] && !args[1].startsWith("--") ? Number(args[1]) : 10,
        days: options.days || 30,
      });
      break;

    case "--error-clustering":
      await clusterErrors({
        days: options.days || 7,
        top: options.top || 10,
      });
      break;

    case "--executor-comparison":
      const executors = args
        .slice(1)
        .filter((a) => !a.startsWith("--"));
      if (executors.length === 0) {
        console.error("Error: Specify at least one executor");
        process.exit(1);
      }
      await compareExecutors(executors);
      break;

    case "--task-planning":
      await analyzePlanning({
        failedOnly: options["failed-only"] || false,
      });
      break;

    case "--weekly-report":
      await generateWeeklyReport();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      process.exit(1);
  }
} catch (err) {
  console.error(`Error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
