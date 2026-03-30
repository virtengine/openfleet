import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const indexSource = readFileSync(resolve(process.cwd(), "ui", "index.html"), "utf8");
const siteIndexSource = readFileSync(resolve(process.cwd(), "site", "ui", "index.html"), "utf8");
const appSource = readFileSync(resolve(process.cwd(), "ui", "app.js"), "utf8");
const siteAppSource = readFileSync(resolve(process.cwd(), "site", "ui", "app.js"), "utf8");

describe("ui index module boot", () => {
  it("registers the import map before booting app.js", () => {
    for (const source of [indexSource, siteIndexSource]) {
      const importMapIndex = source.indexOf('<script type="importmap">');
      const moduleBootIndex = source.indexOf('<script type="module">');

      expect(importMapIndex).toBeGreaterThanOrEqual(0);
      expect(moduleBootIndex).toBeGreaterThan(importMapIndex);
      expect(source).toContain('const appUrl = new URL("/app.js", window.location.origin);');
      expect(source).toContain('if (appUrl.pathname !== "/app.js") throw new Error("Unexpected app entry path");');
      expect(source).toContain('import "/app.js";');
      expect(source).not.toContain('`r`n');
    }
  });

  it("does not preload or dynamically import the app entry before import maps exist", () => {
    expect(indexSource).not.toContain('<link rel="modulepreload" href="/app.js"');
    expect(indexSource).not.toContain('<link rel="modulepreload" href="/vendor/preact.js"');
    expect(indexSource).not.toContain('window.importShim(url)');
    expect(indexSource).not.toContain('return import(url)');
  });

  it("keeps lazy tab imports in module context instead of using indirect Function imports", () => {
    for (const source of [appSource, siteAppSource]) {
      expect(source).not.toContain('Function("u", "return import(u)")');
      expect(source).toContain('window.importShim(tabPath)');
      expect(source).toContain('nativeLoader()');
      expect(source).toContain('() => import("./tabs/tasks.js")');
      expect(source).toContain('() => import("./tabs/agents.js")');
      expect(source).toContain('resolveLazyTabComponent');
      expect(source).toContain('loader.key = `${tabPath}::${exportName || "default"}`');
    }
  });
});
