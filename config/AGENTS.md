# Config Module Guide

## Scope
Configuration loading, validation, diagnostics, and repo-root normalization.

## Start Files
- `config/config.mjs` - main config resolution pipeline.
- `config/config-doctor.mjs` - diagnostics/health checks.
- `config/repo-config.mjs` - repo-level config normalization.
- `config/repo-root.mjs` - root/path discovery logic.
- `config/context-shredding-config.mjs` - context shredding knobs.

## Common Task Routing
- Env/config precedence issues -> `config.mjs` + `.env.example`.
- Setup/config migration -> `setup.mjs`, `config-doctor.mjs`.
- Path/workspace resolution bugs -> `repo-root.mjs`, `workspace/` modules.

## Tests
- Focused: `npm test -- tests/*config*.test.mjs tests/*setup*.test.mjs`
- Full: `npm test`
