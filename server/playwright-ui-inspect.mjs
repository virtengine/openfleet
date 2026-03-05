/**
 * Playwright UI inspector — screenshots every tab and checks for layout issues.
 *
 * Usage:
 *   1. Start the mock UI server:  node playwright-ui-server.mjs
 *   2. Run this:                  npx playwright test playwright-ui-inspect.mjs --headed
 */
import { test, expect } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS_DIR = resolve(__dirname, "playwright-screenshots");
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

const BASE = "http://localhost:4444";

const TABS = [
  "dashboard",
  "tasks",
  "chat",
  "workflows",
  "agents",
  "control",
  "infra",
  "logs",
  "library",
  "telemetry",
  "settings",
];

const VIEWPORTS = [
  { name: "mobile", width: 390,  height: 844 },
  { name: "tablet", width: 768,  height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

test.describe("Portal UI Visual Inspection", () => {
  for (const vp of VIEWPORTS) {
    test.describe(`${vp.name} (${vp.width}x${vp.height})`, () => {
      test.use({ viewport: { width: vp.width, height: vp.height } });

      for (const tabId of TABS) {
        test(`screenshot ${tabId}`, async ({ page }) => {
          // Suppress console errors from missing backend
          page.on("pageerror", () => {});
          page.on("console", () => {});

          // Navigate to the tab
          await page.goto(`${BASE}/${tabId}`, { waitUntil: "domcontentloaded", timeout: 20000 });

          // Wait for SPA to hydrate
          await page.waitForTimeout(4000);

          // Wait for boot loader to disappear (best-effort)
          await page.waitForFunction(() => {
            const boot = document.getElementById("boot-loader");
            return !boot || boot.offsetParent === null || boot.style.display === "none";
          }, { timeout: 8000 }).catch(() => {});

          // Take screenshot
          const filename = `${vp.name}-${tabId}.png`;
          await page.screenshot({
            path: resolve(SCREENSHOTS_DIR, filename),
            fullPage: true,
          });

          // ── Layout checks ──
          const issues = await page.evaluate(() => {
            const problems = [];

            // Check for horizontal overflow
            if (document.body.scrollWidth > window.innerWidth + 2) {
              problems.push(
                `Body horizontal overflow: scrollWidth=${document.body.scrollWidth} > viewportWidth=${window.innerWidth}`,
              );
            }

            // Check for elements overflowing viewport
            const allElements = document.querySelectorAll("*");
            const checked = new Set();
            for (const el of allElements) {
              if (el.offsetParent === null && el.tagName !== "BODY") continue;
              const rect = el.getBoundingClientRect();

              // Skip tiny/invisible elements
              if (rect.width < 2 || rect.height < 2) continue;

              // Check right overflow
              if (rect.right > window.innerWidth + 5) {
                const id = el.id || el.className?.toString().slice(0, 40) || el.tagName;
                const key = `right-overflow:${id}`;
                if (!checked.has(key)) {
                  checked.add(key);
                  problems.push(
                    `Right overflow: <${el.tagName.toLowerCase()}> class="${(el.className || "").toString().slice(0, 60)}" right=${Math.round(rect.right)} > viewport=${window.innerWidth}`,
                  );
                }
              }

              // Check bottom nav overlap with content
              if (el.classList?.contains("MuiBottomNavigation-root")) {
                const navTop = rect.top;
                const mainContent = document.querySelector("main, .main-content, [class*='content']");
                if (mainContent) {
                  const contentRect = mainContent.getBoundingClientRect();
                  if (contentRect.bottom > navTop + 2) {
                    problems.push(
                      `Content overlaps bottom nav: content.bottom=${Math.round(contentRect.bottom)} > nav.top=${Math.round(navTop)}`,
                    );
                  }
                }
              }
            }

            // Check for cut-off text (very small containers with overflow hidden)
            const textContainers = document.querySelectorAll("h1, h2, h3, h4, h5, h6, p, span, label, button, [class*='title'], [class*='label']");
            for (const el of textContainers) {
              if (el.offsetParent === null) continue;
              const style = getComputedStyle(el);
              if (style.overflow === "hidden" && el.scrollWidth > el.clientWidth + 3) {
                if (!style.textOverflow || style.textOverflow === "clip") {
                  const text = el.textContent?.slice(0, 30) || "";
                  problems.push(
                    `Text clip without ellipsis: "${text}" scrollW=${el.scrollWidth} clientW=${el.clientWidth}`,
                  );
                }
              }
            }

            // Check z-index stacking issues
            const highZ = [];
            for (const el of allElements) {
              const style = getComputedStyle(el);
              const z = parseInt(style.zIndex, 10);
              if (z > 9999 && style.position !== "static") {
                highZ.push({ tag: el.tagName, class: (el.className || "").toString().slice(0, 40), z });
              }
            }
            if (highZ.length > 5) {
              problems.push(`Many high z-index elements (${highZ.length}): possible stacking issues`);
            }

            // Check for missing fonts (fallback detection)
            const body = document.body;
            const bodyFont = getComputedStyle(body).fontFamily;
            if (!bodyFont || bodyFont === "serif" || bodyFont === "sans-serif") {
              problems.push(`Body using generic font: ${bodyFont}`);
            }

            // Check for empty content area
            const main = document.querySelector("main, .main-content, [role='main'], .tab-content");
            if (main && main.offsetHeight < 50) {
              problems.push(`Main content area very short: ${main.offsetHeight}px`);
            }

            return problems;
          });

          // Log issues found
          if (issues.length > 0) {
            console.log(`\n=== ISSUES: ${vp.name} / ${tabId} ===`);
            for (const issue of issues) {
              console.log(`  ⚠ ${issue}`);
            }
          }
        });
      }
    });
  }

  // ── Comprehensive CSS audit ──
  test("CSS audit - all pages", async ({ page }) => {
    page.on("pageerror", () => {});
    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(4000);

    const cssAudit = await page.evaluate(() => {
      const issues = [];

      // Collect all stylesheets
      const sheets = Array.from(document.styleSheets);
      for (const sheet of sheets) {
        try {
          const rules = Array.from(sheet.cssRules || []);
          for (const rule of rules) {
            if (rule.type !== 1) continue; // CSSStyleRule
            const sel = rule.selectorText;

            // Check for !important overuse
            const important = (rule.cssText.match(/!important/g) || []).length;
            if (important > 3) {
              issues.push(`Excessive !important (${important}x) in: ${sel}`);
            }

            // Check for fixed px values on responsive elements
            const width = rule.style.width;
            if (width && width.endsWith("px") && parseInt(width) > 500) {
              issues.push(`Fixed large width ${width} on: ${sel}`);
            }
          }
        } catch {
          // Cross-origin stylesheet
        }
      }

      // Check computed styles for common issues
      const containers = document.querySelectorAll(
        ".header, .sidebar, .main-content, .bottom-nav, nav, header, main, aside, footer, " +
        ".MuiAppBar-root, .MuiDrawer-root, .MuiBottomNavigation-root",
      );
      for (const el of containers) {
        const style = getComputedStyle(el);
        // Check for conflicting position values
        if (style.position === "fixed" && !style.zIndex) {
          issues.push(`Fixed element without z-index: ${el.tagName}.${(el.className || "").toString().slice(0, 40)}`);
        }
      }

      return issues;
    });

    if (cssAudit.length > 0) {
      console.log("\n=== CSS AUDIT RESULTS ===");
      for (const issue of cssAudit) {
        console.log(`  ⚠ ${issue}`);
      }
    }
  });
});
