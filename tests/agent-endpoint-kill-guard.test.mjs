import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

describe("agent endpoint stale-pid handling", () => {
  const source = readFileSync(resolve(process.cwd(), "agent-endpoint.mjs"), "utf8");

  it("treats process-not-found taskkill output as already exited", () => {
    expect(source).toContain('detail.includes("not found")');
  });

  it("uses spawnSync taskkill with piped stdio", () => {
    const match = source.match(
      /if \(isWindows\) \{[\s\S]*?spawnSync\([\s\S]*?"taskkill"[\s\S]*?\);[\s\S]*?\} else \{/,
    );
    expect(match, "Windows taskkill block should use spawnSync").toBeTruthy();
    const block = match ? match[0] : "";
    expect(block).toContain('stdio: ["ignore", "pipe", "pipe"]');
  });

  it("skips forced kill when port owner is not a bosun process", () => {
    expect(source).toContain("isLikelyBosunCommandLine");
    expect(source).toContain("held by non-bosun PID");
    expect(source).toContain("skipping forced kill");
  });
});
