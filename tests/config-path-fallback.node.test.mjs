import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { loadConfig } from "../scripts/bosun/config/config.mjs""240;

const ENV_KEYS = ["WATCH_PATH", "ORCHESTRATOR_SCRIPT", "BOSUN_CONFIG_PATH"];

function captureEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function loadForTempRepo(tempConfigDir) {
  return loadConfig([
    "node",
    "bosun",
    "--config-dir",
    tempConfigDir,
    "--repo-root",
    tempConfigDir,
  ]);
}

test("watchPath falls back to an existing path when WATCH_PATH is unset", async (t) => {
  const tempConfigDir = await mkdtemp(resolve(tmpdir(), "bosun-config-path-"));
  const envSnapshot = captureEnv(ENV_KEYS);
  t.after(async () => {
    restoreEnv(envSnapshot);
    await rm(tempConfigDir, { recursive: true, force: true });
  });

  delete process.env.WATCH_PATH;
  delete process.env.BOSUN_CONFIG_PATH;

  const config = loadForTempRepo(tempConfigDir);
  assert.equal(typeof config.watchPath, "string");
  assert.equal(existsSync(config.watchPath), true);
});

test("watchPath falls back when WATCH_PATH points to a missing file", async (t) => {
  const tempConfigDir = await mkdtemp(resolve(tmpdir(), "bosun-config-path-"));
  const envSnapshot = captureEnv(ENV_KEYS);
  t.after(async () => {
    restoreEnv(envSnapshot);
    await rm(tempConfigDir, { recursive: true, force: true });
  });

  const missingWatchPath = resolve(tempConfigDir, "missing-watch-target.ps1");
  process.env.WATCH_PATH = missingWatchPath;
  delete process.env.BOSUN_CONFIG_PATH;

  const config = loadForTempRepo(tempConfigDir);
  assert.notEqual(config.watchPath, missingWatchPath);
  assert.equal(existsSync(config.watchPath), true);
});

test("watchPath preserves an existing WATCH_PATH value", async (t) => {
  const tempConfigDir = await mkdtemp(resolve(tmpdir(), "bosun-config-path-"));
  const envSnapshot = captureEnv(ENV_KEYS);
  t.after(async () => {
    restoreEnv(envSnapshot);
    await rm(tempConfigDir, { recursive: true, force: true });
  });

  const existingWatchPath = resolve(tempConfigDir, "watch-target.txt");
  await writeFile(existingWatchPath, "ok", "utf8");
  process.env.WATCH_PATH = existingWatchPath;
  delete process.env.BOSUN_CONFIG_PATH;

  const config = loadForTempRepo(tempConfigDir);
  assert.equal(config.watchPath, existingWatchPath);
});

test("scriptPath resolves to an existing orchestrator when ORCHESTRATOR_SCRIPT is unset", async (t) => {
  const tempConfigDir = await mkdtemp(resolve(tmpdir(), "bosun-config-path-"));
  const envSnapshot = captureEnv(ENV_KEYS);
  t.after(async () => {
    restoreEnv(envSnapshot);
    await rm(tempConfigDir, { recursive: true, force: true });
  });

  delete process.env.ORCHESTRATOR_SCRIPT;
  delete process.env.BOSUN_CONFIG_PATH;

  const config = loadForTempRepo(tempConfigDir);
  assert.equal(existsSync(config.scriptPath), true);
  assert.match(config.scriptPath, /ve-orchestrator\.(ps1|sh)$/i);
});
