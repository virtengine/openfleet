/**
 * Regression tests: browser mic indicator stays lit after closing a voice call.
 *
 * Three root-cause bugs were fixed.  These tests verify each structural fix
 * is present so the bugs can never silently re-introduce themselves.
 *
 * Strategy: source-level analysis (readFileSync) gives us deterministic,
 * browser-API-free tests that directly verify the guard code is in place.
 * Pairing each test with a "normal-flow" sanity check ensures we're reading
 * the right files and that basic assumptions about the code still hold.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd(); // bosun/

const vcSrc = readFileSync(resolve(ROOT, "ui/modules/voice-client.js"), "utf8");
const sdkSrc = readFileSync(resolve(ROOT, "ui/modules/voice-client-sdk.js"), "utf8");

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return the body of the first function with the given name, skipping the
 * parameter list to find the true opening brace of the body.
 *
 * Works for `function foo(...)`, `async function foo(...)`,
 * `export function foo(...)`, etc.
 */
function extractFunctionBody(src, name) {
  const startRe = new RegExp(`function\\s+${name}\\s*\\(`);
  const startIdx = src.search(startRe);
  if (startIdx === -1) return null;

  // Walk forward to find the end of the parameter list (matching parens),
  // then the first '{' after that is the body opening brace.
  let i = startIdx;
  // skip to opening paren of parameter list
  while (i < src.length && src[i] !== "(") i++;

  // balance parens to find the closing ')' of the parameter list
  let parenDepth = 0;
  while (i < src.length) {
    if (src[i] === "(") parenDepth++;
    else if (src[i] === ")") {
      parenDepth--;
      if (parenDepth === 0) { i++; break; }
    }
    i++;
  }

  // skip whitespace/colon/return-type annotation to find the body '{'
  while (i < src.length && src[i] !== "{") i++;

  // now balance braces for the body
  const bodyStart = i;
  let braceDepth = 0;
  while (i < src.length) {
    if (src[i] === "{") braceDepth++;
    else if (src[i] === "}") {
      braceDepth--;
      if (braceDepth === 0) return src.slice(bodyStart, i + 1);
    }
    i++;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bug 1 — AudioContext leak when connection drops unexpectedly
//
// Root cause: cleanup() was called by both stopVoiceSession() (which pre-calls
// _stopMicLevelMonitor()) and handleDisconnect() (which did NOT), so an
// unexpected disconnect left the AudioContext alive.
//
// Fix: _stopMicLevelMonitor() is now the very first statement in cleanup().
// ─────────────────────────────────────────────────────────────────────────────

describe("Bug 1 — AudioContext closed even on unexpected disconnect (voice-client.js cleanup)", () => {
  it("cleanup() calls _stopMicLevelMonitor() before any other teardown", () => {
    const body = extractFunctionBody(vcSrc, "cleanup");
    expect(body, "cleanup() function not found in voice-client.js").not.toBeNull();

    // _stopMicLevelMonitor() must appear BEFORE _reconnectInFlight (the very
    // next statement) — verifying it is effectively the first action performed.
    const monitorPos = body.indexOf("_stopMicLevelMonitor()");
    const reconnectPos = body.indexOf("_reconnectInFlight");
    expect(monitorPos, "_stopMicLevelMonitor() not found in cleanup()").toBeGreaterThan(0);
    expect(reconnectPos, "_reconnectInFlight not found in cleanup()").toBeGreaterThan(0);
    expect(monitorPos).toBeLessThan(reconnectPos);
  });

  it("cleanup() contains the explanatory comment about handleDisconnect path", () => {
    const body = extractFunctionBody(vcSrc, "cleanup");
    expect(body).toContain("reached both by stopVoiceSession() and by handleDisconnect()");
  });

  it("cleanup() also calls _stopMicLevelMonitor somewhere (belt-and-suspenders)", () => {
    const body = extractFunctionBody(vcSrc, "cleanup");
    expect(body).toContain("_stopMicLevelMonitor()");
  });

  it("handleDisconnect() itself does NOT call _stopMicLevelMonitor (no duplication)", () => {
    const body = extractFunctionBody(vcSrc, "handleDisconnect");
    expect(body, "handleDisconnect() not found in voice-client.js").not.toBeNull();
    // The call is expected to come from cleanup(), not handleDisconnect() body
    // directly — deduplication concern.  This is intentional: cleanup() owns it.
    expect(body).not.toContain("_stopMicLevelMonitor");
  });

  it("sanity: _stopMicLevelMonitor function is defined in voice-client.js", () => {
    expect(vcSrc).toContain("function _stopMicLevelMonitor");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 2 — getUserMedia race in voice-client.js
//
// Root cause: startVoiceSession() awaits fetch("/api/voice/token") then
// getUserMedia().  If the user presses hang-up during that window,
// stopVoiceSession() → cleanup() → stopTrackedMicStreams() runs with nothing
// in the registry yet.  getUserMedia() then resolves and deposits a live,
// never-to-be-stopped stream → mic indicator stays lit.
//
// Fix: after getUserMedia() resolves, check _explicitStop.  If true, stop all
// tracks immediately and throw to abort session setup.
// ─────────────────────────────────────────────────────────────────────────────

describe("Bug 2 — getUserMedia race condition fixed in voice-client.js", () => {
  it("_explicitStop guard exists immediately after registerMicStream call in startVoiceSession", () => {
    // The guard lies between stream registration and mic-level monitor start —
    // use those as anchors so the test is immune to indentation or line changes.
    const registerIdx = vcSrc.indexOf("registerMicStream(_mediaStream)");
    expect(registerIdx, "registerMicStream(_mediaStream) not found").toBeGreaterThan(-1);
    const monitorIdx = vcSrc.indexOf("_startMicLevelMonitor(_mediaStream)");
    expect(monitorIdx, "_startMicLevelMonitor(_mediaStream) not found").toBeGreaterThan(registerIdx);

    const region = vcSrc.slice(registerIdx, monitorIdx);
    expect(region).toContain("if (_explicitStop)");
  });

  it("guard stops all tracks via getTracks() loop when _explicitStop is true", () => {
    const registerIdx = vcSrc.indexOf("registerMicStream(_mediaStream)");
    const monitorIdx = vcSrc.indexOf("_startMicLevelMonitor(_mediaStream)");
    const region = vcSrc.slice(registerIdx, monitorIdx);
    expect(region).toContain("_mediaStream.getTracks()");
    expect(region).toContain("track.stop()");
  });

  it("guard nulls out _mediaStream after stopping tracks", () => {
    const registerIdx = vcSrc.indexOf("registerMicStream(_mediaStream)");
    const monitorIdx = vcSrc.indexOf("_startMicLevelMonitor(_mediaStream)");
    const region = vcSrc.slice(registerIdx, monitorIdx);
    expect(region).toContain("_mediaStream = null");
  });

  it("guard throws an error with an explanatory message", () => {
    expect(vcSrc).toContain('throw new Error("voice session was stopped during microphone acquisition")');
  });

  it("guard comment explains the race condition scenario", () => {
    expect(vcSrc).toContain("stopVoiceSession() may have been called while getUserMedia() was");
    expect(vcSrc).toContain("cleanup() already ran without this stream");
  });

  it("stopVoiceSession() sets _explicitStop = true before cleanup", () => {
    const body = extractFunctionBody(vcSrc, "stopVoiceSession");
    expect(body, "stopVoiceSession() not found in voice-client.js").not.toBeNull();
    expect(body).toContain("_explicitStop = true");
  });

  it("startVoiceSession() resets _explicitStop = false at the start", () => {
    const body = extractFunctionBody(vcSrc, "startVoiceSession");
    expect(body, "startVoiceSession() not found in voice-client.js").not.toBeNull();
    expect(body).toContain("_explicitStop = false");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug 3 — getUserMedia race in voice-client-sdk.js (OpenAI Agents + Gemini)
//
// Root cause: stopSdkVoiceSession() can complete while session.connect() or
// startGeminiMicCapture() is still awaiting getUserMedia().  The captured
// streams arrive in the registry after cleanup — never subsequently stopped.
//
// Fix: added _sdkExplicitStop flag (module-level), set at top of stop function,
// reset at start of start function, with guards after each async getUserMedia await.
// ─────────────────────────────────────────────────────────────────────────────

describe("Bug 3 — SDK getUserMedia race condition fixed in voice-client-sdk.js", () => {
  describe("module-level flag", () => {
    it("_sdkExplicitStop is declared at module scope (not inside a function)", () => {
      const flagIdx = sdkSrc.indexOf("let _sdkExplicitStop = false");
      expect(flagIdx, "_sdkExplicitStop declaration not found").toBeGreaterThan(-1);

      // The explanatory comment must live within a few lines of the declaration.
      // Use a generous window so whitespace changes don't break the test.
      const region = sdkSrc.slice(Math.max(0, flagIdx - 400), flagIdx + 80);
      expect(region).toContain("Set to true by stopSdkVoiceSession");
    });
  });

  describe("stopSdkVoiceSession() sets the flag FIRST", () => {
    it("_sdkExplicitStop = true is the first statement in stopSdkVoiceSession()", () => {
      const flagIdx = sdkSrc.indexOf("_sdkExplicitStop = true");
      expect(flagIdx, "_sdkExplicitStop = true not found").toBeGreaterThan(-1);

      // Find where stopSdkVoiceSession starts and verify the flag assignment
      // appears before any destructive operation in that function
      const stopFnBody = extractFunctionBody(sdkSrc, "stopSdkVoiceSession");
      expect(stopFnBody, "stopSdkVoiceSession() not found in voice-client-sdk.js").not.toBeNull();

      const flagPosInBody = stopFnBody.indexOf("_sdkExplicitStop = true");
      const emitPos = stopFnBody.indexOf('emit("session-ending"');
      const flushPos = stopFnBody.indexOf("_flushPendingTranscriptBuffers");

      expect(flagPosInBody).toBeGreaterThan(-1);
      expect(flagPosInBody).toBeLessThan(emitPos);
      expect(flagPosInBody).toBeLessThan(flushPos);
    });

    it("has explanatory comment in stopSdkVoiceSession about in-flight awaiters", () => {
      expect(sdkSrc).toContain("in-flight getUserMedia / session.connect awaiters");
    });
  });

  describe("startSdkVoiceSession() resets the flag", () => {
    it("_sdkExplicitStop = false appears in startSdkVoiceSession()", () => {
      const body = extractFunctionBody(sdkSrc, "startSdkVoiceSession");
      expect(body, "startSdkVoiceSession() not found").not.toBeNull();
      expect(body).toContain("_sdkExplicitStop = false");
    });
  });

  describe("startAgentsSdkSession() guard after _withGetUserMediaCapture", () => {
    it("_sdkExplicitStop guard exists after _withGetUserMediaCapture call", () => {
      const captureIdx = sdkSrc.indexOf("_withGetUserMediaCapture");
      expect(captureIdx, "_withGetUserMediaCapture not found").toBeGreaterThan(-1);

      // Find the first _sdkExplicitStop check that appears after the capture call.
      // Use _session = session as the closing anchor (guard must precede the
      // successful assignment).
      const sessionAssignIdx = sdkSrc.indexOf("_session = session", captureIdx);
      expect(sessionAssignIdx, "_session = session not found after _withGetUserMediaCapture").toBeGreaterThan(captureIdx);

      const between = sdkSrc.slice(captureIdx, sessionAssignIdx);
      expect(between).toContain("if (_sdkExplicitStop)");
    });

    it("guard in startAgentsSdkSession calls _stopCapturedSdkMicStreams and stopTrackedMicStreams", () => {
      const captureIdx = sdkSrc.indexOf("_withGetUserMediaCapture");
      const sessionAssignIdx = sdkSrc.indexOf("_session = session", captureIdx);
      const between = sdkSrc.slice(captureIdx, sessionAssignIdx);
      expect(between).toContain("_stopCapturedSdkMicStreams()");
      expect(between).toContain("stopTrackedMicStreams()");
    });

    it("guard in startAgentsSdkSession throws to abort session setup", () => {
      expect(sdkSrc).toContain('throw new Error("SDK session was stopped during connection")');
    });
  });

  describe("startGeminiMicCapture() guard after getUserMedia", () => {
    it("_sdkExplicitStop guard exists after registerMicStream in startGeminiMicCapture", () => {
      // The Gemini path uses _geminiMicStream
      const registerIdx = sdkSrc.indexOf("registerMicStream(_geminiMicStream)");
      expect(registerIdx, "registerMicStream(_geminiMicStream) not found").toBeGreaterThan(-1);

      const region = sdkSrc.slice(registerIdx, registerIdx + 400);
      expect(region).toContain("if (_sdkExplicitStop)");
    });

    it("Gemini guard stops tracks via getTracks() loop", () => {
      const registerIdx = sdkSrc.indexOf("registerMicStream(_geminiMicStream)");
      const region = sdkSrc.slice(registerIdx, registerIdx + 400);
      expect(region).toContain("_geminiMicStream.getTracks()");
      expect(region).toContain("track.stop()");
    });

    it("Gemini guard nulls out _geminiMicStream after stopping", () => {
      const registerIdx = sdkSrc.indexOf("registerMicStream(_geminiMicStream)");
      const region = sdkSrc.slice(registerIdx, registerIdx + 400);
      expect(region).toContain("_geminiMicStream = null");
    });

    it("Gemini guard throws an explanatory error", () => {
      expect(sdkSrc).toContain('throw new Error("SDK session was stopped during microphone acquisition")');
    });

    it("Gemini guard comment explains the race", () => {
      expect(sdkSrc).toContain("stopSdkVoiceSession() may have raced with this getUserMedia await");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Safety-net: mic-track-registry must still provide stopTrackedMicStreams()
// which is the final backstop called in every cleanup path.
// ─────────────────────────────────────────────────────────────────────────────

describe("Safety net — stopTrackedMicStreams() is called in all cleanup paths", () => {
  it("voice-client.js cleanup() calls stopTrackedMicStreams()", () => {
    const body = extractFunctionBody(vcSrc, "cleanup");
    expect(body).toContain("stopTrackedMicStreams()");
  });

  it("voice-client-sdk.js stopSdkVoiceSession() calls stopTrackedMicStreams()", () => {
    const body = extractFunctionBody(sdkSrc, "stopSdkVoiceSession");
    expect(body, "stopSdkVoiceSession() not found").not.toBeNull();
    expect(body).toContain("stopTrackedMicStreams()");
  });
});
