import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cli update flow", () => {
  const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");
  const updateSection = cliSource.slice(
    cliSource.indexOf("// Handle --update (force update)"),
    cliSource.indexOf("// ── Startup banner with update check"),
  );

  it("warns about restart behavior before prompting for an update", () => {
    expect(updateSection).toContain(
      '"  Note: a successful update will restart the bosun daemon automatically."',
    );
    expect(updateSection).toContain(
      "other running bosun process(es) will be stopped after a successful update.",
    );
  });

  it("only stops sibling processes after forceUpdate reports success", () => {
    const updateCallIndex = updateSection.indexOf(
      "const updated = await forceUpdate(VERSION);",
    );
    const exitGuardIndex = updateSection.indexOf("if (!updated) {");
    const stopCallIndex = updateSection.indexOf("stopBosunProcesses(siblingPids, {");

    expect(updateCallIndex).toBeGreaterThanOrEqual(0);
    expect(exitGuardIndex).toBeGreaterThan(updateCallIndex);
    expect(stopCallIndex).toBeGreaterThan(exitGuardIndex);
  });

  it("restarts the daemon automatically after a successful update", () => {
    expect(updateSection).toContain("const shouldRestartDaemon = runningDaemonPids.length > 0;");
    expect(updateSection).toContain('console.log("  Restarting daemon with updated version...");');
    expect(updateSection).toContain("startDaemon(); // spawns new daemon-child and calls process.exit(0)");
  });
});