# GitHub Integration Guide

## Scope
GitHub App auth, OAuth, marketplace/webhook handling, and trust guards.

## Start Files
- `github/github-auth-manager.mjs` - auth strategy and token selection.
- `github/github-app-auth.mjs` - app JWT + installation token flow.
- `github/github-oauth-portal.mjs` - OAuth web flow.
- `github/marketplace-webhook.mjs` - marketplace events.
- `github/issue-trust-guard.mjs` - issue/repo safety checks.

## Common Task Routing
- Token/auth failures -> `github-auth-manager.mjs`, `github-app-auth.mjs`.
- OAuth callback/session bugs -> `github-oauth-portal.mjs`, `server/ui-server.mjs`.
- Marketplace entitlement issues -> `marketplace-webhook.mjs`.

## Tests
- Focused: `npm test -- tests/*github*.test.mjs tests/*marketplace*.test.mjs`
- Full: `npm test`
