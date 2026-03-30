// CLAUDE:SUMMARY — internal-harness-runtime
// Executes compiled internal harness profiles with stage-aware event emission
// and queued steering/follow-up control over Bosun thread runners.

function createEventEmitter(onEvent) {
  const events = [];
  const emit = (event) => {
    const normalized = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    events.push(normalized);
    if (typeof onEvent === "function") {
      onEvent(normalized);
    }
    return normalized;
  };
  return { events, emit };
}

function normalizeExtensionList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      ...entry,
      id: String(entry.id || "").trim() || null,
    }))
    .filter((entry) => entry.id);
}

function resolveExtensionMap(options = {}) {
  const entries = new Map();
  for (const extension of normalizeExtensionList(options.extensions)) {
    entries.set(extension.id, extension);
  }
  if (options.extensionRegistry && typeof options.extensionRegistry === "object") {
    for (const [id, extension] of Object.entries(options.extensionRegistry)) {
      if (!extension || typeof extension !== "object") continue;
      const normalizedId = String(extension.id || id || "").trim();
      if (!normalizedId) continue;
      entries.set(normalizedId, {
        ...extension,
        id: normalizedId,
      });
    }
  }
  return entries;
}

function resolveStageExtensions(profile, stage, options = {}) {
  const extensionMap = resolveExtensionMap(options);
  const requestedIds = [
    ...(Array.isArray(profile?.extensionIds) ? profile.extensionIds : []),
    ...(Array.isArray(stage?.extensionIds) ? stage.extensionIds : []),
  ];
  return Array.from(new Set(
    requestedIds
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  ))
    .map((id) => extensionMap.get(id))
    .filter(Boolean);
}

function resolveProfileExtensions(profile, options = {}) {
  const extensionMap = resolveExtensionMap(options);
  return Array.from(new Set(
    (Array.isArray(profile?.extensionIds) ? profile.extensionIds : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  ))
    .map((id) => extensionMap.get(id))
    .filter(Boolean);
}

function normalizeHookResult(result) {
  if (!result || typeof result !== "object") return {};
  const prompt = typeof result.prompt === "string" ? result.prompt : null;
  const steering = Array.isArray(result.enqueueSteering)
    ? result.enqueueSteering
    : (typeof result.enqueueSteering === "string" ? [result.enqueueSteering] : []);
  const followUps = Array.isArray(result.enqueueFollowUps)
    ? result.enqueueFollowUps
    : (typeof result.enqueueFollowUps === "string" ? [result.enqueueFollowUps] : []);
  const artifacts = Array.isArray(result.artifacts)
    ? result.artifacts.filter((entry) => entry && typeof entry === "object")
    : [];
  return {
    prompt,
    enqueueSteering: steering.map((entry) => String(entry || "").trim()).filter(Boolean),
    enqueueFollowUps: followUps.map((entry) => String(entry || "").trim()).filter(Boolean),
    artifacts,
    metadata: result.metadata && typeof result.metadata === "object" ? { ...result.metadata } : null,
  };
}

async function runExtensionHook(extensions, hookName, context, emit) {
  const outputs = [];
  for (const extension of extensions) {
    const hook = extension?.[hookName];
    if (typeof hook !== "function") continue;
    try {
      const result = normalizeHookResult(await hook({
        extensionId: extension.id,
        ...context,
      }));
      outputs.push({
        extensionId: extension.id,
        hookName,
        ...result,
      });
      emit({
        type: "extension_hook",
        extensionId: extension.id,
        hookName,
        stageId: context?.stage?.id || context?.stageId || null,
        taskKey: context?.taskKey || null,
      });
    } catch (error) {
      emit({
        type: "extension_error",
        extensionId: extension?.id || null,
        hookName,
        stageId: context?.stage?.id || context?.stageId || null,
        taskKey: context?.taskKey || null,
        error: error?.message || String(error),
      });
      throw error;
    }
  }
  return outputs;
}

function applyHookOutputs(outputs, { steeringQueue, followUpQueue, stageArtifacts, taskKey, stageId, emit }) {
  let prompt = null;
  for (const output of outputs) {
    if (typeof output.prompt === "string" && output.prompt.trim()) {
      prompt = output.prompt;
    }
    for (const entry of output.enqueueSteering || []) {
      steeringQueue.push(entry);
      emit({
        type: "extension_steering_queued",
        extensionId: output.extensionId,
        stageId,
        taskKey,
        prompt: entry,
      });
    }
    for (const entry of output.enqueueFollowUps || []) {
      followUpQueue.push(entry);
      emit({
        type: "extension_followup_queued",
        extensionId: output.extensionId,
        stageId,
        taskKey,
        prompt: entry,
      });
    }
    for (const artifact of output.artifacts || []) {
      const normalizedArtifact = {
        extensionId: output.extensionId,
        ...artifact,
      };
      stageArtifacts.push(normalizedArtifact);
      emit({
        type: "extension_artifact",
        extensionId: output.extensionId,
        stageId,
        taskKey,
        artifact: normalizedArtifact,
      });
    }
  }
  return prompt;
}

function buildTurnPrompt(basePrompt, queuedMessages, label) {
  const additions = Array.isArray(queuedMessages)
    ? queuedMessages.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  if (additions.length === 0) return String(basePrompt || "").trim();
  return [
    String(basePrompt || "").trim(),
    "",
    `# ${label}`,
    ...additions.map((entry, index) => `${index + 1}. ${entry}`),
  ]
    .filter(Boolean)
    .join("\n");
}

export function createInternalHarnessSession(compiledProfile, options = {}) {
  if (!compiledProfile?.agentId) {
    throw new Error("Compiled harness profile must include agentId.");
  }
  if (!Array.isArray(compiledProfile?.stages) || compiledProfile.stages.length === 0) {
    throw new Error("Compiled harness profile must include at least one stage.");
  }
  if (typeof options.executeTurn !== "function") {
    throw new Error("Internal harness session requires an executeTurn function.");
  }

  const { events, emit } = createEventEmitter(options.onEvent);
  const steeringQueue = [];
  const followUpQueue = [];
  const state = {
    running: false,
    completed: false,
    currentStageId: null,
    currentTaskKey: null,
    turnsExecuted: 0,
    result: null,
  };

  function getSnapshot() {
    return {
      ...state,
      steeringQueueLength: steeringQueue.length,
      followUpQueueLength: followUpQueue.length,
      eventCount: events.length,
    };
  }

  function enqueueSteering(prompt, { immediate = true } = {}) {
    const text = String(prompt || "").trim();
    if (!text) return false;
    if (
      immediate &&
      state.running &&
      state.currentTaskKey &&
      typeof options.steerActiveTurn === "function"
    ) {
      try {
        const sent = Boolean(options.steerActiveTurn(state.currentTaskKey, text));
        if (sent) {
          emit({
            type: "steering_sent",
            stageId: state.currentStageId,
            taskKey: state.currentTaskKey,
            prompt: text,
          });
          return true;
        }
      } catch {
        // Fall through to queued steering.
      }
    }
    steeringQueue.push(text);
    emit({
      type: "steering_queued",
      stageId: state.currentStageId,
      taskKey: state.currentTaskKey,
      prompt: text,
    });
    return true;
  }

  function enqueueFollowUp(prompt) {
    const text = String(prompt || "").trim();
    if (!text) return false;
    followUpQueue.push(text);
    emit({
      type: "followup_queued",
      stageId: state.currentStageId,
      taskKey: state.currentTaskKey,
      prompt: text,
    });
    return true;
  }

  async function executeStageTurn(stage, prompt, mode, sequence) {
    const activeExtensions = resolveStageExtensions(compiledProfile, stage, options);
    const stageArtifacts = [];
    const beforeOutputs = await runExtensionHook(activeExtensions, "beforeTurn", {
      profile: compiledProfile,
      stage,
      taskKey: state.currentTaskKey,
      prompt,
      mode,
      sequence,
      turnIndex: state.turnsExecuted + 1,
      snapshot: getSnapshot(),
    }, emit);
    const nextPrompt = applyHookOutputs(beforeOutputs, {
      steeringQueue,
      followUpQueue,
      stageArtifacts,
      taskKey: state.currentTaskKey,
      stageId: stage.id,
      emit,
    }) || prompt;
    emit({
      type: "turn_start",
      stageId: stage.id,
      taskKey: state.currentTaskKey,
      mode,
      sequence,
      prompt: nextPrompt,
    });
    const result = await options.executeTurn({
      profile: compiledProfile,
      stage,
      taskKey: state.currentTaskKey,
      prompt: nextPrompt,
      mode,
      sequence,
      turnIndex: state.turnsExecuted + 1,
    });
    state.turnsExecuted += 1;
    const afterOutputs = await runExtensionHook(activeExtensions, "afterTurn", {
      profile: compiledProfile,
      stage,
      taskKey: state.currentTaskKey,
      prompt: nextPrompt,
      mode,
      sequence,
      turnIndex: state.turnsExecuted,
      result,
      snapshot: getSnapshot(),
    }, emit);
    applyHookOutputs(afterOutputs, {
      steeringQueue,
      followUpQueue,
      stageArtifacts,
      taskKey: state.currentTaskKey,
      stageId: stage.id,
      emit,
    });
    emit({
      type: "turn_end",
      stageId: stage.id,
      taskKey: state.currentTaskKey,
      mode,
      sequence,
      result,
    });
    return {
      ...result,
      artifacts: stageArtifacts,
    };
  }

  async function run() {
    if (state.running) {
      throw new Error("Internal harness session is already running.");
    }
    if (state.completed) {
      return state.result;
    }

    state.running = true;
    const sessionArtifacts = [];
    const profileExtensions = resolveProfileExtensions(compiledProfile, options);
    emit({
      type: "session_start",
      agentId: compiledProfile.agentId,
      taskKey: compiledProfile.taskKey,
      profileVersion: compiledProfile.profileVersion,
    });
    const sessionStartOutputs = await runExtensionHook(profileExtensions, "onSessionStart", {
      profile: compiledProfile,
      taskKey: compiledProfile.taskKey,
      snapshot: getSnapshot(),
    }, emit);
    applyHookOutputs(sessionStartOutputs, {
      steeringQueue,
      followUpQueue,
      stageArtifacts: sessionArtifacts,
      taskKey: compiledProfile.taskKey,
      stageId: null,
      emit,
    });

    const stageResults = [];
    try {
      for (const stage of compiledProfile.stages) {
        if (state.turnsExecuted >= compiledProfile.maxTurns) {
          throw new Error(`Harness reached maxTurns=${compiledProfile.maxTurns} before completing all stages.`);
        }

        state.currentStageId = stage.id;
        state.currentTaskKey = `${compiledProfile.taskKey}:${stage.taskKeySuffix || stage.id}`;
        emit({
          type: "stage_start",
          agentId: compiledProfile.agentId,
          stageId: stage.id,
          taskKey: state.currentTaskKey,
        });
        const stageExtensions = resolveStageExtensions(compiledProfile, stage, options);
        await runExtensionHook(stageExtensions, "onStageStart", {
          profile: compiledProfile,
          stage,
          taskKey: state.currentTaskKey,
          snapshot: getSnapshot(),
        }, emit);

        const stageOutcome = {
          stageId: stage.id,
          taskKey: state.currentTaskKey,
          turns: [],
          artifacts: [],
          extensionIds: stageExtensions.map((extension) => extension.id),
          success: true,
        };

        let sequence = 0;
        let lastTurn = await executeStageTurn(stage, stage.prompt, "initial", ++sequence);
        stageOutcome.turns.push(lastTurn);
        stageOutcome.artifacts.push(...(Array.isArray(lastTurn?.artifacts) ? lastTurn.artifacts : []));
        if (!lastTurn?.success) {
          stageOutcome.success = false;
          stageResults.push(stageOutcome);
          await runExtensionHook(stageExtensions, "onStageEnd", {
            profile: compiledProfile,
            stage,
            taskKey: state.currentTaskKey,
            stageOutcome,
            snapshot: getSnapshot(),
          }, emit);
          emit({
            type: "stage_end",
            stageId: stage.id,
            taskKey: state.currentTaskKey,
            success: false,
            stageOutcome,
          });
          break;
        }

        for (const steeringPrompt of stage.steering || []) {
          enqueueSteering(steeringPrompt, { immediate: false });
        }
        for (const followUpPrompt of stage.followUps || []) {
          enqueueFollowUp(followUpPrompt);
        }

        while (steeringQueue.length > 0 || followUpQueue.length > 0) {
          if (state.turnsExecuted >= compiledProfile.maxTurns) {
            throw new Error(`Harness reached maxTurns=${compiledProfile.maxTurns} while processing stage follow-ups.`);
          }
          if (steeringQueue.length > 0) {
            const prompts = steeringQueue.splice(0, steeringQueue.length);
            lastTurn = await executeStageTurn(
              stage,
              buildTurnPrompt("Continue with the active task using the following steering updates.", prompts, "STEERING"),
              "steering",
              ++sequence,
            );
            stageOutcome.turns.push(lastTurn);
            stageOutcome.artifacts.push(...(Array.isArray(lastTurn?.artifacts) ? lastTurn.artifacts : []));
            if (!lastTurn?.success) {
              stageOutcome.success = false;
              break;
            }
            continue;
          }
          const prompts = followUpQueue.splice(0, followUpQueue.length);
          lastTurn = await executeStageTurn(
            stage,
            buildTurnPrompt("Continue with these follow-up instructions.", prompts, "FOLLOW UP"),
            "followup",
            ++sequence,
          );
          stageOutcome.turns.push(lastTurn);
          stageOutcome.artifacts.push(...(Array.isArray(lastTurn?.artifacts) ? lastTurn.artifacts : []));
          if (!lastTurn?.success) {
            stageOutcome.success = false;
            break;
          }
        }

        sessionArtifacts.push(...stageOutcome.artifacts);
        stageResults.push(stageOutcome);
        await runExtensionHook(stageExtensions, "onStageEnd", {
          profile: compiledProfile,
          stage,
          taskKey: state.currentTaskKey,
          stageOutcome,
          snapshot: getSnapshot(),
        }, emit);
        emit({
          type: "stage_end",
          stageId: stage.id,
          taskKey: state.currentTaskKey,
          success: stageOutcome.success,
          stageOutcome,
        });
        if (!stageOutcome.success) break;
      }

      const success = stageResults.length === compiledProfile.stages.length &&
        stageResults.every((stage) => stage.success);
      state.result = {
        success,
        agentId: compiledProfile.agentId,
        taskKey: compiledProfile.taskKey,
        turnsExecuted: state.turnsExecuted,
        artifacts: sessionArtifacts,
        stageResults,
        events,
      };
      state.completed = true;
      const sessionEndOutputs = await runExtensionHook(profileExtensions, "onSessionEnd", {
        profile: compiledProfile,
        taskKey: compiledProfile.taskKey,
        result: state.result,
        snapshot: getSnapshot(),
      }, emit);
      applyHookOutputs(sessionEndOutputs, {
        steeringQueue,
        followUpQueue,
        stageArtifacts: sessionArtifacts,
        taskKey: compiledProfile.taskKey,
        stageId: null,
        emit,
      });
      emit({
        type: "session_end",
        agentId: compiledProfile.agentId,
        taskKey: compiledProfile.taskKey,
        success,
        turnsExecuted: state.turnsExecuted,
      });
      return state.result;
    } finally {
      state.running = false;
      state.currentStageId = null;
      state.currentTaskKey = null;
    }
  }

  return {
    enqueueSteering,
    enqueueFollowUp,
    getSnapshot,
    getEvents: () => [...events],
    run,
  };
}
