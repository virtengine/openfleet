import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ENV_KEYS = [
  "CLOUDFLARE_BASE_DOMAIN",
  "CF_BASE_DOMAIN",
  "CLOUDFLARE_TUNNEL_HOSTNAME",
  "CF_TUNNEL_HOSTNAME",
  "CLOUDFLARE_USERNAME_HOSTNAME_POLICY",
  "CLOUDFLARE_TUNNEL_USERNAME",
  "CLOUDFLARE_HOSTNAME_USER",
  "BOSUN_OPERATOR_ID",
  "USERNAME",
  "USER",
  "CLOUDFLARE_FIXED_HOST_LABEL",
  "CF_FIXED_HOST_LABEL",
];

let savedEnv;

function saveEnv() {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
}

function clearEnv() {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

let normalizeTunnelMode;
let sanitizeHostnameLabel;
let resolveDeterministicTunnelHostname;
let ensureCloudflareDnsCname;

beforeEach(async () => {
  saveEnv();
  clearEnv();
  vi.resetModules();
  const mod = await import("../server/tunnel-hostname.mjs");
  normalizeTunnelMode = mod.normalizeTunnelMode;
  sanitizeHostnameLabel = mod.sanitizeHostnameLabel;
  resolveDeterministicTunnelHostname = mod.resolveDeterministicTunnelHostname;
  ensureCloudflareDnsCname = mod.ensureCloudflareDnsCname;
});

afterEach(() => {
  restoreEnv();
  vi.restoreAllMocks();
});

describe("normalizeTunnelMode", () => {
  it("returns 'named' for empty string", () => {
    expect(normalizeTunnelMode("")).toBe("named");
  });

  it("returns 'named' for null", () => {
    expect(normalizeTunnelMode(null)).toBe("named");
  });

  it("returns 'named' for undefined", () => {
    expect(normalizeTunnelMode(undefined)).toBe("named");
  });

  describe("disabled values", () => {
    for (const value of ["disabled", "off", "false", "0"]) {
      it(`returns 'disabled' for "${value}"`, () => {
        expect(normalizeTunnelMode(value)).toBe("disabled");
      });
    }
  });

  describe("quick values", () => {
    for (const value of ["quick", "quick-tunnel", "ephemeral", "trycloudflare"]) {
      it(`returns 'quick' for "${value}"`, () => {
        expect(normalizeTunnelMode(value)).toBe("quick");
      });
    }
  });

  describe("named values", () => {
    for (const value of ["cloudflared", "auto", "named", "permanent"]) {
      it(`returns 'named' for "${value}"`, () => {
        expect(normalizeTunnelMode(value)).toBe("named");
      });
    }
  });

  it("returns 'named' for unknown values", () => {
    expect(normalizeTunnelMode("something-random")).toBe("named");
    expect(normalizeTunnelMode("foobar")).toBe("named");
  });

  it("is case-insensitive", () => {
    expect(normalizeTunnelMode("DISABLED")).toBe("disabled");
    expect(normalizeTunnelMode("Quick")).toBe("quick");
    expect(normalizeTunnelMode("NAMED")).toBe("named");
    expect(normalizeTunnelMode("TryCloudflare")).toBe("quick");
  });

  it("trims whitespace", () => {
    expect(normalizeTunnelMode("  disabled  ")).toBe("disabled");
    expect(normalizeTunnelMode("\tquick\n")).toBe("quick");
    expect(normalizeTunnelMode("  named  ")).toBe("named");
  });
});

describe("sanitizeHostnameLabel", () => {
  it("returns sanitized lowercase label", () => {
    expect(sanitizeHostnameLabel("MyHost")).toBe("myhost");
    expect(sanitizeHostnameLabel("hello-world")).toBe("hello-world");
  });

  it("replaces non-alphanumeric chars with hyphens", () => {
    expect(sanitizeHostnameLabel("hello world")).toBe("hello-world");
    expect(sanitizeHostnameLabel("test@host!")).toBe("test-host");
  });

  it("collapses multiple hyphens", () => {
    expect(sanitizeHostnameLabel("a---b")).toBe("a-b");
    expect(sanitizeHostnameLabel("foo--bar--baz")).toBe("foo-bar-baz");
  });

  it("strips leading and trailing hyphens", () => {
    expect(sanitizeHostnameLabel("-hello-")).toBe("hello");
    expect(sanitizeHostnameLabel("---abc---")).toBe("abc");
  });

  it("returns fallback for empty input", () => {
    expect(sanitizeHostnameLabel("")).toBe("operator");
    expect(sanitizeHostnameLabel("", "custom")).toBe("custom");
  });

  it("returns fallback for null input", () => {
    expect(sanitizeHostnameLabel(null)).toBe("operator");
    expect(sanitizeHostnameLabel(null, "fallback-val")).toBe("fallback-val");
  });

  it("uses 'operator' as default fallback", () => {
    expect(sanitizeHostnameLabel("")).toBe("operator");
    expect(sanitizeHostnameLabel(undefined)).toBe("operator");
  });

  it("truncates to 63 characters max", () => {
    const long = "a".repeat(100);
    const result = sanitizeHostnameLabel(long);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result).toBe("a".repeat(63));
  });

  it("strips trailing hyphens after truncation", () => {
    // 62 'a' + '-' at position 63 + more text => truncated to 63, trailing hyphen stripped
    const label = "a".repeat(62) + "-bbb";
    const result = sanitizeHostnameLabel(label);
    expect(result.length).toBeLessThanOrEqual(63);
    expect(result).not.toMatch(/-$/);
  });

  it("handles underscores and dots", () => {
    expect(sanitizeHostnameLabel("my_host.name")).toBe("my-host-name");
    expect(sanitizeHostnameLabel("a.b_c")).toBe("a-b-c");
  });
});

describe("resolveDeterministicTunnelHostname", () => {
  it("returns explicit hostname when provided", () => {
    const result = resolveDeterministicTunnelHostname({
      explicitHostname: "my-tunnel.example.com",
    });
    expect(result.hostname).toBe("my-tunnel.example.com");
    expect(result.policy).toBe("explicit");
    expect(result.source).toBe("explicit");
    expect(result.label).toBe("my-tunnel");
    expect(result.baseDomain).toBe("example.com");
  });

  it("throws when no baseDomain and no explicit hostname", () => {
    expect(() => resolveDeterministicTunnelHostname({})).toThrow(
      /Missing CLOUDFLARE_BASE_DOMAIN/,
    );
  });

  it("returns fixed hostname when policy is 'fixed'", () => {
    const result = resolveDeterministicTunnelHostname({
      baseDomain: "example.com",
      policy: "fixed",
      username: "testuser",
    });
    expect(result.hostname).toBe("bosun.example.com");
    expect(result.policy).toBe("fixed");
    expect(result.source).toBe("fixed");
    expect(result.label).toBe("bosun");
  });

  it("returns per-user-fixed hostname with map storage", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bosun-test-tunnel-"));
    try {
      const result = resolveDeterministicTunnelHostname({
        baseDomain: "example.com",
        username: "alice",
        configDir: tempDir,
      });
      expect(result.hostname).toBe("alice.example.com");
      expect(result.policy).toBe("per-user-fixed");
      expect(result.source).toBe("map");
      expect(result.label).toBe("alice");
      expect(result.identity).toBe("alice");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns same hostname across module reloads for same identity", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bosun-test-tunnel-"));
    try {
      const result1 = resolveDeterministicTunnelHostname({
        baseDomain: "example.com",
        username: "bob",
        configDir: tempDir,
      });
      // Re-import to clear in-memory cache
      vi.resetModules();
      const mod2 = await import("../server/tunnel-hostname.mjs");
      const result2 = mod2.resolveDeterministicTunnelHostname({
        baseDomain: "example.com",
        username: "bob",
        configDir: tempDir,
      });
      expect(result1.hostname).toBe(result2.hostname);
      expect(result1.label).toBe(result2.label);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles reserved hostname labels by appending suffix", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "bosun-test-tunnel-"));
    try {
      const result = resolveDeterministicTunnelHostname({
        baseDomain: "example.com",
        username: "admin",
        configDir: tempDir,
      });
      // "admin" is reserved, so it should become "admin-user"
      expect(result.label).toBe("admin-user");
      expect(result.hostname).toBe("admin-user.example.com");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles reserved labels in fixed mode by appending suffix", () => {
    process.env.CLOUDFLARE_FIXED_HOST_LABEL = "www";
    const result = resolveDeterministicTunnelHostname({
      baseDomain: "example.com",
      policy: "fixed",
      username: "testuser",
    });
    expect(result.label).toBe("www-app");
    expect(result.hostname).toBe("www-app.example.com");
  });

  describe("env var fallbacks", () => {
    it("uses CLOUDFLARE_BASE_DOMAIN env var", () => {
      process.env.CLOUDFLARE_BASE_DOMAIN = "envbase.com";
      const tempDir = mkdtempSync(join(tmpdir(), "bosun-test-tunnel-"));
      try {
        const result = resolveDeterministicTunnelHostname({
          username: "user1",
          configDir: tempDir,
        });
        expect(result.baseDomain).toBe("envbase.com");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("uses CF_BASE_DOMAIN as fallback", () => {
      process.env.CF_BASE_DOMAIN = "cfbase.com";
      const tempDir = mkdtempSync(join(tmpdir(), "bosun-test-tunnel-"));
      try {
        const result = resolveDeterministicTunnelHostname({
          username: "user1",
          configDir: tempDir,
        });
        expect(result.baseDomain).toBe("cfbase.com");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("uses CLOUDFLARE_TUNNEL_HOSTNAME env var for explicit", () => {
      process.env.CLOUDFLARE_TUNNEL_HOSTNAME = "from-env.example.com";
      const result = resolveDeterministicTunnelHostname({});
      expect(result.hostname).toBe("from-env.example.com");
      expect(result.policy).toBe("explicit");
    });

    it("uses CF_TUNNEL_HOSTNAME as fallback for explicit", () => {
      process.env.CF_TUNNEL_HOSTNAME = "cf-env.example.com";
      const result = resolveDeterministicTunnelHostname({});
      expect(result.hostname).toBe("cf-env.example.com");
      expect(result.policy).toBe("explicit");
    });

    it("uses CLOUDFLARE_FIXED_HOST_LABEL for fixed label", () => {
      process.env.CLOUDFLARE_FIXED_HOST_LABEL = "my-app";
      const result = resolveDeterministicTunnelHostname({
        baseDomain: "example.com",
        policy: "fixed",
        username: "testuser",
      });
      expect(result.label).toBe("my-app");
      expect(result.hostname).toBe("my-app.example.com");
    });

    it("uses CF_FIXED_HOST_LABEL as fallback for fixed label", () => {
      process.env.CF_FIXED_HOST_LABEL = "my-cf-app";
      const result = resolveDeterministicTunnelHostname({
        baseDomain: "example.com",
        policy: "fixed",
        username: "testuser",
      });
      expect(result.label).toBe("my-cf-app");
      expect(result.hostname).toBe("my-cf-app.example.com");
    });
  });
});

describe("ensureCloudflareDnsCname", () => {
  it("returns disabled result when api.enabled is false", async () => {
    const result = await ensureCloudflareDnsCname({
      hostname: "test.example.com",
      target: "tunnel.example.com",
      api: { enabled: false, token: "tok", zoneId: "zone1" },
    });
    expect(result).toEqual({ ok: true, changed: false, action: "disabled" });
  });

  it("returns missing_credentials when token is empty", async () => {
    const result = await ensureCloudflareDnsCname({
      hostname: "test.example.com",
      target: "tunnel.example.com",
      api: { enabled: true, token: "", zoneId: "zone1" },
    });
    expect(result).toEqual({ ok: false, changed: false, action: "missing_credentials" });
  });

  it("returns missing_credentials when zoneId is empty", async () => {
    const result = await ensureCloudflareDnsCname({
      hostname: "test.example.com",
      target: "tunnel.example.com",
      api: { enabled: true, token: "tok", zoneId: "" },
    });
    expect(result).toEqual({ ok: false, changed: false, action: "missing_credentials" });
  });

  it("throws when hostname is missing", async () => {
    await expect(
      ensureCloudflareDnsCname({
        hostname: "",
        target: "tunnel.example.com",
        api: { enabled: true, token: "tok", zoneId: "zone1" },
      }),
    ).rejects.toThrow(/Missing hostname\/target/);
  });

  it("throws when target is missing", async () => {
    await expect(
      ensureCloudflareDnsCname({
        hostname: "test.example.com",
        target: "",
        api: { enabled: true, token: "tok", zoneId: "zone1" },
      }),
    ).rejects.toThrow(/Missing hostname\/target/);
  });
});
