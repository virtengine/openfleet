/**
 * issue-trust-guard.mjs — Security gate for externally-created GitHub Issues
 *
 * WHAT THIS SOLVES:
 *   Any public user can open a GitHub issue on a repo that Bosun is connected
 *   to.  Without a trust gate, a malicious actor could craft an issue whose
 *   title or body contains adversarial prompts that get injected directly into
 *   an agent's context — a classic "prompt injection via issue" attack.
 *
 * HOW IT WORKS:
 *   1. issueIngestionEnabled must be explicitly `true` in config.security.
 *      Default is OFF — Bosun never auto-ingests external issues unless opted in.
 *   2. If ingestion is on, the issue creator's login is checked against the
 *      trusted-user list. That list always includes the repo owner (derived
 *      from GITHUB_REPO or the first configured repository slug).
 *   3. Even for trusted users, the title and body are scanned for prompt-
 *      injection patterns before the content reaches any agent.
 *   4. All untrusted or suspicious submissions are quarantined in "backlog"
 *      (never auto-promoted to "todo") and a Telegram alert is sent.
 *
 * EXPORTS:
 *   buildTrustConfig(config)           → TrustConfig
 *   checkIssueTrust(issue, trustCfg)   → TrustResult
 *   sanitiseIssueContent(text)         → string
 *   isPromptInjection(text, patterns)  → { detected: boolean, matches: string[] }
 *
 * TrustResult shape:
 *   {
 *     trusted:       boolean,  // safe to ingest?
 *     reason:        string,   // machine-readable reason
 *     detail:        string,   // human-readable explanation
 *     action:        "ingest_backlog"|"ingest_todo"|"quarantine"|"reject",
 *     injectionRisk: boolean,  // prompt injection patterns found?
 *     injectionMatches: string[],
 *     creator:       string,   // github login of issue creator
 *   }
 *
 * @module issue-trust-guard
 */

const TAG = "[issue-trust-guard]";

// ── Default injection patterns ────────────────────────────────────────────────
// Covers the most common LLM prompt-injection patterns seen in the wild.
// Users may append extra patterns via config.security.promptInjectionPatterns.

const DEFAULT_INJECTION_PATTERNS = [
  // Classic instruction-override attempts
  /ignore\s+(previous|prior|all|above)\s+(instructions?|prompts?|context)/i,
  /disregard\s+(the\s+)?(previous|prior|all|above|system)/i,
  /forget\s+(everything|all|prior|previous)\s+(you|instructions?)/i,

  // Direct role/system manipulation
  /you\s+are\s+now\s+(?:a\s+)?(?:different\s+)?(?:an?\s+)?(?:uncensored|evil|d\.a\.n|jailbreak|unrestricted)/i,
  /\[system\]/i,
  /\[\/?(inst|SYS|INST|SYSTEM|USER|ASSISTANT)\]/i,
  /<\/?(?:system|instructions?|prompt|context|input)\b/i,

  // Exfiltration / SSRF attempts via task work
  /curl\s+https?:\/\/(?!github\.com|api\.github\.com)/i,
  /wget\s+https?:\/\/(?!github\.com|api\.github\.com)/i,
  /fetch\(['"]https?:\/\/(?!github\.com|api\.github\.com)/i,
  /\bexfiltrat/i,

  // Attempts to read secrets
  /cat\s+(?:\.env|secrets?\.|credentials?|id_rsa|\.ssh\/)/i,
  /\$(?:GITHUB_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|BOSUN_)/,
  /process\.env\./,

  // Markdown/HTML comment injection (hide instructions)
  /<!--[\s\S]{0,500}(?:instruction|ignore|system|forget|disregard)/i,

  // Token-smuggling via Unicode lookalikes / zero-width chars
  /[\u200B-\u200D\uFEFF]/,
  /[\u202A-\u202E]/,
];

// ── TrustConfig builder ───────────────────────────────────────────────────────

/**
 * Build a normalised trust configuration from the bosun config object.
 *
 * @param {object} cfg — Full bosun config (from loadConfig())
 * @returns {TrustConfig}
 *
 * TrustConfig shape:
 * {
 *   ingestionEnabled:           boolean,
 *   requireTrustedCreator:      boolean,
 *   trustedUsers:               Set<string>,   // lower-cased logins
 *   repoOwner:                  string,        // derived from GITHUB_REPO or repositories[0]
 *   newExternalTaskStatus:      "backlog"|"todo",
 *   injectionPatternsEnabled:   boolean,
 *   injectionPatterns:          RegExp[],
 *   quarantineLabel:            string,
 *   postComment:                boolean,
 * }
 */
export function buildTrustConfig(cfg) {
  const sec = cfg?.security || {};

  // Derive repo owner from GITHUB_REPO env, then from config repositories
  const repoSlug =
    process.env.GITHUB_REPO ||
    (Array.isArray(cfg?.repositories) && cfg.repositories[0]?.slug) ||
    "";
  const repoOwner = repoSlug.split("/")[0] || "";

  // Build trusted user set — always includes repo owner
  const explicitTrusted = Array.isArray(sec.trustedGithubUsers)
    ? sec.trustedGithubUsers
    : typeof sec.trustedGithubUsers === "string"
      ? sec.trustedGithubUsers.split(/[,\s]+/)
      : [];
  const trustedUsers = new Set(
    [...explicitTrusted, repoOwner]
      .map((u) => String(u || "").trim().toLowerCase())
      .filter(Boolean),
  );

  // Extra injection patterns from config
  const extraPatterns = Array.isArray(sec.promptInjectionPatterns)
    ? sec.promptInjectionPatterns
        .map((p) => {
          try {
            return typeof p === "string" ? new RegExp(p, "i") : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];

  const injectionPatterns = [...DEFAULT_INJECTION_PATTERNS, ...extraPatterns];

  return Object.freeze({
    ingestionEnabled:
      sec.issueIngestionEnabled === true ||
      process.env.BOSUN_ISSUE_INGESTION === "true",

    requireTrustedCreator: sec.requireTrustedIssueCreator !== false, // default true

    trustedUsers,
    repoOwner,

    // Where externally-ingested tasks land by default
    newExternalTaskStatus:
      sec.newExternalTaskStatus === "todo" ? "todo" : "backlog",

    // Whether to run injection scanning
    injectionPatternsEnabled: sec.injectionScanEnabled !== false, // default true

    injectionPatterns,

    // Label applied to quarantined issues
    quarantineLabel:
      sec.quarantineLabel || "bosun:quarantine",

    // Post a GitHub comment explaining the rejection/quarantine
    postComment: sec.postRejectionComment !== false, // default true
  });
}

// ── Prompt injection scanner ──────────────────────────────────────────────────

/**
 * Scan text content (issue title + body) for prompt injection patterns.
 *
 * @param {string} text
 * @param {RegExp[]} patterns
 * @returns {{ detected: boolean, matches: string[] }}
 */
export function isPromptInjection(text, patterns = DEFAULT_INJECTION_PATTERNS) {
  const str = String(text || "");
  const matches = [];
  for (const re of patterns) {
    const m = str.match(re);
    if (m) {
      // Record a short excerpt (max 80 chars) around the match to aid auditing
      const idx = m.index ?? 0;
      const excerpt = str.slice(Math.max(0, idx - 20), idx + 60).trim();
      matches.push(excerpt);
    }
  }
  return { detected: matches.length > 0, matches };
}

// ── Content sanitiser ─────────────────────────────────────────────────────────

/**
 * Sanitise issue content before it enters the task description that agents read.
 * Removes zero-width characters, trims whitespace, and redacts obvious secret
 * patterns (e.g. bare API keys).  Does NOT alter structural meaning.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitiseIssueContent(text) {
  let out = String(text || "");

  // Strip zero-width / directional override characters
  out = out.replace(/[\u200B-\u200D\uFEFF\u202A-\u202E]/g, "");

  // Redact patterns that look like raw secrets leaking into task descriptions
  const SECRET_RE = [
    /\bghp_[A-Za-z0-9]{36,}\b/g,            // GitHub PAT
    /\bsk-[A-Za-z0-9]{32,}\b/g,             // OpenAI-style key
    /\bANTHROPIC_API_KEY\s*=\s*\S+/g,       // Anthropic env assignment
    /\bOPENAI_API_KEY\s*=\s*\S+/g,
    /\bGITHUB_TOKEN\s*=\s*\S+/g,
  ];
  for (const re of SECRET_RE) {
    out = out.replace(re, "[REDACTED]");
  }

  return out.trim();
}

// ── Main trust check ──────────────────────────────────────────────────────────

/**
 * Evaluate whether a GitHub issue can be safely ingested as a Bosun task.
 *
 * @param {object} issue       — GitHub Issues API payload (or partial)
 * @param {object} trustConfig — From buildTrustConfig()
 * @returns {TrustResult}
 */
export function checkIssueTrust(issue, trustConfig) {
  const cfg = trustConfig;
  const creator = String(
    issue?.user?.login || issue?.author?.login || issue?.creatorLogin || "",
  ).trim().toLowerCase();

  // ── 1. Ingestion gate ────────────────────────────────────────────────────
  if (!cfg.ingestionEnabled) {
    return _result({
      trusted: false,
      reason: "ingestion_disabled",
      detail:
        "Issue ingestion is disabled (security.issueIngestionEnabled is not set). " +
        "Enable it in bosun.config.json to allow external issues to become tasks.",
      action: "reject",
      creator,
    });
  }

  // ── 2. Missing creator ───────────────────────────────────────────────────
  if (!creator) {
    return _result({
      trusted: false,
      reason: "unknown_creator",
      detail:
        "Cannot determine issue creator login — rejecting to prevent anonymous injection.",
      action: "reject",
      creator: "(unknown)",
    });
  }

  // ── 3. Trusted-creator check ─────────────────────────────────────────────
  const isTrusted = cfg.trustedUsers.has(creator);
  if (cfg.requireTrustedCreator && !isTrusted) {
    const trustedList = [...cfg.trustedUsers].join(", ") || "(none configured)";
    return _result({
      trusted: false,
      reason: "untrusted_creator",
      detail:
        `Issue creator "@${creator}" is not in the trusted user list. ` +
        `Trusted: [${trustedList}]. ` +
        `Add the creator to security.trustedGithubUsers in bosun.config.json to allow their issues.`,
      action: "quarantine",
      creator,
    });
  }

  // ── 4. Prompt injection scan ─────────────────────────────────────────────
  if (cfg.injectionPatternsEnabled) {
    const combinedText = `${issue?.title || ""}\n${issue?.body || ""}`;
    const { detected, matches } = isPromptInjection(
      combinedText,
      cfg.injectionPatterns,
    );
    if (detected) {
      return _result({
        trusted: false,
        reason: "injection_detected",
        detail:
          `Prompt injection patterns detected in issue content from "@${creator}". ` +
          `The issue has been quarantined. Matched patterns near: ` +
          matches.slice(0, 3).map((m) => `"${m}"`).join("; "),
        action: "quarantine",
        creator,
        injectionRisk: true,
        injectionMatches: matches,
      });
    }
  }

  // ── 5. Trusted — determine target status ─────────────────────────────────
  // Even trusted issues land in backlog unless the operator has explicitly
  // set newExternalTaskStatus to "todo" (opt-in only).
  const action =
    cfg.newExternalTaskStatus === "todo" ? "ingest_todo" : "ingest_backlog";

  return _result({
    trusted: true,
    reason: "trusted_creator",
    detail: isTrusted
      ? `Issue creator "@${creator}" is in the trusted user list.`
      : `Issue creator "@${creator}" passed trust checks (requireTrustedCreator is disabled).`,
    action,
    creator,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _result({
  trusted,
  reason,
  detail,
  action,
  creator,
  injectionRisk = false,
  injectionMatches = [],
}) {
  return Object.freeze({
    trusted,
    reason,
    detail,
    action,      // "ingest_backlog"|"ingest_todo"|"quarantine"|"reject"
    creator,
    injectionRisk,
    injectionMatches,
  });
}

// ── Public helper: derive initial task status from a TrustResult ──────────────

/**
 * Return the task status that a newly-ingested issue should start with.
 *
 * @param {TrustResult} trustResult
 * @returns {"backlog"|"todo"|"quarantine"}
 */
export function resolveInitialTaskStatus(trustResult) {
  switch (trustResult.action) {
    case "ingest_todo":    return "todo";
    case "ingest_backlog": return "backlog";
    default:               return "backlog"; // quarantine/reject also land in backlog (with label)
  }
}

// ── Comment templates ─────────────────────────────────────────────────────────

/**
 * Build a GitHub comment body explaining why an issue was quarantined/rejected.
 *
 * @param {TrustResult} trustResult
 * @param {string} repoOwner
 * @returns {string}
 */
export function buildRejectionComment(trustResult, repoOwner = "") {
  const ownerNote = repoOwner
    ? ` Only the repository owner (@${repoOwner}) and explicitly trusted accounts can have issues automatically ingested.`
    : "";

  switch (trustResult.reason) {
    case "ingestion_disabled":
      return (
        "👋 Thanks for opening this issue! " +
        "Automatic issue-to-task ingestion is not enabled for this repository right now. " +
        "A maintainer will review your issue manually."
      );

    case "untrusted_creator":
      return (
        "👋 Thanks for opening this issue! " +
        "Bosun's automated agent will not pick this up automatically because your account " +
        "is not on the trusted contributors list." +
        ownerNote +
        " A maintainer will review and triage this issue."
      );

    case "injection_detected":
      return (
        "⚠️ This issue could not be automatically ingested because its content " +
        "matched one or more patterns associated with prompt injection attacks. " +
        "This is a security measure to protect the automated agent pipeline. " +
        "If you believe this is a false positive, please contact a maintainer."
      );

    case "unknown_creator":
      return (
        "⚠️ This issue was submitted without an identifiable creator and has been " +
        "quarantined as a precaution."
      );

    default:
      return (
        "This issue was quarantined by Bosun's security gate. " +
        `Reason: ${trustResult.detail}`
      );
  }
}
