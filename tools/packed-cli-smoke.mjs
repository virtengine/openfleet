#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const nodeCmd = process.execPath;
const SMOKE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.BOSUN_PACKED_SMOKE_TIMEOUT_MS || "15000") || 15000,
);
const NPM_TIMEOUT_MS = Math.max(
  SMOKE_TIMEOUT_MS,
  Number(process.env.BOSUN_PACKED_SMOKE_NPM_TIMEOUT_MS || "120000") || 120000,
);
const nodeBinDir = dirname(nodeCmd);

function resolveNpmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    resolve(nodeBinDir, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(nodeBinDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  throw new Error("Unable to locate npm-cli.js for packed smoke test");
}

const npmCliPath = resolveNpmCliPath();

function isWindowsChildLaunchBlocked(error) {
  if (process.platform !== "win32") return false;
  const message = String(error?.message || "");
  return message.includes("EPERM") && /spawn(?:Sync)?\s/i.test(message);
}

function runNpm(args, options = {}) {
  const cwd = options.cwd || ROOT;
  return execFileSync(nodeCmd, [npmCliPath, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: NPM_TIMEOUT_MS,
    ...options,
  });
}

function sanitizeTarballFilename(name, version) {
  const normalizedName = String(name || "")
    .trim()
    .replace(/^@/, "")
    .replaceAll("/", "-")
    .replaceAll("\\", "-");
  return `${normalizedName}-${String(version || "").trim()}.tgz`;
}

function waitForExistingPath(candidates, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return null;
}

function resolvePackedTarballPath(packDir, packEntry = {}) {
  const expectedPaths = [
    packEntry.filename ? resolve(packDir, String(packEntry.filename)) : null,
    packEntry.filename ? resolve(packDir, String(packEntry.filename).split(/[\\/]/).pop() || "") : null,
    packEntry.name && packEntry.version
      ? resolve(packDir, sanitizeTarballFilename(packEntry.name, packEntry.version))
      : null,
  ].filter(Boolean);

  const found = waitForExistingPath(expectedPaths);
  if (found) return found;

  const tarballs = readdirSync(packDir)
    .filter((entry) => entry.endsWith(".tgz"))
    .map((entry) => resolve(packDir, entry));
  const fallback = waitForExistingPath(tarballs, 1000);
  if (fallback) return fallback;

  throw new Error(
    `npm pack reported a tarball but none was found in ${packDir}. Expected one of: ${expectedPaths.join(", ") || "<none>"}`,
  );
}

function packTarball(packDir) {
  mkdirSync(packDir, { recursive: true });
  const raw = runNpm(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir]);
  const parsed = JSON.parse(raw);
  const packEntry = parsed?.[0];
  if (!packEntry) {
    throw new Error("npm pack did not return a tarball filename");
  }
  return resolvePackedTarballPath(packDir, packEntry);
}

function installPackedArtifact(tarballPath, installDir) {
  writeFileSync(
    resolve(installDir, "package.json"),
    JSON.stringify({ name: "bosun-packed-smoke", private: true, type: "module" }, null, 2),
  );
  runNpm(["install", "--ignore-scripts", "--no-package-lock", tarballPath], {
    cwd: installDir,
  });
}

function runNode(args, options = {}) {
  return execFileSync(nodeCmd, args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: SMOKE_TIMEOUT_MS,
    ...options,
  });
}

function assertPackedCliStarts(installDir) {
  const cliPath = resolve(installDir, "node_modules", "bosun", "cli.mjs");

  const versionOutput = runNode([cliPath, "--version"], {
    cwd: installDir,
  });
  if (!/\d+\.\d+\.\d+/.test(versionOutput)) {
    throw new Error(`packed CLI --version returned unexpected output: ${JSON.stringify(versionOutput.trim())}`);
  }

  const helpOutput = runNode([cliPath, "--help"], {
    cwd: installDir,
  });
  if (!helpOutput.includes("bosun v") || !helpOutput.includes("USAGE")) {
    throw new Error("packed CLI --help did not print the expected usage text");
  }

  const configImportOutput = runNode(
    [
      "--input-type=module",
      "--eval",
      "const mod = await import('bosun/config'); console.log(typeof mod.loadConfig);",
    ],
    {
      cwd: installDir,
    },
  );
  if (!configImportOutput.trim().includes("function")) {
    throw new Error("packed package export 'bosun/config' did not import successfully");
  }
}

function safeRemove(targetPath, label) {
  if (!targetPath) return;
  try {
    rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200,
    });
  } catch (error) {
    console.warn(`[smoke] warning: failed to clean ${label}: ${error.message}`);
  }
}

function main() {
  const tempRoot = mkdtempSync(resolve(tmpdir(), "bosun-packed-smoke-"));
  const packDir = resolve(tempRoot, "pack");
  const installDir = resolve(tempRoot, "install");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(installDir, { recursive: true });

  let tarballPath = "";
  try {
    tarballPath = packTarball(packDir);
    installPackedArtifact(tarballPath, installDir);
    assertPackedCliStarts(installDir);

    const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    console.log(
      `[smoke] packed CLI ok: ${manifest.name}@${manifest.version}`,
    );
  } catch (error) {
    if (isWindowsChildLaunchBlocked(error)) {
      console.warn(
        `[smoke] skipped packed CLI smoke: Windows child-process launch blocked in current Node runtime (${error.message})`,
      );
      return;
    }
    throw error;
  } finally {
    safeRemove(tarballPath, "packed tarball");
    safeRemove(tempRoot, "temporary smoke workspace");
  }
}

main();
