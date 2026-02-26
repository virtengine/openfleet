import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
  getWorkspacesDir,
  getWorkspacePath,
  getRepoPath,
  listWorkspaces,
  getWorkspace,
  getActiveWorkspace,
  createWorkspace,
  removeWorkspace,
  setActiveWorkspace,
  setActiveRepo,
  removeRepoFromWorkspace,
  getWorkspaceRepositories,
  detectWorkspaces,
  mergeDetectedWorkspaces,
  initializeWorkspaces,
} from "../scripts/bosun/workspaces/workspace-manager.mjs";

// ── Test Helpers ────────────────────────────────────────────────────────────

let TEST_DIR = "";

function configPath() {
  return TEST_DIR;
}

function writeConfig(config) {
  writeFileSync(
    resolve(TEST_DIR, "bosun.config.json"),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}

function readConfig() {
  const raw = readFileSync(resolve(TEST_DIR, "bosun.config.json"), "utf8");
  return JSON.parse(raw);
}

/**
 * Create a fake git repo directory (with .git folder) under the workspaces dir.
 * @param {string} workspaceId
 * @param {string} repoName
 * @param {{ remoteUrl?: string }} opts
 */
function createFakeRepo(workspaceId, repoName, opts = {}) {
  const repoDir = resolve(TEST_DIR, "workspaces", workspaceId, repoName);
  mkdirSync(resolve(repoDir, ".git"), { recursive: true });
  writeFileSync(resolve(repoDir, ".git", "HEAD"), "ref: refs/heads/main\n");

  if (opts.remoteUrl) {
    // Create a real git repo so `git remote get-url origin` works
    try {
      execSync("git init", { cwd: repoDir, stdio: "pipe" });
      execSync(`git remote add origin ${opts.remoteUrl}`, {
        cwd: repoDir,
        stdio: "pipe",
      });
    } catch {
      // Fallback: just write a git config manually
      mkdirSync(resolve(repoDir, ".git"), { recursive: true });
      writeFileSync(
        resolve(repoDir, ".git", "config"),
        `[remote "origin"]\n\turl = ${opts.remoteUrl}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
      );
    }
  }
  return repoDir;
}

/**
 * Create a workspace directory without any repos.
 */
function createWorkspaceDir(workspaceId) {
  const wsDir = resolve(TEST_DIR, "workspaces", workspaceId);
  mkdirSync(wsDir, { recursive: true });
  return wsDir;
}

describe("workspace-manager", () => {
  beforeEach(() => {
    TEST_DIR = mkdtempSync(resolve(tmpdir(), "bosun-ws-mgr-test-"));
    mkdirSync(resolve(TEST_DIR, "workspaces"), { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(TEST_DIR)) {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ── Path Helpers ────────────────────────────────────────────────────────

  describe("getWorkspacesDir", () => {
    it("returns the workspaces subdirectory of configDir", () => {
      const result = getWorkspacesDir("/home/user/bosun");
      expect(result).toBe(resolve("/home/user/bosun", "workspaces"));
    });
  });

  describe("getWorkspacePath", () => {
    it("returns workspace path under workspaces dir", () => {
      const result = getWorkspacePath("/home/user/bosun", "my-ws");
      expect(result).toBe(resolve("/home/user/bosun", "workspaces", "my-ws"));
    });
  });

  describe("getRepoPath", () => {
    it("returns repo path under workspace", () => {
      const result = getRepoPath("/home/user/bosun", "my-ws", "my-repo");
      expect(result).toBe(
        resolve("/home/user/bosun", "workspaces", "my-ws", "my-repo"),
      );
    });
  });

  // ── listWorkspaces ──────────────────────────────────────────────────────

  describe("listWorkspaces", () => {
    it("returns empty array when no config exists", () => {
      const result = listWorkspaces(TEST_DIR);
      expect(result).toEqual([]);
    });

    it("returns empty array when config has no workspaces key", () => {
      writeConfig({});
      const result = listWorkspaces(TEST_DIR);
      expect(result).toEqual([]);
    });

    it("lists configured workspaces with repo existence detection", () => {
      const repoDir = createFakeRepo("alpha", "repo-a");
      writeConfig({
        workspaces: [
          {
            id: "alpha",
            name: "Alpha",
            repos: [
              { name: "repo-a", slug: "org/repo-a", url: "" },
              { name: "repo-b", slug: "org/repo-b", url: "" },
            ],
            activeRepo: "repo-a",
          },
        ],
        activeWorkspace: "alpha",
      });

      const result = listWorkspaces(TEST_DIR);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("alpha");
      expect(result[0].exists).toBe(true);
      expect(result[0].repos).toHaveLength(2);

      const repoA = result[0].repos.find((r) => r.name === "repo-a");
      const repoB = result[0].repos.find((r) => r.name === "repo-b");
      expect(repoA.exists).toBe(true);
      expect(repoB.exists).toBe(false);
    });

    it("uses repoRoot override for missing repos", () => {
      // Create a repo under an alternate root, not under workspaces/
      const altRoot = resolve(TEST_DIR, "alt-root");
      mkdirSync(resolve(altRoot, "repo-x", ".git"), { recursive: true });

      writeConfig({
        workspaces: [
          {
            id: "beta",
            name: "Beta",
            repos: [{ name: "repo-x", slug: "org/repo-x", url: "" }],
            activeRepo: "repo-x",
          },
        ],
      });

      // Without repoRoot override, repo is missing
      const withoutOverride = listWorkspaces(TEST_DIR);
      expect(withoutOverride[0].repos[0].exists).toBe(false);

      // With repoRoot override, repo is found
      const withOverride = listWorkspaces(TEST_DIR, { repoRoot: altRoot });
      expect(withOverride[0].repos[0].exists).toBe(true);
      expect(withOverride[0].repos[0].path).toBe(resolve(altRoot, "repo-x"));
    });

    it("workspace exists if directory exists even with no repos present on disk", () => {
      createWorkspaceDir("empty-ws");
      writeConfig({
        workspaces: [
          {
            id: "empty-ws",
            name: "Empty",
            repos: [],
          },
        ],
      });

      const result = listWorkspaces(TEST_DIR);
      expect(result[0].exists).toBe(true);
    });

    it("workspace shows as existing if any repo exists on disk", () => {
      // Don't create the workspace directory itself, but create a repo under it
      createFakeRepo("ws-nodir", "my-repo");
      writeConfig({
        workspaces: [
          {
            id: "ws-nodir",
            name: "NoDir",
            repos: [{ name: "my-repo", slug: "", url: "" }],
          },
        ],
      });

      const result = listWorkspaces(TEST_DIR);
      expect(result[0].exists).toBe(true);
    });
  });

  // ── getWorkspace ────────────────────────────────────────────────────────

  describe("getWorkspace", () => {
    it("finds workspace by normalized ID", () => {
      writeConfig({
        workspaces: [
          { id: "my-workspace", name: "My Workspace", repos: [] },
        ],
      });

      const result = getWorkspace(TEST_DIR, "MY WORKSPACE");
      expect(result).not.toBeNull();
      expect(result.id).toBe("my-workspace");
    });

    it("returns null when workspace does not exist", () => {
      writeConfig({ workspaces: [] });
      const result = getWorkspace(TEST_DIR, "nonexistent");
      expect(result).toBeNull();
    });
  });

  // ── getActiveWorkspace ──────────────────────────────────────────────────

  describe("getActiveWorkspace", () => {
    it("returns workspace matching activeWorkspace config", () => {
      writeConfig({
        workspaces: [
          { id: "ws1", name: "WS1", repos: [] },
          { id: "ws2", name: "WS2", repos: [] },
        ],
        activeWorkspace: "ws2",
      });

      const result = getActiveWorkspace(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result.id).toBe("ws2");
    });

    it("falls back to first workspace when activeWorkspace is not set", () => {
      writeConfig({
        workspaces: [
          { id: "first", name: "First", repos: [] },
          { id: "second", name: "Second", repos: [] },
        ],
      });

      const result = getActiveWorkspace(TEST_DIR);
      expect(result).not.toBeNull();
      expect(result.id).toBe("first");
    });

    it("returns null when no workspaces exist", () => {
      writeConfig({ workspaces: [] });
      const result = getActiveWorkspace(TEST_DIR);
      expect(result).toBeNull();
    });
  });

  // ── createWorkspace ─────────────────────────────────────────────────────

  describe("createWorkspace", () => {
    it("creates a workspace with a new directory", () => {
      writeConfig({ workspaces: [] });

      const result = createWorkspace(TEST_DIR, { name: "New WS" });

      expect(result.id).toBe("new-ws");
      expect(result.name).toBe("New WS");
      expect(result.exists).toBe(true);
      expect(existsSync(result.path)).toBe(true);

      const config = readConfig();
      expect(config.workspaces).toHaveLength(1);
      expect(config.workspaces[0].id).toBe("new-ws");
    });

    it("sets first workspace as active automatically", () => {
      writeConfig({ workspaces: [] });

      createWorkspace(TEST_DIR, { name: "First" });

      const config = readConfig();
      expect(config.activeWorkspace).toBe("first");
    });

    it("does not override active workspace when adding a second workspace", () => {
      writeConfig({
        workspaces: [{ id: "existing", name: "Existing", repos: [] }],
        activeWorkspace: "existing",
      });

      createWorkspace(TEST_DIR, { name: "Second" });

      const config = readConfig();
      expect(config.activeWorkspace).toBe("existing");
    });

    it("throws when workspace already exists", () => {
      writeConfig({
        workspaces: [{ id: "dup", name: "Dup", repos: [] }],
      });

      expect(() => createWorkspace(TEST_DIR, { name: "dup" })).toThrow(
        /already exists/,
      );
    });

    it("throws when name is empty", () => {
      writeConfig({ workspaces: [] });
      expect(() => createWorkspace(TEST_DIR, { name: "" })).toThrow(
        /required/,
      );
    });

    it("normalizes workspace ID from name", () => {
      writeConfig({ workspaces: [] });

      const result = createWorkspace(TEST_DIR, {
        name: "My Special WS!!!",
      });

      expect(result.id).toBe("my-special-ws");
    });

    it("uses explicit id when provided", () => {
      writeConfig({ workspaces: [] });

      const result = createWorkspace(TEST_DIR, {
        name: "Display Name",
        id: "custom-id",
      });

      expect(result.id).toBe("custom-id");
    });
  });

  // ── removeWorkspace ─────────────────────────────────────────────────────

  describe("removeWorkspace", () => {
    it("removes workspace from config", () => {
      writeConfig({
        workspaces: [{ id: "to-remove", name: "Remove", repos: [] }],
        activeWorkspace: "other",
      });

      const result = removeWorkspace(TEST_DIR, "to-remove");

      expect(result).toBe(true);
      const config = readConfig();
      expect(config.workspaces).toHaveLength(0);
    });

    it("returns false for non-existent workspace", () => {
      writeConfig({ workspaces: [] });
      expect(removeWorkspace(TEST_DIR, "nope")).toBe(false);
    });

    it("deletes files when deleteFiles option is true", () => {
      const wsDir = createWorkspaceDir("deleteme");
      writeConfig({
        workspaces: [{ id: "deleteme", name: "Delete Me", repos: [] }],
      });

      removeWorkspace(TEST_DIR, "deleteme", { deleteFiles: true });

      expect(existsSync(wsDir)).toBe(false);
    });

    it("does not delete files by default", () => {
      const wsDir = createWorkspaceDir("keepme");
      writeConfig({
        workspaces: [{ id: "keepme", name: "Keep Me", repos: [] }],
      });

      removeWorkspace(TEST_DIR, "keepme");

      expect(existsSync(wsDir)).toBe(true);
    });

    it("updates active workspace when removing the active one", () => {
      writeConfig({
        workspaces: [
          { id: "ws-a", name: "A", repos: [] },
          { id: "ws-b", name: "B", repos: [] },
        ],
        activeWorkspace: "ws-a",
      });

      removeWorkspace(TEST_DIR, "ws-a");

      const config = readConfig();
      expect(config.activeWorkspace).toBe("ws-b");
    });

    it("clears active workspace when removing the last workspace", () => {
      writeConfig({
        workspaces: [{ id: "only", name: "Only", repos: [] }],
        activeWorkspace: "only",
      });

      removeWorkspace(TEST_DIR, "only");

      const config = readConfig();
      expect(config.activeWorkspace).toBe("");
    });
  });

  // ── setActiveWorkspace ──────────────────────────────────────────────────

  describe("setActiveWorkspace", () => {
    it("sets the active workspace", () => {
      writeConfig({
        workspaces: [
          { id: "ws-a", name: "A", repos: [] },
          { id: "ws-b", name: "B", repos: [] },
        ],
        activeWorkspace: "ws-a",
      });

      setActiveWorkspace(TEST_DIR, "ws-b");

      const config = readConfig();
      expect(config.activeWorkspace).toBe("ws-b");
    });

    it("throws when workspace does not exist", () => {
      writeConfig({ workspaces: [] });
      expect(() => setActiveWorkspace(TEST_DIR, "nope")).toThrow(/not found/);
    });
  });

  // ── Repo Management ────────────────────────────────────────────────────

  describe("setActiveRepo", () => {
    it("sets active repo within a workspace", () => {
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [
              { name: "repo-a", slug: "", url: "" },
              { name: "repo-b", slug: "", url: "" },
            ],
            activeRepo: "repo-a",
          },
        ],
      });

      const result = setActiveRepo(TEST_DIR, "ws1", "repo-b");

      expect(result).toBe(true);
      const config = readConfig();
      expect(config.workspaces[0].activeRepo).toBe("repo-b");
    });

    it("returns false for non-existent workspace", () => {
      writeConfig({ workspaces: [] });
      expect(setActiveRepo(TEST_DIR, "nope", "repo")).toBe(false);
    });

    it("returns false for non-existent repo", () => {
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [{ name: "repo-a", slug: "", url: "" }],
          },
        ],
      });

      expect(setActiveRepo(TEST_DIR, "ws1", "repo-z")).toBe(false);
    });
  });

  describe("removeRepoFromWorkspace", () => {
    it("removes a repo from the workspace config", () => {
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [
              { name: "repo-a", slug: "", url: "" },
              { name: "repo-b", slug: "", url: "" },
            ],
            activeRepo: "repo-b",
          },
        ],
      });

      const result = removeRepoFromWorkspace(TEST_DIR, "ws1", "repo-a");

      expect(result).toBe(true);
      const config = readConfig();
      expect(config.workspaces[0].repos).toHaveLength(1);
      expect(config.workspaces[0].repos[0].name).toBe("repo-b");
    });

    it("updates activeRepo when removing the active repo", () => {
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [
              { name: "repo-a", slug: "", url: "" },
              { name: "repo-b", slug: "", url: "" },
            ],
            activeRepo: "repo-a",
          },
        ],
      });

      removeRepoFromWorkspace(TEST_DIR, "ws1", "repo-a");

      const config = readConfig();
      expect(config.workspaces[0].activeRepo).toBe("repo-b");
    });

    it("sets activeRepo to null when removing the last repo", () => {
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [{ name: "only-repo", slug: "", url: "" }],
            activeRepo: "only-repo",
          },
        ],
      });

      removeRepoFromWorkspace(TEST_DIR, "ws1", "only-repo");

      const config = readConfig();
      expect(config.workspaces[0].activeRepo).toBeNull();
    });

    it("returns false for non-existent workspace", () => {
      writeConfig({ workspaces: [] });
      expect(removeRepoFromWorkspace(TEST_DIR, "nope", "repo")).toBe(false);
    });

    it("returns false for non-existent repo", () => {
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [{ name: "repo-a", slug: "", url: "" }],
          },
        ],
      });

      expect(removeRepoFromWorkspace(TEST_DIR, "ws1", "missing")).toBe(false);
    });

    it("deletes repo directory when deleteFiles is true", () => {
      const repoDir = createFakeRepo("ws1", "my-repo");
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [{ name: "my-repo", slug: "", url: "" }],
          },
        ],
      });

      removeRepoFromWorkspace(TEST_DIR, "ws1", "my-repo", {
        deleteFiles: true,
      });

      expect(existsSync(repoDir)).toBe(false);
    });
  });

  // ── getWorkspaceRepositories ──────────────────────────────────────────

  describe("getWorkspaceRepositories", () => {
    it("returns repos for the active workspace", () => {
      createWorkspaceDir("ws1");
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [
              {
                name: "repo-a",
                slug: "org/repo-a",
                url: "git@github.com:org/repo-a.git",
                primary: true,
              },
              {
                name: "repo-b",
                slug: "org/repo-b",
                url: "git@github.com:org/repo-b.git",
              },
            ],
            activeRepo: "repo-a",
          },
        ],
        activeWorkspace: "ws1",
      });

      const repos = getWorkspaceRepositories(TEST_DIR);

      expect(repos).toHaveLength(2);
      expect(repos[0].name).toBe("repo-a");
      expect(repos[0].primary).toBe(true);
      expect(repos[0].workspace).toBe("ws1");
      expect(repos[1].name).toBe("repo-b");
    });

    it("returns repos for a specific workspace ID", () => {
      createWorkspaceDir("ws2");
      writeConfig({
        workspaces: [
          { id: "ws1", name: "WS1", repos: [{ name: "r1", slug: "", url: "" }] },
          {
            id: "ws2",
            name: "WS2",
            repos: [
              { name: "r2", slug: "org/r2", url: "", primary: true },
            ],
            activeRepo: "r2",
          },
        ],
        activeWorkspace: "ws1",
      });

      const repos = getWorkspaceRepositories(TEST_DIR, "ws2");

      expect(repos).toHaveLength(1);
      expect(repos[0].name).toBe("r2");
      expect(repos[0].workspace).toBe("ws2");
    });

    it("returns empty array when workspace has no repos", () => {
      writeConfig({
        workspaces: [{ id: "empty", name: "Empty", repos: [] }],
        activeWorkspace: "empty",
      });

      const repos = getWorkspaceRepositories(TEST_DIR);
      expect(repos).toEqual([]);
    });

    it("returns empty array when no workspaces exist", () => {
      writeConfig({ workspaces: [] });
      const repos = getWorkspaceRepositories(TEST_DIR);
      expect(repos).toEqual([]);
    });
  });

  // ── detectWorkspaces ──────────────────────────────────────────────────

  describe("detectWorkspaces", () => {
    it("returns empty array when workspaces dir does not exist", () => {
      const emptyDir = mkdtempSync(resolve(tmpdir(), "bosun-empty-"));
      const result = detectWorkspaces(emptyDir);
      expect(result).toEqual([]);
      // Cleanup
      rm(emptyDir, { recursive: true, force: true });
    });

    it("detects workspace directories containing git repos", () => {
      createFakeRepo("project-alpha", "frontend", {
        remoteUrl: "git@github.com:myorg/frontend.git",
      });
      createFakeRepo("project-alpha", "backend", {
        remoteUrl: "git@github.com:myorg/backend.git",
      });

      const result = detectWorkspaces(TEST_DIR);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("project-alpha");
      expect(result[0].name).toBe("project-alpha");
      expect(result[0].repos).toHaveLength(2);

      const repoNames = result[0].repos.map((r) => r.name).sort();
      expect(repoNames).toEqual(["backend", "frontend"]);

      // First repo should be primary
      expect(result[0].repos[0].primary).toBe(true);
      // activeRepo should be first detected
      expect(result[0].activeRepo).toBe(result[0].repos[0].name);
    });

    it("ignores directories without git repos", () => {
      // Create a workspace dir with a non-git subdir
      const wsDir = createWorkspaceDir("no-repos");
      mkdirSync(resolve(wsDir, "just-files"), { recursive: true });
      writeFileSync(resolve(wsDir, "just-files", "README.md"), "hello");

      const result = detectWorkspaces(TEST_DIR);

      // Should not detect a workspace with no git repos
      expect(result.find((w) => w.id === "no-repos")).toBeUndefined();
    });

    it("detects multiple workspaces", () => {
      createFakeRepo("ws-one", "app");
      createFakeRepo("ws-two", "service");

      const result = detectWorkspaces(TEST_DIR);

      expect(result).toHaveLength(2);
      const ids = result.map((w) => w.id).sort();
      expect(ids).toEqual(["ws-one", "ws-two"]);
    });

    it("normalizes workspace IDs", () => {
      // Create a directory with unusual casing
      createFakeRepo("My Project", "repo");

      const result = detectWorkspaces(TEST_DIR);

      const ws = result.find((w) => w.name === "My Project");
      expect(ws).toBeDefined();
      expect(ws.id).toBe("my-project");
    });

    it("ignores files at workspace level (non-directories)", () => {
      writeFileSync(
        resolve(TEST_DIR, "workspaces", "not-a-dir.txt"),
        "hello",
      );
      createFakeRepo("real-ws", "repo");

      const result = detectWorkspaces(TEST_DIR);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("real-ws");
    });
  });

  // ── mergeDetectedWorkspaces ───────────────────────────────────────────

  describe("mergeDetectedWorkspaces", () => {
    it("adds newly detected workspaces to empty config", () => {
      writeConfig({ workspaces: [] });
      createFakeRepo("new-ws", "app");

      const result = mergeDetectedWorkspaces(TEST_DIR);

      expect(result.added).toBe(1);
      expect(result.updated).toBe(0);
      expect(result.scanned).toBe(1);
      expect(result.workspaces).toHaveLength(1);
      expect(result.workspaces[0].id).toBe("new-ws");
    });

    it("does not add duplicate workspaces", () => {
      createFakeRepo("existing", "app");
      writeConfig({
        workspaces: [
          {
            id: "existing",
            name: "Existing",
            repos: [{ name: "app", slug: "", url: "" }],
            activeRepo: "app",
          },
        ],
      });

      const result = mergeDetectedWorkspaces(TEST_DIR);

      expect(result.added).toBe(0);
      // Should not create a second entry
      const config = readConfig();
      expect(config.workspaces).toHaveLength(1);
    });

    it("updates existing workspace with new repos from filesystem", () => {
      createFakeRepo("ws1", "existing-repo");
      createFakeRepo("ws1", "new-repo");
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [{ name: "existing-repo", slug: "", url: "" }],
            activeRepo: "existing-repo",
          },
        ],
      });

      const result = mergeDetectedWorkspaces(TEST_DIR);

      expect(result.updated).toBe(1);
      const config = readConfig();
      const ws = config.workspaces.find((w) => w.id === "ws1");
      expect(ws.repos).toHaveLength(2);
      const repoNames = ws.repos.map((r) => r.name).sort();
      expect(repoNames).toEqual(["existing-repo", "new-repo"]);
    });

    it("fills in missing slug from detected repos", () => {
      createFakeRepo("ws1", "repo-a", {
        remoteUrl: "git@github.com:myorg/repo-a.git",
      });
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [{ name: "repo-a", slug: "", url: "" }],
          },
        ],
      });

      mergeDetectedWorkspaces(TEST_DIR);

      const config = readConfig();
      const repo = config.workspaces[0].repos.find((r) => r.name === "repo-a");
      expect(repo.slug).toBe("myorg/repo-a");
    });

    it("sets activeRepo when existing workspace lacks one", () => {
      createFakeRepo("ws1", "repo-a");
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [{ name: "repo-a", slug: "", url: "" }],
            // No activeRepo set
          },
        ],
      });

      mergeDetectedWorkspaces(TEST_DIR);

      const config = readConfig();
      expect(config.workspaces[0].activeRepo).toBe("repo-a");
    });

    it("preserves existing activeRepo when it is set", () => {
      createFakeRepo("ws1", "repo-a");
      createFakeRepo("ws1", "repo-b");
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [
              { name: "repo-a", slug: "", url: "" },
            ],
            activeRepo: "repo-a",
          },
        ],
      });

      mergeDetectedWorkspaces(TEST_DIR);

      const config = readConfig();
      expect(config.workspaces[0].activeRepo).toBe("repo-a");
    });

    it("preserves activeWorkspace setting", () => {
      createFakeRepo("ws1", "repo-a");
      createFakeRepo("ws2", "repo-b");
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [{ name: "repo-a", slug: "", url: "" }],
            activeRepo: "repo-a",
          },
        ],
        activeWorkspace: "ws1",
      });

      mergeDetectedWorkspaces(TEST_DIR);

      const config = readConfig();
      expect(config.activeWorkspace).toBe("ws1");
    });

    it("returns zero counts when nothing changed", () => {
      writeConfig({ workspaces: [] });
      // No repos on filesystem

      const result = mergeDetectedWorkspaces(TEST_DIR);

      expect(result.added).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.scanned).toBe(0);
    });
  });

  // ── initializeWorkspaces ──────────────────────────────────────────────

  describe("initializeWorkspaces", () => {
    it("returns existing workspaces when config already has them", () => {
      createWorkspaceDir("ws1");
      writeConfig({
        workspaces: [
          { id: "ws1", name: "WS1", repos: [] },
        ],
      });

      const result = initializeWorkspaces(TEST_DIR);

      expect(result.isNew).toBe(false);
      expect(result.workspaces).toHaveLength(1);
    });

    it("auto-detects and saves workspaces on first run", () => {
      writeConfig({ workspaces: [] });
      createFakeRepo("discovered", "app");

      const result = initializeWorkspaces(TEST_DIR);

      expect(result.isNew).toBe(true);
      expect(result.workspaces).toHaveLength(1);
      expect(result.workspaces[0].id).toBe("discovered");

      // Should persist to config
      const config = readConfig();
      expect(config.workspaces).toHaveLength(1);
      expect(config.activeWorkspace).toBe("discovered");
    });

    it("returns empty workspaces when nothing to detect", () => {
      writeConfig({ workspaces: [] });
      // No repos on filesystem

      const result = initializeWorkspaces(TEST_DIR);

      expect(result.isNew).toBe(true);
      expect(result.workspaces).toHaveLength(0);
    });

    it("passes opts through to listWorkspaces", () => {
      const altRoot = resolve(TEST_DIR, "alt");
      mkdirSync(resolve(altRoot, "repo-x", ".git"), { recursive: true });

      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [{ name: "repo-x", slug: "", url: "" }],
          },
        ],
      });

      const result = initializeWorkspaces(TEST_DIR, { repoRoot: altRoot });

      expect(result.isNew).toBe(false);
      expect(result.workspaces[0].repos[0].exists).toBe(true);
    });
  });

  // ── Edge Cases ────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("handles corrupted config JSON gracefully", () => {
      writeFileSync(
        resolve(TEST_DIR, "bosun.config.json"),
        "NOT VALID JSON {{{",
        "utf8",
      );

      // Should not throw — loadBosunConfig catches parse errors
      const result = listWorkspaces(TEST_DIR);
      expect(result).toEqual([]);
    });

    it("handles missing config file gracefully", () => {
      // No config file at all
      const result = listWorkspaces(TEST_DIR);
      expect(result).toEqual([]);
    });

    it("handles workspaces array being non-array in config", () => {
      writeConfig({ workspaces: "not-an-array" });
      const result = listWorkspaces(TEST_DIR);
      expect(result).toEqual([]);
    });

    it("handles repos being undefined in workspace entry", () => {
      writeConfig({
        workspaces: [{ id: "ws1", name: "WS1" }],
      });

      const result = listWorkspaces(TEST_DIR);
      expect(result).toHaveLength(1);
      expect(result[0].repos).toEqual([]);
    });

    it("normalizeId handles special characters", () => {
      writeConfig({ workspaces: [] });

      const result = createWorkspace(TEST_DIR, {
        name: "Hello World! @#$%",
      });

      expect(result.id).toBe("hello-world");
    });

    it("normalizeId handles leading/trailing dashes", () => {
      writeConfig({ workspaces: [] });

      const result = createWorkspace(TEST_DIR, {
        name: "---test---",
      });

      expect(result.id).toBe("test");
    });

    it("createWorkspace and removeWorkspace round-trip", () => {
      writeConfig({ workspaces: [] });

      createWorkspace(TEST_DIR, { name: "roundtrip" });
      expect(readConfig().workspaces).toHaveLength(1);

      removeWorkspace(TEST_DIR, "roundtrip", { deleteFiles: true });
      expect(readConfig().workspaces).toHaveLength(0);
    });

    it("duplicate repo names across different workspaces", () => {
      createFakeRepo("ws-a", "shared-name");
      createFakeRepo("ws-b", "shared-name");

      const detected = detectWorkspaces(TEST_DIR);

      expect(detected).toHaveLength(2);
      const wsA = detected.find((w) => w.id === "ws-a");
      const wsB = detected.find((w) => w.id === "ws-b");
      expect(wsA.repos[0].name).toBe("shared-name");
      expect(wsB.repos[0].name).toBe("shared-name");
    });

    it("duplicate slug repos within same workspace config", () => {
      writeConfig({
        workspaces: [
          {
            id: "ws1",
            name: "WS1",
            repos: [
              { name: "repo-a", slug: "org/repo", url: "" },
              { name: "repo-b", slug: "org/repo", url: "" },
            ],
          },
        ],
      });

      const result = listWorkspaces(TEST_DIR);
      expect(result[0].repos).toHaveLength(2);
    });

    it("many workspaces can be listed efficiently", () => {
      const workspaces = [];
      for (let i = 0; i < 20; i++) {
        workspaces.push({
          id: `ws-${i}`,
          name: `Workspace ${i}`,
          repos: [],
        });
      }
      writeConfig({ workspaces });

      const result = listWorkspaces(TEST_DIR);
      expect(result).toHaveLength(20);
    });
  });
});
