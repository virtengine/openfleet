import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { describe, expect, it } from "vitest";

import SettingsScreen from "../../ui/tui/SettingsScreen.js";
import { renderInk } from "./render-ink.mjs";

function makeConfigDir(config) {
  const dir = mkdtempSync(join(tmpdir(), "bosun-settings-"));
  writeFileSync(join(dir, "bosun.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return dir;
}

describe("tui settings screen", () => {
  it("renders grouped schema fields and masks secrets by default", async () => {
    const configDir = makeConfigDir({
      projectName: "demo",
      kanban: { backend: "github" },
      linear: { apiKey: "super-secret" },
      costRates: { inputPer1M: 1, outputPer1M: 2 },
    });

    const view = await renderInk(React.createElement(SettingsScreen, { configDir, config: {} }), { columns: 220, waitMs: 120 });

    expect(view.text()).toContain("General");
    expect(view.text()).toContain("Kanban");
    expect(view.text()).toContain("Integrations");
    expect(view.text()).toContain("Cost Rates");
    expect(view.text()).toContain("linear.apiKey");
    expect(view.text()).toContain("****");

    await view.unmount();
  });

  it("writes enum changes to bosun.config.json", async () => {
    const configDir = makeConfigDir({ kanban: { backend: "github" } });
    const view = await renderInk(React.createElement(SettingsScreen, { configDir, config: {} }), { columns: 220, waitMs: 120 });

    for (let index = 0; index < 120 && !view.text().includes("> kanban.backend"); index += 1) {
      await view.press("j", 5);
    }
    await view.press("\u001b[C", 120);

    const updated = JSON.parse(readFileSync(join(configDir, "bosun.config.json"), "utf8"));
    expect(updated.kanban.backend).toBe("linear");

    await view.unmount();
  });

  it("prevents invalid numeric saves and leaves file unchanged", async () => {
    const configDir = makeConfigDir({ cloudflareDnsMaxRetries: 3 });
    const before = readFileSync(join(configDir, "bosun.config.json"), "utf8");
    const view = await renderInk(React.createElement(SettingsScreen, { configDir, config: {} }), { columns: 220, waitMs: 120 });

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
