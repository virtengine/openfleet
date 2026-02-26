import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveAgentRepoRoot, resolveRepoRoot } from "../scripts/bosun/config/repo-root.mjs";

const ENV_KEYS = [
  "REPO_ROOT",
  "BOSUN_AGENT_REPO_ROOT",
  "BOSUN_DIR",
  "BOSUN_WORKSPACE",
  "PATH",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOME",
];

function snapshotEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}

function moduleRootPath() {
  return resolve(dirname(fileURLToPath(new URL("../repo-root.mjs", import.meta.url))));
}

function isolateConfigSearchPaths(tempRoot) {
  process.env.APPDATA = resolve(tempRoot, "appdata");
  process.env.LOCALAPPDATA = resolve(tempRoot, "localappdata");
  process.env.USERPROFILE = resolve(tempRoot, "userprofile");
  process.env.HOME = resolve(tempRoot, "home");
}

test(
  "resolveRepoRoot prefers Bosun module root over config fallback when git is unavailable",
  { concurrency: false },
  async (t) => {
    const tempRoot = await mkdtemp(resolve(tmpdir(), "bosun-repo-root-"));
    const envSnapshot = snapshotEnv(ENV_KEYS);
    t.after(async () => {
      restoreEnv(envSnapshot);
      await rm(tempRoot, { recursive: true, force: true });
    });

    const configDir = resolve(tempRoot, "config");
    const configRepo = resolve(tempRoot, "config-repo");
    const noGitBin = resolve(tempRoot, "no-git-bin");
    const cwd = resolve(tempRoot, "cwd");
    await mkdir(configDir, { recursive: true });
    await mkdir(configRepo, { recursive: true });
    await mkdir(noGitBin, { recursive: true });
    await mkdir(cwd, { recursive: true });

    await writeFile(
      resolve(configDir, "bosun.config.json"),
      JSON.stringify(
        {
          repositories: [{ path: configRepo, primary: true }],
        },
        null,
        2,
      ),
      "utf8",
    );

    delete process.env.REPO_ROOT;
    process.env.BOSUN_DIR = configDir;
    process.env.PATH = noGitBin;
    isolateConfigSearchPaths(tempRoot);

    const resolved = resolveRepoRoot({ cwd });
    assert.equal(resolved, moduleRootPath());
    assert.notEqual(resolved, resolve(configRepo));
  },
);

test(
  "resolveRepoRoot honors explicit REPO_ROOT before all fallbacks",
  { concurrency: false },
  async (t) => {
    const tempRoot = await mkdtemp(resolve(tmpdir(), "bosun-repo-root-"));
    const envSnapshot = snapshotEnv(ENV_KEYS);
    t.after(async () => {
      restoreEnv(envSnapshot);
      await rm(tempRoot, { recursive: true, force: true });
    });

    const explicitRoot = resolve(tempRoot, "explicit-repo");
    await mkdir(explicitRoot, { recursive: true });

    process.env.REPO_ROOT = explicitRoot;
    process.env.BOSUN_DIR = resolve(tempRoot, "unused");
    process.env.PATH = resolve(tempRoot, "also-unused");
    isolateConfigSearchPaths(tempRoot);

    const resolved = resolveRepoRoot({ cwd: resolve(tempRoot, "cwd") });
    assert.equal(resolved, resolve(explicitRoot));
  },
);

test(
  "resolveAgentRepoRoot picks workspace primary repo with .git marker",
  { concurrency: false },
  async (t) => {
    const tempRoot = await mkdtemp(resolve(tmpdir(), "bosun-agent-root-"));
    const envSnapshot = snapshotEnv(ENV_KEYS);
    t.after(async () => {
      restoreEnv(envSnapshot);
      await rm(tempRoot, { recursive: true, force: true });
    });

    const configDir = resolve(tempRoot, "config");
    const workspacePath = resolve(tempRoot, "workspaces", "alpha");
    const primaryRepo = resolve(workspacePath, "primary-repo");
    const secondaryRepo = resolve(workspacePath, "secondary-repo");
    await mkdir(resolve(primaryRepo, ".git"), { recursive: true });
    await mkdir(secondaryRepo, { recursive: true });
    await mkdir(configDir, { recursive: true });

    await writeFile(
      resolve(configDir, "bosun.config.json"),
      JSON.stringify(
        {
          workspaces: [
            {
              id: "alpha",
              path: workspacePath,
              activeRepo: "secondary-repo",
              repos: [
                { name: "primary-repo", primary: true },
                { name: "secondary-repo" },
              ],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    delete process.env.REPO_ROOT;
    delete process.env.BOSUN_AGENT_REPO_ROOT;
    process.env.BOSUN_DIR = configDir;
    process.env.BOSUN_WORKSPACE = "alpha";
    isolateConfigSearchPaths(tempRoot);

    const resolved = resolveAgentRepoRoot({ cwd: resolve(tempRoot, "cwd") });
    assert.equal(resolved, primaryRepo);
  },
);

test(
  "resolveAgentRepoRoot ignores missing BOSUN_AGENT_REPO_ROOT and falls back to workspace",
  { concurrency: false },
  async (t) => {
    const tempRoot = await mkdtemp(resolve(tmpdir(), "bosun-agent-root-"));
    const envSnapshot = snapshotEnv(ENV_KEYS);
    t.after(async () => {
      restoreEnv(envSnapshot);
      await rm(tempRoot, { recursive: true, force: true });
    });

    const configDir = resolve(tempRoot, "config");
    const workspacePath = resolve(tempRoot, "workspaces", "beta");
    const repoPath = resolve(workspacePath, "repo-a");
    await mkdir(resolve(repoPath, ".git"), { recursive: true });
    await mkdir(configDir, { recursive: true });

    await writeFile(
      resolve(configDir, "bosun.config.json"),
      JSON.stringify(
        {
          workspaces: [
            {
              id: "beta",
              path: workspacePath,
              repos: [{ name: "repo-a", primary: true }],
            },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );

    delete process.env.REPO_ROOT;
    process.env.BOSUN_AGENT_REPO_ROOT = resolve(tempRoot, "missing-agent-root");
    process.env.BOSUN_DIR = configDir;
    process.env.BOSUN_WORKSPACE = "beta";
    isolateConfigSearchPaths(tempRoot);

    const resolved = resolveAgentRepoRoot({ cwd: resolve(tempRoot, "cwd") });
    assert.equal(resolved, repoPath);
  },
);

test(
  "resolveAgentRepoRoot handles invalid workspace config and falls back to REPO_ROOT",
  { concurrency: false },
  async (t) => {
    const tempRoot = await mkdtemp(resolve(tmpdir(), "bosun-agent-root-"));
    const envSnapshot = snapshotEnv(ENV_KEYS);
    t.after(async () => {
      restoreEnv(envSnapshot);
      await rm(tempRoot, { recursive: true, force: true });
    });

    const configDir = resolve(tempRoot, "config");
    const fallbackRoot = resolve(tempRoot, "fallback-repo");
    await mkdir(configDir, { recursive: true });
    await mkdir(fallbackRoot, { recursive: true });
    await writeFile(resolve(configDir, "bosun.config.json"), "{invalid-json", "utf8");

    process.env.REPO_ROOT = fallbackRoot;
    delete process.env.BOSUN_AGENT_REPO_ROOT;
    process.env.BOSUN_DIR = configDir;
    delete process.env.BOSUN_WORKSPACE;
    isolateConfigSearchPaths(tempRoot);

    const resolved = resolveAgentRepoRoot({ cwd: resolve(tempRoot, "cwd") });
    assert.equal(resolved, fallbackRoot);
  },
);
