# Website Module Guide

## Scope
Public website and docs pages (`bosun.engineer`) static assets.

## Start Files
- `site/index.html` - main landing page.
- `site/docs/` - generated docs pages/assets.
- `site/ui/` - demo UI pages used in smoke checks.

## Common Task Routing
- Marketing page updates -> `index.html` + `site/css/` and `site/js/`.
- Docs publishing pipeline -> `tools/build-docs.mjs`, `_docs/`, `site/docs/`.
- Demo/smoke failures -> `site/ui/demo.html`, CI/test hooks.

## Validation
- Build docs: `npm run build:docs`
- Full checks: `npm test && npm run build`
