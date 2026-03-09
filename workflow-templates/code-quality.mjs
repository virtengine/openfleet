/**
 * code-quality.mjs — Code quality maintenance workflow templates.
 *
 * Templates:
 *   - Code Quality Striker (recommended)
 *
 * Purpose:
 *   Recurring autonomous agent that refactors the codebase to improve
 *   structural quality for long-term agentic development. Runs every 2 hours,
 *   is capped at a 90-minute session, and MUST deliver a passing PR before
 *   ending. Zero functional changes — quality improvements only.
 */

import { node, edge, resetLayout } from "./_helpers.mjs";

// ═══════════════════════════════════════════════════════════════════════════
//  Code Quality Striker
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const CODE_QUALITY_STRIKER_TEMPLATE = {
  id: "template-code-quality-striker",
  name: "Code Quality Striker",
  description:
    "Recurring autonomous refactoring agent that improves codebase structure " +
    "for long-term agentic development. Runs every 2 hours with a hard 90-minute " +
    "session cap. Each session MUST produce a passing PR before terminating. " +
    "Scope is strictly limited to structural quality: module decomposition, " +
    "deduplication, function splitting. Zero functional changes allowed.",
  category: "maintenance",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    sessionTimeoutMs: 5400000,       // 90 minutes hard cap
    branch: "chore/code-quality-striker-{{_runId}}",
    baseBranch: "main",
    sessionLogPath: ".bosun-monitor/code-quality-striker.md",
    maxFilesPerSession: 6,           // keep PRs reviewable; prevents mega-diffs
    minFileSizeKb: 30,               // only target files worth splitting
    testCommand: "npm test",
    buildCommand: "npm run build",
    syntaxCheckCommand: "node --check",
  },
  nodes: [
    // ── 1. Schedule trigger ────────────────────────────────────────────────
    node("trigger", "trigger.schedule", "Every 2 Hours", {
      intervalMs: 7200000,
      cron: "0 */2 * * *",
    }, { x: 400, y: 50 }),

    // ── 2. Guard: skip if a quality striker branch already has an open PR ──
    node("check-active-pr", "condition.expression", "Active Striker PR?", {
      expression: "(() => { try { const r = $ctx.runCommand('git branch -r'); return (r?.output || '').includes('code-quality-striker'); } catch { return false; } })()",
    }, { x: 400, y: 180, outputs: ["yes", "no"] }),

    node("skip-already-running", "notify.log", "Skip — PR Already Open", {
      message: "Code quality striker skipped: an open quality striker PR already exists. Will retry next cycle.",
      level: "info",
    }, { x: 650, y: 310 }),

    // ── 3. Identify refactoring candidates ─────────────────────────────────
    node("scan-candidates", "action.run_command", "Scan Large Files", {
      // List .mjs/.js source files outside node_modules/.cache sorted by size.
      // Output: newline-separated relative paths.
      command: "node -e \"const{readdirSync,statSync}=require('fs');const{join,relative}=require('path');const base=process.cwd();function walk(d){const out=[];for(const f of readdirSync(d,{withFileTypes:true})){if(f.name==='node_modules'||f.name==='.cache'||f.name==='.git'||f.name==='worktrees')continue;const p=join(d,f.name);if(f.isDirectory())out.push(...walk(p));else if(/\\.(mjs|js)$/.test(f.name)){const s=statSync(p);out.push({p,kb:Math.round(s.size/1024)})}}return out}const files=walk(base).filter(x=>x.kb>={{minFileSizeKb}}).sort((a,b)=>b.kb-a.kb).slice(0,20);console.log(files.map(x=>x.kb+'kb\\t'+relative(base,x.p)).join('\\n'))\"",
      continueOnError: true,
    }, { x: 400, y: 310 }),

    // ── 4. Run the refactoring agent ───────────────────────────────────────
    node("run-striker", "action.run_agent", "Code Quality Striker Agent", {
      timeoutMs: "{{sessionTimeoutMs}}",
      sdk: "auto",
      prompt: `# Code Quality Striker

You are a **structural quality agent**. Your sole mandate is to improve the
internal structure of the codebase so that future agentic models can work on
it more efficiently — smaller files, clearer module boundaries, zero
duplication, and self-contained functions.

## Session Constraints

- **Hard session cap**: you have at most 90 minutes total. Budget your time.
- **You MUST open a PR before ending** — a session with no PR is a failed
  session. If you run out of time mid-refactor, commit what you have, push,
  and open the PR immediately even if the work is partial, AS LONG AS all
  tests pass.
- **Maximum {{maxFilesPerSession}} source files changed** in a single PR.
  Keep diffs small and reviewable. Better to do one clean split per session
  than attempt a mega-refactor.
- You may run multiple sessions and PRs over time. Prefer incremental progress.

## ✅ Allowed Changes (ONLY these)

1. **Module decomposition** — extract a large file into smaller, focused
   modules. The extracted module must be imported back so the public surface
   is identical.
2. **Function splitting** — break functions > ~80 lines into smaller,
   well-named helpers within the same file or a co-located util module.
3. **Deduplication** — extract identical or near-identical logic blocks into
   a shared helper. Must not change call-site behaviour.
4. **Dead code removal** — remove functions, variables, or imports that are
   verifiably unreferenced (no callers anywhere in the repo).
5. **Import cleanup** — remove unused imports, deduplicate import statements,
   consolidate barrel imports.

## ❌ Forbidden Changes (HARD STOPS — never do these)

- Adding, removing, or changing any exported function signature or return value
- Changing any HTTP route path, method, or response shape
- Changing any config key names or default values
- Adding new features, flags, or options of any kind
- Changing test assertions or test logic
- Renaming exported symbols (only rename internal/private symbols)
- Adding comments, JSDoc, or inline documentation (unless minimal and necessary)
- Changing error messages visible to users or logs (string literals)
- Any change to .json, .sh, .md, .yaml, .html, .css, or non-.mjs/.js files
  (unless you are only touching an import path string that is broken by a move)

## Workflow

### Step 1 — Identify your target

Use the candidate file list provided (sorted by size, largest first):

\`\`\`
{{scan-candidates.output}}
\`\`\`

Pick **1–3 files** for this session. Prioritise:
- Files > 500 lines used by multiple modules (high parallel-conflict risk)
- Files with clearly repeated logic blocks
- Files with functions > 100 lines that have distinct sub-responsibilities

Read each target file in full before making any decision. Do NOT edit
anything you have not fully read.

### Step 2 — Plan your split in writing

Before touching the file, write a short plan (to yourself, as a comment in
your reasoning — DO NOT add it to the code):
- What gets extracted and where
- New file names (follow existing naming conventions in that directory)
- Which exports stay vs. move
- Any callers that will need their import paths updated

### Step 3 — Extract and wire up

- Create the new module file(s) under the same directory as the source file.
- Update the source file to re-export or directly import the extracted piece
  so every existing call-site continues to work without modification.
- Update any OTHER files that directly imported from the source file, if and
  only if you moved an export that those files reference. Use
  \`grep -r 'importedName' --include='*.mjs' --include='*.js'\` to find callers.
- **Do not touch callers unless strictly required by the move.**

### Step 4 — Validate before committing

Run ALL of the following in order. Do not commit if any fail:

\`\`\`bash
# 1. Syntax check every file you touched
{{syntaxCheckCommand}} <file1> <file2> ...

# 2. Full test suite — must be 0 failures, 0 unexpected skips
npm test

# 3. Build — must pass clean
npm run build
\`\`\`

If tests fail, **revert your change** (\`git checkout -- <file>\`) and either:
- Attempt a smaller, safer split of the same file, OR
- Move to a different target file

**Never push a failing test suite.**

### Step 5 — Commit, push, and open the PR

Branch name: \`chore/code-quality-striker-{{_runId}}\`
Base branch: \`{{baseBranch}}\`

Commit message format:
\`\`\`
refactor(<module>): split <description>

- extracted <what> into <new-file>
- <any other bullet points>

No functional changes. All tests pass.
\`\`\`

PR title: \`refactor: code quality pass — <one-line summary>\`

PR body template:
\`\`\`markdown
## Code Quality Pass

**Session**: code-quality-striker {{_runId}}
**Scope**: structural refactor only — zero functional changes

### Changes
- <bullet per extracted module or dedup>

### Validation
- \`node --check\` passed on all touched files
- \`npm test\` passed (N tests)
- \`npm run build\` passed

### Why
<one sentence: "X was Y lines with Z responsibilities; split to improve
parallel edit safety for future agent sessions.">
\`\`\`

### Step 6 — Write session log

Append a new entry to \`{{sessionLogPath}}\` using this
exact format (create the file if it does not exist):

\`\`\`markdown
## <ISO timestamp with timezone>

- Scope: <one sentence describing what was refactored>
- Files changed: <comma-separated list>
- Strategy: <what split/dedup/cleanup was performed and why>
- Validation evidence:
  - \`node --check\` passed on all touched files
  - \`npm test\` passed (N tests)
  - \`npm run build\` passed
- PR: #<number> — \`<branch name>\`
\`\`\`

## Time Budget Warning

If you have fewer than 15 minutes remaining:
- Stop new analysis immediately
- Commit and push whatever passing changes you have
- Open the PR even if the scope is smaller than planned
- Write the session log
- Stop

A small, clean, tested PR is always better than nothing.`,
    }, { x: 400, y: 450 }),

    // ── 5. Verify tests pass ───────────────────────────────────────────────
    node("verify-tests", "validation.tests", "Verify — npm test", {
      command: "{{testCommand}}",
    }, { x: 200, y: 610 }),

    node("verify-build", "validation.build", "Verify — npm run build", {
      command: "{{buildCommand}}",
      zeroWarnings: false,
    }, { x: 600, y: 610 }),

    // ── 6. Both passed? ────────────────────────────────────────────────────
    node("check-validation", "condition.expression", "Validation Passed?", {
      expression: "$ctx.getNodeOutput('verify-tests')?.success === true && $ctx.getNodeOutput('verify-build')?.success === true",
    }, { x: 400, y: 750, outputs: ["yes", "no"] }),

    // ── 7a. Create PR ──────────────────────────────────────────────────────
    node("create-pr", "action.create_pr", "Open Quality PR", {
      title: "refactor: code quality pass {{_runId}}",
      body: "Automated code-quality session. Structural refactor only — zero functional changes. See `.bosun-monitor/code-quality-striker.md` for session details.",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
      labels: ["refactor", "code-quality", "automated"],
    }, { x: 200, y: 890 }),

    node("notify-success", "notify.telegram", "Notify PR Opened", {
      message: ":check: Code quality striker session complete.\nPR opened: **{{branch}}**\nRun ID: `{{_runId}}`",
      silent: true,
    }, { x: 200, y: 1030 }),

    // ── 7b. Validation failed — notify and abort ───────────────────────────
    node("notify-failure", "notify.telegram", "Notify — Validation Failed", {
      message: ":alert: Code quality striker **validation failed** for run `{{_runId}}`.\n\nThe agent produced changes that broke tests or build. No PR was created.\nCheck `.bosun-monitor/code-quality-striker.md` for details.",
    }, { x: 600, y: 890 }),

    node("log-failure", "notify.log", "Log Failure", {
      message: "Code quality striker run {{_runId}} failed validation — no PR created.",
      level: "warn",
    }, { x: 600, y: 1030 }),
  ],
  edges: [
    edge("trigger", "check-active-pr"),
    edge("check-active-pr", "skip-already-running", { condition: "$output?.result === true", port: "yes" }),
    edge("check-active-pr", "scan-candidates", { condition: "$output?.result !== true", port: "no" }),
    edge("scan-candidates", "run-striker"),
    edge("run-striker", "verify-tests"),
    edge("run-striker", "verify-build"),
    edge("verify-tests", "check-validation"),
    edge("verify-build", "check-validation"),
    edge("check-validation", "create-pr", { condition: "$output?.result === true", port: "yes" }),
    edge("check-validation", "notify-failure", { condition: "$output?.result !== true", port: "no" }),
    edge("create-pr", "notify-success"),
    edge("notify-failure", "log-failure"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-09T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["refactor", "code-quality", "maintenance", "scheduled", "agentic"],
    sessionLog: ".bosun-monitor/code-quality-striker.md",
  },
};
