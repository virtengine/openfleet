import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import SettingsScreen from "../../ui/tui/SettingsScreen.js";
import { renderInk } from "./render-ink.mjs";

function makeConfigDir(config) {
  const dir = mkdtempSync(join(tmpdir(), "bosun-settings-"));
  writeFileSync(join(dir, "bosun.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return dir;
}

describe("tui settings screen", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.KANBAN_BACKEND;
    delete process.env.LINEAR_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("renders grouped schema fields and masks secrets by default", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "env-secret-token";

    const configDir = makeConfigDir({
      projectName: "demo",
      kanban: { backend: "github" },
      linear: { apiKey: "super-secret" },
      telegramBotToken: "local-secret",
      costRates: { inputPer1M: 1, outputPer1M: 2 },
    });

    const view = await renderInk(
      React.createElement(SettingsScreen, { configDir, config: {} }),
      { columns: 220, waitMs: 120 },
    );

    const text = view.text();
    expect(text).toContain("General");
    expect(text).toContain("Kanban");
    expect(text).toContain("Integrations");
    expect(text).toContain("Cost Rates");
    expect(text).toContain("linear.apiKey");
    expect(text).toContain("telegramBotToken");
    expect(text).toContain("from env");
    expect(text).toContain("****");
    expect(text).not.toContain("env-secret-token");

    await view.unmount();
  });

  it("writes enum changes to bosun.config.json and emits reload", async () => {
    const configDir = makeConfigDir({ kanban: { backend: "github" } });
    const emitReload = vi.fn();

    const view = await renderInk(
      React.createElement(SettingsScreen, { configDir, config: {}, onConfigReload: emitReload }),
      { columns: 220, waitMs: 120 },
    );

    for (let index = 0; index < 120 && !view.text().includes("> kanban.backend"); index += 1) {
      await view.press("j", 5);
    }
    await view.press("\u001b[C", 120);

    const updated = JSON.parse(readFileSync(join(configDir, "bosun.config.json"), "utf8"));
    expect(updated.kanban.backend).not.toBe("github");
    expect(emitReload).toHaveBeenCalledTimes(1);
    expect(emitReload).toHaveBeenCalledWith(expect.objectContaining({
      configPath: join(configDir, "bosun.config.json"),
      reason: "settings-save",
    }));

    await view.unmount();
  });

  it("prevents invalid numeric saves and leaves file unchanged", async () => {
    const configDir = makeConfigDir({ cloudflareDnsMaxRetries: 3 });
    const before = readFileSync(join(configDir, "bosun.config.json"), "utf8");
    const view = await renderInk(
      React.createElement(SettingsScreen, { configDir, config: {} }),
      { columns: 220, waitMs: 120 },
    );

    for (let index = 0; index < 220 && !view.text().includes("> cloudflareDnsMaxRetries"); index += 1) {
      await view.press("j", 5);
    }
    await view.press("\r", 60);
    await view.press("abc", 20);
    await view.press("\u0013", 120);

    expect(view.text()).toContain("Validation error");
    const after = readFileSync(join(configDir, "bosun.config.json"), "utf8");
    expect(after).toBe(before);

    await view.unmount();
  });
});
