import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("monitor-monitor orchestrator tail behavior", () => {
  // Normalize CRLF → LF so regex matches on Windows
  const monitorSource = readFileSync(resolve(process.cwd(), "monitor.mjs"), "utf8").replace(/\r\n/g, "\n");

  it("marks missing orchestrator tail as not-applicable in internal-like modes", () => {
    expect(
      monitorSource.includes("function formatOrchestratorTailForMonitorPrompt("),
      "formatOrchestratorTailForMonitorPrompt should exist",
    ).toBe(true);
    expect(
      monitorSource.includes('mode === "internal"'),
      "should check internal mode",
    ).toBe(true);
    expect(
      monitorSource.includes('mode === "disabled"'),
      "should check disabled mode",
    ).toBe(true);
    expect(
      monitorSource.includes("not applicable: executor mode"),
      "should return clear message for non-orchestrator modes",
    ).toBe(true);
  });

  it("applies executor mode formatting before monitor-monitor prompt assembly", () => {
    expect(
      monitorSource.includes("const runtimeExecutorMode = String("),
      "should compute runtimeExecutorMode",
    ).toBe(true);
    expect(
      monitorSource.includes("formatOrchestratorTailForMonitorPrompt("),
      "should call formatOrchestratorTailForMonitorPrompt",
    ).toBe(true);
  });
});
