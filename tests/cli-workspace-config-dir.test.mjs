import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("cli workspace config-dir resolution", () => {
  const cliSource = readFileSync(resolve(process.cwd(), "cli.mjs"), "utf8");
  const workspaceSection = cliSource.slice(
    cliSource.indexOf("// Handle workspace commands"),
    cliSource.indexOf("// Handle --setup-terminal (legacy terminal wizard)"),
  );

  it("uses resolveConfigDirForCli fallback for workspace commands", () => {
    const expected =
      "configDirArg || process.env.BOSUN_DIR || resolveConfigDirForCli()";
    const matches = workspaceSection.split(expected).length - 1;

    expect(matches).toBe(5);
    expect(workspaceSection).not.toContain('resolve(os.homedir(), "bosun")');
  });
});
