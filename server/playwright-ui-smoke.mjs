import { test, expect } from "@playwright/test";

const CRITICAL_ROUTES = [
  { path: "/", label: "portal home" },
  { path: "/dashboard", label: "dashboard" },
];

function isCriticalAssetUrl(url, baseURL) {
  if (!url) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== new URL(baseURL).origin) return false;
  return (
    parsed.pathname === "/" ||
    parsed.pathname === "/index.html" ||
    parsed.pathname === "/app.js" ||
    parsed.pathname.startsWith("/lib/") ||
    parsed.pathname.startsWith("/modules/") ||
    parsed.pathname.startsWith("/vendor/") ||
    parsed.pathname.startsWith("/styles/") ||
    /\.(?:js|mjs|css|map|png|svg|ico|woff2?|ttf)$/i.test(parsed.pathname)
  );
}

async function waitForPortalBoot(page) {
  try {
    await page.waitForFunction(() => {
      const boot = document.getElementById("boot-loader");
      if (!boot) return true;
      const style = window.getComputedStyle(boot);
      return style.display === "none" || boot.offsetParent === null;
    }, { timeout: 15000 });
  } catch (error) {
    const bootText = page.isClosed()
      ? "page closed before boot completed"
      : await page.evaluate(() => {
          const boot = document.getElementById("boot-loader");
          return boot?.textContent?.trim() || "boot loader still visible";
        });
    throw new Error(`Portal failed to finish booting: ${bootText}`, { cause: error });
  }
}

test.describe("Portal UI smoke", () => {
  test.describe.configure({ timeout: 45000 });

  for (const route of CRITICAL_ROUTES) {
    test(`loads ${route.label} without critical asset failures`, async ({ page, baseURL }) => {
      const runtimeErrors = [];
      const criticalFailures = [];
      const criticalWarnings = [];
      const originBase = baseURL || "http://localhost:4444";

      page.on("pageerror", (error) => {
        runtimeErrors.push(error?.stack || error?.message || String(error));
      });

      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const text = message.text();
        if (/Failed to load app modules|Native import failed|Module preflight failed/i.test(text)) {
          criticalWarnings.push(text);
        }
      });

      page.on("requestfailed", (request) => {
        if (!isCriticalAssetUrl(request.url(), originBase)) return;
        criticalFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText || "request failed"}`);
      });

      page.on("response", (response) => {
        if (response.status() < 400) return;
        if (!isCriticalAssetUrl(response.url(), originBase)) return;
        criticalFailures.push(`${response.status()} ${response.url()}`);
      });

      await page.goto(route.path, { waitUntil: "domcontentloaded", timeout: 20000 });
      await waitForPortalBoot(page);
      await expect(page.locator("#app")).toBeVisible();

      // Give late-loading modules a brief window to fail.
      await page.waitForTimeout(1500);

      expect.soft(criticalWarnings, `boot warnings for ${route.path}`).toEqual([]);
      expect(criticalFailures, `critical asset failures for ${route.path}`).toEqual([]);
      expect(runtimeErrors, `runtime errors for ${route.path}`).toEqual([]);
    });
  }
});