import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawnSync: spawnSyncMock,
}));

const { evaluateBranchSafetyForPush, normalizeBaseBranch } = await import(
  "../git-safety.mjs"
);

describe("git-safety", () => {
  let repoDir = "";
  let gitState = null;

  function setGitState({ baseFiles = 0, headFiles = 0, diff = null } = {}) {
    gitState = {
      fileCounts: new Map([
        ["origin/main", baseFiles],
        ["HEAD", headFiles],
      ]),
      diffStats: new Map([
        [
          "origin/main...HEAD",
          diff || { files: 0, inserted: 0, deleted: 0 },
        ],
      ]),
    };
  }

  beforeEach(() => {
    repoDir = "/tmp/git-safety";
    setGitState({
      baseFiles: 600,
      headFiles: 600,
      diff: { files: 0, inserted: 0, deleted: 0 },
    });
    spawnSyncMock.mockImplementation((_cmd, args) => {
      const [command, ...rest] = args;
      if (command === "ls-tree" && rest[0] === "-r") {
        const ref = rest[2];
        const count = gitState.fileCounts.get(ref);
        if (count == null) {
          return { status: 1, stdout: "" };
        }
        const files = Array.from({ length: count }, (_, i) => `file-${i}.txt`);
        return { status: 0, stdout: files.join("\n") };
      }
      if (command === "diff" && rest[0] === "--numstat") {
        const range = rest[1];
        const stats = gitState.diffStats.get(range);
        if (!stats) return { status: 1, stdout: "" };
        if (stats.files <= 0) return { status: 0, stdout: "" };
        const lines = [
          `${stats.inserted}\t${stats.deleted}\tfile-0.txt`,
          ...Array.from({ length: stats.files - 1 }, (_, i) => `0\t0\tfile-${i + 1}.txt`),
        ];
        return { status: 0, stdout: lines.join("\n") };
      }
      return { status: 1, stdout: "" };
    });
  });

  it("normalizes base branch names", () => {
    expect(normalizeBaseBranch("main")).toEqual({
      branch: "main",
      remoteRef: "origin/main",
    });
    expect(normalizeBaseBranch("origin/main")).toEqual({
      branch: "main",
      remoteRef: "origin/main",
    });
    expect(normalizeBaseBranch("refs/remotes/origin/main")).toEqual({
      branch: "main",
      remoteRef: "origin/main",
    });
    expect(normalizeBaseBranch("origin/origin/main")).toEqual({
      branch: "main",
      remoteRef: "origin/main",
    });
  });

  it("flags README-only destructive branch states", async () => {
    setGitState({
      baseFiles: 600,
      headFiles: 1,
      diff: { files: 600, inserted: 0, deleted: 600 },
    });

    const safety = evaluateBranchSafetyForPush(repoDir, { baseBranch: "main" });
    expect(safety.safe).toBe(false);
    expect(safety.reason).toContain("HEAD tracks only");
  });

  it("supports explicit bypass for emergency pushes", async () => {
    const prev = process.env.VE_ALLOW_DESTRUCTIVE_PUSH;
    process.env.VE_ALLOW_DESTRUCTIVE_PUSH = "1";
    try {
      const safety = evaluateBranchSafetyForPush(repoDir, {
        baseBranch: "main",
      });
      expect(safety.safe).toBe(true);
      expect(safety.bypassed).toBe(true);
    } finally {
      if (prev == null) delete process.env.VE_ALLOW_DESTRUCTIVE_PUSH;
      else process.env.VE_ALLOW_DESTRUCTIVE_PUSH = prev;
    }
  });
});
