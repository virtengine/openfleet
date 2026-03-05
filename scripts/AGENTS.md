# Scripts Folder Guide

## Scope
One-off or migration-oriented utility scripts not in the main `tools/` pipeline.

## Start Files
- `scripts/migrate-modules.mjs`
- `scripts/fix-test-mocks.mjs`
- `scripts/fix-dirname-paths.mjs`
- `scripts/mutation-report.mjs`

## Common Task Routing
- Mechanical refactors/migrations -> prefer scripts here or `tools/` equivalents.
- Mutation report processing -> `mutation-report.mjs`.
- If a script becomes part of recurring CI/hook workflow, move or mirror it in `tools/`.

## Safety
- Dry-run where possible before broad rewrites.
- Re-run targeted tests after script-driven edits.
