/**
 * Minimal static server for Playwright UI inspection.
 * Serves ui/ files with proper MIME types + mock API endpoints.
 * Proxies MUI/Emotion vendor files through esm.sh to get ESM-safe bundles.
 */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiRoot = resolve(__dirname, "..", "ui");
const sharedLibRoot = resolve(__dirname, "..", "lib");
const PORT = 4444;
const ESM_CACHE_DIR = resolve(__dirname, "..", ".cache", "esm-vendor");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
};

/** Files that must be fetched from esm.sh instead of served from ui/vendor/ */
const ESM_CDN = {
  "mui-material.js":
    "https://esm.sh/@mui/material@5.15.20?target=es2022&external=react,react-dom,react/jsx-runtime",
  "emotion-react.js": "https://esm.sh/@emotion/react@11?bundle&external=react",
  "emotion-styled.js": "https://esm.sh/@emotion/styled@11?bundle&external=react,react-dom",
};

function normalizeEsmBody(body) {
  body = body.replace(
    /(import\s+(?:[^"'`]*?\s+from\s+)?["'])\/(?!\/)/g,
    "$1https://esm.sh/",
  );
  body = body.replace(
    /(export\s+(?:\*|\{[^}]*\})\s+from\s+["'])\/(?!\/)/g,
    "$1https://esm.sh/",
  );
  return body;
}

async function serveEsmVendor(res, name) {
  const cdnUrl = ESM_CDN[name];
  if (!cdnUrl) return false;

  // Try disk cache first
  const cacheFile = resolve(ESM_CACHE_DIR, name);
  if (existsSync(cacheFile)) {
    try {
      const cached = await readFile(cacheFile, "utf8");
      if (!cached.includes('Dynamic require of "react"')) {
        res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
        res.end(cached);
        return true;
      }
    } catch { /* fall through */ }
  }

  // Fetch from esm.sh
  try {
    console.log(`[esm-proxy] Fetching ${name} from esm.sh...`);
    const response = await fetch(cdnUrl, {
      headers: { "User-Agent": "bosun-playwright-proxy/1.0" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = await response.text();
    const body = normalizeEsmBody(raw);

    // Cache to disk
    try {
      await mkdir(ESM_CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, body, "utf8");
      console.log(`[esm-proxy] Cached ${name}`);
    } catch { /* best effort */ }

    res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
    res.end(body);
    return true;
  } catch (err) {
    console.error(`[esm-proxy] Failed to fetch ${name}: ${err.message}`);
    return false;
  }
}

/** Mock API responses so the UI doesn't error out */
const MOCK_API = {
  "/api/health": { status: "ok", version: "0.0.0-test", uptime: 99 },
  "/api/agents": [],
  "/api/sessions": [],
  "/api/tasks": [],
  "/api/logs": { lines: [] },
  "/api/config": { projectName: "test-project" },
  "/api/telemetry": { agents: [], sessions: [] },
  "/api/workflows": [],
  "/api/infra": { containers: [], services: [] },
  "/api/library": { tools: [], skills: [] },
  "/api/command": { ok: true },
  "/api/voice/config": { enabled: false },
  "/api/dashboard": { summary: {}, agents: [], recentTasks: [] },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Mock API
  if (pathname.startsWith("/api/")) {
    const key = pathname.split("?")[0];
    const data = MOCK_API[key] ?? { ok: true };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }

  // ESM vendor proxy for MUI/Emotion
  if (pathname.startsWith("/vendor/")) {
    const name = pathname.replace(/^\/vendor\//, "");
    if (ESM_CDN[name]) {
      const served = await serveEsmVendor(res, name);
      if (served) return;
      // Fall through to static file if proxy fails
    }
  }

  // Static files
  const servesSharedLib = pathname === "/lib" || pathname.startsWith("/lib/");
  const staticRoot = servesSharedLib ? sharedLibRoot : uiRoot;
  const relativePath = pathname === "/"
    ? "index.html"
    : servesSharedLib
      ? pathname.slice("/lib/".length)
      : pathname.replace(/^\//, "");
  let filePath = resolve(staticRoot, relativePath || "index.html");

  if (!filePath.startsWith(staticRoot)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  if (!existsSync(filePath)) {
    // SPA fallback
    const looksLikeFile = /\.[a-z0-9]+$/i.test(pathname);
    if (!looksLikeFile) {
      filePath = resolve(uiRoot, "index.html");
    } else {
      res.writeHead(404); res.end("Not Found"); return;
    }
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch (err) {
    res.writeHead(500); res.end(err.message);
  }
});

server.listen(PORT, () => {
  console.log(`[playwright-ui-server] Serving UI at http://localhost:${PORT}`);
});
