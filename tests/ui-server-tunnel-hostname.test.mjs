import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ui-server tunnel hostname + DNS helpers", () => {
  const ENV_KEYS = [
    "BOSUN_CONFIG_PATH",
    "CLOUDFLARE_BASE_DOMAIN",
    "CLOUDFLARE_TUNNEL_HOSTNAME",
    "CLOUDFLARE_USERNAME_HOSTNAME_POLICY",
  ];
  let envSnapshot = {};
  let tempDir = "";

  beforeEach(() => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    tempDir = mkdtempSync(join(tmpdir(), "bosun-hostname-map-"));
    process.env.BOSUN_CONFIG_PATH = join(tempDir, "bosun.config.json");
    delete process.env.CLOUDFLARE_TUNNEL_HOSTNAME;
    process.env.CLOUDFLARE_BASE_DOMAIN = "bosun.det.io";
    process.env.CLOUDFLARE_USERNAME_HOSTNAME_POLICY = "per-user-fixed";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("normalizes tunnel mode aliases with named as the default", async () => {
    const mod = await import("../ui-server.mjs");
    expect(mod.normalizeTunnelMode()).toBe("named");
    expect(mod.normalizeTunnelMode("auto")).toBe("named");
    expect(mod.normalizeTunnelMode("cloudflared")).toBe("named");
    expect(mod.normalizeTunnelMode("quick")).toBe("quick");
    expect(mod.normalizeTunnelMode("disabled")).toBe("disabled");
  });

  it("resolves deterministic per-user hostname and protects reserved names", async () => {
    const mod = await import("../ui-server.mjs");
    const first = mod.resolveDeterministicTunnelHostname({
      baseDomain: "bosun.det.io",
      username: "jon",
      policy: "per-user-fixed",
    });
    const second = mod.resolveDeterministicTunnelHostname({
      baseDomain: "bosun.det.io",
      username: "jon",
      policy: "per-user-fixed",
    });
    expect(first.hostname).toBe("jon.bosun.det.io");
    expect(second.hostname).toBe("jon.bosun.det.io");

    const reserved = mod.resolveDeterministicTunnelHostname({
      baseDomain: "bosun.det.io",
      username: "admin",
      policy: "per-user-fixed",
    });
    expect(reserved.hostname).not.toBe("admin.bosun.det.io");
    expect(reserved.hostname.endsWith(".bosun.det.io")).toBe(true);
  });

  it("keeps Cloudflare DNS orchestration idempotent for existing matching CNAME", async () => {
    const mod = await import("../ui-server.mjs");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          result: [
            {
              id: "rec-1",
              type: "CNAME",
              name: "jon.bosun.det.io",
              content: "abc.cfargotunnel.com",
              proxied: true,
            },
          ],
        }),
      });

    vi.stubGlobal("fetch", fetchMock);
    const result = await mod.ensureCloudflareDnsCname({
      hostname: "jon.bosun.det.io",
      target: "abc.cfargotunnel.com",
      proxied: true,
      api: {
        enabled: true,
        token: "token",
        zoneId: "zone",
        baseUrl: "https://api.cloudflare.com/client/v4",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.action).toBe("noop");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

