import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildDemoDefaultsData,
  renderDefaultsScript,
} from "../tools/generate-demo-defaults.mjs";

const ROOT = process.cwd();

function read(relPath) {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("demo defaults generator sync", () => {
  it("generated ui and site demo defaults match source-of-truth", async () => {
    const data = await buildDemoDefaultsData();
    const expected = renderDefaultsScript(data);
    expect(read("ui/demo-defaults.js")).toBe(expected);
    expect(read("site/ui/demo-defaults.js")).toBe(expected);
  });
  it("demo html fixtures keep the hung-session alert copy in sync", () => {
    const expectedLabel = "label: 'Alert Hung Sessions'";
    const expectedMessage = "message: ':dot: Agent session appears hung — auto-continue attempted. Check status.'";

    for (const relPath of ["ui/demo.html", "site/ui/demo.html"]) {
      const source = read(relPath);
      expect(source).toContain(expectedLabel);
      expect(source).toContain(expectedMessage);
    }
  });
});
