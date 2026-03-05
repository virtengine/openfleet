#!/usr/bin/env node
/**
 * test-file-pairs — Show source files that lack a corresponding test file
 *
 * Usage: node test-file-pairs.mjs [rootDir] [--json]
 *   rootDir  defaults to cwd
 *   --json   emit JSON array instead of human-readable output
 *
 * Searches for common test file naming conventions:
 *   <base>.test.mjs / .test.js / .test.ts
 *   <base>.spec.js / .spec.ts
 *   __tests__/<base>.{mjs,js,ts}
 *
 * Exit code 1 if any unpaired files found, 0 if all covered.
 */
import { readdirSync, existsSync } from "node:fs";
import { resolve, relative, basename, extname, dirname } from "node:path";

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const ROOT = args.find((a) => !a.startsWith("-")) || process.cwd();

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".bosun", "dist", "build",
  "coverage", ".cache", ".next",
]);

const SRC_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

const TEST_SUFFIXES = [
  ".test.mjs", ".test.js", ".test.ts", ".test.tsx", ".test.jsx",
  ".spec.mjs", ".spec.js", ".spec.ts", ".spec.tsx",
];

function isTestFile(name) {
  return TEST_SUFFIXES.some((s) => name.endsWith(s)) ||
    name.includes("__tests__") ||
    name.includes(".test.") ||
    name.includes(".spec.");
}

function walk(dir, results = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const ent of entries) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(full, results);
    } else if (SRC_EXTS.has(extname(ent.name)) && !isTestFile(ent.name)) {
      results.push(full);
    }
  }
  return results;
}

function hasTestFile(srcPath) {
  const dir = dirname(srcPath);
  const base = basename(srcPath, extname(srcPath));
  const ext = extname(srcPath);

  // Sibling test file
  for (const suffix of TEST_SUFFIXES) {
    if (existsSync(resolve(dir, base + suffix))) return true;
  }

  // __tests__ subfolder
  for (const suffix of [ext, ...TEST_SUFFIXES]) {
    const candidate = resolve(dir, "__tests__", base + suffix);
    if (existsSync(candidate)) return true;
  }

  // Dedicated tests/ directory at repo root (strip leading src/ or lib/)
  const rel = relative(ROOT, srcPath);
  const testRoots = ["tests", "test", "__tests__"].map((d) => resolve(ROOT, d));
  for (const testRoot of testRoots) {
    if (!existsSync(testRoot)) continue;
    // Remove leading path segments like src/, lib/
    const normalized = rel.replace(/^(?:src|lib|app)[\\/]/, "");
    for (const suffix of TEST_SUFFIXES) {
      if (existsSync(resolve(testRoot, normalized.replace(extname(normalized), suffix)))) {
        return true;
      }
    }
  }

  return false;
}

const srcFiles = walk(ROOT);
const missing = srcFiles.filter((f) => !hasTestFile(f)).map((f) => relative(ROOT, f));

if (jsonMode) {
  console.log(JSON.stringify({ missing, total: srcFiles.length, covered: srcFiles.length - missing.length }, null, 2));
} else {
  if (missing.length === 0) {
    console.log(`All ${srcFiles.length} source file(s) have corresponding test files. ✓`);
  } else {
    console.log(`${missing.length}/${srcFiles.length} source file(s) are missing test coverage:\n`);
    for (const f of missing) console.log(`  ${f}`);
  }
}

process.exit(missing.length > 0 ? 1 : 0);
