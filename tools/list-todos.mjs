#!/usr/bin/env node
/**
 * list-todos — Scan codebase for TODO/FIXME/HACK/XXX/BUG comment markers
 *
 * Usage: node list-todos.mjs [rootDir] [--json]
 *   rootDir  defaults to cwd
 *   --json   emit JSON array instead of human-readable output
 *
 * Exit 0 always (informational tool).
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, extname } from "node:path";

const args = process.argv.slice(2);
const jsonMode = args.includes("--json");
const ROOT = args.find((a) => !a.startsWith("-")) || process.cwd();

const PATTERNS = [
  /\/\/\s*(TODO|FIXME|HACK|XXX|TEMP|BUG)[\s:]/i,
  /\/\*+\s*(TODO|FIXME|HACK|XXX|BUG)/i,
  /#\s*(TODO|FIXME|HACK|XXX|BUG)/i,
];

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".bosun", "dist", "build",
  "coverage", ".cache", ".next", ".turbo", "out",
]);

const TEXT_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx",
  ".py", ".sh", ".rb", ".go", ".rs",
  ".md", ".yaml", ".yml", ".toml", ".css", ".html",
]);

const results = [];

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
    } else if (TEXT_EXTS.has(extname(ent.name))) {
      let lines;
      try {
        lines = readFileSync(full, "utf8").split("\n");
      } catch {
        continue;
      }
      for (let i = 0; i < lines.length; i++) {
        if (PATTERNS.some((p) => p.test(lines[i]))) {
          const match = lines[i].match(/\b(TODO|FIXME|HACK|XXX|TEMP|BUG)\b/i);
          results.push({
            file: relative(ROOT, full),
            line: i + 1,
            marker: match ? match[1].toUpperCase() : "TODO",
            text: lines[i].trim(),
          });
        }
      }
    }
  }
}

scan(ROOT);

if (jsonMode) {
  console.log(JSON.stringify(results, null, 2));
} else {
  if (results.length === 0) {
    console.log("No TODO/FIXME/HACK markers found.");
  } else {
    const byMarker = {};
    for (const r of results) {
      (byMarker[r.marker] = byMarker[r.marker] || []).push(r);
    }
    for (const [marker, items] of Object.entries(byMarker)) {
      console.log(`\n── ${marker} (${items.length}) ────────────────`);
      for (const r of items) {
        console.log(`  ${r.file}:${r.line}  ${r.text}`);
      }
    }
    console.log(`\nTotal: ${results.length} marker(s) in ${ROOT}`);
  }
}
