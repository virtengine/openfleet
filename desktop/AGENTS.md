# Desktop Module Agent Guide

## Scope
Electron shell that launches Bosun's local UI server.

## Start Files
- `desktop/main.mjs` - app lifecycle, BrowserWindow creation.
- `desktop/launch.mjs` - dev launcher and Electron bootstrap.
- `desktop/preload.mjs` / `desktop/preload.cjs` - preload bridge.
- `desktop/package.json` - packaging/build settings.

## Related Runtime
- `server/ui-server.mjs` - backend the desktop shell starts.
- `infra/desktop-shortcut.mjs` / `infra/desktop-api-key.mjs` - desktop helpers.

## Typical Tasks
- Startup/boot issues: inspect `main.mjs` + `launch.mjs`.
- Native window behavior: inspect `main.mjs` + preload bridge.
- Packaging/distribution: inspect `desktop/package.json`.

## Validation
- Launch smoke test: `node desktop/launch.mjs`
- Full validation from repo root: `npm test && npm run build`
