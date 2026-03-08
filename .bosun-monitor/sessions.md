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
