import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(relPath) {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("stored defaults config routing", () => {
  it("does not let app preferences silently mutate executor server config on startup", () => {
    const uiSource = read("ui/modules/state.js");
    const siteSource = read("site/ui/modules/state.js");

    for (const source of [uiSource, siteSource]) {
      expect(source).toContain("Executor runtime defaults now live only in Server Config");
      expect(source).not.toContain('apiFetch("/api/settings/update"');
      expect(source).not.toContain('apiFetch("/api/executor/maxparallel"');
      expect(source).not.toContain('JSON.stringify({ changes: settingsUpdates })');
    }
  });
});
