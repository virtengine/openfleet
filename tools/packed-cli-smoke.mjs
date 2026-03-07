#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
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

function runNpm(args, options = {}) {
  return execFileSync("npm", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    timeout: SMOKE_TIMEOUT_MS,
    ...options,
  });
}

function packTarball() {
  const raw = runNpm(["pack", "--json", "--ignore-scripts"]);
  const parsed = JSON.parse(raw);
  const filename = parsed?.[0]?.filename;
  if (!filename) {
    throw new Error("npm pack did not return a tarball filename");
  }
  return resolve(ROOT, filename);
}

function installPackedArtifact(tarballPath, installDir) {
  writeFileSync(
    resolve(installDir, "package.json"),
    JSON.stringify({ name: "bosun-packed-smoke", private: true, type: "module" }, null, 2),
  );
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-package-lock", tarballPath],
    {
      cwd: installDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      timeout: SMOKE_TIMEOUT_MS,
    },
  );
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

function main() {
  const tempRoot = mkdtempSync(resolve(tmpdir(), "bosun-packed-smoke-"));
  const installDir = resolve(tempRoot, "install");
  mkdirSync(installDir, { recursive: true });

  let tarballPath = "";
  try {
    tarballPath = packTarball();
    installPackedArtifact(tarballPath, installDir);
    assertPackedCliStarts(installDir);

    const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    console.log(
      `[smoke] packed CLI ok: ${manifest.name}@${manifest.version}`,
    );
  } finally {
    if (tarballPath) {
      rmSync(tarballPath, { force: true });
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();