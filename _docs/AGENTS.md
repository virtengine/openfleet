# _docs Source Guide

## Scope
Authoritative long-form markdown source docs used for generated/published docs.

## Start Files
- `_docs/WORKFLOWS.md`
- `_docs/VERIFICATION_CHECKLIST.md`
- `_docs/KANBAN_GITHUB_ENHANCEMENT.md`
- `_docs/SHARED_STATE_INTEGRATION.md`

## Common Task Routing
- Product/system behavior docs -> update here first.
- Public docs sync -> follow with `npm run build:docs` to refresh `site/docs/`.
- Historical notes/research -> keep dated files in `_docs/` with clear titles.

## Validation
- Regenerate docs: `npm run build:docs`
- Smoke full checks when behavior is documented with code changes: `npm test && npm run build`
