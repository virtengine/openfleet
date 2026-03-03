import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  runContextIndex,
  searchContextIndex,
  getContextIndexStatus,
} from "../context-indexer.mjs";

let testRoot;

function makeTempRoot() {
  const dir = resolve(
    tmpdir(),
    `context-index-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("context-indexer", () => {
  beforeEach(() => {
    testRoot = makeTempRoot();
  });

  afterEach(async () => {
    if (testRoot && existsSync(testRoot)) {
      await rm(testRoot, { recursive: true, force: true });
    }
  });

  it("indexes files and supports search/status", async () => {
    mkdirSync(resolve(testRoot, "src"), { recursive: true });
    mkdirSync(resolve(testRoot, "docs"), { recursive: true });

    writeFileSync(
      resolve(testRoot, "src", "alpha.mjs"),
      "// alpha module\nexport function greetUser(name) { return `hello ${name}`; }\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, "src", "beta.py"),
      "# beta module\ndef calc_total(value):\n    return value + 1\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, "docs", "notes.md"),
      "# Notes\nSome documentation for agents.\n",
      "utf8",
    );

    const result = await runContextIndex({
      rootDir: testRoot,
      includeTests: true,
      useTreeSitter: false,
      useZoekt: false,
    });

    expect(result.indexedFiles).toBeGreaterThan(0);
    expect(result.changedFiles).toBeGreaterThan(0);
    expect(result.symbolCount).toBeGreaterThan(0);

    const dbPath = resolve(testRoot, ".bosun", "context-index", "index.db");
    const agentIndexPath = resolve(testRoot, ".bosun", "context-index", "AGENT_INDEX.md");

    expect(existsSync(dbPath)).toBe(true);
    expect(existsSync(agentIndexPath)).toBe(true);

    const hits = await searchContextIndex("greetUser", {
      rootDir: testRoot,
      limit: 10,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((hit) => hit.type === "symbol" && hit.name === "greetUser")).toBe(true);

    const status = await getContextIndexStatus({ rootDir: testRoot });
    expect(status.ready).toBe(true);
    expect(status.fileCount).toBeGreaterThan(0);
    expect(status.symbolCount).toBeGreaterThan(0);
  });

  it("supports task-type scoped search with optional fallback", async () => {
    mkdirSync(resolve(testRoot, "src", "ui"), { recursive: true });
    mkdirSync(resolve(testRoot, ".github", "workflows"), { recursive: true });

    writeFileSync(
      resolve(testRoot, "src", "ui", "button.tsx"),
      "export function renderButton(label: string) { return `<button>${label}</button>`; }\n",
      "utf8",
    );

    writeFileSync(
      resolve(testRoot, ".github", "workflows", "ci.yml"),
      "name: CI\non:\n  workflow_dispatch:\njobs:\n  build:\n    runs-on: ubuntu-latest\n",
      "utf8",
    );

    await runContextIndex({
      rootDir: testRoot,
      includeTests: true,
      useTreeSitter: false,
      useZoekt: false,
    });

    const strictFrontend = await searchContextIndex("ci.yml", {
      rootDir: testRoot,
      taskType: "frontend",
      fallbackToGlobal: false,
      limit: 10,
    });

    expect(Array.isArray(strictFrontend)).toBe(true);
    expect(strictFrontend.length).toBe(0);

    const frontendWithFallback = await searchContextIndex("ci.yml", {
      rootDir: testRoot,
      taskType: "frontend",
      fallbackToGlobal: true,
      includeMeta: true,
      limit: 10,
    });

    expect(frontendWithFallback.taskTypeUsed).toBe("frontend");
    expect(frontendWithFallback.fallbackUsed).toBe(true);
    expect(frontendWithFallback.results.some((hit) => String(hit.path || "").includes(".github/workflows/ci.yml"))).toBe(true);

    const scopedFrontend = await searchContextIndex("renderButton", {
      rootDir: testRoot,
      taskType: "frontend",
      includeMeta: true,
      limit: 10,
    });

    expect(scopedFrontend.fallbackUsed).toBe(false);
    expect(scopedFrontend.results.some((hit) => String(hit.path || "").includes("src/ui/button.tsx"))).toBe(true);
  });
});
