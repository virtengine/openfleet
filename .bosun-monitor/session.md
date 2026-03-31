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
- Follow-up on 2026-04-01 (workflow-owned stale-claim recovery after bridge fix):
  - Fresh pinned-runtime verification showed task `5d0cd537-2dcc-4ced-a001-130b77aea729` was no longer actively looping after the `baseBranch` repair, but it was still stranded:
    - `/api/tasks/detail?...includeWorkflowRuns=0` reported `status=inprogress`, `runtimeSnapshot.reason=no_active_executor_slot`, `auditActivity.summary.eventCount=0`.
    - `task-claims.json` and `shared-task-states.json` still held owner `wf-056c56fa` with the last renewals at `2026-03-31T19:26:08Z`.
    - `_active-runs.json` did not list the task anymore, so the executor had lost workflow ownership while the stale claim/thread state remained.
  - Root cause:
    - workflow-owned in-progress recovery still treated `getActiveThreads()` as authoritative liveness even when the workflow run was gone and the shared-state owner was stale.
    - that let resumable thread-registry entries mask stale workflow claims, leaving tasks pinned in `inprogress` indefinitely with `No live execution detected`.
  - Source fix applied:
    - `task/task-executor.mjs`
    - `tests/task-executor.test.mjs`
  - Behavioral change:
    - in workflow-owned mode, stale shared-state ownership is now resolved before the thread-registry shortcut.
    - workflow-owned resets for stale/missing ownership now also call `invalidateThread(taskId)` so dead resumable thread records cannot keep the task stranded on the next recovery pass.
  - Focused validation passed:
    - `npm test -- tests/task-executor.test.mjs -t "stale workflow claim|fresh workflow-owned tasks when no active workflow run or claim exists|active workflow run exists|dead local pid"`
    - result: `4 passed`
  - Next concrete actions:
    1. restart Bosun on pinned roots so the recovery patch is live.
    2. verify task `5d0cd537-...` is either reset to `todo` or re-dispatched cleanly instead of remaining orphaned in `inprogress`.
    3. continue UI/Playwright sweeps once the pipeline state is confirmed live again.
- Follow-up on 2026-04-01 (worker bridge taskKey normalization):
  - Confirmed the live `run-agent-plan` failure at `logs/daemon.log:7792` was still `[agent-pool] execWithRetry requires a taskKey for thread persistence` in the current daemon epoch after the stale-claim recovery patch.
  - Source-side `action.run_agent` fallback logic already produced a `recoveryTaskKey`, so the remaining suspect path was the worker/main-thread service bridge.
  - Patch applied in `server/ui-server.mjs`:
    - worker service dispatch now normalizes `agentPool.execWithRetry` / `launchOrResumeThread` args before invoking the in-process pool;
    - if `taskKey` is blank, it is rehydrated from `slotMeta.taskKey`, `taskId`, `linkedTaskId`, `targetTaskKey`, `workflowRunId`, or `workflowId`.
  - Regression updated in `tests/workflow-worker-recovery-regression.test.mjs` to lock the new bridge normalization in place.
  - Validation passed:
    - `npm test -- tests/workflow-worker-recovery-regression.test.mjs`
    - `npm run build`
  - Next concrete action:
    1. restart daemon on pinned roots and verify `5d0cd537-...` moves past `run-agent-plan` without the missing-taskKey failure.
- Follow-up on 2026-04-01 (post-restart runtime + Playwright CLI status):
  - Restarted daemon successfully onto the patched source checkout; current pinned daemon PID is `20880`.
  - Immediate post-restart polling has not yet re-exercised task `5d0cd537-2dcc-4ced-a001-130b77aea729` through a fresh `run-agent-plan` attempt in the new epoch, so the worker-bridge taskKey normalization fix is validated in tests/build but still awaiting live confirmation.
  - Pinned task stats remain stable after restart: `draft=45 todo=12 inprogress=9 inreview=0 done=104 blocked=10 total=183`.
  - Playwright CLI browser session was reopened, but the portal still hard-fails navigation with `net::ERR_CERT_AUTHORITY_INVALID` against `https://127.0.0.1:4400/` even after adding local `.playwright/cli.config.json` attempts for `contextOptions.ignoreHTTPSErrors` and Chrome launch args `--ignore-certificate-errors`.
  - Next concrete action:
    1. use a different Playwright control path or browser-certificate bypass approach before resuming the remaining Fleet/Control/Infra/Logs/Library/Market/Chat sweep.
    2. keep watching for the first fresh post-restart Task Lifecycle poll that exercises `5d0cd537-...` through `run-agent-plan`.
- Follow-up on 2026-04-01 (Pulse project-summary scope/count repair):
  - Confirmed a live Pulse inconsistency before the patch:
    - `/api/tasks?page=0&pageSize=200` returned workspace-scoped counts `draft=45 backlog=12 blocked=6 inProgress=8 inReview=0 done=96`.
    - `/api/project-summary` returned global-ish/stale card data `taskCount=183 completedCount=104`, then after the first scope patch still `taskCount=167 completedCount=93`.
  - Source fix applied in `server/ui-server.mjs`:
    - `/api/project-summary` now uses `resolveInjectedTaskStoreApi() || getKanbanAdapter()`.
    - the endpoint now filters tasks through `taskMatchesWorkspaceContext(...)` before computing the summary card payload.
    - `completedCount` now uses `mapTaskStatusToBoardColumn(task.status) === "done"` so merged/closed/done states stay aligned with the main Pulse buckets.
  - Regression added in `tests/ui-server.test.mjs` to lock active-workspace scoping on `/api/project-summary`.
  - Validation passed:
    - `npm test -- tests/ui-server.test.mjs -t "project-summary to the active workspace"`
    - `npm run build`
  - Live runtime confirmation after restart onto the patched source:
    - current daemon PID is `13280`.
    - `/api/tasks?page=0&pageSize=200` => `{"draft":45,"backlog":12,"blocked":6,"inProgress":8,"inReview":0,"done":96}`
    - `/api/project-summary` => `{"taskCount":167,"completedCount":96}`
    - `/api/status` remains broader runtime snapshot scope => `done=104 blocked=10 total=180`, so remaining dashboard confusion should now be limited to intentionally different scope labels rather than a mismatched Project card.
  - Next concrete actions:
    1. use Playwright on the authenticated Pulse tab to visually confirm the Project card now shows `167` tasks / `96` completed and no longer contradicts the overview metrics.
    2. continue the remaining authenticated tab sweep (`Fleet`, `Control`, `Infra`, `Logs`, `Library`, `Market`, `Chat`) on daemon `PID 13280`.
    3. keep watching whether task `5d0cd537-2dcc-4ced-a001-130b77aea729` reaches a fresh `run-agent-plan` in the current daemon epoch.
- Follow-up on 2026-04-01 (Fleet dispatch pagination contract + session-state evidence):
  - Confirmed the Fleet `Dispatch` task picker was querying `/api/tasks?limit=1000`, but `server/ui-server.mjs` ignores `limit` and still paginates with `pageSize` (default `15`, max `200`).
  - Live authenticated API evidence on daemon `PID 13280`:
    - `/api/tasks?page=0&pageSize=200` returns `total=167` with workspace-scoped counts `draft=45 backlog=12 blocked=6 inProgress=8 inReview=0 done=96`.
    - `/api/sessions?type=task&workspace=all` currently groups to:
      - `12 active/active/active`
      - `21 no_output/no_output/no_output`
      - `11 stalled/stalled/stalled`
      - `49 completed/completed/completed`
    - `no_output` sessions already serialize as explicit non-live runtime state (`runtimeState=no_output`, `turnCount=0`), so the immediate Fleet loader defect was the task query cap rather than response unwrapping.
  - Source fix applied:
    - `ui/tabs/agents.js`
    - `site/ui/tabs/agents.js`
  - Behavioral change:
    - Fleet `Dispatch` now requests `/api/tasks?page=0&pageSize=200`, matching the server pagination contract and exposing the full backlog/draft pool instead of the first 15 tasks only.
  - Regression coverage added:
    - `tests/session-api.test.mjs` now locks `runtimeState=no_output` as explicit non-live runtime state to preserve the current Fleet liveness semantics while the deeper task-pipeline triage continues.
  - Next concrete actions:
    1. run `npm test -- tests/session-api.test.mjs`, `npm run syntax:check`, `npm test`, and `npm run build`.
    2. refresh the authenticated Fleet tab and verify the Dispatch picker now shows backlog/draft tasks beyond the previous first-page cap.
    3. continue deeper runtime triage on the still-stranded `no_output` / `stalled` task sessions after the UI loader fix is live.
- Follow-up on 2026-04-01 (Fleet session-list hide filter for synthetic task fixtures):
  - Confirmed the remaining Fleet “12 session-only agents active” inflation was server-side:
    - `/api/sessions?type=task&workspace=all` includes hidden synthetic/stale task sessions because `/api/sessions` only applied `shouldHideSessionFromDefaultList(session)` when no `type`/`status` filters were present.
    - the stale task ids observed in the live daemon session list included:
      - `nonexistent`
      - `session-linked-task-1`
      - `task-1774940903138-4lzrda`
      - `task-1774940641127-qpcjry`
    - many of these reported `turnCount=0` and `runtimeState/status=lifecycleStatus` combinations such as `no_output/no_output/no_output` or bogus `active/active/active`.
  - Source fix applied:
    - `server/ui-server.mjs`
    - `tests/ui-server.test.mjs`
  - Behavioral change:
    - `/api/sessions` now applies default hidden-session filtering whenever `includeHidden` is not set, including filtered list views like `type=task`.
    - the synthetic fixture matcher was extended to catch generated stale task ids of the form `task-<digits>-<suffix>` and explicit `nonexistent` placeholders while still staying inside the existing temp-workspace/no-workspace guard.
  - Focused validation passed:
    - `npm test -- tests/ui-server.test.mjs -t "hides leaked synthetic fixture sessions from the default session list"`
    - `npm test -- tests/ui-server.test.mjs -t "scopes session listing to the active workspace by default|hides leaked synthetic fixture sessions from the default session list|filters ledger-only sessions to the active workspace using durable workspace metadata"`
    - `npm run build`
  - Full-suite blocker discovered and repaired during validation:
    - `npm test` failed in `tests/demo-defaults-sync.test.mjs` because checked-in generated demo defaults were stale relative to current workflow source-of-truth.
    - regenerated synced bundles with `node tools/generate-demo-defaults.mjs`.
    - `npm test -- tests/demo-defaults-sync.test.mjs` then passed.
  - Important live-runtime note:
    - current daemon source watcher does **not** watch `server/`, so the `/api/sessions` fix is not live until a pinned daemon restart.
    - a mid-verification request to `https://127.0.0.1:4400/api/sessions?...` briefly hit `connection refused`, but `--daemon-status` still reported the daemon running afterward; treat as transient UI listener instability until the controlled restart/recheck is done.
  - Current status at handoff:
    - full `npm test` rerun restarted after the demo-default regeneration and was still progressing cleanly through grouped batches at the time of this checkpoint.
  - Next concrete actions:
    1. wait for the current full `npm test` rerun to complete.
    2. restart Bosun on pinned roots with `node cli.mjs --stop-daemon --config-dir .bosun --repo-root .` then `node cli.mjs --daemon --config-dir .bosun --repo-root . --no-update-check --no-auto-update`.
    3. re-query `https://127.0.0.1:4400/api/sessions?type=task&workspace=all&token=...` and confirm the stale synthetic ids above are absent.
    4. use Playwright against the authenticated Fleet tab to confirm the session-only active count drops and the Dispatch picker still shows the expanded backlog/draft task list.
- Follow-up on 2026-04-01 (kanban base-branch alias regression reappeared during full suite):
  - The resumed full `npm test` rerun progressed past the earlier demo-default sync failure but then failed in `tests/kanban-adapter.test.mjs`:
    - failing case: `does not treat generic target payload fields as a base-branch alias`
    - symptom: internal adapter was again persisting `baseBranch: "entire"` when payload-only task creation used `target: "entire"`.
  - Root cause:
    - `kanban/kanban-adapter.mjs` `resolveBaseBranchInput(payload)` still accepted generic payload aliases `base` and `target`, not just explicit branch fields.
    - `InternalAdapter.updateTask()` also treated those same generic keys as `baseBranchProvided`, which could clear/set canonical base-branch metadata on unrelated generic target updates.
  - Source fix applied:
    - `kanban/kanban-adapter.mjs`
  - Behavioral change:
    - base-branch inference from payload fields is now limited to explicit branch-specific keys:
      - `baseBranch`
      - `base_branch`
      - `upstream`
      - `upstreamBranch`
      - `upstream_branch`
      - `targetBranch`
      - `target_branch`
    - generic payload keys like `target` and `base` no longer alias into branch metadata.
  - Validation passed:
    - `npm test -- tests/kanban-adapter.test.mjs -t "does not infer a base branch from health-check target prose|still infers a base branch from explicit branch markers in task text|does not treat generic target payload fields as a base-branch alias|clears persisted base branch metadata when explicitly unset"`
    - `npm test -- tests/kanban-adapter.test.mjs`
  - Immediate next action:
    1. restart the pinned daemon so both the session-list filter fix and this adapter fix are live in runtime before further API/Playwright verification.
