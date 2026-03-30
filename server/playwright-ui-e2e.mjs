/**
 * Playwright E2E page tests — verifies every major tab/page loads without
 * runtime errors such as TDZ (temporal dead zone), ReferenceError, or
 * uncaught exceptions.
 *
 * The mock server (playwright-ui-server.mjs) preserves the real production
 * boot loader and import-map flow while removing unrelated third-party
 * resources that add network flake. The harness derives routes from
 * ui/modules/router.js so it tracks the actual portal surface.
 *
 * NOTE: Full visual rendering with MUI + Preact-compat doesn't work in
 * headless-Chromium + mock environment (ThemeProvider requires emotion
 * context wiring that the local vendor bundle doesn't fully support).
 * Instead we verify:
 *   1. All JS modules load without errors (catches TDZ, ReferenceError)
 *   2. No pageerror events fire
 *   3. No TabErrorBoundary console.error calls
 *   4. All critical static assets respond 200
 *   5. API endpoints respond correctly
 *
 * Usage:
 *   npx playwright test server/playwright-ui-e2e.mjs
 *   npm run test:e2e
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as playwrightTest from "@playwright/test";

const test = playwrightTest.test ?? playwrightTest.default?.test;
const expect = playwrightTest.expect ?? playwrightTest.default?.expect;

const ROUTER_SOURCE = readFileSync(resolve(process.cwd(), "ui/modules/router.js"), "utf8");

function extractTabRoutes(source) {
  const block = source.match(/export const TAB_CONFIG = \[([\s\S]*?)\n\];/);
  if (!block) {
    throw new Error("Could not locate TAB_CONFIG in ui/modules/router.js");
  }

  const ids = [...block[1].matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
  const routes = ids.map((id) => ({
    path: id === "dashboard" ? "/" : `/${id}`,
    label: id === "dashboard" ? "Dashboard" : id,
    expectedTab: id,
  }));

  if (ids.includes("dashboard")) {
    routes.unshift({ path: "/dashboard", label: "Dashboard alias", expectedTab: "dashboard" });
  }

  return routes;
}

function extractParameterizedRoutes(source) {
  const routes = [];

  if (/if \(tab === "tasks"\)/.test(source)) {
    routes.push({ path: "/tasks/task-test-001", label: "Task detail", expectedTab: "tasks" });
  }
  if (/if \(tab === "chat"\)/.test(source)) {
    routes.push({ path: "/chat/session-test-001", label: "Chat session", expectedTab: "chat" });
  }
  if (/if \(tab === "workflows"\)/.test(source)) {
    routes.push(
      { path: "/workflows/wf-test-001", label: "Workflow detail", expectedTab: "workflows" },
      { path: "/workflows/runs", label: "Workflow runs", expectedTab: "workflows" },
      { path: "/workflows/runs/run-001", label: "Workflow run detail", expectedTab: "workflows" },
    );
  }

  return routes;
}

const ROUTES_UNDER_TEST = [...new Map(
  [...extractTabRoutes(ROUTER_SOURCE), ...extractParameterizedRoutes(ROUTER_SOURCE)]
    .map((route) => [route.path, route]),
).values()];

const SUBVIEW_SCENARIOS = [
  {
    path: "/tasks",
    label: "Tasks DAG view",
    expectedTab: "tasks",
    run: assertTasksDagViewActivated,
  },
];

/* ═══════════════════════════════════════════════════════════════
 *  Helpers
 * ═══════════════════════════════════════════════════════════════ */

/** Block external resources so the test exercises the local boot path only. */
async function blockExternals(page) {
  await page.route(
    /(telegram\.org|umami\.is|cloud\.umami|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com)/,
    (route) => route.abort(),
  );
}

/**
 * Collect runtime errors, console errors, and local asset failures.
 * Returns an object whose arrays are mutated live during the test.
 */
function attachErrorCollectors(page) {
  const state = { runtimeErrors: [], consoleErrors: [], assetFailures: [], loadedAssets: new Set() };
  const criticalConsolePattern = /syntaxerror|referenceerror|typeerror|failed to load app modules|native import failed|primary cdn failed|\[taberrorboundary\]/i;

  page.on("pageerror", (error) => {
    const msg = error?.stack || error?.message || String(error);
    state.runtimeErrors.push(msg);
  });

  page.on("console", (consoleMsg) => {
    if (consoleMsg.type() !== "error") return;
    const text = consoleMsg.text();
    if (criticalConsolePattern.test(text)) {
      state.consoleErrors.push(text);
    }
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!url.startsWith("http://localhost:4444/")) return;
    if (!/\.(?:js|mjs|css|png|svg|ico|woff2?|ttf)(?:$|\?)/i.test(url)) return;
    state.assetFailures.push(
      `${request.method()} ${url} :: ${request.failure()?.errorText || "request failed"}`,
    );
  });

  page.on("response", (response) => {
    const url = response.url();
    if (!url.startsWith("http://localhost:4444/")) return;
    if (!/\.(?:js|mjs|css|png|svg|ico|woff2?|ttf)(?:$|\?)/i.test(url)) return;
    if (response.status() >= 400) {
      state.assetFailures.push(`${response.status()} ${url}`);
      return;
    }
    state.loadedAssets.add(new URL(url).pathname);
  });

  return state;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the current boot-loader text and classify whether it surfaced a
 * user-visible failure.
 */
async function readBootResult(page) {
  const bootText = await page.locator("#boot-loader").textContent().catch(() => "");
  return {
    bootText: String(bootText || ""),
    bootFailed: /failed to load app modules|authentication expired/i.test(String(bootText || "")),
  };
}

async function readRenderedRouteState(page) {
  const tabErrorText = await page.locator(".tab-error-boundary").first().textContent().catch(() => "");
  return {
    tabErrorText: String(tabErrorText || "").trim(),
  };
}

async function assertTasksDagViewActivated(page) {
  const dagToggle = page.getByRole("button", { name: /DAG/i });
  await expect(dagToggle).toBeVisible({ timeout: 10000 });
  await dagToggle.click({ force: true });
  await page.waitForTimeout(1000);

  const bodyText = await page.locator("body").textContent().catch(() => "");
  const text = String(bodyText || "");
  const hasDagMarker = text.includes("DAG VIEW")
    || text.includes("Planning controls")
    || text.includes("No DAG nodes available for this view yet.")
    || text.includes("No DAG data was returned from DAG endpoints.");

  expect(
    hasDagMarker,
    `Expected Tasks DAG view to activate, but the page did not show a DAG-only marker.\n${text}`,
  ).toBe(true);
}

/* ═══════════════════════════════════════════════════════════════
 *  Test Suite: All Portal Routes Boot Cleanly
 *  Routes are derived from ui/modules/router.js so the harness tracks the
 *  actual portal surface instead of a hand-maintained list.
 * ═══════════════════════════════════════════════════════════════ */

test.describe("Portal route boot harness", () => {
  test.describe.configure({ timeout: 120000 });

  for (const route of ROUTES_UNDER_TEST) {
    test(`${route.label} (${route.path}) boots without JS load failures`, async ({ page }) => {
      await blockExternals(page);
      const errors = attachErrorCollectors(page);

      await page.goto(`http://localhost:4444${route.path}`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await sleep(2500);
      const boot = await readBootResult(page);
      const rendered = await readRenderedRouteState(page);

      expect(
        boot.bootFailed,
        `Boot loader surfaced an error on ${route.path}:\n${boot.bootText}`,
      ).toBe(false);

      expect(
        errors.loadedAssets.has("/app.js"),
        `Expected /app.js to load for ${route.path}`,
      ).toBe(true);

      expect(
        rendered.tabErrorText,
        `Render error boundary appeared on ${route.path}:
${rendered.tabErrorText}`,
      ).toBe("");

      expect(
        errors.runtimeErrors,
        `Runtime JS errors on ${route.path}:\n${errors.runtimeErrors.join("\n")}`,
      ).toEqual([]);

      expect(
        errors.consoleErrors,
        `Console errors on ${route.path}:\n${errors.consoleErrors.join("\n")}`,
      ).toEqual([]);

      expect(
        errors.assetFailures,
        `Critical local asset failures on ${route.path}:\n${errors.assetFailures.join("\n")}`,
      ).toEqual([]);
    });
  }
});

test.describe("Portal subview harness", () => {
  test.describe.configure({ timeout: 120000 });

  for (const scenario of SUBVIEW_SCENARIOS) {
    test(`${scenario.label} (${scenario.path}) boots without JS load failures`, async ({ page }) => {
      await blockExternals(page);
      const errors = attachErrorCollectors(page);

      await page.goto(`http://localhost:4444${scenario.path}`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await sleep(2500);
      const boot = await readBootResult(page);

      expect(
        boot.bootFailed,
        `Boot loader surfaced an error on ${scenario.path}:
${boot.bootText}`,
      ).toBe(false);

      expect(
        errors.loadedAssets.has("/app.js"),
        `Expected /app.js to load for ${scenario.path}`,
      ).toBe(true);

      await scenario.run(page);
      const rendered = await readRenderedRouteState(page);

      expect(
        rendered.tabErrorText,
        `Render error boundary appeared on ${scenario.label}:
${rendered.tabErrorText}`,
      ).toBe("");

      expect(
        errors.runtimeErrors,
        `Runtime JS errors on ${scenario.label}:
${errors.runtimeErrors.join("\n")}`,
      ).toEqual([]);

      expect(
        errors.consoleErrors,
        `Console errors on ${scenario.label}:
${errors.consoleErrors.join("\n")}`,
      ).toEqual([]);

      expect(
        errors.assetFailures,
        `Critical local asset failures on ${scenario.label}:
${errors.assetFailures.join("\n")}`,
      ).toEqual([]);
    });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  Test Suite: Critical Assets & API Endpoints
 * ═══════════════════════════════════════════════════════════════ */

test.describe("E2E Critical Assets", () => {
  test.describe.configure({ timeout: 120000 });

  test("app.js and core modules load with HTTP 200", async ({ page }) => {
    await blockExternals(page);
    const failedAssets = [];
    const loadedAssets = new Set();

    page.on("response", (response) => {
      try {
        const parsed = new URL(response.url());
        if (!parsed.hostname.includes("localhost")) return;
        const path = parsed.pathname;
        if (!/\.(js|mjs|css)$/i.test(path)) return;
        if (response.status() >= 400) {
          failedAssets.push(`${response.status()} ${path}`);
        } else {
          loadedAssets.add(path);
        }
      } catch {
        /* ignore */
      }
    });

    await page.goto("http://localhost:4444/", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await sleep(2500);

    // Core files must load
    expect(loadedAssets.has("/app.js"), "app.js should load").toBe(true);
    expect(loadedAssets.has("/styles.css"), "styles.css should load").toBe(true);

    // Vendor files must load
    for (const vendorFile of [
      "/vendor/preact.js",
      "/vendor/preact-hooks.js",
      "/vendor/htm.js",
      "/vendor/preact-signals.js",
    ]) {
      expect(loadedAssets.has(vendorFile), `${vendorFile} should load`).toBe(true);
    }

    // No JS/CSS assets should 404
    expect(
      failedAssets,
      `Failed asset loads:\n${failedAssets.join("\n")}`,
    ).toEqual([]);
  });

  test("mock API endpoints return valid JSON", async ({ page }) => {
    const endpoints = [
      "/api/health",
      "/api/status",
      "/api/config",
      "/api/tasks",
      "/api/agents",
      "/api/workflows",
      "/api/executor",
    ];

    for (const endpoint of endpoints) {
      const response = await page.request.get(`http://localhost:4444${endpoint}`);
      expect(response.status(), `${endpoint} should return 200`).toBe(200);

      const contentType = response.headers()["content-type"] || "";
      expect(contentType, `${endpoint} should return JSON`).toContain("application/json");

      const body = await response.text();
      expect(() => JSON.parse(body), `${endpoint} should return valid JSON`).not.toThrow();
    }
  });
});
