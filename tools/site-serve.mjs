import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");
const siteRoot = resolve(repoRoot, "site");

const args = process.argv.slice(2);
const host = readArgValue(args, "--host") || "127.0.0.1";
const port = normalizePort(readArgValue(args, "--port") || process.env.BOSUN_SITE_PORT || "4173");

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "application/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const server = createServer(async (req, res) => {
  try {
    const targetFile = await resolveRequestPath(req.url);
    if (!targetFile) {
      writeError(res, 404, "Not Found");
      return;
    }

    const contentType = MIME_TYPES.get(extname(targetFile).toLowerCase()) || "application/octet-stream";
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    });
    createReadStream(targetFile).pipe(res);
  } catch (error) {
    console.error(`[site:serve] ${error?.stack || error}`);
    writeError(res, 500, "Internal Server Error");
  }
});

server.listen(port, host, () => {
  console.log(`Bosun site server listening on http://${host}:${port}`);
  console.log(`Serving ${siteRoot}`);
});

server.on("error", (error) => {
  console.error(`[site:serve] Failed to start server: ${error?.message || error}`);
  process.exitCode = 1;
});

function readArgValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return "";
  return String(argv[index + 1] || "").trim();
}

function normalizePort(rawValue) {
  const parsed = Number.parseInt(String(rawValue || "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid --port value: ${rawValue}`);
  }
  return parsed;
}

async function resolveRequestPath(rawUrl) {
  const requestUrl = new URL(String(rawUrl || "/"), "http://local.bosun");
  let requestPath = decodeURIComponent(requestUrl.pathname || "/");
  if (requestPath === "/") requestPath = "/index.html";

  const preferred = normalize(resolve(siteRoot, `.${requestPath}`));
  const candidates = [preferred];

  if (!extname(preferred)) {
    candidates.push(join(preferred, "index.html"));
    candidates.push(`${preferred}.html`);
  }

  for (const candidate of candidates) {
    if (!candidate.startsWith(siteRoot)) continue;
    try {
      await access(candidate);
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function writeError(res, statusCode, message) {
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  res.end(message);
}
