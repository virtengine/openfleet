import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["BOSUN_OTEL_ENDPOINT"];

describe("infra/tracing sample rate", () => {
  let originalEnv = {};

  beforeEach(() => {
    vi.resetModules();
    originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    delete process.env.BOSUN_OTEL_ENDPOINT;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] == null) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    vi.restoreAllMocks();
  });

  it("clamps sample rate into the valid OTel range", async () => {
    const tracing = await import("../infra/tracing.mjs");

    const high = await tracing.setupTracing({ endpoint: "http://collector.example/v1/traces", sampleRate: 3 });
    expect(high.sampleRate).toBe(1);

    const low = await tracing.setupTracing({ endpoint: "http://collector.example/v1/traces", sampleRate: -5 });
    expect(low.sampleRate).toBe(0);
  });
});
