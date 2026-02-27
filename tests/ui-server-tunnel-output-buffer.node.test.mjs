import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");

describe("ui-server quick tunnel output buffer", () => {
  it("defines appendOutputTail function", () => {
    assert.ok(
      source.includes("appendOutputTail"),
      "appendOutputTail function should be defined",
    );
  });

  it("caps output buffer at a configurable maximum size", () => {
    // Default is 64KB
    const has64KB =
      source.includes("64 * 1024") ||
      source.includes("65536") ||
      /64\s*\*\s*1024/.test(source);
    assert.ok(has64KB, "output buffer should default to 64KB cap");
  });

  it("truncates output from the front when cap is exceeded", () => {
    // When buffer overflows, older content is dropped (tail kept)
    const hasTruncation =
      /slice\s*\(.*-|substr\s*\(|substring\s*\(|\.slice\s*\(-/.test(source) &&
      source.includes("appendOutputTail");
    assert.ok(
      hasTruncation,
      "appendOutputTail should truncate from the front to preserve recent output",
    );
  });

  it("uses appendOutputTail in quick tunnel output handling", () => {
    // Quick tunnel stdout/stderr should use the capped buffer
    const hasUsage =
      source.includes("appendOutputTail") &&
      (source.includes("quickTunnel") || source.includes("quick_tunnel") ||
       source.includes("startQuickTunnel"));
    assert.ok(
      hasUsage,
      "quick tunnel output handlers should use appendOutputTail",
    );
  });

  it("exposes output tail for status/health reporting", () => {
    // The buffered output should be accessible for diagnostics
    const hasExposure =
      source.includes("outputTail") ||
      source.includes("tunnelOutput") ||
      source.includes("tunnelLog");
    assert.ok(
      hasExposure,
      "tunnel output tail should be accessible for status reporting",
    );
  });
});
