#!/usr/bin/env node
/**
 * imports-graph — Show all files that import a given module or path fragment
 *
 * Usage: node imports-graph.mjs <module-name> [rootDir] [--json] [--reverse]
 *   module-name   fragment to match in import/require paths (e.g. "agent-custom-tools")
 *   rootDir       defaults to cwd
 *   --json        emit JSON array
 *   --reverse     also show transitive fan-out (experimental, one level)
 *
 * Useful for: impact analysis before renaming/deleting a module, finding
 * all integration points of a shared utility, circular-dep investigation.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, extname } from "node:path";

const rawArgs = process.argv.slice(2);
const jsonMode = rawArgs.includes("--json");
const posArgs = rawArgs.filter((a) => !a.startsWith("-"));

const TARGET = posArgs[0];
if (!TARGET) {
  console.error(
    "Usage: node imports-graph.mjs <module-name-fragment> [rootDir] [--json]",
  );
  process.exit(1);
}

const ROOT = posArgs[1] ? resolve(posArgs[1]) : process.cwd();

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".bosun", "dist", "build",
  "coverage", ".cache", ".next", ".turbo",
]);
const CODE_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);

// Matches: import ... from "...", require("..."), import("...")
const IMPORT_RE = /(?:from|require|import)\s*[\("'`]([^"'`\n)]+)[\)"'`]/g;

const matches = [];

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
      let src;
      try {
        src = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const fileMatches = [];
      IMPORT_RE.lastIndex = 0;
      let m;
      while ((m = IMPORT_RE.exec(src)) !== null) {
        if (m[1].includes(TARGET)) {
          fileMatches.push(m[1]);
        }
      }
      if (fileMatches.length > 0) {
        matches.push({
          file: relative(ROOT, full),
          imports: [...new Set(fileMatches)],
        });
      }
    }
  }
}

scan(ROOT);

if (jsonMode) {
  console.log(JSON.stringify(matches, null, 2));
} else {
  if (matches.length === 0) {
    console.log(`No files found importing "${TARGET}" under ${ROOT}`);
  } else {
    console.log(
      `${matches.length} file(s) importing "${TARGET}" (under ${ROOT}):\n`,
    );
    for (const { file, imports } of matches) {
      console.log(`  ${file}`);
      for (const imp of imports) {
        console.log(`    └─ "${imp}"`);
      }
    }
  }
}
