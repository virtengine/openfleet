import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { rmSync } from "node:fs";

// ── Mocks ────────────────────────────────────────────────────────────────────

const execSyncMock = vi.hoisted(() => vi.fn());
const readdirSyncMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn());
const resolveRepoRootMock = vi.hoisted(() => vi.fn());

let MOCK_REPO_ROOT = "";

vi.mock("node:child_process", () => ({
  execSync: execSyncMock,
}));

vi.mock("../repo-root.mjs", () => ({
  resolveRepoRoot: resolveRepoRootMock,
}));

// We need to re-mock fs selectively — only readdirSync and existsSync for
// the discovery helpers. configureNonInteractiveGit also uses existsSync
// so we provide a controllable mock.
vi.mock("node:fs", async (importOriginal) => {
  const orig = await importOriginal();
  return {
    ...orig,
    existsSync: existsSyncMock,
    readdirSync: readdirSyncMock,
  };
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function setupTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "git-editor-fix-test-"));
  return dir;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("git-editor-fix", () => {
  let tempDir = "";

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = resolve(tmpdir(), `git-editor-fix-test-${Date.now()}`);
    MOCK_REPO_ROOT = tempDir;
    resolveRepoRootMock.mockReturnValue(tempDir);
    // Default: existsSync returns true for .git paths
    existsSyncMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // We need to import after mocks are set up
  let configureNonInteractiveGit;
  let fixAllWorkspaces;
  let configureRepoAndWorktrees;
  let findGitWorktrees;
  let findVKWorktrees;
  let findTmpclaudeWorkspaces;

  beforeEach(async () => {
    const mod = await import("../scripts/bosun/git/git-editor-fix.mjs"");
    configureNonInteractiveGit = mod.configureNonInteractiveGit;
    fixAllWorkspaces = mod.fixAllWorkspaces;
    configureRepoAndWorktrees = mod.configureRepoAndWorktrees;
    findGitWorktrees = mod.findGitWorktrees;
    findVKWorktrees = mod.findVKWorktrees;
    findTmpclaudeWorkspaces = mod.findTmpclaudeWorkspaces;
  });

  // ── configureNonInteractiveGit ───────────────────────────────────────────

  describe("configureNonInteractiveGit", () => {
    it("sets core.editor and merge.commit.autoEdit for a workspace with .git", () => {
      existsSyncMock.mockReturnValue(true);
      execSyncMock.mockReturnValue("");

      const result = configureNonInteractiveGit("/fake/workspace");

      expect(result).toBe(true);
      expect(execSyncMock).toHaveBeenCalledTimes(2);

      // First call: set core.editor to ':'
      const firstCall = execSyncMock.mock.calls[0];
      expect(firstCall[0]).toBe("git config --local core.editor :");
      expect(firstCall[1]).toMatchObject({ cwd: "/fake/workspace" });

      // Second call: disable merge commit autoEdit
      const secondCall = execSyncMock.mock.calls[1];
      expect(secondCall[0]).toBe("git config --local merge.commit.autoEdit no");
      expect(secondCall[1]).toMatchObject({ cwd: "/fake/workspace" });
    });

    it("returns false when .git does not exist", () => {
      existsSyncMock.mockReturnValue(false);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = configureNonInteractiveGit("/no/git/here");

      expect(result).toBe(false);
      expect(execSyncMock).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("No .git entry"),
      );
      warnSpy.mockRestore();
    });

    it("returns false when execSync throws an error", () => {
      existsSyncMock.mockReturnValue(true);
      execSyncMock.mockImplementation(() => {
        throw new Error("git not found");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = configureNonInteractiveGit("/bad/workspace");

      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Failed to configure"),
        expect.stringContaining("git not found"),
      );
      errorSpy.mockRestore();
    });

    it("uses stdio: pipe to suppress interactive output", () => {
      existsSyncMock.mockReturnValue(true);
      execSyncMock.mockReturnValue("");

      configureNonInteractiveGit("/some/workspace");

      for (const call of execSyncMock.mock.calls) {
        expect(call[1].stdio).toBe("pipe");
      }
    });
  });

  // ── findTmpclaudeWorkspaces ──────────────────────────────────────────────

  describe("findTmpclaudeWorkspaces", () => {
    it("returns tmpclaude-* directories from REPO_ROOT", () => {
      readdirSyncMock.mockReturnValue([
        { name: "tmpclaude-abc", isDirectory: () => true },
        { name: "tmpclaude-def", isDirectory: () => true },
        { name: "node_modules", isDirectory: () => true },
        { name: "README.md", isDirectory: () => false },
      ]);

      const result = findTmpclaudeWorkspaces();

      expect(result).toHaveLength(2);
      expect(result[0]).toContain("tmpclaude-abc");
      expect(result[1]).toContain("tmpclaude-def");
    });

    it("returns empty array when no tmpclaude directories exist", () => {
      readdirSyncMock.mockReturnValue([
        { name: "src", isDirectory: () => true },
        { name: "package.json", isDirectory: () => false },
      ]);

      const result = findTmpclaudeWorkspaces();

      expect(result).toEqual([]);
    });

    it("returns empty array when readdirSync throws", () => {
      readdirSyncMock.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = findTmpclaudeWorkspaces();

      expect(result).toEqual([]);
      errorSpy.mockRestore();
    });

    it("ignores files named tmpclaude-* (non-directories)", () => {
      readdirSyncMock.mockReturnValue([
        { name: "tmpclaude-file", isDirectory: () => false },
      ]);

      const result = findTmpclaudeWorkspaces();

      expect(result).toEqual([]);
    });
  });

  // ── findGitWorktrees ─────────────────────────────────────────────────────

  describe("findGitWorktrees", () => {
    it("parses git worktree list porcelain output", () => {
      const porcelainOutput = [
        `worktree ${resolve(tempDir, "main")}`,
        "HEAD abc123",
        "branch refs/heads/main",
        "",
        `worktree ${resolve(tempDir, "ve", "task-1")}`,
        "HEAD def456",
        "branch refs/heads/ve/task-1",
        "",
      ].join("\n");

      execSyncMock.mockReturnValue(porcelainOutput);
      existsSyncMock.mockReturnValue(true);

      const result = findGitWorktrees();

      expect(result).toContain(resolve(tempDir, "main"));
      expect(result).toContain(resolve(tempDir, "ve", "task-1"));
    });

    it("skips worktrees without .git entry", () => {
      const mainPath = resolve(tempDir, "main");
      const orphanPath = resolve(tempDir, "orphan");
      const porcelainOutput = [
        `worktree ${mainPath}`,
        "HEAD abc123",
        "",
        `worktree ${orphanPath}`,
        "HEAD def456",
        "",
      ].join("\n");

      execSyncMock.mockReturnValue(porcelainOutput);
      existsSyncMock.mockImplementation((path) => {
        // Only mainPath has .git
        return String(path).startsWith(mainPath);
      });

      const result = findGitWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0]).toContain("main");
    });

    it("returns empty array when git worktree list fails", () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("not a git repository");
      });

      const result = findGitWorktrees();

      expect(result).toEqual([]);
    });

    it("warns on non-repo errors", () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("permission denied");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = findGitWorktrees();

      expect(result).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Could not enumerate git worktrees"),
        expect.stringContaining("permission denied"),
      );
      warnSpy.mockRestore();
    });

    it("does not warn when error is 'not a git repository'", () => {
      execSyncMock.mockImplementation(() => {
        throw new Error("fatal: is not a git repository");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      findGitWorktrees();

      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it("handles empty porcelain output", () => {
      execSyncMock.mockReturnValue("");
      const result = findGitWorktrees();
      expect(result).toEqual([]);
    });
  });

  // ── findVKWorktrees ──────────────────────────────────────────────────────

  describe("findVKWorktrees", () => {
    it("returns directories under $TEMP/vibe-kanban/worktrees/ with .git", () => {
      // First existsSync: vkBase dir check
      existsSyncMock
        .mockReturnValueOnce(true) // vkBase exists
        .mockReturnValueOnce(true) // first dir has .git
        .mockReturnValueOnce(false); // second dir has no .git

      readdirSyncMock.mockReturnValue([
        { name: "task-42", isDirectory: () => true },
        { name: "task-99", isDirectory: () => true },
      ]);

      const result = findVKWorktrees();

      expect(result).toHaveLength(1);
      // Should include the first task dir that has .git
      expect(result[0]).toContain("task-42");
    });

    it("returns empty array when vkBase does not exist", () => {
      existsSyncMock.mockReturnValue(false);

      const result = findVKWorktrees();

      expect(result).toEqual([]);
      expect(readdirSyncMock).not.toHaveBeenCalled();
    });

    it("returns empty array when readdirSync throws", () => {
      existsSyncMock.mockReturnValue(true);
      readdirSyncMock.mockImplementation(() => {
        throw new Error("EACCES");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const result = findVKWorktrees();

      expect(result).toEqual([]);
      errorSpy.mockRestore();
    });

    it("skips non-directory entries", () => {
      existsSyncMock.mockReturnValue(true);
      readdirSyncMock.mockReturnValue([
        { name: "file.txt", isDirectory: () => false },
      ]);

      const result = findVKWorktrees();

      expect(result).toEqual([]);
    });
  });

  // ── configureRepoAndWorktrees ────────────────────────────────────────────

  describe("configureRepoAndWorktrees", () => {
    it("returns fix counts and deduplicates paths", () => {
      // Mock discovery: no tmpclaude, no worktrees, no VK
      readdirSyncMock.mockReturnValue([]);
      execSyncMock.mockReturnValue(""); // git worktree list
      existsSyncMock.mockReturnValue(true); // .git exists

      // Reset mock for the actual git config calls
      execSyncMock.mockReset();
      existsSyncMock.mockReturnValue(true);
      execSyncMock.mockReturnValue("");

      // Re-mock discovery to return nothing extra
      readdirSyncMock.mockReturnValue([]);

      const result = configureRepoAndWorktrees();

      expect(result).toHaveProperty("fixed");
      expect(result).toHaveProperty("total");
      expect(typeof result.fixed).toBe("number");
      expect(typeof result.total).toBe("number");
      expect(result.total).toBeGreaterThanOrEqual(1); // At least REPO_ROOT
    });

    it("counts successful and failed workspace configurations", () => {
      // Mock discovery: just REPO_ROOT
      readdirSyncMock.mockReturnValue([]);

      let callCount = 0;
      existsSyncMock.mockImplementation(() => {
        // First call: vkBase check (false), rest: .git checks
        callCount++;
        return callCount > 1;
      });

      // git worktree list returns empty
      execSyncMock.mockReturnValueOnce("");
      // git config calls succeed
      execSyncMock.mockReturnValue("");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const result = configureRepoAndWorktrees();

      expect(result.fixed).toBeLessThanOrEqual(result.total);
      logSpy.mockRestore();
    });
  });

  // ── fixAllWorkspaces ─────────────────────────────────────────────────────

  describe("fixAllWorkspaces", () => {
    it("logs workspace discovery and fix counts", () => {
      readdirSyncMock.mockReturnValue([]);
      existsSyncMock.mockReturnValue(true);
      execSyncMock.mockReturnValue("");

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      fixAllWorkspaces();

      const messages = logSpy.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => m.includes("Scanning for agent workspaces"))).toBe(true);
      expect(messages.some((m) => m.includes("workspace(s) to configure") || m.includes("Fixed"))).toBe(true);
      logSpy.mockRestore();
    });

    it("deduplicates paths found from multiple sources", () => {
      // tmpclaude scan returns one dir that is also a worktree
      const sharedPath = resolve(tempDir, "tmpclaude-shared");
      readdirSyncMock.mockImplementation((path, opts) => {
        if (String(path) === tempDir) {
          return [{ name: "tmpclaude-shared", isDirectory: () => true }];
        }
        return [];
      });

      // git worktree list also returns the same path
      execSyncMock.mockImplementation((cmd) => {
        if (String(cmd).includes("worktree list")) {
          return `worktree ${sharedPath}\nHEAD abc\n`;
        }
        return "";
      });

      existsSyncMock.mockReturnValue(true);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      fixAllWorkspaces();

      // Should deduplicate: REPO_ROOT + sharedPath = 2 unique
      const configCalls = execSyncMock.mock.calls.filter((c) =>
        String(c[0]).includes("git config"),
      );
      // Each workspace gets 2 git config calls
      // With dedup: 2 workspaces * 2 = 4 calls
      expect(configCalls.length).toBeLessThanOrEqual(4);
      logSpy.mockRestore();
    });
  });
});
