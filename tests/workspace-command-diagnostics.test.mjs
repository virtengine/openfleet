import { beforeEach, describe, expect, it, vi } from "vitest";

describe("workspace command diagnostics", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("escapes backslashes in suggested pytest reruns", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "pytest",
      output: "FAILED tests\api\test_sample.py::test_case - AssertionError
= 1 failed in 0.42s =",
      exitCode: 1,
    });

    expect(diagnostic.suggestedRerun).toBe('pytest "tests\\api\\test_sample.py::test_case"');
  });

  it("parses vitest failures without regex backtracking over tool output", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "vitest",
      output: [
        " FAIL  tests/example.test.mjs:14:1",
        " Test Files  1 failed | 5 passed",
      ].join("
"),
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

  it("classifies rg-style searches as search family", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "rg",
      args: ["TODO", "src"],
      output: [
        "src/app.mjs:10:// TODO improve router",
        "src/lib.mjs:22:// TODO add cache",
      ].join("
"),
      exitCode: 0,
    });

    expect(diagnostic.family).toBe("search");
  });

  it("classifies package-manager install flows separately from build", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "npm",
      args: ["install"],
      output: "added 12 packages, audited 12 packages in 2s",
      exitCode: 0,
    });

    expect(diagnostic.family).toBe("package-manager");
  });

  it("classifies deploy-style commands as deploy family", async () => {
    const { analyzeCommandDiagnostic } = await import("../workspace/command-diagnostics.mjs");

    const diagnostic = await analyzeCommandDiagnostic({
      command: "vercel",
      args: ["deploy", "--prod"],
      output: "Deploying project...
Production: https://example.vercel.app",
      exitCode: 0,
    });

    expect(diagnostic.family).toBe("deploy");
  });
});
