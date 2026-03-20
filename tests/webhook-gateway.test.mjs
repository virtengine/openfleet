import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebhookGateway } from "../workflow/webhook-gateway.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir;
let gateway;

function makeGateway(opts = {}) {
  tmpDir = mkdtempSync(join(tmpdir(), "wh-gw-test-"));
  gateway = new WebhookGateway({ configDir: tmpDir, ...opts });
  return gateway;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("WebhookGateway", () => {
  beforeEach(() => {
    makeGateway();
  });

  afterEach(() => {
    try {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("requires configDir", () => {
    expect(() => new WebhookGateway({})).toThrow(/configDir/);
  });

  describe("token management", () => {
    it("generates a 64-char hex token", () => {
      const { token } = gateway.generateToken("wf-1");
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates unique tokens", () => {
      const { token: t1 } = gateway.generateToken("wf-1");
      const { token: t2 } = gateway.generateToken("wf-2");
      expect(t1).not.toBe(t2);
    });

    it("validates a correct token", () => {
      const { token } = gateway.generateToken("wf-1");
      expect(gateway.validateToken("wf-1", token)).toBe(true);
    });

    it("rejects an incorrect token", () => {
      gateway.generateToken("wf-1");
      expect(gateway.validateToken("wf-1", "wrong-token")).toBe(false);
    });

    it("returns hmacSecret and expiresAt as null by default", () => {
      const result = gateway.generateToken("wf-1");
      expect(result.hmacSecret).toBeNull();
      expect(result.expiresAt).toBeNull();
    });

    it("rejects token for unknown workflow", () => {
      expect(gateway.validateToken("unknown", "any-token")).toBe(false);
    });

    it("revokes token", () => {
      const { token } = gateway.generateToken("wf-1");
      expect(gateway.revokeToken("wf-1")).toBe(true);
      expect(gateway.validateToken("wf-1", token)).toBe(false);
    });

    it("revoke returns false for unknown workflow", () => {
      expect(gateway.revokeToken("unknown")).toBe(false);
    });
  });

  describe("token rotation", () => {
    it("returns a new token", () => {
      const { token: oldToken } = gateway.generateToken("wf-1");
      const { token: newToken } = gateway.rotateToken("wf-1");
      expect(newToken).not.toBe(oldToken);
      expect(newToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it("old token is invalid after rotation", () => {
      const { token: oldToken } = gateway.generateToken("wf-1");
      gateway.rotateToken("wf-1");
      expect(gateway.validateToken("wf-1", oldToken)).toBe(false);
    });

    it("new token validates after rotation", () => {
      gateway.generateToken("wf-1");
      const { token: newToken } = gateway.rotateToken("wf-1");
      expect(gateway.validateToken("wf-1", newToken)).toBe(true);
    });
  });

  describe("activation state", () => {
    it("new tokens are active by default", () => {
      gateway.generateToken("wf-1");
      expect(gateway.isActive("wf-1")).toBe(true);
    });

    it("deactivate prevents validation", () => {
      const { token } = gateway.generateToken("wf-1");
      gateway.deactivate("wf-1");
      expect(gateway.isActive("wf-1")).toBe(false);
      expect(gateway.validateToken("wf-1", token)).toBe(false);
    });

    it("reactivate restores validation", () => {
      const { token } = gateway.generateToken("wf-1");
      gateway.deactivate("wf-1");
      gateway.activate("wf-1");
      expect(gateway.isActive("wf-1")).toBe(true);
      expect(gateway.validateToken("wf-1", token)).toBe(true);
    });

    it("getWebhookInfo returns null for unknown", () => {
      expect(gateway.getWebhookInfo("unknown")).toBe(null);
    });

    it("getWebhookInfo returns entry details", () => {
      const { token } = gateway.generateToken("wf-1");
      const info = gateway.getWebhookInfo("wf-1");
      expect(info.active).toBe(true);
      expect(info.token).toBe(token);
      expect(info.createdAt).toBeTruthy();
      expect(info).toHaveProperty("expiresAt");
      expect(info).toHaveProperty("expired");
      expect(info).toHaveProperty("hasHmac");
    });
  });

  describe("rate limiting", () => {
    it("allows requests within limit", () => {
      gateway.generateToken("wf-1"); // don't need destructured token here
      const result = gateway.checkRateLimit("wf-1");
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeGreaterThanOrEqual(0);
    });

    it("blocks after exceeding limit", () => {
      const gw = makeGateway({ rateLimit: 3 });
      gw.generateToken("wf-1");

      gw.checkRateLimit("wf-1"); // 1
      gw.checkRateLimit("wf-1"); // 2
      gw.checkRateLimit("wf-1"); // 3
      const blocked = gw.checkRateLimit("wf-1"); // 4 — over limit
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
    });

    it("per-workflow limit override works", () => {
      gateway.generateToken("wf-1");
      gateway.setRateLimit("wf-1", 2);

      gateway.checkRateLimit("wf-1"); // 1
      gateway.checkRateLimit("wf-1"); // 2
      const blocked = gateway.checkRateLimit("wf-1"); // 3 — over
      expect(blocked.allowed).toBe(false);
    });

    it("resetAt is in the future", () => {
      gateway.generateToken("wf-1");
      const result = gateway.checkRateLimit("wf-1");
      expect(result.resetAt).toBeGreaterThan(Date.now());
    });
  });

  describe("persistence", () => {
    it("persists tokens to disk", () => {
      gateway.generateToken("wf-1");
      const tokensPath = join(tmpDir, ".bosun", "webhook-tokens.json");
      expect(existsSync(tokensPath)).toBe(true);

      const data = JSON.parse(readFileSync(tokensPath, "utf8"));
      expect(data["wf-1"]).toBeTruthy();
      expect(data["wf-1"].token).toMatch(/^[0-9a-f]{64}$/);
      expect(data["wf-1"]).toHaveProperty("expiresAt");
      expect(data["wf-1"]).toHaveProperty("hmacSecret");
    });

    it("reloads tokens on new gateway instance", () => {
      const { token } = gateway.generateToken("wf-1");
      const gw2 = new WebhookGateway({ configDir: tmpDir });
      expect(gw2.validateToken("wf-1", token)).toBe(true);
    });

    it("revoke is persisted", () => {
      const { token } = gateway.generateToken("wf-1");
      gateway.revokeToken("wf-1");
      const gw2 = new WebhookGateway({ configDir: tmpDir });
      expect(gw2.validateToken("wf-1", token)).toBe(false);
    });
  });

  // ── Token expiry ────────────────────────────────────────────────────

  describe("token expiry", () => {
    it("generateToken with ttlMs sets expiresAt", () => {
      const { token, expiresAt } = gateway.generateToken("wf-1", { ttlMs: 60_000 });
      expect(expiresAt).toBeTruthy();
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(gateway.validateToken("wf-1", token)).toBe(true);
    });

    it("expired token fails validation", () => {
      const { token } = gateway.generateToken("wf-1", { ttlMs: 1 }); // 1ms TTL
      // Force expiry by waiting a tiny bit
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }
      expect(gateway.validateToken("wf-1", token)).toBe(false);
    });

    it("getWebhookInfo shows expired flag", () => {
      gateway.generateToken("wf-1", { ttlMs: 1 });
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }
      const info = gateway.getWebhookInfo("wf-1");
      expect(info.expired).toBe(true);
      expect(info.active).toBe(false);
    });
  });

  // ── HMAC signing ────────────────────────────────────────────────────

  describe("HMAC signing", () => {
    it("generates hmacSecret when enableHmac=true", () => {
      const { hmacSecret } = gateway.generateToken("wf-1", { enableHmac: true });
      expect(hmacSecret).toBeTruthy();
      expect(hmacSecret).toMatch(/^[0-9a-f]{64}$/);
    });

    it("signPayload returns null without HMAC", () => {
      gateway.generateToken("wf-1");
      expect(gateway.signPayload("wf-1", "test-body")).toBeNull();
    });

    it("signPayload returns hex signature with HMAC", () => {
      gateway.generateToken("wf-1", { enableHmac: true });
      const sig = gateway.signPayload("wf-1", "test-body");
      expect(sig).toBeTruthy();
      expect(sig).toMatch(/^[0-9a-f]+$/);
    });

    it("verifySignature validates correct signature", () => {
      gateway.generateToken("wf-1", { enableHmac: true });
      const sig = gateway.signPayload("wf-1", "payload-data");
      expect(gateway.verifySignature("wf-1", "payload-data", sig)).toBe(true);
    });

    it("verifySignature rejects incorrect signature", () => {
      gateway.generateToken("wf-1", { enableHmac: true });
      expect(gateway.verifySignature("wf-1", "payload-data", "deadbeef")).toBe(false);
    });

    it("verifySignature returns false for workflow without HMAC", () => {
      gateway.generateToken("wf-1");
      expect(gateway.verifySignature("wf-1", "body", "sig")).toBe(false);
    });
  });

  // ── Delivery log ────────────────────────────────────────────────────

  describe("delivery log", () => {
    it("starts with empty log", () => {
      expect(gateway.getDeliveryLog("wf-1")).toEqual([]);
    });

    it("records delivery events", () => {
      gateway.recordDelivery("wf-1", { status: 200, method: "POST", payload: '{"ok":true}', ip: "127.0.0.1" });
      const log = gateway.getDeliveryLog("wf-1");
      expect(log).toHaveLength(1);
      expect(log[0].status).toBe(200);
      expect(log[0].method).toBe("POST");
      expect(log[0].payloadHash).toBeTruthy();
      expect(log[0].ip).toBe("127.0.0.1");
      expect(log[0].timestamp).toBeTruthy();
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        gateway.recordDelivery("wf-1", { status: 200, method: "POST", payload: `body-${i}` });
      }
      expect(gateway.getDeliveryLog("wf-1", 3)).toHaveLength(3);
    });

    it("caps log at maxDeliveryLogSize", () => {
      const gw = makeGateway({ maxDeliveryLogSize: 15 });
      for (let i = 0; i < 30; i++) {
        gw.recordDelivery("wf-1", { status: 200, method: "POST", payload: `entry-${i}` });
      }
      expect(gw.getDeliveryLog("wf-1")).toHaveLength(15);
    });
  });

  // ── Payload transformation ──────────────────────────────────────────

  describe("transformPayload", () => {
    it("extracts top-level fields", () => {
      const result = WebhookGateway.transformPayload(
        { name: "Alice", age: 30 },
        { user: "name", years: "age" },
      );
      expect(result).toEqual({ user: "Alice", years: 30 });
    });

    it("extracts nested fields via dot path", () => {
      const result = WebhookGateway.transformPayload(
        { data: { inner: { value: 42 } } },
        { extracted: "data.inner.value" },
      );
      expect(result).toEqual({ extracted: 42 });
    });

    it("returns undefined for missing paths", () => {
      const result = WebhookGateway.transformPayload(
        { a: 1 },
        { missing: "x.y.z" },
      );
      expect(result.missing).toBeUndefined();
    });

    it("returns payload as-is when no fieldMap", () => {
      const payload = { a: 1 };
      expect(WebhookGateway.transformPayload(payload, null)).toBe(payload);
    });
  });
});
