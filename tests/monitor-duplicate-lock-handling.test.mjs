import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("duplicate monitor lock handling", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");
  const maintenanceSource = readFileSync(resolve(process.cwd(), "maintenance.mjs"), "utf8");

  it("treats non-self-restart lock contention as a benign duplicate start", () => {
    const blockMatch = monitorSource.match(
      /if \(!acquireMonitorLock\(config\.cacheDir\)\) \{[\s\S]*?process\.exit\(0\);[\s\S]*?\n\s*\}/,
    );
    expect(blockMatch, "singleton guard block should exit 0 for duplicate starts").toBeTruthy();
    const block = blockMatch ? blockMatch[0] : "";
    expect(block).toContain("duplicate start ignored");
    expect(block).not.toContain("exit code 1");
  });

  it("logs duplicate lock owners as warnings in maintenance", () => {
    expect(maintenanceSource).toContain("another bosun is already running");
    expect(maintenanceSource).toContain("Ignoring duplicate start.");
    expect(maintenanceSource).toContain("console.warn(");
  });
});
