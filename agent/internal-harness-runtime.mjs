import {
  expireApprovalRequest,
  upsertHarnessRunApprovalRequest,
} from "../workflow/approval-queue.mjs";

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

function stageRequiresOperatorApproval(stage = {}) {
  const stageType = toTrimmedString(stage?.type).toLowerCase();
  if (stageType === "gate") return true;
  if (stage?.approvalRequired === true) return true;
  if (stage?.approval && typeof stage.approval === "object") {
    if (stage.approval.required !== false) return true;
  }
  const tools = Array.isArray(stage?.tools) ? stage.tools : [];
  return tools.some((tool) => {
    const normalized = toTrimmedString(tool).toLowerCase();
    return normalized === "approval_gate"
      || normalized === "await_approval"
      || normalized === "manual_approval";
  });
}

function normalizeApprovalDecision(value, fallback = "approved") {
  const normalized = toTrimmedString(value).toLowerCase();
  if (["approved", "denied", "expired", "aborted"].includes(normalized)) return normalized;
  if (normalized === "approve" || normalized === "success") return "approved";
  if (normalized === "deny" || normalized === "denied" || normalized === "rejected") return "denied";
  if (normalized === "timeout") return "expired";
  return fallback;
}

function buildApprovalPreview(stage, result = {}) {
  const preview = toTrimmedString(
    result?.summary
    || result?.output
    || result?.error
    || stage?.prompt
    || "",
  );
  return preview || null;
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
  const taskId = toTrimmedString(options.taskId || profile.taskId || "");
  const taskTitle = toTrimmedString(options.taskTitle || profile.taskTitle || profile.name || "");
  const approvalRepoRoot = toTrimmedString(options.approvalRepoRoot || options.repoRoot || "");
  let aborted = false;
  let activeStageId = "";
  let activeStageTaskKey = "";
  let pendingApproval = null;

  function canSteerActiveTurn() {
    if (dryRun || aborted) return false;
    if (!activeStageId || !activeStageTaskKey) return false;
    return typeof options.steerActiveTurn === "function";
  }

  function clearPendingApproval() {
    if (!pendingApproval) return;
    if (pendingApproval.timer) clearTimeout(pendingApproval.timer);
    pendingApproval = null;
  }

  function resolvePendingApproval(payload = {}) {
    if (!pendingApproval) return false;
    const current = pendingApproval;
    pendingApproval = null;
    if (current.timer) clearTimeout(current.timer);
    current.resolve({
      decision: normalizeApprovalDecision(payload?.decision, "approved"),
      actorId: toTrimmedString(payload?.actorId || payload?.actor || "operator") || "operator",
      note: toTrimmedString(payload?.note),
      requestId: toTrimmedString(payload?.requestId || current.requestId) || current.requestId,
      stageId: current.stageId,
      stageType: current.stageType,
      resolvedAt: new Date().toISOString(),
      prompt: toTrimmedString(payload?.prompt),
    });
    return true;
  }

  async function waitForStageApproval(stage, result, historyEntry) {
    const approvalConfig = stage?.approval && typeof stage.approval === "object" ? stage.approval : {};
    const timeoutMs = toPositiveInteger(
      approvalConfig.timeoutMs ?? stage?.approvalTimeoutMs ?? 0,
      0,
    );
    const approvalMode = toTrimmedString(approvalConfig.mode || "manual") || "manual";
    const requestRecord = approvalRepoRoot
      ? upsertHarnessRunApprovalRequest({
          runId,
          taskId: taskId || null,
          taskTitle: taskTitle || null,
          taskKey,
          stageId: stage.id,
          stageType: stage.type || null,
          agentId: profile.agentId || null,
          artifactId: toTrimmedString(options.artifactId) || null,
          sourceOrigin: toTrimmedString(options.sourceOrigin) || null,
          sourcePath: toTrimmedString(options.sourcePath) || null,
          requestedBy: toTrimmedString(approvalConfig.requestedBy || options.requestedBy || "harness") || "harness",
          reason: toTrimmedString(approvalConfig.reason || `Harness stage "${stage.id}" requires operator approval before continuation.`),
          preview: buildApprovalPreview(stage, result),
          timeoutMs: timeoutMs || undefined,
          mode: approvalMode,
          approvalNote: toTrimmedString(approvalConfig.note),
        }, { repoRoot: approvalRepoRoot })
      : {
          ok: true,
          request: {
            requestId: `harness-run:${runId}`,
            scopeType: "harness-run",
            scopeId: runId,
            runId,
            stageId: stage.id,
            stageType: stage.type || null,
            requestedBy: toTrimmedString(approvalConfig.requestedBy || options.requestedBy || "harness") || "harness",
            status: "pending",
          },
        };
    const request = requestRecord?.request || null;
    const requestedAt = new Date().toISOString();
    emitEvent(options.onEvent, {
      type: "harness:approval-requested",
      runId,
      taskKey,
      stageId: stage.id,
      stageType: stage.type || null,
      requestId: request?.requestId || `harness-run:${runId}`,
      requestedBy: request?.requestedBy || "harness",
      reason: request?.reason || null,
      preview: request?.preview || buildApprovalPreview(stage, result),
      status: "pending",
      timestamp: requestedAt,
    });
    historyEntry.approval = {
      requestId: request?.requestId || `harness-run:${runId}`,
      requestedAt,
      requestedBy: request?.requestedBy || "harness",
      status: "pending",
      stageId: stage.id,
      stageType: stage.type || null,
    };
    const approvalOutcome = await new Promise((resolve) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (approvalRepoRoot && request?.requestId) {
              try {
                expireApprovalRequest(request.requestId, {
                  repoRoot: approvalRepoRoot,
                  actorId: "system:timeout",
                  note: `Harness approval timed out after ${timeoutMs}ms.`,
                });
              } catch {
                // best effort
              }
            }
            resolvePendingApproval({
              decision: "expired",
              actorId: "system:timeout",
              note: `Harness approval timed out after ${timeoutMs}ms.`,
              requestId: request?.requestId,
            });
          }, timeoutMs)
        : null;
      pendingApproval = {
        requestId: request?.requestId || `harness-run:${runId}`,
        stageId: stage.id,
        stageType: stage.type || null,
        resolve,
        timer,
      };
    });
    if (options.emitApprovalResolutionEvent !== false) {
      emitEvent(options.onEvent, {
        type: "harness:approval-resolved",
        runId,
        taskKey,
        stageId: stage.id,
        stageType: stage.type || null,
        requestId: approvalOutcome.requestId || request?.requestId || `harness-run:${runId}`,
        decision: approvalOutcome.decision,
        actor: approvalOutcome.actorId || null,
        note: approvalOutcome.note || null,
        status: approvalOutcome.decision,
        timestamp: approvalOutcome.resolvedAt || new Date().toISOString(),
      });
    }
    historyEntry.approval = {
      ...(historyEntry.approval || {}),
      status: approvalOutcome.decision,
      decision: approvalOutcome.decision,
      actorId: approvalOutcome.actorId || null,
      note: approvalOutcome.note || null,
      resolvedAt: approvalOutcome.resolvedAt || new Date().toISOString(),
    };
    return approvalOutcome;
  }

  return {
    abort(reason = "aborted") {
      aborted = true;
      resolvePendingApproval({
        decision: "aborted",
        actorId: "system:abort",
        note: toTrimmedString(reason) || "Harness run aborted",
      });
      emitEvent(options.onEvent, {
        type: "harness:aborted",
        reason,
        runId,
        taskKey,
        timestamp: new Date().toISOString(),
      });
    },
    canSteer() {
      return canSteerActiveTurn();
    },
    steer(prompt, meta = {}) {
      const interventionType = toTrimmedString(meta?.kind || meta?.type || "nudge") || "nudge";
      if (interventionType === "approval" && pendingApproval) {
        const pending = pendingApproval;
        const requestedStageId = toTrimmedString(meta?.requestedStageId || meta?.stageId);
        if (requestedStageId && requestedStageId !== pending.stageId) {
          return {
            ok: false,
            delivered: false,
            reason: "stage_mismatch",
            interventionType,
            stageId: pending.stageId,
            targetTaskKey: taskKey,
          };
        }
        const delivered = resolvePendingApproval({
          decision: meta?.decision || meta?.status || meta?.reason || "approved",
          actorId: meta?.actor || meta?.actorId || "operator",
          note: meta?.note || prompt,
          requestId: meta?.requestId || pending.requestId,
          prompt,
        });
        return {
          ok: delivered,
          delivered,
          reason: delivered ? "approval_recorded" : "not_waiting_for_approval",
          interventionType,
          stageId: pending.stageId,
          targetTaskKey: taskKey,
          requestId: pending.requestId,
          decision: normalizeApprovalDecision(meta?.decision || meta?.status || meta?.reason, "approved"),
        };
      }
      const instruction = toTrimmedString(prompt);
      const stageId = activeStageId || null;
      const targetTaskKey = activeStageTaskKey || taskKey;
      const timestamp = new Date().toISOString();
      if (!instruction) {
        emitEvent(options.onEvent, {
          type: "harness:intervention-rejected",
          runId,
          taskKey,
          stageId,
          targetTaskKey,
          interventionType,
          reason: "empty_prompt",
          timestamp,
          meta: meta && typeof meta === "object" ? { ...meta } : {},
        });
        return {
          ok: false,
          delivered: false,
          reason: "empty_prompt",
          interventionType,
          stageId,
          targetTaskKey,
        };
      }
      if (!canSteerActiveTurn()) {
        emitEvent(options.onEvent, {
          type: "harness:intervention-rejected",
          runId,
          taskKey,
          stageId,
          targetTaskKey,
          interventionType,
          reason: dryRun ? "dry_run" : "not_steerable",
          prompt: instruction,
          timestamp,
          meta: meta && typeof meta === "object" ? { ...meta } : {},
        });
        return {
          ok: false,
          delivered: false,
          reason: dryRun ? "dry_run" : "not_steerable",
          interventionType,
          stageId,
          targetTaskKey,
        };
      }
      emitEvent(options.onEvent, {
        type: "harness:intervention-requested",
        runId,
        taskKey,
        stageId,
        targetTaskKey,
        interventionType,
        prompt: instruction,
        timestamp,
        meta: meta && typeof meta === "object" ? { ...meta } : {},
      });
      const delivered = options.steerActiveTurn(targetTaskKey, instruction) === true;
      emitEvent(options.onEvent, {
        type: delivered ? "harness:intervention-delivered" : "harness:intervention-rejected",
        runId,
        taskKey,
        stageId,
        targetTaskKey,
        interventionType,
        reason: delivered ? "steered" : "not_steerable",
        prompt: instruction,
        timestamp: new Date().toISOString(),
        meta: meta && typeof meta === "object" ? { ...meta } : {},
      });
      return {
        ok: delivered,
        delivered,
        reason: delivered ? "steered" : "not_steerable",
        interventionType,
        stageId,
        targetTaskKey,
      };
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
          activeStageId = "";
          activeStageTaskKey = "";
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
          activeStageId = "";
          activeStageTaskKey = "";
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
        activeStageId = stage.id;
        activeStageTaskKey = toTrimmedString(stage.taskKey || taskKey);
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
          try {
            rawResult = await options.executeTurn({
              profile,
              stage,
              taskKey: toTrimmedString(stage.taskKey || taskKey),
              prompt: stage.prompt,
              mode,
              dryRun,
              timeoutMs: toPositiveInteger(stage.timeoutMs || options.timeoutMs, 0) || undefined,
              step: steps,
              abortController: options.abortController || null,
              signal: options.abortController?.signal || null,
            });
          } catch (error) {
            const wasAborted =
              aborted === true ||
              options.abortController?.signal?.aborted === true ||
              error?.name === "AbortError" ||
              /abort|cancel|stop/i.test(String(error?.message || ""));
            if (wasAborted) {
              activeStageId = "";
              activeStageTaskKey = "";
              return {
                success: false,
                status: "aborted",
                runId,
                dryRun,
                currentStageId: stage.id,
                completedStageId: lastCompletedStageId || null,
                history,
                error: String(error?.message || "Harness run aborted"),
              };
            }
            throw error;
          }
        }

        if (aborted || options.abortController?.signal?.aborted === true) {
          activeStageId = "";
          activeStageTaskKey = "";
          return {
            success: false,
            status: "aborted",
            runId,
            dryRun,
            currentStageId: stage.id,
            completedStageId: lastCompletedStageId || null,
            history,
          };
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

        if (result.success && !dryRun && stageRequiresOperatorApproval(stage)) {
          const approvalOutcome = await waitForStageApproval(stage, result, historyEntry);
          if (approvalOutcome.decision !== "approved") {
            const deniedTransition = resolveStageTransition(stage, [
              approvalOutcome.decision === "expired" ? "approval-expired" : "approval-denied",
              approvalOutcome.decision,
              "failure",
              "error",
            ]);
            if (deniedTransition?.to) {
              historyEntry.nextStageId = deniedTransition.to;
              historyEntry.transitionReason = approvalOutcome.decision === "expired" ? "approval-expired" : "approval-denied";
              emitEvent(options.onEvent, {
                type: "harness:stage-transition",
                runId,
                taskKey,
                stageId: stage.id,
                toStageId: deniedTransition.to,
                reason: historyEntry.transitionReason,
                dryRun,
                timestamp: new Date().toISOString(),
              });
              lastCompletedStageId = stage.id;
              currentStageId = deniedTransition.to;
              continue;
            }
            const blockedAt = Date.now();
            const blocked = {
              success: false,
              status: approvalOutcome.decision === "expired" ? "approval_expired" : "approval_denied",
              runId,
              dryRun,
              currentStageId: stage.id,
              completedStageId: lastCompletedStageId || null,
              history,
              error: approvalOutcome.decision === "expired"
                ? `Harness approval for stage "${stage.id}" expired`
                : `Harness approval for stage "${stage.id}" was denied`,
              durationMs: Math.max(0, blockedAt - startedAt),
            };
            emitEvent(options.onEvent, {
              type: "harness:failed",
              runId,
              taskKey,
              stageId: stage.id,
              dryRun,
              timestamp: new Date(blockedAt).toISOString(),
              result: blocked,
            });
            activeStageId = "";
            activeStageTaskKey = "";
            clearPendingApproval();
            return blocked;
          }
        }

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
            activeStageId = "";
            activeStageTaskKey = "";
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
        activeStageId = "";
        activeStageTaskKey = "";
        clearPendingApproval();
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
      activeStageId = "";
      activeStageTaskKey = "";
      clearPendingApproval();
      return exhausted;
    },
  };
}

export default createInternalHarnessSession;
