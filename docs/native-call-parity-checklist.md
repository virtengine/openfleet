# Native Call Parity Checklist

This checklist defines the minimum acceptance bar for Bosun voice/video call behavior across:

- OpenAI (ChatGPT-style partner)
- Claude
- Gemini

Use this with `npm run check:native-call-parity`.

## Provider Coverage

| Provider | Voice Config | Token Path | Vision Path | Expected Tier |
| --- | --- | --- | --- | --- |
| OpenAI | `/api/voice/config` returns `provider=openai` | `/api/voice/token` succeeds (`200`) | `/api/vision/frame` returns `provider=openai` | `1` |
| Claude | `/api/voice/config` returns `provider=claude` | `/api/voice/token` fails with non-realtime provider message (`500`) | `/api/vision/frame` returns `provider=claude` | `2` |
| Gemini | `/api/voice/config` returns `provider=gemini` | `/api/voice/token` fails with non-realtime provider message (`500`) | `/api/vision/frame` returns `provider=gemini` | `2` |

## Acceptance Criteria

| ID | Capability | Measurable Requirement | Automated By |
| --- | --- | --- | --- |
| PARITY-001 | Provider matrix | OpenAI, Claude, and Gemini route checks all pass in one run. | `tests/voice-provider-smoke.test.mjs` |
| PARITY-002 | Voice config correctness | `/api/voice/config` returns `available=true` and expected `provider`/`tier` per provider. | `tests/voice-provider-smoke.test.mjs` |
| PARITY-003 | Token behavior | OpenAI token route returns `200`; Claude/Gemini token route returns `500` with provider-specific non-realtime error. | `tests/voice-provider-smoke.test.mjs` |
| PARITY-004 | Vision capability | `/api/vision/frame` returns `ok=true`, `analyzed=true`, and provider-specific result for all three providers. | `tests/voice-provider-smoke.test.mjs` |
| PARITY-005 | CI enforcement | Native parity checks must fail CI when any criterion above regresses. | `.github/workflows/ci.yaml` + `npm run check:native-call-parity` |

## Runbook

1. Local gate: `npm run check:native-call-parity`
2. Full validation: `npm test`
3. CI gate: GitHub `CI` workflow runs `check:native-call-parity` before full test suite.
