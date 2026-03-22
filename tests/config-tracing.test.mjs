import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadConfig } from "../config/config.mjs";

const ENV_KEYS = ["BOSUN_OTEL_ENDPOINT"];

describe("loadConfig tracing configuration", () => {
  let tempConfigDir = "";
  let originalEnv = {};

  beforeEach(async () => {
    tempConfigDir = await mkdtemp(resolve(tmpdir(), "bosun-tracing-config-"));
    originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    delete process.env.BOSUN_OTEL_ENDPOINT;
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await rm(tempConfigDir, { recursive: true, force: true });
  });

  it("loads tracing config from bosun.config.json", async () => {
    await writeFile(
      resolve(tempConfigDir, "bosun.config.json"),
      JSON.stringify({ tracing: { enabled: true, endpoint: "http://localhost:4318/v1/traces", sampleRate: 0.5 } }),
      "utf8",
    );

    const config = loadConfig(["node", "bosun", "--config-dir", tempConfigDir, "--repo-root", tempConfigDir]);

    expect(config.tracing).toEqual({
      enabled: true,
      endpoint: "http://localhost:4318/v1/traces",
      sampleRate: 0.5,
    });
  });

  it("lets BOSUN_OTEL_ENDPOINT enable tracing without file config", () => {
    process.env.BOSUN_OTEL_ENDPOINT = "http://env-collector:4318/v1/traces";

    const config = loadConfig(["node", "bosun", "--config-dir", tempConfigDir, "--repo-root", tempConfigDir]);

    expect(config.tracing).toEqual({
      enabled: true,
      endpoint: "http://env-collector:4318/v1/traces",
      sampleRate: 1,
    });
  });
});
