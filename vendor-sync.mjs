#!/usr/bin/env node
/**
 * vendor-sync.mjs — Bundle front-end vendor files into ui/vendor/
 *
 * Copies the ESM browser builds of Preact, htm, @preact/signals, and
 * es-module-shims from node_modules into ui/vendor/ so they are:
 *
 *   1. Included in the npm tarball (zero CDN dependency at runtime)
 *   2. Served directly as static files by both ui-server and setup-web-server
 *   3. Committed to git so the GitHub Pages demo works without a server
 *
 * Resolution order for each file:
 *   a) node_modules (createRequire resolution — handles npm hoisting)
 *   b) Download from upstream esm.sh (pinned URLs — same versions)
 *
 * Run automatically by:
 *   - `npm install`  (via postinstall.mjs)
 *   - `npm run prepare` (before npm pack / npm publish)
 *   - `npx bosun vendor-sync` (manual refresh)
 */

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = resolve(__dirname, "ui", "vendor");
const _require = createRequire(import.meta.url);

// ── Vendor manifest ───────────────────────────────────────────────────────────
// Each entry: output filename → { specifier from node_modules, upstream URL fallback }
//
// The upstream URLs are pinned esm.sh ES-module builds.  For packages that
// import bare specifiers (preact/hooks → 'preact'), the importmap in demo.html
// and index.html re-routes those to the local vendor files — so the node_modules
// copy (which uses bare specifiers internally) also works in the browser.
const VENDOR_MANIFEST = [
  {
    name: "preact.js",
    specifier: "preact/dist/preact.module.js",
    upstream: "https://esm.sh/preact@10.25.4/es2022/preact.mjs",
    upstreamFallback: "https://cdn.jsdelivr.net/npm/preact@10.25.4/dist/preact.module.js",
  },
  {
    name: "preact-hooks.js",
    specifier: "preact/hooks/dist/hooks.module.js",
    upstream: "https://cdn.jsdelivr.net/npm/preact@10.25.4/hooks/dist/hooks.module.js",
    upstreamFallback: "https://esm.sh/preact@10.25.4/hooks/es2022/hooks.mjs",
  },
  {
    name: "preact-compat.js",
    specifier: "preact/compat/dist/compat.module.js",
    upstream: "https://cdn.jsdelivr.net/npm/preact@10.25.4/compat/dist/compat.module.js",
    upstreamFallback: "https://esm.sh/preact@10.25.4/compat/es2022/compat.mjs",
  },
  {
    name: "htm.js",
    specifier: "htm/dist/htm.module.js",
    upstream: "https://esm.sh/htm@3.1.1/es2022/htm.mjs",
    upstreamFallback: "https://cdn.jsdelivr.net/npm/htm@3.1.1/dist/htm.module.js",
  },
  {
    // signals-core must be vendored BEFORE signals so the importmap can resolve it
    name: "preact-signals-core.js",
    specifier: "@preact/signals-core/dist/signals-core.module.js",
    upstream: "https://cdn.jsdelivr.net/npm/@preact/signals-core@1.8.0/dist/signals-core.module.js",
    upstreamFallback: "https://esm.sh/@preact/signals-core@1.8.0/es2022/signals-core.mjs",
  },
  {
    // signals depends on preact + preact/hooks + @preact/signals-core ─ all resolved by importmap
    name: "preact-signals.js",
    specifier: "@preact/signals/dist/signals.module.js",
    upstream: "https://cdn.jsdelivr.net/npm/@preact/signals@1.3.1/dist/signals.module.js",
    upstreamFallback: "https://esm.sh/@preact/signals@1.3.1/es2022/signals.mjs",
  },
  {
    name: "es-module-shims.js",
    specifier: "es-module-shims/dist/es-module-shims.js",
    upstream: "https://esm.sh/es-module-shims@1.10.0/es2022/es-module-shims.mjs",
    upstreamFallback: "https://cdn.jsdelivr.net/npm/es-module-shims@1.10.0/dist/es-module-shims.min.js",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolve a package sub-path in node_modules using createRequire.
 *
 * Handles two failure modes:
 *   - ERR_MODULE_NOT_FOUND   — package isn't installed
 *   - ERR_PACKAGE_PATH_NOT_EXPORTED — package uses strict `exports` that don't
 *     expose the dist/  path we want (common in modern preact / signals).
 *     Work-around: resolve the package *root* via its main entry, then
 *     construct the full path manually.
 */
function resolveFromNodeModules(specifier) {
  // Try direct resolution first (works when exports field allows the sub-path)
  try {
    return _require.resolve(specifier);
  } catch (e) {
    if (e.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") return null;
  }

  // Parse 'pkg/sub/path' or '@scope/pkg/sub/path'
  const isScoped = specifier.startsWith("@");
  const firstSlash = specifier.indexOf("/");
  const secondSlash = isScoped ? specifier.indexOf("/", firstSlash + 1) : firstSlash;
  if (secondSlash === -1) return null;
  const pkgName = specifier.slice(0, secondSlash);
  const filePath = specifier.slice(secondSlash + 1); // e.g. 'dist/preact.module.js'

  try {
    const pkgMain = _require.resolve(pkgName); // e.g. .../preact/dist/preact.js
    // Walk up from pkgMain until we find the directory with package.json
    let dir = dirname(pkgMain);
    while (dir !== dirname(dir)) {
      if (existsSync(resolve(dir, "package.json"))) {
        const candidate = resolve(dir, filePath);
        return existsSync(candidate) ? candidate : null;
      }
      dir = dirname(dir);
    }
  } catch { /* not installed */ }
  return null;
}

function fetchUrl(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects <= 0) {
      reject(new Error(`Too many redirects: ${url}`));
      return;
    }
    https
      .get(url, { headers: { "User-Agent": "bosun-vendor-sync/1.0" } }, (res) => {
        // Follow redirects (esm.sh uses 302/307 for CDN routing)
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, url).href;
          res.resume();
          fetchUrl(next, redirects - 1).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

/** Rewrite the cross-package ESM imports in esm.sh files back to local bare
 *  specifiers so the importmap resolves them to ui/vendor/* instead of CDN. */
function rewriteEsmShImports(src) {
  // esm.sh injects absolute CDN URLs like:
  //   import { ... } from "/stable/preact@10.25.4/..."
  //   import { ... } from "https://esm.sh/preact@10.25.4/..."
  // We rewrite those back to the bare specifier so the importmap takes over.
  return src
    .replace(/from\s+["'](https?:\/\/esm\.sh\/|\/stable\/)preact@[^"']*["']/g, 'from "preact"')
    .replace(/from\s+["'](https?:\/\/esm\.sh\/|\/stable\/)preact@[^"']*\/hooks[^"']*["']/g, 'from "preact/hooks"')
    .replace(/from\s+["'](https?:\/\/esm\.sh\/|\/stable\/)preact@[^"']*\/compat[^"']*["']/g, 'from "preact/compat"');
}

// ── Main ──────────────────────────────────────────────────────────────────────

export async function syncVendorFiles({ silent = false } = {}) {
  mkdirSync(VENDOR_DIR, { recursive: true });

  const log = silent ? () => {} : (...a) => console.log("[vendor-sync]", ...a);
  const warn = (...a) => console.warn("[vendor-sync] WARN:", ...a);

  const results = [];

  for (const entry of VENDOR_MANIFEST) {
    const destPath = resolve(VENDOR_DIR, entry.name);

    // ── 1. Try node_modules ──────────────────────────────────────────────────
    const localPath = resolveFromNodeModules(entry.specifier);
    if (localPath && existsSync(localPath)) {
      try {
        const src = readFileSync(localPath);
        writeFileSync(destPath, src);
        log(`✓ node_modules → ${entry.name}`);
        results.push({ name: entry.name, source: "node_modules" });
        continue;
      } catch (err) {
        warn(`node_modules read failed for ${entry.name}: ${err.message}`);
      }
    }

    // ── 2. Try esm.sh (primary upstream) ────────────────────────────────────
    for (const url of [entry.upstream, entry.upstreamFallback]) {
      try {
        log(`↓ Downloading ${entry.name} from ${url} …`);
        const buf = await fetchUrl(url);
        const src = rewriteEsmShImports(buf.toString("utf8"));
        writeFileSync(destPath, src, "utf8");
        log(`✓ downloaded → ${entry.name}`);
        results.push({ name: entry.name, source: url });
        break;
      } catch (err) {
        warn(`Download failed (${url}): ${err.message}`);
      }
    }

    if (!results.find((r) => r.name === entry.name)) {
      warn(`Could not vendor ${entry.name} — server will fall back to node_modules or CDN`);
      results.push({ name: entry.name, source: null });
    }
  }

  const ok = results.every((r) => r.source !== null);
  return { ok, results };
}

// ── CLI entry ─────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && (
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) ||
  process.argv[1].endsWith("vendor-sync.mjs")
);

if (isMain) {
  const silent = process.argv.includes("--silent");
  console.log("[vendor-sync] Syncing vendor files to ui/vendor/ …");
  const { ok, results } = await syncVendorFiles({ silent });
  if (!ok) {
    const failed = results.filter((r) => !r.source).map((r) => r.name);
    console.warn(`[vendor-sync] Some files could not be synced: ${failed.join(", ")}`);
    console.warn("[vendor-sync] The server will fall back to CDN for those files.");
  } else {
    console.log(`[vendor-sync] Done — ${results.length} vendor files ready in ui/vendor/`);
  }
}
