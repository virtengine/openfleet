import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("config repo-root precedence", () => {
  const source = readFileSync(resolve(process.cwd(), "config/config.mjs"), "utf8");

  it("prioritizes explicit repo-root/REPO_ROOT over workspace repo paths", () => {
    expect(source).toContain("const explicitRepoRoot = normalizedRepoRootOverride ||");
    expect(source).toContain("explicitRepoRoot ||");
    expect(source).toContain("const agentRepoRoot = explicitRepoRoot || resolveAgentRepoRoot();");
  });
});