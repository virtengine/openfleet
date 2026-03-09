import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("prefers repo-local .bosun for --where when repo root is provided", () => {
    const repoRoot = mkdtempSync(resolve(tmpdir(), "bosun-cli-config-dir-"));
    const repoConfigDir = resolve(repoRoot, ".bosun");
    mkdirSync(repoConfigDir, { recursive: true });
    writeFileSync(resolve(repoConfigDir, "bosun.config.json"), "{}", "utf8");

    const env = { ...process.env };
    delete env.BOSUN_HOME;
    delete env.BOSUN_DIR;
    env.APPDATA = resolve(repoRoot, "appdata");
    env.LOCALAPPDATA = env.APPDATA;
    env.USERPROFILE = env.APPDATA;
    env.HOME = env.APPDATA;
    env.XDG_CONFIG_HOME = env.APPDATA;

    try {
      const output = execFileSync(process.execPath, ["cli.mjs", "--where", "--repo-root", repoRoot], {
        cwd: resolve(process.cwd()),
        env,
        encoding: "utf8",
      });

      expect(output).toContain(repoConfigDir);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
