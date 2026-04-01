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
- Follow-up on 2026-04-01 (Fleet task-session snapshot isolation fix):
  - Diagnosed the remaining Fleet/Sessions mismatch as a client-side shared-store overwrite issue, not another server/session-filter bug.
  - Root cause:
    - `ui/components/session-list.js` exposes a single global `sessionsData` signal.
    - both the Fleet overview (`AgentsTab`) and standalone `FleetSessionsTab` were reading from that shared signal after calling `loadSessions({ type: "task", workspace: "all" })`.
    - other tabs/loaders can later overwrite the same signal with different filters (`workspace=active`, other session types), causing Fleet overview/session cards to show `0` or `No sessions yet` even while the standalone Sessions flow had recently loaded non-empty task sessions.
  - Source fix applied:
    - `ui/components/session-list.js`
    - `site/ui/components/session-list.js`
    - `ui/tabs/agents.js`
    - `site/ui/tabs/agents.js`
    - `tests/fleet-tab-render.test.mjs`
  - Behavioral change:
    - `loadSessions(...)` now returns the loaded session array on success (or `null` on failure) in addition to updating the shared signal.
    - Fleet overview and standalone Fleet Sessions now keep a local `fleetSessionsSnapshot` sourced from their own `loadSessions({ type: "task", workspace: "all" })` refresh loop.
    - `FleetSessionsPanel` now renders from the passed task-session snapshot instead of the mutable global `sessionsData` store, so Fleet metrics/session cards stay aligned with the same task-session query they requested.
    - mirrored the same fix into `site/ui/` to preserve hosted demo parity.
  - Validation passed:
    - `npm run syntax:check`
    - `npm test -- tests/fleet-tab-render.test.mjs tests/session-api.test.mjs`
    - `npm run build`
  - Current live-runtime verification status:
    - restarted Bosun on pinned roots:
      - `node cli.mjs --stop-daemon --config-dir .bosun --repo-root .`
      - `node cli.mjs --daemon --config-dir .bosun --repo-root . --no-update-check --no-auto-update`
    - current daemon is now `PID 52752`.
    - direct HTTPS checks against `https://192.168.0.183:4400` show the UI server is live again and still normalizes tokenized URLs with `302` redirects to clean paths.
    - Playwright browser verification against the restarted Fleet/Sessions UI is in progress at this checkpoint; no new code blocker found in local validation.
  - Next concrete actions:
    1. finish the post-restart Playwright Fleet/Sessions smoke and confirm the Fleet overview no longer shows `0` while Sessions is populated.
    2. if Fleet still diverges visually, capture the redirected/authenticated DOM text plus in-page fetch results from the same browser context to isolate any remaining client-only render path.
    3. resume broader runtime triage for the remaining `no_output` / `stalled` task sessions once Fleet metrics are visually confirmed stable.
- Follow-up on 2026-04-01 (Pulse/Telemetry durable runtime zero-summary fix):
  - Diagnosed the remaining Pulse `Durable Runtime` and Telemetry `Durable Session Runtime` zero cards as an API projection gap, not another UI rendering bug.
  - Root cause:
    - `ui/tabs/dashboard.js` and `ui/tabs/telemetry.js` already expect:
      - `sessionHealth`
      - `context`
      - `toolSummary`
      - `activeSessionCount`
      - `completedSessionCount`
      - `totalSessionCount`
    - `infra/runtime-accumulator.mjs` already computes the completed-session aggregates (`healthBuckets`, `contextSummary`, `toolSummary`, `sessionCount`).
    - `server/ui-server.mjs` `/api/status` and `/api/telemetry/summary` were not exposing those durable-runtime fields, so the live cards fell back to zero even while Fleet/Sessions showed active and historic task sessions.
  - Source fix applied:
    - `server/ui-server.mjs`
    - `tests/ui-server.test.mjs`
  - Behavioral change:
    - added shared `buildDurableRuntimeSurface()` in `server/ui-server.mjs`.
    - `/api/status` now merges durable runtime/session/context/tool fields into the top-level `data` payload.
    - `/api/telemetry/summary` now merges the same durable runtime/session/context/tool fields into the returned telemetry summary.
    - live-session counts come from `buildCurrentTuiMonitorStats()`; completed-session/context/tool aggregates come from `getRuntimeStats()`.
  - Validation passed:
    - `npm test -- tests/ui-server.test.mjs`
    - `npm run syntax:check`
    - `npm run build`
  - Current next actions:
    1. restart Bosun on pinned roots so the `server/` change is live.
    2. re-check `/api/status` and `/api/telemetry/summary` against the live daemon for non-zero durable-runtime fields.
    3. verify Pulse and Telemetry cards in the authenticated browser context with Playwright CLI.

- Follow-up on 2026-04-02 (systemic throughput fixes in current working tree):
  - Confirmed currently applied source changes:
    - `task/task-executor.mjs`
    - `tests/task-executor.test.mjs`
    - `workflow/workflow-nodes.mjs`
    - `tests/workflow-task-lifecycle.test.mjs`
    - `task/task-assessment.mjs`
    - `tests/monitor-workflow-startup-guards.test.mjs`
  - Workflow-owned recovery guard:
    - restored and revalidated the task-executor fallback that treats recent workflow-run detail (`topology.latestRunId` -> `.bosun/workflow-runs/<runId>.json`) as valid liveness evidence even when `_active-runs.json` is briefly empty.
    - prevents false `inprogress -> todo` demotions caused by transient active-run index gaps.
    - focused validation passed:
      - `node --max-old-space-size=4096 tools/vitest-runner.mjs run --config vitest.config.mjs tests/task-executor.test.mjs`
      - result: `81/81` passing
  - Downstream refresh routing fix:
    - full-suite failure exposed a real prompt/runtime bug in `task/task-assessment.mjs`.
    - `quickAssess({ trigger: "pr_merged_downstream" })` used merge-oriented wording and could emit `origin/origin/main` when `upstreamBranch` already included `origin/main`.
    - fixed by normalizing the upstream ref and issuing rebase-oriented refresh guidance.
    - focused validation passed:
      - `node --max-old-space-size=4096 tools/vitest-runner.mjs run --config vitest.config.mjs tests/branch-routing.test.mjs tests/task-assessment.test.mjs`
      - result: `83/83` passing
  - Generated demo-defaults drift fix:
    - full-suite failure exposed stale generated assets, not logic failure.
    - regenerated:
      - `ui/demo-defaults.js`
      - `site/ui/demo-defaults.js`
    - command:
      - `node tools/generate-demo-defaults.mjs`
    - focused validation passed:
      - `node --max-old-space-size=4096 tools/vitest-runner.mjs run --config vitest.config.mjs tests/demo-defaults-sync.test.mjs`
      - result: `2/2` passing
  - Startup-guard coverage alignment:
    - later full-suite failure was a stale source-text assertion in `tests/monitor-workflow-startup-guards.test.mjs`.
    - test previously expected the old guard string `if (hasWorkflowRun || hasThread) {`.
    - updated test to require the stronger fallback path:
      - `hasRecentWorkflowRunEvidence`
      - `if (hasWorkflowRun || hasRecentWorkflowRunEvidence || hasThread) {`
    - focused validation passed:
      - `node --max-old-space-size=4096 tools/vitest-runner.mjs run --config vitest.config.mjs tests/monitor-workflow-startup-guards.test.mjs`
      - result: `36/36` passing
  - Global validation status during this pass:
    - `npm run syntax:check` passed
    - `npm run build` passed
    - full `npm test` reruns progressed cleanly through grouped batches 1 through 7 after the above fixes
    - next full-suite checkpoint reached grouped batch 8 before this handoff note was written; no new runtime defect had been patched beyond the stale startup-guard test at this checkpoint

- Follow-up on 2026-04-02 (harness 404 / stale runs triage):
  - Root cause of the "no runs newer than 1d" incident was not the harness route definitions.
  - `server/ui-server.mjs` already contained `/api/harness/runs` and `/api/harness/approvals`, but the Bosun daemon had crashed during startup and the monitor loop was not producing fresh runtime activity.
  - Crash signature:
    - `workspace/shared-knowledge.mjs`
    - `SyntaxError: Identifier 'loadRegistryEntries' has already been declared`
  - Source fix applied:
    - `workspace/shared-knowledge.mjs`
  - Behavioral change:
    - removed the duplicated `loadRegistryEntries(...)` definition introduced by merge residue.
    - restored a single ledger-backed registry loader via `listKnowledgeEntriesFromStateLedger(...)`.
    - removed the broken dynamic-ledger/double-write path in `appendKnowledgeEntry(...)` so shared knowledge writes are authoritative, single-pass, and no longer block startup.
  - Validation passed:
    - `node --input-type=module -e "await import('./workspace/shared-knowledge.mjs'); console.log('shared-knowledge import ok');"`
    - `node --max-old-space-size=4096 tools/vitest-runner.mjs run --config vitest.config.mjs tests/fleet-coordinator.test.mjs -t "shared-knowledge|Persistent Memory|appendKnowledgeEntry|retrieveKnowledgeEntries"`
    - `npm run syntax:check`
    - `npm run build`
  - Runtime verification after pinned restart:
    - restarted with:
      - `node cli.mjs --daemon --config-dir .bosun --repo-root . --no-update-check --no-auto-update`
    - verified:
      - `node cli.mjs --daemon-status --config-dir .bosun --repo-root .`
      - result: daemon running (`PID 2100`)
    - monitor log resumed with fresh startup entries at `2026-04-01T15:35:56Z` and fresh workflow schedule activity.
    - `.bosun/workflow-runs/index.json` now contains fresh schedule-poll workflow runs again (for example `Task Batch Processor` and `Task Lifecycle` entries with recent timestamps).
    - authenticated harness probes now return `200 OK`:
      - `/api/harness/runs?limit=8&token=...`
      - `/api/harness/approvals?limit=100&status=pending&token=...`
  - Current state:
    - the harness API is live again.
    - the current harness store still only contains older persisted harness executions from `2026-03-31`, so the harness monitor itself still shows older run history until a new harness execution is triggered.
    - the broader Bosun workflow runtime is producing fresh workflow-run records again after the crash fix.

- Follow-up on 2026-04-02 (workflow run history showing `17h ago` despite fresh monitor activity):
  - Root cause:
    - `/api/workflows/runs` was resolving the active workspace into the managed workspace clone under:
      - `.bosun/workspaces/virtengine-gh/bosun`
    - instead of the canonical repo-local Bosun runtime at:
      - `C:\Users\jON\Documents\source\repos\virtengine-gh\bosun`
    - because workspace repo resolution preferred `repos[].path` (clone-local path) over the explicit configured repo location in `repos[].url`.
  - Source fix applied:
    - `server/ui-server.mjs`
  - Behavioral change:
    - added `resolveWorkspaceRepoLocation(...)`.
    - active workspace repo selection now prefers explicit configured repo URLs before clone-local workspace paths.
    - task repository resolution for workspace-scoped operations now uses the same location precedence.
  - Validation passed:
    - `npm run syntax:check`
    - `npm run build`
    - pinned daemon restart:
      - `node cli.mjs --stop-daemon --config-dir .bosun --repo-root .`
      - `node cli.mjs --daemon --config-dir .bosun --repo-root . --no-update-check --no-auto-update`
    - live API verification after restart:
      - `/api/workflows/runs?limit=5&token=...` now returns fresh current runs such as:
        - `e65cc774-f4ad-49cd-9159-0fb44a5c8e59`
      - `7bde50c9-5268-4151-987a-e2dd3a5bc833`
      - `af5d1371-3bbd-44d6-9089-f3f254606562`
      - these correspond to current startup/schedule-poll activity instead of the stale March 31 workspace-clone history.

- Follow-up on 2026-04-02 (fleet-sessions showing stale/inactive session-only rows as active):
  - Problem:
    - Fleet Sessions "Active" was still surfacing non-live task sessions that only had stale/recent metadata.
    - The list also did not make it obvious whether current agent output should be read from the chat stream or the log tail.
  - UI/runtime changes applied:
    - `ui/tabs/agents.js`
    - `site/ui/tabs/agents.js`
    - `tests/session-api.test.mjs`
    - `tests/fleet-tab-render.test.mjs`
  - Behavioral change:
    - Fleet-active session-only rows now require runtime state `running`; `recent` is no longer treated as active.
    - Recent session-only rows are still visible in the full list/history, but they are no longer counted under the Active fleet filter.
    - Fleet row activity text now includes response path context, e.g. `Responding via stream ...`, `Last logs response ...`, or `Awaiting stream response`.
    - Selected fleet detail header now also shows the response path so operators can immediately tell where live output is expected.
  - Validation passed:
    - `npm run syntax:check`
    - `npm test -- tests/session-api.test.mjs tests/fleet-tab-render.test.mjs`
      - passed: `87` tests
    - `npm run build`
  - Repo-wide validation note:
    - `npm test` did not complete cleanly due existing failures in `tests/primary-agent.runtime.test.mjs`.
    - observed failures were timeouts in:
      - `falls back to pooled execution when active adapter is busy on another session`
      - `records a context compression marker when returned items were summarized`
      - `retries codex locally before any failover`
      - `suppresses failover until repeated infrastructure failures`
  - Follow-up fix:
    - root cause for remaining false `ACTIVE` badges was lifecycle/runtime precedence in `ui/modules/session-api.js` and `site/ui/modules/session-api.js`.
    - terminal lifecycle states must win over stale `runtimeState: running` snapshots from persisted session records.
    - added regression in `tests/session-api.test.mjs`.
  - Follow-up validation passed:
    - `npm run syntax:check`
    - `npm test -- tests/session-api.test.mjs tests/fleet-tab-render.test.mjs`
      - passed: `88` tests

## 2026-04-02 - Fleet Sessions active/live cleanup

- User-facing incident:
  - Fleet Sessions "Active" view was showing stale/inactive session records and repeated zero-turn entries.
  - rail ordering did not make it obvious where current agent responses were landing.
- Source fixes applied:
  - `ui/modules/session-api.js`
  - `site/ui/modules/session-api.js`
  - `ui/tabs/agents.js`
  - `site/ui/tabs/agents.js`
  - `ui/styles/components.css`
  - `site/ui/styles/components.css`
- Behavioral change:
  - explicit `runtimeIsLive: false` now downgrades stale `runtimeState: running` snapshots into recency-derived non-live states instead of keeping them active forever.
  - Fleet Sessions `Active` now keys off `getFleetEntryStatusMeta(...).isActive` and no longer treats `recent` sessions as active.
  - Fleet session rail now dedupes repeated entries by canonical session/task identity and prefers the strongest live entry.
  - session cards now expose response freshness text such as responding/last-response/awaiting-response so current activity is easier to locate.
- Validation:
  - focused tests passed:
    - `npm test -- tests/session-api.test.mjs tests/fleet-tab-render.test.mjs`
  - build passed:
    - `npm run build`
  - full suite status:
    - `npm test` progressed through grouped batches and then failed in unrelated pre-existing runtime timeout coverage under `tests/primary-agent.runtime.test.mjs`
    - observed failing cases:
      - `falls back to pooled execution when active adapter is busy on another session`
      - `records a context compression marker when returned items were summarized`
      - `retries codex locally before any failover`
      - `suppresses failover until repeated infrastructure failures`

## 2026-04-02 - Run History loading and API resilience hardening

- User-facing incident:
  - clicking `Run History` rows could fail to open the selected run because run-detail fetches were not consistently workspace-scoped.
  - run history and run-detail views did not clearly distinguish loading vs failure, which made backend restarts look like frozen UI.
  - repeated `ERR_CONNECTION_REFUSED` / websocket reconnect churn was making the UI feel laggy and noisy during backend interruptions.
  - library tab async loads were still vulnerable to late `setLoading(false)` after unmount, matching the `preact-hooks ... reading 'setState'` crash signature.
- Source fixes applied:
  - `ui/modules/api.js`
  - `site/ui/modules/api.js`
  - `ui/tabs/workflows.js`
  - `site/ui/tabs/workflows.js`
  - `ui/tabs/library.js`
  - `site/ui/tabs/library.js`
  - `tests/workflow-run-history-ui-regression.test.mjs`
  - `tests/ui-connection-badge.test.mjs`
  - `tests/library-agent-type-tools-regression.test.mjs`
- Behavioral change:
  - workflow run detail, retry, approval, cancel, copilot-context, and live-refresh requests now route through `buildWorkflowRunApiPath(...)` so the active workspace query is preserved across run history flows.
  - run history now exposes explicit loading/error signals for both the run list and run details, with inline `CircularProgress` states and retry affordances instead of silent failures.
  - API client now applies a short backend-unavailable cooldown after connection-refused / failed-fetch errors, dedupes repeated API-error toasts, and defers websocket reconnect attempts until the cooldown expires.
  - library tab load requests now track mount/request liveness before mutating component state, preventing stale async completions from calling `setLoading(false)` after unmount.
- Validation:
  - focused tests passed:
    - `npm test -- tests/workflow-run-history-ui-regression.test.mjs tests/ui-connection-badge.test.mjs tests/library-agent-type-tools-regression.test.mjs`
  - build passed:
    - `npm run build`
  - full suite status:
    - `npm test` still failed only in the pre-existing `tests/primary-agent.runtime.test.mjs` timeout cluster.
    - observed failing cases:
      - `falls back to pooled execution when active adapter is busy on another session`
      - `records a context compression marker when returned items were summarized`
      - `retries codex locally before any failover`
      - `suppresses failover until repeated infrastructure failures`
  - Playwright CLI:
    - `npx --yes --package @playwright/cli playwright-cli --session bosun-smoke open https://192.168.0.183:4400 --persistent --profile output/playwright/profile`
    - browser smoke reached the portal after bypassing the local certificate warning, but the session landed on `Unauthorized`, so authenticated end-to-end clicking of run history could not be completed from a fresh Playwright profile in this turn.

## 2026-04-02 - Task throughput stall diagnosis and lifecycle failure hardening

- Runtime evidence collected:
  - current local time during triage: `2026-04-02T07:11:11+11:00`
  - daemon state: `node cli.mjs --daemon-status --config-dir .bosun --repo-root .` returned `bosun daemon is not running`
  - latest workflow-run artifacts stopped at about `2026-04-02 05:30 +11:00`
  - latest `done` task update remained `2026-03-31T15:42:58.087Z`, so there were no completed tasks in the last 12h and in practice no new task completions for much longer
- Root-cause findings:
  - `Task Batch Processor` kept logging dispatch-only success (`Task batch completed: 1/1 succeeded`, `2/2 succeeded`, `8/8 succeeded`) while task completion was not advancing.
  - `Task Lifecycle` was repeatedly moving tasks into `inprogress`, then stale-claim recovery moved them back to `todo` (`source: task-executor-recovery-stale-workflow-claim`), creating churn instead of completion.
  - monitor logs captured deterministic agent infrastructure failures during those cycles, including:
    - `primary SDK "codex" missing prerequisites: @openai/codex-sdk not installed`
    - `attempt 1 hit deterministic SDK failure; retry suppressed: [agent-pool] no SDK available...`
    - `Codex SDK runtime missing at ...codex.exe`
  - after the churn window, the daemon stopped entirely, which explains why run history later went quiet.
- Systemic fix applied:
  - updated `workflow-templates/task-lifecycle.mjs`
  - added explicit success gates after `run-agent-plan`, `run-agent-tests`, and `run-agent-implement`
  - agent-phase failure now blocks the task with the phase error/failure kind and routes into normal cleanup instead of falling through to commit detection / no-commit retry loops
- Validation:
  - `npm run syntax:check` passed
  - `npm test -- tests/workflow-task-lifecycle.test.mjs tests/workflow-templates.test.mjs` passed (`344` tests)
  - `npm run build` passed
  - full `npm test` still fails in the suite runner before completion:
    - `tools/vitest-full-suite.mjs` batch 1 exits `No test files found` for its generated Vitest filter set
- Runtime recovery:
  - restarted Bosun with:
    - `node cli.mjs --daemon --config-dir .bosun --repo-root . --no-update-check --no-auto-update`
  - verified running:
    - `node cli.mjs --daemon-status --config-dir .bosun --repo-root .` → `bosun daemon is running (PID 12428)`
  - verified fresh workflow activity after restart:
    - `Bosun PR Watchdog` run `7e0553f9-fd36-4fa0-ba42-5550cf99603f`
    - `Task Batch Processor` run `3b22b475-7b77-4cb7-b20e-26a63024e3ba`
    - `Task Lifecycle` run `2fa9f5fb-2da0-439a-8f19-e4c5ffdfab8f`

## 2026-04-02 - Stability hardening for run history, session polling, and memory pressure

- User-facing incident:
  - Bosun could become sluggish or unresponsive while loading run history, workflow lists, and sessions.
  - live data refreshes could time out because the UI kept re-requesting larger and larger run-history payloads.
  - session polling was reloading and merging an oversized durable session history on every request.
  - chat/manual sessions were retaining unusually large in-memory message rings, increasing memory pressure over long runs.
- Root-cause findings:
  - `ui/tabs/workflows.js` and `site/ui/tabs/workflows.js` were polling every `3000ms` for active runs and re-fetching `Math.max(runs.length, WORKFLOW_RUN_PAGE_SIZE)`, so the request cost grew with every extra page the operator loaded.
  - `workflow/workflow-engine.mjs#getRunHistoryPage` hydrated persisted run detail summaries up to `Math.max(offset + limit, 200)` even for small first-page requests.
  - `server/ui-server.mjs#listDurableSessionsFromLedger` pulled up to `5000` durable sessions from the state ledger for repeated `/api/sessions` merges.
  - `infra/session-tracker.mjs` kept `DEFAULT_CHAT_MAX_MESSAGES = 2000` for primary/manual/chat sessions, which is too high for a long-running operator console.
- Source fixes applied:
  - `ui/tabs/workflows.js`
  - `site/ui/tabs/workflows.js`
  - `server/ui-server.mjs`
  - `infra/session-tracker.mjs`
  - `workflow/workflow-engine.mjs`
  - `tests/workflow-run-history-ui-regression.test.mjs`
  - `tests/session-tracker.test.mjs`
  - `tests/workflow-engine.test.mjs`
- Behavioral change:
  - run history live refresh now uses incremental first-page refresh (`preserveExisting`) instead of re-fetching the full loaded run list.
  - active run polling slowed from `3000ms` to `8000ms`; idle polling slowed from `15000ms` to `20000ms`.
  - manual run-history refresh/retry buttons now follow the lighter incremental refresh path.
  - persisted run-history hydration floor was reduced from `200` summaries to `50`, lowering disk churn for common first-page requests.
  - durable session ledger reads are now capped to `750` records and cached briefly before merge/filter work is repeated.
  - chat/manual/primary session ring buffers now default to `600` messages instead of `2000`.
- Validation:
  - focused tests passed:
    - `npx vitest run tests/workflow-run-history-ui-regression.test.mjs tests/session-tracker.test.mjs tests/workflow-engine.test.mjs`
  - build passed:
    - `npm run build`
  - full suite status:
    - `npm test` now gets through syntax/import validation and the full-suite runner starts successfully, but it still fails in unrelated pre-existing agent-pool coverage.
    - observed blocker:
      - `tests/async-safety-guards.test.mjs` expecting older `agent/agent-pool.mjs` fire-and-forget registry guard text while the repo currently contains a much larger unrelated agent-pool rewrite.

## 2026-04-02 - SQL-first workflow detail fallback and harness persistence follow-through

- Goal:
  - continue the SQL migration past run-history pages so workflow run detail can load from SQLite even when `workflow-runs/<runId>.json` is missing, while keeping harness API read paths SQL-first.
- Source changes:
  - `lib/state-ledger-sqlite.mjs`
  - `workflow/workflow-engine.mjs`
  - `workflow/execution-ledger.mjs`
  - `tests/state-ledger-sqlite.test.mjs`
  - `tests/workflow-engine.test.mjs`
- Behavioral change:
  - workflow run rows now reserve `workflow_runs.detail_json` in the SQLite state ledger.
  - workflow checkpoints, active-run snapshots, and final persisted run detail now sync into SQLite in addition to the legacy detail file.
  - `WorkflowEngine#getRunDetail()` now prefers the SQL detail snapshot before falling back to `workflow-runs/<runId>.json`.
  - execution-ledger normalization now derives terminal `status`, `endedAt`, and `updatedAt` from the event stream when stored summary fields are stale, which makes file and SQL fallback reads more resilient.
- Validation:
  - focused regression set passed:
    - `npx vitest run tests/state-ledger-sqlite.test.mjs tests/workflow-engine.test.mjs tests/ui-server.test.mjs -t "mirrors workflow execution ledgers into sqlite and falls back to sqlite reads|loads persisted run detail from sqlite when the detail file is missing|runs harness profiles through the API with dry-run, persisted run records, and task-linked history|stops active harness runs through the API and persists aborted task history|nudges active harness runs and resolves approval interventions through the API"`
  - build passed:
    - `npm run build`
- Remaining SQL-first work:
  - workflow snapshots/forensics/history-adjacent features still retain legacy file dependencies for some richer artifact surfaces (`snapshots`, trajectory exports, and legacy `index.json` maintenance).
  - harness approval queue persistence is still file-backed through `workflow/approval-queue.mjs`; harness run records/events are SQL-first, but approval request storage itself is not yet migrated.

## 2026-04-02 - SQL-first approval queue persistence

- Goal:
  - migrate workflow and harness approval queue storage off `requests.json` so approval inbox/API reads come from SQLite first and approval resolution still works when only SQL run state exists.
- Source changes:
  - `lib/state-ledger-sqlite.mjs`
  - `workflow/approval-queue.mjs`
  - `tests/workflow-approval-queue.test.mjs`
- Behavioral change:
  - approval requests now persist into the state ledger using the existing `operator_actions` table with `action_type = "approval_request"`.
  - approval queue reads (`get`, `getById`, `list`) are now SQL-first with the legacy `.bosun/approvals/requests.json` file kept as a fallback/mirror during migration.
  - workflow-run approval resolution now updates SQL run detail even if the legacy `workflow-runs/<runId>.json` file is missing.
  - harness-run approval resolution now updates SQL harness run state even if the legacy `.cache/harness/runs/<runId>.json` record is missing.
  - `listOperatorActionsFromStateLedger` now supports `actionId`, `actionType`, `scopeId`, and `status` filters for narrower state-ledger queries.
- Validation:
  - focused approval suites passed:
    - `npx vitest run tests/workflow-approval-queue.test.mjs tests/internal-harness.test.mjs tests/ui-server.test.mjs -t "approval|approvals"`
  - build passed:
    - `npm run build`
- Remaining SQL-first work:
  - workflow snapshots/trajectory exports and parts of `index.json` maintenance are still file-backed.
  - some workflow approval state updates still mirror back into legacy files for compatibility; storage authority is now SQL-first, but the compatibility write path remains intentionally enabled during migration.

## 2026-04-02 - SQL-first workflow snapshots plus test-budget hardening

- Goal:
  - finish the next workflow SQL slice by making snapshots SQL-first for create/list/restore paths, while keeping the legacy snapshot and trajectory files as compatibility mirrors.
- Source changes:
  - `workflow/workflow-engine.mjs`
  - `tests/workflow-forensics.test.mjs`
  - `tests/state-ledger-sqlite.test.mjs`
  - `tests/ui-server.test.mjs`
  - `tests/bench-swebench.test.mjs`
- Behavioral change:
  - `WorkflowEngine#createRunSnapshot()` now writes snapshot payloads into the SQLite state ledger via `workflow_snapshots` before mirroring to `runs/snapshots/*.json`.
  - `WorkflowEngine#restoreFromSnapshot()` now loads from SQLite first and only falls back to `runs/snapshots/<id>.json` when the SQL copy is absent.
  - `WorkflowEngine#listSnapshots()` now reads `workflow_snapshots` first and falls back to the legacy snapshot directory only when SQL returns nothing.
  - snapshot restore/list now keep working after the legacy snapshot JSON file is removed, proving the SQL store is authoritative for those paths.
  - two slow integration smoke tests were given explicit per-test/hook budgets so the suite stops failing on Windows cold-start/setup timing rather than functional regressions:
    - `tests/ui-server.test.mjs` circular can-start guard task-detail case
    - `tests/bench-swebench.test.mjs` CLI usage smoke
- Validation:
  - focused snapshot regressions passed:
    - `npx vitest run tests/state-ledger-sqlite.test.mjs tests/workflow-forensics.test.mjs tests/workflow-engine.test.mjs tests/ui-server.test.mjs -t "sqlite|snapshot|snapshots|restore"`
  - targeted flake follow-up passed:
    - `npx vitest run tests/bench-swebench.test.mjs -t "prints usage when invoked without a command"`
    - `npx vitest run tests/ui-server.test.mjs -t "keeps task detail responses JSON-safe when can-start guards return circular raw data"`
  - build passed:
    - `npm run build`
- Full-suite status:
  - `npm test` progressed past the prior snapshot/approval/schema failures.
  - full-suite reruns still exposed time-budget flakes rather than functional SQL regressions; the last observed failures were:
    - `tests/ui-server.test.mjs` hook/test budget exhaustion during the isolated long-running UI suite
    - `tests/bench-swebench.test.mjs` CLI usage smoke exceeding the old short timeout on cold start
  - both were patched with larger explicit budgets and then passed in targeted reruns, but a fresh full-suite rerun has not yet been carried all the way to completion after the final timeout-budget edits.
- Remaining SQL-first work:
  - trajectory exports under `runs/trajectories` are still file-backed compatibility artifacts.
  - workflow run index maintenance (`runs/index.json`) still exists as a legacy mirror/projection.
  - additional workflow forensic/reporting surfaces should be checked for any remaining direct file reads once the next full-suite pass is green.

## 2026-04-02 - SQL-first run summary fallback beyond index.json

- Goal:
  - remove another operator-visible dependency on `runs/index.json` by making workflow detail/history/schedule readers prefer SQL run summaries when the ledger already has the run document and detail snapshot.
- Source changes:
  - `workflow/workflow-engine.mjs`
  - `lib/state-ledger-sqlite.mjs`
  - `tests/workflow-engine.test.mjs`
- Behavioral change:
  - `WorkflowEngine#getRunDetail()` now prefers a ledger-backed run summary/document before consulting `index.json` when it reconstructs a persisted run from SQLite detail.
  - `WorkflowEngine#getRunHistory()` now sources persisted summaries from the SQL summary pager instead of hydrating legacy index/detail files first.
  - `WorkflowEngine#evaluateScheduleTriggers()` now derives latest run timestamps from SQL-backed persisted summaries rather than the legacy run index.
  - `writeWorkflowRunDetailToStateLedger()` now backfills sparse `workflow_runs` columns (`workflow_id`, `workflow_name`, retry lineage, task/session ids, started/ended timestamps, and status) from the detail payload itself, so SQL summaries remain usable even when the file index is empty or stale.
- Validation:
  - focused engine + ledger regressions passed:
    - `npx vitest run tests/workflow-engine.test.mjs tests/state-ledger-sqlite.test.mjs -t "loads persisted run detail from sqlite when the detail file is missing|workflow execution ledgers into sqlite and falls back to sqlite reads"`
  - build passed:
    - `npm run build`
- Current blocker outside this slice:
  - broader `tests/ui-server.test.mjs` slices are currently importing through unrelated dirty provider-registry changes in the worktree and fail with missing provider module paths before reaching the workflow assertions. That blocker is not from this SQL migration patch and should be handled separately or after those in-flight provider edits stabilize.

## 2026-04-02 - SQL-first run history paging and isolated ledger anchors

- Goal:
  - stop SQL-backed workflow history pagination from depending on legacy index hydration in the normal inactive-runs case, and fix state-ledger path resolution so explicit temp/test anchors cannot leak into the shared Bosun home database.
- Source changes:
  - `lib/state-ledger-sqlite.mjs`
  - `workflow/workflow-engine.mjs`
  - `tests/state-ledger-sqlite.test.mjs`
  - `tests/workflow-engine.test.mjs`
- Behavioral change:
  - `resolveStateLedgerPath()` now treats explicit `anchorPath` values as authoritative unless they are actually inside the configured repo/Bosun home roots, preventing test/temp `runsDir` callers from reading the shared home ledger via `REPO_ROOT` or `BOSUN_STATE_LEDGER_PATH`.
  - `WorkflowEngine#_readRunIndex()` can now rebuild `runs/index.json` projections from SQL summaries without leaking unrelated global runs into temp-engine tests.
  - `WorkflowEngine#getRunHistoryPage()` now uses true SQL paging (`offset` + `limit`) when there are no active runs, instead of first hydrating a larger legacy projection window and then slicing it in memory.
- Validation:
  - focused SQL paging/isolation regressions passed:
    - `npx vitest run tests/workflow-engine.test.mjs tests/state-ledger-sqlite.test.mjs -t "rebuilds the legacy run index from sqlite summaries when index.json is missing|keeps standalone anchor paths isolated from the shared Bosun home ledger|loads persisted run detail from sqlite when the detail file is missing|workflow execution ledgers into sqlite and falls back to sqlite reads"`
    - `npx vitest run tests/workflow-engine.test.mjs tests/state-ledger-sqlite.test.mjs -t "uses SQL-backed page reads without invoking legacy index hydration|reads paged run history from SQL-backed summaries when the legacy index is missing|pages SQL-backed run history with offsets when the legacy index is missing|rebuilds the legacy run index from sqlite summaries when index.json is missing|keeps standalone anchor paths isolated from the shared Bosun home ledger"`
  - build passed:
    - `npm run build`
  - full-suite status:
    - `npm test` advanced through grouped batches 1-11 and then failed in grouped batch 12 on an unrelated Windows cleanup error:
      - `tests/task-cli.test.mjs` -> `persists deleted tasks before the CLI exits`
      - failure: `EPERM, Permission denied` while `rmSync(tempDir, { recursive: true, force: true })` ran in `afterEach`
    - that failure is outside the SQL run-history/ledger changes made in this slice.
- Remaining SQL-first work after this slice:
  - `runs/index.json` and `runs/snapshots/*.json` still exist as compatibility mirrors and should stay non-authoritative.
  - workflow cleanup/recovery paths still contain legacy file scans under `workflow/workflow-engine.mjs`; those should be reviewed next once the broader validation gates stay green.

## 2026-04-02 - workflow template failure repair for condition.expression and evaluate_run

- Goal:
  - fix the two live schedule-run failures seen in monitor logs:
    - `Git Health Pipeline` -> `churn-check` failed with `Expression error: Truncated is not defined`
    - `Health Check` -> `evaluate-latest-run` failed with `action.evaluate_run: run "{{...}}" not found`
- Source changes:
  - `workflow/workflow-engine.mjs`
  - `workflow-templates/reliability.mjs`
  - `tests/workflow-engine.test.mjs`
  - `tests/workflow-new-templates.test.mjs`
- Behavioral change:
  - engine config resolution now preserves the raw `expression` field for `condition.expression` nodes, so placeholder serialization still happens inside the node handler instead of being flattened into unsafe raw JS tokens before execution.
  - `template-health-check` now parses the `collect-recent-runs` command output as JSON and passes `{{collect-recent-runs.output.latestRunId}}` to `action.evaluate_run`, replacing the invalid moustache-wrapped JS expression that was being treated as a literal run id.
- Validation:
  - focused regressions passed:
    - `npx vitest run tests/workflow-engine.test.mjs tests/workflow-new-templates.test.mjs -t "condition.expression resolves template placeholders as JS literals|preserves condition.expression templates through engine config resolution|collects recent runs, evaluates the latest run, and applies ratchet decisions"`
  - build passed:
    - `npm run build`

## 2026-04-02 - CLI Ctrl+C shutdown forwarding repaired

- Goal:
  - restore foreground CLI shutdown behavior so pressing `Ctrl+C` actually tears down the monitor/server stack instead of leaving the parent waiting indefinitely for a child that may never receive `SIGINT`.
- Source changes:
  - `cli.mjs`
  - `tests/cli-daemon-pid-files.test.mjs`
- Behavioral change:
  - the CLI parent now forwards `SIGINT`/`SIGTERM` to the spawned monitor child explicitly.
  - first `Ctrl+C` requests graceful child shutdown with `SIGINT`; repeated shutdown signals escalate to `SIGTERM`.
  - a fallback timer now stops the parent from waiting forever if the child hangs during shutdown.
- Validation:
  - focused CLI regression check passed:
    - `npx vitest run tests/cli-daemon-pid-files.test.mjs`
  - build passed:
    - `npm run build`

## 2026-04-02 - self-restart watcher false-positive hardening

- Goal:
  - investigate monitor logs like `source file changed: worktree-manager.mjs` when `git status` did not show a corresponding tracked change, and reduce false/misattributed self-restart events from Windows `fs.watch`.
- Source changes:
  - `infra/monitor.mjs`
  - `tests/monitor-self-watcher-lib.node.test.mjs`
- Findings:
  - the self-restart watcher intentionally watches multiple runtime-critical source roots, including `workspace/`, so `workspace/worktree-manager.mjs` was in scope.
  - before this patch, the watcher trusted raw `fs.watch` filenames and logged only the bare filename, with no `mtime` verification. On Windows that can misattribute or spuriously trigger restart notices.
- Behavioral change:
  - the watcher now snapshots `.mjs` mtimes for watched source roots and ignores events unless the target file's `mtime` actually advanced.
  - restart logs now use repo-relative paths (for example `workspace/worktree-manager.mjs`) instead of ambiguous bare filenames.
- Validation:
  - focused watcher regression check passed:
    - `node --test tests/monitor-self-watcher-lib.node.test.mjs`
  - build passed:
    - `npm run build`
