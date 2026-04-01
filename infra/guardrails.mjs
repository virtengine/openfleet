import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectProjectStack } from "../workflow/project-detection.mjs";

export const DEFAULT_INPUT_POLICY = Object.freeze({
  enabled: true,
  warnThreshold: 60,
  blockThreshold: 35,
  minTitleLength: 8,
  minDescriptionLength: 24,
  minContextFields: 1,
  minCombinedTokens: 10,
});

export const DEFAULT_PUSH_POLICY = Object.freeze({
  workflowOnly: true,
  blockAgentPushes: true,
  requireManagedPrePush: true,
});

const GENERIC_TEXT_PATTERNS = [
  /\b(?:asdf|placeholder|tbd|todo|unknown|misc|thing|stuff|whatever)\b/i,
  /^(?:fix|test|tmp|wip|na|n\/a|none|help)$/i,
  /^\W+$/,
];

function parseBooleanLike(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function clampNumber(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function collectTextValues(value, bucket = []) {
  if (value == null) return bucket;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = normalizeText(value);
    if (normalized) bucket.push(normalized);
    return bucket;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectTextValues(entry, bucket);
    return bucket;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (["guardrailsOverride", "overrideGuardrails", "INPUTOverride"].includes(key)) continue;
      collectTextValues(entry, bucket);
    }
  }
  return bucket;
}

function tokenize(text) {
  return normalizeText(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
}

function addFinding(findings, id, penalty, message) {
  findings.push({
    id,
    penalty,
    message,
    severity: penalty >= 25 ? "high" : penalty >= 15 ? "medium" : "low",
  });
}

function readPolicyFile(policyPath) {
  if (!existsSync(policyPath)) return {};
  try {
    return JSON.parse(readFileSync(policyPath, "utf8"));
  } catch {
    return {};
  }
}

function normalizeScriptEntries(scripts, matcher) {
  return Object.entries(scripts)
    .filter(([name]) => matcher.test(String(name || "")))
    .map(([name, command]) => ({ name, command: String(command || "") }));
}

export function normalizeINPUTPolicy(raw = {}) {
  return {
    enabled: parseBooleanLike(raw?.enabled, DEFAULT_INPUT_POLICY.enabled),
    warnThreshold: clampNumber(raw?.warnThreshold, 1, 100, DEFAULT_INPUT_POLICY.warnThreshold),
    blockThreshold: clampNumber(raw?.blockThreshold, 0, 100, DEFAULT_INPUT_POLICY.blockThreshold),
    minTitleLength: clampNumber(raw?.minTitleLength, 0, 200, DEFAULT_INPUT_POLICY.minTitleLength),
    minDescriptionLength: clampNumber(raw?.minDescriptionLength, 0, 2000, DEFAULT_INPUT_POLICY.minDescriptionLength),
    minContextFields: clampNumber(raw?.minContextFields, 0, 50, DEFAULT_INPUT_POLICY.minContextFields),
    minCombinedTokens: clampNumber(raw?.minCombinedTokens, 0, 200, DEFAULT_INPUT_POLICY.minCombinedTokens),
  };
}

export function normalizePushPolicy(raw = {}) {
  return {
    workflowOnly: parseBooleanLike(raw?.workflowOnly, DEFAULT_PUSH_POLICY.workflowOnly),
    blockAgentPushes: parseBooleanLike(raw?.blockAgentPushes, DEFAULT_PUSH_POLICY.blockAgentPushes),
    requireManagedPrePush: parseBooleanLike(raw?.requireManagedPrePush, DEFAULT_PUSH_POLICY.requireManagedPrePush),
  };
}

export function normalizeGuardrailsPolicy(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    INPUT: normalizeINPUTPolicy(source?.INPUT && typeof source.INPUT === "object" ? source.INPUT : {}),
    push: normalizePushPolicy(source?.push && typeof source.push === "object" ? source.push : {}),
  };
}

export function getGuardrailsPolicyPath(rootDir) {
  return resolve(rootDir, ".bosun", "guardrails.json");
}

export function loadGuardrailsPolicy(rootDir) {
  const policyPath = getGuardrailsPolicyPath(rootDir);
  return normalizeGuardrailsPolicy(readPolicyFile(policyPath));
}

export function saveGuardrailsPolicy(rootDir, raw = {}) {
  const normalized = normalizeGuardrailsPolicy(raw);
  const policyPath = getGuardrailsPolicyPath(rootDir);
  mkdirSync(resolve(rootDir, ".bosun"), { recursive: true });
  writeFileSync(policyPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

export function ensureGuardrailsPolicy(rootDir) {
  const policyPath = getGuardrailsPolicyPath(rootDir);
  if (!existsSync(policyPath)) {
    return saveGuardrailsPolicy(rootDir, { INPUT: DEFAULT_INPUT_POLICY, push: DEFAULT_PUSH_POLICY });
  }
  const normalized = loadGuardrailsPolicy(rootDir);
  writeFileSync(policyPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

export function shouldBlockAgentPushes(rootDir) {
  return loadGuardrailsPolicy(rootDir).push.blockAgentPushes !== false;
}

export function shouldRequireManagedPrePush(rootDir) {
  return loadGuardrailsPolicy(rootDir).push.requireManagedPrePush !== false;
}

export function detectRepoGuardrails(rootDir) {
  // ── npm/package.json detection (legacy, always attempted) ───────────────
  const packageJsonPath = resolve(rootDir, "package.json");
  let packageJson = null;
  try {
    packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch {
    packageJson = null;
  }

  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object"
    ? packageJson.scripts
    : {};
  const prepushScripts = normalizeScriptEntries(scripts, /^(?:prepush(?::|$)|pre-push$|check:prepush$)/i);
  const prepublishScripts = normalizeScriptEntries(scripts, /^(?:prepublish(?:only)?(?::|$)|pre-publish$)/i);
  const ciScripts = normalizeScriptEntries(
    scripts,
    /^(?:ci(?::|$)|test(?::|$)|build(?::|$)|lint(?::|$)|check(?::|$)|verify(?::|$)|release(?::|$))/i,
  ).filter((entry) => !prepushScripts.some((candidate) => candidate.name === entry.name));

  // ── Language-aware stack detection ──────────────────────────────────────
  let stack = null;
  try {
    stack = detectProjectStack(rootDir);
  } catch { /* project-detection may not be available in all environments */ }

  const stacks = Array.isArray(stack?.stacks) ? stack.stacks : [];
  const primary = stack?.primary || null;
  const stackCommands = primary?.commands || {};

  // Build language-aware guardrail categories from detected stack commands.
  // For npm projects the prepush/prepublish scripts are the authoritative source;
  // for every other language we synthesize equivalent categories from the
  // detected test / build / lint / qualityGate commands.
  const stackTestScripts = [];
  const stackBuildScripts = [];
  const stackLintScripts = [];
  const stackQualityGateScripts = [];

  for (const s of stacks) {
    const cmds = s.commands || {};
    if (cmds.test) stackTestScripts.push({ name: `${s.id}:test`, command: cmds.test });
    if (cmds.build) stackBuildScripts.push({ name: `${s.id}:build`, command: cmds.build });
    if (cmds.lint) stackLintScripts.push({ name: `${s.id}:lint`, command: cmds.lint });
    if (cmds.qualityGate) stackQualityGateScripts.push({ name: `${s.id}:qualityGate`, command: cmds.qualityGate });
    if (cmds.syntaxCheck && cmds.syntaxCheck !== cmds.lint) {
      stackLintScripts.push({ name: `${s.id}:syntaxCheck`, command: cmds.syntaxCheck });
    }
    if (cmds.typeCheck && cmds.typeCheck !== cmds.lint && cmds.typeCheck !== cmds.syntaxCheck) {
      stackLintScripts.push({ name: `${s.id}:typeCheck`, command: cmds.typeCheck });
    }
  }

  // Merge: npm scripts win when present; stack-detected scripts fill gaps.
  const mergedPrepush = prepushScripts.length > 0
    ? prepushScripts
    : stackQualityGateScripts;
  const mergedCi = ciScripts.length > 0
    ? ciScripts
    : [...stackTestScripts, ...stackBuildScripts, ...stackLintScripts];

  const categories = {
    prepush: {
      detected: mergedPrepush.length > 0,
      enforced: mergedPrepush.length > 0,
      scripts: mergedPrepush,
    },
    prepublish: {
      detected: prepublishScripts.length > 0,
      enforced: prepublishScripts.length > 0,
      scripts: prepublishScripts,
    },
    ci: {
      detected: mergedCi.length > 0,
      enforced: mergedCi.length > 0,
      scripts: mergedCi,
    },
    test: {
      detected: stackTestScripts.length > 0 || ciScripts.some((s) => /\btest\b/i.test(s.name)),
      enforced: false,
      scripts: stackTestScripts.length > 0 ? stackTestScripts : ciScripts.filter((s) => /\btest\b/i.test(s.name)),
    },
    build: {
      detected: stackBuildScripts.length > 0 || ciScripts.some((s) => /\bbuild\b/i.test(s.name)),
      enforced: false,
      scripts: stackBuildScripts.length > 0 ? stackBuildScripts : ciScripts.filter((s) => /\bbuild\b/i.test(s.name)),
    },
    lint: {
      detected: stackLintScripts.length > 0 || ciScripts.some((s) => /\blint\b/i.test(s.name)),
      enforced: false,
      scripts: stackLintScripts.length > 0 ? stackLintScripts : ciScripts.filter((s) => /\blint\b/i.test(s.name)),
    },
  };

  return {
    rootDir,
    packageJsonPath,
    hasPackageJson: packageJson != null,
    packageName: typeof packageJson?.name === "string" ? packageJson.name : "",
    categories,
    detectedCount: Object.values(categories).filter((entry) => entry.detected).length,
    // New stack-aware fields
    stacks,
    primaryStack: primary ? {
      id: primary.id,
      label: primary.label,
      packageManager: primary.packageManager,
      frameworks: primary.frameworks || [],
    } : null,
    stackCommands,
    isMonorepo: stacks.length > 1,
    detectedLanguages: stacks.map((s) => s.label),
  };
}

export function assessInputQuality(input = {}, policy = DEFAULT_INPUT_POLICY) {
  const normalizedPolicy = normalizeINPUTPolicy(policy);
  const title = normalizeText(input?.title);
  const description = normalizeText(input?.description);
  const metadataValues = collectTextValues(input?.metadata || {});
  const formValues = collectTextValues(input?.formValues || {});
  const contextValues = [...metadataValues, ...formValues];
  const combinedText = [title, description, ...contextValues].filter(Boolean).join(" ");
  const tokens = tokenize(combinedText);
  const uniqueTokens = new Set(tokens);
  const uniqueTokenRatio = tokens.length > 0 ? uniqueTokens.size / tokens.length : 0;
  const genericHits = [title, description, ...contextValues].filter(Boolean).filter((value) =>
    GENERIC_TEXT_PATTERNS.some((pattern) => pattern.test(value)),
  );

  const findings = [];
  let score = 100;

  if (normalizedPolicy.enabled !== true) {
    return {
      policy: normalizedPolicy,
      score,
      status: "disabled",
      blocked: false,
      summary: "INPUT guardrails are disabled.",
      findings,
      metrics: {
        titleLength: title.length,
        descriptionLength: description.length,
        contextFieldCount: contextValues.length,
        tokenCount: tokens.length,
        uniqueTokenRatio,
      },
    };
  }

  if (!title) {
    score -= 45;
    addFinding(findings, "missing-title", 45, "A clear title is required.");
  } else if (title.length < normalizedPolicy.minTitleLength) {
    const penalty = 30;
    score -= penalty;
    addFinding(findings, "short-title", penalty, `Title should be at least ${normalizedPolicy.minTitleLength} characters.`);
  }

  if (!description) {
    score -= 35;
    addFinding(findings, "missing-description", 35, "Add a description with enough implementation context.");
  } else if (description.length < normalizedPolicy.minDescriptionLength) {
    const penalty = 15;
    score -= penalty;
    addFinding(findings, "thin-description", penalty, `Description should be at least ${normalizedPolicy.minDescriptionLength} characters.`);
  }

  if (contextValues.length < normalizedPolicy.minContextFields) {
    const penalty = 15;
    score -= penalty;
    addFinding(findings, "missing-context", penalty, `Provide at least ${normalizedPolicy.minContextFields} populated context field(s).`);
  }

  if (tokens.length < normalizedPolicy.minCombinedTokens) {
    const penalty = 20;
    score -= penalty;
    addFinding(findings, "low-signal", penalty, `Input should contain at least ${normalizedPolicy.minCombinedTokens} meaningful tokens.`);
  }

  if (uniqueTokenRatio > 0 && uniqueTokenRatio < 0.45) {
    const penalty = 10;
    score -= penalty;
    addFinding(findings, "repetitive-input", penalty, "Input is too repetitive to be reliable.");
  }

  if (title && description && title.toLowerCase() === description.toLowerCase()) {
    const penalty = 10;
    score -= penalty;
    addFinding(findings, "duplicated-summary", penalty, "Title and description should not repeat the same text.");
  }

  if (genericHits.length > 0) {
    const penalty = Math.min(30, genericHits.length * 10);
    score -= penalty;
    addFinding(findings, "generic-language", penalty, "Replace placeholder or generic text with concrete intent.");
  }

  score = Math.max(0, Math.min(100, score));
  const status = score < normalizedPolicy.blockThreshold
    ? "block"
    : score < normalizedPolicy.warnThreshold
      ? "warn"
      : "pass";

  return {
    policy: normalizedPolicy,
    score,
    status,
    blocked: status === "block",
    summary:
      findings[0]?.message ||
      (status === "pass" ? "Input quality passed INPUT guardrails." : "Input quality needs more detail."),
    findings,
    metrics: {
      titleLength: title.length,
      descriptionLength: description.length,
      contextFieldCount: contextValues.length,
      tokenCount: tokens.length,
      uniqueTokenRatio: Number(uniqueTokenRatio.toFixed(3)),
      genericHitCount: genericHits.length,
    },
  };
}
