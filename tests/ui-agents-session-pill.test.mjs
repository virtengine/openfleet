/**
 * Source-level tests for the FleetSessionsPanel session-ID pill.
 *
 * Validates:
 *  - The clipboard API guard is present in copySessionId.
 *  - The sessionId variable is derived per-entry inside visibleEntries.map.
 *  - The pill button is not a nested <button> inside another <button>
 *    (outer row uses component="div").
 *  - The animationEnd handler resets copiedSessionId.
 *  - copySessionId is NOT defined inside AgentsTab (would reference undefined state).
 */
import { describe, it, expect } from "vitest";
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
  describe(`FleetSessionsPanel session-ID pill (${relPath})`, () => {
    it("guards against unavailable Clipboard API before writing", () => {
      expect(source).toContain("navigator?.clipboard?.writeText");
    });

    it("resets copied state and shows error when clipboard is unavailable", () => {
      expect(source).toContain('showToast("Copy failed", "error")');
    });

    it("derives sessionId per-entry inside visibleEntries.map", () => {
      expect(source).toContain("const sessionId = resolveFleetEntrySessionId(entry)");
    });

    it("resets copiedSessionId to empty string on animationEnd", () => {
      expect(source).toContain('if (copiedSessionId === sessionId) setCopiedSessionId("")');
    });

    it("outer row container uses component=\"div\" to avoid nested <button> elements", () => {
      expect(source).toContain('component="div"');
    });

    it("does not define copySessionId inside AgentsTab", () => {
      const agentsTabStart = source.indexOf("export function AgentsTab()");
      const fleetPanelStart = source.indexOf("function FleetSessionsPanel(");
      expect(agentsTabStart).toBeGreaterThan(-1);
      expect(fleetPanelStart).toBeGreaterThan(-1);
      // copySessionId must only appear after FleetSessionsPanel begins
      const agentsTabChunk = source.slice(agentsTabStart, fleetPanelStart);
      expect(agentsTabChunk).not.toContain("const copySessionId =");
    });
  });
}
