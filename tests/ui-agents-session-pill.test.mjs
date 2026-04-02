import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const sourceFiles = [
  "ui/tabs/agents.js",
  "site/ui/tabs/agents.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

for (const { relPath, source } of sourceFiles) {
  describe(`agents session pill diagnostics actions (${relPath})`, () => {
    it("opens a session action menu from the existing pill entrypoint", () => {
      expect(source).toContain("fleet-session-id-pill");
      expect(source).toContain("setSessionActionMenu");
      expect(source).toContain("aria-controls=${sessionActionMenuOpen ? \"fleet-session-action-menu\" : undefined}");
      expect(source).toContain("aria-haspopup=\"menu\"");
      expect(source).toContain("aria-expanded=${sessionActionMenuOpen ? \"true\" : undefined}");
      expect(source).toContain("openSessionActionMenu(event, sessionId)");
      expect(source).not.toContain("onClick=${() => copySessionId(sessionId)}");
    });

    it("offers copy-id and diagnostics export actions with visible failure handling", () => {
      expect(source).toContain("Copy Session ID");
      expect(source).toContain("Copy Diagnostics");
      expect(source).toContain("Download Diagnostics");
      expect(source).toContain("Session diagnostics copied");
      expect(source).toContain("Session diagnostics saved");
      expect(source).toContain("Diagnostics export failed");
      expect(source).toContain("session-diagnostics-${sessionId}.json");
      expect(source).toContain("buildSessionApiPath(sessionId, \"diagnostics\"");
    });
  });
}
