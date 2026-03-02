import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("ui-server esm proxy targets", () => {
  it("uses a working MUI CDN URL", () => {
    const source = readFileSync(resolve(process.cwd(), "ui-server.mjs"), "utf8");
    expect(source).toContain('"mui-material.js": "https://esm.sh/@mui/material@5?bundle"');
    expect(source).not.toContain("@mui/material@5?bundle&external=react,react-dom,react/jsx-runtime");
  });
});

