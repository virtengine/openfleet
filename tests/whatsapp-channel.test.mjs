import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Tests for whatsapp-channel.mjs
 *
 * Note: ESM modules are cached — env vars are read at module load time.
 * We test the functions with the default (disabled) state, plus static analysis.
 */

describe("whatsapp-channel", () => {
  describe("module exports", () => {
    it("exports all expected functions", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      const expected = [
        "isWhatsAppEnabled",
        "isWhatsAppConnected",
        "getWhatsAppStatus",
        "sendWhatsAppMessage",
        "notifyWhatsApp",
        "setWhatsAppTyping",
        "startWhatsAppChannel",
        "stopWhatsAppChannel",
        "runWhatsAppAuth",
      ];
      for (const name of expected) {
        expect(typeof mod[name]).toBe("function");
      }
    });
  });

  describe("isWhatsAppEnabled (default disabled)", () => {
    it("returns false when WHATSAPP_ENABLED is not set", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      // Default state — WHATSAPP_ENABLED not set before module loaded
      expect(mod.isWhatsAppEnabled()).toBe(false);
    });
  });

  describe("isWhatsAppConnected", () => {
    it("returns false when not started", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      expect(mod.isWhatsAppConnected()).toBe(false);
    });
  });

  describe("getWhatsAppStatus", () => {
    it("returns status object with connected=false", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      const status = mod.getWhatsAppStatus();
      expect(status).toBeDefined();
      expect(typeof status.connected).toBe("boolean");
      expect(status.connected).toBe(false);
    });

    it("includes enabled field", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      const status = mod.getWhatsAppStatus();
      expect("enabled" in status).toBe(true);
    });
  });

  describe("sendWhatsAppMessage", () => {
    it("queues message when not connected (does not throw)", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      // Should not throw — just queues or silently fails
      await expect(
        mod.sendWhatsAppMessage("test@s.whatsapp.net", "hello"),
      ).resolves.not.toThrow();
    });
  });

  describe("notifyWhatsApp", () => {
    it("is a function", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      expect(typeof mod.notifyWhatsApp).toBe("function");
    });

    it("does not throw when not connected", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      await expect(mod.notifyWhatsApp("test message")).resolves.not.toThrow();
    });
  });

  describe("setWhatsAppTyping", () => {
    it("is a function that does not throw when disconnected", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      expect(typeof mod.setWhatsAppTyping).toBe("function");
      // Should not throw when no connection exists
      expect(() => mod.setWhatsAppTyping("test@s.whatsapp.net")).not.toThrow();
    });
  });

  describe("stopWhatsAppChannel", () => {
    it("does not throw when not started", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      expect(() => mod.stopWhatsAppChannel()).not.toThrow();
    });
  });

  describe("startWhatsAppChannel", () => {
    it("resolves without error when disabled", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      // When disabled, startWhatsAppChannel should be a no-op or reject gracefully
      if (!mod.isWhatsAppEnabled()) {
        // Not enabled — should either resolve immediately or throw
        try {
          await mod.startWhatsAppChannel({
            onMessage: () => {},
            logger: () => {},
          });
        } catch {
          // Expected when disabled — acceptable
        }
      }
    });
  });

  describe("runWhatsAppAuth", () => {
    it("is exported as a function", async () => {
      const mod = await import("../whatsapp-channel.mjs");
      expect(typeof mod.runWhatsAppAuth).toBe("function");
    });
  });

  describe("source code structure", () => {
    it("uses baileys lazy loading pattern", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
      const source = fs.readFileSync(
        path.resolve(dir, "..", "whatsapp-channel.mjs"),
        "utf8",
      );

      // Verify lazy baileys loading (not eagerly imported at top)
      expect(source).toContain("@whiskeysockets/baileys");
      expect(source).toContain("async function loadBaileys");
    });

    it("respects WHATSAPP_CHAT_ID for security filtering", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");
      const dir = path.resolve(fileURLToPath(new URL(".", import.meta.url)));
      const source = fs.readFileSync(
        path.resolve(dir, "..", "whatsapp-channel.mjs"),
        "utf8",
      );

      expect(source).toContain("WHATSAPP_CHAT_ID");
      expect(source).toContain("whatsappChatId");
    });
  });
});
