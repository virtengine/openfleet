import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config/config.mjs";

describe("config repo-root precedence", () => {
  const source = readFileSync(resolve(process.cwd(), "config/config.mjs"), "utf8");
  const tempDirs = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("prioritizes explicit repo-root/REPO_ROOT over workspace repo paths", () => {
    expect(source).toContain("const explicitRepoRoot = normalizedRepoRootOverride ||");
    expect(source).toContain("explicitRepoRoot ||");
    expect(source).toContain("const agentRepoRoot = explicitRepoRoot || resolveAgentRepoRoot();");
  });

  it("keeps explicit --repo-root after workspace repository selection", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "bosun-config-precedence-"));
    tempDirs.push(root);

    const configDir = resolve(root, ".bosun");
    const explicitRepoRoot = resolve(root, "source-repo");
    const workspaceRepoRoot = resolve(configDir, "workspaces", "virtengine-gh", "bosun");

    await mkdir(resolve(explicitRepoRoot, ".git"), { recursive: true });
    await mkdir(resolve(workspaceRepoRoot, ".git"), { recursive: true });
    await writeFile(
      resolve(configDir, "bosun.config.json"),
      JSON.stringify({
        workspaces: [
          {
            id: "virtengine-gh",
            activeRepo: "bosun",
            repos: [
              {
                name: "bosun",
                slug: "virtengine/bosun",
                primary: true,
              },
            ],
          },
        ],
        activeWorkspace: "virtengine-gh",
      }),
      "utf8",
    );

    const config = loadConfig([
      "node",
      "cli.mjs",
      "--config-dir",
      configDir,
      "--repo-root",
      explicitRepoRoot,
    ]);

    expect(config.repoRoot).toBe(explicitRepoRoot);
    expect(config.repositories[0]?.path).toBe(workspaceRepoRoot);
    expect(config.activeWorkspace).toBe("virtengine-gh");
  });
});
