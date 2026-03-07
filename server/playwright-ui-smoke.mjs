import { test, expect } from "@playwright/test";

const CRITICAL_ROUTES = [
  { path: "/", label: "portal home" },
  { path: "/dashboard", label: "dashboard" },
];
const REQUIRED_ASSET_PATHS = ["/app.js", "/lib/session-insights.mjs"];

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

test.describe("Portal UI smoke", () => {
  test.describe.configure({ timeout: 45000 });

  for (const route of CRITICAL_ROUTES) {
    test(`loads ${route.label} without critical asset failures`, async ({ page, baseURL }) => {
      const runtimeErrors = [];
      const criticalFailures = [];
      const successfulAssets = new Set();
      const originBase = baseURL || "http://localhost:4444";

      page.on("pageerror", (error) => {
        runtimeErrors.push(error?.stack || error?.message || String(error));
      });

      page.on("requestfailed", (request) => {
        if (!isCriticalAssetUrl(request.url(), originBase)) return;
        criticalFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText || "request failed"}`);
      });

      page.on("response", (response) => {
        if (!isCriticalAssetUrl(response.url(), originBase)) return;
        if (response.status() < 400) {
          successfulAssets.add(new URL(response.url()).pathname);
          return;
        }
        criticalFailures.push(`${response.status()} ${response.url()}`);
      });

      await page.goto(route.path, { waitUntil: "domcontentloaded", timeout: 20000 });
      // Give the SPA time to request its local module graph.
      await page.waitForTimeout(6000);

      expect(criticalFailures, `critical asset failures for ${route.path}`).toEqual([]);
      expect(runtimeErrors, `runtime errors for ${route.path}`).toEqual([]);
      for (const requiredAsset of REQUIRED_ASSET_PATHS) {
        expect(
          successfulAssets.has(requiredAsset),
          `expected ${requiredAsset} to load for ${route.path}`,
        ).toBe(true);
      }
    });
  }
});