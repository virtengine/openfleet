import { describe, expect, it } from "vitest";
import { buildCommandContextEnvelope } from "../workflow/command-context-envelope.mjs";

describe("command context envelope", () => {
  it("classifies dotnet test output and keeps stable inline summary", () => {
    const envelope = buildCommandContextEnvelope({
      command: "dotnet",
      args: ["test"],
      stdout: [
        "Test run for Demo.dll (.NETCoreApp,Version=v8.0)",
        "Passed!  - Failed:     0, Passed:    24, Skipped:     0, Total:    24",
      ].join("\n"),
      exitCode: 0,
    });
    expect(envelope.family).toBe("test");
    expect(envelope.budgetPolicy.name).toBe("inline-excerpt");
    expect(envelope.promptContext.summary).toContain("test command succeeded");
    expect(envelope.decision.reasons).toContain("family=test");
  });

  it("classifies git diff as structured delta", () => {
    const envelope = buildCommandContextEnvelope({
      command: "git",
      args: ["diff", "--stat"],
      stdout: " src/a.mjs | 2 +-\n src/b.mjs | 8 ++++++--\n 2 files changed, 6 insertions(+), 4 deletions(-)",
      exitCode: 0,
    });
    expect(envelope.family).toBe("git");
    expect(envelope.decision.retrieval).toBe("structured-delta");
    expect(envelope.promptContext.structuredDelta.length).toBeGreaterThan(0);
  });

  it("routes noisy build output to artifact retention with inspectable reasons", () => {
    const stdout = Array.from({ length: 220 }, (_, index) => `build line ${index + 1} warning CS${1000 + index}`).join("\n");
    const envelope = buildCommandContextEnvelope({ command: "dotnet", args: ["build"], stdout, exitCode: 0 });
    expect(envelope.family).toBe("build");
    expect(envelope.decision.retrieval).toBe("artifact");
    expect(envelope.artifacts[0]?.kind).toBe("command-output");
    expect(envelope.decision.reasons.some((entry) => entry.startsWith("lines="))).toBe(true);
  });

  it("classifies rg-style search output", () => {
    const envelope = buildCommandContextEnvelope({
      command: "rg",
      args: ["TODO", "src"],
      stdout: "src/app.mjs:10:// TODO fix\nsrc/lib.mjs:22:// TODO test",
      exitCode: 0,
    });
    expect(envelope.family).toBe("search");
    expect(envelope.evidence.every((entry) => entry.kind === "match")).toBe(true);
  });
});
