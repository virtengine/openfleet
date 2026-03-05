#!/usr/bin/env node
/**
 * dead-exports-scan — Find exported symbols that are never imported elsewhere
 *
 * Scans a JS/TS/MJS codebase for `export function`, `export const`, `export class`
 * declarations, then checks if each name appears in an import statement anywhere
 * in the project. Reports symbols that appear to be unused.
 *
 * Limitations:
 *   - Does not follow dynamic imports or computed property access
 *   - Re-exports (`export * from`) are treated as opaque
 *   - False positives possible for symbols used only in tests or via barrel files
 *
 * Usage: node dead-exports-scan.mjs [rootDir] [--json] [--include-tests]
 *   rootDir         defaults to cwd
 *   --json          emit JSON array
 *   --include-tests also scan files in test/tests/__tests__ dirs
 *
 * Exit code 1 if dead exports found, 0 if none.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, extname } from "node:path";

const rawArgs = process.argv.slice(2);
const jsonMode = rawArgs.includes("--json");
const includeTests = rawArgs.includes("--include-tests");
const ROOT = rawArgs.find((a) => !a.startsWith("-")) || process.cwd();

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".bosun", "dist", "build",
  "coverage", ".cache", ".next", ".turbo",
]);
if (!includeTests) {
  SKIP_DIRS.add("test");
  SKIP_DIRS.add("tests");
  SKIP_DIRS.add("__tests__");
}

const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

// Matches: export function Foo, export const Foo, export class Foo, export async function Foo
const EXPORT_RE =
  /^export\s+(?:async\s+)?(?:function|const|let|var|class|enum|interface|type)\s+([A-Z_a-z]\w*)/;
// Named export list: export { Foo, Bar as Baz }
const NAMED_EXPORT_RE = /^export\s*\{([^}]+)\}/;
// Default export: export default function Foo — skip (default is always "used" conventionally)

// Import name matches: import { Foo, Bar } or import Foo
const IMPORT_NAMES_RE =
  /import\s*(?:type\s*)?\{([^}]+)\}|import\s+([A-Z_a-z]\w*)\s+from/g;

const exportedSymbols = []; // { name, file, line }
const importedNames = new Set();

const allFiles = [];

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walk(full);
    } else if (CODE_EXTS.has(extname(ent.name))) {
      allFiles.push(full);
    }
  }
}

walk(ROOT);

// First pass: collect all exports
for (const file of allFiles) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m1 = EXPORT_RE.exec(line);
    if (m1) {
      exportedSymbols.push({ name: m1[1], file: relative(ROOT, file), line: i + 1 });
      continue;
    }
    const m2 = NAMED_EXPORT_RE.exec(line);
    if (m2) {
      for (const part of m2[1].split(",")) {
        // handle `Foo as Bar` → exported name is Bar
        const [, name] = part.trim().split(/\s+as\s+/);
        const sym = (name || part.trim()).replace(/\s.*/, "").trim();
        if (sym && /^[A-Z_a-z]\w*$/.test(sym)) {
          exportedSymbols.push({ name: sym, file: relative(ROOT, file), line: i + 1 });
        }
      }
    }
  }
}

// Second pass: collect all imported names
for (const file of allFiles) {
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  IMPORT_NAMES_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_NAMES_RE.exec(src)) !== null) {
    if (m[1]) {
      // named imports
      for (const part of m[1].split(",")) {
        const local = part.trim().split(/\s+as\s+/).pop().trim();
        if (local) importedNames.add(local);
        // Also add the original name (before 'as')
        const orig = part.trim().split(/\s+as\s+/)[0].trim();
        if (orig) importedNames.add(orig);
      }
    } else if (m[2]) {
      importedNames.add(m[2]);
    }
  }
}

const dead = exportedSymbols.filter((s) => !importedNames.has(s.name));

if (jsonMode) {
  console.log(JSON.stringify(dead, null, 2));
} else {
  if (dead.length === 0) {
    console.log("No dead exports detected. ✓");
  } else {
    console.log(`${dead.length} potentially unused export(s):\n`);
    for (const s of dead) {
      console.log(`  ${s.file}:${s.line}  export ${s.name}`);
    }
    console.log(
      "\nNote: barrel re-exports, dynamic imports, and test usage are not tracked.",
    );
  }
}

process.exit(dead.length > 0 ? 1 : 0);
