import { beforeEach, describe, expect, it, vi } from "vitest";

describe("telegram health region cache", () => {
  beforeEach(async () => {
    const mod = await import("../telegram/telegram-bot.mjs");
    mod.__executorHealthTestApi.resetHealthRegionCacheForTest();
  });

  it("deduplicates concurrent region refreshes and reuses the cached result", async () => {
    const mod = await import("../telegram/telegram-bot.mjs");
    const loader = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        active_region: "us",
        override: null,
        sweden_available: true,
      };
    });

    const [first, second] = await Promise.all([
      mod.__executorHealthTestApi.getCachedExecutorRegionStatus({ loader }),
      mod.__executorHealthTestApi.getCachedExecutorRegionStatus({ loader }),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);

    const cached = await mod.__executorHealthTestApi.getCachedExecutorRegionStatus({
      loader: vi.fn(async () => ({
        active_region: "sweden",
        override: "manual",
        sweden_available: true,
      })),
    });

    expect(cached).toEqual(first);
  });
});