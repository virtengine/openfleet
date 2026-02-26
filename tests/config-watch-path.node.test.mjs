import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { loadConfig } from "../scripts/bosun/config/config.mjs";

const ENV_KEYS = ["WATCH_PATH", "BOSUN_CONFIG_PATH"];

describe("config watchPath resolution", () => {
  let tempRoot = "";
  let tempConfigDir = "";
  let tempRepoRoot = "";
  let originalEnv = {};

  beforeEach(async () => {
    tempRoot = await mkdtemp(resolve(tmpdir(), "bosun-watch-path-"));
    tempConfigDir = resolve(tempRoot, "config");
    tempRepoRoot = resolve(tempRoot, "repo");
    await mkdir(tempConfigDir, { recursive: true });
    await mkdir(tempRepoRoot, { recursive: true });

    originalEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] == null) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses explicit WATCH_PATH when it exists", async () => {
    const explicitWatchPath = resolve(tempRoot, "explicit-watch.txt");
    await writeFile(explicitWatchPath, "watch", "utf8");
    process.env.WATCH_PATH = explicitWatchPath;

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempRepoRoot,
    ]);

    assert.equal(config.watchPath, resolve(explicitWatchPath));
  });

  it("falls back to an existing path and warns when WATCH_PATH is missing", () => {
    const missingWatchPath = resolve(tempRoot, "missing-watch-target.txt");
    process.env.WATCH_PATH = missingWatchPath;

    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    try {
      const config = loadConfig([
        "node",
        "bosun",
        "--config-dir",
        tempConfigDir,
        "--repo-root",
        tempRepoRoot,
      ]);

      assert.notEqual(config.watchPath, resolve(missingWatchPath));
      assert.equal(existsSync(config.watchPath), true);
      assert.ok(
        warnings.some(
          (line) =>
            line.includes("[config] WATCH_PATH not found:") &&
            line.includes(resolve(missingWatchPath)) &&
            line.includes("; falling back to "),
        ),
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it("defaults watchPath to a real orchestrator file when repo/config paths have no script", () => {
    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempRepoRoot,
    ]);

    assert.equal(existsSync(config.watchPath), true);
    assert.match(basename(config.watchPath), /^ve-orchestrator\.(ps1|sh)$/);
  });

  it("uses watchPath from bosun.config.json when present and valid", async () => {
    const configWatchPath = resolve(tempRoot, "config-watch-target.txt");
    await writeFile(configWatchPath, "watch", "utf8");
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify({ watchPath: configWatchPath }, null, 2),
      "utf8",
    );

    const config = loadConfig([
      "node",
      "bosun",
      "--config-dir",
      tempConfigDir,
      "--repo-root",
      tempRepoRoot,
    ]);

    assert.equal(config.watchPath, resolve(configWatchPath));
  });
});
