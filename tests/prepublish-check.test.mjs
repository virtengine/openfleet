import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  expandPublishedFiles,
  findLocalImportSpecifiers,
  validatePublishedLocalImports,
} from "../tools/prepublish-check.mjs";

const tempDirs = [];

function createFixture(structure) {
  const root = mkdtempSync(resolve(tmpdir(), "bosun-prepublish-test-"));
  tempDirs.push(root);

  for (const [relativePath, content] of Object.entries(structure)) {
    const target = resolve(root, relativePath);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("prepublish-check", () => {
  it("parses nested relative imports including parent-directory imports", async () => {
    const source = [
      'import { a } from "./local.mjs";',
      'import "../side-effect.mjs";',
      'export { b } from "../shared/util.mjs";',
      'const c = await import("../dynamic.mjs");',
    ].join("\n");

    await expect(findLocalImportSpecifiers(source)).resolves.toEqual([
      "./local.mjs",
      "../side-effect.mjs",
      "../shared/util.mjs",
      "../dynamic.mjs",
    ]);
  });

  it("expands directory entries from the published files manifest", () => {
    const root = createFixture({
      "package.json": JSON.stringify({ name: "fixture", version: "1.0.0", files: ["infra"] }),
      "infra/monitor.mjs": "export const ok = true;",
      "infra/nested/helper.mjs": "export const helper = true;",
    });

    expect([...expandPublishedFiles(root, ["infra"])].sort()).toEqual([
      "infra/monitor.mjs",
      "infra/nested/helper.mjs",
    ]);
  });

  it("fails when a published module imports a non-published parent-relative file", async () => {
    const root = createFixture({
      "package.json": JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        files: ["infra/monitor.mjs"],
      }),
      "infra/monitor.mjs": 'import "../monitor-tail-sanitizer.mjs";\nexport const ok = true;',
      "monitor-tail-sanitizer.mjs": "export const sanitize = () => true;",
    });

    const pkg = JSON.parse(
      '{"name":"fixture","version":"1.0.0","files":["infra/monitor.mjs"]}',
    );
    const result = await validatePublishedLocalImports({ rootDir: root, pkg });

    expect(result.missing).toEqual([
      {
        file: "infra/monitor.mjs",
        imported: "../monitor-tail-sanitizer.mjs",
        resolved: "monitor-tail-sanitizer.mjs",
      },
    ]);
  });

  it("passes when the imported file is included in the published manifest", async () => {
    const root = createFixture({
      "package.json": JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        files: ["infra/monitor.mjs", "monitor-tail-sanitizer.mjs"],
      }),
      "infra/monitor.mjs": 'import "../monitor-tail-sanitizer.mjs";\nexport const ok = true;',
      "monitor-tail-sanitizer.mjs": "export const sanitize = () => true;",
    });

    const pkg = JSON.parse(
      '{"name":"fixture","version":"1.0.0","files":["infra/monitor.mjs","monitor-tail-sanitizer.mjs"]}',
    );
    const result = await validatePublishedLocalImports({ rootDir: root, pkg });

    expect(result.missing).toEqual([]);
  });
});