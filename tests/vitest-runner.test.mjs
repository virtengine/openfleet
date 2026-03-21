import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { findVitestEntry } from "../tools/vitest-runner.mjs";

const tempDirs = [];

function createFixture() {
  const root = mkdtempSync(resolve(tmpdir(), "bosun-vitest-runner-"));
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("vitest-runner", () => {
  it("finds vitest from an ancestor node_modules directory", () => {
    const root = createFixture();
    const vitestEntry = resolve(root, "node_modules", "vitest", "vitest.mjs");
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-123");

    mkdirSync(resolve(vitestEntry, ".."), { recursive: true });
    mkdirSync(nestedWorktree, { recursive: true });
    writeFileSync(vitestEntry, "export default {};\n");

    expect(findVitestEntry({ startDir: nestedWorktree })).toBe(vitestEntry);
  });

  it("returns null when vitest is unavailable in any ancestor", () => {
    const root = createFixture();
    const nestedWorktree = resolve(root, ".bosun", "worktrees", "task-456");
    mkdirSync(nestedWorktree, { recursive: true });

    expect(findVitestEntry({ startDir: nestedWorktree })).toBeNull();
  });

  it("routes package test scripts through the worktree-safe runner", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

    expect(packageJson.scripts.test).toContain("tools/vitest-runner.mjs");
    expect(packageJson.scripts["test:vitest"]).toContain("tools/vitest-runner.mjs");
    expect(packageJson.scripts.test).not.toContain("node_modules/vitest/vitest.mjs");
    expect(packageJson.scripts["test:vitest"]).not.toContain("node_modules/vitest/vitest.mjs");
  });

  it("routes the pre-push hook through the worktree-safe runner", () => {
    const prePushHook = readFileSync(resolve(process.cwd(), ".githooks", "pre-push"), "utf8");

    expect(prePushHook).toContain("node tools/vitest-runner.mjs run --config vitest.config.mjs");
    expect(prePushHook).not.toContain("node node_modules/vitest/vitest.mjs");
  });
});
