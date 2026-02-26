import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  evaluateThrottledWarning,
  resetBranchSyncWarningStateForTests,
  syncLocalTrackingBranches,
} from "../scripts/bosun/core/maintenance.mjs";

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`,
  );
  return result;
}

async function createRepoPair() {
  const root = await mkdtemp(resolve(tmpdir(), "bosun-maintenance-warning-"));
  const seed = resolve(root, "seed");
  const origin = resolve(root, "origin.git");
  const local = resolve(root, "local");
  const peer = resolve(root, "peer");

  runGit(["init", "-b", "main", seed], root);
  runGit(["config", "user.name", "Bosun Test"], seed);
  runGit(["config", "user.email", "bosun-test@example.com"], seed);
  await writeFile(resolve(seed, "README.md"), "seed\n", "utf8");
  runGit(["add", "README.md"], seed);
  runGit(["commit", "-m", "seed"], seed);

  runGit(["clone", "--bare", seed, origin], root);
  runGit(["clone", origin, local], root);
  runGit(["clone", origin, peer], root);

  runGit(["config", "user.name", "Bosun Local"], local);
  runGit(["config", "user.email", "bosun-local@example.com"], local);
  runGit(["config", "user.name", "Bosun Peer"], peer);
  runGit(["config", "user.email", "bosun-peer@example.com"], peer);

  return { root, local, peer };
}

async function commitInRepo(repoPath, fileName, content, message, shouldPush = false) {
  await writeFile(resolve(repoPath, fileName), content, "utf8");
  runGit(["add", fileName], repoPath);
  runGit(["commit", "-m", message], repoPath);
  if (shouldPush) {
    runGit(["push", "origin", "main"], repoPath);
  }
}

describe("evaluateThrottledWarning", () => {
  it("logs first occurrence, suppresses repeats, then emits with suppressed count", () => {
    const state = new Map();

    assert.deepEqual(evaluateThrottledWarning(state, "dirty:main", 1_000, 60_000), {
      shouldLog: true,
      suppressed: 0,
    });

    assert.deepEqual(evaluateThrottledWarning(state, "dirty:main", 2_000, 60_000), {
      shouldLog: false,
      suppressed: 1,
    });

    assert.deepEqual(evaluateThrottledWarning(state, "dirty:main", 3_000, 60_000), {
      shouldLog: false,
      suppressed: 2,
    });

    assert.deepEqual(evaluateThrottledWarning(state, "dirty:main", 61_100, 60_000), {
      shouldLog: true,
      suppressed: 2,
    });
  });

  it("enforces a minimum throttle window and tracks keys independently", () => {
    const state = new Map();

    assert.equal(
      evaluateThrottledWarning(state, "diverged:main", 1_000, 10).shouldLog,
      true,
    );
    assert.equal(
      evaluateThrottledWarning(state, "diverged:main", 1_500, 10).shouldLog,
      false,
    );
    assert.equal(
      evaluateThrottledWarning(state, "diverged:main", 2_050, 10).shouldLog,
      true,
    );

    assert.equal(
      evaluateThrottledWarning(state, "dirty:main", 2_050, 60_000).shouldLog,
      true,
    );
  });
});

describe("syncLocalTrackingBranches warning throttling", () => {
  let repo = null;

  beforeEach(async () => {
    repo = await createRepoPair();
    resetBranchSyncWarningStateForTests();
  });

  afterEach(async () => {
    resetBranchSyncWarningStateForTests();
    if (repo?.root) {
      await rm(repo.root, { recursive: true, force: true });
    }
  });

  it("throttles repeated diverged warnings and reports suppressed count", async () => {
    await commitInRepo(repo.peer, "peer-a.txt", "peer-a\n", "peer-a", true);
    await commitInRepo(repo.local, "local-a.txt", "local-a\n", "local-a", false);

    const warnings = [];
    const originalWarn = console.warn;
    const originalNow = Date.now;
    console.warn = (...args) => warnings.push(args.map(String).join(" "));

    try {
      Date.now = () => 1_000;
      assert.equal(syncLocalTrackingBranches(repo.local, ["main"]), 0);

      Date.now = () => 2_000;
      assert.equal(syncLocalTrackingBranches(repo.local, ["main"]), 0);

      Date.now = () => 1_802_000;
      assert.equal(syncLocalTrackingBranches(repo.local, ["main"]), 0);
    } finally {
      Date.now = originalNow;
      console.warn = originalWarn;
    }

    const divergedWarnings = warnings.filter((line) =>
      line.includes("skipping (diverged)"),
    );
    assert.equal(divergedWarnings.length, 2);
    assert.match(divergedWarnings[1], /suppressed 1 similar warning\(s\)/);
  });

  it("resets dirty-warning throttle after a successful fast-forward pull", async () => {
    await commitInRepo(repo.peer, "peer-dirty-1.txt", "peer-dirty-1\n", "peer-dirty-1", true);
    const dirtyFile = resolve(repo.local, "DIRTY.txt");
    await writeFile(dirtyFile, "dirty\n", "utf8");

    const warnings = [];
    const originalWarn = console.warn;
    const originalNow = Date.now;
    console.warn = (...args) => warnings.push(args.map(String).join(" "));

    try {
      Date.now = () => 1_000;
      assert.equal(syncLocalTrackingBranches(repo.local, ["main"]), 0);

      Date.now = () => 2_000;
      assert.equal(syncLocalTrackingBranches(repo.local, ["main"]), 0);

      await unlink(dirtyFile);
      Date.now = () => 3_000;
      assert.equal(syncLocalTrackingBranches(repo.local, ["main"]), 1);

      await commitInRepo(repo.peer, "peer-dirty-2.txt", "peer-dirty-2\n", "peer-dirty-2", true);
      await writeFile(dirtyFile, "dirty-again\n", "utf8");
      Date.now = () => 4_000;
      assert.equal(syncLocalTrackingBranches(repo.local, ["main"]), 0);
    } finally {
      Date.now = originalNow;
      console.warn = originalWarn;
    }

    const dirtyWarnings = warnings.filter((line) =>
      line.includes("checked out with uncommitted changes"),
    );
    assert.equal(dirtyWarnings.length, 2);
  });
});
