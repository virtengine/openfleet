import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("shared UI layering regressions", () => {
  it("portals ToastContainer to document.body so modals cannot cover it", () => {
    const source = readFileSync(resolve(process.cwd(), "ui/components/shared.js"), "utf8");
    expect(source).toContain("export function ToastContainer()");
    expect(source).toContain("return createPortal(content, document.body);");
  });
});
