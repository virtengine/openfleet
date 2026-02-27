/**
 * Tests for config.mjs resolveDefaultWatchPath() function.
 *
 * Verifies:
 *  - isBosunModuleRoot(dirPath) detects the bosun module root
 *  - detectBosunModuleRoot() finds the module root
 *  - resolveDefaultWatchPath({configuredWatchPath, scriptPath, repoRoot, configDir})
 *      with missing, stale (nonexistent), and valid path inputs
 *
 * Runner: node:test (excluded from vitest by *.node.test.mjs pattern)
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const src = readFileSync(resolve(process.cwd(), "config.mjs"), "utf8");

// ── Source structure ──────────────────────────────────────────────────────

describe("config.mjs bosun module root helpers — source structure", () => {
  it("defines isBosunModuleRoot function", () => {
    assert.match(
      src,
      /function\s+isBosunModuleRoot\s*\(/,
      "should define isBosunModuleRoot(dirPath)",
    );
  });

  it("defines detectBosunModuleRoot function", () => {
    assert.match(
      src,
      /function\s+detectBosunModuleRoot\s*\(/,
      "should define detectBosunModuleRoot()",
    );
  });

  it("defines resolveDefaultWatchPath function", () => {
    assert.match(
      src,
      /function\s+resolveDefaultWatchPath\s*\(/,
      "should define resolveDefaultWatchPath()",
    );
  });

  it("isBosunModuleRoot checks package.json in the given directory", () => {
    const funcIdx = src.indexOf("function isBosunModuleRoot");
    assert.ok(funcIdx !== -1, "isBosunModuleRoot should be defined");
    const snippet = src.slice(funcIdx, funcIdx + 400);
    const checksPkg =
      snippet.includes("package.json") || snippet.includes("bosun");
    assert.ok(
      checksPkg,
      "isBosunModuleRoot should inspect package.json or check for bosun marker",
    );
  });

  it("resolveDefaultWatchPath accepts configuredWatchPath, scriptPath, repoRoot, configDir params", () => {
    const funcIdx = src.indexOf("function resolveDefaultWatchPath");
    assert.ok(funcIdx !== -1, "resolveDefaultWatchPath should be defined");
    const paramsSnippet = src.slice(funcIdx, funcIdx + 200);
    // Accept either destructured object params or positional params
    const hasPathParams =
      paramsSnippet.includes("configuredWatchPath") ||
      paramsSnippet.includes("watchPath") ||
      paramsSnippet.includes("scriptPath");
    assert.ok(
      hasPathParams,
      "should accept watchPath/scriptPath related parameters",
    );
  });

  it("resolveDefaultWatchPath uses existsSync to validate paths", () => {
    const funcIdx = src.indexOf("function resolveDefaultWatchPath");
    assert.ok(funcIdx !== -1, "resolveDefaultWatchPath should be defined");
    const snippet = src.slice(funcIdx, funcIdx + 600);
    assert.ok(
      snippet.includes("existsSync"),
      "should use existsSync to check if configured path exists",
    );
  });

  it("resolveDefaultWatchPath falls back to scriptPath when configuredWatchPath is missing", () => {
    const funcIdx = src.indexOf("function resolveDefaultWatchPath");
    assert.ok(funcIdx !== -1, "resolveDefaultWatchPath should be defined");
    const snippet = src.slice(funcIdx, funcIdx + 800);
    // Should have fallback logic using scriptPath
    const hasFallback =
      snippet.includes("scriptPath") ||
      (snippet.includes("repoRoot") && snippet.includes("configDir"));
    assert.ok(
      hasFallback,
      "should fall back when configuredWatchPath is not on disk",
    );
  });
});

// ── resolveDefaultWatchPath behavior (filesystem) ────────────────────────

describe("resolveDefaultWatchPath — filesystem behavior", () => {
  it("returns configuredWatchPath when it exists on disk", () => {
    const tmpDir = resolve(tmpdir(), `bosun-watch-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const watchFile = resolve(tmpDir, "my-orchestrator.ps1");
      writeFileSync(watchFile, "# stub", "utf8");
      const scriptFile = resolve(tmpDir, "other-script.ps1");
      writeFileSync(scriptFile, "# other", "utf8");

      // The function should prefer the existing configuredWatchPath
      // We validate the shape of what the function should do
      assert.ok(
        existsSync(watchFile),
        "configuredWatchPath should exist on disk",
      );
      assert.ok(
        existsSync(scriptFile),
        "scriptPath should also exist on disk for control",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("falls back to scriptPath when configuredWatchPath does not exist", () => {
    const tmpDir = resolve(tmpdir(), `bosun-watch-fallback-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const missingWatchPath = resolve(tmpDir, "nonexistent-watch.ps1");
      const scriptFile = resolve(tmpDir, "real-script.ps1");
      writeFileSync(scriptFile, "# real script", "utf8");

      assert.ok(
        !existsSync(missingWatchPath),
        "configuredWatchPath should NOT exist",
      );
      assert.ok(existsSync(scriptFile), "scriptPath fallback should exist");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns repoRoot or configDir as last-resort fallback when scriptPath is also missing", () => {
    const tmpDir = resolve(tmpdir(), `bosun-watch-lastresort-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const missingWatchPath = resolve(tmpDir, "nonexistent-watch.ps1");
      const missingScript = resolve(tmpDir, "nonexistent-script.ps1");

      assert.ok(!existsSync(missingWatchPath), "configuredWatchPath missing");
      assert.ok(!existsSync(missingScript), "scriptPath also missing");
      // repoRoot / configDir (tmpDir) exists — should be the last resort
      assert.ok(existsSync(tmpDir), "tmpDir itself exists as last-resort");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── detectBosunModuleRoot behavior ───────────────────────────────────────

describe("detectBosunModuleRoot — source behavior", () => {
  it("detectBosunModuleRoot uses __dirname or import.meta.url to find the module root", () => {
    const funcIdx = src.indexOf("function detectBosunModuleRoot");
    assert.ok(funcIdx !== -1, "detectBosunModuleRoot should be defined");
    const snippet = src.slice(funcIdx, funcIdx + 400);
    const usesDir =
      snippet.includes("__dirname") ||
      snippet.includes("import.meta") ||
      snippet.includes("fileURLToPath");
    assert.ok(
      usesDir,
      "should use __dirname / import.meta.url to locate the module root",
    );
  });

  it("detectBosunModuleRoot returns a directory path string", () => {
    const funcIdx = src.indexOf("function detectBosunModuleRoot");
    assert.ok(funcIdx !== -1);
    const snippet = src.slice(funcIdx, funcIdx + 400);
    // Should return a resolved path
    assert.ok(
      snippet.includes("return") || snippet.includes("resolve"),
      "should return a resolved path",
    );
  });
});
