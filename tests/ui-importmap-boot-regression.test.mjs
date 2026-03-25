import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexSource = readFileSync(resolve(process.cwd(), "ui", "index.html"), "utf8");

describe("ui index module boot", () => {
  it("registers the import map before booting app.js", () => {
    const importMapIndex = indexSource.indexOf('<script type="importmap">');
    const moduleBootIndex = indexSource.indexOf('<script type="module">');

    expect(importMapIndex).toBeGreaterThanOrEqual(0);
    expect(moduleBootIndex).toBeGreaterThan(importMapIndex);
    expect(indexSource).toContain('import "/app.js";');
  });

  it("does not preload or dynamically import the app entry before import maps exist", () => {
    expect(indexSource).not.toContain('<link rel="modulepreload" href="/app.js"');
    expect(indexSource).not.toContain('<link rel="modulepreload" href="/vendor/preact.js"');
    expect(indexSource).not.toContain('window.importShim(url)');
    expect(indexSource).not.toContain('return import(url)');
  });
});
