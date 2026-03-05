# Tools Module Guide

## Scope
Build, verification, release, and maintenance utility scripts.

## Start Files
- `tools/syntax-check.mjs` - syntax verification used by tests/hooks.
- `tools/prepublish-check.mjs` - release readiness checks.
- `tools/vendor-sync.mjs` - build/vendor sync pipeline.
- `tools/build-docs.mjs` - docs generation.
- `tools/workflow-orphan-worktree-recovery.mjs` - orphan worktree recovery helper.

## Common Task Routing
- Hook/prepush failures -> inspect corresponding tool script invoked by package.json.
- Docs generation issues -> `build-docs.mjs`, `_docs/`, `site/docs/`.
- Workflow maintenance tooling -> `workflow-orphan-worktree-recovery.mjs`.

## Validation
- Syntax only: `npm run syntax:check`
- Prepublish checks: `npm run prepublishOnly`
- Full checks: `npm test && npm run build`
