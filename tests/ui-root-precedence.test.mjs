import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";

const targets = [
  "server/ui-server.mjs",
  "server/setup-web-server.mjs",
].map((relativePath) => ({
  relativePath,
  source: readFileSync(resolve(process.cwd(), relativePath), "utf8"),
}));

for (const { relativePath, source } of targets) {
  describe(`UI root precedence (${relativePath})`, () => {
    it("prefers ui/ over site/ui when both directories are present", () => {
      expect(source).toMatch(/const\s+uiRootPreferred\s*=\s*resolve\(__dirname,\s*(?:"\.\.",\s*)?"ui"\)/);
      expect(source).toMatch(/const\s+uiRootFallback\s*=\s*resolve\(__dirname,\s*(?:"\.\.",\s*)?"site",\s*"ui"\)/);
      expect(source).toMatch(
        /const\s+uiRoot\s*=\s*existsSync\(uiRootPreferred\)\s*\?\s*uiRootPreferred\s*:\s*uiRootFallback/,
      );
    });
  });
}
