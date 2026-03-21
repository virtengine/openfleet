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

    expect(matches).toBeGreaterThanOrEqual(1);
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

  it("prefers repo-local task store for task stats when --repo-root is provided", () => {
    const repoRoot = mkdtempSync(resolve(tmpdir(), "bosun-cli-task-store-"));
    const repoConfigDir = resolve(repoRoot, ".bosun");
    const repoCacheDir = resolve(repoConfigDir, ".cache");
    const appDataDir = resolve(repoRoot, "appdata");
    const roamingBosunDir = resolve(appDataDir, "bosun");
    const workspaceStoreDir = resolve(
      roamingBosunDir,
      "workspaces",
      "virtengine-gh",
      "bosun",
      ".bosun",
      ".cache",
    );
    mkdirSync(repoCacheDir, { recursive: true });
    mkdirSync(workspaceStoreDir, { recursive: true });
    writeFileSync(resolve(repoConfigDir, "bosun.config.json"), JSON.stringify({
      activeWorkspace: "virtengine-gh",
      workspacesDir: resolve(roamingBosunDir, "workspaces"),
      workspaces: [
        {
          id: "virtengine-gh",
          activeRepo: "bosun",
          repos: [
            { name: "bosun", slug: "virtengine/bosun", primary: true },
          ],
        },
      ],
    }), "utf8");
    writeFileSync(resolve(repoCacheDir, "kanban-state.json"), JSON.stringify({
      _meta: {
        version: 1,
        taskCount: 1,
        stats: { draft: 0, todo: 0, inprogress: 1, inreview: 0, done: 0, blocked: 0 },
      },
      tasks: {
        "repo-task": { id: "repo-task", title: "Repo task", status: "inprogress" },
      },
      sprints: {},
    }), "utf8");
    writeFileSync(resolve(workspaceStoreDir, "kanban-state.json"), JSON.stringify({
      _meta: {
        version: 1,
        taskCount: 1,
        stats: { draft: 0, todo: 1, inprogress: 0, inreview: 0, done: 0, blocked: 0 },
      },
      tasks: {
        "workspace-task": { id: "workspace-task", title: "Workspace task", status: "todo" },
      },
      sprints: {},
    }), "utf8");

    const env = { ...process.env };
    delete env.REPO_ROOT;
    delete env.BOSUN_STORE_PATH;
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;
    delete env.JEST_WORKER_ID;
    delete env.NODE_ENV;
    env.BOSUN_HOME = repoConfigDir;
    env.BOSUN_DIR = repoConfigDir;
    env.APPDATA = appDataDir;
    env.LOCALAPPDATA = appDataDir;
    env.USERPROFILE = appDataDir;
    env.HOME = appDataDir;
    env.XDG_CONFIG_HOME = appDataDir;

    try {
      const output = execFileSync(
        process.execPath,
        ["cli.mjs", "task", "stats", "--json", "--config-dir", repoConfigDir, "--repo-root", repoRoot],
        {
          cwd: resolve(process.cwd()),
          env,
          encoding: "utf8",
        },
      );
      const jsonStart = output.indexOf("{");
      const stats = JSON.parse(output.slice(jsonStart));

      expect(stats.total).toBe(1);
      expect(stats.inprogress).toBe(1);
      expect(stats.todo).toBe(0);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
