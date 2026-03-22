import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".cache",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".bosun",
]);

const DEFAULT_FILE_EXTENSIONS = new Set([
  ".mjs",
  ".js",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".json",
  ".md",
  ".yml",
  ".yaml",
]);

function normalizeLimit(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shouldIncludeFile(name) {
  if (!name) return false;
  if (name === "package.json" || name === "AGENTS.md") return true;
  return DEFAULT_FILE_EXTENSIONS.has(extname(name).toLowerCase());
}

function scorePath(relPath) {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  let score = 0;
  if (/^agent\//.test(normalized)) score += 8;
  if (/^shell\//.test(normalized)) score += 7;
  if (/^config\//.test(normalized)) score += 5;
  if (/^task\//.test(normalized)) score += 5;
  if (/^workflow\//.test(normalized)) score += 4;
  if (/^infra\//.test(normalized)) score += 3;
  if (/^tests\//.test(normalized)) score += 2;
  if (/AGENTS\.md$/i.test(normalized)) score += 10;
  if (/package\.json$/i.test(normalized)) score += 10;
  if (/primary-agent\.mjs$/i.test(normalized)) score += 8;
  if (/codex-shell\.mjs$/i.test(normalized)) score += 8;
  return score;
}

function summarizeFile(rootDir, relPath) {
  const fullPath = join(rootDir, relPath);
  let text = "";
  try {
    text = readFileSync(fullPath, "utf8");
  } catch {
    return `- ${relPath}`;
  }

  const lines = text.split(/\r?\n/);
  const exports = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^export\s+(async\s+)?function\s+/.test(trimmed)) {
      exports.push(trimmed.replace(/\s*\{?\s*$/, ""));
    } else if (/^export\s+(const|let|var|class)\s+/.test(trimmed)) {
      exports.push(trimmed.replace(/\s*=.*$/, ""));
    }
    if (exports.length >= 3) break;
  }

  const importCount = lines.filter((line) => /^import\s+/u.test(line.trim())).length;
  const tags = [];
  if (importCount > 0) tags.push(`${importCount} imports`);
  if (exports.length > 0) tags.push(exports.join("; "));
  return tags.length > 0 ? `- ${relPath} — ${tags.join(" | ")}` : `- ${relPath}`;
}

function walkRepo(rootDir, currentDir, entries, maxFiles) {
  const children = readdirSync(currentDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const child of children) {
    if (entries.length >= maxFiles) return;
    if (child.isDirectory()) {
      if (DEFAULT_IGNORED_DIRS.has(child.name)) continue;
      walkRepo(rootDir, join(currentDir, child.name), entries, maxFiles);
      continue;
    }
    if (!child.isFile()) continue;
    if (!shouldIncludeFile(child.name)) continue;
    const relPath = relative(rootDir, join(currentDir, child.name)).split(sep).join("/");
    entries.push(relPath);
  }
}

export function generateRepoMap(rootDir, options = {}) {
  const maxFiles = normalizeLimit(options.maxFiles, 24);
  const maxSummaryLines = normalizeLimit(options.maxSummaryLines, 16);
  const entries = [];
  walkRepo(rootDir, rootDir, entries, maxFiles * 3);

  const ranked = entries
    .map((relPath) => {
      let size = 0;
      try {
        size = statSync(join(rootDir, relPath)).size;
      } catch {
        size = 0;
      }
      return { relPath, score: scorePath(relPath), size };
    })
    .sort((a, b) => (b.score - a.score) || (a.size - b.size) || a.relPath.localeCompare(b.relPath))
    .slice(0, maxFiles);

  const directories = new Map();
  for (const entry of ranked) {
    const dir = entry.relPath.includes("/") ? entry.relPath.split("/")[0] : ".";
    directories.set(dir, (directories.get(dir) || 0) + 1);
  }

  const header = [
    `Root: ${basename(rootDir)}`,
    `Hotspots: ${[...directories.entries()].sort((a, b) => b[1] - a[1]).map(([dir, count]) => `${dir}(${count})`).join(", ")}`,
  ];
  const summaries = ranked.slice(0, maxSummaryLines).map((entry) => summarizeFile(rootDir, entry.relPath));
  return [...header, ...summaries].join("\n");
}
