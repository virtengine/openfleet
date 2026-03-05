# Docs Module Guide

## Scope
Human-facing markdown docs for operation, setup, and subsystem deep dives.

## Start Files
- `docs/agent-logging-quickstart.md`
- `docs/agent-work-logging-design.md`
- `docs/setup-portal.md`
- `docs/workflows-and-libraries.md`

## Related Sources
- Long-form source docs live in `_docs/`.
- Generated/published pages live in `site/docs/`.

## Common Task Routing
- Product docs edits -> update `docs/` and mirror source updates in `_docs/` if needed.
- Website docs mismatch -> run `npm run build:docs` after edits.

## Validation
- Docs build: `npm run build:docs`
- Repo checks: `npm test && npm run build`
