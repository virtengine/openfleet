import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("voice UI externalize/handoff regressions", () => {
  it("preserves active call session when externalizing overlay", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/modules/voice-overlay.js"), "utf8");

    expect(source).toContain("preserveSessionOnHideRef");
    expect(source).toContain("if (preserveSessionOnHideRef.current)");
    expect(source).toContain('if (reason === "externalize")');
  });

  it("guards externalize handoff against duplicate in-flight opens", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/app.js"), "utf8");

    expect(source).toContain("externalizeInFlightRef");
    expect(source).toContain("if (externalizeInFlightRef.current)");
    expect(source).toContain("externalizeInFlightRef.current = true");
    expect(source).toContain("externalizeInFlightRef.current = false");
  });

  it("routes mute button to SDK mute path when SDK voice is active", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/modules/voice-overlay.js"), "utf8");

    expect(source).toContain("toggleSdkMicMute");
    expect(source).toContain("if (effectiveSdk)");
    expect(source).toContain("toggleSdkMicMute();");
  });
});
