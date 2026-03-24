#!/usr/bin/env node
/**
 * bosun-skills — Agent Skills Knowledge-Base
 *
 * Skills are reusable Markdown knowledge files stored in the workspace at
 *   BOSUN_HOME/.bosun/skills/   (global, shared across all projects)
 *   <workspace>/.bosun/skills/  (per-workspace override, higher priority)
 *
 * Agents load relevant skills at the start of each task to improve reliability,
 * follow established patterns, and build on knowledge discovered by previous agents.
 *
 * Agents are also encouraged to *write* new skills when they discover non-obvious
 * patterns, workarounds, or domain-specific facts during task execution.
 *
 * Skills index: .bosun/skills/index.json — lightweight JSON manifest agents can
 * scan quickly to decide which skill files to read.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function readBuiltinSkillFile(filename) {
  return readFileSync(resolve(__dirname, "skills", filename), "utf8");
}

// ── Analytics stream path (same file task-executor writes to) ────────────────
const _SKILL_STREAM_PATH = resolve(
  __dirname,
  "..", ".cache",
  "agent-work-logs",
  "agent-work-stream.jsonl",
);

/**
 * Best-effort: emit a skill_invoke event to the agent work stream so usage
 * analytics can track which skills are loaded per task.
 *
 * @param {string} skillName
 * @param {string} [skillTitle]
 * @param {{ taskId?: string, executor?: string, source?: string }} [opts]
 */
export function emitSkillInvokeEvent(skillName, skillTitle, opts = {}) {
  try {
    const event = {
      timestamp: new Date().toISOString(),
      event_type: "skill_invoke",
      data: { skill_name: skillName, skill_title: skillTitle || skillName },
      ...(opts.taskId ? { task_id: String(opts.taskId) } : {}),
      ...(opts.executor ? { executor: String(opts.executor) } : {}),
      ...(opts.source ? { source: String(opts.source) } : {}),
    };
    mkdirSync(dirname(_SKILL_STREAM_PATH), { recursive: true });
    appendFileSync(_SKILL_STREAM_PATH, JSON.stringify(event) + "\n", "utf8");
  } catch {
    /* best effort — never let analytics crash skill loading */
  }
}

// ── Built-in skill definitions ────────────────────────────────────────────────

/**
 * Each entry:
 *   filename  – the .md file written into skills/
 *   title     – short human-readable name
 *   tags      – array of lowercase tags agents use to match skills to tasks
 *   important – eagerly inline this skill into agent context when matched
 *   scope     – "global" | "bosun" (bosun-specific internals)
 *   content   – the full Markdown skill text
 */
export const BUILTIN_SKILLS = [
  {
    filename: "background-task-execution.md",
    title: "Background Task Execution",
    tags: ["background", "task", "reliability", "heartbeat", "stall", "completion"],
    important: true,
    scope: "global",
    content: readBuiltinSkillFile("background-task-execution.md"),
  },
  {
    filename: "pr-workflow.md",
    title: "Pull Request Workflow",
    tags: ["pr", "pull-request", "github", "review", "ci", "merge"],
    important: true,
    scope: "global",
    content: readBuiltinSkillFile("pr-workflow.md"),
  },
  {
    filename: "error-recovery.md",
    title: "Error Recovery Patterns",
    tags: ["error", "recovery", "retry", "debug", "failure"],
    important: true,
    scope: "global",
    content: readBuiltinSkillFile("error-recovery.md"),
  },
  {
    filename: "tdd-pattern.md",
    title: "Test-Driven Development",
    tags: ["tdd", "test", "testing", "unit-test", "red-green-refactor"],
    important: true,
    scope: "global",
    content: readBuiltinSkillFile("tdd-pattern.md"),
  },
  {
    filename: "commit-conventions.md",
    title: "Conventional Commits",
    tags: ["git", "commit", "commits", "conventional", "history"],
    important: true,
    scope: "global",
    content: readBuiltinSkillFile("commit-conventions.md"),
  },
  {
    filename: "agent-coordination.md",
    title: "Multi-Agent Coordination",
    tags: ["agent", "coordination", "parallel", "handoff", "merge-conflict"],
    important: true,
    scope: "bosun",
    content: readBuiltinSkillFile("agent-coordination.md"),
  },
  {
    filename: "bosun-agent-api.md",
    title: "Bosun Agent Status API",
    tags: ["bosun", "status", "heartbeat", "api", "complete", "error"],
    important: true,
    scope: "bosun",
    content: readBuiltinSkillFile("bosun-agent-api.md"),
  },
  {
    filename: "code-quality-anti-patterns.md",
    title: "Code Quality Anti-Patterns",
    tags: ["quality", "async", "testing", "cache", "anti-pattern"],
    important: true,
    scope: "global",
    content: readBuiltinSkillFile("code-quality-anti-patterns.md"),
  },
  {
    filename: "skill-codebase-audit.md",
    title: "Codebase Annotation Audit",
    tags: ["audit", "annotation", "documentation", "summary", "claude"],
    important: true,
    scope: "global",
    content: readBuiltinSkillFile("skill-codebase-audit.md"),
  },
  {
    filename: "custom-tool-creation.md",
    title: "Custom Tool Creation & Reuse",
    tags: ["tool", "tools", "reuse", "automation", "codemod"],
    important: true,
    scope: "bosun",
    content: readBuiltinSkillFile("custom-tool-creation.md"),
  },
];

export function getSkillsDir(bosunHome) {
  return resolve(bosunHome, ".bosun", "skills");
}

/**
 * Returns the path to the skills index JSON file.
 */
export function getSkillsIndexPath(bosunHome) {
  return resolve(getSkillsDir(bosunHome), "index.json");
}

// ── Scaffolding ───────────────────────────────────────────────────────────────

/**
 * Write built-in skill files to the given bosun home directory.
 * Existing files are NOT overwritten — to update built-ins, delete and re-scaffold.
 *
 * @param {string} bosunHome  Path to BOSUN_HOME
 * @returns {{ written: string[], skipped: string[], indexPath: string }}
 */
export function scaffoldSkills(bosunHome) {
  const skillsDir = getSkillsDir(bosunHome);
  mkdirSync(skillsDir, { recursive: true });

  const written = [];
  const skipped = [];

  for (const skill of BUILTIN_SKILLS) {
    const filePath = resolve(skillsDir, skill.filename);
    if (existsSync(filePath)) {
      skipped.push(filePath);
    } else {
      writeFileSync(filePath, skill.content.trim() + "\n", "utf8");
      written.push(filePath);
    }
  }

  // Build (or rebuild) the index every time so new user-created skills appear
  const indexPath = buildSkillsIndex(skillsDir);

  return { written, skipped, indexPath };
}

// ── Index management ──────────────────────────────────────────────────────────

/**
 * Scan the skills directory and write an up-to-date index.json.
 * The index is a lightweight manifest agents can read quickly.
 *
 * @param {string} skillsDir  Absolute path to the skills directory
 * @returns {string}          Path to the written index file
 */
export function buildSkillsIndex(skillsDir) {
  const indexPath = resolve(skillsDir, "index.json");
  const entries = [];

  // Seed with built-in metadata for known files
  const builtinByFilename = Object.fromEntries(
    BUILTIN_SKILLS.map((s) => [s.filename, s]),
  );

  let files = [];
  try {
    files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
  } catch {
    /* directory may not exist yet */
  }

  function extractSkillFileMetadata(filePath) {
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return { title: "", tags: [], important: false };
    }

    let title = "";
    let tags = [];
    let important = false;

    const tagMatch = /<!--\s*tags:\s*(.+?)\s*-->/i.exec(content);
    if (tagMatch) {
      tags = tagMatch[1].split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    }

    const importantMatch = /<!--\s*(?:important|eager)\s*:\s*(true|false|yes|no|on|off|1|0)\s*-->/i.exec(content);
    if (importantMatch) {
      const raw = String(importantMatch[1] || "").trim().toLowerCase();
      important = raw === "true" || raw === "yes" || raw === "on" || raw === "1";
    }

    const h1 = /^#\s+(?:Skill: )?(.+)/m.exec(content);
    if (h1) title = h1[1].trim();

    return { title, tags, important };
  }

  for (const filename of files.toSorted((a, b) => a.localeCompare(b))) {
    const filePath = resolve(skillsDir, filename);
    let stat;
    try { stat = statSync(filePath); } catch { continue; }

    const builtin = builtinByFilename[filename];
    let title = basename(filename, ".md").replaceAll("-", " ").replaceAll(/\b\w/g, (c) => c.toUpperCase());
    let tags = [];
    let important = false;
    let scope = "global";

    if (builtin) {
      title = builtin.title;
      tags = builtin.tags;
      important = builtin.important === true;
      scope = builtin.scope;
    } else {
      const metadata = extractSkillFileMetadata(filePath);
      if (metadata.title) title = metadata.title;
      tags = metadata.tags;
      important = metadata.important;
    }

    entries.push({
      filename,
      title,
      tags,
      important,
      scope,
      updatedAt: stat.mtime.toISOString(),
    });
  }

  const index = {
    generated: new Date().toISOString(),
    count: entries.length,
    skills: entries,
  };

  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");
  return indexPath;
}

// ── Context helper ────────────────────────────────────────────────────────────

/**
 * Build the skills-loading instruction block that gets appended to agent prompts.
 * Agents see this and know to look up the index + load relevant skill files.
 *
 * @param {string} bosunHome  BOSUN_HOME path for the project
 * @returns {string}          Prompt fragment (Markdown)
 */
export function buildSkillsPromptBlock(bosunHome) {
  const skillsDir = getSkillsDir(bosunHome);
  const indexPath = getSkillsIndexPath(bosunHome);
  return `
## Skills Knowledge-Base

Relevant skills and patterns discovered by previous agents are stored in:
  \`${skillsDir}\`

Index: \`${indexPath}\`

**Before starting work:**
1. Read \`${indexPath}\` to see available skills.
2. Load any skill files whose tags match your task's domain/module.
3. Apply relevant patterns and avoid known pitfalls.

**After completing work:**
If you discovered a non-obvious pattern, workaround, or domain fact that would
help the next agent, append or create a skill file at:
  \`${skillsDir}/<module>.md\`

Then update the index by running:
  \`node -e "import('bosun/bosun-skills.mjs').then(m => m.buildSkillsIndex('${skillsDir}'))"\`

Skills files are committed to git so all agents share the growing knowledge base.
`.trimStart();
}

/**
 * Load the skills index from a bosun home directory.
 * Returns null if no index exists yet.
 *
 * @param {string} bosunHome
 * @returns {{ skills: Array, generated: string } | null}
 */
export function loadSkillsIndex(bosunHome) {
  const indexPath = getSkillsIndexPath(bosunHome);
  if (!existsSync(indexPath)) return null;
  try {
    return JSON.parse(readFileSync(indexPath, "utf8"));
  } catch {
    return null;
  }
}

const DEFAULT_SKILLS_MAX_CHARS = 4000;

function normalizeKeywordText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function buildKeywordMatcher(title, description = "", labels = []) {
  const labelList = Array.isArray(labels)
    ? labels
    : String(labels || "")
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);
  const keywordText = normalizeKeywordText([title, description, ...labelList].join(" "));
  const keywords = new Set(keywordText.split(/\s+/).filter(Boolean));
  return {
    keywordText,
    paddedKeywordText: " " + keywordText + " ",
    keywords,
  };
}

function tagMatchesKeyword(tag, matcher) {
  const normalizedTag = normalizeKeywordText(tag);
  if (!normalizedTag) return false;

  const tagTokens = normalizedTag.split(/\s+/).filter(Boolean);
  if (tagTokens.length === 0) return false;
  if (tagTokens.length === 1) {
    return matcher.keywords.has(tagTokens[0]);
  }

  return matcher.paddedKeywordText.includes(" " + normalizedTag + " ")
    || tagTokens.every((token) => matcher.keywords.has(token));
}

function countSkillTagMatches(tags, matcher) {
  if (!Array.isArray(tags) || tags.length === 0) return 0;
  let matches = 0;
  for (const tag of tags) {
    if (tagMatchesKeyword(tag, matcher)) matches += 1;
  }
  return matches;
}

function resolveSkillCharBudget(maxChars) {
  const resolved = Number(maxChars ?? process.env.BOSUN_SKILLS_MAX_CHARS);
  return Number.isFinite(resolved) && resolved >= 0
    ? Math.floor(resolved)
    : DEFAULT_SKILLS_MAX_CHARS;
}

function selectRelevantSkills(bosunHome, taskTitle, taskDescription = "", opts = {}) {
  const index = loadSkillsIndex(bosunHome);
  if (!index?.skills?.length) return [];

  const matcher = buildKeywordMatcher(taskTitle, taskDescription, opts.labels || []);
  if (!matcher.keywordText) return [];

  const skillsDir = getSkillsDir(bosunHome);
  return index.skills
    .map(({ filename, title, tags, important }) => {
      const matchCount = countSkillTagMatches(tags, matcher);
      if (matchCount <= 0) return null;

      let content = "";
      try {
        content = readFileSync(resolve(skillsDir, filename), "utf8");
      } catch {
        return null;
      }

      return {
        filename,
        title,
        tags,
        important: important === true,
        matchCount,
        content,
      };
    })
    .filter(Boolean)
    .sort((left, right) =>
      right.matchCount - left.matchCount
      || Number(right.important === true) - Number(left.important === true)
      || String(left.filename).localeCompare(String(right.filename)),
    );
}

/**
 * Find skills relevant to a given task by matching tags against the task title
 * and description.
 *
 * @param {string}   bosunHome
 * @param {string}   taskTitle
 * @param {string}   [taskDescription]
 * @returns {Array<{filename:string,title:string,tags:string[],content:string}>}
 */
/**
 * Find skills relevant to a given task by matching tags against the task title
 * and description. Also emits `skill_invoke` analytics events for each matched
 * skill so usage analytics can track skill popularity over time.
 *
 * @param {string}   bosunHome
 * @param {string}   taskTitle
 * @param {string}   [taskDescription]
 * @param {{ taskId?: string, executor?: string }} [opts]  - Optional task context for analytics.
 * @returns {Array<{filename:string,title:string,tags:string[],content:string}>}
 */
export function findRelevantSkills(bosunHome, taskTitle, taskDescription = "", opts = {}) {
  const matched = selectRelevantSkills(bosunHome, taskTitle, taskDescription, opts);

  if (opts.emitAnalytics !== false) {
    for (const skill of matched) {
      const skillName = skill.filename.replace(/\.md$/i, "");
      emitSkillInvokeEvent(skillName, skill.title, opts);
    }
  }

  return matched;
}

export function loadSkillsForTask(bosunHome, task, opts = {}) {
  const taskTitle = String(task?.title || task?.name || "").trim();
  const taskDescription = String(task?.description || task?.body || "").trim();
  const labels = opts.labels ?? task?.labels ?? [];
  const matched = selectRelevantSkills(bosunHome, taskTitle, taskDescription, {
    ...opts,
    labels,
  });
  if (matched.length === 0) return "";

  const maxChars = resolveSkillCharBudget(opts.maxChars);
  if (maxChars <= 0) return "";

  const lines = ["## Skills Context", ""];
  const included = [];
  for (const skill of matched) {
    const importantLabel = skill.important ? " [important]" : "";
    const blockLines = [
      "### Skill: " + skill.title + " (`" + skill.filename + "`)" + importantLabel,
      skill.content.trim(),
      "",
    ];
    const candidate = lines.concat(blockLines).join("\n").trim();
    if (candidate.length > maxChars) continue;
    lines.push(...blockLines);
    included.push(skill);
  }

  if (included.length === 0) return "";

  if (opts.emitAnalytics !== false) {
    for (const skill of included) {
      const skillName = skill.filename.replace(/\.md$/i, "");
      emitSkillInvokeEvent(skillName, skill.title, opts);
    }
  }

  return lines.join("\n").trim();
}

export function buildRelevantSkillsPromptBlock(bosunHome, taskTitle, taskDescription = "", opts = {}) {
  return loadSkillsForTask(
    bosunHome,
    {
      title: taskTitle,
      description: taskDescription,
      labels: opts.labels || [],
    },
    opts,
  );
}
