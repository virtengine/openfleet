#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

const SUPPORTED_LANGUAGES = new Map([
  [".js", { language: "javascript", comment: "//" }],
  [".mjs", { language: "javascript", comment: "//" }],
  [".cjs", { language: "javascript", comment: "//" }],
  [".ts", { language: "typescript", comment: "//" }],
  [".tsx", { language: "typescript", comment: "//" }],
  [".jsx", { language: "javascript", comment: "//" }],
  [".py", { language: "python", comment: "#" }],
  [".go", { language: "go", comment: "//" }],
  [".rs", { language: "rust", comment: "//" }],
]);

const GENERATED_START = "<!-- BOSUN:AUDIT:START -->";
const GENERATED_END = "<!-- BOSUN:AUDIT:END -->";
const MAX_MANIFEST_LINES = 60;
const MAX_MANIFEST_FILE_ENTRIES = 14;

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".turbo",
  ".yarn",
  ".bosun",
  "coverage",
  "dist",
  "build",
  "out",
  "vendor",
  "node_modules",
]);

const GENERATED_FILE_PATTERNS = [
  /(^|\/)dist\//i,
  /(^|\/)build\//i,
  /(^|\/)coverage\//i,
  /(^|\/)vendor\//i,
  /(^|\/)node_modules\//i,
  /\.min\.[^.]+$/i,
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
  /Cargo\.lock$/,
  /\.generated\./i,
];

const CREDENTIAL_PATTERNS = [
  { kind: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { kind: "github-token", pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/ },
  { kind: "openai-key", pattern: /sk-[A-Za-z0-9]{20,}/ },
  { kind: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
];

function toPosixPath(pathValue) {
  return String(pathValue || "").split(sep).join("/");
}

function normalizeRelativePath(rootDir, filePath) {
  return toPosixPath(relative(rootDir, filePath));
}

function ensureAuditDir(rootDir) {
  const auditDir = resolve(rootDir, ".bosun", "audit");
  mkdirSync(auditDir, { recursive: true });
  return auditDir;
}

function getAnnotationPatterns() {
  return {
    summary: /(?:CLAUDE|BOSUN):SUMMARY\b/,
    warn: /(?:CLAUDE|BOSUN):WARN\b/,
    claudeSummary: /CLAUDE:SUMMARY\b/,
    claudeWarn: /CLAUDE:WARN\b/,
    legacySummary: /BOSUN:SUMMARY\b/,
    legacyWarn: /BOSUN:WARN\b/,
  };
}

function listRepositoryFiles(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        stack.push(absolutePath);
        continue;
      }
      const extension = extname(entry.name).toLowerCase();
      if (SUPPORTED_LANGUAGES.has(extension)) {
        results.push(absolutePath);
      }
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

function getGitOutput(rootDir, args) {
  try {
    return execFileSync("git", ["-C", rootDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function parseNameStatusOutput(rootDir, output) {
  if (!output) {
    return [];
  }
  const files = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const parts = trimmed.split(/\t+/);
    const status = parts[0] || "";
    const relativePath = parts[parts.length - 1] || "";
    const absolutePath = resolve(rootDir, relativePath);
    const extension = extname(relativePath).toLowerCase();
    if (!SUPPORTED_LANGUAGES.has(extension) || !existsSync(absolutePath)) {
      continue;
    }
    files.push({
      status,
      absolutePath,
      relativePath: toPosixPath(relativePath),
    });
  }
  return files;
}

function getGitChangedFiles(rootDir, { staged = false, newFilesOnly = false, ci = false } = {}) {
  const diffFilter = newFilesOnly ? "A" : "ACMR";
  if (staged) {
    const output = getGitOutput(rootDir, ["diff", "--cached", "--name-status", `--diff-filter=${diffFilter}`]);
    return parseNameStatusOutput(rootDir, output);
  }
  if (ci) {
    const baseRef = String(process.env.GITHUB_BASE_REF || "").trim();
    const baseTarget = baseRef ? `origin/${baseRef}` : "origin/main";
    const mergeBase = getGitOutput(rootDir, ["merge-base", "HEAD", baseTarget]);
    if (mergeBase) {
      const output = getGitOutput(rootDir, ["diff", "--name-status", `--diff-filter=${diffFilter}`, `${mergeBase}...HEAD`]);
      return parseNameStatusOutput(rootDir, output);
    }
  }
  return [];
}

function isGeneratedFile(relativePath, content) {
  if (GENERATED_FILE_PATTERNS.some((pattern) => pattern.test(relativePath))) {
    return true;
  }
  return /@generated|generated by|do not edit/i.test(content.slice(0, 400));
}

function classifyFile(relativePath) {
  const normalized = toPosixPath(relativePath).toLowerCase();
  if (/\.(test|spec)\.[^.]+$/.test(normalized) || normalized.startsWith("tests/")) {
    return "test";
  }
  if (/\/(__tests__|fixtures|sandbox)\//.test(normalized)) {
    return "test";
  }
  if (/(^|\/)(config|configs)\//.test(normalized) || /(^|\/).*config\.[^.]+$/.test(normalized)) {
    return "config";
  }
  return "core";
}

function countLines(content) {
  return content ? content.split(/\r?\n/).length : 0;
}

function humanizeName(name) {
  return String(name || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[-_.]+/g, " ")
    .replace(/\bcli\b/i, "CLI")
    .replace(/\bapi\b/i, "API")
    .replace(/\bci\b/i, "CI")
    .trim();
}

function extractJavaScriptSymbols(content) {
  const symbols = new Set();
  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    /export\s+class\s+([A-Za-z0-9_$]+)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g,
    /exports\.([A-Za-z0-9_$]+)\s*=/g,
    /module\.exports\s*=\s*\{([^}]+)\}/g,
    /export\s*\{([^}]+)\}/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1] && match[1].includes(",")) {
        for (const item of match[1].split(",")) {
          const name = item.split(/\s+as\s+/i).pop().trim();
          if (name) {
            symbols.add(name);
          }
        }
      } else if (match[1]) {
        symbols.add(match[1].trim());
      }
    }
  }
  return Array.from(symbols).filter(Boolean);
}

function extractPythonSymbols(content) {
  const symbols = new Set();
  const patterns = [/^(?:async\s+)?def\s+([A-Za-z0-9_]+)/gm, /^class\s+([A-Za-z0-9_]+)/gm];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      symbols.add(match[1]);
    }
  }
  return Array.from(symbols).filter(Boolean);
}

function extractGoSymbols(content) {
  const symbols = new Set();
  const patterns = [/^func\s+(?:\([^)]*\)\s*)?([A-Z][A-Za-z0-9_]*)/gm, /^type\s+([A-Z][A-Za-z0-9_]*)/gm];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      symbols.add(match[1]);
    }
  }
  return Array.from(symbols).filter(Boolean);
}

function extractRustSymbols(content) {
  const symbols = new Set();
  const patterns = [/^pub\s+fn\s+([A-Za-z0-9_]+)/gm, /^pub\s+(?:struct|enum|trait)\s+([A-Za-z0-9_]+)/gm];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      symbols.add(match[1]);
    }
  }
  return Array.from(symbols).filter(Boolean);
}

function extractSymbols(language, content) {
  if (language === "javascript" || language === "typescript") {
    return extractJavaScriptSymbols(content);
  }
  if (language === "python") {
    return extractPythonSymbols(content);
  }
  if (language === "go") {
    return extractGoSymbols(content);
  }
  if (language === "rust") {
    return extractRustSymbols(content);
  }
  return [];
}

function summarizeSymbols(symbols) {
  if (symbols.length === 0) {
    return "";
  }
  if (symbols.length === 1) {
    return ` and exposes ${symbols[0]}`;
  }
  if (symbols.length === 2) {
    return ` and exposes ${symbols[0]} and ${symbols[1]}`;
  }
  return ` and exposes ${symbols[0]}, ${symbols[1]}, and ${symbols[2]}`;
}

function buildSummaryText(fileInfo) {
  const relativeDir = dirname(fileInfo.relativePath);
  const area = relativeDir === "." ? "the repository root" : humanizeName(basename(relativeDir));
  const baseName = humanizeName(basename(fileInfo.relativePath));
  const symbols = summarizeSymbols(fileInfo.symbols.slice(0, 3));
  if (fileInfo.category === "test") {
    return `CLAUDE:SUMMARY Verifies ${baseName} behavior for ${area}${symbols}.`;
  }
  if (/cli/i.test(baseName)) {
    return `CLAUDE:SUMMARY Routes ${baseName} flows for ${area}${symbols}.`;
  }
  if (/config/i.test(baseName)) {
    return `CLAUDE:SUMMARY Loads and normalizes ${baseName} settings for ${area}${symbols}.`;
  }
  if (/manager/i.test(baseName)) {
    return `CLAUDE:SUMMARY Manages ${baseName} responsibilities for ${area}${symbols}.`;
  }
  if (/registry/i.test(baseName)) {
    return `CLAUDE:SUMMARY Tracks ${baseName} state for ${area}${symbols}.`;
  }
  if (/server/i.test(baseName)) {
    return `CLAUDE:SUMMARY Serves ${baseName} responsibilities for ${area}${symbols}.`;
  }
  return `CLAUDE:SUMMARY Handles ${baseName} responsibilities for ${area}${symbols}.`;
}

function extractRelativeImports(fileInfo, repoFilesByPath) {
  const imports = new Set();
  const content = fileInfo.content;
  const addCandidate = (candidatePath) => {
    const normalized = toPosixPath(candidatePath);
    const variants = [
      normalized,
      `${normalized}.js`,
      `${normalized}.mjs`,
      `${normalized}.cjs`,
      `${normalized}.ts`,
      `${normalized}.tsx`,
      `${normalized}.jsx`,
      `${normalized}.py`,
      `${normalized}.go`,
      `${normalized}.rs`,
      `${normalized}/index.js`,
      `${normalized}/index.mjs`,
      `${normalized}/index.ts`,
      `${normalized}/index.tsx`,
      `${normalized}/__init__.py`,
      `${normalized}/mod.rs`,
    ];
    for (const variant of variants) {
      if (repoFilesByPath.has(variant)) {
        imports.add(variant);
        return;
      }
    }
  };

  if (fileInfo.language === "javascript" || fileInfo.language === "typescript") {
    const patterns = [
      /(?:import|export)\s+[^\n]*?from\s+["'](\.[^"']+)["']/g,
      /require\(\s*["'](\.[^"']+)["']\s*\)/g,
      /import\(\s*["'](\.[^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const resolved = normalizeRelativePath(
          fileInfo.rootDir,
          resolve(dirname(fileInfo.absolutePath), match[1]),
        );
        addCandidate(resolved);
      }
    }
  }

  if (fileInfo.language === "python") {
    const pattern = /^from\s+(\.[A-Za-z0-9_\.]+)\s+import\s+/gm;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const relativeModule = match[1].replace(/^\./, "").replace(/\./g, "/");
      const resolved = normalizeRelativePath(
        fileInfo.rootDir,
        resolve(dirname(fileInfo.absolutePath), relativeModule),
      );
      addCandidate(resolved);
    }
  }

  if (fileInfo.language === "rust") {
    const pattern = /^mod\s+([A-Za-z0-9_]+);/gm;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const resolved = normalizeRelativePath(
        fileInfo.rootDir,
        resolve(dirname(fileInfo.absolutePath), match[1]),
      );
      addCandidate(resolved);
    }
  }

  return Array.from(imports);
}

function detectCycles(graph) {
  const visited = new Set();
  const inStack = new Set();
  const cycles = new Map();
  const stack = [];

  function visit(node) {
    if (inStack.has(node)) {
      const start = stack.indexOf(node);
      const cycle = stack.slice(start).concat(node);
      for (const member of cycle) {
        cycles.set(member, cycle);
      }
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    inStack.add(node);
    stack.push(node);
    for (const edge of graph.get(node) || []) {
      visit(edge);
    }
    stack.pop();
    inStack.delete(node);
  }

  for (const node of graph.keys()) {
    visit(node);
  }
  return cycles;
}

function extractFunctionDefinitions(fileInfo) {
  const lines = fileInfo.content.split(/\r?\n/);
  const definitions = [];
  const patterns = fileInfo.language === "python"
    ? [{ regex: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/ }]
    : fileInfo.language === "go"
      ? [{ regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*\(/ }]
      : fileInfo.language === "rust"
        ? [{ regex: /^\s*(?:pub\s+)?fn\s+([A-Za-z0-9_]+)\s*\(/ }]
        : [
          { regex: /^\s*export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/ },
          { regex: /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/ },
          { regex: /^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\([^=]*=>/ },
          { regex: /^\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?[A-Za-z0-9_$]+\s*=>/ },
        ];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const pattern of patterns) {
      const match = pattern.regex.exec(line);
      if (!match) {
        continue;
      }
      definitions.push({
        name: match[1],
        lineNumber: index + 1,
        body: lines.slice(index, Math.min(lines.length, index + 30)).join("\n"),
      });
      break;
    }
  }
  return definitions;
}

function buildWarningText(message) {
  return `CLAUDE:WARN ${message}`;
}

function dedupeWarnings(warnings) {
  const seen = new Set();
  const results = [];
  for (const warning of warnings) {
    const key = `${warning.location}:${warning.lineNumber || 0}:${warning.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    results.push(warning);
  }
  return results;
}

function detectWarningsForFile(fileInfo, cycleMap) {
  const warnings = [];
  const content = fileInfo.content;
  const topWindow = content.split(/\r?\n/).slice(0, 60).join("\n");

  if (/(spawn|exec|execFile|fork|setInterval|process\.on)\s*\(/.test(topWindow)) {
    warnings.push({
      location: "top",
      text: buildWarningText("This module has startup side effects; preserve boot order and error handling when moving calls."),
    });
  }

  if (/let\s+[A-Za-z0-9_$]+\s*=\s*(?:null|undefined)/.test(content) && /(\?\?=|=\s*await\s+|if\s*\(![A-Za-z0-9_$]+\))/m.test(content)) {
    warnings.push({
      location: "top",
      text: buildWarningText("This file uses lazy initialization; keep cache state module-scoped to avoid repeated work or races."),
    });
  }

  const cycle = cycleMap.get(fileInfo.relativePath);
  if (cycle && cycle.length > 2) {
    warnings.push({
      location: "top",
      text: buildWarningText(`This file participates in an import cycle (${cycle.join(" -> ")}); change dependencies carefully.`),
    });
  }

  for (const definition of fileInfo.functions) {
    if (/\bimport\s*\(/.test(definition.body)) {
      warnings.push({
        location: "line",
        lineNumber: definition.lineNumber,
        text: buildWarningText(`Function ${definition.name} does dynamic imports; keep the lazy-load path and fallback behavior aligned.`),
      });
    }
    if (/\bvoid\s+[A-Za-z0-9_$]+\s*\(/.test(definition.body)) {
      warnings.push({
        location: "line",
        lineNumber: definition.lineNumber,
        text: buildWarningText(`Function ${definition.name} fires async work without awaiting it; preserve rejection handling when editing.`),
      });
    }
  }

  return dedupeWarnings(warnings);
}

function readFileInfo(rootDir, absolutePath, gitStatus = "") {
  const content = readFileSync(absolutePath, "utf8");
  const extension = extname(absolutePath).toLowerCase();
  const languageInfo = SUPPORTED_LANGUAGES.get(extension);
  const relativePath = normalizeRelativePath(rootDir, absolutePath);
  const patterns = getAnnotationPatterns();
  const category = classifyFile(relativePath);
  const generated = isGeneratedFile(relativePath, content);
  const symbols = extractSymbols(languageInfo.language, content);
  return {
    rootDir,
    absolutePath,
    relativePath,
    extension,
    language: languageInfo.language,
    comment: languageInfo.comment,
    category,
    generated,
    lines: countLines(content),
    hasSummary: patterns.summary.test(content),
    hasWarn: patterns.warn.test(content),
    hasClaudeSummary: patterns.claudeSummary.test(content),
    hasClaudeWarn: patterns.claudeWarn.test(content),
    hasLegacySummary: patterns.legacySummary.test(content),
    hasLegacyWarn: patterns.legacyWarn.test(content),
    content,
    symbols,
    functions: [],
    warnings: [],
    gitStatus,
  };
}

function collectInventory(rootDir, options = {}) {
  const fileEntries = options.files && options.files.length > 0
    ? options.files.map((entry) => typeof entry === "string"
      ? { absolutePath: resolve(rootDir, entry), relativePath: toPosixPath(entry), status: "" }
      : entry)
    : options.staged || options.ci
      ? getGitChangedFiles(rootDir, options)
      : listRepositoryFiles(rootDir).map((absolutePath) => ({
        absolutePath,
        relativePath: normalizeRelativePath(rootDir, absolutePath),
        status: "",
      }));

  const files = [];
  for (const entry of fileEntries) {
    const absolutePath = entry.absolutePath || resolve(rootDir, entry.relativePath);
    if (!existsSync(absolutePath)) {
      continue;
    }
    files.push(readFileInfo(rootDir, absolutePath, entry.status || ""));
  }

  const repoFilesByPath = new Map(files.map((fileInfo) => [fileInfo.relativePath, fileInfo]));
  const graph = new Map();
  for (const fileInfo of files) {
    fileInfo.functions = extractFunctionDefinitions(fileInfo);
    graph.set(fileInfo.relativePath, extractRelativeImports(fileInfo, repoFilesByPath));
  }

  const cycleMap = detectCycles(graph);
  for (const fileInfo of files) {
    fileInfo.warnings = detectWarningsForFile(fileInfo, cycleMap);
  }

  const missingSummary = files.filter((fileInfo) => !fileInfo.generated && !fileInfo.hasSummary).length;
  const missingWarn = files.filter((fileInfo) => fileInfo.warnings.length > 0 && !fileInfo.hasWarn).length;
  const languageCounts = {};
  for (const fileInfo of files) {
    languageCounts[fileInfo.language] = (languageCounts[fileInfo.language] || 0) + 1;
  }

  return {
    rootDir,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    missingSummary,
    missingWarn,
    languageCounts,
    files: files.map((fileInfo) => ({
      path: fileInfo.relativePath,
      lang: fileInfo.language,
      lines: fileInfo.lines,
      category: fileInfo.category,
      generated: fileInfo.generated,
      has_summary: fileInfo.hasSummary,
      has_warn: fileInfo.hasWarn,
      symbols: fileInfo.symbols,
      warnings: fileInfo.warnings,
      gitStatus: fileInfo.gitStatus,
    })),
    fileInfos: files,
  };
}

function writeJson(filePath, payload) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function getSummaryInsertIndex(lines) {
  let index = 0;
  if (lines[0]?.startsWith("#!")) {
    index = 1;
  }
  while (lines[index] !== undefined && lines[index].trim() === "") {
    index += 1;
  }
  return index;
}

function getTopWarningInsertIndex(lines) {
  let index = getSummaryInsertIndex(lines);
  while (lines[index] && /(?:CLAUDE|BOSUN):(SUMMARY|WARN)\b/.test(lines[index])) {
    index += 1;
  }
  while (lines[index] !== undefined && lines[index].trim() === "") {
    index += 1;
  }
  return index;
}

function applySummaryAnnotation(fileInfo, { dryRun = false } = {}) {
  if (fileInfo.generated || fileInfo.hasSummary) {
    return false;
  }
  const lines = fileInfo.content.split(/\r?\n/);
  const insertIndex = getSummaryInsertIndex(lines);
  lines.splice(insertIndex, 0, `${fileInfo.comment} ${buildSummaryText(fileInfo)}`, "");
  const updated = lines.join("\n");
  if (!dryRun) {
    writeFileSync(fileInfo.absolutePath, updated, "utf8");
    fileInfo.content = updated;
    fileInfo.hasSummary = true;
    fileInfo.hasClaudeSummary = true;
  }
  return true;
}

function lineAlreadyAnnotated(lines, lineNumber, text) {
  const start = Math.max(0, lineNumber - 3);
  const end = Math.min(lines.length - 1, lineNumber);
  for (let index = start; index <= end; index += 1) {
    if (String(lines[index] || "").includes(text)) {
      return true;
    }
  }
  return false;
}

function applyWarningAnnotations(fileInfo, { dryRun = false } = {}) {
  if (fileInfo.generated || fileInfo.warnings.length === 0) {
    return 0;
  }
  const lines = fileInfo.content.split(/\r?\n/);
  const inserts = [];
  for (const warning of fileInfo.warnings) {
    if (warning.location === "top") {
      const insertIndex = getTopWarningInsertIndex(lines);
      if (!lineAlreadyAnnotated(lines, insertIndex + 1, warning.text)) {
        inserts.push({ index: insertIndex, text: `${fileInfo.comment} ${warning.text}` });
      }
      continue;
    }
    const targetIndex = Math.max(0, (warning.lineNumber || 1) - 1);
    if (!lineAlreadyAnnotated(lines, warning.lineNumber || 1, warning.text)) {
      inserts.push({ index: targetIndex, text: `${fileInfo.comment} ${warning.text}` });
    }
  }
  inserts.sort((left, right) => right.index - left.index);
  for (const insert of inserts) {
    lines.splice(insert.index, 0, insert.text);
  }
  if (inserts.length > 0 && !dryRun) {
    const updated = lines.join("\n");
    writeFileSync(fileInfo.absolutePath, updated, "utf8");
    fileInfo.content = updated;
    fileInfo.hasWarn = true;
    fileInfo.hasClaudeWarn = true;
  }
  return inserts.length;
}

function groupFilesByDirectory(fileInfos) {
  const grouped = new Map();
  for (const fileInfo of fileInfos) {
    if (fileInfo.generated) {
      continue;
    }
    const directoryPath = dirname(fileInfo.relativePath);
    const key = directoryPath === "." ? "." : directoryPath;
    const bucket = grouped.get(key) || [];
    bucket.push(fileInfo);
    grouped.set(key, bucket);
  }
  return grouped;
}

function buildFileSummaryEntry(fileInfo, rootDir) {
  const localPath = dirname(fileInfo.relativePath) === "."
    ? basename(fileInfo.relativePath)
    : toPosixPath(relative(resolve(rootDir, dirname(fileInfo.relativePath)), fileInfo.absolutePath));
  const summaryMatch = fileInfo.content.match(/(?:CLAUDE|BOSUN):SUMMARY\s+(.+)/);
  const summary = summaryMatch ? summaryMatch[1].trim() : buildSummaryText(fileInfo).replace(/^CLAUDE:SUMMARY\s+/, "");
  return `- \`${toPosixPath(localPath)}\` — ${summary}`;
}

function trimManifestLines(lines) {
  if (lines.length <= MAX_MANIFEST_LINES) {
    return lines.join("\n");
  }
  const trimmed = lines.slice(0, MAX_MANIFEST_LINES - 2);
  trimmed.push("- Additional entries were trimmed to keep this manifest compact.");
  trimmed.push(GENERATED_END);
  return trimmed.join("\n");
}

function buildManagedBlock(kind, directoryPath, fileInfos, rootDir) {
  const label = directoryPath === "." ? "repository root" : directoryPath;
  const lines = [
    GENERATED_START,
    `## ${kind === "claude" ? "Directory Map" : "Audit Snapshot"}`,
    `- Scope: \`${label}\``,
    "- Start with this file before opening full modules.",
    "- Prefer `grep \"CLAUDE:SUMMARY\"` to narrow reads before deeper inspection.",
    "- Refresh generated entries with `bosun audit manifest` after moving files.",
    "",
    "### Files",
  ];

  const entries = fileInfos
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .slice(0, MAX_MANIFEST_FILE_ENTRIES)
    .map((fileInfo) => buildFileSummaryEntry(fileInfo, rootDir));
  lines.push(...entries);
  if (fileInfos.length > MAX_MANIFEST_FILE_ENTRIES) {
    lines.push(`- ... ${fileInfos.length - MAX_MANIFEST_FILE_ENTRIES} more entries live in \`INDEX.map\`.`);
  }
  lines.push("");
  lines.push("### Commands");
  lines.push("- `bosun audit scan` updates inventory and missing-annotation counts.");
  lines.push("- `bosun audit conformity` validates summaries, warnings, manifests, and leak checks.");
  lines.push("- `bosun audit index` refreshes `INDEX.map` after annotation changes.");
  lines.push(GENERATED_END);
  return trimManifestLines(lines);
}

function upsertManagedMarkdown(filePath, title, block) {
  const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  if (!existing.trim()) {
    writeFileSync(filePath, `# ${title}\n\n${block}\n`, "utf8");
    return;
  }
  if (existing.includes(GENERATED_START) && existing.includes(GENERATED_END)) {
    const updated = existing.replace(
      new RegExp(`${GENERATED_START}[\\s\\S]*?${GENERATED_END}`),
      block,
    );
    writeFileSync(filePath, updated.endsWith("\n") ? updated : `${updated}\n`, "utf8");
    return;
  }
  writeFileSync(filePath, `${existing.trimEnd()}\n\n${block}\n`, "utf8");
}

function createIndexMap(rootDir, fileInfos) {
  const indexLines = [];
  for (const fileInfo of fileInfos.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    if (fileInfo.generated) {
      continue;
    }
    const summaryMatch = fileInfo.content.match(/(?:CLAUDE|BOSUN):SUMMARY\s+(.+)/);
    const summary = summaryMatch ? summaryMatch[1].trim() : buildSummaryText(fileInfo).replace(/^CLAUDE:SUMMARY\s+/, "");
    indexLines.push(`${fileInfo.relativePath} | ${fileInfo.category} | ${summary}`);
  }
  const indexPath = resolve(rootDir, "INDEX.map");
  writeFileSync(indexPath, `${indexLines.join("\n")}\n`, "utf8");
  return indexPath;
}

function runManifestUpdate(rootDir, inventory) {
  const grouped = groupFilesByDirectory(inventory.fileInfos);
  const writtenFiles = [];
  for (const [directoryPath, fileInfos] of grouped.entries()) {
    const directoryRoot = directoryPath === "." ? rootDir : resolve(rootDir, directoryPath);
    const claudePath = resolve(directoryRoot, "CLAUDE.md");
    const agentsPath = resolve(directoryRoot, "AGENTS.md");
    const claudeBlock = buildManagedBlock("claude", directoryPath, fileInfos, rootDir);
    const agentsBlock = buildManagedBlock("agents", directoryPath, fileInfos, rootDir);
    upsertManagedMarkdown(claudePath, "CLAUDE.md", claudeBlock);
    upsertManagedMarkdown(agentsPath, "AGENTS.md", agentsBlock);
    writtenFiles.push(claudePath, agentsPath);
  }
  return writtenFiles;
}

function extractSummaryMentions(summaryText) {
  const marker = /exposes\s+(.+?)\.$/i.exec(summaryText);
  if (!marker) {
    return [];
  }
  return marker[1]
    .split(/,| and /)
    .map((item) => item.trim())
    .filter(Boolean);
}

function findCredentialLeaks(fileInfo) {
  const results = [];
  for (const entry of CREDENTIAL_PATTERNS) {
    const match = entry.pattern.exec(fileInfo.content);
    if (!match) {
      continue;
    }
    const lineNumber = fileInfo.content.slice(0, match.index).split(/\r?\n/).length;
    results.push({ kind: entry.kind, line: lineNumber });
  }
  return results;
}

function collectConformity(rootDir, options = {}) {
  const inventory = collectInventory(rootDir, options);
  const missingSummaries = [];
  const missingWarnings = [];
  const staleAnnotations = [];
  const credentialLeaks = [];

  for (const fileInfo of inventory.fileInfos) {
    if (fileInfo.generated) {
      continue;
    }
    if (!fileInfo.hasSummary) {
      missingSummaries.push(fileInfo.relativePath);
    }
    if (fileInfo.warnings.length > 0 && !fileInfo.hasWarn) {
      missingWarnings.push(fileInfo.relativePath);
    }
    const summaryMatch = fileInfo.content.match(/(?:CLAUDE|BOSUN):SUMMARY\s+(.+)/);
    if (summaryMatch) {
      for (const symbol of extractSummaryMentions(summaryMatch[1])) {
        if (!fileInfo.symbols.includes(symbol)) {
          staleAnnotations.push({ path: fileInfo.relativePath, symbol });
        }
      }
    }
    for (const leak of findCredentialLeaks(fileInfo)) {
      credentialLeaks.push({ path: fileInfo.relativePath, ...leak });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    rootDir,
    scope: options.ci ? "ci" : options.staged ? "staged" : "repo",
    checkedFiles: inventory.fileInfos.length,
    missingSummaries,
    missingWarnings,
    staleAnnotations,
    credentialLeaks,
    ok: missingSummaries.length === 0 && staleAnnotations.length === 0 && credentialLeaks.length === 0,
  };
  const reportPath = resolve(ensureAuditDir(rootDir), "conformity-report.json");
  writeJson(reportPath, report);
  return { report, reportPath, inventory };
}

function migrateLegacyAnnotations(rootDir, options = {}) {
  const inventory = collectInventory(rootDir, options);
  let migrated = 0;
  for (const fileInfo of inventory.fileInfos) {
    if (!fileInfo.hasLegacySummary && !fileInfo.hasLegacyWarn) {
      continue;
    }
    const updated = fileInfo.content
      .replaceAll("BOSUN:SUMMARY", "CLAUDE:SUMMARY")
      .replaceAll("BOSUN:WARN", "CLAUDE:WARN");
    if (updated === fileInfo.content) {
      continue;
    }
    writeFileSync(fileInfo.absolutePath, updated, "utf8");
    migrated += 1;
  }
  return migrated;
}

function formatScanSummary(inventory) {
  const languageParts = Object.entries(inventory.languageCounts)
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([language, count]) => `${language}:${count}`)
    .join(", ");
  return [
    `Scanned ${inventory.fileCount} supported files.`,
    `Missing summaries: ${inventory.missingSummary}.`,
    `Missing warnings: ${inventory.missingWarn}.`,
    languageParts ? `Languages: ${languageParts}.` : "Languages: none.",
  ].join(" ");
}

function printAuditHelp() {
  console.log(`
  bosun audit <command> [options]

  COMMANDS
    scan          Walk the repo and report missing annotations
    generate      Add CLAUDE:SUMMARY annotations to supported files
    warn          Add CLAUDE:WARN annotations for non-obvious hazards
    manifest      Generate or refresh lean AGENTS.md and CLAUDE.md blocks
    index         Build INDEX.map from current summaries
    trim          Trim generated manifest blocks back to a lean size
    conformity    Validate summaries, warnings, stale entries, and leaks
    migrate       Convert legacy BOSUN annotations to CLAUDE annotations

  OPTIONS
    --root <path>         Repo root to scan (default: cwd)
    --json                Print machine-readable JSON
    --dry-run             Report changes without writing files
    --staged              Limit checks to staged files
    --new-files-only      Limit staged/CI checks to added files only
    --ci                  Check changed files and exit non-zero on conformity failures
    --warn-only           Print conformity failures without exiting non-zero
    --help                Show this help
  `);
}

function parseAuditArgs(args) {
  const parsed = {
    command: "help",
    rootDir: process.cwd(),
    json: false,
    dryRun: false,
    staged: false,
    newFilesOnly: false,
    ci: false,
    warnOnly: false,
  };

  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      parsed.json = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--staged") {
      parsed.staged = true;
      continue;
    }
    if (arg === "--new-files-only") {
      parsed.newFilesOnly = true;
      continue;
    }
    if (arg === "--ci") {
      parsed.ci = true;
      continue;
    }
    if (arg === "--warn-only") {
      parsed.warnOnly = true;
      continue;
    }
    if (arg === "--root" && args[index + 1]) {
      parsed.rootDir = resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      parsed.rootDir = resolve(arg.slice("--root=".length));
      continue;
    }
    positional.push(arg);
  }

  if (parsed.ci) {
    parsed.command = "conformity";
    return parsed;
  }
  if (positional[0]) {
    parsed.command = positional[0];
  }
  if (positional[1] && positional[1] !== "--help") {
    parsed.rootDir = resolve(positional[1]);
  }
  return parsed;
}

export function scanRepository(rootDir, options = {}) {
  const inventory = collectInventory(rootDir, options);
  const inventoryPath = resolve(ensureAuditDir(rootDir), "inventory.json");
  writeJson(inventoryPath, {
    generatedAt: inventory.generatedAt,
    rootDir,
    fileCount: inventory.fileCount,
    missingSummary: inventory.missingSummary,
    missingWarn: inventory.missingWarn,
    languageCounts: inventory.languageCounts,
    files: inventory.files,
  });
  return { inventory, inventoryPath };
}

export function generateSummaries(rootDir, options = {}) {
  const inventory = collectInventory(rootDir, options);
  let changed = 0;
  for (const fileInfo of inventory.fileInfos) {
    if (applySummaryAnnotation(fileInfo, options)) {
      changed += 1;
    }
  }
  return { changed, inventory };
}

export function generateWarnings(rootDir, options = {}) {
  const inventory = collectInventory(rootDir, options);
  let changed = 0;
  for (const fileInfo of inventory.fileInfos) {
    changed += applyWarningAnnotations(fileInfo, options);
  }
  return { changed, inventory };
}

export function generateManifests(rootDir, options = {}) {
  const inventory = collectInventory(rootDir, options);
  const writtenFiles = runManifestUpdate(rootDir, inventory);
  return { writtenFiles, inventory };
}

export function buildAuditIndex(rootDir, options = {}) {
  const inventory = collectInventory(rootDir, options);
  const indexPath = createIndexMap(rootDir, inventory.fileInfos);
  return { indexPath, inventory };
}

export function trimAuditManifests(rootDir, options = {}) {
  return generateManifests(rootDir, options);
}

export function runAuditConformity(rootDir, options = {}) {
  return collectConformity(rootDir, options);
}

export function runAuditMigration(rootDir, options = {}) {
  const migrated = migrateLegacyAnnotations(rootDir, options);
  return { migrated };
}

export async function runAuditCli(args = process.argv.slice(2)) {
  const parsed = parseAuditArgs(args);
  if (args.includes("--help") || parsed.command === "help") {
    printAuditHelp();
    return 0;
  }

  const rootDir = parsed.rootDir;
  let exitCode = 0;
  let result;

  switch (parsed.command) {
    case "scan": {
      result = scanRepository(rootDir, parsed);
      const payload = {
        inventoryPath: result.inventoryPath,
        ...result.inventory,
      };
      if (parsed.json) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(formatScanSummary(result.inventory));
        console.log(`Inventory: ${result.inventoryPath}`);
      }
      break;
    }
    case "generate": {
      result = generateSummaries(rootDir, parsed);
      console.log(parsed.json
        ? JSON.stringify({ changed: result.changed }, null, 2)
        : `Added ${result.changed} summary annotations.`);
      break;
    }
    case "warn": {
      result = generateWarnings(rootDir, parsed);
      console.log(parsed.json
        ? JSON.stringify({ changed: result.changed }, null, 2)
        : `Added ${result.changed} warning annotations.`);
      break;
    }
    case "manifest": {
      result = generateManifests(rootDir, parsed);
      console.log(parsed.json
        ? JSON.stringify({ writtenFiles: result.writtenFiles }, null, 2)
        : `Updated ${result.writtenFiles.length} manifest files.`);
      break;
    }
    case "index": {
      result = buildAuditIndex(rootDir, parsed);
      console.log(parsed.json
        ? JSON.stringify({ indexPath: result.indexPath }, null, 2)
        : `Wrote ${result.indexPath}.`);
      break;
    }
    case "trim": {
      result = trimAuditManifests(rootDir, parsed);
      console.log(parsed.json
        ? JSON.stringify({ writtenFiles: result.writtenFiles }, null, 2)
        : `Trimmed ${result.writtenFiles.length} manifest files.`);
      break;
    }
    case "conformity": {
      result = runAuditConformity(rootDir, parsed);
      if (parsed.json) {
        console.log(JSON.stringify(result.report, null, 2));
      } else {
        console.log(`Checked ${result.report.checkedFiles} files.`);
        console.log(`Missing summaries: ${result.report.missingSummaries.length}.`);
        console.log(`Missing warnings: ${result.report.missingWarnings.length}.`);
        console.log(`Stale annotations: ${result.report.staleAnnotations.length}.`);
        console.log(`Credential leaks: ${result.report.credentialLeaks.length}.`);
        console.log(`Report: ${result.reportPath}`);
      }
      if (!result.report.ok && !parsed.warnOnly) {
        exitCode = 1;
      }
      break;
    }
    case "migrate": {
      result = runAuditMigration(rootDir, parsed);
      console.log(parsed.json
        ? JSON.stringify(result, null, 2)
        : `Migrated ${result.migrated} files from BOSUN annotations to CLAUDE annotations.`);
      break;
    }
    default: {
      console.error(`Unknown audit command: ${parsed.command}`);
      printAuditHelp();
      exitCode = 1;
    }
  }

  return exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runAuditCli(process.argv.slice(2));
  process.exit(exitCode);
}
