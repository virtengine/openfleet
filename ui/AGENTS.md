# Mini App UI Guide

## Scope
Frontend assets for Bosun setup and control dashboard served by `server/ui-server.mjs`.

## Start Files
- `ui/index.html` - primary app shell.
- `ui/app.js` - main client logic.
- `ui/styles.css` - core styles.
- `ui/setup.html` - setup screen.
- Legacy variants: `app.legacy.js`, `app.monolith.js`, `styles.monolith.css`.

## Common Task Routing
- Visual/layout regressions -> `styles.css` + matching HTML surface.
- API-driven UI bugs -> `app.js` + server endpoint in `server/ui-server.mjs`.
- Setup-specific UI behavior -> `setup.html`, `app.js`, `setup.mjs`.

## Validation
- UI tests: `npm test -- tests/*ui*.test.mjs`
- Manual smoke: run `node cli.mjs`, open Mini App, verify target flow.
