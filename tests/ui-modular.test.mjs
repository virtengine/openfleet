import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const uiDir = resolve(process.cwd(), "ui");

describe("modular mini app structure", () => {
  const requiredModules = [
    "app.js",
    "modules/telegram.js",
    "modules/api.js",
    "modules/state.js",
    "modules/router.js",
    "modules/utils.js",
    "modules/icons.js",
    "components/shared.js",
    "components/charts.js",
    "components/forms.js",
    "tabs/dashboard.js",
    "tabs/tasks.js",
    "tabs/agents.js",
    "tabs/infra.js",
    "tabs/control.js",
    "tabs/logs.js",
    "tabs/settings.js",
    "styles.css",
    "styles/variables.css",
    "styles/base.css",
    "styles/layout.css",
    "styles/components.css",
    "styles/animations.css",
    "index.html",
  ];

  for (const file of requiredModules) {
    it(`${file} exists`, () => {
      expect(existsSync(resolve(uiDir, file))).toBe(true);
    });
  }
});
