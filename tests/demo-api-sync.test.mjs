/**
 * demo-api-sync.test.mjs
 *
 * Validates that demo.html's mock API layer stays in sync with the real
 * API surface defined in ui-server.mjs.  Fails on push if a route exists
 * in the server but is missing from the demo mock, preventing the demo
 * from silently breaking.
 *
 * Also validates that the CDN import maps in demo.html and index.html
 * resolve the same bare-specifier set and use compatible CDN strategies
 * (esm.sh preferred for @preact/signals to avoid dual-preact instances).
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function readFile(relPath) {
  return readFileSync(resolve(ROOT, relPath), "utf-8");
}

// ── Extract API routes from ui-server.mjs ─────────────────────────────
function extractServerRoutes(source) {
  const routes = new Set();

  // Match: path === "/api/..."
  const exactRe = /path\s*===\s*["']\/api\/([^"']+)["']/g;
  let m;
  while ((m = exactRe.exec(source))) {
    routes.add("/api/" + m[1]);
  }

  // Match: path.match(/^\/api\/sessions\/.../)  → parametrized session routes
  const matchRe = /path\.match\(\s*\/\^\\\/api\\\/([^/]+)/g;
  while ((m = matchRe.exec(source))) {
    routes.add("/api/" + m[1].replace(/\\\//g, "/") + "/:id");
  }

  return routes;
}

// ── Extract session sub-actions from ui-server.mjs ────────────────────
function extractSessionActions(source) {
  const actions = new Set();
  // Match: action === "message", action === "archive", etc.
  const re = /action\s*===\s*["'](\w+)["']/g;
  let m;
  while ((m = re.exec(source))) {
    actions.add(m[1]);
  }
  return actions;
}

// ── Extract mock routes from demo.html ────────────────────────────────
function extractDemoRoutes(source) {
  const routes = new Set();

  // Match: route === '/api/...'
  const exactRe = /route\s*===\s*['"]\/api\/([^'"]+)['"]/g;
  let m;
  while ((m = exactRe.exec(source))) {
    routes.add("/api/" + m[1]);
  }

  // Match: route.match(/^\/api\/sessions\/.../)
  const matchRe = /route\.match\(\s*\/\^\\\/api\\\/([^/]+)/g;
  while ((m = matchRe.exec(source))) {
    routes.add("/api/" + m[1].replace(/\\\//g, "/") + "/:id");
  }

  return routes;
}

// ── Extract session sub-actions from demo.html ────────────────────────
function extractDemoSessionActions(source) {
  const actions = new Set();
  // Match patterns like: route.match(/^\/api\/sessions\/[^/]+\/message$/)
  const re = /route\.match\(\/.*?sessions.*?\/(\w+)\$\/\)/g;
  let m;
  while ((m = re.exec(source))) {
    actions.add(m[1]);
  }
  return actions;
}

// ── Extract import map specifiers from HTML ───────────────────────────
function extractImportMap(html) {
  // Get the first <script type="importmap"> block
  const re = /<script\s+type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/i;
  const m = re.exec(html);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ── Routes that are intentionally server-only (not needed in demo) ────
// These routes require real server functionality that can't be meaningfully
// mocked (e.g., file I/O, git operations, process management).
const INTENTIONALLY_SKIPPED = new Set([
  "/api/config",            // Full config dump — demo uses /api/settings
  "/api/projects",          // Project listing — demo uses /api/project-summary
  "/api/threads",           // Thread listing from real executor
  "/api/agent-logs/context",// Real log file reading
  "/api/worktrees/peek",    // Real git worktree file reading
  "/api/git/branch-detail", // Real git branch detail
  "/api/project-sync/metrics", // Real project sync metrics
  "/api/settings/update",   // Alias for /api/config/update
  "/api/github/app/config", // GitHub App config — server-only (reads env vars + key files)
  "/api/github/device/start", // Device Flow initiation — server-only (calls GitHub API)
  "/api/github/device/poll",  // Device Flow polling — server-only (calls GitHub API)
  "/api/workspace-health",     // Workspace health diagnostics — server-only
  "/api/voice/config",         // Voice config — server-only (reads real API keys + config)
  "/api/voice/token",          // Ephemeral token creation — server-only (calls OpenAI/Azure API)
  "/api/voice/tool",           // Voice tool execution — server-only (runs real tools)
]);

// ── Session actions intentionally skipped in demo ─────────────────────
const INTENTIONALLY_SKIPPED_ACTIONS = new Set([
  "delete",   // Demo doesn't need session deletion
  "rename",   // Demo doesn't need session renaming
  "execute",  // Workflow :id/execute action (not a session action)
  "runs",     // Workflow :id/runs action (not a session action)
  "retry",    // Workflow :id/retry action (not a session action)
]);

describe("demo.html ↔ ui-server.mjs API sync", () => {
  const serverSrc = readFile("ui-server.mjs");
  const demoSrc = readFile("ui/demo.html");

  const serverRoutes = extractServerRoutes(serverSrc);
  const demoRoutes = extractDemoRoutes(demoSrc);

  it("server should have API routes (sanity check)", () => {
    expect(serverRoutes.size).toBeGreaterThan(30);
  });

  it("demo should have API routes (sanity check)", () => {
    expect(demoRoutes.size).toBeGreaterThan(20);
  });

  it("demo mock should handle all server API routes", () => {
    const missing = [];
    for (const route of serverRoutes) {
      if (INTENTIONALLY_SKIPPED.has(route)) continue;
      // Parametrized session routes are handled by regex in demo
      if (route === "/api/sessions/:id") continue;
      if (!demoRoutes.has(route)) {
        missing.push(route);
      }
    }

    if (missing.length > 0) {
      const msg = [
        `demo.html is missing ${missing.length} API route(s) from ui-server.mjs:`,
        "",
        ...missing.map((r) => `  - ${r}`),
        "",
        "Fix: Add mock handlers in demo.html's handleApi() function,",
        "or add to INTENTIONALLY_SKIPPED in demo-api-sync.test.mjs if server-only.",
      ].join("\n");
      expect.fail(msg);
    }
  });

  it("demo mock should handle all session sub-actions", () => {
    const serverActions = extractSessionActions(serverSrc);
    const demoActions = extractDemoSessionActions(demoSrc);

    const missing = [];
    for (const action of serverActions) {
      if (INTENTIONALLY_SKIPPED_ACTIONS.has(action)) continue;
      if (!demoActions.has(action)) {
        missing.push(action);
      }
    }

    if (missing.length > 0) {
      const msg = [
        `demo.html is missing ${missing.length} session action(s):`,
        "",
        ...missing.map((a) => `  - /api/sessions/:id/${a}`),
        "",
        "Fix: Add route.match() handler in demo.html's handleApi(),",
        "or add to INTENTIONALLY_SKIPPED_ACTIONS in demo-api-sync.test.mjs.",
      ].join("\n");
      expect.fail(msg);
    }
  });

  it("no demo routes should be absent from the server (stale mocks)", () => {
    const stale = [];
    for (const route of demoRoutes) {
      // Skip special demo-only routes
      if (route === "/api/executors") continue; // alias
      if (route === "/api/project") continue;   // alias for project-summary
      // Parametrized routes
      if (route.includes("/:id")) continue;
      if (!serverRoutes.has(route)) {
        stale.push(route);
      }
    }

    if (stale.length > 0) {
      const msg = [
        `demo.html has ${stale.length} stale mock route(s) not in ui-server.mjs:`,
        "",
        ...stale.map((r) => `  - ${r}`),
        "",
        "These routes may have been removed from the server. Clean up demo.html.",
      ].join("\n");
      // Warn but don't fail — stale mocks are less critical than missing ones
      console.warn(msg);
    }
  });
});

describe("import map consistency", () => {
  const demoHtml = readFile("ui/demo.html");
  const indexHtml = readFile("ui/index.html");

  const demoMap = extractImportMap(demoHtml);
  const indexMap = extractImportMap(indexHtml);

  it("demo.html should have a valid import map", () => {
    expect(demoMap).not.toBeNull();
    expect(demoMap.imports).toBeDefined();
  });

  it("index.html should have a valid import map", () => {
    expect(indexMap).not.toBeNull();
    expect(indexMap.imports).toBeDefined();
  });

  it("both import maps should define the same bare specifiers", () => {
    const demoKeys = Object.keys(demoMap.imports).sort();
    const indexKeys = Object.keys(indexMap.imports).sort();
    expect(demoKeys).toEqual(indexKeys);
  });

  it("@preact/signals should use esm.sh with ?deps= to prevent dual-preact", () => {
    const signalsUrl = demoMap.imports["@preact/signals"] || "";
    const indexSignalsUrl = indexMap.imports["@preact/signals"] || "";

    // esm.sh with ?deps=preact ensures a single preact instance
    // jsdelivr +esm bundles its own internal preact copy, breaking signals
    for (const [label, url] of [
      ["demo.html", signalsUrl],
      ["index.html", indexSignalsUrl],
    ]) {
      if (url.includes("cdn.jsdelivr.net")) {
        expect.fail(
          `${label} uses jsdelivr for @preact/signals which bundles a separate ` +
            `preact instance internally, breaking signals/hooks integration. ` +
            `Use esm.sh with ?deps=preact@<version> instead.`,
        );
      }
    }
  });

  it("preact versions should be consistent across import maps", () => {
    const extractVersion = (url) => {
      // CDN URL: extract from preact@X.Y.Z
      const m = url.match(/preact@([\d.]+)/);
      if (m) return m[1];
      // Vendor path: /vendor/preact.js or ./vendor/preact.js
      // Version is pinned in package.json; return the filename as a stable identity token.
      if (url.startsWith("/vendor/") || url.startsWith("./vendor/")) return url;
      return null;
    };

    const demoPreactUrl = demoMap.imports["preact"] || "";
    const indexPreactUrl = indexMap.imports["preact"] || "";

    const demoPreactVer = extractVersion(demoPreactUrl);
    const indexPreactVer = extractVersion(indexPreactUrl);

    expect(demoPreactVer).toBeTruthy();
    expect(indexPreactVer).toBeTruthy();

    // index.html is served by the local bosun UI server which handles /vendor/
    // routes — it MUST use them for zero-CDN operation.
    const indexVendor = indexPreactUrl.startsWith("/vendor/");
    expect(indexVendor).toBe(true); // index.html must use /vendor/ (live server)

    // demo.html is a GitHub Pages static file. It may use either:
    //   a) ./vendor/ relative paths — vendor files committed to git (preferred: offline-safe)
    //   b) CDN URLs (esm.sh / jsDelivr) — fallback when vendor files aren't available
    // It must NOT use bare unprefixed /vendor/ (that would require a live bosun server).
    const demoUsesVendor = demoPreactUrl.startsWith("./vendor/");
    const demoUsesCdn = !demoPreactUrl.startsWith("/vendor/") && !demoPreactUrl.startsWith("./vendor/");
    expect(demoUsesVendor || demoUsesCdn).toBe(true); // must use ./vendor/ or CDN

    // @preact/signals deps param should match the CDN preact version used in demo (only for CDN mode)
    const signalsUrl = demoMap.imports["@preact/signals"] || "";
    if (!signalsUrl.startsWith("/vendor/") && !signalsUrl.startsWith("./vendor/")) {
      const demoSignalsDeps = extractVersion(signalsUrl);
      if (demoSignalsDeps) {
        expect(demoSignalsDeps).toBe(demoPreactVer);
      }
    }
  });
});
