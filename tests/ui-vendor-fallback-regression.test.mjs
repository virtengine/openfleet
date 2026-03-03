import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("ui vendor fallback regressions", () => {
  it("keeps MUI/emotion fallback entries while routing requests through local /esm proxy", () => {
    const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");
    expect(source).toContain('"mui-material.js":          { specifier: null, cdn:');
    expect(source).toContain('"emotion-react.js":         { specifier: null, cdn:');
    expect(source).toContain('"emotion-styled.js":        { specifier: null, cdn:');
    expect(source).toContain("const ESM_CDN_FILES = {");
    expect(source).toContain('if (url.pathname.startsWith("/esm/"))');
  });
});
