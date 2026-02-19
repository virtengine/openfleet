import { describe, expect, it } from "vitest";
import { parseOrchestratorArgs } from "../ve-orchestrator.mjs";

describe("ve-orchestrator native args", () => {
  it("parses PowerShell-compatible flags", () => {
    const parsed = parseOrchestratorArgs([
      "-MaxParallel",
      "6",
      "-PollIntervalSec",
      "45",
      "-OneShot",
      "-DryRun",
    ]);

    expect(parsed.maxParallel).toBe(6);
    expect(parsed.pollIntervalSec).toBe(45);
    expect(parsed.oneShot).toBe(true);
    expect(parsed.dryRun).toBe(true);
  });

  it("applies defaults when no args provided", () => {
    const parsed = parseOrchestratorArgs([]);
    expect(parsed).toEqual({
      maxParallel: 2,
      pollIntervalSec: 90,
      oneShot: false,
      dryRun: false,
    });
  });
});
