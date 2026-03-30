import { describe, expect, it } from "vitest";

import { discoverProviders, invalidateCache } from "../shell/opencode-providers.mjs";

describe("opencode-providers", () => {
  it("keeps provider discovery resilient", async () => {
    invalidateCache();
    const snapshot = await discoverProviders({ force: true });
    expect(Array.isArray(snapshot.providers)).toBe(true);
    expect(Array.isArray(snapshot.connectedIds)).toBe(true);
  });
});
