// CLAUDE:SUMMARY — internal-harness-profile
// Compiles markdown or JSON harness definitions into validated Bosun-native
// execution profiles with secret/prompt-safety checks and normalized stages.

const SECRET_KEYS = [
  "secret",
  "token",
  "password",
  "api_key",
  "apikey",
  "access_key",
];

const PROMPT_INJECTION_PATTERNS = [
  "ignore previous instructions",
  "ignore all previous instructions",
  "disregard prior instructions",
  "forget previous instructions",
  "ignore safety constraints",
  "bypass guardrails",
  "override system instruction",
  "act as system",
  "developer message",
  "reveal system prompt",
  "jailbreak",
];

const UNSAFE_EXECUTION_PATTERNS = [
  "rm -rf",
  "sudo rm -rf",
  "curl | sh",
  "wget | sh",
  "base64 -d | sh",
  "metadata.google.internal",
  "169.254.169.254",
  "begin private key",
  "~/.ssh",
  "/etc/passwd",
  "send secrets",
  "exfiltrate",
];

function createIssue(code, message, level = "error", path = "") {
  return {
    code,
    message,
    level,
    path: String(path || "").trim() || null,
  };
}

function containsIgnoreCase(source, pattern) {
  return String(source || "").toLowerCase().includes(String(pattern || "").toLowerCase());
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePositiveInteger(value, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/\r?\n|[,;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeExtensionIds(value) {
  return Array.from(new Set(
    normalizeStringArray(value)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean),
  ));
}

function normalizeTaskKey(value, fallback) {
  const normalized = String(value || fallback || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || String(fallback || "harness-task");
}

function extractFence(input, marker) {
  const text = String(input || "");
  const startIndex = text.indexOf(marker);
  if (startIndex === -1) return null;
  const contentStart = text.indexOf("\n", startIndex + marker.length);
  if (contentStart === -1) return null;
  const endIndex = text.indexOf("```", contentStart + 1);
  if (endIndex === -1) return null;
  return text.slice(contentStart + 1, endIndex).trim();
}

function extractProfilePayload(source) {
  const text = String(source || "").trim();
  if (!text) return null;
  if (text.startsWith("{")) return text;
  return extractFence(text, "```json") || extractFence(text, "```");
}

function scanSensitiveKeys(value, issues, path = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanSensitiveKeys(entry, issues, `${path}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nextValue] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (SECRET_KEYS.some((pattern) => containsIgnoreCase(key, pattern))) {
      issues.push(
        createIssue(
          "PROFILE_CONTAINS_SECRET_FIELD",
          `Profile field "${nextPath}" looks secret-bearing and is not allowed in harness profiles.`,
          "error",
          nextPath,
        ),
      );
    }
    scanSensitiveKeys(nextValue, issues, nextPath);
  }
}

function containsLikelySecretLiteral(source) {
  const text = String(source || "");
  for (const key of SECRET_KEYS) {
    const regex = new RegExp(`${key}\\s*["']?\\s*[:=]\\s*["'][^"']{8,}`, "i");
    if (regex.test(text)) return true;
  }
  return false;
}

function normalizeStage(stage, index, profileDefaults, issues) {
  const path = `stages[${index}]`;
  if (!isPlainObject(stage)) {
    issues.push(createIssue("STAGE_INVALID", `Stage ${index + 1} must be an object.`, "error", path));
    return null;
  }

  const id = String(stage.id || `stage-${index + 1}`).trim();
  const prompt = String(stage.prompt || stage.userMessage || "").trim();
  if (!prompt) {
    issues.push(createIssue("STAGE_PROMPT_REQUIRED", `Stage "${id}" is missing a prompt.`, "error", `${path}.prompt`));
    return null;
  }

  const followUps = normalizeStringArray(stage.followUps);
  const steering = normalizeStringArray(stage.steering);

  return {
    id,
    prompt,
    sessionType: String(stage.sessionType || profileDefaults.sessionType || "task").trim() || "task",
    taskKeySuffix: normalizeTaskKey(stage.taskKeySuffix, id),
    sdk: String(stage.sdk || profileDefaults.sdk || "").trim() || null,
    model: String(stage.model || profileDefaults.model || "").trim() || null,
    cwd: String(stage.cwd || profileDefaults.cwd || "").trim() || null,
    maxRetries: normalizePositiveInteger(stage.maxRetries, profileDefaults.maxRetries, 0, 50),
    maxContinues: normalizePositiveInteger(stage.maxContinues, profileDefaults.maxContinues, 0, 50),
    followUps,
    steering,
    extensionIds: normalizeExtensionIds(stage.extensionIds || stage.extensions),
    metadata: isPlainObject(stage.metadata) ? { ...stage.metadata } : {},
  };
}

function normalizeProfile(rawProfile, issues, options = {}) {
  if (!isPlainObject(rawProfile)) {
    issues.push(createIssue("PROFILE_OBJECT_REQUIRED", "Harness profile root must be an object.", "error"));
    return null;
  }

  const profileDefaults = {
    sessionType: String(rawProfile.sessionType || options.defaultSessionType || "task").trim() || "task",
    sdk: String(rawProfile.sdk || options.defaultSdk || "").trim() || null,
    model: String(rawProfile.model || options.defaultModel || "").trim() || null,
    cwd: String(rawProfile.cwd || options.defaultCwd || "").trim() || null,
    maxRetries: normalizePositiveInteger(rawProfile.maxRetries, 2, 0, 50),
    maxContinues: normalizePositiveInteger(rawProfile.maxContinues, 3, 0, 50),
  };

  const agentId = String(rawProfile.agentId || options.defaultAgentId || "").trim();
  if (!agentId) {
    issues.push(createIssue("AGENT_ID_REQUIRED", "Harness profile must define a non-empty agentId.", "error", "agentId"));
  }

  const taskKey = normalizeTaskKey(rawProfile.taskKey, agentId || "harness-task");
  const stageEntries = Array.isArray(rawProfile.stages)
    ? rawProfile.stages
    : String(rawProfile.prompt || rawProfile.initialPrompt || "").trim()
      ? [{ id: "stage-1", prompt: String(rawProfile.prompt || rawProfile.initialPrompt || "") }]
      : [];

  if (stageEntries.length === 0) {
    issues.push(
      createIssue(
        "STAGES_REQUIRED",
        "Harness profile must define at least one stage or a top-level prompt/initialPrompt.",
        "error",
        "stages",
      ),
    );
  }

  const stages = stageEntries
    .map((stage, index) => normalizeStage(stage, index, profileDefaults, issues))
    .filter(Boolean);

  const stageIds = new Set();
  for (const stage of stages) {
    if (stageIds.has(stage.id)) {
      issues.push(
        createIssue("STAGE_ID_DUPLICATE", `Duplicate stage id "${stage.id}" is not allowed.`, "error", `stages.${stage.id}`),
      );
      continue;
    }
    stageIds.add(stage.id);
  }

  return {
    profileVersion: normalizePositiveInteger(rawProfile.profileVersion, 1, 1, 10),
    agentId: agentId || null,
    taskKey,
    sessionType: profileDefaults.sessionType,
    maxTurns: normalizePositiveInteger(rawProfile.maxTurns, Math.max(1, stages.length * 3), 1, 250),
    sdk: profileDefaults.sdk,
    model: profileDefaults.model,
    cwd: profileDefaults.cwd,
    extensionIds: normalizeExtensionIds(rawProfile.extensionIds || rawProfile.extensions),
    metadata: isPlainObject(rawProfile.metadata) ? { ...rawProfile.metadata } : {},
    stages,
  };
}

export function compileInternalHarnessProfile(source, options = {}) {
  const issues = [];
  const sourceText = typeof source === "string" ? source : JSON.stringify(source ?? {}, null, 2);
  if (containsLikelySecretLiteral(sourceText)) {
    issues.push(
      createIssue(
        "SOURCE_CONTAINS_SECRET_LITERAL",
        "Harness source appears to contain a secret literal. Remove credentials from the source.",
        "error",
      ),
    );
  }
  for (const pattern of PROMPT_INJECTION_PATTERNS) {
    if (containsIgnoreCase(sourceText, pattern)) {
      issues.push(
        createIssue(
          "PROMPT_INJECTION_PATTERN",
          `Harness source contains known prompt-injection phrasing: "${pattern}".`,
          "error",
        ),
      );
      break;
    }
  }
  for (const pattern of UNSAFE_EXECUTION_PATTERNS) {
    if (containsIgnoreCase(sourceText, pattern)) {
      issues.push(
        createIssue(
          "UNSAFE_EXECUTION_PATTERN",
          `Harness source contains an unsafe execution pattern: "${pattern}".`,
          "error",
        ),
      );
      break;
    }
  }

  let rawProfile = null;
  if (isPlainObject(source)) {
    rawProfile = source;
  } else {
    const payload = extractProfilePayload(sourceText);
    if (!payload) {
      issues.push(
        createIssue(
          "PROFILE_PAYLOAD_NOT_FOUND",
          "Harness markdown must contain inline JSON or a fenced JSON block.",
          "error",
        ),
      );
    } else {
      try {
        rawProfile = JSON.parse(payload);
      } catch (error) {
        issues.push(
          createIssue(
            "PROFILE_JSON_INVALID",
            `Harness profile JSON is malformed: ${error?.message || error}`,
            "error",
          ),
        );
      }
    }
  }

  if (rawProfile) {
    scanSensitiveKeys(rawProfile, issues);
  }

  const compiledProfile = rawProfile ? normalizeProfile(rawProfile, issues, options) : null;
  const errorCount = issues.filter((issue) => issue.level === "error").length;
  const validationReport = {
    isValid: Boolean(compiledProfile) && errorCount === 0,
    errorCount,
    warningCount: issues.filter((issue) => issue.level === "warning").length,
    issues,
  };

  return {
    compiledProfile,
    compiledProfileJson: compiledProfile ? JSON.stringify(compiledProfile, null, 2) : null,
    validationReport,
    agentId: compiledProfile?.agentId || null,
    isValid: validationReport.isValid,
  };
}
