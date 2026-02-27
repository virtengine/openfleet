import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  detectWorkspaces,
  listWorkspaces,
  mergeDetectedWorkspaces,
} from "../workspace-manager.mjs";

const cleanupDirs = [];

beforeEach(() => {
  cleanupDirs.length = 0;
});

afterEach(() => {
  for (const dir of cleanupDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function createConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), "workspace-manager-tests-"));
  cleanupDirs.push(dir);
  return dir;
}

function writeBosunConfig(configDir, config) {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "bosun.config.json"), JSON.stringify(config, null, 2) + "\n", "utf8");
}

function createGitRepo(repoPath, remoteUrl) {
  mkdirSync(repoPath, { recursive: true });
  execSync("git init", { cwd: repoPath, stdio: ["ignore", "ignore", "ignore"] });
  if (remoteUrl) {
    execSync("git remote add origin " + remoteUrl, {
      cwd: repoPath,
      stdio: ["ignore", "ignore", "ignore"],
    });
  }
}

function readConfig(configDir) {
  return JSON.parse(readFileSync(join(configDir, "bosun.config.json"), "utf8"));
}

describe("detectWorkspaces", () => {
  it("only detects directories with git repositories and reports their slug", () => {
    const configDir = createConfigDir();
    const workspacesDir = join(configDir, "workspaces");
    createGitRepo(join(workspacesDir, "alpha", "repo-one"), "git@github.com:virtengine/repo-one.git");

    // Workspace without git repos should be ignored
    mkdirSync(join(workspacesDir, "empty"), { recursive: true });

    const detected = detectWorkspaces(configDir);
    const alpha = detected.find((ws) => ws.id === "alpha");

    expect(alpha).toBeDefined();
    expect(alpha.repos).toHaveLength(1);
    expect(alpha.repos[0].name).toBe("repo-one");
    expect(alpha.repos[0].slug).toBe("virtengine/repo-one");
    expect(detected.some((ws) => ws.id === "empty")).toBe(false);
  });
});

describe("mergeDetectedWorkspaces", () => {
  it("updates existing workspaces without duplicating repos and keeps the active workspace", () => {
    const configDir = createConfigDir();
    const workspacesDir = join(configDir, "workspaces");
    const alphaDir = join(workspacesDir, "alpha");
    const betaDir = join(workspacesDir, "beta");

    createGitRepo(join(alphaDir, "common"), "git@github.com:virtengine/common.git");
    createGitRepo(join(alphaDir, "extra"), "git@github.com:virtengine/extra.git");
    createGitRepo(join(betaDir, "other"), "git@github.com:virtengine/other.git");

    writeBosunConfig(configDir, {
      workspaces: [
        {
          id: "alpha",
          name: "Alpha",
          repos: [
            {
              name: "common",
              url: "https://example.com/common.git",
            },
          ],
          activeRepo: "common",
        },
      ],
      activeWorkspace: "alpha",
    });

    const result = mergeDetectedWorkspaces(configDir);
    const config = readConfig(configDir);
    const alpha = config.workspaces.find((ws) => ws.id === "alpha");
    const beta = config.workspaces.find((ws) => ws.id === "beta");

    expect(result.added).toBeGreaterThanOrEqual(1);
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha.repos.filter((repo) => repo.name === "common")).toHaveLength(1);
    expect(alpha.repos.some((repo) => repo.name === "extra")).toBe(true);
    expect(alpha.repos.find((repo) => repo.name === "common").slug).toBe("virtengine/common");
    expect(config.activeWorkspace).toBe("alpha");
  });
});

describe("listWorkspaces", () => {
  it("uses repoRoot override when workspace path is missing", () => {
    const configDir = createConfigDir();
    const altRoot = join(configDir, "alternate-repos");
    const missingRepoPath = join(altRoot, "missing-repo");
    mkdirSync(join(missingRepoPath, ".git"), { recursive: true });

    writeBosunConfig(configDir, {
      workspaces: [
        {
          id: "primary",
          name: "Primary",
          repos: [
            {
              name: "missing-repo",
              url: "",
              slug: "",
            },
          ],
        },
      ],
      activeWorkspace: "primary",
    });

    const [workspace] = listWorkspaces(configDir, { repoRoot: altRoot });
    const [repo] = workspace.repos;

    expect(workspace.exists).toBe(true);
    expect(repo.exists).toBe(true);
    expect(repo.path).toBe(missingRepoPath);
  });
});
