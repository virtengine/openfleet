/**
 * Playwright E2E page tests — verifies every major tab/page loads without
 * runtime errors and renders meaningful content.
 *
 * This catches issues like the `normalizeNodesForCanvas` TDZ error that
 * broke the workflows page — any JS ReferenceError, TypeError, or
 * uncaught promise rejection during page render will fail the test.
 *
 * Usage:
 *   npx playwright test server/playwright-ui-e2e.mjs
 *   npm run test:e2e
 */
import { test, expect } from "@playwright/test";

/* ═══════════════════════════════════════════════════════════════
 *  Tab definitions — every navigable page in the SPA
 * ═══════════════════════════════════════════════════════════════ */

const ALL_TABS = [
  { id: "dashboard", label: "Dashboard" },
  { id: "tasks",     label: "Tasks" },
  { id: "chat",      label: "Chat" },
  { id: "workflows", label: "Workflows" },
  { id: "agents",    label: "Agents" },
  { id: "control",   label: "Control" },
  { id: "infra",     label: "Infra" },
  { id: "logs",      label: "Logs" },
  { id: "library",   label: "Library" },
  { id: "manual-flows", label: "Manual Flows" },
  { id: "telemetry", label: "Telemetry" },
  { id: "benchmarks", label: "Benchmarks" },
  { id: "settings",  label: "Settings" },
];

const DEEP_ROUTES = [
  { path: "/workflows/wf-test-001",  label: "Workflow Canvas (by ID)" },
  { path: "/workflows/runs",         label: "Workflow Runs list" },
  { path: "/tasks/task-test-001",    label: "Task detail (by ID)" },
];

/* ═══════════════════════════════════════════════════════════════
 *  Helpers
 * ═══════════════════════════════════════════════════════════════ */

/**
 * Sets up request interception to make page loads fast and deterministic:
 * - Blocks slow external resources (telegram, umami, fonts)
 * - Replaces es-module-shims with a no-op (Chromium supports native import maps)
 */
async function setupFastPageLoad(page) {
  // Block slow external resources that aren't needed for functional tests
  await page.route(/(telegram\.org|umami\.is|cloud\.umami)/, (route) => route.abort());

  // Replace es-module-shims with a no-op — Playwright's Chromium supports
  // native import maps, and the polyfill adds 10-15s of processing time.
  await page.route("**/vendor/es-module-shims.js", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "/* no-op for Playwright E2E */",
    }),
  );
}

/**
 * Waits for the SPA to finish booting. Polls the boot-loader element
 * until it disappears or shows an error.
 * Returns { loaded: boolean, error?: string }.
 */
async function waitForAppBoot(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await page.evaluate(() => {
      const boot = document.getElementById("boot-loader");
      if (!boot) return { loaded: true };
      if (boot.style.display === "none" || boot.offsetParent === null) return { loaded: true };
      const text = boot.innerText || "";
      if (text.includes("Failed") || text.includes("expired")) return { loaded: false, error: text.slice(0, 200) };
      return { loaded: false };
    }).catch(() => ({ loaded: false, error: "page closed" }));
    if (state.loaded || state.error) return state;
    await page.waitForTimeout(500);
  }
  return { loaded: false, error: "boot timeout" };
}

/**
 * Collects runtime errors and TabErrorBoundary catches during page lifecycle.
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

/* ═══════════════════════════════════════════════════════════════
 *  Test Suite: Page Load — Zero Errors
 * ═══════════════════════════════════════════════════════════════ */

test.describe("E2E Page Load — All Tabs", () => {
  test.describe.configure({ timeout: 45000 });

  for (const tab of ALL_TABS) {
    test(`${tab.label} (/${tab.id}) loads without runtime errors`, async ({ page }) => {
      await setupFastPageLoad(page);
      const errors = attachErrorCollectors(page);

      await page.goto(`/${tab.id}`, { waitUntil: "domcontentloaded", timeout: 15000 });
      const boot = await waitForAppBoot(page);

      // ── No uncaught JS errors ──
      expect(
        errors.runtimeErrors,
        `Runtime JS errors on /${tab.id}:\n${errors.runtimeErrors.join("\n")}`,
      ).toEqual([]);

      // ── No TabErrorBoundary catches ──
      expect(
        errors.tabBoundaryErrors,
        `TabErrorBoundary caught errors on /${tab.id}:\n${errors.tabBoundaryErrors.join("\n")}`,
      ).toEqual([]);

      // ── App booted successfully ──
      expect(boot.loaded, `App failed to boot on /${tab.id}: ${boot.error || "unknown"}`).toBe(true);

      // ── Page has visible content ──
      const contentLength = await page.evaluate(() => (document.body?.innerText || "").length);
      expect(contentLength, `/${tab.id} rendered empty — expected visible content`).toBeGreaterThan(10);
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
      await setupFastPageLoad(page);
      const errors = attachErrorCollectors(page);

      await page.goto(route.path, { waitUntil: "domcontentloaded", timeout: 15000 });
      const boot = await waitForAppBoot(page);

      expect(
        errors.runtimeErrors,
        `Runtime JS errors on ${route.path}:\n${errors.runtimeErrors.join("\n")}`,
      ).toEqual([]);

      expect(
        errors.tabBoundaryErrors,
        `TabErrorBoundary caught errors on ${route.path}:\n${errors.tabBoundaryErrors.join("\n")}`,
      ).toEqual([]);

      expect(boot.loaded, `App failed to boot on ${route.path}: ${boot.error || "unknown"}`).toBe(true);
    });
  }
});

/* ═══════════════════════════════════════════════════════════════
 *  Test Suite: Client-Side Navigation
 * ═══════════════════════════════════════════════════════════════ */

test.describe("E2E Client-Side Navigation", () => {
  test.describe.configure({ timeout: 90000 });

  test("navigate through all tabs via client-side routing without errors", async ({ page }) => {
    await setupFastPageLoad(page);
    const errors = attachErrorCollectors(page);

    // Start at dashboard
    await page.goto("/dashboard", { waitUntil: "domcontentloaded", timeout: 15000 });
    const boot = await waitForAppBoot(page);
    expect(boot.loaded, `App failed to boot: ${boot.error}`).toBe(true);

    // Navigate to each tab via pushState (simulating navigateTo)
    for (const tab of ALL_TABS) {
      if (tab.id === "dashboard") continue;

      await page.evaluate((tabId) => {
        if (window.navigateTo) {
          window.navigateTo(tabId);
        } else {
          window.history.pushState({}, "", `/${tabId}`);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
      }, tab.id);

      // Wait for tab to render
      await page.waitForTimeout(1500);
    }

    // Verify no errors accumulated across all navigations
    expect(
      errors.runtimeErrors,
      `Runtime errors during tab navigation:\n${errors.runtimeErrors.join("\n")}`,
    ).toEqual([]);

    expect(
      errors.tabBoundaryErrors,
      `TabErrorBoundary errors during tab navigation:\n${errors.tabBoundaryErrors.join("\n")}`,
    ).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  Test Suite: Workflow Canvas (regression guard)
 * ═══════════════════════════════════════════════════════════════ */

test.describe("E2E Workflow Canvas Regression", () => {
  test.describe.configure({ timeout: 45000 });

  test("workflow canvas renders without initialization errors", async ({ page }) => {
    await setupFastPageLoad(page);
    const errors = attachErrorCollectors(page);

    await page.goto("/workflows/wf-test-001", { waitUntil: "domcontentloaded", timeout: 15000 });
    const boot = await waitForAppBoot(page);
    expect(boot.loaded, `App failed to boot: ${boot.error}`).toBe(true);

    // Specifically check for the TDZ error that broke this page
    const tdzErrors = errors.runtimeErrors.filter((e) =>
      /cannot access .* before initialization/i.test(e),
    );
    expect(
      tdzErrors,
      `Temporal dead zone errors in workflow canvas:\n${tdzErrors.join("\n")}`,
    ).toEqual([]);

    expect(errors.tabBoundaryErrors).toEqual([]);
  });

  test("workflow runs page renders without errors", async ({ page }) => {
    await setupFastPageLoad(page);
    const errors = attachErrorCollectors(page);

    await page.goto("/workflows/runs", { waitUntil: "domcontentloaded", timeout: 15000 });
    const boot = await waitForAppBoot(page);
    expect(boot.loaded, `App failed to boot: ${boot.error}`).toBe(true);

    expect(errors.runtimeErrors).toEqual([]);
    expect(errors.tabBoundaryErrors).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════
 *  Test Suite: Critical Asset Loading
 * ═══════════════════════════════════════════════════════════════ */

test.describe("E2E Critical Assets", () => {
  test.describe.configure({ timeout: 45000 });

  test("app.js and core modules load successfully", async ({ page }) => {
    await setupFastPageLoad(page);
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

    page.on("pageerror", () => {}); // suppress for this test

    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 15000 });
    await waitForAppBoot(page);

    // Core files must load
    expect(loadedAssets.has("/app.js"), "app.js should load").toBe(true);

    // No JS/CSS assets should 404
    expect(
      failedAssets,
      `Failed asset loads:\n${failedAssets.join("\n")}`,
    ).toEqual([]);
  });
});
