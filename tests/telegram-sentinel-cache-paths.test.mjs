import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("telegram-sentinel cache path discovery", () => {
  const source = readFileSync(
    resolve(process.cwd(), "telegram/telegram-sentinel.mjs"),
    "utf8",
  );

  it("derives cache candidates from repo and BOSUN workspace paths", () => {
    expect(source).toContain("function getWorkspaceCacheCandidates()");
    expect(source).toContain("resolveBosunConfigDir()");
    expect(source).toContain('resolve(bosunDir, "workspaces", workspaceName, repoName, ".cache")');
  });

  it("checks monitor and daemon pid files across cache candidates", () => {
    expect(source).toContain('...CACHE_CANDIDATES.map((dir) => resolve(dir, "bosun.pid"))');
    expect(source).toContain('...CACHE_CANDIDATES.map((dir) => resolve(dir, "bosun-daemon.pid"))');
  });

  it("uses multi-path sentinel pid discovery", () => {
    expect(source).toContain("function readSentinelPid()");
    expect(source).toContain('...CACHE_CANDIDATES.map((dir) => resolve(dir, "telegram-sentinel.pid"))');
    expect(source).toContain("function removeSentinelPidFiles()");
  });
});
