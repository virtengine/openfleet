import { afterEach, describe, expect, it, vi } from "vitest";

import * as providersModule from "../shell/opencode-providers.mjs";

const { discoverProviders, invalidateCache } = providersModule;

afterEach(() => {
  vi.restoreAllMocks();
  invalidateCache();
});

describe("opencode-providers", () => {
  it("keeps provider discovery resilient", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("");

    const snapshot = await discoverProviders({ force: true });
    expect(Array.isArray(snapshot.providers)).toBe(true);
    expect(Array.isArray(snapshot.connectedIds)).toBe(true);
  }, 15000);
});
