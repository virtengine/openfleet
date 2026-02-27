import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "maintenance.mjs"), "utf8");

test("maintenance logs benign dirty-working-tree branch sync skips at info/log level", () => {
  assert.match(
    source,
    /console\.log\(\s*`\[maintenance\] local '\$\{branch\}' diverged \(\$\{ahead\}↑ \$\{behind\}↓\) but has uncommitted changes — skipping`/,
  );
  assert.match(
    source,
    /console\.log\(\s*`\[maintenance\] '\$\{branch\}' is checked out with uncommitted changes — skipping pull`/,
  );
});
