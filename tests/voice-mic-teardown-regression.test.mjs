import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("voice mic teardown regressions", () => {
  it("overlay uses a unified hard-stop that always stops all voice transports", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/modules/voice-overlay.js"), "utf8");

    expect(source).toContain("const stopAllVoiceTransports = useCallback");
    expect(source).toContain("stopSdkVoiceSession()");
    expect(source).toContain("stopVoiceSession()");
    expect(source).toContain("stopFallbackSession()");
    expect(source).toContain("stopAllVoiceTransports();");
    expect(source).toContain("preserveSessionOnHideRef.current = false");
  });

  it("sdk client tracks captured getUserMedia mic streams and stops them on teardown", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/modules/voice-client-sdk.js"), "utf8");

    expect(source).toContain("const _sdkCapturedMicStreams = new Set()");
    expect(source).toContain("async function _withGetUserMediaCapture");
    expect(source).toContain("await _withGetUserMediaCapture(async () =>");
    expect(source).toContain("_stopCapturedSdkMicStreams();");
  });
});

