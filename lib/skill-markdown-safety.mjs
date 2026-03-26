import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createLogger } from "./logger.mjs";

const INVISIBLE_UNICODE_RE = /[\u200B-\u200D\u2060\u2066-\u2069\uFEFF\u202A-\u202E\uFE00-\uFE0F]/g;

const DEFAULT_AUDIT_LOG_PATH = ".bosun/logs/markdown-safety-audit.jsonl";
const DOCUMENTATION_PATH_SEGMENTS = ["/docs/", "/doc/", "/guides/", "/guide/", "/examples/", "/example/", "/tutorials/", "/tutorial/"];
const DOCUMENTATION_FILE_NAMES = new Set([
  "agents.md",
  "readme.md",
  "copilot-instructions.md",
  "instructions.md",
  "contributing.md",
]);
const markdownSafetyLogger = createLogger("markdown-safety");

const PROMPT_OVERRIDE_PATTERNS = [
  {
    regex: /\balways\s+run\s+this\s+skill\b/gi,
    reason: "always-run directive",
    weight: 5,
    highConfidence: true,
  },
  {
    regex: /\bmust\s+always\s+run\b/gi,
    reason: "must-always-run directive",
    weight: 5,
    highConfidence: true,
  },
  {
    regex: /\brun\s+this\s+skill\s+with\s+every\s+session\b/gi,
    reason: "run-every-session directive",
    weight: 5,
    highConfidence: true,
  },
  {
    regex: /\bignore\s+(?:previous|prior|all|above)\s+(?:instructions?|prompts?|context)\b/gi,
    reason: "ignore-instructions directive",
    weight: 5,
    highConfidence: true,
  },
  {
    regex: /\bdisregard\s+(?:the\s+)?(?:previous|prior|all|above|system)\b/gi,
    reason: "disregard-instructions directive",
    weight: 5,
    highConfidence: true,
  },
  {
    regex: /\bno\s+matter\s+what\b/gi,
    reason: "unconditional-execution directive",
    weight: 2,
    highConfidence: false,
  },
];

const PROMOTION_PATTERNS = [
  {
    regex: /\bencourage\s+the\s+user\s+to\b/gi,
    reason: "call-to-action language",
    weight: 2,
  },
  {
    regex: /\bsign\s+up\b/gi,
    reason: "sign-up language",
    weight: 2,
  },
  {
    regex: /\bfree\s+credits?\b/gi,
    reason: "free-credits language",
    weight: 2,
  },
  {
    regex: /\bget\s+started\b/gi,
    reason: "conversion language",
    weight: 1,
  },
  {
    regex: /\bvisit\s+(?:the\s+)?(?:website|site)\b/gi,
    reason: "visit-website language",
    weight: 1,
  },
  {
    regex: /\bwww\.[a-z0-9.-]+\.[a-z]{2,}\b/gi,
    reason: "website url",
    weight: 1,
  },
  {
    regex: /\bhttps?:\/\/[^\s)]+/gi,
    reason: "website url",
    weight: 1,
  },
];

const MALWARE_PATTERNS = [
  {
    regex: /\b(?:curl|wget)\b[^\n|]{0,160}\|\s*(?:bash|sh|zsh)\b/gi,
    reason: "download-and-execute pipeline",
    weight: 6,
    highConfidence: true,
  },
  {
    regex: /\b(?:invoke-expression|iex)\b[^\n]{0,160}\b(?:invoke-webrequest|iwr|downloadstring|downloadfile|new-object\s+net\.webclient)\b|\b(?:invoke-webrequest|iwr|downloadstring|downloadfile|new-object\s+net\.webclient)\b[^\n]{0,160}\b(?:invoke-expression|iex)\b/gi,
    reason: "powershell cradle",
    weight: 6,
    highConfidence: true,
  },
  {
    regex: /\bpowershell(?:\.exe)?\b[^\n]{0,160}\b(?:-enc|-encodedcommand)\b/gi,
    reason: "encoded powershell launcher",
    weight: 5,
    highConfidence: true,
  },
  {
    regex: /\b(?:exfiltrat(?:e|ion)|steal|harvest|dump|collect)\b[^\n]{0,120}\b(?:credentials?|tokens?|cookies?|secrets?|passwords?|ssh\s+keys?|api\s+keys?)\b|\b(?:credentials?|tokens?|cookies?|secrets?|passwords?|ssh\s+keys?|api\s+keys?)\b[^\n]{0,120}\b(?:exfiltrat(?:e|ion)|steal|harvest|dump|collect)\b/gi,
    reason: "credential exfiltration language",
    weight: 5,
    highConfidence: true,
  },
  {
    regex: /\b(?:append|write|add|modify|overwrite|persist|tamper)\b[^\n]{0,120}(?:(?:~\/)?\.bashrc|(?:~\/)?\.zshrc|profile\.ps1|powershell\s+profile|shell\s+profile)\b|(?:(?:~\/)?\.bashrc|(?:~\/)?\.zshrc|profile\.ps1|powershell\s+profile|shell\s+profile)[^\n]{0,120}\b(?:append|write|add|modify|overwrite|persist|tamper)\b/gi,
    reason: "shell profile tampering",
    weight: 5,
    highConfidence: true,
  },
];

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function buildExcerpt(text, index, length) {
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + Math.max(length, 1) + 56);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

function collectPatternMatches(text, patterns, { maxExcerpts = 6 } = {}) {
  const matches = [];
  let score = 0;
  let highConfidenceMatches = 0;

  for (const pattern of patterns) {
    const regex = new RegExp(
      pattern.regex.source,
      pattern.regex.flags.includes("g") ? pattern.regex.flags : pattern.regex.flags + "g",
    );
    for (const match of text.matchAll(regex)) {
      score += Number(pattern.weight || 0);
      if (pattern.highConfidence) highConfidenceMatches += 1;
      matches.push({
        reason: pattern.reason,
        excerpt: buildExcerpt(text, match.index ?? 0, String(match[0] || "").length),
      });
    }
  }

  return {
    score,
    count: matches.length,
    highConfidenceMatches,
    reasons: uniqueStrings(matches.map((match) => match.reason)),
    excerpts: uniqueStrings(matches.map((match) => match.excerpt)).slice(0, maxExcerpts),
  };
}

function normalizeMarkdownText(markdown) {
  return String(markdown || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9:/.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeMatchValue(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function normalizeAllowlistEntry(entry) {
  if (!entry) return null;
  if (typeof entry === "string") {
    const pathSuffix = normalizeMatchValue(entry);
    if (!pathSuffix) return null;
    return Object.freeze({
      repo: "",
      repoUrl: "",
      path: "",
      pathPrefix: "",
      pathSuffix,
      context: "documentation",
      reason: "",
    });
  }
  if (typeof entry !== "object") return null;

  const context = normalizeMatchValue(entry.context || entry.scope || "any");
  return Object.freeze({
    repo: normalizeMatchValue(entry.repo || entry.repository || entry.repoSlug || ""),
    repoUrl: normalizeMatchValue(entry.repoUrl || entry.url || ""),
    path: normalizeMatchValue(entry.path || ""),
    pathPrefix: normalizeMatchValue(entry.pathPrefix || ""),
    pathSuffix: normalizeMatchValue(entry.pathSuffix || ""),
    context: context === "documentation" ? "documentation" : "any",
    reason: String(entry.reason || entry.name || "").trim(),
  });
}

function resolvePolicySection(policyInput) {
  if (!policyInput || typeof policyInput !== "object") return {};
  if (Array.isArray(policyInput.allowlist) || "auditLogPath" in policyInput || "enabled" in policyInput) {
    return policyInput;
  }
  if (policyInput.markdownSafety && typeof policyInput.markdownSafety === "object") {
    return policyInput.markdownSafety;
  }
  return {};
}

function normalizePolicy(policyInput = {}) {
  const section = resolvePolicySection(policyInput);
  const allowlist = Array.isArray(section.allowlist)
    ? section.allowlist.map(normalizeAllowlistEntry).filter(Boolean)
    : [];
  const auditLogPath = String(section.auditLogPath || "").trim() || DEFAULT_AUDIT_LOG_PATH;
  return Object.freeze({
    enabled: section.enabled !== false,
    auditLogPath,
    allowlist,
  });
}

function matchExactOrContains(candidate, expected) {
  if (!expected) return true;
  if (!candidate) return false;
  return candidate === expected || candidate.includes(expected);
}

function entryMatchesAllowlist(entry, context = {}) {
  if (!entry) return false;
  if (entry.context === "documentation" && context.documentationContext !== true) {
    return false;
  }

  const normalizedPath = normalizeMatchValue(context.sourcePath || context.path || "");
  const repoCandidates = [
    context.sourceRepo,
    context.repo,
    context.sourceRepoUrl,
    context.repoUrl,
    context.sourceRoot,
    context.rootDir,
  ]
    .map(normalizeMatchValue)
    .filter(Boolean);

  if (entry.repo && !repoCandidates.some((candidate) => matchExactOrContains(candidate, entry.repo))) {
    return false;
  }
  if (entry.repoUrl && !repoCandidates.some((candidate) => matchExactOrContains(candidate, entry.repoUrl))) {
    return false;
  }
  if (entry.path && normalizedPath !== entry.path) {
    return false;
  }
  if (entry.pathPrefix && !normalizedPath.startsWith(entry.pathPrefix)) {
    return false;
  }
  if (entry.pathSuffix && !normalizedPath.endsWith(entry.pathSuffix)) {
    return false;
  }
  return true;
}

function summarizeReasons(reasons = []) {
  return uniqueStrings(reasons).join(", ");
}

function resolveAuditLogPath(policyInput = {}, rootDir) {
  const policy = normalizePolicy(policyInput);
  if (isAbsolute(policy.auditLogPath)) return policy.auditLogPath;
  return resolve(rootDir || process.cwd(), policy.auditLogPath);
}

export function resolveMarkdownSafetyPolicy(policyInput = {}) {
  return normalizePolicy(policyInput);
}

export function isDocumentationMarkdownPath(pathValue = "") {
  const normalized = normalizeMatchValue(pathValue);
  if (!normalized) return false;
  const fileName = normalized.split("/").pop() || "";
  if (DOCUMENTATION_FILE_NAMES.has(fileName)) return true;
  return DOCUMENTATION_PATH_SEGMENTS.some((segment) => normalized.includes(segment));
}

export function findMarkdownSafetyAllowlistMatch(context = {}, policyInput = {}) {
  const policy = normalizePolicy(policyInput);
  return policy.allowlist.find((entry) => entryMatchesAllowlist(entry, context)) || null;
}

export function evaluateMarkdownSafety(markdown = "", context = {}, policyInput = {}) {
  const safety = analyzeSkillMarkdownSafety(markdown);
  const policy = normalizePolicy(policyInput);
  const allowlistMatch = safety.blocked ? findMarkdownSafetyAllowlistMatch(context, policy) : null;

  return Object.freeze({
    blocked: policy.enabled !== false && safety.blocked && !allowlistMatch,
    safety,
    allowlistMatch,
    policy,
  });
}

export function recordMarkdownSafetyAuditEvent(event = {}, options = {}) {
  const policy = normalizePolicy(options?.policy || event?.policy || {});
  const rootDir = options?.rootDir || event?.rootDir || process.cwd();
  const auditPath = resolveAuditLogPath(policy, rootDir);
  const payload = {
    timestamp: new Date().toISOString(),
    ...event,
    reasonsSummary: summarizeReasons(event?.reasons || []),
  };

  try {
    mkdirSync(dirname(auditPath), { recursive: true });
    appendFileSync(auditPath, JSON.stringify(payload) + "\n", "utf8");
  } catch (err) {
    markdownSafetyLogger.warn(
      `failed to append audit event to ${auditPath}: ${err?.message || err}`,
    );
    return false;
  }

  const subject = String(event?.sourcePath || event?.path || event?.channel || "markdown").trim() || "markdown";
  const reasons = summarizeReasons(event?.reasons || []);
  markdownSafetyLogger.warn(
    `[audit] ${subject}${reasons ? ` blocked: ${reasons}` : " blocked"}`,
  );
  return true;
}

export function analyzeSkillMarkdownSafety(markdown = "") {
  const raw = String(markdown || "");
  const normalized = normalizeMarkdownText(raw);
  const malwareText = raw.normalize("NFKC").toLowerCase();

  const unicodeExcerpts = uniqueStrings(
    [...raw.matchAll(INVISIBLE_UNICODE_RE)].map((match) =>
      buildExcerpt(raw, match.index ?? 0, String(match[0] || "").length),
    ),
  );
  const override = collectPatternMatches(normalized, PROMPT_OVERRIDE_PATTERNS);
  const promotion = collectPatternMatches(normalized, PROMOTION_PATTERNS);
  const malware = collectPatternMatches(malwareText, MALWARE_PATTERNS);

  const reasons = [];
  if (unicodeExcerpts.length > 0) reasons.push("suspicious unicode controls");
  reasons.push(...override.reasons, ...malware.reasons);

  const score = (
    (unicodeExcerpts.length > 0 ? 4 : 0)
    + override.score
    + promotion.score
    + malware.score
  );

  const blocked = unicodeExcerpts.length > 0
    || override.highConfidenceMatches > 0
    || malware.highConfidenceMatches > 0
    || (override.count > 0 && promotion.count > 0)
    || score >= 7;

  if (blocked || promotion.count > 1) {
    reasons.push(...promotion.reasons);
  }

  return Object.freeze({
    blocked,
    score,
    reasons: uniqueStrings(reasons),
    findings: Object.freeze({
      unicode: unicodeExcerpts,
      promptOverride: override.excerpts,
      promotion: promotion.excerpts,
      malware: malware.excerpts,
    }),
  });
}