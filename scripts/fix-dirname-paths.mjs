#!/usr/bin/env node
/**
 * fix-dirname-paths.mjs — Fix __dirname-based path resolutions in moved files.
 *
 * After moving files into subdirectories, __dirname no longer points to root.
 * This script adds ".." to path resolutions that target root-level directories/files.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// Root-level targets that need ".." prepended when accessed via __dirname from subfolders
const ROOT_TARGETS = [
  "logs",
  ".cache",
  "package.json",
  "cli.mjs",
  "ui",
  "bosun.schema.json",
  "site",
  "tools",
  "monitor.mjs",
];

// Directories to scan (only moved-file directories)
const SCAN_DIRS = ["agent", "voice", "task", "git", "shell", "workflow", "config",
  "telegram", "github", "workspace", "kanban", "infra", "server"];

let filesChanged = 0;
let fixesApplied = 0;

for (const dir of SCAN_DIRS) {
  const dirPath = resolve(ROOT, dir);
  if (!existsSync(dirPath)) continue;

  for (const file of readdirSync(dirPath).filter(f => f.endsWith(".mjs"))) {
    const filePath = resolve(dirPath, file);
    let content = readFileSync(filePath, "utf8");
    let changed = false;

    for (const target of ROOT_TARGETS) {
      // Pattern: resolve(__dirname, "target" or resolve(__dirname, "target",
      // Must NOT already have ".." as the first argument after __dirname
      const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      // Match: resolve(__dirname, "target") or resolve(__dirname, "target",
      // But NOT: resolve(__dirname, "..", "target") which is already fixed
      // Also not: resolve(__dirname, "..", ".cache") etc.
      const re = new RegExp(
        `(resolve\\s*\\(\\s*__dirname\\s*,\\s*)(["'])${escapedTarget}\\2`,
        "g"
      );

      content = content.replace(re, (match, prefix, quote) => {
        // Check if ".." is already present (don't double-fix)
        // Look backwards in the match context
        changed = true;
        fixesApplied++;
        return `${prefix}${quote}..${quote}, ${quote}${target}${quote}`;
      });
    }

    // Also fix: new URL("./package.json", import.meta.url) pattern
    // telegram-bot uses this
    content = content.replace(
      /new URL\(\s*["']\.\/package\.json["']\s*,\s*import\.meta\.url\s*\)/g,
      (match) => {
        changed = true;
        fixesApplied++;
        return `new URL("../package.json", import.meta.url)`;
      }
    );

    // Also fix: new URL(".", import.meta.url) used as base for file resolution
    // in ui-server.mjs (already fixed the workflow imports manually, but check for others)

    if (changed) {
      filesChanged++;
      writeFileSync(filePath, content, "utf8");
      console.log(`  ✓ ${dir}/${file}`);
    }
  }
}

console.log(`\nFiles changed: ${filesChanged}, fixes applied: ${fixesApplied}`);
