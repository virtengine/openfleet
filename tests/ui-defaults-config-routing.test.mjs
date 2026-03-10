import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(relPath) {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("stored defaults config routing", () => {
  it("routes startup sdk and region defaults through settings update payloads", () => {
    const uiSource = read("ui/modules/state.js");
    const siteSource = read("site/ui/modules/state.js");

    for (const source of [uiSource, siteSource]) {
      expect(source).toContain('apiFetch("/api/settings/update"');
      expect(source).toContain('JSON.stringify({ changes: settingsUpdates })');
      expect(source).toContain("settingsUpdates.INTERNAL_EXECUTOR_SDK = sdk");
      expect(source).toContain("settingsUpdates.EXECUTOR_REGIONS = region");
      expect(source).not.toContain('apiFetch("/api/config/update"');
    }
  });
});
