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
      const token = gateway.generateToken("wf-1");
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates unique tokens", () => {
      const t1 = gateway.generateToken("wf-1");
      const t2 = gateway.generateToken("wf-2");
      expect(t1).not.toBe(t2);
    });

    it("validates a correct token", () => {
      const token = gateway.generateToken("wf-1");
      expect(gateway.validateToken("wf-1", token)).toBe(true);
    });

    it("rejects an incorrect token", () => {
      gateway.generateToken("wf-1");
      expect(gateway.validateToken("wf-1", "wrong-token")).toBe(false);
    });

    it("rejects token for unknown workflow", () => {
      expect(gateway.validateToken("unknown", "any-token")).toBe(false);
    });

    it("revokes token", () => {
      const token = gateway.generateToken("wf-1");
      expect(gateway.revokeToken("wf-1")).toBe(true);
      expect(gateway.validateToken("wf-1", token)).toBe(false);
    });

    it("revoke returns false for unknown workflow", () => {
      expect(gateway.revokeToken("unknown")).toBe(false);
    });
  });

  describe("token rotation", () => {
    it("returns a new token", () => {
      const oldToken = gateway.generateToken("wf-1");
      const newToken = gateway.rotateToken("wf-1");
      expect(newToken).not.toBe(oldToken);
      expect(newToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it("old token is invalid after rotation", () => {
      const oldToken = gateway.generateToken("wf-1");
      gateway.rotateToken("wf-1");
      expect(gateway.validateToken("wf-1", oldToken)).toBe(false);
    });

    it("new token validates after rotation", () => {
      gateway.generateToken("wf-1");
      const newToken = gateway.rotateToken("wf-1");
      expect(gateway.validateToken("wf-1", newToken)).toBe(true);
    });
  });

  describe("activation state", () => {
    it("new tokens are active by default", () => {
      gateway.generateToken("wf-1");
      expect(gateway.isActive("wf-1")).toBe(true);
    });

    it("deactivate prevents validation", () => {
      const token = gateway.generateToken("wf-1");
      gateway.deactivate("wf-1");
      expect(gateway.isActive("wf-1")).toBe(false);
      expect(gateway.validateToken("wf-1", token)).toBe(false);
    });

    it("reactivate restores validation", () => {
      const token = gateway.generateToken("wf-1");
      gateway.deactivate("wf-1");
      gateway.activate("wf-1");
      expect(gateway.isActive("wf-1")).toBe(true);
      expect(gateway.validateToken("wf-1", token)).toBe(true);
    });

    it("getWebhookInfo returns null for unknown", () => {
      expect(gateway.getWebhookInfo("unknown")).toBe(null);
    });

    it("getWebhookInfo returns entry details", () => {
      const token = gateway.generateToken("wf-1");
      const info = gateway.getWebhookInfo("wf-1");
      expect(info.active).toBe(true);
      expect(info.token).toBe(token);
      expect(info.createdAt).toBeTruthy();
    });
  });

  describe("rate limiting", () => {
    it("allows requests within limit", () => {
      gateway.generateToken("wf-1");
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
    });

    it("reloads tokens on new gateway instance", () => {
      const token = gateway.generateToken("wf-1");
      const gw2 = new WebhookGateway({ configDir: tmpDir });
      expect(gw2.validateToken("wf-1", token)).toBe(true);
    });

    it("revoke is persisted", () => {
      const token = gateway.generateToken("wf-1");
      gateway.revokeToken("wf-1");
      const gw2 = new WebhookGateway({ configDir: tmpDir });
      expect(gw2.validateToken("wf-1", token)).toBe(false);
    });
  });
});
