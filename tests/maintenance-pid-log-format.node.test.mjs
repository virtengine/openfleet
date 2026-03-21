import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "infra/maintenance.mjs"), "utf8");

test("maintenance formats stale pid warning with compact pid summary", () => {
  assert.match(
    source,
    /function formatPidFileSummary\(parsed\)/,
    "expected formatPidFileSummary helper for stale pid warnings",
  );
  assert.match(
    source,
    /formatPidFileSummary\(parsed\)/,
    "expected stale pid warning to use compact pid summary",
  );
});

