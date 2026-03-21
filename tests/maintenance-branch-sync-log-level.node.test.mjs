import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const source = readFileSync(resolve(process.cwd(), "infra/maintenance.mjs"), "utf8");

test("maintenance branch sync logger accepts string shorthand levels", () => {
  assert.match(
    source,
    /typeof levelOrOptions === "string"\s*\?\s*\{ level: levelOrOptions \}/,
    "expected string level shorthands like 'log' to be normalized into options",
  );
});

test("maintenance branch sync logger routes info and log levels to console.log", () => {
  assert.match(
    source,
    /level === "info" \|\| level === "log"/,
    "expected info and log levels to use console.log instead of warn",
  );
});
