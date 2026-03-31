import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SettingsScreen from "../../ui/tui/SettingsScreen.js";
import { ORDERED_FIELDS } from "../../ui/tui/SettingsScreen.js";
import { renderInk } from "./render-ink.mjs";

// Snapshot the env once at module load time so mutations in any test don't leak.
const originalEnv = { ...process.env };
let configDirs = [];

function findFieldIndex(path) {
  const index = ORDERED_FIELDS.findIndex((field) => field.path === path);
  if (index === -1) {
    throw new Error(`Field not found in ORDERED_FIELDS: ${path}`);
  }
  return index;
}

function makeConfigDir(config) {
  const dir = mkdtempSync(join(tmpdir(), "bosun-settings-"));
  writeFileSync(join(dir, "bosun.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  configDirs.push(dir);
  return dir;
}

describe("tui settings screen", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.KANBAN_BACKEND;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    for (const dir of configDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    configDirs = [];
  });

  it("renders grouped schema fields and masks secrets by default", async () => {
    // cloudflareApiToken is in ENV_PATHS mapped to CLOUDFLARE_API_TOKEN
    process.env.CLOUDFLARE_API_TOKEN = "env-secret-token";

    const configDir = makeConfigDir({
      projectName: "demo",
      kanban: { backend: "github" },
    });

    const view = await renderInk(
      React.createElement(SettingsScreen, { configDir, config: {} }),
      { columns: 220, waitMs: 120 },
    );

    const text = view.text();
    expect(text).toContain("General");
    expect(text).toContain("Kanban");
    expect(text).toContain("Integrations");
    expect(text).toContain("kanban.backend");
    expect(text).toContain("cloudflareApiToken");
    expect(text).toContain("from env");
    expect(text).toContain("****");
    expect(text).not.toContain("env-secret-token");

    await view.unmount();
  });

  it("writes enum changes to bosun.config.json and emits reload", async () => {
    const configDir = makeConfigDir({ mode: "virtengine" });
    const emitReload = vi.fn();
    const targetIndex = findFieldIndex("mode");

    const view = await renderInk(
      React.createElement(SettingsScreen, { configDir, config: {}, onConfigReload: emitReload }),
      { columns: 220, waitMs: 120 },
    );

    for (let index = 0; index < targetIndex; index += 1) {
      await view.press("j", 40);
    }
    // Cycle the enum right: "virtengine" → "generic"
    await view.press("\u001b[C", 120);

    const updated = JSON.parse(readFileSync(join(configDir, "bosun.config.json"), "utf8"));
    expect(updated.mode).toBe("generic");
    expect(emitReload).toHaveBeenCalledTimes(1);
    expect(emitReload).toHaveBeenCalledWith(expect.objectContaining({
      configPath: join(configDir, "bosun.config.json"),
      reason: "settings-save",
    }));

    await view.unmount();
  });

  it("prevents invalid JSON saves and leaves file unchanged", async () => {
    const configDir = makeConfigDir({ projectName: "test" });
    const before = readFileSync(join(configDir, "bosun.config.json"), "utf8");
    const targetIndex = findFieldIndex("workflowDefaults.templateOverridesById");
    const view = await renderInk(
      React.createElement(SettingsScreen, { configDir, config: {} }),
      { columns: 220, waitMs: 120 },
    );

    for (let index = 0; index < targetIndex; index += 1) {
      await view.press("j", 40);
    }
    await view.press("\r", 60);
    // Type a raw unquoted string — not valid JSON for an object-type field
    await view.press("not-valid-json", 40);
    await view.press("\u0013", 120);

    expect(view.text()).toContain("Validation error");
    const after = readFileSync(join(configDir, "bosun.config.json"), "utf8");
    expect(after).toBe(before);

    await view.unmount();
  });
});
