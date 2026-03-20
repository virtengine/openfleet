import { beforeEach, describe, expect, it, vi } from "vitest";

describe("workspace command diagnostics", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("escapes backslashes in suggested pytest reruns", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "pytest",
      output: "FAILED tests\\api\\test_sample.py::test_case - AssertionError\n= 1 failed in 0.42s =",
      exitCode: 1,
    });

    expect(diagnostic.suggestedRerun).toBe('pytest "tests\\\\api\\\\test_sample.py::test_case"');
  });

  it("parses vitest failures without regex backtracking over tool output", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "vitest",
      output: [
        " FAIL  tests/example.test.mjs:14:1",
        " Test Files  1 failed | 5 passed",
      ].join("\n"),
      exitCode: 1,
    });

    expect(diagnostic.runner).toBe("vitest");
    expect(diagnostic.failedTargets).toContain("tests/example.test.mjs:14:1");
    expect(diagnostic.summary).toContain("1 failed file");
  });

  it("extracts file anchors from tokenized output", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "node",
      output: "Error in workspace/command-diagnostics.mjs:63 and tests/workspace-command-diagnostics.test.mjs:1",
      exitCode: 1,
    });

    expect(diagnostic.fileAnchors).toContain("workspace/command-diagnostics.mjs:63");
    expect(diagnostic.fileAnchors).toContain("tests/workspace-command-diagnostics.test.mjs:1");
  });
});