import { compileInternalHarnessProfile } from "./internal-harness-profile.mjs";
import { createInternalHarnessSession as createHarnessRuntimeSession } from "./internal-harness-runtime.mjs";

function formatHarnessValidationError(validationReport = {}) {
  const errors = Array.isArray(validationReport?.errors) ? validationReport.errors : [];
  if (errors.length === 0) return "Harness validation failed";
  return errors
    .map((issue) => String(issue?.message || issue?.code || "Harness validation failed").trim())
    .filter(Boolean)
    .join("; ");
}

function resolveTurnExecutor(options = {}) {
  if (typeof options.executeTurn === "function") return options.executeTurn;
  if (typeof options.turnExecutor === "function") return options.turnExecutor;
  if (typeof options.buildTurnExecutor === "function") {
    return options.buildTurnExecutor(options);
  }
  return async () => {
    throw new Error("Harness runtime requires an executeTurn function when dryRun is false");
  };
}

function compileProfileSource(profileSource, options = {}) {
  if (typeof options.compileHarnessSource === "function") {
    return options.compileHarnessSource(profileSource, options);
  }
  return compileInternalHarnessProfile(profileSource, options.compileOptions || options);
}

export function createCompiledHarnessSession(compiledProfile, options = {}) {
  if (!compiledProfile || typeof compiledProfile !== "object" || !Array.isArray(compiledProfile.stages)) {
    throw new Error("Compiled harness profile is required");
  }
  const controller = createHarnessRuntimeSession(compiledProfile, {
    onEvent: options.onHarnessEvent || options.onEvent,
    runId: options.runId,
    dryRun: options.dryRun === true,
    abortController: options.abortController || null,
    taskKey: options.taskKey || compiledProfile.taskKey || compiledProfile.agentId,
    taskId: options.taskId,
    taskTitle: options.taskTitle,
    artifactId: options.artifactId,
    sourceOrigin: options.sourceOrigin,
    sourcePath: options.sourcePath,
    approvalRepoRoot: options.approvalRepoRoot,
    requestedBy: options.requestedBy,
    emitApprovalResolutionEvent: options.emitApprovalResolutionEvent,
    steerActiveTurn: typeof options.steerActiveTurn === "function" ? options.steerActiveTurn : undefined,
    executeTurn: resolveTurnExecutor(options),
    extensions: options.extensions,
    extensionRegistry: options.extensionRegistry,
  });
  return {
    agentId: compiledProfile.agentId || "",
    compiledProfile,
    compiledProfileJson: JSON.stringify(compiledProfile, null, 2),
    validationReport: { errors: [], warnings: [], stats: compiledProfile.metadata || {} },
    isValid: true,
    controller,
    canSteer: () => controller.canSteer?.() === true,
    steer: (prompt, meta = {}) => controller.steer?.(prompt, meta) || {
      ok: false,
      delivered: false,
      reason: "not_steerable",
      interventionType: String(meta?.kind || meta?.type || "nudge").trim() || "nudge",
      stageId: null,
      targetTaskKey: null,
    },
    run: () => controller.run(),
  };
}

export function createHarnessSession(profileSource, options = {}) {
  const compiled = compileProfileSource(profileSource, options);
  if (!compiled?.isValid || !compiled?.compiledProfile) {
    const error = new Error(formatHarnessValidationError(compiled?.validationReport));
    error.validationReport = compiled?.validationReport || { errors: [], warnings: [], stats: {} };
    throw error;
  }
  const compiledSession = createCompiledHarnessSession(compiled.compiledProfile, options);
  return {
    ...compiledSession,
    ...compiled,
  };
}

export async function runCompiledHarnessSession(compiledProfile, options = {}) {
  const session = createCompiledHarnessSession(compiledProfile, options);
  const result = await session.run();
  return {
    ...session,
    result,
  };
}

export async function runHarnessSession(profileSource, options = {}) {
  const session = createHarnessSession(profileSource, options);
  const result = await session.run();
  return {
    ...session,
    result,
  };
}

export function createHarnessSessionManager(defaultOptions = {}) {
  return {
    createCompiledSession(compiledProfile, options = {}) {
      return createCompiledHarnessSession(compiledProfile, { ...defaultOptions, ...options });
    },
    createSession(profileSource, options = {}) {
      return createHarnessSession(profileSource, { ...defaultOptions, ...options });
    },
    runCompiledSession(compiledProfile, options = {}) {
      return runCompiledHarnessSession(compiledProfile, { ...defaultOptions, ...options });
    },
    runSession(profileSource, options = {}) {
      return runHarnessSession(profileSource, { ...defaultOptions, ...options });
    },
  };
}

export default createHarnessSessionManager;
