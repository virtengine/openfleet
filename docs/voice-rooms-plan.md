# Voice Rooms — Multi-Participant Call Plan

> **Status:** Planning  
> **Area:** `bosun` — voice overlay, WebRTC signalling, Cloudflare integration

---

## 1. Goal

Enable multiple co-workers to join the same AI-agent voice call via a short-lived
shareable link, similar to Google Meet or Whereby. No sign-up required for guests.
The AI agent remains the "host" and all participants hear/speak to it together.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                       Cloudflare Calls (SFU)                           │
│                                                                         │
│   ┌──────────────┐     ┌──────────────┐     ┌──────────────────────┐   │
│   │  Host        │     │  Guest A     │     │  AI Agent track      │   │
│   │  (bosun UI)  │────▶│  (browser)   │────▶│  (server-side WebRTC │   │
│   │              │◀────│              │◀────│   or Responses API)  │   │
│   └──────────────┘     └──────────────┘     └──────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
          │                      │
          └──────────┬───────────┘
               WebSocket room bus
               /ws/voice/room/:roomId
```

Components:

- **Cloudflare Calls** (or LiveKit OSS self-hosted) — SFU for mixed audio tracks
- **Room API** — REST endpoints for create/join/list/close rooms
- **Signalling bus** — WebSocket room channel on the existing bosun WS server
- **Join portal** — lightweight static page at `GET /join/:token` (no auth required)

---

## 3. Room Lifecycle

```
Host creates room
  → POST /api/voice/rooms/create  { sessionId, expiresInMin: 120 }
  ← { roomId, shareUrl, token }

Guest follows shareUrl  (https://<host>/join/<token>)
  → GET /join/:token  (static or Preact page, no auth)
  → Guest picks display name, clicks "Join"
  → POST /api/voice/rooms/:roomId/join  { guestToken, displayName }
  ← { wsUrl, iceServers, trackId, participantToken }

Guest connects to Cloudflare Calls  (ICE + DTLS using participantToken)

Host UI shows participant pill: "Guest A joined"

Any participant leaves / call ends:
  → DELETE /api/voice/rooms/:roomId  (host only)  OR socket closes
  → Room GC cleans up after TTL
```

---

## 4. Token Design

Room tokens are signed JWTs (HS256, short secret per room):

```json
{
  "sub": "room:<roomId>",
  "iat": 1720000000,
  "exp": 1720007200,
  "role": "guest", // "host" | "guest"
  "maxParticipants": 8,
  "sessionId": "abc123" // the bosun session this room is bound to
}
```

- Generated server-side; never stored in DB — self-contained
- `exp` = `iat + expiresInMin * 60` (defaults: host 8 h, guest 2 h)
- The share URL encodes only the token: `https://<host>/join/<jwt>`
- Guests validate by verifying JWT signature; no DB lookup needed

---

## 5. API Endpoints

| Method   | Path                            | Auth         | Description                          |
| -------- | ------------------------------- | ------------ | ------------------------------------ |
| `POST`   | `/api/voice/rooms/create`       | user session | Creates room, returns shareUrl + JWT |
| `GET`    | `/api/voice/rooms/:roomId`      | room JWT     | Room metadata + participant list     |
| `POST`   | `/api/voice/rooms/:roomId/join` | room JWT     | Returns ICE config + track grants    |
| `DELETE` | `/api/voice/rooms/:roomId`      | host JWT     | Closes room, evicts all participants |
| `GET`    | `/join/:token`                  | none         | Guest join landing page              |

---

## 6. WebSocket Room Bus

Reuse the existing WS server (`ws.mjs`) with a new channel type:

```js
// Client → Server
{ type: "room:subscribe",  payload: { roomId, participantToken } }
{ type: "room:mute",       payload: { roomId, muted: true } }
{ type: "room:chat",       payload: { roomId, text } }

// Server → Clients (broadcast to room)
{ type: "room:participant-joined",  payload: { roomId, displayName, role } }
{ type: "room:participant-left",    payload: { roomId, displayName } }
{ type: "room:mute-change",         payload: { roomId, displayName, muted } }
{ type: "room:chat",                payload: { roomId, displayName, text } }
{ type: "room:closed",              payload: { roomId, reason } }
```

---

## 7. UI Changes Required

### `voice-overlay.js`

- "People" button (👥) in the `vm-bar` already exists (currently disabled)
- Clicking opens a `vm-participants-panel` sidebar:
  - List of participants (avatar initial + display name + muted state)
  - "Invite" button → copies `shareUrl` to clipboard with a toast
  - Host sees a "Remove" button next to each guest

### New component: `vm-invite-panel`

```
┌─────────────────────────────────┐
│ 👥 Participants (2)         ✕   │
├─────────────────────────────────┤
│ 🟢 You (host)                   │
│ 🟢 Alice                        │
├─────────────────────────────────┤
│ 🔗 Invite link                  │
│ https://host/join/eyJ…  [Copy]  │
│ Expires in 1h 42m               │
└─────────────────────────────────┘
```

### New page: `ui/pages/voice-join.js` (or `/join` route)

- Zero-auth landing page
- Shows: "AI Agent Call · Hosted by <workspace>"
- Input: display name
- Button: "Join Call"
- On join: fetches `/api/voice/rooms/:roomId/join`, connects to CF Calls

---

## 8. Cloudflare Calls Integration

Cloudflare Calls is the preferred SFU because bosun already uses Cloudflare for edge
tunnels. Each room maps to one CF Calls session.

**Server-side steps:**

1. On room create → `POST https://rtc.live.cloudflare.com/v1/apps/:appId/sessions/new`
2. Store `{ cfSessionId, cfAppId }` in an in-memory room registry (TTL-based)
3. On guest join → generate a CF participant token (signed with `CF_CALLS_APP_SECRET`)
4. Return `{ iceServers, participantToken, cfSessionId }` to guest browser
5. Browser uses CF Calls JS SDK to connect tracks

**Required env vars:**

```
CF_CALLS_APP_ID=<cloudflare calls app id>
CF_CALLS_APP_SECRET=<cloudflare calls app secret>
```

**Fallback:** If CF_CALLS_APP_ID is not set, fall back to a simple mesh via the
existing WebRTC signalling (peer-to-peer, ≤4 participants max).

---

## 9. Agent Audio in Multi-Party Calls

The AI agent speaks via its existing WebRTC track (or Responses API audio).
For multi-party, the server must **fan out** the agent's audio to all CF Calls
participants. Options:

| Approach                                          | Complexity          | Latency               |
| ------------------------------------------------- | ------------------- | --------------------- |
| Server-side audio re-encoding + CF Calls publish  | Medium              | +80–150 ms            |
| CF Calls SFU: agent publishes, CF fans out        | Low (preferred)     | minimal               |
| Client-side relay (host re-publishes agent track) | Low (fallback only) | +50–100 ms round-trip |

**Preferred:** The bosun server joins the Cloudflare Calls room as a "publisher"
with the agent audio track; CF SFU fans it out to all guests automatically.

---

## 10. Phase Plan

| Phase                        | Scope                                                                              | Effort   |
| ---------------------------- | ---------------------------------------------------------------------------------- | -------- |
| **1 — P2P (2 participants)** | Share URL → second browser dials host directly via existing WS signalling. No SFU. | 1–2 days |
| **2 — SFU rooms (up to 8)**  | CF Calls integration, participant list sidebar, mute events                        | 3–4 days |
| **3 — Guest portal**         | Zero-auth `/join` page, display name, mobile-responsive                            | 1–2 days |
| **4 — Agent fan-out**        | Server publishes agent audio to CF Calls room                                      | 2–3 days |
| **5 — Recording**            | CF Calls recording → R2 bucket, download link in chat                              | 2–3 days |

---

## 11. Security Considerations

- Room tokens are short-lived JWTs; no persistent DB entries required
- Guest tokens are scoped to a single room and cannot access any bosun API
- Host can close the room at any time, invalidating all outstanding guest tokens
- Share URLs should be treated as secrets (same class as meeting links)
- Rate-limit: max 3 active rooms per workspace, max 8 participants per room
- TURN/STUN credentials should be short-lived (24 h) and fetched fresh per session

---

## 12. Files to Create / Modify

```
bosun/
  api/voice-rooms.mjs         ← new: REST endpoints
  ui/modules/voice-rooms.mjs  ← new: client-side room helpers (signals, WS)
  ui/modules/voice-overlay.js ← modify: enable 👥 button, add participant panel
  ui/pages/voice-join.js      ← new: guest join landing page
  tests/voice-rooms.test.mjs  ← new: unit tests for token gen + room lifecycle
```
