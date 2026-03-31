function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function buildStageMap(profile) {
  const map = new Map();
  for (const stage of Array.isArray(profile?.stages) ? profile.stages : []) {
    if (!stage?.id) continue;
    map.set(stage.id, stage);
  }
  return map;
}

function emitEvent(hook, payload) {
  if (typeof hook !== "function") return;
  try {
    hook(payload);
  } catch {
    // Harness event hooks must never break execution.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeOutcomeToken(value) {
  return toTrimmedString(value).toLowerCase();
}

function buildOutcomeAliases(outcome) {
  const normalized = normalizeOutcomeToken(outcome);
  if (!normalized) return [];
  const aliases = [normalized];
  if (["success", "completed", "complete", "ok", "pass", "passed"].includes(normalized)) {
    aliases.push("next");
  }
  if (["failure", "failed", "error"].includes(normalized)) {
    aliases.push("failure");
    aliases.push("error");
  }
  if (normalized === "repair-exhausted") {
    aliases.push("failure");
    aliases.push("error");
  }
  return [...new Set(aliases.filter(Boolean))];
}

function resolveStageTransition(stage, outcomes) {
  const transitions = Array.isArray(stage?.transitions) ? stage.transitions : [];
  const requested = Array.isArray(outcomes) ? outcomes : [outcomes];
  const aliases = requested.flatMap((entry) => buildOutcomeAliases(entry));
  if (aliases.length > 0) {
    for (const outcome of aliases) {
      const match = transitions.find((entry) => normalizeOutcomeToken(entry?.on || "next") === outcome);
      if (match) {
        return {
          on: normalizeOutcomeToken(match.on || "next") || "next",
          to: toTrimmedString(match.to || ""),
        };
      }
    }
  }
  return null;
}

function normalizeExecutionResult(result, mode) {
  const raw = result && typeof result === "object"
    ? { ...result }
    : {
        output: result == null ? "" : String(result),
      };
  const success = raw.success !== false;
  const outcome = normalizeOutcomeToken(
    raw.outcome || raw.transitionOutcome || raw.status || (success ? "success" : "failure"),
  ) || (success ? "success" : "failure");
  const status = toTrimmedString(raw.status || (success ? "completed" : "failed")) || (success ? "completed" : "failed");
  return {
    ...raw,
    success,
    outcome,
    status,
    mode,
    threadId: raw.threadId || null,
  };
}

function buildDryRunResult(stage, mode) {
  return {
    success: true,
    outcome: "success",
    status: "dry_run",
    dryRun: true,
    simulated: true,
    output: `Dry-run completed for stage "${stage.id}"`,
    mode,
    threadId: null,
  };
}

export function createInternalHarnessSession(compiledProfile, options = {}) {
  const profile = compiledProfile && typeof compiledProfile === "object"
    ? compiledProfile
    : {};
  const stageMap = buildStageMap(profile);
  const maxSteps = Math.max(8, stageMap.size * 4);
  const dryRun = options.dryRun === true;
  const taskKey = toTrimmedString(options.taskKey || profile.taskKey || profile.agentId || profile.name || "harness");
  const runId = toTrimmedString(options.runId || "");
  let aborted = false;

  return {
    abort(reason = "aborted") {
      aborted = true;
      emitEvent(options.onEvent, {
        type: "harness:aborted",
        reason,
        runId,
        taskKey,
        timestamp: new Date().toISOString(),
      });
    },
    async run() {
      const history = [];
      const repairAttempts = new Map();
      const startedAt = Date.now();
      let currentStageId = toTrimmedString(profile.entryStageId);
      let steps = 0;
      let lastCompletedStageId = "";

      emitEvent(options.onEvent, {
        type: "harness:session-start",
        runId,
        taskKey,
        dryRun,
        entryStageId: currentStageId,
        timestamp: new Date(startedAt).toISOString(),
      });

      while (currentStageId && steps < maxSteps) {
        if (aborted) {
          return {
            success: false,
            status: "aborted",
            runId,
            dryRun,
            currentStageId,
            completedStageId: lastCompletedStageId || null,
            history,
          };
        }
        const stage = stageMap.get(currentStageId);
        if (!stage) {
          return {
            success: false,
            status: "invalid_stage",
            runId,
            dryRun,
            currentStageId,
            completedStageId: lastCompletedStageId || null,
            history,
            error: `Unknown stage "${currentStageId}"`,
          };
        }

        steps += 1;
        const stageStartedAt = Date.now();
        const stageRepairAttempt = Number(repairAttempts.get(stage.id) || 0);
        const mode = history.length === 0 ? "initial" : "continue";
        emitEvent(options.onEvent, {
          type: "harness:stage-start",
          runId,
          taskKey,
          stageId: stage.id,
          stageType: stage.type,
          mode,
          step: steps,
          maxSteps,
          dryRun,
          repairAttempt: stageRepairAttempt,
          timestamp: new Date(stageStartedAt).toISOString(),
        });

        let rawResult;
        if (dryRun) {
          rawResult = buildDryRunResult(stage, mode);
        } else {
          if (typeof options.executeTurn !== "function") {
            throw new Error("Harness runtime requires an executeTurn function when dryRun is false");
          }
          rawResult = await options.executeTurn({
            profile,
            stage,
            taskKey: toTrimmedString(stage.taskKey || taskKey),
            prompt: stage.prompt,
            mode,
            dryRun,
            timeoutMs: toPositiveInteger(stage.timeoutMs || options.timeoutMs, 0) || undefined,
            step: steps,
          });
        }

        const result = normalizeExecutionResult(rawResult, mode);
        const endedAt = Date.now();
        const historyEntry = {
          index: history.length,
          step: steps,
          stageId: stage.id,
          stageType: stage.type,
          mode,
          dryRun,
          repairAttempt: stageRepairAttempt,
          startedAt: new Date(stageStartedAt).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          durationMs: Math.max(0, endedAt - stageStartedAt),
          ok: result.success,
          outcome: result.outcome,
          status: result.status,
          result,
          nextStageId: null,
          transitionReason: null,
        };
        history.push(historyEntry);
        emitEvent(options.onEvent, {
          type: "harness:stage-result",
          runId,
          taskKey,
          stageId: stage.id,
          ok: result.success,
          outcome: result.outcome,
          status: result.status,
          dryRun,
          timestamp: new Date(endedAt).toISOString(),
          result,
        });

        const directTransition = resolveStageTransition(stage, [result.outcome]);
        if (directTransition?.to) {
          historyEntry.nextStageId = directTransition.to;
          historyEntry.transitionReason = result.outcome;
          emitEvent(options.onEvent, {
            type: "harness:stage-transition",
            runId,
            taskKey,
            stageId: stage.id,
            toStageId: directTransition.to,
            reason: result.outcome,
            dryRun,
            timestamp: new Date().toISOString(),
          });
          lastCompletedStageId = stage.id;
          currentStageId = directTransition.to;
          continue;
        }

        if (result.success) {
          const nextStage = resolveStageTransition(stage, ["success", "next"]);
          if (!nextStage?.to) {
            const completedAt = Date.now();
            const completed = {
              success: true,
              status: "completed",
              runId,
              dryRun,
              currentStageId: stage.id,
              completedStageId: stage.id,
              history,
              durationMs: Math.max(0, completedAt - startedAt),
            };
            emitEvent(options.onEvent, {
              type: "harness:completed",
              runId,
              taskKey,
              dryRun,
              stageId: stage.id,
              timestamp: new Date(completedAt).toISOString(),
              result: completed,
            });
            return completed;
          }
          historyEntry.nextStageId = nextStage.to;
          historyEntry.transitionReason = nextStage.on || "success";
          emitEvent(options.onEvent, {
            type: "harness:stage-transition",
            runId,
            taskKey,
            stageId: stage.id,
            toStageId: nextStage.to,
            reason: nextStage.on || "success",
            dryRun,
            timestamp: new Date().toISOString(),
          });
          lastCompletedStageId = stage.id;
          currentStageId = nextStage.to;
          continue;
        }

        const repairLoop = stage.repairLoop && typeof stage.repairLoop === "object"
          ? stage.repairLoop
          : null;
        if (repairLoop?.targetStageId) {
          const nextAttempts = Number(repairAttempts.get(stage.id) || 0) + 1;
          if (nextAttempts <= Number(repairLoop.maxAttempts || 0)) {
            repairAttempts.set(stage.id, nextAttempts);
            const backoffMs = toPositiveInteger(repairLoop.backoffMs, 0);
            if (backoffMs > 0) {
              emitEvent(options.onEvent, {
                type: "harness:stage-backoff",
                runId,
                taskKey,
                stageId: stage.id,
                backoffMs,
                attempt: nextAttempts,
                dryRun,
                timestamp: new Date().toISOString(),
              });
              if (!dryRun) {
                await sleep(backoffMs);
              }
            }
            historyEntry.nextStageId = repairLoop.targetStageId;
            historyEntry.transitionReason = "repair";
            emitEvent(options.onEvent, {
              type: "harness:stage-transition",
              runId,
              taskKey,
              stageId: stage.id,
              toStageId: repairLoop.targetStageId,
              reason: "repair",
              attempt: nextAttempts,
              dryRun,
              timestamp: new Date().toISOString(),
            });
            lastCompletedStageId = stage.id;
            currentStageId = repairLoop.targetStageId;
            continue;
          }
        }

        const exhaustedTransition = resolveStageTransition(stage, ["repair-exhausted", "failure", "error"]);
        if (exhaustedTransition?.to) {
          historyEntry.nextStageId = exhaustedTransition.to;
          historyEntry.transitionReason = exhaustedTransition.on || "repair-exhausted";
          emitEvent(options.onEvent, {
            type: "harness:stage-transition",
            runId,
            taskKey,
            stageId: stage.id,
            toStageId: exhaustedTransition.to,
            reason: exhaustedTransition.on || "repair-exhausted",
            dryRun,
            timestamp: new Date().toISOString(),
          });
          lastCompletedStageId = stage.id;
          currentStageId = exhaustedTransition.to;
          continue;
        }

        const failedAt = Date.now();
        const failed = {
          success: false,
          status: "failed",
          runId,
          dryRun,
          currentStageId: stage.id,
          completedStageId: lastCompletedStageId || null,
          history,
          error: result.error || `Harness stage "${stage.id}" failed`,
          durationMs: Math.max(0, failedAt - startedAt),
        };
        emitEvent(options.onEvent, {
          type: "harness:stage-failed",
          runId,
          taskKey,
          stageId: stage.id,
          outcome: result.outcome,
          status: result.status,
          dryRun,
          timestamp: new Date(failedAt).toISOString(),
          result: failed,
        });
        emitEvent(options.onEvent, {
          type: "harness:failed",
          runId,
          taskKey,
          stageId: stage.id,
          dryRun,
          timestamp: new Date(failedAt).toISOString(),
          result: failed,
        });
        return failed;
      }

      const exhaustedAt = Date.now();
      const exhausted = {
        success: false,
        status: "loop_limit_exceeded",
        runId,
        dryRun,
        currentStageId,
        completedStageId: lastCompletedStageId || null,
        history,
        error: `Harness exceeded step budget (${maxSteps})`,
        durationMs: Math.max(0, exhaustedAt - startedAt),
      };
      emitEvent(options.onEvent, {
        type: "harness:failed",
        runId,
        taskKey,
        stageId: currentStageId,
        dryRun,
        timestamp: new Date(exhaustedAt).toISOString(),
        result: exhausted,
      });
      return exhausted;
    },
  };
}

export default createInternalHarnessSession;
