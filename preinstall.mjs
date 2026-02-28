#!/usr/bin/env node

/**
 * bosun — Pre-Install Migration Helper
 *
 * Detects and removes the old `codex-monitor` global npm package before
 * installing bosun. This prevents EEXIST errors when bosun's backward-
 * compatible `codex-monitor` bin aliases collide with the old package's bins.
 *
 * Safe to run multiple times — no-ops when codex-monitor is not installed
 * or when bosun is already the owner of the `codex-monitor` binary.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const isWin = process.platform === "win32";

/**
 * Resolve the real package that owns a given global bin name.
 * Returns the package name string, or null if not installed / not resolvable.
 */
function getOwnerPackage(binName) {
  try {
    // Get the path of the binary
    const whichCmd = isWin ? "where" : "which";
    const binPath = execSync(`${whichCmd} ${binName}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n")[0];

    if (!binPath) return null;

    // On Unix, global npm bins are symlinks into the lib/node_modules tree.
    // Resolve the symlink to find the owning package.
    const realPath = execSync(`readlink -f "${binPath}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    // Walk up from the resolved path to find the nearest package.json
    let dir = dirname(realPath);
    for (let i = 0; i < 10; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        return pkg.name || null;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function main() {
  // Skip in CI or if explicitly opted out
  if (process.env.CI || process.env.BOSUN_SKIP_PREINSTALL) {
    return;
  }

  // Only relevant for global installs
  if (!process.env.npm_config_global && !process.argv.includes("-g")) {
    return;
  }

  const owner = getOwnerPackage("codex-monitor");

  // If codex-monitor isn't installed, or bosun already owns it → nothing to do
  if (!owner) return;
  if (owner === "bosun") return;

  // The old codex-monitor package (or another package) owns the binary.
  // We need to uninstall it so bosun can claim those bin names.
  console.log("");
  console.log("  ┌──────────────────────────────────────────────────────────┐");
  console.log("  │  :refresh: Migrating from codex-monitor → bosun                │");
  console.log("  └──────────────────────────────────────────────────────────┘");
  console.log("");
  console.log(`  Found old "${owner}" package owning the codex-monitor binary.`);
  console.log("  Removing it so bosun can install its backward-compatible aliases...");
  console.log("");

  try {
    execSync(`npm uninstall -g ${owner}`, {
      stdio: "inherit",
      timeout: 30_000,
    });
    console.log(`  :check: Removed old "${owner}" package.`);
    console.log("  :help:  All codex-monitor commands will continue to work via bosun.");
    console.log("");
  } catch (err) {
    console.log(`  :alert:  Could not auto-remove "${owner}": ${err.message}`);
    console.log("  :help:  Run manually:  npm uninstall -g codex-monitor");
    console.log("  :help:  Then retry:    npm install -g bosun");
    console.log("");
    // Don't block the install — npm may still succeed with --force,
    // or the user can follow the manual instructions.
  }
}

main();
