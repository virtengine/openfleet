import { describe, it, expect, vi } from "vitest";

/**
 * Tests for Telegram inline keyboard button support added to telegram-bot.mjs.
 * These tests verify the button infrastructure without requiring a live Telegram connection.
 */

describe("telegram-bot inline keyboards", () => {
  describe("reply_markup support in sendDirect", () => {
    it("sendDirect should accept reply_markup in options", async () => {
      // Verify the module exports exist and the COMMANDS structure includes help
      // We can't easily test sendDirect without mocking fetch, but we can verify
      // the command structure supports buttons
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram-bot.mjs"),
        "utf8",
      );

      // Verify reply_markup is passed through in sendDirect
      expect(botSource).toContain("reply_markup");
      // Verify inline_keyboard structure exists
      expect(botSource).toContain("inline_keyboard");
      // Verify callback_query handling exists
      expect(botSource).toContain("callback_query");
      // Verify answerCallbackQuery function exists
      expect(botSource).toContain("answerCallbackQuery");
      // Verify handleCallbackQuery function exists
      expect(botSource).toContain("handleCallbackQuery");
    });
  });

  describe("COMMANDS structure", () => {
    it("should include /whatsapp and /container commands", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram-bot.mjs"),
        "utf8",
      );

      // Verify /whatsapp command is registered
      expect(botSource).toContain('"/whatsapp"');
      expect(botSource).toContain("cmdWhatsApp");

      // Verify /container command is registered
      expect(botSource).toContain('"/container"');
      expect(botSource).toContain("cmdContainer");
    });
  });

  describe("FAST_COMMANDS includes new commands", () => {
    it("should include /whatsapp and /container in FAST_COMMANDS", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram-bot.mjs"),
        "utf8",
      );

      // Extract FAST_COMMANDS set definition
      const fastMatch = botSource.match(
        /const FAST_COMMANDS = new Set\(\[([\s\S]*?)\]\)/,
      );
      expect(fastMatch).toBeTruthy();
      const fastContent = fastMatch[1];
      expect(fastContent).toContain("/whatsapp");
      expect(fastContent).toContain("/container");
    });
  });

  describe("callback query allowed_updates", () => {
    it("should include callback_query in allowed_updates", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram-bot.mjs"),
        "utf8",
      );

      // The allowed_updates array should include callback_query
      const updatesMatch = botSource.match(/allowed_updates.*?\[([^\]]+)\]/);
      expect(updatesMatch).toBeTruthy();
      expect(updatesMatch[1]).toContain("callback_query");
    });
  });

  describe("/helpfull command", () => {
    it("should have a /helpfull command registered", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { fileURLToPath } = await import("node:url");

      const __dirname = path.resolve(
        fileURLToPath(new URL(".", import.meta.url)),
      );
      const botSource = fs.readFileSync(
        path.resolve(__dirname, "..", "telegram-bot.mjs"),
        "utf8",
      );

      expect(botSource).toContain('"/helpfull"');
      expect(botSource).toContain("cmdHelpFull");
    });
  });
});
