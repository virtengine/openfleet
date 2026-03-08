# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog,
and this project adheres to Semantic Versioning.

## [0.40.6] - 2026-03-08

### Features
- Added task status persistence, runtime snapshots, richer execution metadata, and runtime management improvements for task handling.
- Added epic dependency management across the task store, API, CLI update flow, and UI.
- Added sprint execution and task ordering modes, sprint management endpoints, and enhanced task DAG retrieval.
- Added Jira-style task detail improvements, richer metadata fields, and expanded subtask management flows.
- Added cooperative workflow cancellation, stricter workflow start guards, and broader workflow task filtering behavior.
- Added support for serving shared `/lib` modules from the UI server and improved chat/manual draft handling with a JSON-RPC compatibility shim.
- Added failover and recovery improvements for primary and adapter agent sessions.
- Added Kanban board enhancements, including improved column loading behavior and broader task management updates.

### Fixes
- Fixed monitor workflow scheduling by hoisting the poll helper scope and ensuring automation polls start during monitor startup.
- Fixed workflow profile selection, schedule polling on startup, task trigger polling, and downstream gating when trigger conditions evaluate false.
- Fixed workflow task dispatch initialization by binding task claims and dispatch context earlier in the automation flow.
- Fixed worktree acquisition and PR creation edge cases by falling back unresolved base branches and always passing `--body` to `gh pr create`.
- Fixed workspace and runtime path resolution by correcting config-dir, repo-root, and AppData workspace command precedence.
- Fixed Git environment leakage in workspace sync and hook-safe commit detection paths, and repaired Git config corruption in the pre-push hook and worktree manager.
- Fixed empty external task issue creation in the Kanban integration.
- Fixed task detail string replacement behavior and related modal data handling regressions.

### Refactors
- Removed unused workflow task trace hook initialization.
- Removed unused demo API routes.
- Refactored tool discovery and execution flow to simplify agent tooling behavior.

### Docs
- Added monitor recovery, health check, and incident log updates for Bosun environment stability work.
- Added documentation encouraging users to star the project and included a star history chart.

### Tests
- Added regression coverage for Kanban scroll behavior and legacy task handling.
- Added workflow tests for Git environment sanitization and stabilized `create_pr` base-branch checks.
- Added Playwright smoke coverage for the portal UI.
- Expanded CLI daemon PID tracking and task store DAG test coverage.

### Chores
- Updated package versions through the `0.40.x` release line.
- Bumped the `npm_and_yarn` dependency group across both package directories.
