import { createHash } from "node:crypto";

const INLINE_CHAR_BUDGET = 1200;
const INLINE_LINE_BUDGET = 40;
const ARTIFACT_CHAR_BUDGET = 4000;
const ARTIFACT_LINE_BUDGET = 120;

const FAMILY_RULES = {
  search: { inlineChars: 900, inlineLines: 24, artifactChars: 3200, artifactLines: 80 },
  test: { inlineChars: 1400, inlineLines: 48, artifactChars: 5200, artifactLines: 180 },
  build: { inlineChars: 1200, inlineLines: 36, artifactChars: 4800, artifactLines: 160 },
  git: { inlineChars: 1000, inlineLines: 32, artifactChars: 3600, artifactLines: 120 },
  logs: { inlineChars: 900, inlineLines: 28, artifactChars: 4200, artifactLines: 140 },
  "package-manager": { inlineChars: 1000, inlineLines: 32, artifactChars: 4200, artifactLines: 130 },
  deploy: { inlineChars: 1100, inlineLines: 34, artifactChars: 4600, artifactLines: 150 },
  generic: { inlineChars: INLINE_CHAR_BUDGET, inlineLines: INLINE_LINE_BUDGET, artifactChars: ARTIFACT_CHAR_BUDGET, artifactLines: ARTIFACT_LINE_BUDGET },
};

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function clipText(text, maxChars, maxLines) {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  const lines = normalized.split("\n");
  const clippedLines = lines.slice(0, maxLines);
  let clipped = clippedLines.join("\n");
  if (clipped.length > maxChars) clipped = clipped.slice(0, maxChars).trimEnd() + "…";
  if (lines.length > maxLines || normalized.length > maxChars) clipped += "\n[…truncated]";
  return clipped;
}

function detectCommandFamily(command = "", args = []) {
  const raw = (String(command || "") + " " + (Array.isArray(args) ? args.join(" ") : "")).trim().toLowerCase();
  if (/\b(rg|ripgrep|grep|findstr|ag|ack|git\s+grep|select-string)\b/.test(raw)) return "search";
  if (/\b(dotnet\s+test|npm\s+test|pnpm\s+test|yarn\s+test|vitest|jest|pytest|go\s+test|cargo\s+test)\b/.test(raw)) return "test";
  if (/\b(dotnet\s+build|npm\s+run\s+build|pnpm\s+build|yarn\s+build|tsc\b|vite\s+build|cargo\s+build|make\b)\b/.test(raw)) return "build";
  if (/\bgit\b/.test(raw)) return "git";
  if (/\b(tail|journalctl|get-content|cat|type)\b/.test(raw) && /\b(log|trace|out|err)\b/.test(raw)) return "logs";
  if (/\b(npm|pnpm|yarn|bun)\b/.test(raw)) return "package-manager";
  if (/\b(kubectl|helm|docker\s+compose|docker|az\s+deployment|terraform|serverless|vercel|netlify)\b/.test(raw)) return "deploy";
  return "generic";
}

function extractEvidence(family, stdout, stderr) {
  const text = [normalizeText(stdout), normalizeText(stderr)].filter(Boolean).join("\n");
  const lines = text ? text.split("\n") : [];
  const lower = lines.map((line) => line.toLowerCase());
  const picks = [];
  const push = (kind, line, index) => {
    if (!line) return;
    if (picks.some((entry) => entry.line === line && entry.kind === kind)) return;
    picks.push({ kind, line, lineNumber: index + 1 });
  };
  lines.forEach((line, index) => {
    const l = lower[index];
    if (family === "test") {
      if (/\b(fail|failed|error|passed|skipped|total|assert)\b/.test(l)) push(/\b(fail|error)\b/.test(l) ? "failure" : "summary", line, index);
    } else if (family === "build") {
      if (/\b(error|warning|built|compiled|success|failed)\b/.test(l)) push(/\berror\b/.test(l) ? "failure" : /\bwarning\b/.test(l) ? "warning" : "summary", line, index);
    } else if (family === "git") {
      if (/^(diff --git|@@|\+\+\+|---|\s*[AMDRCU?]{1,2}\s)/.test(line) || /\b(ahead|behind|changed|files? changed|insertions?|deletions?)\b/.test(l)) push("delta", line, index);
    } else if (family === "search") {
      if (/:\d+[:]?/.test(line) || /\bmatch|matches|found\b/.test(l)) push("match", line, index);
    } else if (family === "logs" || family === "deploy") {
      if (/\b(error|warn|warning|fatal|exception|ready|started|deployed|rollback)\b/.test(l)) push(/\berror|fatal|exception\b/.test(l) ? "failure" : /\bwarn/.test(l) ? "warning" : "summary", line, index);
    } else if (family === "package-manager") {
      if (/\b(added|removed|audited|funding|vulnerab|deprecated|installed|resolved|error)\b/.test(l)) push(/\berror|vulnerab\b/.test(l) ? "failure" : /\bdeprecated\b/.test(l) ? "warning" : "summary", line, index);
    }
  });
  return picks.slice(0, 12);
}

function summarizeFamily(family, commandLine, exitCode, evidence) {
  const lead = evidence.slice(0, 4).map((entry) => entry.line.trim()).filter(Boolean);
  const prefix = family + " command " + (exitCode === 0 ? "succeeded" : `failed (exit ${exitCode})`);
  if (lead.length === 0) return prefix + ": " + commandLine;
  return prefix + ": " + lead.join(" | ");
}

export function buildCommandContextEnvelope({ command = "", args = [], stdout = "", stderr = "", exitCode = 0 }) {
  const family = detectCommandFamily(command, args);
  const policy = FAMILY_RULES[family] || FAMILY_RULES.generic;
  const commandLine = (String(command || "").trim() + " " + (Array.isArray(args) ? args.join(" ") : "")).trim();
  const stdoutText = normalizeText(stdout);
  const stderrText = normalizeText(stderr);
  const combined = [stdoutText, stderrText].filter(Boolean).join("\n");
  const evidence = extractEvidence(family, stdoutText, stderrText);
  const inlineExcerpt = clipText(evidence.length ? evidence.map((entry) => entry.line).join("\n") : combined, policy.inlineChars, policy.inlineLines);
  const artifactExcerpt = clipText(combined, policy.artifactChars, policy.artifactLines);
  const totalChars = combined.length;
  const totalLines = combined ? combined.split("\n").length : 0;
  const retrieval = totalChars > policy.artifactChars || totalLines > policy.artifactLines ? "artifact" : evidence.some((entry) => entry.kind === "delta") ? "structured-delta" : "inline";
  const lowSignal = evidence.length === 0 && totalChars > Math.floor(policy.inlineChars / 2);
  const artifact = retrieval === "artifact"
    ? {
        id: createHash("sha1").update(commandLine + "\n" + combined).digest("hex").slice(0, 12),
        kind: "command-output",
        excerpt: artifactExcerpt,
      }
    : null;
  return {
    command: commandLine,
    family,
    budgetPolicy: {
      name: retrieval === "artifact" ? "artifact-retain" : retrieval === "structured-delta" ? "structured-delta" : "inline-excerpt",
      inlineChars: policy.inlineChars,
      inlineLines: policy.inlineLines,
      artifactChars: policy.artifactChars,
      artifactLines: policy.artifactLines,
    },
    decision: {
      retrieval,
      lowSignal,
      reasons: [
        `family=${family}`,
        `chars=${totalChars}`,
        `lines=${totalLines}`,
        evidence.length ? `evidence=${evidence.length}` : "evidence=0",
      ],
    },
    evidence,
    promptContext: {
      summary: summarizeFamily(family, commandLine, exitCode, evidence),
      inlineExcerpt,
      structuredDelta: family === "git" ? evidence.map((entry) => entry.line) : [],
    },
    artifacts: artifact ? [artifact] : [],
    raw: {
      exitCode,
      stdoutChars: stdoutText.length,
      stderrChars: stderrText.length,
    },
  };
}
