#!/usr/bin/env node
/**
 * build-docs.mjs — Injects the current package version into all site/docs/*.html
 *
 * Usage:  node build-docs.mjs
 *         npm run build:docs
 *
 * What it does:
 *  - Reads version from package.json
 *  - Updates all .sidebar-version spans in site/docs/*.html with the current version
 *  - Updates any inline code blocks that show "bosun vX.Y.Z" version strings
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, "package.json");
const docsDir = join(__dirname, "site", "docs");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = pkg.version;
const vTag = `v${version}`;

const htmlFiles = readdirSync(docsDir).filter((f) => f.endsWith(".html"));

let changed = 0;
for (const file of htmlFiles) {
  const filePath = join(docsDir, file);
  let content = readFileSync(filePath, "utf8");
  const original = content;

  // Update sidebar-version spans
  content = content.replace(
    /(<span[^>]+id="current-version"[^>]*>)Current Version: v[\d.]+(<\/span>)/g,
    `$1Current Version: ${vTag}$2`,
  );
  content = content.replace(
    /(<span class="sidebar-version">)Docs Last Updated: v[\d.]+(<\/span>)/g,
    `$1Docs Last Updated: ${vTag}$2`,
  );

  // Update code block version strings like "# bosun v0.36.1"
  content = content.replace(
    /(#\s*bosun\s+)v[\d.]+(<\/code>)/gi,
    `$1${vTag}$2`,
  );

  if (content !== original) {
    writeFileSync(filePath, content, "utf8");
    console.log(`  ✓ Updated ${file}`);
    changed++;
  } else {
    console.log(`  - ${file} (no changes)`);
  }
}

console.log(`\nbuild:docs complete — ${changed}/${htmlFiles.length} files updated to ${vTag}`);
