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
const compactSkill = (title, sections) =>
  [`# Skill: ${title}`, "", ...sections].join("\n");

export const BUILTIN_SKILLS = [
  {
    filename: "background-task-execution.md",
    title: "Background Task Execution",
    tags: ["background", "task", "reliability", "heartbeat", "stall", "completion"],
    important: true,
    scope: "global",
    content: compactSkill("Background Task Execution", [
      "## Rules",
      "- Send `/heartbeat` at start, after milestones, and at least every 60s during long steps.",
      "- Send `/status` before work that may look stalled.",
      "- Verify build, targeted tests, and lint before `/complete`.",
      "- Review existing edits with `git status`; never discard unknown work silently.",
      "- On retry, inspect `LAST_ERROR` and recent commits before re-implementing.",
      "- Stay inside `BOSUN_WORKTREE_PATH`; never touch main or another worktree.",
    ]),
  },
  {
    filename: "pr-workflow.md",
    title: "Pull Request Workflow",
    tags: ["pr", "pull-request", "github", "review", "ci", "merge"],
    important: true,
    scope: "global",
    content: compactSkill("Pull Request Workflow", [
      "## Flow",
      "- Merge upstream base branch and `origin/main` before push.",
      "- Push with `git push --set-upstream origin <branch>`.",
      "- Hand off PR lifecycle to Bosun; do not run direct PR-create commands.",
      "- Never use `--no-verify`.",
      "- If hooks fail, fix the root cause and rerun targeted validation.",
      "- Use `gh pr checks` and `gh run list` to inspect CI state.",
    ]),
  },
  {
    filename: "error-recovery.md",
    title: "Error Recovery Patterns",
    tags: ["error", "recovery", "retry", "debug", "failure"],
    important: true,
    scope: "global",
    content: compactSkill("Error Recovery Patterns", [
      "## Rules",
      "- Classify the failure first: compile, test, dependency, git, config, network, or OOM.",
      "- Apply the smallest fix that resolves the current error.",
      "- Fix the first compiler error before chasing follow-on failures.",
      "- Reproduce test failures in isolation before broad reruns.",
      "- Fix generators instead of generated output.",
      "- After two failed attempts on the same issue, report `/error` and stop looping.",
    ]),
  },
  {
    filename: "tdd-pattern.md",
    title: "Test-Driven Development",
    tags: ["tdd", "testing", "unit-test", "red-green-refactor", "coverage"],
    scope: "global",
    content: compactSkill("Test-Driven Development", [
      "## Loop",
      "- Start with a failing test for the requested behavior.",
      "- Make the smallest production change that turns the test green.",
      "- Refactor only after the new behavior is covered.",
      "- Keep tests deterministic; no real network, random data, or timer-based syncing.",
      "- Mock external boundaries only, never the module under test.",
      "- Run the narrowest relevant tests first, then adjacent coverage.",
    ]),
  },
  {
    filename: "commit-conventions.md",
    title: "Conventional Commits",
    tags: ["commits", "git", "conventional-commits", "versioning", "changelog"],
    scope: "global",
    content: compactSkill("Conventional Commits", [
      "## Format",
      "- Use `<type>(<scope>): <subject>` when scope is known.",
      "- Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`, `perf`.",
      "- Keep the subject imperative, lowercase, and without a trailing period.",
      "- Commit only verified logical units; split unrelated changes.",
      "- Avoid WIP commits unless the task explicitly asks for them.",
      "- Mention user-facing risk or follow-up detail in the body when needed.",
    ]),
  },
  {
    filename: "agent-coordination.md",
    title: "Multi-Agent Coordination",
    tags: ["multi-agent", "parallel", "coordination", "worktree", "conflict", "bosun"],
    scope: "global",
    content: compactSkill("Multi-Agent Coordination", [
      "## Rules",
      "- Treat branch and worktree isolation as mandatory boundaries.",
      "- Review `git status` before editing to understand inherited state.",
      "- Stage files explicitly; do not use `git add .`.",
      "- Merge upstream before push and resolve conflicts without discarding peer work.",
      "- Preserve useful intermediate commits from previous attempts.",
      "- Leave concise handoff notes when the next agent needs context.",
    ]),
  },
  {
    filename: "bosun-agent-api.md",
    title: "Bosun Agent Status API",
    tags: ["bosun", "api", "status", "heartbeat", "endpoint"],
    scope: "global",
    content: compactSkill("Bosun Agent Status API", [
      "## Required Calls",
      "- Use the local status API whenever running as a Bosun-managed agent.",
      "- Read endpoint values from `BOSUN_ENDPOINT_PORT`, `BOSUN_TASK_ID`, and related aliases.",
      "- POST `/status` for milestones, `/heartbeat` during active work, `/error` on abort, and `/complete` when finished.",
      "- Include short, concrete notes so orchestrator logs stay useful.",
      "- Do not mark completion before validation passes and push state is known.",
    ]),
  },
  {
    filename: "code-quality-anti-patterns.md",
    title: "Code Quality Anti-Patterns",
    tags: ["quality", "code", "architecture", "async", "testing", "reliability", "bug", "crash", "scope", "caching", "promise", "module"],
    scope: "global",
    content: compactSkill("Code Quality Anti-Patterns", [
      "## Avoid",
      "- Module-state caches inside hot functions; keep cached state at module scope.",
      "- Bare async fire-and-forget calls; every promise needs `await` or `.catch()`.",
      "- Unguarded async handlers that can crash the process.",
      "- Repeated dynamic `import()` in hot paths without caching.",
      "- Over-mocked or flaky tests that depend on order, sleep, or random data.",
      "- Inline flag bypasses or safety-check shortcuts that change system behavior.",
    ]),
  },
  {
    filename: "skill-codebase-audit.md",
    title: "Codebase Annotation Audit",
    tags: ["audit", "annotation", "documentation", "summary", "inventory", "codebase", "onboarding", "knowledge", "context", "skill", "warn", "manifest", "conformity", "regeneration", "claude", "copilot"],
    scope: "global",
    content: compactSkill("Codebase Annotation Audit", [
      "## Rules",
      "- Add `CLAUDE:SUMMARY` and `CLAUDE:WARN` only where they reduce future search cost.",
      "- Place annotations near the top of the file, after imports or shebang.",
      "- Audit hot paths first: entrypoints, schedulers, cross-module adapters, and risky stateful code.",
      "- Keep notes LEAN: documentation-only, terse, and easy to regenerate.",
      "- Re-audit when summaries drift or regenerated coverage drops by about 20 percent.",
    ]),
  },
  {
    filename: "custom-tool-creation.md",
    title: "Custom Tool Creation & Reuse",
    tags: ["tools", "custom-tool", "reflect", "reuse", "automation", "script"],
    scope: "global",
    content: compactSkill("Custom Tool Creation & Reuse", [
      "## Rules",
      "- Check the custom tools library before writing new helper code.",
      "- Extract repeated or high-friction logic into `.bosun/tools/` when it will save future tasks.",
      "- Prefer categories from `analysis`, `testing`, `git`, `build`, `transform`, `search`, `validation`, and `utility`.",
      "- Register tools with `registerCustomTool()` and clear tags, description, and owner metadata.",
      "- Promote proven workspace tools to global scope when reuse crosses projects.",
      "- Skip one-off scripts that do not justify long-term maintenance.",
    ]),
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
  const index = loadSkillsIndex(bosunHome);
  if (!index?.skills?.length) return [];

  const searchText = `${taskTitle} ${taskDescription}`.toLowerCase();
  const skillsDir = getSkillsDir(bosunHome);

  const matched = index.skills
    .filter(({ tags }) =>
      tags.some((tag) => searchText.includes(tag)),
    )
    .map(({ filename, title, tags, important }) => {
      let content = "";
      try {
        content = readFileSync(resolve(skillsDir, filename), "utf8");
      } catch { /* skip unreadable files */ }
      return { filename, title, tags, important: important === true, content };
    })
    .filter(({ content }) => !!content);

  // Emit analytics events for each loaded skill
  for (const skill of matched) {
    const skillName = skill.filename.replace(/\.md$/i, "");
    emitSkillInvokeEvent(skillName, skill.title, opts);
  }

  return matched;
}

export function buildRelevantSkillsPromptBlock(bosunHome, taskTitle, taskDescription = "", opts = {}) {
  const {
    maxListed = 8,
    includeMatchedSummary = true,
  } = opts;
  const matched = findRelevantSkills(bosunHome, taskTitle, taskDescription, opts);
  if (!matched.length) return "";

  const importantMatches = matched.filter((skill) => skill.important);
  const summaryMatches = matched.slice(0, Math.max(1, maxListed));
  const lines = ["## Relevant Skills", ""];

  if (importantMatches.length > 0) {
    lines.push(
      "These matched skills are marked important, so their contents are loaded directly below.",
      "",
    );
    for (const skill of importantMatches) {
      lines.push(`### Skill: ${skill.title} (\`${skill.filename}\`)`);
      lines.push(skill.content.trim());
      lines.push("");
    }
  }

  if (includeMatchedSummary) {
    lines.push("Matched skill files:");
    for (const skill of summaryMatches) {
      const tags = Array.isArray(skill.tags) && skill.tags.length > 0
        ? ` — tags: ${skill.tags.join(", ")}`
        : "";
      const importantLabel = skill.important ? " [important]" : "";
      lines.push(`- \`${skill.filename}\` — ${skill.title}${importantLabel}${tags}`);
    }
    lines.push("");
    lines.push("Load non-important matched skills on demand if you need their details.");
    lines.push("");
  }

  return lines.join("\n").trim();
}


