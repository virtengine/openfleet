import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "infra/maintenance.mjs"), "utf8");

test("maintenance logs benign dirty-working-tree branch sync skips at info/log level", () => {
  assert.ok(source.includes("function logThrottledBranchSync("));
  assert.ok(source.includes('level = "warn"'));
  assert.ok(source.includes('throttleMs = BRANCH_SYNC_LOG_THROTTLE_MS'));
  assert.match(source, /else if \(level === "info"(?: \|\| level === "log")?\)/);
  assert.match(
    source,
    /logThrottledBranchSync\(\s*`sync:\$\{branch\}:diverged-dirty`,\s*`\[maintenance\] local '\$\{branch\}' diverged \(\$\{ahead\}↑ \$\{behind\}↓\) but has uncommitted changes — skipping`,\s*"(?:info|log)"/,
  );
  assert.match(
    source,
    /logThrottledBranchSync\(\s*`sync:\$\{branch\}:dirty-pull-skip`,\s*`\[maintenance\] '\$\{branch\}' is checked out with uncommitted changes — skipping pull`,\s*"(?:info|log)"/,
  );
});
