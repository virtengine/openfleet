# Server Module Guide

## Scope
HTTP services for setup, Mini App, and Playwright inspection endpoints.

## Start Files
- `server/ui-server.mjs` - main HTTP API + web UI backend.
- `server/setup-web-server.mjs` - setup portal backend.
- `server/playwright-ui-server.mjs` - Playwright UI test server.
- `server/playwright-ui-inspect.mjs` - inspection/debug server.

## Common Task Routing
- API endpoint behavior -> `ui-server.mjs` (+ related module in `task/`, `workflow/`, or `infra/`).
- Setup onboarding bugs -> `setup-web-server.mjs`, `setup.mjs`, `config/`.
- Test UI server issues -> `playwright-ui-server.mjs`, `playwright.config.mjs`.

## Tests
- Focused: `npm test -- tests/*ui*.test.mjs tests/*setup*.test.mjs`
- Full: `npm test`
