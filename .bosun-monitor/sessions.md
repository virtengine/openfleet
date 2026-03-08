# Bosun Monitor Sessions

## 2026-03-08T20:07:32+11:00
- Context: Continued hourly check-running-bosun-environment after handoff with fix commit be8e31f in PR #144.
- Actions:
  - Verified PR #144 checks and merged PR #144 into main (merge commit bd496fd8d556bfd5401734e1c87394ab2bceab4a).
  - Restarted source daemon via node cli.mjs --terminate then node cli.mjs --daemon --no-update-check.
  - Confirmed daemon process command line uses repo source CLI (.../bosun/cli.mjs --daemon-child).
  - Switched local branch back to monitor/bosun-env-stability, fast-forwarded to merged main, pushed branch.
- Runtime validation:
  - AppData runtime workspace HEAD matches source HEAD (bd496fd...).
  - Scheduler active with minute-level polls and workflow completions.
  - task stats: draft 48, todo 7, inprogress 6, inreview 6, done 2, blocked 0.
  - No new post-restart Worktree creation failed / invalid reference / No commits between origin/main errors observed.
  - Task 44ff8df7-... moved to inprogress and did not flap back to todo during observation window.
- Outstanding non-fatal signals:
  - Historical stuck_agent: undefined alerts remain in old log history (no new post-restart sample in this short window).
  - watch-path fallback warning for ve-orchestrator.ps1 persists.

## 2026-03-08T21:07:52+11:00
- Context: Hourly health pass for source-run Bosun on `monitor/bosun-env-stability`.
- Findings before action:
  - Branch had pre-existing dirty files not touched in this run (`server/ui-server.mjs`, `tests/ui-server.test.mjs`, `ui/components/kanban-board.js`, `ui/styles/kanban.css`, `ui/tabs/tasks.js`).
  - Runtime was active but not in daemon mode: `node cli.mjs --daemon-status` reported "not running in daemon mode, but 2 bosun process(es) are active".
  - Runtime/config root mismatch was present again (`node cli.mjs --where` resolved to `C:\Users\jON\AppData\Roaming\bosun`).
- Operational fix applied:
  - Performed controlled restart from source with explicit local runtime roots:
    - `node cli.mjs --terminate`
    - `node cli.mjs --daemon --no-update-check --config-dir .bosun --repo-root C:\Users\jON\Documents\source\repos\virtengine-gh\bosun`
- Post-fix validation:
  - Daemon now healthy: `node cli.mjs --daemon-status` => running (PID 26648).
  - Process command lines now include `--config-dir .bosun --repo-root ... --daemon-child` for both `cli.mjs` and `infra/monitor.mjs`.
  - Runtime activity shifted to repo-local workflow index:
    - `.bosun/workflow-runs/index.json` advancing (21:06:55 local latest).
    - AppData index stopped advancing at pre-restart timestamp (21:02:54 local), confirming source-local takeover.
  - Recent workflow runs continue at 1-minute cadence (Task Planner / Agent Session Monitor / Task trace workflow).
- Current status:
  - Source daemon mode restored and healthy with repo-local config routing.
  - No code changes in this session; operational remediation only.

## 2026-03-08T22:30:48+11:00
- Context: Hourly health check for source-run Bosun on monitor/bosun-env-stability with workflow dispatch stall investigation.
- Findings before fix:
  - Daemon/monitor were running from source (cli.mjs + infra/monitor.mjs) with .bosun config, schedule poll alive.
  - Runtime runs were mostly limited to Task Planner, Agent Session Monitor, and Task trace workflow; core dispatch workflows (Task Lifecycle, Task Batch Processor) were absent.
  - Root causes:
    1) Source bug: workflow setup profile lookup lowercased IDs but profile map key was camelCase (workflowFirst), causing fallback to alanced.
    2) Runtime selection state lacked lifecycle templates in installed set.
- Code fix shipped:
  - Commit 7ca5be (ix(workflow): honor workflowFirst profile selection) merged via PR #153.
  - Files: workflow/workflow-templates.mjs, 	ests/workflow-templates.test.mjs.
  - Validation passed: targeted workflow test, full 
pm test, 
pm run build, 
pm run prepush:check, push hook targeted suite.
- Runtime remediation after merge:
  - Installed workflow-first template set into local .bosun store and restarted daemon from source.
  - Verified last run window now includes Task Lifecycle, Task Batch Processor, Task Batch → PR, and GitHub ↔ Kanban Sync alongside planner/monitor loops.
- Current status:
  - Daemon healthy and source-based.
  - Workflow dispatch path restored (no longer planner-only).

## 2026-03-08T23:06:58+11:00
- Context: Hourly health pass for source-run Bosun on monitor/bosun-env-stability.
- Branch/runtime baseline:
  - Branch: monitor/bosun-env-stability with pre-existing dirty working tree (infra/sync-engine.mjs, kanban/kanban-adapter.mjs, tests/kanban-adapter.test.mjs) untouched in this run.
  - Package version: 0.40.3.
  - Daemon status healthy: node cli.mjs --daemon-status => running (PID 24568), with monitor child PID 37952 and active codex worker PID 23868.
- Health evidence:
  - Source-local workflow index is advancing: .bosun/workflow-runs/index.json and _active-runs.json mtime advanced during observation windows and now at 2026-03-08T12:05:57Z.
  - Active workflows present (not idle): Task Lifecycle (fcc7bd40-...) and Task Planner (3b5fd20b-...).
  - Recent completed workflows include Agent Session Monitor, GitHub <-> Kanban Sync, Task Batch Processor, and Task Batch -> PR with errorCount=0.
  - Task claims are active in .cache/bosun/task-claims.json (tasks 161, 171, TASK-1 claimed).
  - Backlog is non-empty (no need to seed additional tasks this run).
- Notable observations:
  - node cli.mjs --where without flags still points to AppData, but daemon command line confirms source-local --config-dir .bosun --repo-root ... for the active runtime.
  - .bosun/logs/monitor.log is stale compared with workflow-run telemetry; workflow-run files currently provide the reliable liveness signal.
- Outcome:
  - Status: healthy.
  - No code or config changes applied this hour; no restart required because workflows are actively executing and state remains internally consistent.

## 2026-03-08T23:18:40+11:00
- Context: User-reported incident: workspace modal empty, tasks unavailable, and low confidence in PR throughput despite scheduler liveness.
- Symptom verified:
  - UI/CLI workspace list returned empty (No workspaces configured).
  - Source-local task file existed but appeared empty in prior checks due parser mismatch assumptions.
- Root cause:
  - .bosun/bosun.config.json had a UTF-8 BOM prefix (charCode 65279). workspace-manager uses JSON.parse(readFileSync(...)) without BOM stripping, so config parsing failed and workspace list collapsed to empty.
- Remediation performed:
  - Rewrote .bosun/bosun.config.json without BOM and verified parse success (irst-char-code 123, json-parse-ok).
  - Repaired source-local workspace config to include active irtengine-gh workspace and local repo mappings.
  - Reseeded .bosun/.cache/kanban-state.json from existing runtime store and validated 80 tasks present (draft 36, todo 27, inprogress 9, inreview 6, done 2).
  - Restarted source daemon with explicit local roots (--config-dir .bosun --repo-root ...) and verified monitor/workflow activity resumed.
- Post-fix evidence:
  - 
ode cli.mjs --config-dir .bosun --workspace-list now returns workspace irtengine-gh (active).
  - .bosun/workflow-runs/index.json continues advancing with Task Lifecycle / Task Batch Processor / Task Batch -> PR runs.
  - Recent merged PRs include #172, #153, #145 during this monitoring window.
- Notes:
  - CLI workspace-list marks repo paths as ✗ because it only checks $BOSUN_DIR/workspaces/<id>/<repo> when no explicit epoRoot is passed; server path resolution uses epoRoot and remains operational.

## 2026-03-08T23:19:43+11:00
- Context: Follow-up on empty GitHub issue spam and planner inconsistency after PR #172.
- PR/merge state:
  - PR #172 merged to main at 2026-03-08T12:12:21Z (commit 9351be6ad343e53cad302781ec0fe200ba9bb7ac).
  - Active branch monitor/bosun-env-stability fast-forwarded with origin/main.
- Runtime investigation:
  - Initial mismatch observed: workflow trigger nodes reported 	odoCount=0 while 
ode cli.mjs task stats showed 	odo=27.
  - Workflow run evidence (Task Planner / Task Batch Processor) showed trigger using zero-count backlog.
- Root cause:
  - Repo-root .env still had KANBAN_BACKEND=github; monitor bootstrap read that source, so scheduler/workflow trigger queries were hitting GitHub while local task CLI read internal store.
- Fix applied:
  - Updated repo-root .env to KANBAN_BACKEND=internal (aligning with .bosun/.env).
  - Restarted source runtime with explicit local routing: 
ode cli.mjs --terminate then 
ode cli.mjs --daemon --no-update-check --config-dir .bosun --repo-root ....
- Post-fix validation:
  - Daemon healthy: 
ode cli.mjs --daemon-status => running.
  - Latest runs now consistent:
    - Task Planner trigger: {"triggered":false,"todoCount":27,"threshold":3}
    - Task Batch Processor trigger: {"triggered":false,"todoCount":27,"threshold":3}
  - Local task stats remain: draft 36 / todo 27 / inprogress 9 / inreview 6 / done 2 / blocked 0.
  - No open GitHub issues titled New task.
- Outcome: issue source identified and corrected; planner now reads internal backlog consistently, and issue-spam path is contained by both config and code guards.

## 2026-03-08T23:45:39+11:00
- Context: User reported Telegram live digest uncaught exception: pollWorkflowSchedulesOnce is not defined around 23:13/23:15 local.
- Root cause:
  - pollWorkflowSchedulesOnce was declared inside an earlier if (!isMonitorTestRuntime) block in infra/monitor.mjs.
  - Startup calls in a later block (oid pollWorkflowSchedulesOnce("startup", ...)) executed out of scope, triggering ReferenceError and recovery loops.
- Fix:
  - Hoisted schedule-poll helper to shared module scope via placeholder + assignment form.
  - Added regression guard in 	ests/monitor-workflow-startup-guards.test.mjs ensuring helper is defined before startup invocations.
  - Commit: 5b92f65 on monitor/bosun-env-stability.
- Validation:
  - Targeted: 
pm test -- tests/monitor-workflow-startup-guards.test.mjs tests/workflow-engine.test.mjs (pass).
  - Full gates: 
pm run build (pass), 
pm run prepush:check (pass, includes full 
pm test).
  - PR: #173 merged to main at 2026-03-08T12:42:22Z (merge commit 8f2bee69e651b3d3390dde15fc514a8cfe11e89).
- Runtime post-merge:
  - Restarted source daemon from repo (
ode cli.mjs --daemon --config-dir .bosun --repo-root ...).
  - Daemon healthy, schedule runs advancing, and no new pollWorkflowSchedulesOnce is not defined entries in .bosun/logs/monitor-error.log after restart window.
- Note:
  - Unexpected unstaged local changes appeared in package.json and package-lock.json during this run (not authored by this fix). Left untouched pending user direction.

## 2026-03-09T00:11:01+11:00
- Context: Continued incident triage for task-board disappear bug, DAG insertBefore crash, and unexpected GitHub `New task` issue creation.
- Findings:
  - Confirmed DAG render instability fix is staged in `ui/tabs/tasks.js` + `site/ui/tabs/tasks.js` with regression test `tests/tasks-dag-render-stability.test.mjs`.
  - Confirmed source runtime previously processed GitHub tasks titled `New task` (e.g., task/issue 161 in workflow run `51fccc8c-0bb4-4cd9-9470-9e4b279bb46a`).
  - Root cause for backend drift identified in config loading: explicit `--config-dir .bosun` still loaded repo-root `.env` and could override `KANBAN_BACKEND`.
- Fix implemented (local, uncommitted at this checkpoint):
  - `config/config.mjs`: when config-dir/BOSUN_HOME is explicit, repo-root `.env` is no longer loaded by default; opt-in override via `BOSUN_LOAD_REPO_ENV_WITH_EXPLICIT_CONFIG=1`.
  - Added regression test: `tests/config-explicit-config-dir-env-isolation.test.mjs`.
  - Version bumped to `0.40.7` after validation.
- Validation:
  - Targeted suites passed (DAG/config/ui-server).
  - `npm test` and `npm run build` passed.
  - `npm run prepush:check` passed once after re-run; later run failed due unrelated concurrent file edits in other modules.
- Blocker:
  - New unexpected concurrent modifications appeared mid-run (`ui/modules/mui.js`, `workflow-templates/task-batch.mjs`, `tests/workflow-templates.test.mjs`, plus pre-existing unrelated edits). Paused before commit/push to avoid shipping mixed changes without user direction.

## 2026-03-09T00:33:14+11:00
- Context: Hourly source-run health check on `monitor/bosun-env-stability` focused on workflow/task throughput.
- Baseline:
  - Branch confirmed `monitor/bosun-env-stability`; package version observed `0.40.6` at start, dirty tracked files already present (`server/ui-server.mjs`, `site/ui/tabs/tasks.js`, `tests/ui-server.test.mjs`, `ui/tabs/agents.js`, `ui/tabs/tasks.js`, `tests/tasks-dag-render-stability.test.mjs`).
  - Source daemon processes were running with `--config-dir .bosun --repo-root ...`.
- Findings and fixes:
  - Detected workflow throughput regression: `Task Batch Processor` and `Task Batch -> PR` repeatedly skipped with large todo backlog due `trigger.task_low` wiring in runtime definitions.
  - Runtime remediation applied: switched `.bosun/workflows/fcd7047d-...` and `.bosun/workflows/6d793c82-...` trigger nodes/workflow trigger to `trigger.task_available` (`Tasks Available?`, `pollIntervalMs=60000`, `maxParallel={{maxConcurrent}}`).
  - Startup blocker found: `.bosun/.env` lacked `WORKFLOW_AUTOMATION_ENABLED=true`; source startup could come up with workflow automation disabled. Added explicit flag.
  - Verified source startup in foreground after env fix now logs `workflows automation enabled` and executes startup schedule runs for task workflows.
- Runtime state at end of run:
  - Daemon and monitor active from source (`cli.mjs` PID 53752, `infra/monitor.mjs` PID 44108).
  - `.bosun/workflow-runs/index.json` advanced to `00:31:01+11:00`.
  - Latest runs include `Agent Session Monitor` and `Task trace workflow`; task-batch/planner runs still not recurring at 1-min cadence after the startup burst and need follow-up tuning/diagnosis.
- Outstanding risk:
  - Planner startup run `19e3f239-...` failed (`Agent pool or planner prompt not available` -> no materialized tasks), and autonomous throughput remains below expected PR velocity.

## 2026-03-09T01:19:06.7717691+11:00
- Context: Hourly Bosun source-run health check on branch monitor/bosun-env-stability.
- Initial incident: daemon/process mode inconsistent (AppData config active), source-local workflow telemetry stale, and workflow scheduler produced frozen active runs.
- Root causes observed:
  - Startup without explicit local routing can resolve to AppData config/log paths.
  - Task Planner failures were caused by planner context mismatch (Agent pool or planner prompt not available) and missing workspace-mirror kanban cache (	odoCount=0 despite backlog).
- Remediation this run:
  - Restarted from source using explicit local paths: 
pm run start -- --daemon --no-update-check --config-dir C:\Users\jON\Documents\source\repos\virtengine-gh\bosun\.bosun --repo-root C:\Users\jON\Documents\source\repos\virtengine-gh\bosun.
  - Normalized planner prompt path to absolute source path in both .env and .bosun/.env.
  - Seeded workspace-mirror cache file at .bosun/workspaces/virtengine-gh/bosun/.bosun/.cache/kanban-state.json to remove false zero-todo planner trigger failures.
- Post-fix verification:
  - 
ode cli.mjs --daemon-status (with explicit local config) reports running.
  - Workflow runs resumed at 1-minute cadence (Task Lifecycle, Task Batch Processor, Task Batch → PR, Task Replenish).
  - Task Planner transitioned from repeated failures to completed status on latest observed cycle.
  - One active long-running Task Lifecycle run remains expected; no frozen active-run pair after remediation.
- Residual risk:
  - Task stats CLI (80 tasks) and planner trigger store can still diverge depending on which runtime store is queried; monitor in next run and consider code-level store-path unification if divergence recurs.
