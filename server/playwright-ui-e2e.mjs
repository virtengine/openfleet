/**
 * Playwright E2E page tests — verifies every major tab/page loads without
 * runtime errors such as TDZ (temporal dead zone), ReferenceError, or
 * uncaught exceptions.
 *
 * The mock server (playwright-ui-server.mjs) transforms the index.html on
 * the fly: strips es-module-shims, replaces the boot-loader with a direct
 * native `import("/app.js")`, removes the 12-s timeout, and serves a
 * WebSocket stub. Chromium supports native import maps, so no polyfill is
 * needed.
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
import { test, expect } from "@playwright/test";

/* ═══════════════════════════════════════════════════════════════
 *  Tab / Route definitions
 * ═══════════════════════════════════════════════════════════════ */

const ALL_TABS = [
  { id: "dashboard",    label: "Dashboard" },
  { id: "tasks",        label: "Tasks" },
  { id: "chat",         label: "Chat" },
  { id: "workflows",    label: "Workflows" },
  { id: "agents",       label: "Agents" },
  { id: "control",      label: "Control" },
  { id: "infra",        label: "Infra" },
  { id: "logs",         label: "Logs" },
  { id: "library",      label: "Library" },
  { id: "manual-flows", label: "Manual Flows" },
  { id: "telemetry",    label: "Telemetry" },
  { id: "benchmarks",   label: "Benchmarks" },
  { id: "settings",     label: "Settings" },
];

const DEEP_ROUTES = [
  { path: "/workflows/wf-test-001", label: "Workflow Canvas (by ID)" },
  { path: "/workflows/runs",        label: "Workflow Runs list" },
  { path: "/tasks/task-test-001",   label: "Task detail (by ID)" },
];

/* ═══════════════════════════════════════════════════════════════
 *  Helpers
 * ═══════════════════════════════════════════════════════════════ */

/** Block external resources that slow down or fail in test env. */
async function blockExternals(page) {
  await page.route(/(telegram\.org|umami\.is|cloud\.umami)/, (route) => route.abort());
}

/**
 * Collect runtime errors and TabErrorBoundary catches.
 * Returns an object whose arrays are mutated live during the test.
 */
function attachErrorCollectors(page) {
  const state = { runtimeErrors: [], tabBoundaryErrors: [] };

  page.on("pageerror", (error) => {
    const msg = error?.stack || error?.message || String(error);
    state.runtimeErrors.push(msg);
  });

  page.on("console", (consoleMsg) => {
    if (consoleMsg.type() !== "error") return;
    const text = consoleMsg.text();
    if (/\[TabErrorBoundary\]/i.test(text)) {
      state.tabBoundaryErrors.push(text);
    }
  });

  return state;
}

/**
 * Wait until all JS modules have loaded by watching the network.
 * The server-side HTML transform does `await import("/app.js")` which
 * triggers the full module tree. We wait until there's a quiet period
 * with no pending JS requests.
 */
async function waitForModuleLoad(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  // Give modules initial time to start loading
  await page.waitForTimeout(500);
  // Wait for network idle (no more than 0 network connections for 500ms)
  try {
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch {
    // networkidle may not fire if WebSocket stays open — that's OK
  }
  // Extra safety: wait a moment for any async side-effects
  await page.waitForTimeout(1000);
}

/* ═══════════════════════════════════════════════════════════════
 *  Test Suite: Module Loading — Zero Errors per Tab
 *  Each tab is loaded via a direct navigation. The SPA router inside
 *  app.js picks up the URL and activates the corresponding tab module.
 *  We verify that no JS errors fire during module evaluation.
 * ═══════════════════════════════════════════════════════════════ */

test.describe("E2E Module Loading — All Tabs", () => {
  test.describe.configure({ timeout: 45000 });

  for (const tab of ALL_TABS) {
    test(`${tab.label} (/${tab.id}) loads modules without runtime errors`, async ({ page }) => {
      await blockExternals(page);
      const errors = attachErrorCollectors(page);

      await page.goto(`http://localhost:4444/${tab.id}`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await waitForModuleLoad(page);

      // ── No uncaught JS errors (TDZ, ReferenceError, TypeError, etc.) ──
      expect(
        errors.runtimeErrors,
        `Runtime JS errors on /${tab.id}:\n${errors.runtimeErrors.join("\n")}`,
      ).toEqual([]);

      // ── No TabErrorBoundary catches ──
      expect(
        errors.tabBoundaryErrors,
        `TabErrorBoundary caught errors on /${tab.id}:\n${errors.tabBoundaryErrors.join("\n")}`,
      ).toEqual([]);
    });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  Test Suite: Deep Routes — Parameterized Pages
 * ═══════════════════════════════════════════════════════════════ */

test.describe("E2E Deep Routes", () => {
  test.describe.configure({ timeout: 45000 });

  for (const route of DEEP_ROUTES) {
    test(`${route.label} (${route.path}) loads without errors`, async ({ page }) => {
      await blockExternals(page);
      const errors = attachErrorCollectors(page);

      await page.goto(`http://localhost:4444${route.path}`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await waitForModuleLoad(page);

      expect(
        errors.runtimeErrors,
        `Runtime JS errors on ${route.path}:\n${errors.runtimeErrors.join("\n")}`,
      ).toEqual([]);

      expect(
        errors.tabBoundaryErrors,
        `TabErrorBoundary caught errors on ${route.path}:\n${errors.tabBoundaryErrors.join("\n")}`,
      ).toEqual([]);
    });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  Test Suite: Workflow Canvas Regression Guard
 *  The normalizeNodesForCanvas TDZ error is specifically checked.
 * ═══════════════════════════════════════════════════════════════ */

test.describe("E2E Workflow Canvas Regression", () => {
  test.describe.configure({ timeout: 45000 });

  test("workflow canvas loads without TDZ / initialization errors", async ({ page }) => {
    await blockExternals(page);
    const errors = attachErrorCollectors(page);

    await page.goto("http://localhost:4444/workflows/wf-test-001", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await waitForModuleLoad(page);

    // Specifically check for TDZ errors that previously broke this page
    const tdzErrors = errors.runtimeErrors.filter((e) =>
      /cannot access .* before initialization/i.test(e),
    );
    expect(
      tdzErrors,
      `Temporal dead zone errors in workflow canvas:\n${tdzErrors.join("\n")}`,
    ).toEqual([]);

    expect(errors.runtimeErrors).toEqual([]);
    expect(errors.tabBoundaryErrors).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  Test Suite: Critical Assets & API Endpoints
 * ═══════════════════════════════════════════════════════════════ */

test.describe("E2E Critical Assets", () => {
  test.describe.configure({ timeout: 45000 });

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
      } catch { /* ignore */ }
    });

    await page.goto("http://localhost:4444/", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await waitForModuleLoad(page);

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
