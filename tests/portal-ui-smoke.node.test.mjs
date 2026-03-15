import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

const repoRoot = process.cwd();
const serverEntry = resolve(repoRoot, "server", "playwright-ui-server.mjs");
const routerSource = readFileSync(resolve(repoRoot, "ui", "modules", "router.js"), "utf8");
const envPort = process.env.PLAYWRIGHT_UI_PORT ? Number(process.env.PLAYWRIGHT_UI_PORT) : undefined;
const port = Number.isInteger(envPort) && envPort > 0 ? envPort : 4455;
process.env.PLAYWRIGHT_UI_PORT = String(port);
const baseUrl = `http://127.0.0.1:${port}`;
const externalBlockPattern = /(telegram\.org|umami\.is|cloud\.umami|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com)/;

function extractTabRoutes(source) {
  const block = source.match(/export const TAB_CONFIG = \[([\s\S]*?)\n\];/);
  if (!block) {
    throw new Error("Could not locate TAB_CONFIG in ui/modules/router.js");
  }

  const ids = [...block[1].matchAll(/\bid:\s*"([^"]+)"/g)].map((match) => match[1]);
  const routes = ids.map((id) => ({
    path: id === "dashboard" ? "/" : `/${id}`,
    label: id === "dashboard" ? "Dashboard" : id,
  }));

  if (ids.includes("dashboard")) {
    routes.unshift({ path: "/dashboard", label: "Dashboard alias" });
  }

  return routes;
}

function extractParameterizedRoutes(source) {
  const routes = [];

  if (/if \(tab === "tasks"\)/.test(source)) {
    routes.push({ path: "/tasks/task-test-001", label: "Task detail" });
  }
  if (/if \(tab === "chat"\)/.test(source)) {
    routes.push({ path: "/chat/session-test-001", label: "Chat session" });
  }
  if (/if \(tab === "workflows"\)/.test(source)) {
    routes.push(
      { path: "/workflows/wf-test-001", label: "Workflow detail" },
      { path: "/workflows/runs", label: "Workflow runs" },
      { path: "/workflows/runs/run-001", label: "Workflow run detail" },
    );
  }

  return routes;
}

const routesUnderTest = [...new Map(
  [...extractTabRoutes(routerSource), ...extractParameterizedRoutes(routerSource)]
    .map((route) => [route.path, route]),
).values()];

function createErrorCollectors(page) {
  const state = {
    runtimeErrors: [],
    consoleErrors: [],
    assetFailures: [],
    loadedAssets: new Set(),
  };
  const criticalConsolePattern = /syntaxerror|referenceerror|typeerror|failed to load app modules|native import failed|primary cdn failed|\[taberrorboundary\]/i;

  page.on("pageerror", (error) => {
    state.runtimeErrors.push(error?.stack || error?.message || String(error));
  });

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (criticalConsolePattern.test(text)) {
      state.consoleErrors.push(text);
    }
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!url.startsWith(baseUrl)) return;
    if (!/\.(?:js|mjs|css|png|svg|ico|woff2?|ttf)(?:$|\?)/i.test(url)) return;
    state.assetFailures.push(`${request.method()} ${url} :: ${request.failure()?.errorText || "request failed"}`);
  });

  page.on("response", (response) => {
    const url = response.url();
    if (!url.startsWith(baseUrl)) return;
    if (!/\.(?:js|mjs|css|png|svg|ico|woff2?|ttf)(?:$|\?)/i.test(url)) return;
    if (response.status() >= 400) {
      state.assetFailures.push(`${response.status()} ${url}`);
      return;
    }
    state.loadedAssets.add(new URL(url).pathname);
  });

  return state;
}

async function blockExternals(page) {
  await page.route(externalBlockPattern, (route) => route.abort());
}

async function readBootResult(page) {
  const bootText = await page.locator("#boot-loader").textContent().catch(() => "");
  const text = String(bootText || "");
  return {
    bootText: text,
    bootFailed: /failed to load app modules|authentication expired/i.test(text),
  };
}

async function readTabErrorText(page) {
  const text = await page.locator(".tab-error-boundary").first().textContent().catch(() => "");
  return String(text || "").trim();
}

async function assertTasksDagViewActivated(page) {
  await page.getByRole("button", { name: /DAG/i }).click();
  await page.waitForTimeout(1000);

  const bodyText = await page.locator("body").textContent().catch(() => "");
  const text = String(bodyText || "");
  const hasDagMarker = text.includes("DAG VIEW")
    || text.includes("Planning controls")
    || text.includes("No DAG nodes available for this view yet.")
    || text.includes("No DAG data was returned from DAG endpoints.");

  assert.equal(
    hasDagMarker,
    true,
    `Expected Tasks DAG view to activate, but the page did not show a DAG-only marker.\n${text}`,
  );
}

async function verifyRouteLoads(browser, route) {
  const page = await browser.newPage();
  const errors = createErrorCollectors(page);
  try {
    await blockExternals(page);
    await page.goto(`${baseUrl}${route.path}`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page.waitForTimeout(2500);

    const boot = await readBootResult(page);
    const tabErrorText = await readTabErrorText(page);

    assert.equal(boot.bootFailed, false, `Boot loader surfaced an error on ${route.path}:\n${boot.bootText}`);
    assert.equal(errors.loadedAssets.has("/app.js"), true, `Expected /app.js to load for ${route.path}`);
    assert.equal(tabErrorText, "", `Render error boundary appeared on ${route.path}:\n${tabErrorText}`);
    assert.deepEqual(errors.runtimeErrors, [], `Runtime JS errors on ${route.path}:\n${errors.runtimeErrors.join("\n")}`);
    assert.deepEqual(errors.consoleErrors, [], `Console errors on ${route.path}:\n${errors.consoleErrors.join("\n")}`);
    assert.deepEqual(errors.assetFailures, [], `Critical local asset failures on ${route.path}:\n${errors.assetFailures.join("\n")}`);
  } finally {
    await page.close().catch(() => {});
  }
}

async function waitForHttpReady(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

let serverProcess = null;

before(async () => {
  serverProcess = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_UI_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  serverProcess.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  if (serverProcess.stdout) {
    // Drain stdout to avoid filling the pipe buffer and hanging the test.
    serverProcess.stdout.resume();
  }

  try {
    await waitForHttpReady(baseUrl);
  } catch (error) {
    serverProcess.kill();
    await once(serverProcess, "exit").catch(() => {});
    throw new Error(`Failed to start portal test server: ${error.message}\n${stderr}`);
  }
}, { timeout: 40000 });

after(async () => {
  if (!serverProcess) return;
  serverProcess.kill();
  await once(serverProcess, "exit").catch(() => {});
}, { timeout: 10000 });

describe("portal browser smoke harness", () => {
  it("boots every router-derived portal route without JS load failures", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      for (const route of routesUnderTest) {
        await verifyRouteLoads(browser, route);
      }
    } finally {
      await browser.close();
    }
  }, { timeout: 180000 });

  it("catches Tasks DAG subview failures after the route boots", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = createErrorCollectors(page);
    try {
      await blockExternals(page);
      await page.goto(`${baseUrl}/tasks`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      await page.waitForTimeout(2500);

      const boot = await readBootResult(page);
      assert.equal(boot.bootFailed, false, `Boot loader surfaced an error on /tasks:\n${boot.bootText}`);
      assert.equal(errors.loadedAssets.has("/app.js"), true, "Expected /app.js to load for /tasks");

      await assertTasksDagViewActivated(page);

      const tabErrorText = await readTabErrorText(page);
      assert.equal(tabErrorText, "", `Render error boundary appeared on Tasks DAG view:\n${tabErrorText}`);
      assert.deepEqual(errors.runtimeErrors, [], `Runtime JS errors on Tasks DAG view:\n${errors.runtimeErrors.join("\n")}`);
      assert.deepEqual(errors.consoleErrors, [], `Console errors on Tasks DAG view:\n${errors.consoleErrors.join("\n")}`);
      assert.deepEqual(errors.assetFailures, [], `Critical local asset failures on Tasks DAG view:\n${errors.assetFailures.join("\n")}`);
    } finally {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }, { timeout: 120000 });
});