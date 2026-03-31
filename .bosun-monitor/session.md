# Session 2026-04-01

- Continued Bosun UI and pipeline stabilization on `bosun/codex-self-improvement-loop-commits`.
- Verified source fixes with focused tests plus `npm run build`.
- Fixed source and installed runtime templates for `template-pr-fix-single` and `template-pr-security-fix-single` to prefer `prDigest.core.branch` over `item.branch`.
- Confirmed historical workflow run history still shows older `task/...` clone failures, but those are pre-repair runs.
- Found current operational blockers:
  - `Task Batch Processor` is live but ends every cycle with `0/0 succeeded`; repo-local task stats still show backlog (`todo=16`, `inprogress=4`, `done=104`).
  - `/api/workflows/template-updates` fails in live UI server with `workflows is not iterable`.
  - worker-backed `WorkflowEngineProxy` is the likely cause for template-updates failure because UI server reconcile paths assume synchronous `engine.list()`.
  - Task Batch template uses `itemVariable` but `loop.for_each` reads `variable`, so child workflow item binding is wrong.
- Live runtime evidence:
  - `/api/health` returned OK from `https://192.168.0.183:4400`.
  - daemon log shows repeated `Task batch completed: 0/0 succeeded (0 failed)`.
  - daemon log also shows `/api/workflows/template-updates` 500 with `workflows is not iterable`.
- Next concrete actions:
  1. patch UI server template-update/bootstrap reconcile paths to be proxy-safe (`await engine.list()` and skip sync reconcile against proxies).
  2. patch Task Batch template to use `variable: "currentTask"`.
  3. retest, restart daemon, and verify new batch runs dispatch non-zero items.
- Follow-up on 2026-04-01:
  - UI server proxy-safe template-updates fix is now in place and `/api/workflows/template-updates` recovered.
  - Task Batch still showed `0/0` after the `variable` fix alone; current root cause is store-context drift inside `query-tasks`.
  - Narrow fix applied in source: both Task Batch `query-tasks` commands now set `process.env.REPO_ROOT`, set `process.env.BOSUN_STORE_PATH` to the repo-local `.bosun/.cache/kanban-state.json`, and pin `cwd: "{{repoRoot}}"` before importing `kanban-adapter`.
  - Added template regressions to lock the repo/store context wiring for both `template-task-batch-processor` and `template-task-batch-pr`.
- Follow-up on 2026-04-01 (blocked-task diagnostics + live UI/API stability):
  - Added bounded `/api/tasks` workflow-run enrichment in `server/ui-server.mjs` so blocked list rows stay fast while still pulling shallow workflow-run evidence; deep run-detail/trace expansion remains on `/api/tasks/detail`.
  - Focused validation passed after the patch: `npm test -- tests/ui-server.test.mjs` (`113 tests`) and `npm run build`.
  - Restarted the Bosun daemon onto the patched source checkout with pinned roots; current daemon PID is `53868` and `/api/health` returned `ok=true`.
  - Live `/api/tasks?status=blocked&pageSize=5` now returns successfully again inside the 20s local cap; prior hanging list-route behavior is resolved.
  - Exact blocked-task follow-up for `4a445fa4-7323-4abb-aeeb-311cc0782e9d`:
    - `/api/tasks/detail?taskId=...&includeWorkflowRuns=0` succeeds.
    - Full detail with workflow-run expansion still times out at 20s for this task.
    - Current live blocked-context classification remains generic `blocked` with `worktreeFailureCount=0`, `workflowRunEvidence=[]`, `logEvidence=[]`.
    - Direct workflow-run artifact scans show real `worktreeFailure` metadata exists for other tasks, but no persisted task-specific worktree-failure evidence was confirmed for `4a445fa4...`; current stored evidence for that task is dominated by repeated pre-PR-validation failures and `inprogress -> blocked` transitions.
  - Current throughput snapshot after restart: `draft=45`, `todo=12`, `inprogress=8`, `done=104`, `blocked=10` from pinned `node cli.mjs task stats --config-dir .bosun --repo-root .`.
  - Next concrete actions:
    1. continue Playwright sweep across remaining tabs/workflows on the patched live daemon.
    2. inspect why full `/api/tasks/detail` workflow-run expansion is still heavy for some blocked tasks even when list-mode is bounded.
    3. continue monitoring whether Task Batch/Task Lifecycle keep moving backlog forward after the restart.
- Follow-up on 2026-04-01 (task detail modal load path):
  - Patched both shipped task UIs (`ui/tabs/tasks.js`, `site/ui/tabs/tasks.js`) so the initial task-detail open request now calls `/api/tasks/detail?...&includeWorkflowRuns=0` instead of requesting the heavy workflow-run expansion path up front.
  - Validation passed for browser-served modules: `npm run syntax:check` and `npm run build`.
  - Live Playwright confirmation on the blocked task `4a445fa4-7323-4abb-aeeb-311cc0782e9d`:
    - the Work board still opens the detail modal successfully;
    - the modal now renders the task shell and blocked-context content immediately from the fast detail payload;
    - the modal still shows a background `Refreshing task details…` indicator while hydration completes, so there is remaining polish/perf work if we want that status to settle faster or lazy-load richer evidence explicitly.
