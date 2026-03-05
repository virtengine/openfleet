# Lib Folder Guide

## Scope
Shared lightweight helpers used across modules.

## Start Files
- `lib/logger.mjs` - shared logging wrapper.

## Common Task Routing
- Logging format/transport behavior -> update `logger.mjs` and call sites.
- Keep this folder dependency-light to avoid circular imports.

## Validation
- Run tests covering touched call paths, then `npm test`.
