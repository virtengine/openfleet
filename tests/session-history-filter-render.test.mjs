import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourceFiles = [
  "ui/components/session-list.js",
  "site/ui/components/session-list.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

for (const { relPath, source } of sourceFiles) {
  describe(`Session history filter UI (${relPath})`, () => {
    it("defines explicit all/active/historic filter modes", () => {
      expect(source).toContain("const SESSION_VIEW_FILTER = Object.freeze");
      expect(source).toContain('all: "all"');
      expect(source).toContain('active: "active"');
      expect(source).toContain('historic: "historic"');
    });

    it("classifies historic sessions as non-active statuses", () => {
      expect(source).toMatch(
        /function isHistoricSession\(session\)\s*\{\s*return !isActiveSession\(session\);\s*\}/,
      );
      expect(source).toMatch(
        /function isActiveSession\(session\)\s*\{[\s\S]*status === "active" \|\| status === "running"/,
      );
    });

    it("renders All, Active, and Historic filter buttons with counts", () => {
      expect(source).toContain("All (${allCount})");
      expect(source).toContain("Active (${activeCount})");
      expect(source).toContain("Historic (${historicCount})");
    });

    it("resets historic filter before creating a new session", () => {
      expect(source).toContain(
        "resolvedSessionView === SESSION_VIEW_FILTER.historic",
      );
      expect(source).toContain("setSessionView(SESSION_VIEW_FILTER.all)");
    });
  });
}
