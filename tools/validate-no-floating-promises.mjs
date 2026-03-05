#!/usr/bin/env node
/**
 * validate-no-floating-promises — Detect "floating" async calls not awaited or caught
 *
 * Catches common patterns that cause unhandled promise rejections in Node.js:
 *   - `void asyncFn()`          — explicit fire-and-forget without .catch()
 *   - standalone async call on its own line without await/catch prefix
 *
 * Real false-positive rate: low. Best used as a code-review hint, not a hard gate.
 *
 * Usage: node validate-no-floating-promises.mjs [rootDir] [--json] [--strict]
 *   rootDir   defaults to cwd
 *   --json    emit JSON array
 *   --strict  also flag bare function calls that MIGHT be async (higher FP rate)
 *
 * Exit code 1 if issues found, 0 if clean.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, extname } from "node:path";

const rawArgs = process.argv.slice(2);
const jsonMode = rawArgs.includes("--json");
const strictMode = rawArgs.includes("--strict");
const ROOT = rawArgs.find((a) => !a.startsWith("-")) || process.cwd();

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".bosun", "dist", "build",
  "coverage", ".cache", ".next",
]);
const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

// Pattern 1: explicit `void someAsync(` pattern
const VOID_ASYNC_RE = /\bvoid\s+\w[\w.]*\s*\(/g;

// Pattern 2 (strict): bare foo() on its own line not preceded by await/return/const/let/var/=
// Look for async-named functions (common naming: ...Async, dispatch*, emit*, send*, save*)
const BARE_ASYNC_RE = /^(?!.*(?:await|return|const|let|var|=|\/\/|\/\*)).*(?:Async|dispatch|emit|send|save|write|flush|publish|notify|record)\w*\s*\(/;

const issues = [];

function scan(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) scan(full);
    } else if (CODE_EXTS.has(extname(ent.name))) {
      let lines;
      try {
        lines = readFileSync(full, "utf8").split("\n");
      } catch {
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        VOID_ASYNC_RE.lastIndex = 0;
        if (VOID_ASYNC_RE.test(line)) {
          issues.push({
            file: relative(ROOT, full),
            line: i + 1,
            type: "void-async",
            text: line.trim(),
          });
          continue;
        }
        if (strictMode && BARE_ASYNC_RE.test(line.trim())) {
          issues.push({
            file: relative(ROOT, full),
            line: i + 1,
            type: "bare-async",
            text: line.trim(),
          });
        }
      }
    }
  }
}

scan(ROOT);

if (jsonMode) {
  console.log(JSON.stringify(issues, null, 2));
} else {
  if (issues.length === 0) {
    console.log("No floating-promise patterns detected. ✓");
  } else {
    console.log(
      `${issues.length} potential floating-promise issue(s) found:\n`,
    );
    for (const iss of issues) {
      console.log(`  ${iss.file}:${iss.line}  [${iss.type}]`);
      console.log(`    ${iss.text}`);
    }
    console.log(
      "\nEach `void asyncFn()` call should have .catch() or be replaced with await.",
    );
  }
}

process.exit(issues.length > 0 ? 1 : 0);
