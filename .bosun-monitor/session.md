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
- Follow-up on 2026-04-01 (current runtime + UI sweep after PR-fix preflight patch):
  - Pinned runtime checks remain healthy on the current source daemon:
    - `node cli.mjs --daemon-status --config-dir .bosun --repo-root .` => running (`PID 53868`).
    - `/api/health` => `ok=true`, uptime ~947s during this pass, `wsClients=4`.
    - pinned task stats unchanged from the earlier post-restart snapshot: `draft=45`, `todo=12`, `inprogress=8`, `inreview=0`, `done=104`, `blocked=10`, `total=182`.
  - Current PR Watchdog behavior looks stable in the live monitor window after the `validate-pr-state` source change:
    - recent `monitor.log` cycles (`18:20:56Z` through `18:30:59Z`) show `Bosun PR Watchdog` completing with `fix-needed=false` and no new `dispatch-fix` fan-out in that window.
    - `/api/workflows/runs?limit=12` still lists failed `template-pr-fix-single` runs for PRs `#437`, `#438`, and `#449`, but those are historical runs from the earlier failure epoch, not new failures from the current watch window.
    - `/api/workflows/template-updates` is healthy again and reports `template-pr-fix-single` + `template-pr-security-fix-single` as `updateAvailable=false`.
  - Runtime store/template note:
    - direct file inspection of `.bosun/.bosun/workflows/template-pr-fix-single.json` and `.bosun/.bosun/workflows/template-pr-security-fix-single.json` still shows older on-disk branch wiring without the new `validate-pr-state` node, while the live engine/template metadata says those templates are current.
    - treat this as a store/adoption inconsistency to keep monitoring, but not a proven live execution blocker in this current epoch because the watchdog is not currently dispatching fix agents.
  - Additional Playwright smoke coverage completed against the existing browser session:
    - `Run Flows` remains functional and populated.
    - `Telemetry` loads meaningful analytics cards and charts.
    - `Bench` loads the full benchmark controls/preset forms.
    - `Settings` loads the app preference accordions and account/version section.
  - Remaining live UI signal:
    - browser console still reports one persistent warning: `[h-guard] Array passed as element type — rendering as Fragment 17 items` from `ui/app.js:81`.
    - current narrowing points to the `Run Flows` / `manual-flows` composition path; the page still renders correctly, so this is currently a warning-quality issue rather than a user-visible break.
  - Next concrete actions:
    1. isolate the `manual-flows` / `Run Flows` array-as-element warning and patch both `ui/` + `site/ui/` copies if the misuse is confirmed.
    2. keep watching fresh watchdog cycles to confirm no new merged-PR clone failures reappear.
    3. continue deeper workflow/market/chat/fleet interaction sweeps from the same Playwright session instead of opening more browser processes.
- Follow-up on 2026-04-01 (worktree refresh conflict recovery semantics):
  - Revalidated the main pipeline bottleneck: `branch_refresh_conflict` is still the dominant live worktree failure mode surfaced in Pulse/workflow-run artifacts, but the deeper defect is not the initial block itself. The incorrect behavior was the generic auto-unblock path reactivating these blocked tasks and sending them straight back into the same failing reacquire loop.
  - Source fix applied:
    - `workflow/workflow-nodes.mjs`
    - `workflow/workflow-nodes/actions.mjs`
    - `task/task-store.mjs`
  - Behavioral change:
    - `branch_refresh_conflict` now reports a truthful blocked reason (`task remains blocked until repair workflow succeeds`) instead of claiming Bosun will retry automatically after cooldown.
    - acquire-worktree no longer schedules a generic cooldown `retryAt` for `branch_refresh_conflict`.
    - generic blocked-task auto-recovery in both workflow polling and task-store recovery now skips `branch_refresh_conflict` unless the task still contains unresolved workflow placeholders; this prevents churn where the monitor unblocks the task only for acquire-worktree to hit the same stale-refresh conflict again.
  - Regression coverage added/updated:
    - `tests/task-store.test.mjs`
    - `tests/workflow-task-lifecycle.test.mjs`
    - focused checks passed:
      - `npm test -- tests/task-store.test.mjs -t "does not auto-recover branch refresh conflicts that require repair workflow"`
      - `npm test -- tests/workflow-task-lifecycle.test.mjs -t "does not auto-recover branch refresh conflicts before polling"`
      - `npm run build`
  - Validation caveat:
    - broad `npm test -- tests/task-store.test.mjs tests/workflow-task-lifecycle.test.mjs` still fails in `tests/workflow-task-lifecycle.test.mjs`, but the failures are unrelated template-shape assertions tied to pre-existing dirty changes in `workflow-templates/task-lifecycle.mjs` and `workflow-templates/reliability.mjs` already present in this checkout (`set-fix-summary`, `{{prBody}}`, watchdog defaults). I did not modify those files in this pass.
  - Current pinned runtime snapshot after this pass:
    - `node cli.mjs task stats --config-dir .bosun --repo-root .`
    - `draft=45 todo=13 inprogress=8 inreview=0 done=104 blocked=10 total=183`
  - Next concrete actions:
    1. monitor whether blocked `branch_refresh_conflict` tasks now stay parked for repair instead of boomeranging back to todo.
    2. inspect the repair-worktree workflow path on one affected task branch to confirm it can actually clear the conflict and unblock the task.
    3. continue sequential Playwright sweeps from the authenticated portal session while avoiding new browser process churn.
- Follow-up on 2026-04-01 (manual-flow health check `baseBranch=entire` loop fix):
  - Diagnosed the current `todo -> inprogress -> todo` loop for task `5d0cd537-2dcc-4ced-a001-130b77aea729` as a false base-branch inference, not a `branch_refresh_conflict`.
  - Root cause:
    - internal kanban branch extraction treated plain prose `Target: entire repo` in the Codebase Health Check task description as a branch marker and normalized it into `baseBranch: "entire"`.
    - Task Lifecycle then passed that through acquire-worktree, producing `fatal: invalid reference: entire` and retrying as `worktree_acquisition_failed`.
  - Source fix applied:
    - `kanban/kanban-adapter.mjs`
    - `tests/kanban-adapter.test.mjs`
  - Behavioral change:
    - task text only infers base branches from explicit branch markers (`base branch`, `base_branch`, `upstream`, `target branch`), not generic `Target: ...` prose.
    - internal task updates now honor explicit base-branch clears (`baseBranch: ""`) and remove stale canonical/meta base-branch fields instead of preserving old values.
  - Validation passed:
    - `npm test -- tests/kanban-adapter.test.mjs tests/manual-flows.test.mjs` => `90 passed`
    - `npm run build`
  - Live runtime repair:
    - restarted Bosun on pinned roots with `node cli.mjs --stop-daemon --config-dir .bosun --repo-root .` then `node cli.mjs --daemon --config-dir .bosun --repo-root .`
    - cleared the stale live task field via `/api/tasks/update` with `taskId=5d0cd537-2dcc-4ced-a001-130b77aea729` and `baseBranch=""`
    - immediate task detail confirmed `baseBranch: null`
    - current `monitor.log` evidence shows the next Task Lifecycle attempts now pass `acquire-worktree` with `worktree-ok result=true`, then continue through:
      - `resolve-executor`
      - `record-head`
      - `read-workflow-contract`
      - `workflow-contract-validation`
      - `build-prompt`
      - `run-agent-plan`
    - this confirms the previous `invalid reference: entire` loop is cleared in the live runtime.
  - Current live task state:
    - task `5d0cd537-2dcc-4ced-a001-130b77aea729` is presently `inprogress`
    - `baseBranch` is `null`
    - `worktreePath` is now populated under `.bosun/worktrees/task-5d0cd5372dcc-...`
  - Next concrete actions:
    1. continue monitoring this task through agent execution/finalization to ensure it completes rather than stalling later in the lifecycle.
    2. resume Playwright CLI/browser validation now that the highest-value live pipeline loop is fixed.
    3. investigate the remaining daemon-status/process-accounting inconsistency (`--daemon-status` seeing multiple active Bosun processes) only if it causes operational confusion or restart issues.
