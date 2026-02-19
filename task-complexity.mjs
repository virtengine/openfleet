/**
 * task-complexity.mjs — Task complexity routing for openfleet.
 *
 * Maps task size/complexity to appropriate AI models and reasoning effort
 * levels. Each executor type (CODEX, COPILOT/Claude) has its own model tier
 * ladder, so small tasks use cheaper/faster models while complex tasks get
 * the most capable models.
 *
 * Complexity Tiers:
 *   LOW    — xs/s tasks: simple fixes, docs, config changes
 *   MEDIUM — m tasks: standard feature work, moderate refactors
 *   HIGH   — l/xl/xxl tasks: complex architecture, multi-file changes
 *
 * Default Model Mapping:
 *   ┌──────────┬──────────────────────┬─────────────────────┐
 *   │ Tier     │ CODEX                │ COPILOT (Claude)    │
 *   ├──────────┼──────────────────────┼─────────────────────┤
 *   │ LOW      │ gpt-5.1-codex-mini   │ haiku-4.5           │
 *   │ MEDIUM   │ gpt-5.2-codex        │ sonnet-4.5          │
 *   │ HIGH     │ gpt-5.1-codex-max    │ opus-4.6            │
 *   └──────────┴──────────────────────┴─────────────────────┘
 *
 * Reasoning Effort per tier:
 *   LOW    → "low"
 *   MEDIUM → "medium"
 *   HIGH   → "high"
 *
 * The orchestrator calls `resolveExecutorForTask(task, executorProfile, config)`
 * to get the optimal model/variant/reasoning for that specific task.
 */

// ── Constants ────────────────────────────────────────────────────────────────

export const COMPLEXITY_TIERS = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
});

/**
 * Map task size labels (from ve-orchestrator.ps1 Get-TaskSizeInfo) to
 * complexity tiers. The size→complexity mapping is intentionally simple.
 */
export const SIZE_TO_COMPLEXITY = Object.freeze({
  xs: COMPLEXITY_TIERS.LOW,
  s: COMPLEXITY_TIERS.LOW,
  m: COMPLEXITY_TIERS.MEDIUM,
  l: COMPLEXITY_TIERS.HIGH,
  xl: COMPLEXITY_TIERS.HIGH,
  xxl: COMPLEXITY_TIERS.HIGH,
});

/**
 * Default model profiles per executor type and complexity tier.
 * Users can override via config.complexityRouting.models
 */
export const DEFAULT_MODEL_PROFILES = Object.freeze({
  CODEX: {
    [COMPLEXITY_TIERS.LOW]: {
      model: "gpt-5.1-codex-mini",
      variant: "GPT51_CODEX_MINI",
      reasoningEffort: "low",
    },
    [COMPLEXITY_TIERS.MEDIUM]: {
      model: "gpt-5.2-codex",
      variant: "DEFAULT",
      reasoningEffort: "medium",
    },
    [COMPLEXITY_TIERS.HIGH]: {
      model: "gpt-5.1-codex-max",
      variant: "GPT51_CODEX_MAX",
      reasoningEffort: "high",
    },
  },
  COPILOT: {
    [COMPLEXITY_TIERS.LOW]: {
      model: "haiku-4.5",
      variant: "CLAUDE_HAIKU_4_5",
      reasoningEffort: "low",
    },
    [COMPLEXITY_TIERS.MEDIUM]: {
      model: "sonnet-4.5",
      variant: "CLAUDE_SONNET_4_5",
      reasoningEffort: "medium",
    },
    [COMPLEXITY_TIERS.HIGH]: {
      model: "opus-4.6",
      variant: "CLAUDE_OPUS_4_6",
      reasoningEffort: "high",
    },
  },
});

/**
 * Additional model aliases for manual overrides and telegram /model command.
 * These are not used in automatic routing but allow explicit model selection.
 */
export const MODEL_ALIASES = Object.freeze({
  "gpt-5.1-codex-mini": { executor: "CODEX", variant: "GPT51_CODEX_MINI" },
  "gpt-5.2-codex": { executor: "CODEX", variant: "DEFAULT" },
  "gpt-5.1-codex-max": { executor: "CODEX", variant: "GPT51_CODEX_MAX" },
  "claude-opus-4.6": { executor: "COPILOT", variant: "CLAUDE_OPUS_4_6" },
  "opus-4.6": { executor: "COPILOT", variant: "CLAUDE_OPUS_4_6" },
  "sonnet-4.5": { executor: "COPILOT", variant: "CLAUDE_SONNET_4_5" },
  "haiku-4.5": { executor: "COPILOT", variant: "CLAUDE_HAIKU_4_5" },
  "claude-code": { executor: "COPILOT", variant: "CLAUDE_CODE" },
});

/**
 * Keywords in task titles/descriptions that bump complexity up or down.
 * Scanned case-insensitively against the combined task text blob.
 */
export const COMPLEXITY_SIGNALS = Object.freeze({
  /** Signals that push complexity UP */
  escalators: [
    // Architecture / multi-system
    /\b(architect|redesign|refactor.*entire|overhaul|migration)\b/i,
    /\b(multi[- ]?module|cross[- ]?cutting|system[- ]?wide)\b/i,
    /\b(breaking\s+change|backward.*compat|api.*redesign)\b/i,
    // Security / crypto
    /\b(security.*audit|vulnerability|encryption.*scheme|key.*rotation)\b/i,
    // Consensus / blockchain specific
    /\b(consensus|determinism|state.*machine|genesis|upgrade.*handler)\b/i,
    // Testing complexity
    /\b(e2e.*test.*suite|integration.*framework|test.*infrastructure)\b/i,
    // Scale / performance
    /\b(load\s+test|stress\s+test|1M|1,000,000|million\s+nodes?)\b/i,
    /\b(service\s+mesh|api\s+gateway|mTLS|circuit\s+breaker)\b/i,
    // LOC estimation (>3000 LOC signals high complexity)
    /Est\.?\s*LOC\s*:\s*[3-9],?\d{3}/i,
    /Est\.?\s*LOC\s*:\s*\d{2,},?\d{3}/i,
    // Multi-file / broad scope
    /\b(\d{2,}\s+(?:test|file|module)s?\s+fail)/i,
    /\b(disaster\s+recovery|business\s+continuity|CRITICAL)\b/i,
  ],
  /** Signals that push complexity DOWN */
  simplifiers: [
    /\b(typo|typos|spelling|grammar)\b/i,
    /\b(bump|upgrade)\s+(version|dep|dependency)\b/i,
    /\b(readme|changelog|docs?\s+only)\b/i,
    /\b(lint|format|prettier|eslint)\s*(fix|cleanup|config)?\b/i,
    /\b(rename|move\s+file|copy\s+file)\b/i,
    /\b(add\s+comment|update\s+comment)\b/i,
    /\b(config\s+change|env\s+var|\.env)\b/i,
    // Plan-only tasks
    /\bPlan\s+next\s+tasks\b/i,
    /\b(manual[- ]telegram|triage)\b/i,
  ],
});

// ── Core Functions ───────────────────────────────────────────────────────────

/**
 * Classify a task's complexity tier based on its size label and text content.
 *
 * @param {object} params
 * @param {string} [params.sizeLabel] - Task size: xs/s/m/l/xl/xxl
 * @param {string} [params.title]     - Task title
 * @param {string} [params.description] - Task description
 * @param {number} [params.points]    - Story points (optional, used if sizeLabel missing)
 * @returns {{ tier: string, reason: string, sizeLabel: string, adjusted: boolean }}
 */
export function classifyComplexity({
  sizeLabel,
  title = "",
  description = "",
  points,
} = {}) {
  // Resolve size label from points if not provided
  let resolvedSize = (sizeLabel || "m").toLowerCase();
  if (!sizeLabel && typeof points === "number") {
    if (points <= 1) resolvedSize = "xs";
    else if (points <= 2) resolvedSize = "s";
    else if (points <= 5) resolvedSize = "m";
    else if (points <= 8) resolvedSize = "l";
    else if (points <= 13) resolvedSize = "xl";
    else resolvedSize = "xxl";
  }

  // Base tier from size
  let tier = SIZE_TO_COMPLEXITY[resolvedSize] || COMPLEXITY_TIERS.MEDIUM;
  const baseTier = tier;
  let adjusted = false;
  let reason = `size=${resolvedSize}`;

  // Scan text for complexity signals
  const text = `${title} ${description}`.trim();
  if (text) {
    const escalatorHits = COMPLEXITY_SIGNALS.escalators.filter((rx) =>
      rx.test(text),
    );
    const simplifierHits = COMPLEXITY_SIGNALS.simplifiers.filter((rx) =>
      rx.test(text),
    );

    if (escalatorHits.length > 0 && simplifierHits.length === 0) {
      // Escalate: LOW→MEDIUM, MEDIUM→HIGH (HIGH stays HIGH)
      if (tier === COMPLEXITY_TIERS.LOW) {
        tier = COMPLEXITY_TIERS.MEDIUM;
        adjusted = true;
        reason += " → escalated by keywords";
      } else if (tier === COMPLEXITY_TIERS.MEDIUM) {
        tier = COMPLEXITY_TIERS.HIGH;
        adjusted = true;
        reason += " → escalated by keywords";
      }
    } else if (simplifierHits.length > 0 && escalatorHits.length === 0) {
      // Simplify: HIGH→MEDIUM, MEDIUM→LOW (LOW stays LOW)
      if (tier === COMPLEXITY_TIERS.HIGH) {
        tier = COMPLEXITY_TIERS.MEDIUM;
        adjusted = true;
        reason += " → simplified by keywords";
      } else if (tier === COMPLEXITY_TIERS.MEDIUM) {
        tier = COMPLEXITY_TIERS.LOW;
        adjusted = true;
        reason += " → simplified by keywords";
      }
    }
    // If both hit, they cancel out — keep the base tier
  }

  return { tier, reason, sizeLabel: resolvedSize, adjusted, baseTier };
}

/**
 * Get the model profile for a given complexity tier and executor type.
 *
 * @param {string} tier       - Complexity tier: "low" | "medium" | "high"
 * @param {string} executorType - "CODEX" | "COPILOT"
 * @param {object} [configOverrides] - User-provided model overrides from config
 * @returns {{ model: string, variant: string, reasoningEffort: string }}
 */
export function getModelForComplexity(tier, executorType, configOverrides) {
  const normalizedType = (executorType || "CODEX").toUpperCase();
  const normalizedTier = (tier || "medium").toLowerCase();

  // Check user overrides first
  if (configOverrides?.models?.[normalizedType]?.[normalizedTier]) {
    return { ...configOverrides.models[normalizedType][normalizedTier] };
  }

  // Fall back to defaults
  const profiles = DEFAULT_MODEL_PROFILES[normalizedType];
  if (!profiles) {
    // Unknown executor type — return a safe default
    return {
      model: null,
      variant: null,
      reasoningEffort: normalizedTier === "high" ? "high" : "medium",
    };
  }

  return { ...(profiles[normalizedTier] || profiles[COMPLEXITY_TIERS.MEDIUM]) };
}

/**
 * Resolve the optimal executor profile for a specific task.
 *
 * This is the main entry point for the orchestrator. Given a task and the
 * base executor profile (from round-robin/weighted selection), it returns
 * an enhanced profile with the right model/variant/reasoning for the task's
 * complexity.
 *
 * @param {object} task - Task object from VK (has .title, .description, fields, metadata)
 * @param {object} baseProfile - Executor profile from ExecutorScheduler.next()
 *   { name, executor, variant, weight, role, enabled }
 * @param {object} [complexityConfig] - Config from loadConfig().complexityRouting
 * @returns {{
 *   executor: string,
 *   variant: string,
 *   model: string,
 *   reasoningEffort: string,
 *   complexity: { tier: string, reason: string, sizeLabel: string, adjusted: boolean },
 *   original: object
 * }}
 */
export function resolveExecutorForTask(task, baseProfile, complexityConfig) {
  const config = complexityConfig || {};

  // If complexity routing is disabled, return base profile as-is
  if (config.enabled === false) {
    return {
      ...baseProfile,
      model: null,
      reasoningEffort: null,
      complexity: null,
      original: baseProfile,
    };
  }

  // Extract task info
  const title = task?.title || "";
  const description = task?.description || "";
  const sizeLabel = extractSizeLabel(task);
  const points = extractPoints(task);

  // Classify complexity
  const complexity = classifyComplexity({
    sizeLabel,
    title,
    description,
    points,
  });

  // Get model profile for this tier + executor type
  const executorType = (baseProfile?.executor || "CODEX").toUpperCase();
  const modelProfile = getModelForComplexity(
    complexity.tier,
    executorType,
    config,
  );

  return {
    name: baseProfile?.name || "auto",
    executor: baseProfile?.executor || "CODEX",
    variant: modelProfile.variant || baseProfile?.variant || "DEFAULT",
    weight: baseProfile?.weight || 100,
    role: baseProfile?.role || "primary",
    enabled: baseProfile?.enabled !== false,
    model: modelProfile.model,
    reasoningEffort: modelProfile.reasoningEffort,
    complexity,
    original: baseProfile,
  };
}

/**
 * Produce a human-readable summary of the complexity routing decision.
 * Used for log output and Telegram notifications.
 *
 * @param {object} resolved - Output from resolveExecutorForTask()
 * @returns {string}
 */
export function formatComplexityDecision(resolved) {
  if (!resolved?.complexity) return "complexity=disabled";
  const { complexity, model, reasoningEffort, executor } = resolved;
  const parts = [
    `complexity=${complexity.tier}`,
    `size=${complexity.sizeLabel}`,
    `model=${model || "default"}`,
    `reasoning=${reasoningEffort || "default"}`,
    `executor=${executor}`,
  ];
  if (complexity.adjusted) {
    parts.push(`adjusted=true`);
  }
  return parts.join(" ");
}

/**
 * Get all available complexity tiers with their model mappings.
 * Useful for config validation and UI display.
 *
 * @param {object} [configOverrides] - User config overrides
 * @returns {object} Map of executorType → tier → modelProfile
 */
export function getComplexityMatrix(configOverrides) {
  const matrix = {};
  for (const executorType of ["CODEX", "COPILOT"]) {
    matrix[executorType] = {};
    for (const tier of Object.values(COMPLEXITY_TIERS)) {
      matrix[executorType][tier] = getModelForComplexity(
        tier,
        executorType,
        configOverrides,
      );
    }
  }
  return matrix;
}

// ── Task Completion Confidence ───────────────────────────────────────────────

/**
 * Confidence levels for task completion.
 * Agents should mark tasks with one of these to signal review needs.
 */
export const COMPLETION_CONFIDENCE = Object.freeze({
  /** Task fully completed, all tests pass, no concerns */
  CONFIDENT: "confident",
  /** Task completed but some edge cases may need review */
  NEEDS_REVIEW: "needs-review",
  /** Task partially completed, blocked or uncertain */
  PARTIAL: "partial",
  /** Task failed, needs replanning or different approach */
  FAILED: "failed",
});

/**
 * Assess completion confidence based on task outcome signals.
 *
 * @param {object} params
 * @param {boolean} params.testsPass        - Did all tests pass?
 * @param {boolean} params.buildClean       - Is the build clean (0 warnings)?
 * @param {boolean} params.lintClean        - Did linting pass?
 * @param {number}  params.filesChanged     - Number of files changed
 * @param {number}  params.attemptCount     - How many attempts so far
 * @param {string}  params.complexityTier   - The task's complexity tier
 * @param {boolean} [params.hasTestCoverage] - Were new tests added for new code?
 * @param {string[]} [params.warnings]      - Any warning messages from the agent
 * @returns {{ confidence: string, reason: string, shouldAutoMerge: boolean }}
 */
export function assessCompletionConfidence({
  testsPass = false,
  buildClean = false,
  lintClean = false,
  filesChanged = 0,
  attemptCount = 1,
  complexityTier = COMPLEXITY_TIERS.MEDIUM,
  hasTestCoverage,
  warnings = [],
}) {
  // Failed basic checks → FAILED
  if (!testsPass || !buildClean) {
    return {
      confidence: COMPLETION_CONFIDENCE.FAILED,
      reason: testsPass ? "build has errors" : "tests failing",
      shouldAutoMerge: false,
    };
  }

  // High complexity + many files + no explicit test coverage → NEEDS_REVIEW
  if (
    complexityTier === COMPLEXITY_TIERS.HIGH &&
    filesChanged > 10 &&
    hasTestCoverage === false
  ) {
    return {
      confidence: COMPLETION_CONFIDENCE.NEEDS_REVIEW,
      reason: "high complexity with many files and no new test coverage",
      shouldAutoMerge: false,
    };
  }

  // Multiple attempts suggest difficulty → NEEDS_REVIEW
  if (attemptCount >= 3) {
    return {
      confidence: COMPLETION_CONFIDENCE.NEEDS_REVIEW,
      reason: `required ${attemptCount} attempts`,
      shouldAutoMerge: false,
    };
  }

  // Warnings present → NEEDS_REVIEW
  if (warnings.length > 0) {
    return {
      confidence: COMPLETION_CONFIDENCE.NEEDS_REVIEW,
      reason: `${warnings.length} warning(s) reported`,
      shouldAutoMerge: false,
    };
  }

  // Lint issues → NEEDS_REVIEW (non-blocking but review worthy)
  if (!lintClean) {
    return {
      confidence: COMPLETION_CONFIDENCE.NEEDS_REVIEW,
      reason: "lint warnings present",
      shouldAutoMerge: false,
    };
  }

  // All clean → CONFIDENT
  return {
    confidence: COMPLETION_CONFIDENCE.CONFIDENT,
    reason: "all checks pass",
    shouldAutoMerge: true,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract size label from a VK task object.
 * Mirrors the logic in Get-TaskSizeInfo (ve-orchestrator.ps1).
 */
function extractSizeLabel(task) {
  if (!task) return null;

  // Check direct fields
  for (const field of [
    "size",
    "estimate",
    "story_points",
    "points",
    "effort",
    "complexity",
  ]) {
    const value = task[field];
    if (value && typeof value === "string") return value.toLowerCase();
    if (typeof value === "number") return pointsToSize(value);
  }

  // Check metadata
  if (task.metadata && typeof task.metadata === "object") {
    for (const field of [
      "size",
      "estimate",
      "story_points",
      "points",
      "effort",
    ]) {
      const value = task.metadata[field];
      if (value && typeof value === "string") return value.toLowerCase();
      if (typeof value === "number") return pointsToSize(value);
    }
  }

  // Scan title for [size] pattern
  const text = `${task.title || ""} ${task.description || ""}`;
  const bracketMatch = text.match(/\[(xs|s|m|l|xl|xxl|2xl)\]/i);
  if (bracketMatch) return bracketMatch[1].toLowerCase();

  // Scan for size: value pattern
  const colonMatch = text.match(
    /\b(?:size|effort|estimate|points|story\s*points)\s*[:=]\s*(xs|s|small|m|medium|l|large|xl|x-large|xxl|2xl)\b/i,
  );
  if (colonMatch) {
    const token = colonMatch[1].toLowerCase();
    if (token === "small") return "s";
    if (token === "medium" || token === "med") return "m";
    if (token === "large" || token === "big") return "l";
    if (token === "x-large") return "xl";
    if (token === "2xl") return "xxl";
    return token;
  }

  // Scan for numeric points
  const pointsMatch = text.match(
    /\b(?:size|effort|estimate|points|story\s*points)\s*[:=]\s*(\d+(?:\.\d+)?)\b/i,
  );
  if (pointsMatch) return pointsToSize(Number(pointsMatch[1]));

  return null;
}

/**
 * Extract numeric points from a VK task object.
 */
function extractPoints(task) {
  if (!task) return null;
  for (const field of [
    "points",
    "story_points",
    "estimate",
    "effort",
    "size",
  ]) {
    const value = task[field];
    if (typeof value === "number") return value;
  }
  if (task.metadata && typeof task.metadata === "object") {
    for (const field of ["points", "story_points", "estimate", "effort"]) {
      const value = task.metadata[field];
      if (typeof value === "number") return value;
    }
  }
  return null;
}

/**
 * Convert numeric story points to a size label.
 * Mirrors Resolve-TaskSizeFromPoints in ve-orchestrator.ps1.
 */
function pointsToSize(points) {
  if (points <= 1) return "xs";
  if (points <= 2) return "s";
  if (points <= 5) return "m";
  if (points <= 8) return "l";
  if (points <= 13) return "xl";
  return "xxl";
}

/**
 * Map executor type string to SDK-compatible identifier.
 */
export function executorToSdk(executorType) {
  const normalized = (executorType || "").toUpperCase();
  if (normalized === "CLAUDE") return "claude";
  if (normalized === "COPILOT") return "copilot";
  return "codex";
}
