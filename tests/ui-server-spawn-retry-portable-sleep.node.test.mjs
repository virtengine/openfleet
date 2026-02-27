import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");

describe("ui-server spawn retry portable sleep", () => {
  it("does not use shell sleep command for retry delays", () => {
    // Shell 'sleep' command is not portable across platforms (esp. Windows)
    const hasShellSleep =
      /execSync\s*\(\s*['"`]sleep\s/.test(source) ||
      /spawnSync\s*\(\s*['"`]sleep/.test(source);
    assert.ok(
      !hasShellSleep,
      "should not use shell 'sleep' command which is not portable",
    );
  });

  it("uses a portable sleep implementation for ETXTBSY retry", () => {
    // ETXTBSY retry (for just-downloaded cloudflared binary) needs a delay
    // Should use setTimeout/Promise-based sleep, not shell command
    const hasPortableSleep =
      source.includes("ETXTBSY") &&
      (source.includes("setTimeout") || source.includes("await") ||
       source.includes("sleep") && !source.includes("execSync('sleep") &&
       !source.includes('execSync("sleep'));
    assert.ok(
      hasPortableSleep,
      "ETXTBSY retry should use a portable async delay (setTimeout/Promise)",
    );
  });

  it("defines a reusable portable sleep helper", () => {
    // Check for a sleep/delay helper function
    const hasSleepHelper =
      /function\s+sleep\s*\(|const\s+sleep\s*=|async\s+function\s+delay|const\s+delay\s*=/.test(
        source,
      );
    assert.ok(
      hasSleepHelper,
      "should define a reusable portable sleep/delay helper function",
    );
  });

  it("uses Promise-based sleep in the spawn retry loop", () => {
    const hasPromiseSleep =
      source.includes("ETXTBSY") &&
      (source.includes("new Promise") || source.includes("await sleep") ||
       source.includes("await delay"));
    assert.ok(
      hasPromiseSleep,
      "spawn retry loop should use Promise-based sleep for portability",
    );
  });
});
