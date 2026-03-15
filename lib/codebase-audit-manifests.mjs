import { basename, dirname, extname, relative, resolve } from "node:path";

function human(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function toPosix(pathValue) {
  return String(pathValue || "").replace(/\\/g, "/");
}

function roleFromPath(relPath, content, category) {
  const base = basename(relPath, extname(relPath)).toLowerCase();
  if (category === "test") return "Covers regression and behavior checks";
  if (base === "cli") return "Routes the command-line entrypoint and subcommands";
  if (base.includes("audit")) return "Implements codebase annotation auditing and reporting";
  if (base.includes("config")) return "Loads and normalizes configuration state";
  if (base.includes("server")) return "Hosts request handling and server lifecycle logic";
  if (base.includes("hook")) return "Applies hook validation and workflow guardrails";
  if (base.includes("index")) return "Exports the directory entrypoint and shared surface area";
  if (base.includes("manager")) return "Coordinates lifecycle management and shared state";
  if (base.includes("store")) return "Persists and retrieves shared state";
  if (base.includes("parser")) return "Parses structured input into internal state";
  if (base.includes("logger")) return "Formats and emits logging output";
  if (/process\.argv|args\s*=\s*process\.argv|main\(/.test(content)) return "Runs command handling and process orchestration";
  if (/createServer|express\(|fastify\(|http\.createServer/.test(content)) return "Serves HTTP-facing runtime behavior";
  if (/readFileSync|writeFileSync|readdirSync|statSync|fs\./.test(content)) return "Performs filesystem discovery and state updates";
  const dirName = human(dirname(relPath).split("/").filter(Boolean).pop() || "repository");
  const baseName = human(base || "module");
  return `Owns ${baseName} logic for ${dirName}`;
}

export function buildSummary(file, readText) {
  const content = readText(file.absolutePath);
  const prefix = roleFromPath(file.path, content, file.category);
  const hints = [];
  if (/export\s+(async\s+)?function|module\.exports|export\s+const|pub\s+fn|^func\s+/m.test(content)) hints.push("its public API");
  if (/readFileSync|writeFileSync|mkdirSync|unlinkSync|execFileSync|spawn\(/.test(content)) hints.push("file or process side effects");
  if (/describe\(|it\(|test\(/.test(content)) hints.push("test coverage");
  const detail = hints.length > 0 ? `, including ${hints.slice(0, 2).join(" and ")}` : "";
  return `${prefix}${detail}.`;
}

export function summaryFromLine(line, fallback) {
  if (!line) return fallback;
  return line.replace(/^\s*(?:\/\/|#)\s*(?:CLAUDE|BOSUN):SUMMARY\s*/i, "").trim() || fallback;
}

export function upsertManagedBlock(existing, block) {
  const begin = "<!-- bosun-audit:begin -->";
  const end = "<!-- bosun-audit:end -->";
  if (!existing) return `${block}\n`;
  const start = existing.indexOf(begin);
  if (start !== -1) {
    const finish = existing.indexOf(end, start + begin.length);
    if (finish !== -1) {
      const updated = `${existing.slice(0, start)}${block}${existing.slice(finish + end.length)}`;
      return `${updated.trimEnd()}\n`;
    }
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}

export function buildClaudeManifest(dirPath, entries, repoRoot, summarizeFile) {
  const relDir = toPosix(relative(repoRoot, dirPath)) || ".";
  const lines = [
    "<!-- bosun-audit:begin -->",
    "# CLAUDE.md",
    "",
    "## Protocol",
    `- Start with \`grep -R \"CLAUDE:SUMMARY\" ${relDir === "." ? "." : relDir}\`.`,
    "- Read files with warnings before editing adjacent code.",
    "- Treat this file as a fast map, not exhaustive prose.",
    "",
    "## Files",
  ];
  for (const entry of entries.slice(0, 12)) {
    const relFile = toPosix(relative(dirPath, resolve(repoRoot, entry.path))) || basename(entry.path);
    lines.push(`- \`${relFile}\` - ${summaryFromLine(entry.summaryLine, summarizeFile(entry))}`);
  }
  if (entries.length > 12) lines.push(`- Remaining files: ${entries.length - 12} (see \`INDEX.map\`).`);
  lines.push("", "## Validation", "- Run \`bosun audit conformity\` after documentation-only updates.", "- Regenerate with \`bosun audit manifest\` when file responsibilities change.", "<!-- bosun-audit:end -->");
  return lines.join("\n");
}

export function buildAgentsManifest(dirPath, entries, repoRoot, summarizeFile) {
  const relDir = toPosix(relative(repoRoot, dirPath)) || ".";
  const scope = relDir === "." ? "repository root" : relDir;
  const lines = [
    "<!-- bosun-audit:begin -->",
    "# AGENTS.md",
    "",
    "## Scope",
    `Audit-managed quick guide for \`${scope}\`. Keep edits documentation-only unless deeper instructions say otherwise.`,
    "",
    "## Start Files",
  ];
  for (const entry of entries.slice(0, 8)) {
    lines.push(`- \`${basename(entry.path)}\` - ${summaryFromLine(entry.summaryLine, summarizeFile(entry))}`);
  }
  lines.push(
    "",
    "## Workflow",
    "- Read \`CLAUDE.md\` before broad file discovery.",
    "- Prefer \`grep CLAUDE:SUMMARY\` over opening whole directories.",
    "- Re-run \`bosun audit index\` after annotation updates.",
    "",
    "## Validation",
    "- \`bosun audit conformity\`",
    "- \`bosun audit trim\` when manifests drift or grow stale",
    "<!-- bosun-audit:end -->",
  );
  return lines.join("\n");
}
