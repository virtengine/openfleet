import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import {
  buildAgentsManifest,
  buildClaudeManifest,
  buildSummary,
  summaryFromLine,
  upsertManagedBlock,
} from "./codebase-audit-manifests.mjs";

const SOURCE_TYPES = new Map([
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

const SUMMARY_MARKERS = ["CLAUDE:SUMMARY", "BOSUN:SUMMARY"];
const WARN_MARKERS = ["CLAUDE:WARN", "BOSUN:WARN"];
const GENERATED_PATTERNS = [
  /^\.git(?:\/|$)/,
  /^node_modules(?:\/|$)/,
  /^coverage(?:\/|$)/,
  /^dist(?:\/|$)/,
  /^build(?:\/|$)/,
  /^out(?:\/|$)/,
  /^target(?:\/|$)/,
  /^vendor(?:\/|$)/,
  /^\.next(?:\/|$)/,
  /^\.cache(?:\/|$)/,
  /^\.bosun(?:\/cache\/|\/tmp\/)/,
  /\.min\.[^.]+$/,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /Cargo\.lock$/,
  /go\.sum$/,
  /coverage-report\.json$/,
];
const CREDENTIAL_PATTERNS = [
  { name: "openai", regex: /sk-[A-Za-z0-9]{20,}/g },
  { name: "github_pat", regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "aws_access_key", regex: /AKIA[0-9A-Z]{16}/g },
  { name: "private_key", regex: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PRIVATE) KEY-----/g },
  { name: "generic_assignment", regex: /(?:api|auth|secret|token|password|passwd|private)[_-]?(?:key|token|secret|password)?\s*[:=]\s*["'][^"'\n]{12,}["']/gi },
];

function parseCliArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [rawKey, rawValue] = arg.split("=", 2);
    const key = rawKey.slice(2);
    if (rawValue !== undefined) {
      flags[key] = rawValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positionals, flags };
}

function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function toPosix(pathValue) {
  return String(pathValue || "").replace(/\\/g, "/");
}

function isGeneratedPath(relPath) {
  return GENERATED_PATTERNS.some((pattern) => pattern.test(relPath));
}

function readText(pathValue) {
  return readFileSync(pathValue, "utf8");
}

function safeStat(pathValue) {
  try {
    return statSync(pathValue);
  } catch {
    return null;
  }
}

function ensureAuditDir(rootDir, dryRun = false) {
  const auditDir = resolve(rootDir, ".bosun", "audit");
  if (!dryRun) mkdirSync(auditDir, { recursive: true });
  return auditDir;
}

function writeArtifact(rootDir, name, data, dryRun = false) {
  const auditDir = ensureAuditDir(rootDir, dryRun);
  const artifactPath = resolve(auditDir, name);
  if (!dryRun) {
    const text = typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`;
    writeFileSync(artifactPath, text, "utf8");
  }
  return artifactPath;
}

function buildSchedulePayload(summary = {}) {
  const now = new Date();
  const next = new Date(now.getTime());
  next.setDate(next.getDate() + 30);
  return {
    lastFullAudit: now.toISOString(),
    nextRecommendedAudit: next.toISOString(),
    filesAudited: Number(summary.filesAudited || 0),
    summariesAdded: Number(summary.summariesAdded || 0),
    warningsAdded: Number(summary.warningsAdded || 0),
    conformityScore: Number(summary.conformityScore || 0),
  };
}

function writeSchedule(rootDir, summary = {}, options = {}) {
  const schedule = buildSchedulePayload(summary);
  const path = writeArtifact(rootDir, "schedule.json", schedule, Boolean(options.dryRun));
  return { path, schedule };
}

function getSourceType(pathValue) {
  return SOURCE_TYPES.get(extname(pathValue).toLowerCase()) || null;
}

function parseImportSpecifiers(content, language) {
  if (language !== "javascript" && language !== "typescript") return [];
  const specs = new Set();
  const importRegex = /import\s+(?:[^"'`]+?\s+from\s+)?["'`]([^"'`]+)["'`]/g;
  const dynamicImportRegex = /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  const requireRegex = /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  for (const pattern of [importRegex, dynamicImportRegex, requireRegex]) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1]) specs.add(match[1]);
    }
    pattern.lastIndex = 0;
  }
  return [...specs];
}

function resolveLocalImportPath(repoRoot, fromFile, specifier) {
  if (!specifier || !specifier.startsWith(".")) return "";
  const fromDir = dirname(fromFile);
  const absoluteBase = resolve(fromDir, specifier);
  const candidates = [
    absoluteBase,
    `${absoluteBase}.js`,
    `${absoluteBase}.mjs`,
    `${absoluteBase}.cjs`,
    `${absoluteBase}.ts`,
    `${absoluteBase}.tsx`,
    `${absoluteBase}.jsx`,
    resolve(absoluteBase, "index.js"),
    resolve(absoluteBase, "index.mjs"),
    resolve(absoluteBase, "index.cjs"),
    resolve(absoluteBase, "index.ts"),
    resolve(absoluteBase, "index.tsx"),
    resolve(absoluteBase, "index.jsx"),
  ];
  for (const candidate of candidates) {
    const info = safeStat(candidate);
    if (info?.isFile()) return toPosix(relative(repoRoot, candidate));
  }
  return "";
}

function findCycleMembers(edgesByFile) {
  const states = new Map();
  const stack = [];
  const inCycles = new Set();

  function visit(node) {
    const state = states.get(node) || 0;
    if (state === 2) return;
    if (state === 1) {
      const cycleStart = stack.lastIndexOf(node);
      if (cycleStart >= 0) {
        for (let index = cycleStart; index < stack.length; index += 1) inCycles.add(stack[index]);
        inCycles.add(node);
      }
      return;
    }
    states.set(node, 1);
    stack.push(node);
    for (const dep of edgesByFile.get(node) || []) visit(dep);
    stack.pop();
    states.set(node, 2);
  }

  for (const node of edgesByFile.keys()) visit(node);
  return inCycles;
}

function appendCircularDependencyWarnings(files, repoRoot, warningKinds) {
  const sourceSet = new Set(files.map((file) => file.path));
  const edgesByFile = new Map();
  for (const file of files) {
    if (file.language !== "javascript" && file.language !== "typescript") continue;
    const deps = [];
    for (const specifier of file.importSpecifiers || []) {
      const resolved = resolveLocalImportPath(repoRoot, file.absolutePath, specifier);
      if (resolved && sourceSet.has(resolved)) deps.push(resolved);
    }
    edgesByFile.set(file.path, deps);
  }
  const cycleMembers = findCycleMembers(edgesByFile);
  for (const file of files) {
    if (!cycleMembers.has(file.path)) continue;
    if (file.warnings.some((warning) => warning.kind === "circular-deps")) continue;
    file.warnings.push({
      kind: "circular-deps",
      text: "Module participates in circular dependency chains; avoid reordering imports or eager top-level side effects.",
      functionName: "__module__",
      lineIndex: file.firstFunctionLine,
    });
    warningKinds["circular-deps"] = (warningKinds["circular-deps"] || 0) + 1;
  }
}

function detectCategory(relPath) {
  if (/(^|\/)(tests?|__tests__|fixtures?|sandbox)(\/|$)|\.(test|spec)\./i.test(relPath)) return "test";
  if (/(^|\/)(config|configs)(\/|$)|(^|\/)(AGENTS|CLAUDE)\.md$/i.test(relPath)) return "config";
  if (/(^|\/)(scripts?|tools|bin)(\/|$)/i.test(relPath)) return "tooling";
  if (/(^|\/)(lib|utils?|helpers?)(\/|$)/i.test(relPath)) return "util";
  return "core";
}

function isAnnotationLine(line, markers) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("//") && !trimmed.startsWith("#")) return false;
  return markers.some((marker) => new RegExp(`\\b${marker}\\b`).test(trimmed));
}

function extractAnnotationLines(content, markers = SUMMARY_MARKERS) {
  const lines = content.split(/\r?\n/);
  return lines.filter((line) => isAnnotationLine(line, markers));
}

function collectAnnotations(content) {
  const summaryLine = extractAnnotationLines(content, SUMMARY_MARKERS)[0] || "";
  const warnLines = extractAnnotationLines(content, WARN_MARKERS);
  return { summaryLine, warnLines };
}

function listStagedFiles(rootDir) {
  try {
    const output = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      output
        .split(/\r?\n/)
        .map((entry) => toPosix(entry.trim()))
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

export function scanRepository(rootDir, options = {}) {
  const repoRoot = resolve(rootDir);
  const targetDir = options.targetDir ? resolve(repoRoot, options.targetDir) : repoRoot;
  const stagedFiles = options.staged ? listStagedFiles(repoRoot) : null;
  const files = [];
  const languageCounts = {};
  const warningKinds = {};
  const allowedExtensions = String(options.extensions || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  function addFile(absolutePath) {
    const relPath = toPosix(relative(repoRoot, absolutePath));
    const sourceType = getSourceType(absolutePath);
    if (!sourceType) return;
    if (allowedExtensions.length > 0 && !allowedExtensions.includes(extname(absolutePath).toLowerCase())) return;
    if (stagedFiles && !stagedFiles.has(relPath)) return;
    if (isGeneratedPath(relPath)) return;

    const content = readText(absolutePath);
    const contentLines = content.split(/\r?\n/);
    const annotations = collectAnnotations(content);
    const functionMatches = findFunctionMatches(content, sourceType.language);
    const warnings = analyzeFileWarnings(content, sourceType.language, functionMatches);
    for (const warning of warnings) {
      warningKinds[warning.kind] = (warningKinds[warning.kind] || 0) + 1;
    }
    languageCounts[sourceType.language] = (languageCounts[sourceType.language] || 0) + 1;
    files.push({
      path: relPath,
      absolutePath,
      language: sourceType.language,
      extension: extname(absolutePath).toLowerCase(),
      comment: sourceType.comment,
      lines: content === "" ? 0 : contentLines.length,
      category: detectCategory(relPath),
      hasSummary: annotations.summaryLine !== "",
      hasWarn: annotations.warnLines.length > 0,
      summaryLine: annotations.summaryLine,
      warnLines: annotations.warnLines,
      importSpecifiers: parseImportSpecifiers(content, sourceType.language),
      firstFunctionLine: functionMatches[0]?.lineIndex ?? findInsertionIndex(contentLines),
      warnings,
    });
  }

  function visit(currentDir) {
    let entries = [];
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolutePath = resolve(currentDir, entry.name);
      const relPath = toPosix(relative(repoRoot, absolutePath));
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") && entry.name !== ".bosun") continue;
        if (isGeneratedPath(`${relPath}/`)) continue;
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      addFile(absolutePath);
    }
  }

  const targetStat = safeStat(targetDir);
  if (!targetStat) throw new Error(`Target directory not found: ${targetDir}`);
  if (targetStat.isDirectory()) visit(targetDir);
  if (targetStat.isFile()) {
    const relPath = toPosix(relative(repoRoot, targetDir));
    if (getSourceType(targetDir) && !isGeneratedPath(relPath)) addFile(targetDir);
  }
  appendCircularDependencyWarnings(files, repoRoot, warningKinds);

  const result = {
    rootDir: repoRoot,
    targetDir: toPosix(relative(repoRoot, targetDir)) || ".",
    generatedAt: new Date().toISOString(),
    totals: {
      files: files.length,
      missingSummary: files.filter((file) => !file.hasSummary).length,
      missingWarn: files.filter((file) => file.warnings.length > 0 && !file.hasWarn).length,
    },
    languages: languageCounts,
    warningKinds,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
  writeArtifact(repoRoot, "inventory.json", result, Boolean(options.dryRun));
  return result;
}

const summarizeFile = (file) => buildSummary(file, readText);

function buildCommentLine(commentPrefix, marker, text) {
  return `${commentPrefix} ${marker} ${text}`.trimEnd();
}

function findInsertionIndex(lines) {
  let index = 0;
  if (lines[index]?.startsWith("#!")) index += 1;
  if (lines[index]?.startsWith("# -*-") || lines[index]?.startsWith("# coding:")) index += 1;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  return index;
}

function insertHeaderAnnotation(content, annotationLine) {
  const lines = content.split(/\r?\n/);
  lines.splice(findInsertionIndex(lines), 0, annotationLine);
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function updateFiles(files, updater, options = {}) {
  const changed = [];
  for (const file of files) {
    const original = readText(file.absolutePath);
    const next = updater(file, original);
    if (typeof next !== "string" || next === original) continue;
    if (!options.dryRun) writeFileSync(file.absolutePath, next, "utf8");
    changed.push(file.path);
  }
  return changed;
}

export function generateSummaries(rootDir, options = {}) {
  const scan = scanRepository(rootDir, options);
  const changed = updateFiles(
    scan.files.filter((file) => !file.hasSummary),
    (file, content) => insertHeaderAnnotation(content, buildCommentLine(file.comment, "CLAUDE:SUMMARY", summarizeFile(file))),
    options,
  );
  return {
    command: "generate",
    changed,
    scanned: scan.totals.files,
    added: changed.length,
    artifactPath: writeArtifact(rootDir, "generate-report.json", {
      generatedAt: new Date().toISOString(),
      changed,
      scanned: scan.totals.files,
    }, Boolean(options.dryRun)),
  };
}

function findFunctionMatches(content, language) {
  const lines = content.split(/\r?\n/);
  const matches = [];
  const patternsByLanguage = {
    javascript: [
      /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
      /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
      /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
    ],
    typescript: [
      /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/,
      /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
      /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
    ],
    python: [/^def\s+([A-Za-z_][\w]*)\s*\(/, /^async\s+def\s+([A-Za-z_][\w]*)\s*\(/],
    go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\(/],
    rust: [/^(?:pub\s+)?fn\s+([A-Za-z_][\w]*)\s*\(/],
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    for (const pattern of patternsByLanguage[language] || []) {
      const match = line.match(pattern);
      if (match) {
        matches.push({ name: match[1], lineIndex: index });
        break;
      }
    }
  }
  return matches.map((match, index) => ({
    ...match,
    endLineIndex: (matches[index + 1]?.lineIndex ?? lines.length) - 1,
  }));
}

function analyzeFunctionWarnings(segment) {
  const warnings = [];
  if (/await\s+import\(|\brequire\(|importlib\.import_module/.test(segment)) {
    warnings.push({ kind: "lazy-init", text: "Lazily resolves dependencies at runtime; preserve initialization order and cache behavior." });
  }
  if (/if\s*\((?:!|typeof\s+)[^)]+\)\s*\{?[\s\S]{0,180}?=\s*(?:await\s+)?(?:new\s+|\b(?:create|build|init|get|load)\b)/.test(segment) || /sync\.Once|OnceLock|lazy_static!/.test(segment)) {
    warnings.push({ kind: "singleton", text: "Initializes shared state on demand; changing call order can duplicate or corrupt cached state." });
  }
  if (/\b(?:writeFile|appendFile|unlink|rmSync|mkdirSync)|spawn\(|exec(?:File)?Sync|fork\(|process\.exit|std::fs::|std::process::Command|os\.WriteFile|os\.Remove|subprocess\./.test(segment)) {
    warnings.push({ kind: "side-effects", text: "Performs filesystem or process side effects; audit callers before reordering, retrying, or parallelizing." });
  }
  if (/(?:process\.env|os\.environ|\bgetenv\(|std::env::var)/.test(segment)) {
    warnings.push({ kind: "env", text: "Depends on ambient environment state; validate required variables before changing execution flow." });
  }
  return warnings;
}

function analyzeFileWarnings(content, language, functionMatches) {
  const lines = content.split(/\r?\n/);
  const warnings = [];
  for (const match of functionMatches) {
    const segment = lines.slice(match.lineIndex, match.endLineIndex + 1).join("\n");
    for (const warning of analyzeFunctionWarnings(segment)) {
      warnings.push({ ...warning, functionName: match.name, lineIndex: match.lineIndex });
    }
  }
  if (functionMatches.length === 0) {
    const topLevelWarnings = analyzeFunctionWarnings(lines.slice(0, Math.min(lines.length, 120)).join("\n"));
    for (const warning of topLevelWarnings) warnings.push({ ...warning, functionName: null, lineIndex: findInsertionIndex(lines) });
  }
  return warnings;
}

function hasNearbyWarn(lines, lineIndex) {
  const start = Math.max(0, lineIndex - 2);
  const end = Math.min(lines.length - 1, lineIndex + 1);
  for (let index = start; index <= end; index += 1) {
    if (isAnnotationLine(lines[index], WARN_MARKERS)) return true;
  }
  return false;
}

export function generateWarnings(rootDir, options = {}) {
  const scan = scanRepository(rootDir, options);
  const changed = updateFiles(
    scan.files,
    (file, content) => {
      if (file.warnings.length === 0) return content;
      const lines = content.split(/\r?\n/);
      const inserts = [];
      for (const warning of file.warnings) {
        if (hasNearbyWarn(lines, warning.lineIndex)) continue;
        const preferredIndex = Number.isInteger(warning.lineIndex) ? warning.lineIndex : findInsertionIndex(lines);
        inserts.push({
          index: warning.functionName ? preferredIndex : findInsertionIndex(lines),
          text: buildCommentLine(file.comment, "CLAUDE:WARN", warning.text),
        });
      }
      if (inserts.length === 0) return content;
      inserts.sort((left, right) => right.index - left.index);
      for (const insert of inserts) lines.splice(insert.index, 0, insert.text);
      return `${lines.join("\n").replace(/\n+$/, "")}\n`;
    },
    options,
  );
  return {
    command: "warn",
    changed,
    added: changed.length,
    artifactPath: writeArtifact(rootDir, "warn-report.json", {
      generatedAt: new Date().toISOString(),
      changed,
      scanned: scan.totals.files,
    }, Boolean(options.dryRun)),
  };
}

export function generateManifests(rootDir, options = {}) {
  const scan = scanRepository(rootDir, options);
  const byDirectory = new Map();
  byDirectory.set(resolve(rootDir), [...scan.files]);
  for (const file of scan.files) {
    const dirPath = dirname(resolve(rootDir, file.path));
    if (dirPath === resolve(rootDir)) continue;
    const bucket = byDirectory.get(dirPath) || [];
    bucket.push(file);
    byDirectory.set(dirPath, bucket);
  }
  const changed = [];
  for (const [dirPath, entries] of [...byDirectory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const claudePath = resolve(dirPath, "CLAUDE.md");
    const agentsPath = resolve(dirPath, "AGENTS.md");
    if (!options.dryRun) {
      writeFileSync(claudePath, upsertManagedBlock(existsSync(claudePath) ? readText(claudePath) : "", buildClaudeManifest(dirPath, entries, rootDir, summarizeFile)), "utf8");
      writeFileSync(agentsPath, upsertManagedBlock(existsSync(agentsPath) ? readText(agentsPath) : "", buildAgentsManifest(dirPath, entries, rootDir, summarizeFile)), "utf8");
    }
    changed.push(toPosix(relative(rootDir, claudePath)));
    changed.push(toPosix(relative(rootDir, agentsPath)));
  }
  return {
    command: "manifest",
    changed,
    directories: byDirectory.size,
    artifactPath: writeArtifact(rootDir, "manifest-report.json", {
      generatedAt: new Date().toISOString(),
      changed,
      directories: byDirectory.size,
    }, Boolean(options.dryRun)),
  };
}

export function buildIndexMap(rootDir, options = {}) {
  const scan = scanRepository(rootDir, options);
  const indexPath = resolve(rootDir, "INDEX.map");
  const lines = ["# INDEX.map", ""];
  for (const file of scan.files) {
    lines.push(`${file.path} => ${summaryFromLine(file.summaryLine, summarizeFile(file))}`);
  }
  if (!options.dryRun) writeFileSync(indexPath, `${lines.join("\n")}\n`, "utf8");
  return {
    command: "index",
    entries: scan.files.length,
    path: indexPath,
    artifactPath: writeArtifact(rootDir, "index-report.json", {
      generatedAt: new Date().toISOString(),
      path: indexPath,
      entries: scan.files.length,
    }, Boolean(options.dryRun)),
  };
}

function parseIndexMap(rootDir) {
  const indexPath = resolve(rootDir, "INDEX.map");
  if (!existsSync(indexPath)) return [];
  return readText(indexPath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("=>"))
    .map((line) => {
      const [pathPart, ...summaryParts] = line.split("=>");
      return { path: pathPart.trim(), summary: summaryParts.join("=>").trim() };
    });
}

function findStaleWarnings(content, language) {
  const lines = content.split(/\r?\n/);
  const stale = [];
  const patterns = {
    javascript: /function\s+[A-Za-z_$][\w$]*\s*\(|(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
    typescript: /function\s+[A-Za-z_$][\w$]*\s*\(|(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/,
    python: /(?:async\s+)?def\s+[A-Za-z_][\w]*\s*\(/,
    go: /func\s+(?:\([^)]*\)\s*)?[A-Za-z_][\w]*\s*\(/,
    rust: /(?:pub\s+)?fn\s+[A-Za-z_][\w]*\s*\(/,
  };
  const matcher = patterns[language];
  if (!matcher) return stale;
  for (let index = 0; index < lines.length; index += 1) {
    if (!isAnnotationLine(lines[index], WARN_MARKERS)) continue;
    if (/circular dependency/i.test(lines[index])) continue;
    const window = lines.slice(index + 1, index + 5).join("\n");
    if (!matcher.test(window)) stale.push(index + 1);
  }
  return stale;
}

export function runConformity(rootDir, options = {}) {
  const scan = scanRepository(rootDir, options);
  const missingSummaries = [];
  const staleWarnings = [];
  const credentialFindings = [];
  for (const file of scan.files) {
    const content = readText(file.absolutePath);
    if (!file.hasSummary) missingSummaries.push(file.path);
    for (const lineNumber of findStaleWarnings(content, file.language)) {
      staleWarnings.push({ path: file.path, line: lineNumber });
    }
    for (const pattern of CREDENTIAL_PATTERNS) {
      const match = pattern.regex.exec(content);
      if (match) credentialFindings.push({ path: file.path, kind: pattern.name, match: match[0].slice(0, 24) });
      pattern.regex.lastIndex = 0;
    }
  }
  const staleIndexEntries = parseIndexMap(rootDir).filter((entry) => !existsSync(resolve(rootDir, entry.path)));
  const report = {
    generatedAt: new Date().toISOString(),
    ok: missingSummaries.length === 0 && staleWarnings.length === 0 && staleIndexEntries.length === 0 && credentialFindings.length === 0,
    score: Math.max(0, 100 - (missingSummaries.length * 3) - (staleWarnings.length * 7) - (staleIndexEntries.length * 5) - (credentialFindings.length * 25)),
    missingSummaries,
    staleWarnings,
    staleIndexEntries,
    credentialFindings,
  };
  const schedule = writeSchedule(rootDir, {
    filesAudited: scan.files.length,
    conformityScore: report.score,
  }, options);
  return {
    ...report,
    command: "conformity",
    schedulePath: schedule.path,
    artifactPath: writeArtifact(rootDir, "conformity-report.json", report, Boolean(options.dryRun)),
  };
}

export function migrateAnnotations(rootDir, options = {}) {
  const scan = scanRepository(rootDir, options);
  const migrateLegacyAnnotationMarkers = (content) =>
    content
      .replace(/BOSUN:SUMMARY/g, "CLAUDE:SUMMARY")
      .replace(/BOSUN:WARN/g, "CLAUDE:WARN")
      .replace(
        /^(\s*(?:\/\/|#)\s*)(?:LEGACY:)?SUMMARY\s*[:\-]\s*/gim,
        "$1CLAUDE:SUMMARY ",
      )
      .replace(
        /^(\s*(?:\/\/|#)\s*)(?:LEGACY:)?WARN(?:ING)?\s*[:\-]\s*/gim,
        "$1CLAUDE:WARN ",
      );
  const changed = updateFiles(
    scan.files,
    (file, content) => migrateLegacyAnnotationMarkers(content),
    options,
  );
  return {
    command: "migrate",
    changed,
    migrated: changed.length,
    artifactPath: writeArtifact(rootDir, "migrate-report.json", {
      generatedAt: new Date().toISOString(),
      changed,
      migrated: changed.length,
    }, Boolean(options.dryRun)),
  };
}

export function trimAuditArtifacts(rootDir, options = {}) {
  const manifest = generateManifests(rootDir, options);
  const index = buildIndexMap(rootDir, options);
  const conformity = runConformity(rootDir, options);
  const scan = scanRepository(rootDir, options);
  const schedule = writeSchedule(rootDir, {
    filesAudited: scan.files.length,
    conformityScore: conformity.score,
  }, options);
  return {
    command: "trim",
    changed: [...manifest.changed, index.path],
    conformityScore: conformity.score,
    schedulePath: schedule.path,
    artifactPath: writeArtifact(rootDir, "trim-report.json", {
      generatedAt: new Date().toISOString(),
      changed: [...manifest.changed, index.path],
      conformityScore: conformity.score,
    }, Boolean(options.dryRun)),
  };
}

function printAuditHelp(stdout) {
  stdout(`bosun audit <command> [options]\n`);
  stdout(`Commands:`);
  stdout(`  scan         Walk the repo and report annotation coverage`);
  stdout(`  generate     Add missing CLAUDE:SUMMARY headers`);
  stdout(`  warn         Add CLAUDE:WARN notes for risky functions`);
  stdout(`  manifest     Generate/update lean AGENTS.md and CLAUDE.md blocks`);
  stdout(`  index        Build INDEX.map from file responsibilities`);
  stdout(`  trim         Rebuild lean manifests and prune stale map entries`);
  stdout(`  conformity   Validate summaries, warnings, stale entries, and leaks`);
  stdout(`  migrate      Convert legacy BOSUN annotations to CLAUDE markers`);
  stdout(``);
  stdout(`Options:`);
  stdout(`  --root <dir>       Repo root to audit (default: cwd)`);
  stdout(`  --target-dir <dir> Limit scanning to a subdirectory`);
  stdout(`  --extensions <csv> Limit by extensions, e.g. .mjs,.py,.go`);
  stdout(`  --dry-run          Report planned writes without modifying files`);
  stdout(`  --json             Print machine-readable JSON result`);
  stdout(`  --staged           Limit scans to staged source files`);
  stdout(`  --ci               Alias for conformity with non-zero failure exit`);
}

function formatResult(result) {
  if (result.command === "scan") {
    return [
      `Scanned ${result.totals.files} file(s).`,
      `Missing summaries: ${result.totals.missingSummary}.`,
      `Missing warnings for detected traps: ${result.totals.missingWarn}.`,
    ];
  }
  if (result.command === "conformity") {
    return [
      `Conformity ${result.ok ? "passed" : "failed"} with score ${result.score}.`,
      `Missing summaries: ${result.missingSummaries.length}.`,
      `Stale warnings: ${result.staleWarnings.length}.`,
      `Credential findings: ${result.credentialFindings.length}.`,
    ];
  }
  if (Array.isArray(result.changed)) return [`${capitalize(result.command)} updated ${result.changed.length} path(s).`];
  return [`${capitalize(result.command)} completed.`];
}

export async function runAuditCli(argv, io = {}) {
  const stdout = io.stdout || ((line) => console.log(line));
  const stderr = io.stderr || ((line) => console.error(line));
  const { positionals, flags } = parseCliArgs(argv);
  let command = positionals[0] || "";
  if (flags.ci && !command) command = "conformity";
  if (!command || flags.help || flags.h) {
    printAuditHelp(stdout);
    return { exitCode: 0 };
  }
  const rootDir = resolve(String(flags.root || process.cwd()));
  const options = {
    dryRun: Boolean(flags["dry-run"]),
    targetDir: flags["target-dir"] || "",
    extensions: flags.extensions || "",
    staged: Boolean(flags.staged),
  };
  let result;
  switch (command) {
    case "scan":
      result = { ...scanRepository(rootDir, options), command: "scan" };
      break;
    case "generate":
      result = generateSummaries(rootDir, options);
      break;
    case "warn":
      result = generateWarnings(rootDir, options);
      break;
    case "manifest":
      result = generateManifests(rootDir, options);
      break;
    case "index":
      result = buildIndexMap(rootDir, options);
      break;
    case "trim":
      result = trimAuditArtifacts(rootDir, options);
      break;
    case "conformity":
      result = runConformity(rootDir, options);
      break;
    case "migrate":
      result = migrateAnnotations(rootDir, options);
      break;
    default:
      stderr(`Unknown audit command: ${command}`);
      printAuditHelp(stderr);
      return { exitCode: 1 };
  }
  if (flags.json) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    for (const line of formatResult(result)) stdout(line);
    if (result.artifactPath) stdout(`Artifact: ${toPosix(relative(rootDir, result.artifactPath)) || result.artifactPath}`);
  }
  const shouldFail = command === "conformity" || Boolean(flags.ci);
  return { exitCode: shouldFail && result.ok === false ? 1 : 0, result };
}

