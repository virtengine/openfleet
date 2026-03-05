# Infra Module Guide

## Scope
Supervisor runtime loop, health checks, recovery logic, and operational services.

## Start Files
- `infra/monitor.mjs` - central runtime orchestrator.
- `infra/maintenance.mjs` - periodic maintenance actions.
- `infra/restart-controller.mjs` - restart policy and fail-safe behavior.
- `infra/stream-resilience.mjs` - stream lifecycle hardening.
- `infra/library-manager.mjs` - library state management.
- `infra/container-runner.mjs` - runtime/container checks.

## Common Task Routing
- Crashes/recovery loops -> `monitor.mjs`, `error-detector.mjs`, `restart-controller.mjs`.
- Startup and readiness -> `preflight.mjs`, `startup-service.mjs`, `fetch-runtime.mjs`.
- Presence/session drift -> `presence.mjs`, `session-tracker.mjs`, `sync-engine.mjs`.

## Tests
- Focused: `npm test -- tests/*monitor*.test.mjs tests/*restart*.test.mjs tests/*library*.test.mjs`
- Full: `npm test`
