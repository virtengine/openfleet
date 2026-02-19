#!/usr/bin/env node

/**
 * prepublish-check.mjs — Pre-publish validation gate.
 *
 * Scans all .mjs files for local `import ... from "./foo.mjs"` statements
 * and verifies each imported file is listed in package.json's `files` array.
 * Also checks for duplicate entries in `files`.
 *
 * Run automatically via `prepublishOnly` script, or manually:
 *   node prepublish-check.mjs
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf8"),
);

if (!pkg.version) {
  console.error("❌ Missing version in package.json");
  process.exit(1);
}

const filesArray = pkg.files || [];
const filesSet = new Set(filesArray);

// ── Check for duplicates ─────────────────────────────────────────────────────
const seen = new Set();
const duplicates = [];
for (const f of filesArray) {
  if (seen.has(f)) duplicates.push(f);
  seen.add(f);
}
if (duplicates.length > 0) {
  console.error(
    `❌ Duplicate entries in files array: ${duplicates.join(", ")}`,
  );
  process.exit(1);
}

// ── Scan all .mjs files for local imports ────────────────────────────────────
const mjsFiles = readdirSync(__dirname).filter(
  (f) => f.endsWith(".mjs") && f !== "prepublish-check.mjs",
);

const importPattern = /from\s+["']\.\/([^"']+)["']/g;
const missing = [];

for (const file of mjsFiles) {
  // Only check files that are in the files array (i.e., will be published)
  if (!filesSet.has(file)) continue;

  const content = readFileSync(resolve(__dirname, file), "utf8");
  let match;
  importPattern.lastIndex = 0;

  while ((match = importPattern.exec(content)) !== null) {
    const imported = match[1];
    // Skip if it's a comment line
    const lineStart = content.lastIndexOf("\n", match.index) + 1;
    const line = content.slice(lineStart, match.index).trimStart();
    if (
      line.startsWith("//") ||
      line.startsWith("*") ||
      line.startsWith("/*")
    ) {
      continue;
    }
    if (!filesSet.has(imported)) {
      missing.push({ file, imported });
    }
  }
}

if (missing.length > 0) {
  console.error("❌ Local imports not in package.json files array:");
  for (const { file, imported } of missing) {
    console.error(`   ${file} → import from "./${imported}"`);
  }
  console.error("\nAdd these to the 'files' array in package.json.");
  process.exit(1);
}

console.log(
  `✅ ${pkg.name}@${pkg.version} — ${filesArray.length} files, ${mjsFiles.length} .mjs scanned, 0 missing imports`,
);
