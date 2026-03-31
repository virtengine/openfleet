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
