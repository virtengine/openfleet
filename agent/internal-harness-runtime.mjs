function toTrimmedString(value) {
  return String(value ?? "").trim();
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

function resolveNextStageId(stage) {
  const transitions = Array.isArray(stage?.transitions) ? stage.transitions : [];
  const preferred =
    transitions.find((entry) => entry?.on === "success" || entry?.on === "next")
    || transitions[0]
    || null;
  return toTrimmedString(preferred?.to || "");
}

export function createInternalHarnessSession(compiledProfile, options = {}) {
  const profile = compiledProfile && typeof compiledProfile === "object"
    ? compiledProfile
    : {};
  const stageMap = buildStageMap(profile);
  const maxSteps = Math.max(8, stageMap.size * 4);
  let aborted = false;

  return {
    abort(reason = "aborted") {
      aborted = true;
      emitEvent(options.onEvent, {
        type: "harness:aborted",
        reason,
        timestamp: new Date().toISOString(),
      });
    },
    async run() {
      const history = [];
      const repairAttempts = new Map();
      let currentStageId = toTrimmedString(profile.entryStageId);
      let steps = 0;

      while (currentStageId && steps < maxSteps) {
        if (aborted) {
          return {
            success: false,
            status: "aborted",
            currentStageId,
            history,
          };
        }
        const stage = stageMap.get(currentStageId);
        if (!stage) {
          return {
            success: false,
            status: "invalid_stage",
            currentStageId,
            history,
            error: `Unknown stage "${currentStageId}"`,
          };
        }
        steps += 1;
        emitEvent(options.onEvent, {
          type: "harness:stage-start",
          stageId: stage.id,
          stageType: stage.type,
          timestamp: new Date().toISOString(),
        });
        const mode = history.length === 0 ? "initial" : "continue";
        const result = await options.executeTurn({
          profile,
          stage,
          taskKey: profile.agentId || stage.id,
          prompt: stage.prompt,
          mode,
        });
        history.push({
          stageId: stage.id,
          ok: result?.success !== false,
          result,
        });
        emitEvent(options.onEvent, {
          type: "harness:stage-result",
          stageId: stage.id,
          ok: result?.success !== false,
          timestamp: new Date().toISOString(),
          result,
        });

        if (result?.success === false) {
          const repairLoop = stage.repairLoop && typeof stage.repairLoop === "object"
            ? stage.repairLoop
            : null;
          if (repairLoop?.targetStageId) {
            const nextAttempts = (repairAttempts.get(stage.id) || 0) + 1;
            repairAttempts.set(stage.id, nextAttempts);
            if (nextAttempts <= Number(repairLoop.maxAttempts || 0)) {
              currentStageId = repairLoop.targetStageId;
              continue;
            }
          }
          return {
            success: false,
            status: "failed",
            currentStageId: stage.id,
            history,
            error: result?.error || `Harness stage "${stage.id}" failed`,
          };
        }

        const nextStageId = resolveNextStageId(stage);
        if (!nextStageId) {
          return {
            success: true,
            status: "completed",
            currentStageId: stage.id,
            history,
          };
        }
        currentStageId = nextStageId;
      }

      return {
        success: false,
        status: "loop_limit_exceeded",
        currentStageId,
        history,
        error: `Harness exceeded step budget (${maxSteps})`,
      };
    },
  };
}

export default createInternalHarnessSession;
