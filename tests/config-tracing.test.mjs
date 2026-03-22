import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadConfig } from "../config/config.mjs";

describe("loadConfig tracing", () => {
  let rootDir;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = null;
    }
  });

  it("loads tracing config from bosun.config.json", () => {
    rootDir = mkdtempSync(join(tmpdir(), "bosun-tracing-config-"));
    writeFileSync(
      join(rootDir, "bosun.config.json"),
      JSON.stringify({
        tracing: {
          enabled: true,
          endpoint: "http://localhost:4318/v1/traces",
          sampleRate: 0.5,
        },
      }),
    );

    const config = loadConfig(["node", "bosun", "--config-dir", rootDir]);
    expect(config.tracing.enabled).toBe(true);
    expect(config.tracing.endpoint).toBe("http://localhost:4318/v1/traces");
    expect(config.tracing.sampleRate).toBe(0.5);
  });

  it("lets BOSUN_OTEL_ENDPOINT override file config", () => {
    rootDir = mkdtempSync(join(tmpdir(), "bosun-tracing-config-"));
    writeFileSync(
      join(rootDir, "bosun.config.json"),
      JSON.stringify({ tracing: { enabled: false, endpoint: "http://file-endpoint" } }),
    );
    vi.stubEnv("BOSUN_OTEL_ENDPOINT", "http://env-endpoint");

    const config = loadConfig(["node", "bosun", "--config-dir", rootDir]);
    expect(config.tracing.enabled).toBe(true);
    expect(config.tracing.endpoint).toBe("http://env-endpoint");
  });
  it("reads BOSUN_OTEL_SAMPLE_RATE and clamps invalid values", () => {
    rootDir = mkdtempSync(join(tmpdir(), "bosun-tracing-config-"));
    writeFileSync(join(rootDir, "bosun.config.json"), JSON.stringify({ tracing: { enabled: true, endpoint: "http://localhost:4318/v1/traces", sampleRate: 0.25 } }));
    vi.stubEnv("BOSUN_OTEL_SAMPLE_RATE", "5");
    const config = loadConfig(["node", "bosun", "--config-dir", rootDir]);
    expect(config.tracing.sampleRate).toBe(1);
  });
});

