#!/usr/bin/env node
/**
 * git-hot-files — Rank files by commit frequency (most-changed = highest churn risk)
 *
 * Usage: node git-hot-files.mjs [top=20] [since="3 months ago"] [--json]
 *
 * Hot files have high churn; they are risky candidates for refactoring,
 * conflict-prone in parallel branch work, and worth extra review attention.
 *
 * Exit 0 always. Requires git in PATH and a git repo in cwd.
 */
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const jsonMode = process.argv.includes("--json");
const top = parseInt(args[0] || "20", 10);
const since = args[1] || "3 months ago";
const cwd = args[2] || process.cwd();

let log;
try {
  log = execSync(`git log --since="${since}" --name-only --format=""`, {
    encoding: "utf8",
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
} catch (err) {
  console.error("git-hot-files: must run inside a git repository");
  console.error(err.message);
  process.exit(1);
}

const counts = {};
for (const line of log.split("\n")) {
  const file = line.trim();
  if (file && !file.startsWith("commit ")) {
    counts[file] = (counts[file] || 0) + 1;
  }
}

const sorted = Object.entries(counts)
  .sort(([, a], [, b]) => b - a)
  .slice(0, top);

if (sorted.length === 0) {
  console.log(`No commits found in the last "${since}".`);
  process.exit(0);
}

if (jsonMode) {
  const result = sorted.map(([file, commits]) => ({ file, commits }));
  console.log(JSON.stringify(result, null, 2));
} else {
  const maxCommits = sorted[0][1];
  console.log(`Top ${sorted.length} most-changed files (since "${since}"):\n`);
  console.log(`${"Commits".padEnd(10)} ${"File"}`);
  console.log(`${"─".repeat(10)} ${"─".repeat(60)}`);
  for (const [file, n] of sorted) {
    const bar = "█".repeat(Math.round((n / maxCommits) * 10));
    console.log(`${String(n).padEnd(10)} ${file}  ${bar}`);
  }
  console.log(`\nTotal unique files changed: ${Object.keys(counts).length}`);
}
