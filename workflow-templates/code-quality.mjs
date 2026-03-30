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
import { PR_QUALITY_SIGNAL_SNIPPET } from "./github.mjs";

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

const QUALITY_REPO_SCOPE_SNIPPET = [
  "const fs=require('fs');",
  "const path=require('path');",
  "const {execFileSync}=require('child_process');",
  "const MAX_PRS=Math.max(1,Number('{{maxPrs}}')||12);",
  "const REPO_SCOPE=String('{{repoScope}}'||'auto').trim();",
  "const TRUSTED_AUTHORS=new Set(String('{{trustedAuthors}}'||'').split(',').map((entry)=>entry.trim().toLowerCase()).filter(Boolean));",
  "const ALLOW_TRUSTED_FIXES=String('{{allowTrustedFixes}}'||'false').trim().toLowerCase()==='true';",
  "function runGh(args){return execFileSync('gh',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();}",
  "function parseJson(raw,fallback){try{return JSON.parse(raw||'')}catch{return fallback;}}",
  "function ghJson(args){return parseJson(runGh(args),[]);}",
  "function readLabelNames(pr){return Array.isArray(pr?.labels)?pr.labels.map((entry)=>typeof entry==='string'?entry:entry?.name).filter(Boolean):[];}",
  "function isBosunCreated(pr){return readLabelNames(pr).includes('bosun-pr-bosun-created');}",
  "function readAuthorLogin(pr){return String(pr?.author?.login||pr?.author?.name||'').trim().toLowerCase();}",
  "function configPath(){const home=String(process.env.BOSUN_HOME||process.env.BOSUN_PROJECT_DIR||'').trim();return home?path.join(home,'bosun.config.json'):path.join(process.cwd(),'bosun.config.json');}",
  "function readBosunConfig(){try{return JSON.parse(fs.readFileSync(configPath(),'utf8'));}catch{return {};}}",
  "function collectReposFromConfig(){const repos=[];try{const cfg=readBosunConfig();const workspaces=Array.isArray(cfg?.workspaces)?cfg.workspaces:[];if(workspaces.length>0){const active=String(cfg?.activeWorkspace||'').trim().toLowerCase();const activeWs=active?workspaces.find((ws)=>String(ws?.id||'').trim().toLowerCase()===active):null;const wsList=activeWs?[activeWs]:workspaces;for(const ws of wsList){for(const repo of (Array.isArray(ws?.repos)?ws.repos:[])){const slug=typeof repo==='string'?String(repo).trim():String(repo?.slug||'').trim();if(slug)repos.push(slug);}}}if(repos.length===0){for(const repo of (Array.isArray(cfg?.repos)?cfg.repos:[])){const slug=typeof repo==='string'?String(repo).trim():String(repo?.slug||'').trim();if(slug)repos.push(slug);}}}catch{}return repos;}",
  "function resolveRepoTargets(){if(REPO_SCOPE&&REPO_SCOPE!=='auto'&&REPO_SCOPE!=='current'){return [...new Set(REPO_SCOPE.split(',').map((entry)=>entry.trim()).filter(Boolean))];}if(REPO_SCOPE==='current')return [''];const fromConfig=collectReposFromConfig();if(fromConfig.length>0)return [...new Set(fromConfig)];const envRepo=String(process.env.GITHUB_REPOSITORY||'').trim();return envRepo?[envRepo]:[''];}",
  "function parseRepoFromUrl(url){const raw=String(url||'');const marker='github.com/';const idx=raw.toLowerCase().indexOf(marker);if(idx<0)return '';const tail=raw.slice(idx+marker.length).split('/');if(tail.length<2)return '';const owner=String(tail[0]||'').trim();const repo=String(tail[1]||'').trim();return owner&&repo?(owner+'/'+repo):'';}",
  "function isEligible(pr){const bosunCreated=isBosunCreated(pr);if(bosunCreated)return true;return ALLOW_TRUSTED_FIXES&&TRUSTED_AUTHORS.has(readAuthorLogin(pr));}",
].join(" ");

resetLayout();

export const PR_REVIEW_QUALITY_STRIKER_TEMPLATE = {
  id: "template-pr-review-quality-striker",
  name: "PR Review Quality Striker",
  description:
    "Reactive PR quality workflow that responds to GitHub review activity, falls back to scheduled sweeps, " +
    "pulls GitHub review comments, reviews, inline review comments, and quality-related checks, " +
    "then dispatches a constrained repair agent against actionable findings.",
  category: "maintenance",
  enabled: true,
  recommended: false,
  trigger: "trigger.pr_event",
  variables: {
    repoScope: "auto",
    maxPrs: 12,
    intervalMs: 300000,
    trustedAuthors: "",
    allowTrustedFixes: false,
  },
  nodes: [
    node("trigger", "trigger.pr_event", "PR Review Activity", {
      event: "review_requested",
      events: ["review_requested", "changes_requested", "approved", "opened"],
    }, { x: 220, y: 50 }),

    node("trigger-review-comment", "trigger.event", "PR Review Comment", {
      eventType: "github:pull_request_review_comment",
      filter: "['created','edited'].includes(String($event?.action || '').toLowerCase())",
    }, { x: 420, y: 50 }),

    node("trigger-fallback", "trigger.schedule", "Poll PR Quality Signals", {
      intervalMs: "{{intervalMs}}",
    }, { x: 620, y: 50 }),

    node("fetch-review-signals", "action.run_command", "Fetch Review Quality Signals", {
      command: "node",
      args: ["-e", [
        QUALITY_REPO_SCOPE_SNIPPET,
        PR_QUALITY_SIGNAL_SNIPPET,
        "const DIRECT_PR_NUMBER=Number('{{prNumber}}')||0;",
        "const DIRECT_PR_URL=String('{{prUrl}}'||'').trim();",
        "const DIRECT_REPO=String('{{repo}}'||'{{repoSlug}}'||'{{repository}}'||'').trim()||parseRepoFromUrl(DIRECT_PR_URL);",
        "const DIRECT_BRANCH=String('{{branch}}'||'').trim();",
        "const DIRECT_BASE=String('{{baseBranch}}'||'').trim();",
        "const DIRECT_EVENT=String('{{prEvent}}'||'').trim().toLowerCase();",
        "const actionables=[];",
        "function appendActionable(repo,prNumber,fallback,sourceKind){const number=Number(prNumber)||0;if(!repo||!number)return false;const prDigest=collectPrDigest(repo,number,fallback,runGh);if(prDigest?.core?.isDraft===true)return false;if(!isEligible({author:prDigest?.core?.author,labels:prDigest?.labels,body:prDigest?.core?.body,title:prDigest?.core?.title}))return false;const signals=collectActionableReviewSignals(prDigest);if(signals.commentFindings.length===0&&signals.qualityChecks.length===0)return false;actionables.push({repo,number,branch:String(prDigest?.core?.branch||fallback?.branch||'').trim(),base:String(prDigest?.core?.baseBranch||fallback?.base||'').trim(),url:String(prDigest?.core?.url||fallback?.url||'').trim(),title:String(prDigest?.core?.title||fallback?.title||'').trim(),sourceKind,prEvent:DIRECT_EVENT||null,commentFindings:signals.commentFindings,qualityChecks:signals.qualityChecks,sonarChecks:signals.sonarChecks,summary:signals.summary,digestSummary:prDigest.digestSummary,prDigest});return true;}",
        "let total=0;",
        "if(DIRECT_REPO&&DIRECT_PR_NUMBER>0){total=1;appendActionable(DIRECT_REPO,DIRECT_PR_NUMBER,{branch:DIRECT_BRANCH,base:DIRECT_BASE,url:DIRECT_PR_URL},'event');}else{const prs=[];for(const target of resolveRepoTargets()){const repo=String(target||'').trim();const args=['pr','list','--state','open','--json','number,title,body,author,headRefName,baseRefName,isDraft,statusCheckRollup,labels,url','--limit',String(MAX_PRS)];if(repo)args.push('--repo',repo);try{const list=ghJson(args);for(const pr of (Array.isArray(list)?list:[])){prs.push({...pr,__repo:repo||parseRepoFromUrl(pr?.url)});}}catch{}}total=prs.length;for(const pr of prs){if(pr?.isDraft===true)continue;if(!isEligible(pr))continue;const repo=String(pr?.__repo||'').trim();if(!repo)continue;if(appendActionable(repo,pr.number,{branch:pr.headRefName,base:pr.baseRefName,title:pr.title,url:pr.url},'schedule')&&actionables.length>=5)break;}}",
        "console.log(JSON.stringify({total,actionableCount:actionables.length,mode:DIRECT_REPO&&DIRECT_PR_NUMBER>0?'event':'schedule',actionables}));",
      ].join(" ")],
      continueOnError: false,
      failOnError: true,
    }, { x: 420, y: 210 }),

    node("has-review-work", "condition.expression", "Actionable Review Signals?", {
      expression:
        "(()=>{try{const raw=$ctx.getNodeOutput('fetch-review-signals')?.output||'{}';return (JSON.parse(raw).actionableCount||0)>0;}catch{return false;}})()",
    }, { x: 420, y: 370, outputs: ["yes", "no"] }),

    node("run-review-striker", "action.run_agent", "Repair PR Quality Findings", {
      sdk: "auto",
      timeoutMs: 1800000,
      prompt:
        "You are a Bosun PR quality repair agent. Work only the PRs in this JSON:\n\n" +
        "{{$ctx.getNodeOutput('fetch-review-signals')?.output}}\n\n" +
        "Each item contains prDigest with the PR body, files, issue comments, reviews, review comments, and checks. " +
        "Address only the listed commentFindings and qualityChecks on the existing PR branch. " +
        "Make the smallest safe code change, run targeted validation, and push updates to the same PR branch.\n\n" +
        "STRICT RULES:\n" +
        "- Focus on actionable review feedback and failing quality checks only.\n" +
        "- Do not create a new PR, close the PR, or perform unrelated cleanup.\n" +
        "- Prioritize commentFindings before generic lint or static-analysis cleanup.\n" +
        "- Preserve runtime behavior unless a reviewer-requested fix requires otherwise.\n" +
        "- If a check is listed but the cause is unclear, inspect the relevant file paths from prDigest.files and the referenced review comment paths before editing.",
    }, { x: 220, y: 540 }),

    node("log-review-idle", "notify.log", "No Review Work", {
      message: "PR Review Quality Striker found no actionable review or quality findings.",
      level: "info",
    }, { x: 620, y: 540 }),

    node("notify-review-run", "notify.log", "Log Review Dispatch", {
      message: "PR Review Quality Striker dispatched remediation for actionable GitHub review signals.",
      level: "info",
    }, { x: 220, y: 700 }),
  ],
  edges: [
    edge("trigger", "fetch-review-signals"),
    edge("trigger-review-comment", "fetch-review-signals"),
    edge("trigger-fallback", "fetch-review-signals"),
    edge("fetch-review-signals", "has-review-work"),
    edge("has-review-work", "run-review-striker", { condition: "$output?.result === true", port: "yes" }),
    edge("has-review-work", "log-review-idle", { condition: "$output?.result !== true", port: "no" }),
    edge("run-review-striker", "notify-review-run"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-27T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["maintenance", "github", "pr", "review", "quality", "reactive"],
  },
};

resetLayout();

export const SONARQUBE_PR_STRIKER_TEMPLATE = {
  id: "template-sonarqube-pr-striker",
  name: "SonarQube PR Striker",
  description:
    "Scheduled PR quality workflow that detects failing SonarQube or SonarCloud checks through GitHub-native " +
    "status checks, enriches them with the same compact PR digest used by Bosun's PR workflows, and dispatches " +
    "a constrained static-analysis remediation agent.",
  category: "maintenance",
  enabled: true,
  recommended: false,
  trigger: "trigger.schedule",
  variables: {
    repoScope: "auto",
    maxPrs: 12,
    intervalMs: 600000,
    trustedAuthors: "",
    allowTrustedFixes: false,
  },
  nodes: [
    node("trigger", "trigger.schedule", "Poll Sonar Signals", {
      intervalMs: "{{intervalMs}}",
    }, { x: 420, y: 50 }),

    node("fetch-sonar-signals", "action.run_command", "Fetch SonarQube Signals", {
      command: "node",
      args: ["-e", [
        QUALITY_REPO_SCOPE_SNIPPET,
        PR_QUALITY_SIGNAL_SNIPPET,
        "const prs=[];",
        "for(const target of resolveRepoTargets()){const repo=String(target||'').trim();const args=['pr','list','--state','open','--json','number,title,body,author,headRefName,baseRefName,isDraft,statusCheckRollup,labels,url','--limit',String(MAX_PRS)];if(repo)args.push('--repo',repo);try{const list=ghJson(args);for(const pr of (Array.isArray(list)?list:[])){prs.push({...pr,__repo:repo||parseRepoFromUrl(pr?.url)});}}catch{}}",
        "const actionables=[];",
        "for(const pr of prs){if(pr?.isDraft===true)continue;if(!isEligible(pr))continue;const repo=String(pr?.__repo||'').trim();if(!repo)continue;const listedChecks=Array.isArray(pr?.statusCheckRollup)?pr.statusCheckRollup:[];const hasSonarFailure=listedChecks.some((check)=>SONAR_CHECK_RE.test(String(readCheckName(check)||''))&&(QUALITY_FAIL_STATES.has(String(check?.conclusion||check?.state||'').toUpperCase())||QUALITY_FAIL_STATES.has(String(check?.bucket||'').toUpperCase())));if(!hasSonarFailure)continue;const prDigest=collectPrDigest(repo,pr.number,{branch:pr.headRefName,base:pr.baseRefName,title:pr.title,url:pr.url},runGh);const signals=collectActionableReviewSignals(prDigest);if(signals.sonarChecks.length===0)continue;actionables.push({repo,number:pr.number,branch:String(pr?.headRefName||'').trim(),base:String(pr?.baseRefName||'').trim(),url:String(pr?.url||'').trim(),title:String(pr?.title||'').trim(),sonarChecks:signals.sonarChecks,qualityChecks:signals.qualityChecks,commentFindings:signals.commentFindings,digestSummary:prDigest.digestSummary,summary:signals.summary,prDigest});if(actionables.length>=5)break;}",
        "console.log(JSON.stringify({total:prs.length,actionableCount:actionables.length,actionables}));",
      ].join(" ")],
      continueOnError: false,
      failOnError: true,
    }, { x: 420, y: 210 }),

    node("has-sonar-work", "condition.expression", "Actionable Sonar Findings?", {
      expression:
        "(()=>{try{const raw=$ctx.getNodeOutput('fetch-sonar-signals')?.output||'{}';return (JSON.parse(raw).actionableCount||0)>0;}catch{return false;}})()",
    }, { x: 420, y: 370, outputs: ["yes", "no"] }),

    node("run-sonar-striker", "action.run_agent", "Repair SonarQube Findings", {
      sdk: "auto",
      timeoutMs: 1800000,
      prompt:
        "You are a Bosun SonarQube remediation agent. Work only the PRs in this JSON:\n\n" +
        "{{$ctx.getNodeOutput('fetch-sonar-signals')?.output}}\n\n" +
        "Each item contains sonarChecks plus prDigest with files, comments, reviews, review comments, and all checks. " +
        "Fix only the listed SonarQube or SonarCloud findings on the existing PR branch, using the smallest safe code change.\n\n" +
        "STRICT RULES:\n" +
        "- Use GitHub-native Sonar checks as the source of truth for this run.\n" +
        "- Do not create a new PR or perform unrelated refactors.\n" +
        "- If reviewer comments overlap with the Sonar issue, incorporate them only when they point at the same root cause.\n" +
        "- Run targeted validation before pushing the branch update.\n" +
        "- Preserve behavior while satisfying the static-analysis requirement.",
    }, { x: 220, y: 540 }),

    node("log-sonar-idle", "notify.log", "No Sonar Work", {
      message: "SonarQube PR Striker found no actionable SonarQube or SonarCloud failures.",
      level: "info",
    }, { x: 620, y: 540 }),

    node("notify-sonar-run", "notify.log", "Log Sonar Dispatch", {
      message: "SonarQube PR Striker dispatched remediation for Sonar-native quality failures.",
      level: "info",
    }, { x: 220, y: 700 }),
  ],
  edges: [
    edge("trigger", "fetch-sonar-signals"),
    edge("fetch-sonar-signals", "has-sonar-work"),
    edge("has-sonar-work", "run-sonar-striker", { condition: "$output?.result === true", port: "yes" }),
    edge("has-sonar-work", "log-sonar-idle", { condition: "$output?.result !== true", port: "no" }),
    edge("run-sonar-striker", "notify-sonar-run"),
  ],
  metadata: {
    author: "bosun",
    version: 1,
    createdAt: "2026-03-27T00:00:00Z",
    templateVersion: "1.0.0",
    tags: ["maintenance", "sonarqube", "sonarcloud", "pr", "quality"],
  },
};
