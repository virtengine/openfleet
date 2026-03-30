# Bosun Copilot Instructions

Bosun is a Node.js ESM control plane for autonomous software engineering. It ships a CLI, setup wizard, long-running monitor, workflow engine, task/workspace orchestration, GitHub/Jira integrations, Telegram and WhatsApp channels, a browser Mini App, an Electron desktop shell, and a static docs/marketing site. The repo is large and multi-surface; most changes should stay inside one module plus its direct tests.

## Start Here

- Always read `AGENTS.md` at the repo root first, then the closest module `AGENTS.md` before editing.
- Prefer Node 24 locally to match CI. Docs say Node 18+ works; this repo was validated here with Node `v24.11.1` and npm `11.6.2` on Windows.
- Always run `npm install` before any build or test command. `postinstall.mjs` applies compatibility checks/shims, may install `desktop/` dependencies, and auto-installs `.githooks` when possible.
- Keep the worktree clean before trusting failures. This repo has string/snapshot-style guard tests, so unrelated local edits can make `npm test` fail in ways that do not reflect your change.
- On Windows, prefer PowerShell for npm/node commands. If you must run `.githooks/pre-push` directly in a worktree, use Git for Windows bash instead of WSL bash.

## Verified Command Order

Bootstrap:

- `npm install`  
	Verified success. Always do this first.

Fast local validation:

- `npm run syntax:check`  
	Verified success in ~2s. This uses `tools/syntax-check.mjs`, rejects browser-served modules with top-level `await`, and validates local import/export bindings for browser `.js` and `.mjs` files under `ui/` and `site/ui/`.
- `npm run prompt:lint`  
	Verified success in <1s. Run this whenever you touch prompts, hooks, agent instructions, or `.bosun/agents` content.
- `node cli.mjs --help`  
	Verified success. Use this for a cheap CLI sanity check.

Build and packaging validation:

- `node tools/prepublish-check.mjs` or `npm run prepublishOnly`  
	Verified via `npm run prepublishOnly` in ~26s. This is important: if you add a new published runtime file imported by shipped code, you must also add it to `package.json` `files`, or this check fails.
- `npm run build`  
	Verified success in <1s. This is a vendor sync/build step, not a TypeScript compile.
- `npm run build:docs`  
	Verified success in <1s. Run this when changing `_docs/`, docs generation, or the site docs pipeline.

Tests:

- `npm test`  
	Runs Vitest only, and `pretest` already runs `npm run syntax:check` first. In this workspace it took ~185s but failed because the worktree already contained unrelated edits under `infra/monitor.mjs`; do not assume that specific failure is caused by your change.
- `npm run test:node`  
	Verified success in ~17s. Run this for `*.node.test.mjs`, portal smoke, and Node-runtime behaviors.
- `npm run test:all`  
	Use this when your change can affect both Vitest suites and Node test suites.
- Focused example that passed here:  
	`npm test -- tests/config-validation.test.mjs tests/workflow-templates-e2e.test.mjs -- -t "template-bosun-pr-watchdog installs, executes, and returns valid context"`  
	Took ~170s. Some workflow-template tests print expected stderr when external creds like `GITHUB_PERSONAL_ACCESS_TOKEN` or `EXA_API_KEY` are absent.
- `npm run check:native-call-parity`  
	Verified success in ~4s. CI runs this separately; do not skip it for voice/native-call changes.
- `npm run audit:ci`  
	Verified success but expensive here (~16 min). Run it when touching codebase-audit behavior, CLAUDE summaries/manifests, or when CI has `BOSUN_AUDIT_CI=1` enabled.

Run commands:

- `npm run site:serve`  
	Verified success; served the site locally at `http://127.0.0.1:4173`.
- `npm run setup` starts the web setup wizard. `npm start` runs `node cli.mjs --config-dir .bosun --repo-root . --no-update-check` and expects repo-local config/state.

## CI / Hook Gates To Mirror

- Main CI is `.github/workflows/ci.yaml` on Node 24. It runs: `npm ci`, `node tools/prepublish-check.mjs`, `npm run prompt:lint`, `npm run smoke:packed-cli`, `npm run build`, optional `npm run audit:ci`, `npm run check:native-call-parity`, then `npm test`.
- Local pre-commit runs `npm run syntax:check` and `npm run prompt:lint`, then warns if staged source files are missing `CLAUDE:SUMMARY` annotations.
- Local pre-push always runs syntax, prepublish check, and packed CLI smoke, then chooses targeted tests or the full suite based on changed files.
- If you add a new module or test file, update `ADJACENCY_MAP` in `.githooks/pre-push` so smart pre-push routing can still find the right tests.
- Site deploy uses Node 20 and resolves the local `site/ui` symlink into a real copy before publishing; remember that GitHub Pages will not follow symlinks.
- Hosted demo fixes often require touching both `ui/` and `site/ui/`. If a site tab imports a helper from `site/ui/tabs/`, make sure the file actually exists there rather than only in `ui/tabs/`.

## High-Signal Layout

- `cli.mjs`: main CLI/router and first-run behavior.
- `setup.mjs`: interactive/non-interactive setup, env/config generation, hook scaffolding.
- `infra/`: monitor loop, restart/recovery, runtime services.
- `workflow/`: engine, node registry, migration, workflow APIs.
- `workflow-templates/`: built-in reusable templates and pipeline helpers.
- `task/`: task execution, claims, archiving, CLI.
- `workspace/`: workspaces, worktrees, shared state, context indexing.
- `agent/`: agent pool, prompts, hooks, reports, fleet coordination.
- `shell/`: Codex/Copilot/Claude/OpenCode executor integrations.
- `server/` and `ui/`: Mini App backend/frontend and setup UI.
- `github/`, `kanban/`, `telegram/`, `voice/`: integrations.
- `site/`: public website and generated docs output.
- `tools/`: syntax, docs build, prepublish, vendor sync, hook utilities.
- `tests/`: Vitest and Node suites; `vitest.config.mjs` excludes `*.node.test.mjs` from `npm test`.

Important config files:

- `package.json`: scripts, exports, publishable `files` list.
- `.env.example`: required/optional environment variables and security-sensitive defaults.
- `bosun.config.example.json` and `bosun.schema.json`: config shape references.
- `vitest.config.mjs`, `playwright.config.mjs`, `stryker.config.mjs`: test tooling.
- `.github/workflows/*.yml`: CI, publish, Docker, site deploy, mutation testing, PR automation.
- `.github/hooks/bosun.hooks.json`: Copilot hook bridge integration.

## Change Routing

- Config/setup changes: run `npm test -- tests/*config*.test.mjs tests/*setup*.test.mjs`.
- Workflow engine/template changes: run `npm test -- tests/workflow-*.test.mjs tests/workflow-templates*.test.mjs`.
- Workspace/shared-state changes: run `npm test -- tests/workspace-*.test.mjs tests/worktree-*.test.mjs tests/shared-state*.test.mjs`.
- Task changes: run `npm test -- tests/task-*.test.mjs tests/*task*.test.mjs`.
- Server/UI/setup changes: run `npm test -- tests/*ui*.test.mjs tests/*setup*.test.mjs` and `npm run test:node` when portal smoke/runtime is involved.
- Infra/monitor/restart changes: run `npm test -- tests/*monitor*.test.mjs tests/*restart*.test.mjs`.

## Do Not Re-discover This

- Trust this file first. Only search the repo when these instructions are incomplete, contradicted by the nearest `AGENTS.md`, or proven wrong by a command/result in the current worktree.
