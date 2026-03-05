# Git Utilities Guide

## Scope
Git safety helpers, commit metadata helpers, and conflict resolution utilities.

## Start Files
- `git/git-safety.mjs` - safety checks and guardrails.
- `git/git-commit-helpers.mjs` - commit/PR metadata formatting.
- `git/conflict-resolver.mjs` + `git/sdk-conflict-resolver.mjs` - conflict tooling.
- `git/diff-stats.mjs` - diff analysis utilities.

## Common Task Routing
- Commit/metadata formatting issues -> `git-commit-helpers.mjs`.
- Rebase/conflict automation -> resolver modules + `fix-stuck-rebase.ps1`.
- Safety policy checks -> `git-safety.mjs`, `.githooks/`.

## Tests
- Focused: `npm test -- tests/*git*.test.mjs`
- Full: `npm test`
