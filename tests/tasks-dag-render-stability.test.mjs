import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const files = [
  "ui/tabs/tasks.js",
  "site/ui/tabs/tasks.js",
].map((relPath) => ({
  relPath,
  source: readFileSync(resolve(process.cwd(), relPath), "utf8"),
}));

for (const { relPath, source } of files) {
  describe(`tasks DAG render stability (${relPath})`, () => {
    it("uses explicit null fallbacks for optional DAG children", () => {
      expect(source).toContain("${dagError ? html`");
      expect(source).toContain("${dagLoading ? html`");
      expect(source).toContain("${description ? html`");
      expect(source).not.toContain("${dagError && html`");
      expect(source).not.toContain("${dagLoading && html`");
      expect(source).not.toContain("${description && html`");
    });

    it("uses explicit close tags for DagGraphSection instances", () => {
      expect(source).toContain('emptyMessage="No sprint DAG data available yet."');
      expect(source).toContain('emptyMessage="No global DAG data available yet."');
      expect(source).toContain('emptyMessage="No epic DAG data available yet."');
      expect(source).toMatch(/emptyMessage="No sprint DAG data available yet\."\s*\n\s*><\/\/>/);
      expect(source).toMatch(/emptyMessage="No global DAG data available yet\."\s*\n\s*><\/\/>/);
      expect(source).toMatch(/emptyMessage="No epic DAG data available yet\."\s*\n\s*><\/\/>/);
    });

    it("does not contain leaked DagGraphSection prop text", () => {
      expect(source).not.toContain("allowWiring=emptyMessage");
    });

    it("keeps depth normalization and drag wiring hooks in sync", () => {
      expect(source).toContain("buildDagDepthMap(");
      expect(source).toContain("buildTopologicalDepthMap(");
      expect(source).toContain("beginWireDrag(node, event)");
      expect(source).toContain("onDeleteEdge=${(edge) => handleDeleteDagEdge");
    });
  });
}
