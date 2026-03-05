# Voice Module Guide

## Scope
Voice session tooling, relay/auth flows, and action dispatch integration.

## Start Files
- `voice/voice-relay.mjs` - voice transport relay.
- `voice/voice-auth-manager.mjs` - auth and token management.
- `voice/voice-action-dispatcher.mjs` - action routing from voice events.
- `voice/voice-tools.mjs` - tool registration and capabilities.
- `voice/vision-session-state.mjs` - vision/voice shared session state.

## Common Task Routing
- Voice call/session failures -> `voice-relay.mjs`, `voice-auth-manager.mjs`.
- Tool invocation regressions -> `voice-tools.mjs`, `voice-action-dispatcher.mjs`.
- Provider parity checks -> voice tests plus `shell/` provider modules.

## Tests
- Focused: `npm test -- tests/voice-*.test.mjs tests/native-call-parity-checklist.test.mjs`
- Full: `npm test`
