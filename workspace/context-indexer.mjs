import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, relative, extname, dirname } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";

export const CONTEXT_INDEX_DIR = ".bosun/context-index";

const DB_FILE_NAME = "index.db";
const DOCS_DIR_NAME = "docs";
const ZOEKT_DIR_NAME = "zoekt";

const INCLUDED_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sh",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".pdf",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
]);

const EXCLUDED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".cache",
]);

const TASK_TYPE_ALIASES = Object.freeze({
  auto: "auto",
  ci: "ci-cd",
  cicd: "ci-cd",
  "ci-cd": "ci-cd",
  "ci_cd": "ci-cd",
  pipeline: "ci-cd",
  frontend: "frontend",
  "front-end": "frontend",
  ui: "frontend",
  web: "frontend",
  backend: "backend",
  api: "backend",
  server: "backend",
  infra: "infra",
  infrastructure: "infra",
  devops: "infra",
  docs: "docs",
  documentation: "docs",
  security: "security",
  sec: "security",
});

const TASK_TYPE_SCOPES = Object.freeze({
  "ci-cd": {
    includePathFragments: [
      ".github/workflows/",
      "github/workflows",
      "pipeline",
      "ci",
      "cd",
      "jenkins",
      "gitlab-ci",
      "buildkite",
    ],
    includeLanguages: ["yaml", "yml", "toml", "shell", "json"],
  },
  frontend: {
    includePathFragments: [
      "ui/",
      "site/",
      "web/",
      "frontend/",
      "components/",
      "pages/",
      "styles/",
      "public/",
    ],
    includeLanguages: ["javascript", "typescript", "css", "html", "markdown"],
  },
  backend: {
    includePathFragments: [
      "api/",
      "server/",
      "backend/",
      "service",
      "worker",
      "handlers/",
      "controllers/",
      "routes/",
      "db/",
    ],
    includeLanguages: ["javascript", "typescript", "python", "go", "rust", "java", "csharp"],
  },
  infra: {
    includePathFragments: [
      "infra/",
      "terraform",
      "k8s",
      "kubernetes",
      "helm",
      "docker",
      "compose",
      "deployment",
      "ops/",
    ],
    includeLanguages: ["yaml", "yml", "toml", "shell", "json"],
  },
  docs: {
    includePathFragments: ["docs/", "readme", "guide", "changelog", "adr", "spec"],
    includeLanguages: ["markdown", "json", "yaml", "yml", "toml"],
  },
  security: {
    includePathFragments: [
      "security",
      "auth",
      "oauth",
      "jwt",
      "policy",
      "permission",
      "rbac",
      "secret",
      "credential",
    ],
    includeLanguages: ["javascript", "typescript", "python", "go", "rust", "java", "csharp", "shell"],
  },
});

let sqliteModulePromise = null;
let treeSitterAvailability = null;
let zoektAvailability = null;

async function getSqliteModule() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import("node:sqlite");
  }
  return sqliteModulePromise;
}

function resolvePaths(rootDir) {
  const resolvedRoot = resolve(rootDir || process.cwd());
  const indexDir = resolve(resolvedRoot, CONTEXT_INDEX_DIR);
  const dbPath = resolve(indexDir, DB_FILE_NAME);
  const docsPath = resolve(indexDir, DOCS_DIR_NAME);
  const zoektPath = resolve(indexDir, ZOEKT_DIR_NAME);
  return { rootDir: resolvedRoot, indexDir, dbPath, docsPath, zoektPath };
}

function ensureIndexDirs(paths) {
  mkdirSync(paths.indexDir, { recursive: true });
  mkdirSync(dirname(paths.dbPath), { recursive: true });
  mkdirSync(paths.docsPath, { recursive: true });
}

async function openDb(rootDir) {
  const paths = resolvePaths(rootDir);
  ensureIndexDirs(paths);

  const sqlite = await getSqliteModule();
  const DatabaseSync = sqlite.DatabaseSync;
  if (!DatabaseSync) {
    throw new Error("node:sqlite DatabaseSync is unavailable in this Node.js runtime");
  }

  const db = new DatabaseSync(paths.dbPath);
  ensureSchema(db);
  return { db, paths };
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT,
      size INTEGER,
      mtime_ms INTEGER,
      language TEXT,
      summary TEXT,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT,
      name TEXT,
      kind TEXT,
      line INTEGER,
      signature TEXT,
      parser TEXT
    );

    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
    CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
  `);
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO index_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value ?? ""));
}

function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key);
  return row?.value ?? null;
}

function shouldSkipTestPath(relPath) {
  return /(^|\/)(test|tests|__tests__|__mocks__)(\/|$)|\.(test|spec)\./i.test(relPath);
}

function shouldSkipDir(absPath, relPath, docsPath) {
  const name = absPath.split(/[\\/]/).pop() || "";
  if (EXCLUDED_DIR_NAMES.has(name)) return true;
  const normalizedAbs = absPath.replaceAll("\\", "/");
  const normalizedDocs = docsPath.replaceAll("\\", "/");
  if (normalizedAbs === normalizedDocs) return true;
  if (normalizedAbs.startsWith(`${normalizedDocs}/`)) return true;
  if (!relPath) return false;
  return false;
}

function detectLanguage(filePath) {
  const extension = extname(filePath).toLowerCase();
  const map = {
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
    ".md": "markdown",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".toml": "toml",
    ".sh": "shell",
  };
  return map[extension] || "text";
}

function extractSummary(content) {
  const lines = String(content || "").split(/\r?\n/);
  const commentLike = /^(\/\/|#|\/\*|\*|<!--|--|;)/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (commentLike.test(line)) {
      return line
        .replace(/^(\/\/|#|\/\*+|\*+|<!--|--|;+)/, "")
        .replace(/\*\/$/, "")
        .trim()
        .slice(0, 240);
    }
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line) return line.slice(0, 240);
  }

  return "";
}

function lineFromIndex(content, index) {
  if (index <= 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === "\n") line += 1;
  }
  return line;
}

function pushSymbol(target, dedupe, symbol) {
  if (!symbol?.name) return;
  const key = `${symbol.name}::${symbol.kind || "symbol"}::${symbol.line || 1}`;
  if (dedupe.has(key)) return;
  dedupe.add(key);
  target.push(symbol);
}

function extractHeuristicSymbols(content, language) {
  const symbols = [];
  const dedupe = new Set();

  const addFromRegex = (regex, build) => {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const index = match.index || 0;
      const line = lineFromIndex(content, index);
      const symbol = build(match, line);
      pushSymbol(symbols, dedupe, { ...symbol, parser: "heuristic" });
      if (regex.lastIndex === match.index) {
        regex.lastIndex += 1;
      }
    }
  };

  if (["javascript", "typescript"].includes(language)) {
    addFromRegex(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}(${(m[2] || "").trim()})`,
    }));

    addFromRegex(/^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm, (m, line) => ({
      name: m[1],
      kind: "class",
      line,
      signature: `class ${m[1]}`,
    }));

    addFromRegex(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}(${(m[2] || "").trim()})`,
    }));
  }

  if (language === "python") {
    addFromRegex(/^\s*class\s+([A-Za-z_]\w*)\s*(?:\([^)]*\))?\s*:/gm, (m, line) => ({
      name: m[1],
      kind: "class",
      line,
      signature: `class ${m[1]}`,
    }));

    addFromRegex(/^\s*def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}(${(m[2] || "").trim()})`,
    }));
  }

  if (language === "go") {
    addFromRegex(/^\s*type\s+([A-Za-z_]\w*)\s+struct\b/gm, (m, line) => ({
      name: m[1],
      kind: "struct",
      line,
      signature: `type ${m[1]} struct`,
    }));

    addFromRegex(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(([^)]*)\)/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}(${(m[2] || "").trim()})`,
    }));
  }

  if (language === "rust") {
    addFromRegex(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}(${(m[2] || "").trim()})`,
    }));

    addFromRegex(/^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/gm, (m, line) => ({
      name: m[1],
      kind: "type",
      line,
      signature: m[0].trim(),
    }));
  }

  if (language === "shell") {
    addFromRegex(/^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\)\s*\{/gm, (m, line) => ({
      name: m[1],
      kind: "function",
      line,
      signature: `${m[1]}()`,
    }));
  }

  return symbols;
}

function ensureTreeSitterAvailability() {
  if (treeSitterAvailability) return treeSitterAvailability;

  const check = spawnSync("tree-sitter", ["--help"], { encoding: "utf8", stdio: "pipe" });
  treeSitterAvailability = {
    available: check.status === 0,
    command: "tree-sitter",
  };
  return treeSitterAvailability;
}

function parseTreeSitterTags(content) {
  const symbols = [];
  const dedupe = new Set();
  const lines = String(content || "").split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("!_TAG_")) continue;

    const parts = line.split("\t");
    const name = parts[0]?.trim() || "";
    if (!name) continue;

    const kindMatch = line.match(/;"\s*([^\s\t]+)/);
    const lineMatch = line.match(/\bline:(\d+)\b/) || line.match(/:(\d+):\d+/);
    const signature = parts[2] ? parts[2].trim() : "";

    pushSymbol(symbols, dedupe, {
      name,
      kind: (kindMatch?.[1] || "symbol").toLowerCase(),
      line: Number(lineMatch?.[1] || 1),
      signature,
      parser: "tree-sitter",
    });
  }

  return symbols;
}

async function extractSymbolsForFile(absPath, language, content, useTreeSitter) {
  if (useTreeSitter) {
    const ts = ensureTreeSitterAvailability();
    if (ts.available) {
      try {
        const output = execFileSync(ts.command, ["tags", absPath], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const parsed = parseTreeSitterTags(output);
        if (parsed.length > 0) {
          return parsed;
        }
      } catch {
        // Fall through to heuristic extraction.
      }
    }
  }

  return extractHeuristicSymbols(content, language);
}

function collectSourceFiles(rootDir, options, docsPath) {
  const includeTests = options.includeTests !== false;
  const maxFileBytes = Number(options.maxFileBytes || 800000);

  const files = [];

  function walk(absDir) {
    let entries = [];
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = resolve(absDir, entry.name);
      const relPath = relative(rootDir, absPath).replaceAll("\\", "/");

      if (entry.isDirectory()) {
        if (shouldSkipDir(absPath, relPath, docsPath)) continue;
        walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue;

      const extension = extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(extension)) continue;
      if (!INCLUDED_EXTENSIONS.has(extension)) continue;
      if (!includeTests && shouldSkipTestPath(relPath)) continue;

      let stat;
      try {
        stat = statSync(absPath);
      } catch {
        continue;
      }

      if (!stat.isFile()) continue;
      if (stat.size > maxFileBytes) continue;

      let buffer;
      try {
        buffer = readFileSync(absPath);
      } catch {
        continue;
      }

      const content = buffer.toString("utf8");
      const hash = createHash("sha256").update(buffer).digest("hex");
      const language = detectLanguage(relPath);
      const summary = extractSummary(content);

      files.push({
        absPath,
        relPath,
        hash,
        size: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
        language,
        summary,
        content,
      });
    }
  }

  walk(rootDir);
  return files;
}

function sanitizeDocName(relPath) {
  return `${relPath.replace(/[\\/]/g, "__").replace(/[^A-Za-z0-9._-]/g, "_")}.md`;
}

function writeFileDocs(db, docsPath) {
  rmSync(docsPath, { recursive: true, force: true });
  mkdirSync(docsPath, { recursive: true });

  const files = db
    .prepare("SELECT path, language, summary FROM files ORDER BY path ASC")
    .all();

  const symbolsStmt = db.prepare(
    "SELECT name, kind, line, signature FROM symbols WHERE path = ? ORDER BY line ASC LIMIT 20",
  );

  for (const file of files) {
    const symbols = symbolsStmt.all(file.path);
    const markdown = [
      `# ${file.path}`,
      "",
      `- Language: ${file.language || "unknown"}`,
      `- Summary: ${file.summary || "(none)"}`,
      "",
      "## Top Symbols",
      "",
      ...(symbols.length > 0
        ? symbols.map((s) => `- ${s.name} (${s.kind || "symbol"}) — line ${s.line || 1}${s.signature ? ` — ${String(s.signature).replace(/\s+/g, " ").trim()}` : ""}`)
        : ["- (none)"]),
      "",
    ].join("\n");

    writeFileSync(resolve(docsPath, sanitizeDocName(file.path)), markdown, "utf8");
  }
}

function writeAgentIndexMarkdown(db, rootDir, indexDir) {
  const fileCount = db.prepare("SELECT COUNT(*) AS c FROM files").get()?.c || 0;
  const symbolCount = db.prepare("SELECT COUNT(*) AS c FROM symbols").get()?.c || 0;
  const byLanguage = db
    .prepare("SELECT language, COUNT(*) AS c FROM files GROUP BY language ORDER BY c DESC, language ASC")
    .all();

  const sections = [
    "# Bosun Agent Index",
    "",
    `- Root: ${rootDir}`,
    `- Generated: ${new Date().toISOString()}`,
    `- Files indexed: ${fileCount}`,
    `- Symbols indexed: ${symbolCount}`,
    "",
    "## Files by Language",
    "",
  ];

  for (const row of byLanguage) {
    sections.push(`### ${row.language || "unknown"} (${row.c})`);
    const files = db
      .prepare("SELECT path FROM files WHERE language = ? ORDER BY path ASC LIMIT 20")
      .all(row.language);
    for (const file of files) {
      sections.push(`- ${file.path}`);
    }
    sections.push("");
  }

  sections.push("## Search Tips");
  sections.push("");
  sections.push("- CLI run: `node cli.mjs --context-index run`");
  sections.push("- CLI status: `node cli.mjs --context-index status`");
  sections.push("- CLI search: `node cli.mjs --context-index search --context-index-query \"your query\"`");
  sections.push("- Programmatic: `searchContextIndex(\"query\", { rootDir, limit: 25 })`");
  sections.push("");

  writeFileSync(resolve(indexDir, "AGENT_INDEX.md"), sections.join("\n"), "utf8");
}

function writeAgentIndexJson(db, indexDir, rootDir) {
  const files = db
    .prepare("SELECT path, hash, size, mtime_ms, language, summary, updated_at FROM files ORDER BY path ASC")
    .all();
  const symbols = db
    .prepare("SELECT path, name, kind, line, signature, parser FROM symbols ORDER BY path ASC, line ASC")
    .all();

  const payload = {
    generatedAt: new Date().toISOString(),
    rootDir,
    fileCount: files.length,
    symbolCount: symbols.length,
    files,
    symbols,
  };

  writeFileSync(resolve(indexDir, "agent-index.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function ensureZoektAvailability() {
  if (zoektAvailability) return zoektAvailability;

  const commands = process.platform === "win32"
    ? ["zoekt-index.exe", "zoekt-index"]
    : ["zoekt-index"];

  for (const command of commands) {
    const check = spawnSync(command, ["--help"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (check.status === 0) {
      zoektAvailability = { available: true, command };
      return zoektAvailability;
    }
  }

  zoektAvailability = { available: false, command: null };
  return zoektAvailability;
}

function runZoektIndex(rootDir, zoektPath, enabled) {
  if (!enabled) {
    return {
      enabled: false,
      available: false,
      success: false,
      command: null,
      message: "Zoekt indexing disabled",
    };
  }

  const availability = ensureZoektAvailability();
  if (!availability.available || !availability.command) {
    return {
      enabled: true,
      available: false,
      success: false,
      command: null,
      message: "zoekt-index binary not found",
    };
  }

  mkdirSync(zoektPath, { recursive: true });
  try {
    const output = execFileSync(
      availability.command,
      ["-index", zoektPath, rootDir],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return {
      enabled: true,
      available: true,
      success: true,
      command: availability.command,
      indexPath: zoektPath,
      message: String(output || "").trim() || "Zoekt index completed",
    };
  } catch (error) {
    const stderr = error?.stderr ? String(error.stderr).trim() : "";
    const stdout = error?.stdout ? String(error.stdout).trim() : "";
    const message = stderr || stdout || error?.message || "Zoekt index failed";
    return {
      enabled: true,
      available: true,
      success: false,
      command: availability.command,
      indexPath: zoektPath,
      message,
    };
  }
}

export async function runContextIndex(opts = {}) {
  const {
    rootDir = process.cwd(),
    includeTests = true,
    maxFileBytes = 800000,
    useTreeSitter = true,
    useZoekt = true,
  } = opts;

  const { db, paths } = await openDb(rootDir);

  try {
    const scannedFiles = collectSourceFiles(paths.rootDir, { includeTests, maxFileBytes }, paths.docsPath);

    const existingRows = db
      .prepare("SELECT path, hash FROM files")
      .all();
    const existingByPath = new Map(existingRows.map((row) => [row.path, row]));
    const scannedByPath = new Map(scannedFiles.map((row) => [row.relPath, row]));

    const changed = [];
    const removed = [];

    for (const row of scannedFiles) {
      const existing = existingByPath.get(row.relPath);
      if (!existing || existing.hash !== row.hash) {
        changed.push(row);
      }
    }

    for (const row of existingRows) {
      if (!scannedByPath.has(row.path)) {
        removed.push(row.path);
      }
    }

    const nowIso = new Date().toISOString();
    const parserUsage = { "tree-sitter": 0, heuristic: 0 };

    db.exec("BEGIN");
    try {
      const deleteSymbolsForPath = db.prepare("DELETE FROM symbols WHERE path = ?");
      const deleteFileForPath = db.prepare("DELETE FROM files WHERE path = ?");
      const upsertFile = db.prepare(`
        INSERT INTO files (path, hash, size, mtime_ms, language, summary, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          hash = excluded.hash,
          size = excluded.size,
          mtime_ms = excluded.mtime_ms,
          language = excluded.language,
          summary = excluded.summary,
          updated_at = excluded.updated_at
      `);
      const insertSymbol = db.prepare(`
        INSERT INTO symbols (path, name, kind, line, signature, parser)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const path of removed) {
        deleteSymbolsForPath.run(path);
        deleteFileForPath.run(path);
      }

      for (const file of changed) {
        upsertFile.run(
          file.relPath,
          file.hash,
          file.size,
          file.mtimeMs,
          file.language,
          file.summary,
          nowIso,
        );

        deleteSymbolsForPath.run(file.relPath);
        const symbols = await extractSymbolsForFile(
          file.absPath,
          file.language,
          file.content,
          useTreeSitter,
        );

        for (const symbol of symbols) {
          insertSymbol.run(
            file.relPath,
            symbol.name,
            symbol.kind || "symbol",
            Number(symbol.line || 1),
            symbol.signature || "",
            symbol.parser || "heuristic",
          );
          if (symbol.parser === "tree-sitter") {
            parserUsage["tree-sitter"] += 1;
          } else {
            parserUsage.heuristic += 1;
          }
        }
      }

      setMeta(db, "last_indexed_at", nowIso);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const zoekt = runZoektIndex(paths.rootDir, paths.zoektPath, useZoekt !== false);
    setMeta(db, "zoekt_status", JSON.stringify(zoekt));

    writeFileDocs(db, paths.docsPath);
    writeAgentIndexMarkdown(db, paths.rootDir, paths.indexDir);
    writeAgentIndexJson(db, paths.indexDir, paths.rootDir);

    const symbolCount = db.prepare("SELECT COUNT(*) AS c FROM symbols").get()?.c || 0;

    return {
      indexedFiles: scannedFiles.length,
      changedFiles: changed.length,
      removedFiles: removed.length,
      symbolCount,
      parserUsage,
      dbPath: paths.dbPath,
      docsPath: paths.docsPath,
      zoekt,
    };
  } finally {
    db.close();
  }
}

function escapeLikePattern(value) {
  return String(value).replace(/([%_\\])/g, "\\$1");
}

function normalizeTaskType(input) {
  const raw = String(input || "auto").trim().toLowerCase();
  if (!raw) return "auto";
  return TASK_TYPE_ALIASES[raw] || "auto";
}

function inferTaskTypeFromQuery(query) {
  const q = String(query || "").toLowerCase();
  if (!q) return "auto";
  if (/\b(ci|cd|pipeline|workflow|github actions|jenkins|buildkite|gitlab)\b/.test(q)) return "ci-cd";
  if (/\b(frontend|front-end|ui|component|css|html|react|preact|mui|tailwind)\b/.test(q)) return "frontend";
  if (/\b(api|backend|server|endpoint|handler|controller|database|sql|orm)\b/.test(q)) return "backend";
  if (/\b(infra|terraform|kubernetes|k8s|helm|docker|deployment|devops)\b/.test(q)) return "infra";
  if (/\b(doc|docs|documentation|readme|guide|changelog|adr|spec)\b/.test(q)) return "docs";
  if (/\b(security|auth|oauth|jwt|secret|credential|permission|rbac|vuln)\b/.test(q)) return "security";
  return "auto";
}

function computeScopeBoost(pathValue, languageValue, scope) {
  if (!scope) return 0;
  const normalizedPath = String(pathValue || "").toLowerCase();
  const normalizedLanguage = String(languageValue || "").toLowerCase();

  let boost = 0;
  for (const fragment of scope.includePathFragments || []) {
    if (normalizedPath.includes(String(fragment).toLowerCase())) {
      boost += 25;
    }
  }
  for (const language of scope.includeLanguages || []) {
    if (normalizedLanguage === String(language).toLowerCase()) {
      boost += 12;
      break;
    }
  }
  return boost;
}

export async function searchContextIndex(query, opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const limit = Math.max(1, Number(opts.limit || 25));
  const fallbackToGlobal = opts.fallbackToGlobal !== false;
  const includeMeta = opts.includeMeta === true;
  const normalizedQuery = String(query || "").trim();
  if (!normalizedQuery) return [];

  const requestedTaskType = normalizeTaskType(opts.taskType || "auto");
  const inferredTaskType = inferTaskTypeFromQuery(normalizedQuery);
  const resolvedTaskType = requestedTaskType === "auto" ? inferredTaskType : requestedTaskType;
  const scope = TASK_TYPE_SCOPES[resolvedTaskType] || null;

  const { db } = await openDb(rootDir);
  try {
    const pattern = `%${escapeLikePattern(normalizedQuery)}%`;
    const lower = normalizedQuery.toLowerCase();

    const fileRows = db
      .prepare(`
        SELECT path, language, summary
        FROM files
        WHERE path LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'
        LIMIT ?
      `)
      .all(pattern, pattern, limit * 2);

    const symbolRows = db
      .prepare(`
        SELECT path, name, kind, line, signature, parser
        FROM symbols
        WHERE name LIKE ? ESCAPE '\\' OR signature LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'
        LIMIT ?
      `)
      .all(pattern, pattern, pattern, limit * 3);

    const merged = [];

    for (const row of fileRows) {
      let score = 0;
      const path = String(row.path || "").toLowerCase();
      const summary = String(row.summary || "").toLowerCase();
      if (path.includes(lower)) score += 30;
      if (summary.includes(lower)) score += 15;
      const scopeBoost = computeScopeBoost(row.path, row.language, scope);
      score += scopeBoost;
      merged.push({
        type: "file",
        path: row.path,
        language: row.language,
        summary: row.summary,
        score,
        _scopeBoost: scopeBoost,
      });
    }

    for (const row of symbolRows) {
      let score = 0;
      const name = String(row.name || "").toLowerCase();
      const signature = String(row.signature || "").toLowerCase();
      const path = String(row.path || "").toLowerCase();
      if (name.includes(lower)) score += 45;
      if (signature.includes(lower)) score += 25;
      if (path.includes(lower)) score += 10;
      const scopeBoost = computeScopeBoost(row.path, null, scope);
      score += scopeBoost;
      merged.push({
        type: "symbol",
        path: row.path,
        name: row.name,
        kind: row.kind,
        line: row.line,
        signature: row.signature,
        parser: row.parser,
        score,
        _scopeBoost: scopeBoost,
      });
    }

    merged.sort((a, b) => b.score - a.score);
    const scopedOnly = merged.filter((item) => Number(item._scopeBoost || 0) > 0);
    const scopedStrongEnough = Boolean(scope) && scopedOnly.length > 0;

    let selected;
    let fallbackUsed = false;
    if (scopedStrongEnough) {
      selected = scopedOnly.slice(0, limit);
    } else if (scope && !fallbackToGlobal) {
      selected = scopedOnly.slice(0, limit);
    } else {
      selected = merged.slice(0, limit);
      fallbackUsed = Boolean(scope) && !scopedStrongEnough;
    }

    const cleaned = selected.map(({ _scopeBoost, ...rest }) => rest);
    if (includeMeta) {
      return {
        taskTypeRequested: requestedTaskType,
        taskTypeInferred: inferredTaskType,
        taskTypeUsed: resolvedTaskType,
        scopedResultCount: scopedOnly.length,
        fallbackUsed,
        results: cleaned,
      };
    }

    return cleaned;
  } finally {
    db.close();
  }
}

export async function getContextIndexStatus(opts = {}) {
  const rootDir = opts.rootDir || process.cwd();
  const { db, paths } = await openDb(rootDir);
  try {
    const fileCount = db.prepare("SELECT COUNT(*) AS c FROM files").get()?.c || 0;
    const symbolCount = db.prepare("SELECT COUNT(*) AS c FROM symbols").get()?.c || 0;
    const lastIndexedAt = getMeta(db, "last_indexed_at");
    let zoekt = null;
    const zoektRaw = getMeta(db, "zoekt_status");
    if (zoektRaw) {
      try {
        zoekt = JSON.parse(zoektRaw);
      } catch {
        zoekt = { message: zoektRaw };
      }
    }

    return {
      ready: existsSync(paths.dbPath) && fileCount > 0,
      dbPath: paths.dbPath,
      fileCount,
      symbolCount,
      lastIndexedAt,
      zoekt,
    };
  } finally {
    db.close();
  }
}
