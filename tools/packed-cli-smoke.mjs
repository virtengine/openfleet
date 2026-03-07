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

function runNpm(args, options = {}) {
  return execFileSync("npm", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
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
    },
  );
}

function assertPackedCliStarts(installDir) {
  execFileSync(nodeCmd, [resolve(installDir, "node_modules", "bosun", "cli.mjs"), "--version"], {
    cwd: installDir,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  execFileSync(
    nodeCmd,
    ["--input-type=module", "--eval", "await import('bosun'); console.log('bosun import ok');"],
    {
      cwd: installDir,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
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