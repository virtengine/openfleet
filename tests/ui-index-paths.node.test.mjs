import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

function validateIndexHtml(filePath) {
  const source = readFileSync(filePath, "utf8");
  assert.match(source, /href="\/favicon\.png"/);
  assert.match(source, /href="\/styles\.css"/);
  assert.match(source, /href="\/styles\/kanban\.css"/);
  assert.match(source, /href="\/styles\/sessions\.css"/);
  assert.match(source, /new URL\("\/app\.js", window\.location\.origin\)/);
}

test("ui index uses root-absolute asset URLs", () => {
  validateIndexHtml(resolve(process.cwd(), "ui", "index.html"));
});

test("site/ui index uses root-absolute asset URLs", () => {
  validateIndexHtml(resolve(process.cwd(), "site", "ui", "index.html"));
});
