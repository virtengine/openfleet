import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  resolveRepoLocalBosunDir,
  isBosunModuleRoot,
  detectBosunModuleRoot,
  resolveRepoRoot,
  resolveAgentRepoRoot,
} from "../config/repo-root.mjs";

// ---------------------------------------------------------------------------
// resolveRepoLocalBosunDir
// ---------------------------------------------------------------------------
describe("resolveRepoLocalBosunDir", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bosun-test-repo-root-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("returns null for null/empty repoRoot", () => {
    expect(resolveRepoLocalBosunDir(null)).toBeNull();
    expect(resolveRepoLocalBosunDir("")).toBeNull();
    expect(resolveRepoLocalBosunDir(undefined)).toBeNull();
  });

  it("returns null when .bosun directory does not exist", () => {
    expect(resolveRepoLocalBosunDir(tmpDir)).toBeNull();
  });

  it("returns null when .bosun exists but no marker files and requireMarkers is default", () => {
    mkdirSync(join(tmpDir, ".bosun"), { recursive: true });
    expect(resolveRepoLocalBosunDir(tmpDir)).toBeNull();
  });

  it("returns the .bosun path when markers are present", () => {
    const bosunDir = join(tmpDir, ".bosun");
    mkdirSync(bosunDir, { recursive: true });
    writeFileSync(join(bosunDir, ".env"), "KEY=value");
    const result = resolveRepoLocalBosunDir(tmpDir);
    expect(result).toBe(resolve(bosunDir));
  });

  it("returns .bosun path when requireMarkers is false even without markers", () => {
    const bosunDir = join(tmpDir, ".bosun");
    mkdirSync(bosunDir, { recursive: true });
    const result = resolveRepoLocalBosunDir(tmpDir, { requireMarkers: false });
    expect(result).toBe(resolve(bosunDir));
  });

  it("uses custom markers option", () => {
    const bosunDir = join(tmpDir, ".bosun");
    mkdirSync(bosunDir, { recursive: true });
    // Default markers absent → null
    expect(resolveRepoLocalBosunDir(tmpDir, { markers: ["my-marker.txt"] })).toBeNull();

    // Custom marker present → returns dir
    writeFileSync(join(bosunDir, "my-marker.txt"), "");
    expect(resolveRepoLocalBosunDir(tmpDir, { markers: ["my-marker.txt"] })).toBe(resolve(bosunDir));
  });
});

// ---------------------------------------------------------------------------
// isBosunModuleRoot
// ---------------------------------------------------------------------------
describe("isBosunModuleRoot", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "bosun-test-module-root-"));
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it("returns false for null/empty path", () => {
    expect(isBosunModuleRoot(null)).toBe(false);
    expect(isBosunModuleRoot("")).toBe(false);
    expect(isBosunModuleRoot(undefined)).toBe(false);
  });

  it("returns false for directory without package.json", () => {
    expect(isBosunModuleRoot(tmpDir)).toBe(false);
  });

  it("returns false for directory with package.json but different name", () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "other-package" }));
    expect(isBosunModuleRoot(tmpDir)).toBe(false);
  });

  it('returns true for directory with package.json name "bosun"', () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "bosun" }));
    expect(isBosunModuleRoot(tmpDir)).toBe(true);
  });

  it('returns true for directory with package.json name "@virtengine/bosun"', () => {
    writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "@virtengine/bosun" }));
    expect(isBosunModuleRoot(tmpDir)).toBe(true);
  });

  it("returns false for invalid JSON in package.json", () => {
    writeFileSync(join(tmpDir, "package.json"), "{ not-valid-json }}}");
    expect(isBosunModuleRoot(tmpDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectBosunModuleRoot
// ---------------------------------------------------------------------------
describe("detectBosunModuleRoot", () => {
  it("returns a string path", () => {
    const result = detectBosunModuleRoot();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns an existing directory", () => {
    const result = detectBosunModuleRoot();
    expect(existsSync(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveRepoRoot
// ---------------------------------------------------------------------------
describe("resolveRepoRoot", () => {
  const ENV_KEYS = ["REPO_ROOT"];

  let savedEnv;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("returns REPO_ROOT env var when set", () => {
    let tmpDir;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), "bosun-test-reporoot-"));
      process.env.REPO_ROOT = tmpDir;
      const result = resolveRepoRoot();
      expect(result).toBe(resolve(tmpDir));
    } finally {
      if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("returns a string path in all cases", () => {
    delete process.env.REPO_ROOT;
    const result = resolveRepoRoot();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("falls back to cwd when nothing else works", () => {
    let tmpDir;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), "bosun-test-fallback-"));
      delete process.env.REPO_ROOT;
      // Provide a cwd that is not inside a git repo and has no config
      const result = resolveRepoRoot({ cwd: tmpDir });
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    } finally {
      if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ---------------------------------------------------------------------------
// resolveAgentRepoRoot
// ---------------------------------------------------------------------------
describe("resolveAgentRepoRoot", () => {
  const ENV_KEYS = ["BOSUN_AGENT_REPO_ROOT", "REPO_ROOT"];

  let savedEnv;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("returns BOSUN_AGENT_REPO_ROOT env var when set and path exists", () => {
    let tmpDir;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), "bosun-test-agentroot-"));
      process.env.BOSUN_AGENT_REPO_ROOT = tmpDir;
      const result = resolveAgentRepoRoot();
      expect(result).toBe(resolve(tmpDir));
    } finally {
      if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("falls back to resolveRepoRoot when no agent root configured", () => {
    let tmpDir;
    try {
      tmpDir = mkdtempSync(join(tmpdir(), "bosun-test-agentfallback-"));
      delete process.env.BOSUN_AGENT_REPO_ROOT;
      process.env.REPO_ROOT = tmpDir;
      const result = resolveAgentRepoRoot();
      expect(result).toBe(resolve(tmpDir));
    } finally {
      if (tmpDir) try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});
