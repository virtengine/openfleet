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

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";

// ── Built-in skill definitions ────────────────────────────────────────────────

/**
 * Each entry:
 *   filename  – the .md file written into skills/
 *   title     – short human-readable name
 *   tags      – array of lowercase tags agents use to match skills to tasks
 *   scope     – "global" | "bosun" (bosun-specific internals)
 *   content   – the full Markdown skill text
 */
export const BUILTIN_SKILLS = [
  {
    filename: "background-task-execution.md",
    title: "Background Task Execution",
    tags: ["background", "task", "reliability", "heartbeat", "stall", "completion"],
    scope: "global",
    content: `# Skill: Background Task Execution

## Purpose
Ensure coding tasks that run autonomously in the background complete reliably
without stalling, losing state, or silently failing.

## Heartbeat & Claim Renewal

When a task agent runs without an interactive terminal, bosun monitors liveness
via a heartbeat endpoint. **Always POST a heartbeat while work is in progress:**

\`\`\`
POST http://127.0.0.1:<ENDPOINT_PORT>/api/tasks/<TASK_ID>/heartbeat {}
\`\`\`

POST this:
- At startup before any work begins
- After every major milestone (file edited, test run, build completed)
- At most every 60 seconds during long-running operations (builds, installs)

Failure to heartbeat causes the orchestrator to re-queue the task — wasting
compute and creating merge conflicts. Don't skip it.

## No-Progress Detection

Bosun detects stalls via a configurable window (default 10 min). If your agent
is about to spend > 5 minutes on a single step (e.g., a large dependency install),
heartbeat mid-step and log a status message so the orchestrator knows you're alive.

\`\`\`
POST /api/tasks/<TASK_ID>/status { "status": "inprogress", "note": "Installing deps..." }
\`\`\`

## Verification Before Completion

**Never mark a task complete without verifying**:
1. Build succeeds (at minimum, re-check changed files compile/parse cleanly).
2. Tests pass for the affected module (or full suite if cheap).
3. No lint/format regressions introduced.
4. Branch was pushed and PR opened (if applicable).

\`\`\`
POST /api/tasks/<TASK_ID>/complete { "hasCommits": true }
\`\`\`

## Handling Stale State

If git shows unexpected staged/unstaged changes on startup:
1. Run \`git status\` to understand what's there.
2. If changes belong to your task: stage, commit, and push.
3. If changes are leftover from a previous failed run: stash them or clean
   (only if they don't belong to the current task's scope).

Never silently discard local changes — they may be work from a previous attempt.

## Recovery after Crash

The orchestrator will re-queue a task if the agent crashes unexpectedly.
On restart, the retry prompt includes \`LAST_ERROR\` — read it before acting.

1. Check \`git log --oneline -5\` to see how far the previous attempt got.
2. If commits exist: verify and push rather than re-implementing.
3. If no commits: start implementation from scratch with lessons from the error.

## Parallelism Safety

Multiple bosun agents can run simultaneously in separate git worktrees.
**Never operate on the main branch or another agent's worktree path.**

Your worktree path is provided via \`BOSUN_WORKTREE_PATH\`. Stay inside it.
`,
  },
  {
    filename: "pr-workflow.md",
    title: "Pull Request Workflow",
    tags: ["pr", "pull-request", "github", "review", "ci", "merge"],
    scope: "global",
    content: `# Skill: Pull Request Workflow

## Standard Bosun Lifecycle Flow

After committing all changes on your task branch:

\`\`\`bash
# Merge upstream changes first (base branch + main)
git fetch origin
git merge origin/<base-branch> --no-edit 2>/dev/null || true
git merge origin/main --no-edit 2>/dev/null || true

# Resolve any conflicts, commit, then push
git push --set-upstream origin <branch-name>

# Hand off PR lifecycle to Bosun manager (no direct PR-create command)
echo "PR lifecycle handoff ready for <branch-name>"
\`\`\`

Bosun manages PR lifecycle (create/update/merge) after handoff.

## PR Description Template

\`\`\`markdown
## Summary
<What was changed and why>

## Changes
- <file or component>: <what changed>
- <file or component>: <what changed>

## Testing
- <what tests were run / added>

## Notes
<Any non-obvious side-effects or follow-ups required>
\`\`\`

## Pre-Push Hooks

Bosun installs pre-push hooks that run build + test validation.
**Never use \`--no-verify\`** — if hooks fail, fix the issues first.

If the hook runs \`npm test\` or \`dotnet test\` and fails:
1. Read the test output carefully.
2. Fix the root cause (not just suppress the error).
3. If the failure is in an unrelated existing test, note it in the lifecycle handoff context
   and run a targeted test to confirm your changes don't regress it.

## Reviewing CI Status

\`\`\`bash
gh pr checks <number>  # show check statuses
gh run list --limit 5  # recent workflow runs
\`\`\`
`,
  },
  {
    filename: "error-recovery.md",
    title: "Error Recovery Patterns",
    tags: ["error", "recovery", "retry", "debug", "failure"],
    scope: "global",
    content: `# Skill: Error Recovery Patterns

## Error Classification

Before applying a fix, classify the error. Different error types require
different recovery strategies:

| Type | Symptoms | Strategy |
|------|----------|----------|
| **Compile/Syntax** | Build fails, parse errors | Fix source code, re-build |
| **Test Failure** | Tests fail, assertions wrong | Root-cause analysis, fix logic |
| **Missing Dependency** | Import/require not found | Install package, update lock file |
| **Git Conflict** | Merge conflict markers | Resolve preserving both intents |
| **Network/Timeout** | API calls fail intermittently | Retry with backoff, then abort |
| **Config Error** | Env var missing, path wrong | Check .env, ensure scaffold exists |
| **OOM/Kill** | Process killed, no error | Reduce batch size, no code fix |

## Minimal-Fix Principle

Apply the **smallest change** that fixes the problem. Do not refactor surrounding
code. Do not "clean up" unrelated areas. Reviewers will reject broad changes
that mask the actual fix.

## Build Errors

1. Read the compiler output from the top — first error often causes the rest.
2. Fix one issue at a time; rebuild to see downstream errors dissolve.
3. If the error is in generated code: fix the generator, not the generated output.

## Test Failures

1. Run only the failing test in isolation: \`npm test -- --grep "<test name>"\`
2. Add a \`console.log\` or debug breakpoint to understand the actual vs expected values.
3. Fix the production code, then verify the test passes alone and as part of the suite.

## Import / Dependency Errors

\`\`\`bash
# Node.js
npm install <package>          # add to dependencies
npm ci                         # clean install from lockfile

# Python
pip install <package>
\`\`\`

For missing peer dependencies, check the package README for install instructions
before blindly installing.

## The "Works Locally, Fails in CI" Pattern

- Check environment variables: CI may not have secrets that your local .env has.
- Check working directory: CI often runs from repo root; relative paths may differ.
- Check Node/runtime version: CI may use a different version than local.

## When to Escalate

If after 2 fix attempts the same error persists, POST to the error endpoint and
stop rather than entering an infinite loop:
\`\`\`
POST /api/tasks/<TASK_ID>/error { "error": "<detailed error message + stack trace>" }
\`\`\`
This lets the orchestrator decide whether to retry with a different executor,
escalate to human review, or re-queue with updated context.
`,
  },
  {
    filename: "tdd-pattern.md",
    title: "Test-Driven Development",
    tags: ["tdd", "testing", "unit-test", "red-green-refactor", "coverage"],
    scope: "global",
    content: `# Skill: Test-Driven Development

## The Red-Green-Refactor Cycle

For every meaningful behavior change, follow this cycle:

1. **Red** — Write a failing test that describes the expected behavior.
   Confirm it fails for the *right* reason (wrong behavior, not a setup error).

2. **Green** — Write the minimum production code to make the test pass.
   Resist the urge to add extra logic not tested by the current red test.

3. **Refactor** — Clean up code while keeping tests green.
   Extract helpers, rename for clarity, remove duplication.

Commit at each stable green point, not just at the end.

## Test Quality Checklist

- Tests assert *behavior*, not *implementation details* (avoid testing private methods).
- Each test covers exactly one scenario (a test with multiple \`assert\` calls
  for unrelated things is likely two tests).
- Tests are deterministic — no random data, no clock-dependent assertions without mocking.
- Avoid \`sleep\`/\`wait\` in tests; use event-driven assertions or mock timers.

## Naming Convention

\`\`\`
<unit>_<scenario>_<expectedOutcome>
  e.g. parseDate_invalidString_throwsArgumentError
       createTask_withTitle_returnsTaskWithId
\`\`\`

Or BDD-style:
\`\`\`
describe('<unit>') {
  it('should <expected outcome> when <condition>')
}
\`\`\`

## What to Test

| Worth testing | Skip or defer |
|---------------|---------------|
| Business logic / domain rules | Third-party library internals |
| Edge cases that caused past bugs | UI pixel layout |
| Complex parsing / transformation | One-liner getters with no logic |
| Auth / permissions checks | Framework boilerplate |

## Running Tests Efficiently

\`\`\`bash
# Run only tests touching changed files (Jest)
npx jest --onlyChanged

# Run a single test file
npx jest path/to/test.spec.ts

# Run tests matching a name pattern
npx jest -t "parseDate"
\`\`\`

Always run the full suite as a final gate before pushing.
`,
  },
  {
    filename: "commit-conventions.md",
    title: "Conventional Commits",
    tags: ["commits", "git", "conventional-commits", "versioning", "changelog"],
    scope: "global",
    content: `# Skill: Conventional Commits

## Format

\`\`\`
<type>(<scope>): <short description>

[optional body — explain WHY, not WHAT]

[optional footer — BREAKING CHANGE, Closes #123, Co-authored-by: ...]
\`\`\`

## Types

| Type | When to use |
|------|-------------|
| **feat** | New feature or capability |
| **fix** | Bug fix |
| **refactor** | Code restructure without behavior change |
| **perf** | Performance improvement |
| **test** | Adding/fixing tests only |
| **docs** | Documentation only |
| **chore** | Build system, deps, tooling (no prod code) |
| **ci** | CI/CD pipeline changes |
| **revert** | Reverts a previous commit |
| **style** | Formatting/lint only |

## Scope

The scope is the **module or area** affected:
- Use the directory or package name: \`feat(auth):\`, \`fix(api):\`, \`chore(deps):\`
- For bosun tasks, use the task's module or feature: \`feat(task-executor):\`
- Omit scope for cross-cutting changes: \`chore: update node version\`

## Rules for Bosun Agents

1. **Stage files individually** — never \`git add .\`
   \`\`\`bash
   git add src/specific/changed/file.ts
   git add tests/specific/test.ts
   \`\`\`

2. **One logical change per commit** — don't bundle unrelated fixes.

3. **Body explains intent** when the short description isn't obvious:
   \`\`\`
   fix(task-executor): prevent double-completion on retry

   The heartbeat timer fired after task completion, causing a second
   POST /complete that overwrote the done status. Cancel the timer on success.
   \`\`\`

4. **Breaking changes** go in the footer:
   \`\`\`
   BREAKING CHANGE: EXECUTORS env format changed from CSV to JSON.
   Migrate by running: bosun migrate-config
   \`\`\`

## Common Mistakes to Avoid

- ❌ \`git commit -m "fix stuff"\` — too vague
- ❌ \`git commit -m "WIP: not done yet"\` — commit only complete, testable units
- ❌ \`git commit -am "…"\` — stages all tracked changes indiscriminately
- ✅ \`git add src/auth/login.ts && git commit -m "fix(auth): handle empty token gracefully"\`
`,
  },
  {
    filename: "agent-coordination.md",
    title: "Multi-Agent Coordination",
    tags: ["multi-agent", "parallel", "coordination", "worktree", "conflict", "bosun"],
    scope: "bosun",
    content: `# Skill: Multi-Agent Coordination

## How Bosun Runs Agents in Parallel

Bosun uses **git worktrees** to run multiple agents simultaneously without
conflict. Each agent gets its own isolated directory:

\`\`\`
<workspace>/
  main-repo/          ← original checkout (main branch)
  .bosun-worktrees/
    task-001-feature-x/   ← Agent A works here
    task-002-fix-y/       ← Agent B works here
\`\`\`

Each worktree is on its own branch. Agent A's commits never touch Agent B's
directory, and vice-versa.

## Rules for Agents in Worktrees

1. **Never navigate outside your worktree** — use \`BOSUN_WORKTREE_PATH\` as your root.
2. **Never modify files in another agent's worktree** — not even to "help".
3. **Never switch branches inside your worktree** — your branch was pre-set.
4. **Never run \`git worktree add/remove\`** — bosun manages the worktree lifecycle.

## Merge Order and Base Branches

Each task has a \`base_branch\` (often a module branch like \`origin/auth\`).
Your branch was created from that base — not from \`main\` directly.

Merge order on completion:
1. Merge upstream base branch changes into your branch (keeps drift low).
2. Merge main (catches global changes like dep bumps).
3. Push and hand off lifecycle targeting the base branch.

The orchestrator then merges the base branch into main after CI.

## Shared State

Bosun uses a **shared state manager** to coordinate claims, heartbeats, and task
statuses across agents. All communication goes through HTTP:

\`\`\`
http://127.0.0.1:<ENDPOINT_PORT>/api/tasks/<TASK_ID>/...
\`\`\`

Do not read/write the task store files directly — use the API endpoints.

## File-Level Conflict Avoidance

The planner intentionally keeps task file overlap low. If you notice your task
would require editing the same file as another active task:

1. Check if the other task is still in-progress via \`GET /api/tasks?status=inprogress\`.
2. If it is, focus only on non-overlapping changes and note the dependency.
3. If it isn't, proceed normally — git will handle the merge.

## Detecting & Resolving Conflicts

If \`git merge\` reports conflicts:
\`\`\`bash
git status                         # see conflicting files
git diff --diff-filter=U           # see conflict markers
\`\`\`

Resolution heuristics:
- **Lockfiles** (\`package-lock.json\`, \`yarn.lock\`): \`git checkout --theirs <file>\`, then \`npm ci\`
- **Changelogs / coverage reports**: \`git checkout --ours <file>\`
- **Source files**: merge by intent — preserve both changes where both are correct.

After merging \`git add <resolved>\` and \`git commit\` (no message needed for merge commits).
`,
  },
  {
    filename: "bosun-agent-api.md",
    title: "Bosun Agent Status API",
    tags: ["bosun", "api", "status", "heartbeat", "endpoint"],
    scope: "bosun",
    content: `# Skill: Bosun Agent Status API

Bosun exposes a local HTTP API for agents to report progress, errors, and
completion. You MUST use this API when running as a bosun-managed agent.

## Endpoint Base

\`http://127.0.0.1:<ENDPOINT_PORT>/api/tasks/<TASK_ID>/\`

Both \`ENDPOINT_PORT\` and \`TASK_ID\` are injected into your environment as
\`BOSUN_ENDPOINT_PORT\` / \`VE_ENDPOINT_PORT\` and \`BOSUN_TASK_ID\` / \`VK_TASK_ID\`.

## Required Calls

### Startup
\`\`\`bash
curl -sX POST http://127.0.0.1:$BOSUN_ENDPOINT_PORT/api/tasks/$BOSUN_TASK_ID/heartbeat \\
  -H "Content-Type: application/json" -d '{}'
\`\`\`

### Periodic Heartbeat (every ≤ 60 seconds during active work)
Same as startup.

### Status Update
\`\`\`bash
curl -sX POST http://127.0.0.1:$BOSUN_ENDPOINT_PORT/api/tasks/$BOSUN_TASK_ID/status \\
  -H "Content-Type: application/json" \\
  -d '{"status": "inprogress", "note": "Running tests..."}'
\`\`\`
Status values: \`todo → inprogress → inreview → done\`

### Completion (after successful push + PR)
\`\`\`bash
curl -sX POST http://127.0.0.1:$BOSUN_ENDPOINT_PORT/api/tasks/$BOSUN_TASK_ID/complete \\
  -H "Content-Type: application/json" \\
  -d '{"hasCommits": true}'
\`\`\`

### Error (fatal failure only — do not retry after posting an error)
\`\`\`bash
curl -sX POST http://127.0.0.1:$BOSUN_ENDPOINT_PORT/api/tasks/$BOSUN_TASK_ID/error \\
  -H "Content-Type: application/json" \\
  -d '{"error": "Build failed: <details>"}'
\`\`\`

## Environment Variables Available to Agents

| Variable | Alias | Description |
|----------|-------|-------------|
| \`BOSUN_TASK_ID\` | \`VK_TASK_ID\` | Current task identifier |
| \`BOSUN_TASK_TITLE\` | \`VK_TASK_TITLE\` | Human-readable title |
| \`BOSUN_TASK_DESCRIPTION\` | \`VK_TASK_DESCRIPTION\` | Full task description |
| \`BOSUN_BRANCH_NAME\` | \`VK_BRANCH_NAME\` | Git branch for this task |
| \`BOSUN_WORKTREE_PATH\` | \`VK_WORKTREE_PATH\` | Absolute path to worktree root |
| \`BOSUN_ENDPOINT_PORT\` | \`VE_ENDPOINT_PORT\` | API server port |
| \`BOSUN_SDK\` | \`VE_SDK\` | SDK/executor type (COPILOT/CODEX/CLAUDE_CODE) |
| \`BOSUN_MANAGED\` | \`VE_MANAGED\` | Set to "1" when running under bosun |
`,
  },
  {
    filename: "code-quality-anti-patterns.md",
    title: "Code Quality Anti-Patterns",
    tags: ["quality", "code", "architecture", "async", "testing", "reliability", "bug", "crash", "scope", "caching", "promise", "module"],
    scope: "global",
    content: `# Skill: Code Quality Anti-Patterns

## Purpose
Prevent common coding mistakes that cause crashes, flaky behavior, memory leaks,
and hard-to-diagnose production failures. Every pattern below has caused real
outages — treat each as a hard rule, not a suggestion.

---

## 1. Module-Scope vs Function-Scope — Caching & Singletons

**Rule:** Variables that cache module-level state (lazy singletons, loaded
configs, memoized results) MUST be declared at **module scope**, never inside
a function that runs repeatedly.

### Bad — re-initializes on every call
\`\`\`js
export function handleRequest(req, res) {
  let _engine;           // ← reset to undefined on EVERY call
  let _loaded = false;   // ← never stays true across calls
  if (!_loaded) {
    _engine = await loadEngine();
    _loaded = true;
  }
  // ...
}
\`\`\`

### Good — persists across calls
\`\`\`js
let _engine;
let _loaded = false;

export function handleRequest(req, res) {
  if (!_loaded) {
    _engine = await loadEngine();
    _loaded = true;
  }
  // ...
}
\`\`\`

**Why:** Placing cache variables inside a function body causes:
- Repeated expensive initialization (import, parse, connect) on every call
- Log spam from repeated init messages
- Potential memory leaks from orphaned resources
- Race conditions when multiple concurrent calls all see \`_loaded === false\`

**Checklist:**
- [ ] Lazy singletons: module scope
- [ ] Memoization caches: module scope (or a \`Map\`/\`WeakMap\` at module scope)
- [ ] "loaded" / "initialized" flags: module scope
- [ ] Config objects read once from disk: module scope

---

## 2. Async Fire-and-Forget — Always Handle Rejections

**Rule:** NEVER use bare \`void asyncFn()\` or call an async function without
either \`await\`-ing or chaining \`.catch()\`. Unhandled promise rejections crash
Node.js processes.

### Bad — unhandled rejection → crash
\`\`\`js
void dispatchEvent(data);    // if dispatchEvent is async and throws → crash
asyncCleanup();              // no await, no catch → crash
\`\`\`

### Good — always handle the rejection
\`\`\`js
await dispatchEvent(data);                           // preferred: await it
dispatchEvent(data).catch(() => {});                  // fire-and-forget OK
dispatchEvent(data).catch(err => log.warn(err));      // fire-and-forget with logging
\`\`\`

**Why:** Since Node.js 15+, unhandled promise rejections terminate the process
with exit code 1. A single \`void asyncFn()\` in a hot path can cause a
crash → restart → crash loop that takes down the entire system.

**Checklist:**
- [ ] Every async call is \`await\`-ed OR has a \`.catch()\` handler
- [ ] No bare \`void asyncFn()\` patterns
- [ ] Event dispatch functions wrapped in try/catch at the top level
- [ ] setInterval/setTimeout callbacks that call async functions use \`.catch()\`

---

## 3. Error Boundaries & Defensive Coding

**Rule:** Any function called from a hot path (HTTP handlers, event loops,
timers) MUST have a top-level try/catch that prevents a single failure from
crashing the entire process.

### Bad — one bad event kills the server
\`\`\`js
router.post('/webhook', async (req, res) => {
  const data = parsePayload(req.body);
  await processAllWebhooks(data);
  res.json({ ok: true });
});
\`\`\`

### Good — contained failure
\`\`\`js
router.post('/webhook', async (req, res) => {
  try {
    const data = parsePayload(req.body);
    await processAllWebhooks(data);
    res.json({ ok: true });
  } catch (err) {
    log.error('webhook handler failed', err);
    res.status(500).json({ error: 'internal' });
  }
});
\`\`\`

---

## 4. Testing Anti-Patterns

### Over-Mocking
**Rule:** Tests should validate real behavior, not just confirm that mocks
return what you told them to return.

- Mock only external boundaries (network, filesystem, clock).
- Never mock the module under test.
- If you need > 3 mocks for a single test, the code under test probably needs
  refactoring, not more mocks.
- Prefer integration tests with real instances over unit tests with heavy mocking.

### Flaky Tests
**Rule:** Tests must be deterministic and reproducible.

- No \`Math.random()\` or \`Date.now()\` without mocking.
- No network calls to real servers.
- No \`setTimeout\`/\`sleep\` for synchronization — use proper async patterns.
- No implicit ordering dependencies between tests.
- If a test creates global state, clean it up in \`afterEach\`.

### Assertion Quality
- Test ONE behavior per test case.
- Assert on observable outputs, not internal state.
- Check error cases, not just happy paths.
- Use descriptive test names: \`parseDate_invalidInput_throwsError\`
  not \`test parseDate 3\`.

---

## 5. Architectural Patterns

### Initialization Guards
When a module has expensive async initialization, use a promise-based
deduplication pattern to prevent multiple concurrent initializations:

\`\`\`js
let _initPromise = null;

async function ensureInit() {
  if (!_initPromise) {
    _initPromise = doExpensiveInit(); // called ONCE
  }
  return _initPromise;
}
\`\`\`

### Import/Require in Module Scope
Dynamic \`import()\` calls should be cached at module scope.
Never put \`import()\` inside a frequently-called function without caching.

### Guard Clauses for Optional Features
When calling into optional subsystems (plugins, workflow engines, etc.),
always check that the subsystem is enabled before invoking:

\`\`\`js
if (!config.featureEnabled) return;
const engine = await getEngine();
if (!engine) return;
await engine.process(data);
\`\`\`

---

## Quick Reference: Red Flags in Code Review

| Pattern | Risk | Fix |
|---------|------|-----|
| \`let x\` inside function body used as cache | Re-init every call | Hoist to module scope |
| \`void asyncFn()\` | Unhandled rejection → crash | \`await\` or \`.catch()\` |
| Async callback without try/catch | Uncaught exception → crash | Wrap in try/catch |
| \`import()\` inside hot function, no cache | Repeated I/O, log spam | Cache at module scope |
| Test mocking the module under test | Test proves nothing | Mock only boundaries |
| \`setTimeout\`/\`sleep\` in tests | Flaky | Use async events/mocks |
| No error case tests | False confidence | Add negative test cases |
| \`git add .\` | Stages unrelated files | Stage files individually |
`,
  },
];

// ── Skills directory helpers ──────────────────────────────────────────────────

/**
 * Returns the skills directory path for a given bosun home.
 * Global skills: BOSUN_HOME/.bosun/skills/
 */
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

  for (const filename of files.toSorted((a, b) => a.localeCompare(b))) {
    const filePath = resolve(skillsDir, filename);
    let stat;
    try { stat = statSync(filePath); } catch { continue; }

    const builtin = builtinByFilename[filename];
    let title = basename(filename, ".md").replaceAll("-", " ").replaceAll(/\b\w/g, (c) => c.toUpperCase());
    let tags = [];
    let scope = "global";

    if (builtin) {
      title = builtin.title;
      tags = builtin.tags;
      scope = builtin.scope;
    } else {
      // Try to extract tags from the first `<!--tags: ... -->` comment or a
      // "## Tags" / "## Tags:" section in the skill file.
      try {
        const content = readFileSync(filePath, "utf8");
        const tagMatch = /<!--\s*tags:\s*(.+?)\s*-->/i.exec(content);
        if (tagMatch) {
          tags = tagMatch[1].split(/[,\s]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
        } else {
          const h1 = /^#\s+(?:Skill: )?(.+)/m.exec(content);
          if (h1) title = h1[1].trim();
        }
      } catch { /* ignore read errors */ }
    }

    entries.push({
      filename,
      title,
      tags,
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
export function findRelevantSkills(bosunHome, taskTitle, taskDescription = "") {
  const index = loadSkillsIndex(bosunHome);
  if (!index?.skills?.length) return [];

  const searchText = `${taskTitle} ${taskDescription}`.toLowerCase();
  const skillsDir = getSkillsDir(bosunHome);

  return index.skills
    .filter(({ tags }) =>
      tags.some((tag) => searchText.includes(tag)),
    )
    .map(({ filename, title, tags }) => {
      let content = "";
      try {
        content = readFileSync(resolve(skillsDir, filename), "utf8");
      } catch { /* skip unreadable files */ }
      return { filename, title, tags, content };
    })
    .filter(({ content }) => !!content);
}
