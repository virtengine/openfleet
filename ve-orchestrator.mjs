#!/usr/bin/env node

import { VeKanbanRuntime } from "./ve-kanban.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  shouldRetryTask,
  sweepStaleSharedStates,
  releaseSharedState,
} from "./shared-state-manager.mjs";

// Shared state configuration
const SHARED_STATE_ENABLED = process.env.SHARED_STATE_ENABLED !== "false"; // default true
const SHARED_STATE_STALE_THRESHOLD_MS =
  Number(process.env.SHARED_STATE_STALE_THRESHOLD_MS) || 300_000;
const SHARED_STATE_MAX_RETRIES =
  Number(process.env.SHARED_STATE_MAX_RETRIES) || 3;

function log(level, msg) {
  const now = new Date().toISOString().replace("T", " ").replace("Z", "");
  const tag = level.toUpperCase();
  const prefix = `[${now}] [${tag}]`;
  if (level === "error") console.error(`${prefix} ${msg}`);
  else if (level === "warn") console.warn(`${prefix} ${msg}`);
  else console.log(`${prefix} ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStatus(raw) {
  return String(raw || "")
    .toLowerCase()
    .trim();
}

function isTerminalAttempt(attempt) {
  if (!attempt || attempt.archived) return true;
  const status = normalizeStatus(attempt.status);
  if (
    [
      "done",
      "completed",
      "complete",
      "cancelled",
      "canceled",
      "failed",
      "error",
      "merged",
      "closed",
    ].includes(status)
  ) {
    return true;
  }
  return false;
}

function sortByCreatedAsc(items) {
  return [...items].sort((a, b) => {
    const aTs = Date.parse(a?.created_at || a?.createdAt || 0) || 0;
    const bTs = Date.parse(b?.created_at || b?.createdAt || 0) || 0;
    return aTs - bTs;
  });
}

export function parseOrchestratorArgs(argv) {
  const options = {
    maxParallel: 2,
    pollIntervalSec: 90,
    oneShot: false,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || "").toLowerCase();
    if (
      token === "-maxparallel" ||
      token === "--max-parallel" ||
      token === "-p"
    ) {
      options.maxParallel = Math.max(
        1,
        toInt(argv[i + 1], options.maxParallel),
      );
      i += 1;
      continue;
    }
    if (
      token === "-pollintervalsec" ||
      token === "--poll-interval-sec" ||
      token === "--interval" ||
      token === "-i"
    ) {
      options.pollIntervalSec = Math.max(
        5,
        toInt(argv[i + 1], options.pollIntervalSec),
      );
      i += 1;
      continue;
    }
    if (
      token === "-oneshot" ||
      token === "--one-shot" ||
      token === "--oneshot"
    ) {
      options.oneShot = true;
      continue;
    }
    if (token === "-dryrun" || token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "-waitformutex" || token === "--wait-for-mutex") {
      // Kept for CLI compatibility. This native orchestrator is single-process.
      continue;
    }
  }

  return options;
}

async function reconcileMergedAttempts(runtime, attempts, dryRun) {
  let merged = 0;

  for (const attempt of attempts) {
    if (isTerminalAttempt(attempt)) continue;
    const attemptId = String(attempt.id || "").trim();
    const branch = String(attempt.branch || attempt.branch_name || "").trim();
    const taskId = String(attempt.task_id || attempt.taskId || "").trim();
    if (!attemptId || !branch) continue;

    const pr = runtime.findPullRequestForBranch(branch, "all");
    if (!pr || String(pr.state).toUpperCase() !== "MERGED") continue;

    if (dryRun) {
      log(
        "info",
        `[dry-run] would mark task ${taskId || "(unknown)"} done and archive attempt ${attemptId}`,
      );
      merged += 1;
      continue;
    }

    try {
      if (taskId) {
        await runtime.updateTaskStatus(taskId, "done");

        // Mark task as complete in shared state
        if (SHARED_STATE_ENABLED && attempt.claim_token) {
          try {
            await releaseSharedState(
              taskId,
              attempt.claim_token,
              "complete",
              undefined,
              process.cwd(),
            );
            log("info", `marked ${taskId} complete in shared state`);
          } catch (err) {
            log(
              "warn",
              `failed to update shared state for ${taskId}: ${err.message}`,
            );
          }
        }
      }
      await runtime.archiveAttempt(attemptId, true);
      merged += 1;
      log("info", `archived merged attempt ${attemptId} (${branch})`);
    } catch (err) {
      log(
        "warn",
        `failed to archive merged attempt ${attemptId}: ${err?.message || err}`,
      );
    }
  }

  return merged;
}

async function fillCapacity(runtime, maxParallel, dryRun) {
  const attempts = await runtime.listAttempts();
  const active = attempts.filter((attempt) => !isTerminalAttempt(attempt));
  const availableSlots = Math.max(0, maxParallel - active.length);
  if (availableSlots <= 0) {
    return { submitted: 0, active: active.length };
  }

  const todo = sortByCreatedAsc(await runtime.listTasks("todo"));
  const candidates = todo.slice(0, availableSlots);
  if (candidates.length === 0) {
    return { submitted: 0, active: active.length };
  }

  let submitted = 0;
  for (const task of candidates) {
    const taskId = String(task.id || "").trim();
    if (!taskId) continue;

    // Check shared state before claiming task
    if (SHARED_STATE_ENABLED) {
      try {
        const retryCheck = await shouldRetryTask(
          taskId,
          SHARED_STATE_MAX_RETRIES,
        );
        if (!retryCheck.shouldRetry) {
          log("info", `Skipping task ${taskId}: ${retryCheck.reason}`);
          continue;
        }
      } catch (err) {
        log("warn", `Shared state check failed for ${taskId}: ${err.message}`);
        // Continue with task on error (graceful degradation)
      }
    }

    if (dryRun) {
      log(
        "info",
        `[dry-run] would submit task ${taskId} (${task.title || "untitled"})`,
      );
      submitted += 1;
      continue;
    }

    try {
      const attempt = await runtime.submitTaskAttempt(taskId);
      submitted += 1;
      log(
        "info",
        `submitted task ${taskId} -> attempt ${attempt?.id || "(unknown)"} ${attempt?.branch || ""}`,
      );
      try {
        await runtime.updateTaskStatus(taskId, "inprogress");
      } catch {
        // best-effort
      }
    } catch (err) {
      log("warn", `submit failed for task ${taskId}: ${err?.message || err}`);
    }
  }

  return { submitted, active: active.length };
}

export async function runOrchestrator(argv, runtime = new VeKanbanRuntime()) {
  const opts = parseOrchestratorArgs(argv);
  let stopRequested = false;
  let cycle = 0;

  process.on("SIGINT", () => {
    stopRequested = true;
    log("warn", "received SIGINT, stopping after current cycle");
  });
  process.on("SIGTERM", () => {
    stopRequested = true;
    log("warn", "received SIGTERM, stopping after current cycle");
  });

  log(
    "info",
    `starting native orchestrator (maxParallel=${opts.maxParallel}, poll=${opts.pollIntervalSec}s, dryRun=${opts.dryRun}, oneShot=${opts.oneShot})`,
  );

  while (!stopRequested) {
    cycle += 1;
    try {
      await runtime.ensureConfig();

      // Periodically sweep stale shared states (every cycle)
      if (SHARED_STATE_ENABLED) {
        try {
          const sweepResult = await sweepStaleSharedStates(
            SHARED_STATE_STALE_THRESHOLD_MS,
            process.cwd(),
          );
          if (sweepResult.sweptCount > 0) {
            log(
              "info",
              `swept ${sweepResult.sweptCount} stale shared state(s): ${sweepResult.abandonedTasks.join(", ")}`,
            );
          }
        } catch (err) {
          log("warn", `shared state sweep failed: ${err.message}`);
        }
      }

      const attemptsBefore = await runtime.listAttempts();
      const merged = await reconcileMergedAttempts(
        runtime,
        attemptsBefore,
        opts.dryRun,
      );
      const fill = await fillCapacity(runtime, opts.maxParallel, opts.dryRun);

      log(
        "info",
        `cycle #${cycle}: active=${fill.active}, merged=${merged}, submitted=${fill.submitted}`,
      );
    } catch (err) {
      log("error", `cycle #${cycle} failed: ${err?.message || err}`);
    }

    if (opts.oneShot || stopRequested) {
      break;
    }
    await sleep(opts.pollIntervalSec * 1000);
  }

  log("info", "orchestrator stopped");
  return 0;
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runOrchestrator(process.argv.slice(2))
    .then((code) => {
      if (Number.isFinite(code) && code !== 0) {
        process.exit(code);
      }
    })
    .catch((err) => {
      log("error", err?.message || String(err));
      process.exit(1);
    });
}
