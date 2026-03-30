/**
 * tests/vault.test.mjs — VaultStore + VaultKeychain unit tests
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeKey() {
  return randomBytes(32);
}

// ─── VaultStore tests ─────────────────────────────────────────────────────────

describe("VaultStore", async () => {
  // We need to override the vault path to a temp dir per test
  // The module uses homedir() for the path, so we monkeypatch via vi.mock
  let tmpDir;
  let VaultStore;
  let VAULT_PATH;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "bosun-vault-test-"));
    // Re-import with mocked homedir
    vi.resetModules();
    vi.doMock("node:os", () => ({
      homedir: () => tmpDir,
    }));
    const mod = await import("../lib/vault.mjs");
    VaultStore = mod.VaultStore;
    VAULT_PATH = mod.VAULT_PATH;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("isInitialized returns false before init", () => {
    const v = new VaultStore();
    expect(v.isInitialized()).toBe(false);
  });

  it("isUnlocked returns false before open", () => {
    const v = new VaultStore();
    const key = makeKey();
    v.init(key);
    const v2 = new VaultStore();
    expect(v2.isUnlocked()).toBe(false);
  });

  it("init creates vault file", () => {
    const v = new VaultStore();
    const key = makeKey();
    v.init(key);
    expect(existsSync(VAULT_PATH)).toBe(true);
  });

  it("init + open round-trips", () => {
    const key = makeKey();
    const v1 = new VaultStore();
    v1.init(key);

    const v2 = new VaultStore();
    v2.open(key);
    expect(v2.isUnlocked()).toBe(true);
  });

  it("open with wrong key throws", () => {
    const key = makeKey();
    const wrong = makeKey();
    const v1 = new VaultStore();
    v1.init(key);

    const v2 = new VaultStore();
    expect(() => v2.open(wrong)).toThrow();
  });

  it("init twice throws", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    expect(() => new VaultStore().init(key)).toThrow("already initialized");
  });

  it("seal clears unlock state", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    expect(v.isUnlocked()).toBe(true);
    v.seal();
    expect(v.isUnlocked()).toBe(false);
  });

  it("operations on locked vault throw", () => {
    const v = new VaultStore();
    expect(() => v.listSecrets()).toThrow("locked");
  });

  it("createSecret returns uuid and persists", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);

    const id = v.createSecret({
      name: "My GitHub Token",
      integration: "github",
      fields: { token: "ghp_test123" },
    });

    expect(typeof id).toBe("string");
    expect(id).toHaveLength(36);

    // Re-open to verify persistence
    const v2 = new VaultStore();
    v2.open(key);
    const list = v2.listSecrets();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("My GitHub Token");
  });

  it("listSecrets does not include field values", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    v.createSecret({ name: "Token", integration: "github", fields: { token: "secret123" } });
    const list = v.listSecrets();
    expect(list[0]).not.toHaveProperty("fields");
  });

  it("getSecret includes field values", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    const id = v.createSecret({ name: "Token", integration: "github", fields: { token: "ghp_abc" } });
    const s = v.getSecret(id);
    expect(s.fields.token).toBe("ghp_abc");
  });

  it("updateSecret merges fields", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    const id = v.createSecret({ name: "Token", integration: "github", fields: { token: "old" } });
    v.updateSecret(id, { fields: { token: "new", extra: "val" } });
    const s = v.getSecret(id);
    expect(s.fields.token).toBe("new");
    expect(s.fields.extra).toBe("val");
  });

  it("deleteSecret removes secret", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    const id = v.createSecret({ name: "X", integration: "custom", fields: {} });
    v.deleteSecret(id);
    expect(v.listSecrets()).toHaveLength(0);
  });

  it("deleteSecret throws for unknown id", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    expect(() => v.deleteSecret("nonexistent")).toThrow("not found");
  });

  it("setPermissions updates permissions", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    const id = v.createSecret({ name: "T", integration: "github", fields: {} });
    v.setPermissions(id, { agents: ["agent-1"], workflows: ["*"], deny: [] });
    const s = v.getSecret(id);
    expect(s.permissions.agents).toEqual(["agent-1"]);
  });

  it("canAgentAccess respects wildcard allow", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    const id = v.createSecret({ name: "T", integration: "github", fields: {} });
    expect(v.canAgentAccess(id, "any-agent")).toBe(true);
  });

  it("canAgentAccess respects explicit allowlist", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    const id = v.createSecret({ name: "T", integration: "github", fields: {} });
    v.setPermissions(id, { agents: ["agent-a"], workflows: ["*"], deny: [] });
    expect(v.canAgentAccess(id, "agent-a")).toBe(true);
    expect(v.canAgentAccess(id, "agent-b")).toBe(false);
  });

  it("canAgentAccess respects deny list", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    const id = v.createSecret({ name: "T", integration: "github", fields: {} });
    v.setPermissions(id, { agents: ["*"], workflows: ["*"], deny: ["bad-agent"] });
    expect(v.canAgentAccess(id, "bad-agent")).toBe(false);
    expect(v.canAgentAccess(id, "good-agent")).toBe(true);
  });

  it("setEnv / getEnv / deleteEnv round-trips", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    v.setEnv("MY_KEY", "my-value");
    expect(v.getEnv("MY_KEY")).toBe("my-value");
    v.deleteEnv("MY_KEY");
    expect(v.getEnv("MY_KEY")).toBeUndefined();
  });

  it("listEnvKeys returns keys", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    v.setEnv("A", "1");
    v.setEnv("B", "2");
    const keys = v.listEnvKeys();
    expect(keys).toContain("A");
    expect(keys).toContain("B");
  });

  it("resolveEnv skips keys in baseEnv", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    v.setEnv("EXISTING", "vault-val");
    v.setEnv("NEW_KEY", "new-val");
    const result = v.resolveEnv({ EXISTING: "env-val" });
    expect(result).not.toHaveProperty("EXISTING");
    expect(result.NEW_KEY).toBe("new-val");
  });

  it("status returns correct counts", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key);
    v.createSecret({ name: "T", integration: "github", fields: {} });
    v.setEnv("FOO", "bar");
    const s = v.status();
    expect(s.initialized).toBe(true);
    expect(s.unlocked).toBe(true);
    expect(s.secretCount).toBe(1);
    expect(s.envCount).toBe(1);
  });

  it("validateKey accepts hex string", () => {
    const key = makeKey();
    const v = new VaultStore();
    v.init(key.toString("hex")); // hex string
    const v2 = new VaultStore();
    v2.open(key);
    expect(v2.isUnlocked()).toBe(true);
  });

  it("validateKey rejects wrong length", () => {
    const v = new VaultStore();
    expect(() => v.init(Buffer.from("tooshort"))).toThrow("32-byte");
  });
});

// ─── integrations-registry tests ─────────────────────────────────────────────

describe("integrations-registry", async () => {
  it("exports INTEGRATIONS array with expected ids", async () => {
    const { INTEGRATIONS, getIntegration, getIntegrationIds } = await import("../lib/integrations-registry.mjs");
    expect(Array.isArray(INTEGRATIONS)).toBe(true);
    const ids = getIntegrationIds();
    expect(ids).toContain("github");
    expect(ids).toContain("telegram");
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("env");
    expect(ids).toContain("custom");
  });

  it("getIntegration returns correct definition", async () => {
    const { getIntegration } = await import("../lib/integrations-registry.mjs");
    const gh = getIntegration("github");
    expect(gh.name).toBe("GitHub");
    expect(gh.fields.length).toBeGreaterThan(0);
    expect(gh.fields.find(f => f.id === "token")).toBeTruthy();
  });

  it("getIntegration returns undefined for unknown id", async () => {
    const { getIntegration } = await import("../lib/integrations-registry.mjs");
    expect(getIntegration("nonexistent")).toBeUndefined();
  });
});
