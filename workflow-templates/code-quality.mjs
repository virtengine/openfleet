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
    branch: "chore/code-quality-striker",
    baseBranch: "main",
    sessionLogPath: ".bosun-monitor/code-quality-striker.md",
    maxFilesPerSession: 6,           // keep PRs reviewable; prevents mega-diffs
    minFileSizeKb: 30,               // only target files worth splitting
    testCommand: "npm test",
    buildCommand: "npm run build",
    syntaxCheckCommand: "node --check",
    lintCommand: "",
    sourceExtensions: ".mjs,.js,.ts,.tsx,.py,.go,.rs,.java,.cs,.rb,.php",
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
      // List source files outside node_modules/.cache sorted by size.
      // Uses configurable sourceExtensions to support any language.
      // Output: newline-separated relative paths.
      command: "node -e \"const{readdirSync,statSync}=require('fs');const{join,relative}=require('path');const base=process.cwd();const exts=new Set('{{sourceExtensions}}'.split(',').map(e=>e.trim()));function walk(d){const out=[];for(const f of readdirSync(d,{withFileTypes:true})){if(f.name==='node_modules'||f.name==='.cache'||f.name==='.git'||f.name==='worktrees'||f.name==='__pycache__'||f.name==='.venv'||f.name==='target'||f.name==='vendor'||f.name==='dist'||f.name==='build')continue;const p=join(d,f.name);if(f.isDirectory())out.push(...walk(p));else{const ext='.'+f.name.split('.').pop();if(exts.has(ext)){const s=statSync(p);out.push({p,kb:Math.round(s.size/1024)})}}}return out}const files=walk(base).filter(x=>x.kb>={{minFileSizeKb}}).sort((a,b)=>b.kb-a.kb).slice(0,20);console.log(files.map(x=>x.kb+'kb\\t'+relative(base,x.p)).join('\\n'))\"",
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

# 2. Lint check (if configured)
{{lintCommand}}

# 3. Full test suite — must be 0 failures, 0 unexpected skips
{{testCommand}}

# 4. Build — must pass clean
{{buildCommand}}
\`\`\`

If tests fail, **revert your change** (\`git checkout -- <file>\`) and either:
- Attempt a smaller, safer split of the same file, OR
- Move to a different target file

**Never push a failing test suite.**

### Step 5 — Commit, push, and open the PR

Branch name: \`{{branch}}\`
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

**Session**: {{branch}}
**Scope**: structural refactor only — zero functional changes

### Changes
- <bullet per extracted module or dedup>

### Validation
- \`{{syntaxCheckCommand}}\` passed on all touched files
- \`{{testCommand}}\` passed (N tests)
- \`{{buildCommand}}\` passed

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
  - \`{{syntaxCheckCommand}}\` passed on all touched files
  - \`{{testCommand}}\` passed (N tests)
  - \`{{buildCommand}}\` passed
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
    node("verify-tests", "validation.tests", "Verify — Tests", {
      command: "{{testCommand}}",
    }, { x: 200, y: 610 }),

    node("verify-build", "validation.build", "Verify — Build", {
      command: "{{buildCommand}}",
      zeroWarnings: false,
    }, { x: 600, y: 610 }),

    // ── 6. Both passed? ────────────────────────────────────────────────────
    node("check-validation", "condition.expression", "Validation Passed?", {
      expression: "$ctx.getNodeOutput('verify-tests')?.success === true && $ctx.getNodeOutput('verify-build')?.success === true",
    }, { x: 400, y: 750, outputs: ["yes", "no"] }),

    // ── 7a. Create PR ──────────────────────────────────────────────────────
    node("create-pr", "action.create_pr", "Open Quality PR", {
      title: "refactor: code quality pass",
      body: "## Summary\n\nAutomated code-quality session. Structural refactor only — zero functional changes.\n\nSee `.bosun-monitor/code-quality-striker.md` for session details.",
      branch: "{{branch}}",
      baseBranch: "{{baseBranch}}",
      labels: ["refactor", "code-quality", "automated"],
    }, { x: 200, y: 890 }),

    node("notify-success", "notify.telegram", "Notify PR Opened", {
      message: ":check: Code quality striker session complete.\nPR opened: **{{branch}}**",
      silent: true,
    }, { x: 200, y: 1030 }),

    // ── 7b. Validation failed — notify and abort ───────────────────────────
    node("notify-failure", "notify.telegram", "Notify — Validation Failed", {
      message: ":alert: Code quality striker **validation failed**.\n\nThe agent produced changes that broke tests or build. No PR was created.\nCheck `.bosun-monitor/code-quality-striker.md` for details.",
    }, { x: 600, y: 890 }),

    node("log-failure", "notify.log", "Log Failure", {
      message: "Code quality striker validation failed — no PR created.",
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

// ═══════════════════════════════════════════════════════════════════════════
//  PR Review Quality Striker
//  Fires on review events + review comments + scheduled fallback.
//  Collects PR signals, runs a focused review agent, comments findings.
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const PR_REVIEW_QUALITY_STRIKER_TEMPLATE = {
  id: "template-pr-review-quality-striker",
  name: "PR Review Quality Striker",
  description:
    "Reactive PR review agent. Fires on review_requested events, review " +
    "comment events, and a scheduled fallback. Collects PR digest + review " +
    "signals, runs a quality-review agent, and comments actionable findings.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.pr_event",
  variables: {
    intervalMs: 1800000,
    maxPrsPerRun: 5,
    timeoutMs: 1800000,
  },
  nodes: [
    node("trigger", "trigger.pr_event", "PR Review Requested", {
      event: "review_requested",
      events: ["review_requested", "changes_requested", "approved", "opened"],
    }, { x: 200, y: 50 }),

    node("trigger-review-comment", "trigger.event", "Review Comment Posted", {
      eventType: "github:pull_request_review_comment",
    }, { x: 500, y: 50 }),

    node("trigger-fallback", "trigger.schedule", "Scheduled Fallback", {
      intervalMs: "{{intervalMs}}",
    }, { x: 800, y: 50 }),

    node("fetch-review-signals", "action.run_command", "Fetch PR Review Signals", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const DIRECT_REPO=String(process.env.DIRECT_REPO||'').trim();",
        "const DIRECT_PR_NUMBER=Number(process.env.DIRECT_PR_NUMBER||0);",
        "const DIRECT_PR_URL=String(process.env.DIRECT_PR_URL||'').trim();",
        "const DIRECT_EVENT=String(process.env.DIRECT_EVENT||'').trim();",
        "const sourceKind=DIRECT_REPO&&DIRECT_PR_NUMBER>0?'event':'schedule';",
        "function ghJson(args){try{const o=execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();return o?JSON.parse(o):[];}catch{return [];}}",
        "function collectPrDigest(repo,n){",
        "  const core=ghJson(['pr','view',String(n),'--repo',repo,'--json','number,title,body,headRefName,baseRefName,mergeable,url,labels,state,author,createdAt']);",
        "  const files=ghJson(['pr','view',String(n),'--repo',repo,'--json','files','--jq','.files']);",
        "  const checks=ghJson(['pr','checks',String(n),'--repo',repo,'--json','name,state,bucket']);",
        "  return {core:core||{},files:Array.isArray(files)?files:[],checks:Array.isArray(checks)?checks:[]};",
        "}",
        "function collectActionableReviewSignals(repo,n){",
        "  const reviews=ghJson(['pr','view',String(n),'--repo',repo,'--json','reviews','--jq','.reviews']);",
        "  const reviewComments=ghJson(['pr','view',String(n),'--repo',repo,'--json','reviewDecision']);",
        "  return {reviews:Array.isArray(reviews)?reviews:[],reviewComments:[]};",
        "}",
        "function appendActionable(signals,digest){",
        "  return {...signals,digest};",
        "}",
        "let results=[];",
        "if(sourceKind==='event'&&DIRECT_REPO&&DIRECT_PR_NUMBER>0){",
        "  const digest=collectPrDigest(DIRECT_REPO,DIRECT_PR_NUMBER);",
        "  const signals=collectActionableReviewSignals(DIRECT_REPO,DIRECT_PR_NUMBER);",
        "  const commentFindings=[];",
        "  const qualityChecks=[];",
        "  results=[appendActionable({repo:DIRECT_REPO,number:DIRECT_PR_NUMBER,url:DIRECT_PR_URL,event:DIRECT_EVENT,commentFindings,qualityChecks,sourceKind,mode:DIRECT_REPO&&DIRECT_PR_NUMBER>0?'event':'schedule'},digest)];",
        "}else{",
        "  const commentFindings=[];",
        "  const qualityChecks=[];",
        "  results=[{repo:'',number:0,url:'',event:'schedule',commentFindings,qualityChecks,sourceKind,mode:DIRECT_REPO&&DIRECT_PR_NUMBER>0?'event':'schedule'}];",
        "}",
        "process.stdout.write(JSON.stringify({prs:results,count:results.length}));",
      ].join(" ")],
      parseJson: true,
      continueOnError: true,
      timeoutMs: 120000,
      env: {
        DIRECT_REPO:      "{{$data?.prRepo || $data?.repo || ''}}",
        DIRECT_PR_NUMBER: "{{$data?.prNumber || $data?.number || 0}}",
        DIRECT_PR_URL:    "{{$data?.prUrl || $data?.url || ''}}",
        DIRECT_EVENT:     "{{$data?.action || $data?.event || ''}}",
        MAX_PRS_PER_RUN:  "{{maxPrsPerRun}}",
      },
    }, { x: 500, y: 180 }),

    node("run-review-striker", "action.run_agent", "Run Review Quality Agent", {
      prompt:
        "You are a PR review quality agent. Analyse the PR review signals and produce " +
        "actionable quality findings.\n\n" +
        "Input data: commentFindings and qualityChecks from fetch-review-signals output.\n" +
        "PR context: prDigest with the PR body, files, issue comments, reviews, review comments, and checks.\n\n" +
        "For each finding: explain what is wrong, why it matters, and how to fix it. " +
        "Post findings as a single review comment on the PR.",
      sdk: "auto",
      timeoutMs: "{{timeoutMs}}",
      failOnError: false,
      continueOnError: true,
    }, { x: 500, y: 360 }),

    node("notify-done", "notify.log", "Review Strike Complete", {
      message: "PR review quality striker finished for PR #{{$data?.prNumber || 0}}",
      level: "info",
    }, { x: 500, y: 500 }),
  ],
  edges: [
    edge("trigger",               "fetch-review-signals"),
    edge("trigger-review-comment","fetch-review-signals"),
    edge("trigger-fallback",      "fetch-review-signals"),
    edge("fetch-review-signals",  "run-review-striker"),
    edge("run-review-striker",    "notify-done"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-31T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "review", "quality", "striker", "reactive"],
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//  SonarQube PR Striker
//  Uses GitHub-native Sonar check results (not the SonarQube API).
// ═══════════════════════════════════════════════════════════════════════════

resetLayout();

export const SONARQUBE_PR_STRIKER_TEMPLATE = {
  id: "template-sonarqube-pr-striker",
  name: "SonarQube PR Striker",
  description:
    "Monitors open PRs for SonarQube quality-gate failures using GitHub-native " +
    "check results. Does NOT call the SonarQube API. Collects PR digest and " +
    "sonarChecks, then runs a focused repair agent.",
  category: "github",
  enabled: true,
  recommended: true,
  trigger: "trigger.schedule",
  variables: {
    intervalMs: 1800000,
    maxPrsPerRun: 3,
    timeoutMs: 3600000,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Every 30 min", {
      intervalMs: "{{intervalMs}}",
    }, { x: 400, y: 50 }),

    node("fetch-sonar-signals", "action.run_command", "Fetch Sonar PR Signals", {
      command: "node",
      args: ["-e", [
        "const {execFileSync}=require('child_process');",
        "const SONAR_CHECK_RE=/sonar/i;",
        "function ghJson(args){try{const o=execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();return o?JSON.parse(o):[];}catch{return [];}}",
        "function collectPrDigest(repo,n){",
        "  const core=ghJson(['pr','view',String(n),'--repo',repo,'--json','number,title,body,headRefName,baseRefName,url,labels,state,author']);",
        "  const files=ghJson(['pr','view',String(n),'--repo',repo,'--json','files','--jq','.files']);",
        "  const checks=ghJson(['pr','checks',String(n),'--repo',repo,'--json','name,state,bucket']);",
        "  return {core:core||{},files:Array.isArray(files)?files:[],checks:Array.isArray(checks)?checks:[]};",
        "}",
        "function collectActionableReviewSignals(repo,n){",
        "  const reviews=ghJson(['pr','view',String(n),'--repo',repo,'--json','reviews','--jq','.reviews']);",
        "  return {reviews:Array.isArray(reviews)?reviews:[],reviewComments:[]};",
        "}",
        "const repo=String(process.env.BOSUN_REPO||'').trim();",
        "if(!repo){process.stdout.write(JSON.stringify({prs:[],count:0}));process.exit(0);}",
        "const prs=ghJson(['pr','list','--repo',repo,'--state','open','--json','number,headRefName,url','--limit','20']);",
        "const results=[];",
        "for(const pr of (Array.isArray(prs)?prs:[])){",
        "  const digest=collectPrDigest(repo,pr.number);",
        "  const signals=collectActionableReviewSignals(repo,pr.number);",
        "  const sonarChecks=Array.isArray(digest.checks)?digest.checks.filter(c=>SONAR_CHECK_RE.test(c.name||'')):[];",
        "  const hasSonarFailure=sonarChecks.some(c=>['FAILURE','ERROR','TIMED_OUT','CANCELLED'].includes(String(c.state||'').toUpperCase()));",
        "  if(!hasSonarFailure){",
        "    if(signals.sonarChecks&&signals.sonarChecks.length===0)continue;",
        "    continue;",
        "  }",
        "  const digestSummary={total:digest.checks.length,sonarFailing:sonarChecks.filter(c=>['FAILURE','ERROR'].includes(String(c.state||'').toUpperCase())).length};",
        "  results.push({repo,number:pr.number,url:pr.url,branch:pr.headRefName,sonarChecks,hasSonarFailure,digest,digestSummary,reviews:signals.reviews});",
        "}",
        "process.stdout.write(JSON.stringify({prs:results,count:results.length}));",
      ].join(" ")],
      parseJson: true,
      continueOnError: true,
      timeoutMs: 180000,
      env: {
        BOSUN_REPO: "{{$data?.repo || ''}}",
        MAX_PRS_PER_RUN: "{{maxPrsPerRun}}",
      },
    }, { x: 400, y: 180 }),

    node("has-sonar-failures", "condition.expression", "Any Sonar Failures?", {
      expression: "Number($ctx.getNodeOutput('fetch-sonar-signals')?.prs?.length || 0) > 0",
    }, { x: 400, y: 320, outputs: ["yes", "no"] }),

    node("run-sonar-striker", "action.run_agent", "Fix SonarQube Failures", {
      prompt:
        "You are a PR repair agent for Sonar quality-gate failures. Use GitHub-native Sonar checks as the source of truth. " +
        "Do NOT call any external quality API directly.\n\n" +
        "Input: sonarChecks plus prDigest for each failing PR.\n" +
        "For each PR with sonar failures: check out the branch, fix the issues, run tests, push fixes.",
      sdk: "auto",
      timeoutMs: "{{timeoutMs}}",
      failOnError: false,
      continueOnError: true,
    }, { x: 400, y: 450 }),

    node("skip-no-failures", "notify.log", "No Sonar Failures", {
      message: "SonarQube PR striker: no open PRs with Sonar failures",
      level: "info",
    }, { x: 700, y: 320 }),

    node("notify-done", "notify.log", "Sonar Strike Complete", {
      message: "SonarQube PR striker finished",
      level: "info",
    }, { x: 400, y: 590 }),
  ],
  edges: [
    edge("trigger",              "fetch-sonar-signals"),
    edge("fetch-sonar-signals",  "has-sonar-failures"),
    edge("has-sonar-failures",   "run-sonar-striker",  { condition: "$output?.result === true", port: "yes" }),
    edge("has-sonar-failures",   "skip-no-failures",   { condition: "$output?.result !== true", port: "no" }),
    edge("run-sonar-striker",    "notify-done"),
    edge("skip-no-failures",     "notify-done"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-31T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["github", "pr", "sonarqube", "quality", "striker", "scheduled"],
  },
};
