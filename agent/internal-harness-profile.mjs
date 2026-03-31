import { createHash } from "node:crypto";

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|client[_-]?secret|pat)/i;
const SECRET_PLACEHOLDER_ENV_RE = /^(?:\$?\{?[A-Z0-9_:-]+\}?|<[^>]+>)$/;
const SECRET_PLACEHOLDER_TEXT_RE = /^(?:changeme|replace[-_ ]?me|your[-_ ]?key|your[-_ ]?token)$/i;
const PROMPT_INJECTION_RE = /\b(ignore (?:all |any |the )?(?:previous|prior) instructions|reveal (?:the )?(?:system|developer) prompt|bypass (?:all )?(?:guardrails|safeguards)|disable (?:all )?(?:guardrails|checks)|override (?:the )?(?:system|developer) message)\b/i;
const UNSAFE_EXECUTION_RE = /\b(?:rm\s+-rf\s+\/|git\s+reset\s+--hard|curl\b[^|\n\r]*\|\s*(?:sh|bash)|wget\b[^|\n\r]*\|\s*(?:sh|bash)|del\s+\/f\s+\/s\s+\/q|format\s+[a-z]:)\b/i;
const GATE_TOOL_ALLOWLIST = new Set([
  "approval_gate",
  "manual_review",
  "run_tests",
  "validate_diff",
  "check_quality",
  "await_approval",
]);
const STAGE_TYPE_ALLOWLIST = new Set([
  "prompt",
  "action",
  "gate",
  "repair",
  "finalize",
]);

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function slugify(value) {
  return toTrimmedString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "harness";
}

function safeClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addIssue(bucket, issue) {
  bucket.push({
    code: toTrimmedString(issue?.code || "invalid"),
    message: toTrimmedString(issue?.message || "Invalid harness profile"),
    path: toTrimmedString(issue?.path || ""),
    stageId: toTrimmedString(issue?.stageId || ""),
  });
}

function parseSourceObject(source) {
  if (isObject(source)) return safeClone(source);
  const raw = toTrimmedString(source);
  if (!raw) {
    throw new Error("Harness source is empty");
  }
  try {
    return JSON.parse(raw);
  } catch {
    const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) {
      return JSON.parse(fenceMatch[1]);
    }
  }
  throw new Error("Harness source must be a JSON object or markdown fenced JSON block");
}

function normalizeTransitionList(stage) {
  const transitions = [];
  if (toTrimmedString(stage?.next)) {
    transitions.push({ on: "success", to: toTrimmedString(stage.next) });
  }
  if (Array.isArray(stage?.transitions)) {
    for (const entry of stage.transitions) {
      if (typeof entry === "string") {
        const target = toTrimmedString(entry);
        if (target) transitions.push({ on: "next", to: target });
        continue;
      }
      if (!isObject(entry)) continue;
      const target = toTrimmedString(entry.to || entry.target || entry.stageId);
      if (!target) continue;
      transitions.push({
        on: toTrimmedString(entry.on || entry.event || "next") || "next",
        to: target,
      });
    }
  }
  if (isObject(stage?.transitionMap)) {
    for (const [eventName, target] of Object.entries(stage.transitionMap)) {
      const resolvedTarget = toTrimmedString(target);
      if (!resolvedTarget) continue;
      transitions.push({
        on: toTrimmedString(eventName || "next") || "next",
        to: resolvedTarget,
      });
    }
  }
  return transitions;
}

function normalizeSkillEntry(entry) {
  if (typeof entry === "string") {
    return {
      ref: toTrimmedString(entry),
      pinned: false,
      source: "string",
    };
  }
  if (!isObject(entry)) {
    return { ref: "", pinned: false, source: "unknown" };
  }
  return {
    ref: toTrimmedString(entry.ref || entry.path || entry.id || entry.skill),
    pinned: entry.pinned === true,
    source: "object",
  };
}

function normalizeStage(stage, index) {
  const id = toTrimmedString(stage?.id || stage?.stageId || `stage-${index + 1}`);
  const typeRaw = toTrimmedString(stage?.type || stage?.kind || "prompt").toLowerCase();
  const type = STAGE_TYPE_ALLOWLIST.has(typeRaw) ? typeRaw : "prompt";
  const tools = toArray(stage?.tools)
    .map((entry) => toTrimmedString(entry))
    .filter(Boolean);
  const transitions = normalizeTransitionList(stage);
  const repairLoop = isObject(stage?.repairLoop)
    ? {
        maxAttempts: Number(stage.repairLoop.maxAttempts),
        targetStageId: toTrimmedString(stage.repairLoop.targetStageId || stage.repairLoop.target || ""),
        backoffMs: Number(stage.repairLoop.backoffMs),
        onFailure: toTrimmedString(stage.repairLoop.onFailure || stage.repairLoop.strategy || "retry"),
      }
    : null;
  return {
    id,
    index,
    type,
    prompt: toTrimmedString(stage?.prompt || stage?.instruction || ""),
    tools,
    transitions,
    repairLoop,
    meta: isObject(stage?.meta) ? safeClone(stage.meta) : {},
  };
}

function collectObjectIssues(value, visit, path = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectObjectIssues(entry, visit, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    visit(key, entry, nextPath);
    collectObjectIssues(entry, visit, nextPath);
  }
}

function validateSkillRefs(skillEntries, report) {
  const normalized = skillEntries.map(normalizeSkillEntry);
  for (const entry of normalized) {
    if (!entry.ref) {
      addIssue(report.errors, {
        code: "skill_ref_missing",
        message: "Skill entries must include a ref/path/id",
        path: "skills",
      });
      continue;
    }
    const looksPinned =
      entry.pinned === true ||
      entry.ref.includes("/") ||
      entry.ref.includes("\\") ||
      entry.ref.includes(".md") ||
      entry.ref.includes("@") ||
      entry.ref.startsWith("$");
    if (!looksPinned) {
      addIssue(report.errors, {
        code: "skill_ref_unpinned",
        message: `Skill ref "${entry.ref}" must be pinned to a concrete path or version`,
        path: "skills",
      });
    }
  }
  return normalized
    .filter((entry) => entry.ref)
    .map((entry) => ({
      ref: entry.ref,
      pinned: entry.pinned === true || entry.ref.includes("/") || entry.ref.includes("\\") || entry.ref.includes(".md") || entry.ref.includes("@"),
    }));
}

function validateStages(stages, entryStageId, report) {
  const knownIds = new Set();
  const stageById = new Map();
  for (const stage of stages) {
    if (!stage.id) {
      addIssue(report.errors, {
        code: "stage_id_missing",
        message: "Each stage requires a non-empty id",
        path: "stages",
      });
      continue;
    }
    if (knownIds.has(stage.id)) {
      addIssue(report.errors, {
        code: "stage_id_duplicate",
        message: `Duplicate stage id "${stage.id}"`,
        path: "stages",
        stageId: stage.id,
      });
      continue;
    }
    knownIds.add(stage.id);
    stageById.set(stage.id, stage);
    if (!stage.prompt) {
      addIssue(report.errors, {
        code: "stage_prompt_missing",
        message: `Stage "${stage.id}" requires a prompt`,
        path: `stages.${stage.id}.prompt`,
        stageId: stage.id,
      });
    }
    if (PROMPT_INJECTION_RE.test(stage.prompt)) {
      addIssue(report.warnings, {
        code: "prompt_injection_phrase",
        message: `Stage "${stage.id}" prompt contains a prompt-injection phrase`,
        path: `stages.${stage.id}.prompt`,
        stageId: stage.id,
      });
    }
    if (UNSAFE_EXECUTION_RE.test(stage.prompt)) {
      addIssue(report.errors, {
        code: "unsafe_execution_phrase",
        message: `Stage "${stage.id}" prompt contains an unsafe execution pattern`,
        path: `stages.${stage.id}.prompt`,
        stageId: stage.id,
      });
    }
  }

  if (!knownIds.has(entryStageId)) {
    addIssue(report.errors, {
      code: "entry_stage_missing",
      message: `Entry stage "${entryStageId}" does not exist`,
      path: "entryStageId",
    });
  }

  for (const stage of stages) {
    for (const transition of stage.transitions) {
      if (!knownIds.has(transition.to)) {
        addIssue(report.errors, {
          code: "stage_transition_unknown",
          message: `Stage "${stage.id}" transitions to unknown stage "${transition.to}"`,
          path: `stages.${stage.id}.transitions`,
          stageId: stage.id,
        });
      }
    }
    if (stage.type === "gate") {
      if (stage.index === stages.length - 1) {
        addIssue(report.errors, {
          code: "gate_stage_terminal",
          message: `Gate stage "${stage.id}" cannot be terminal`,
          path: `stages.${stage.id}`,
          stageId: stage.id,
        });
      }
      if (!stage.tools.some((tool) => GATE_TOOL_ALLOWLIST.has(tool))) {
        addIssue(report.errors, {
          code: "gate_stage_tool_missing",
          message: `Gate stage "${stage.id}" must declare at least one gate tool (${Array.from(GATE_TOOL_ALLOWLIST).join(", ")})`,
          path: `stages.${stage.id}.tools`,
          stageId: stage.id,
        });
      }
    }
    if (stage.repairLoop) {
      if (!Number.isFinite(stage.repairLoop.maxAttempts) || stage.repairLoop.maxAttempts < 1) {
        addIssue(report.errors, {
          code: "repair_loop_max_attempts_invalid",
          message: `Stage "${stage.id}" repairLoop.maxAttempts must be >= 1`,
          path: `stages.${stage.id}.repairLoop.maxAttempts`,
          stageId: stage.id,
        });
      }
      if (!stage.repairLoop.targetStageId) {
        addIssue(report.errors, {
          code: "repair_loop_target_missing",
          message: `Stage "${stage.id}" repairLoop.targetStageId is required`,
          path: `stages.${stage.id}.repairLoop.targetStageId`,
          stageId: stage.id,
        });
      } else if (!knownIds.has(stage.repairLoop.targetStageId)) {
        addIssue(report.errors, {
          code: "repair_loop_target_unknown",
          message: `Stage "${stage.id}" repairLoop.targetStageId references unknown stage "${stage.repairLoop.targetStageId}"`,
          path: `stages.${stage.id}.repairLoop.targetStageId`,
          stageId: stage.id,
        });
      }
    }
  }

  const reachable = new Set();
  const queue = knownIds.has(entryStageId) ? [entryStageId] : [];
  while (queue.length > 0) {
    const stageId = queue.shift();
    if (!stageId || reachable.has(stageId)) continue;
    reachable.add(stageId);
    const stage = stageById.get(stageId);
    for (const transition of toArray(stage?.transitions)) {
      if (transition?.to && !reachable.has(transition.to)) {
        queue.push(transition.to);
      }
    }
  }

  for (const stage of stages) {
    if (!reachable.has(stage.id)) {
      addIssue(report.warnings, {
        code: "stage_unreachable",
        message: `Stage "${stage.id}" is unreachable from entry stage "${entryStageId}"`,
        path: `stages.${stage.id}`,
        stageId: stage.id,
      });
    }
  }
}

export function compileInternalHarnessProfile(source, options = {}) {
  const profile = parseSourceObject(source);
  const report = { errors: [], warnings: [] };

  if (!isObject(profile)) {
    throw new Error("Harness source must compile to an object");
  }

  collectObjectIssues(profile, (key, value, path) => {
    if (typeof value !== "string") return;
    const trimmed = toTrimmedString(value);
    if (!trimmed) return;
    if (
      SECRET_KEY_RE.test(key) &&
      !SECRET_PLACEHOLDER_ENV_RE.test(trimmed) &&
      !SECRET_PLACEHOLDER_TEXT_RE.test(trimmed)
    ) {
      addIssue(report.errors, {
        code: "secret_literal_detected",
        message: `Secret-looking field "${path}" must not contain a literal secret`,
        path,
      });
    }
  });

  const stagesInput = toArray(profile.stages);
  if (stagesInput.length === 0) {
    addIssue(report.errors, {
      code: "stages_missing",
      message: "Harness profile requires a non-empty stages array",
      path: "stages",
    });
  }

  const stages = stagesInput.map((stage, index) => normalizeStage(stage, index));
  const entryStageId = toTrimmedString(profile.entryStageId || stages[0]?.id || "");
  const skills = validateSkillRefs(toArray(profile.skills), report);
  validateStages(stages, entryStageId, report);

  const stageCount = stages.length;
  const transitionCount = stages.reduce((sum, stage) => sum + stage.transitions.length, 0);
  const gateStageCount = stages.filter((stage) => stage.type === "gate").length;
  const repairLoopCount = stages.filter((stage) => stage.repairLoop).length;
  const unreachableStageCount = report.warnings.filter((issue) => issue.code === "stage_unreachable").length;

  const baseName = toTrimmedString(profile.name || profile.id || profile.agentId || "");
  const sourceHash = createHash("sha256")
    .update(JSON.stringify(profile))
    .digest("hex");
  const agentIdBase = slugify(baseName || entryStageId || "harness");
  const agentId = `${agentIdBase}-${sourceHash.slice(0, 12)}`;

  const compiledProfile = {
    schemaVersion: 1,
    kind: "bosun-internal-harness-profile",
    agentId,
    name: baseName || agentIdBase,
    description: toTrimmedString(profile.description || ""),
    entryStageId,
    skills,
    metadata: {
      compiledAt: new Date().toISOString(),
      sourceHash,
      stageCount,
      transitionCount,
      gateStageCount,
      repairLoopCount,
      unreachableStageCount,
    },
    stages: stages.map((stage) => ({
      id: stage.id,
      index: stage.index,
      type: stage.type,
      prompt: stage.prompt,
      tools: stage.tools,
      transitions: stage.transitions,
      repairLoop: stage.repairLoop,
      meta: stage.meta,
    })),
  };

  const compiledProfileJson = JSON.stringify(compiledProfile, null, 2);
  return {
    agentId,
    compiledProfile,
    compiledProfileJson,
    validationReport: {
      errors: report.errors,
      warnings: report.warnings,
      stats: {
        stageCount,
        transitionCount,
        gateStageCount,
        repairLoopCount,
        skillCount: skills.length,
        unreachableStageCount,
      },
    },
    isValid: report.errors.length === 0,
    sourceProfile: safeClone(profile),
    sourceHash,
  };
}

export default compileInternalHarnessProfile;
