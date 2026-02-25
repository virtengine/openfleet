import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("duplicate monitor lock handling", () => {
  const monitorSource = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8");
  const maintenanceSource = readFileSync(resolve(process.cwd(), "maintenance.mjs"), "utf8");
  const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");

  it("treats non-self-restart lock contention as a benign duplicate start", () => {
    const blockMatch = monitorSource.match(
      /if \(!acquireMonitorLock\(config\.cacheDir\)\) \{[\s\S]*?process\.exit\(0\);[\s\S]*?\n\s*\}/,
    );
    expect(blockMatch, "singleton guard block should exit 0 for duplicate starts").toBeTruthy();
    const block = blockMatch ? blockMatch[0] : "";
    expect(
      block.includes("duplicate start ignored") ||
        block.includes("writeDuplicateStartExitNotice("),
    ).toBe(true);
    expect(block).not.toContain("exit code 1");
  });

  it("logs duplicate lock owners as warnings in maintenance", () => {
    expect(maintenanceSource).toContain("another bosun is already running");
    expect(maintenanceSource).toContain("Ignoring duplicate start.");
    expect(maintenanceSource).toContain("logDuplicateStartWarning(");
  });

  it("throttles duplicate lock warning spam across restart storms", () => {
    expect(maintenanceSource).toContain("MONITOR_DUPLICATE_START_WARN_THROTTLE_MS");
    expect(maintenanceSource).toContain("duplicate-start warnings in last");
  });
  it("throttles duplicate-start exit notices in monitor", () => {
    expect(monitorSource).toContain("DUPLICATE_START_EXIT_THROTTLE_MS");
    expect(monitorSource).toContain("monitor-duplicate-start-exit-state.json");
    expect(monitorSource).toContain("suppressed");
  });

  it("short-circuits duplicate starts in cli before forking monitor", () => {
    const preflightMatch = cliSource.match(
      /const existingOwner = detectExistingMonitorLockOwner\(\);[\s\S]*?if \(existingOwner\) \{[\s\S]*?exiting duplicate start\.[\s\S]*?return;[\s\S]*?\}/,
    );
    expect(preflightMatch, "cli should skip runMonitor() when a live lock owner exists").toBeTruthy();
  });
});

