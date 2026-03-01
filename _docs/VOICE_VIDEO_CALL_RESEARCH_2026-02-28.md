# Voice + Video Call Integration Research (2026-02-28)

## Goal

Enable Bosun's existing live voice mode to optionally include:

- Screen share context (high utility for coding workflows)
- Camera context (optional)
- Real-time tool execution continuity (already implemented)

This brief maps provider capabilities to Bosun's current architecture and proposes an implementation path.

## Current Bosun State

Bosun already has a solid Tier 1 real-time voice stack:

- Browser voice client uses WebRTC + data channel (`ui/modules/voice-client.js`, starts at line 70).
- Voice session token and tool calls flow through:
  - `POST /api/voice/token` (`ui-server.mjs:7734`)
  - `POST /api/voice/tool` (`ui-server.mjs:7748`)
- Server relay supports OpenAI and Azure Realtime session provisioning (`voice-relay.mjs`).
- Voice config exists in schema/env/settings, but only for audio/provider/turn detection (no video/screen controls yet):
  - `bosun.schema.json:43`
  - `ui/modules/settings-schema.js:112`
  - `.env.example:143`

Key observation: current client acquires microphone only via `getUserMedia({ audio: ... })` and does not capture or transmit screen/camera frames.

## Provider Capability Snapshot (as researched on 2026-02-28)

### OpenAI Realtime

- Realtime API supports low-latency interaction over WebRTC/WebSocket/SIP.
- Realtime conversations support text + image inputs, and realtime models support function calling.
- OpenAI's `gpt-realtime` line is the direction for native realtime multimodal support.

Practical implication for Bosun: keep your existing WebRTC audio path and add image/frame injection as conversation items for visual context.

### Google Gemini Live API

- Gemini Live API supports low-latency bidirectional voice/video interactions.
- Live API docs include web camera + screen-share use cases and function calling.
- Session limits differ by modality (notably shorter for audio+video than audio-only), so reconnection/session-rolling strategy is required.

Practical implication: strongest native "live video call" fit, but requires provider-specific client path and session lifecycle logic.

### Anthropic Claude API

- Claude API strongly supports image understanding in Messages API (URL/base64 images in request content).
- Streaming is primarily Messages API streaming (SSE).
- No first-class public realtime voice/video session API is documented in the same style as OpenAI/Gemini realtime sessions.

Practical implication: best immediate Claude path is periodic/smart screenshot ingestion + response summaries, not a native live audio/video transport.

### Optional infra abstraction (LiveKit)

- LiveKit exposes agent integrations/plugins for OpenAI and Gemini realtime use cases.
- Could provide provider-agnostic room/session plumbing later, if Bosun wants multi-party or broader RTC control.

## Architecture Options

## Option A: Screenshot polling (your 1 FPS idea)

How:

- Capture screen via `getDisplayMedia`.
- Sample frames at fixed interval (e.g. 1 fps).
- Downscale + JPEG/WebP compress in browser.
- Send to server/model as image input.

Pros:

- Fastest path to value.
- Works with all providers (including Claude via Messages vision).
- Minimal disruption to current voice stack.

Cons:

- Temporal lag/missed fast UI transitions.
- Can get expensive in tokens if unbounded.
- Harder to "feel" like a true live call unless adaptive.

Verdict: best Phase 1 baseline.

## Option B: Native live video provider path

How:

- Build provider-specific path (especially Gemini Live API) for camera/screen streaming.

Pros:

- Most "real video call" experience.
- Lowest perceived latency when provider supports video natively.

Cons:

- Provider divergence increases maintenance.
- Session-limit handling and fallback complexity.

Verdict: best Phase 2 after Phase 1 proves UX and demand.

## Option C: RTC abstraction layer (e.g., LiveKit)

How:

- Introduce room/media layer independent from model provider.
- Bridge tracks/events to provider adapters.

Pros:

- Scales to multi-user, recording, richer controls.
- Reduces provider lock-in over time.

Cons:

- Higher implementation and ops overhead.

Verdict: Phase 3+ only if product scope expands.

## Recommended Strategy

1. Ship "Voice + Vision Lite" first (adaptive screenshot pipeline).
2. Add provider-specific native live video where it has clear advantage (Gemini path).
3. Keep Claude integrated through screenshot vision bridge.

This gives the fastest path to user-visible wins while preserving optionality.

## Proposed Phase Plan

### Phase 1 (2-4 days): Voice + Vision Lite (adaptive frames)

Add new feature-flagged pipeline:

- Browser capture source: `screen | camera | off`.
- Adaptive FPS:
  - idle: 1 fps
  - active user interaction: 2-4 fps burst
- Compression target:
  - max dimension: 1024-1280
  - JPEG/WebP quality: 0.45-0.70
- Only send frame when perceptual hash delta crosses threshold (skip near-duplicates).

Code touchpoints:

- `ui/modules/voice-client.js`
  - capture controls
  - frame scheduler
  - payload send path
- `ui/modules/voice-overlay.js`
  - UI toggles (Share Screen / Camera / Stop)
  - capture status indicator
- `ui-server.mjs`
  - add `POST /api/vision/frame` (auth + rate limit + provider dispatch)
- `voice-relay.mjs`
  - add provider-aware vision dispatch helper

### Phase 2 (3-7 days): Native live video path

- Add optional Gemini Live adapter for true audio+video sessions.
- Keep OpenAI path on audio realtime + image-keyframe injection unless/until direct video track support is preferred in your UX.
- Add automatic fallback to Phase 1 screenshot mode on capability mismatch.

### Phase 3 (optional): RTC abstraction

- Evaluate LiveKit-based transport unification.
- Consider multi-agent or multi-view scenarios.

## Config Additions (proposed)

Add to schema + settings + env example:

- `VOICE_VIDEO_ENABLED=true|false`
- `VOICE_VIDEO_SOURCE=off|screen|camera`
- `VOICE_VIDEO_FPS_IDLE=1`
- `VOICE_VIDEO_FPS_ACTIVE=3`
- `VOICE_VIDEO_MAX_WIDTH=1280`
- `VOICE_VIDEO_IMAGE_FORMAT=jpeg|webp`
- `VOICE_VIDEO_IMAGE_QUALITY=0.6`
- `VOICE_VIDEO_SEND_ON_CHANGE_ONLY=true`
- `VOICE_VIDEO_MIN_HASH_DELTA=0.08`
- `VOICE_VIDEO_PROVIDER_MODE=auto|openai_images|gemini_live|claude_vision`

## Security/Privacy Requirements

- Explicit user gesture required for capture start.
- Persistent, obvious "capturing" indicator.
- One-tap stop capture.
- No frame persistence by default.
- Optional debug persistence behind explicit opt-in.
- Rate limits server-side to prevent runaway upload/token burn.

## Why this is the best first move

- Your current architecture already has 80% of the control plane (voice session, tool execution, overlay UX, server relay).
- Adaptive screenshot vision adds visual intelligence with lowest risk and fastest iteration.
- You can then layer true live video where provider support is strongest.

## Immediate Build Checklist

1. Add schema/env/settings keys for video controls.
2. Implement capture + compression + adaptive frame loop in `voice-client.js`.
3. Add `/api/vision/frame` endpoint + provider dispatch.
4. Wire overlay controls and state indicators.
5. Add guardrails (rate limit, size cap, disable-on-error fallback).
6. Add tests:
   - config parsing
   - frame throttling/change-detection logic
   - endpoint validation/rate limiting
   - voice session remains stable when video capture errors.
