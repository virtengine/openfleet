/**
 * shared-knowledge.mjs — Agent-to-agent knowledge sharing for openfleet.
 *
 * Allows agents across the fleet to contribute lessons learned, patterns,
 * and critical findings to a shared knowledge base (AGENTS.md or a
 * designated knowledge file).
 *
 * Features:
 *   - Append-only knowledge entries with dedup
 *   - Structured entry format with metadata (agent, timestamp, scope)
 *   - Git-conflict-safe appending (append to dedicated section)
 *   - Rate limiting to prevent spam
 *   - Entry validation before write
 *
 * Knowledge entries are appended to a `## Agent Learnings` section at the
 * bottom of the target file (default: AGENTS.md).
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, basename } from "node:path";
import crypto from "node:crypto";

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SECTION_HEADER = "## Agent Learnings";
const DEFAULT_TARGET_FILE = "AGENTS.md";
const ENTRY_SEPARATOR = "\n---\n";
const MAX_ENTRY_LENGTH = 2000; // chars
const MIN_ENTRY_LENGTH = 20; // chars
const RATE_LIMIT_MS = 30_000; // 30s between entries from same agent

// ── State ────────────────────────────────────────────────────────────────────

const knowledgeState = {
  repoRoot: null,
  targetFile: DEFAULT_TARGET_FILE,
  sectionHeader: DEFAULT_SECTION_HEADER,
  entriesWritten: 0,
  lastWriteAt: null,
  entryHashes: new Set(), // dedup
};

// ── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize the shared knowledge system.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - Git repository root
 * @param {string} [opts.targetFile] - File to append to (default: AGENTS.md)
 * @param {string} [opts.sectionHeader] - Markdown section header for learnings
 */
export function initSharedKnowledge(opts = {}) {
  knowledgeState.repoRoot = opts.repoRoot || process.cwd();
  knowledgeState.targetFile = opts.targetFile || DEFAULT_TARGET_FILE;
  knowledgeState.sectionHeader = opts.sectionHeader || DEFAULT_SECTION_HEADER;
}

// ── Entry Format ─────────────────────────────────────────────────────────────

/**
 * Build a knowledge entry object.
 *
 * @param {object} opts
 * @param {string} opts.content - The actual learning / insight
 * @param {string} [opts.scope] - Area of the codebase (e.g., "veid", "market")
 * @param {string} [opts.agentId] - Instance/agent identifier
 * @param {string} [opts.agentType] - "codex" | "copilot" | "human"
 * @param {string} [opts.category] - "pattern" | "gotcha" | "perf" | "security" | "convention"
 * @param {string} [opts.taskRef] - VK task ID or branch name reference
 * @returns {object} entry
 */
export function buildKnowledgeEntry(opts = {}) {
  const {
    content,
    scope = null,
    agentId = "unknown",
    agentType = "codex",
    category = "pattern",
    taskRef = null,
  } = opts;

  return {
    content: String(content || "").trim(),
    scope,
    agentId,
    agentType,
    category,
    taskRef,
    timestamp: new Date().toISOString(),
    hash: hashEntry(content, scope),
  };
}

/**
 * Format a knowledge entry as Markdown for appending to file.
 */
export function formatEntryAsMarkdown(entry) {
  const lines = [];
  const datePart =
    entry.timestamp?.split("T")[0] || new Date().toISOString().split("T")[0];
  const scopePart = entry.scope ? ` (${entry.scope})` : "";
  const catPart = entry.category ? `[${entry.category}]` : "";
  const taskPart = entry.taskRef ? ` • ref: \`${entry.taskRef}\`` : "";

  lines.push(`### ${catPart}${scopePart} — ${datePart}${taskPart}`);
  lines.push("");
  lines.push(`> **Agent:** ${entry.agentId} (${entry.agentType})`);
  lines.push("");
  lines.push(entry.content);
  lines.push("");

  return lines.join("\n");
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate a knowledge entry before writing.
 * Returns { valid: boolean, reason?: string }.
 */
export function validateEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return { valid: false, reason: "entry must be an object" };
  }

  const content = String(entry.content || "").trim();
  if (content.length < MIN_ENTRY_LENGTH) {
    return {
      valid: false,
      reason: `content too short (min ${MIN_ENTRY_LENGTH} chars)`,
    };
  }
  if (content.length > MAX_ENTRY_LENGTH) {
    return {
      valid: false,
      reason: `content too long (max ${MAX_ENTRY_LENGTH} chars)`,
    };
  }

  // Check for obviously low-value entries
  const lowValuePatterns = [
    /^(ok|done|yes|no|maybe|test|todo|fixme|hack)$/i,
    /^[^a-zA-Z]*$/, // no letters at all
    /(.)\1{20,}/, // 20+ repeated chars
  ];
  for (const pat of lowValuePatterns) {
    if (pat.test(content)) {
      return { valid: false, reason: "entry appears to be low-value or noise" };
    }
  }

  // Validate category
  const validCategories = [
    "pattern",
    "gotcha",
    "perf",
    "security",
    "convention",
    "tip",
    "bug",
  ];
  if (entry.category && !validCategories.includes(entry.category)) {
    return {
      valid: false,
      reason: `invalid category — must be one of: ${validCategories.join(", ")}`,
    };
  }

  return { valid: true };
}

// ── Deduplication ────────────────────────────────────────────────────────────

function hashEntry(content, scope) {
  const data = `${scope || ""}|${String(content || "")
    .trim()
    .toLowerCase()}`;
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

/**
 * Check if an entry with this content already exists (in-memory dedup).
 */
export function isDuplicate(entry) {
  return knowledgeState.entryHashes.has(entry.hash);
}

/**
 * Load existing entry hashes from the target file for dedup.
 */
async function loadExistingHashes() {
  const filePath = resolve(knowledgeState.repoRoot, knowledgeState.targetFile);
  if (!existsSync(filePath)) return;

  try {
    const content = await readFile(filePath, "utf8");
    // Extract content blocks from Agent Learnings section
    const sectionIdx = content.indexOf(knowledgeState.sectionHeader);
    if (sectionIdx === -1) return;

    const sectionContent = content.slice(sectionIdx);
    // Parse each learning entry (between ### headers)
    const entries = sectionContent.split(/^### /m).slice(1);
    for (const block of entries) {
      // Extract the content after the metadata lines
      const lines = block.split("\n");
      const contentLines = lines.filter(
        (l) =>
          !l.startsWith(">") &&
          !l.startsWith("###") &&
          !l.startsWith("---") &&
          l.trim().length > 0,
      );
      const entryContent = contentLines.join(" ").trim();
      if (entryContent) {
        // Extract scope from header if present
        const scopeMatch = lines[0]?.match(/\(([^)]+)\)/);
        const scope = scopeMatch?.[1] || null;
        const hash = hashEntry(entryContent, scope);
        knowledgeState.entryHashes.add(hash);
      }
    }
  } catch {
    // file read error — skip
  }
}

// ── Write ────────────────────────────────────────────────────────────────────

/**
 * Append a knowledge entry to the target file.
 *
 * @param {object} entry - From buildKnowledgeEntry()
 * @returns {object} { success: boolean, reason?: string }
 */
export async function appendKnowledgeEntry(entry) {
  // Validate
  const validation = validateEntry(entry);
  if (!validation.valid) {
    return { success: false, reason: validation.reason };
  }

  // Rate limit
  if (knowledgeState.lastWriteAt) {
    const elapsed = Date.now() - knowledgeState.lastWriteAt;
    if (elapsed < RATE_LIMIT_MS) {
      return {
        success: false,
        reason: `rate limited — wait ${Math.ceil((RATE_LIMIT_MS - elapsed) / 1000)}s`,
      };
    }
  }

  // Dedup check
  await loadExistingHashes();
  if (isDuplicate(entry)) {
    return { success: false, reason: "duplicate entry — already recorded" };
  }

  // Format
  const markdown = formatEntryAsMarkdown(entry);

  // Append to file
  const filePath = resolve(knowledgeState.repoRoot, knowledgeState.targetFile);
  try {
    let content = "";
    if (existsSync(filePath)) {
      content = await readFile(filePath, "utf8");
    }

    // Find or create the section
    const sectionIdx = content.indexOf(knowledgeState.sectionHeader);
    if (sectionIdx === -1) {
      // Append section at end of file
      const newContent =
        content.trimEnd() +
        "\n\n" +
        knowledgeState.sectionHeader +
        "\n\n" +
        markdown +
        ENTRY_SEPARATOR;
      await writeFile(filePath, newContent, "utf8");
    } else {
      // Append at end of existing section (before any next ## header or EOF)

      const afterSection = content.slice(
        sectionIdx + knowledgeState.sectionHeader.length,
      );
      // Find next top-level heading (## but not ###)
      const nextSectionMatch = afterSection.match(/\n## [^#]/);
      if (nextSectionMatch) {
        const insertPos =

          sectionIdx +
          knowledgeState.sectionHeader.length +
          nextSectionMatch.index;
        const before = content.slice(0, insertPos);
        const after = content.slice(insertPos);
        await writeFile(
          filePath,
          before + "\n" + markdown + ENTRY_SEPARATOR + after,
          "utf8",
        );
      } else {
        // Append at end of file
        await writeFile(
          filePath,
          content.trimEnd() + "\n\n" + markdown + ENTRY_SEPARATOR,
          "utf8",
        );
      }
    }

    // Track
    knowledgeState.entryHashes.add(entry.hash);
    knowledgeState.entriesWritten++;
    knowledgeState.lastWriteAt = Date.now();

    return { success: true, hash: entry.hash };
  } catch (err) {
    return { success: false, reason: `write error: ${err.message}` };
  }
}

// ── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read all knowledge entries from the target file.
 * Returns structured entries, not raw markdown.
 */
export async function readKnowledgeEntries() {
  const filePath = resolve(knowledgeState.repoRoot, knowledgeState.targetFile);
  if (!existsSync(filePath)) return [];

  try {
    const content = await readFile(filePath, "utf8");
    const sectionIdx = content.indexOf(knowledgeState.sectionHeader);
    if (sectionIdx === -1) return [];


    const sectionContent = content.slice(
      sectionIdx + knowledgeState.sectionHeader.length,
    );
    // Find next top-level heading
    const nextSectionMatch = sectionContent.match(/\n## [^#]/);
    const relevantContent = nextSectionMatch
      ? sectionContent.slice(0, nextSectionMatch.index)
      : sectionContent;

    const blocks = relevantContent.split(/^### /m).slice(1);
    const entries = [];

    for (const block of blocks) {
      const lines = block.split("\n");
      const header = lines[0] || "";

      // Parse header: [category](scope) — date • ref: `taskRef`
      const catMatch = header.match(/^\[([^\]]+)\]/);
      const scopeMatch = header.match(/\(([^)]+)\)/);
      const dateMatch = header.match(/(\d{4}-\d{2}-\d{2})/);
      const refMatch = header.match(/ref: `([^`]+)`/);

      // Parse agent line
      const agentLine = lines.find((l) => l.startsWith("> **Agent:**"));
      const agentMatch = agentLine?.match(/\*\*Agent:\*\* ([^ ]+) \(([^)]+)\)/);

      // Extract content

      const contentLines = lines
        .filter(
          (l) =>
            !l.startsWith(">") && l.trim().length > 0 && !l.startsWith("---"),
        )
        .slice(1); // skip header line

      entries.push({
        category: catMatch?.[1] || "unknown",
        scope: scopeMatch?.[1] || null,
        date: dateMatch?.[1] || null,
        taskRef: refMatch?.[1] || null,
        agentId: agentMatch?.[1] || "unknown",
        agentType: agentMatch?.[2] || "unknown",
        content: contentLines.join("\n").trim(),
      });
    }

    return entries;
  } catch {
    return [];
  }
}

// ── Getters ──────────────────────────────────────────────────────────────────

export function getKnowledgeState() {
  return { ...knowledgeState, entryHashes: knowledgeState.entryHashes.size };
}

export function formatKnowledgeSummary() {
  return [
    `📚 Shared Knowledge: ${knowledgeState.entriesWritten} entries written this session`,
    `Target: ${knowledgeState.targetFile}`,
    `Dedup cache: ${knowledgeState.entryHashes.size} hashes`,
    knowledgeState.lastWriteAt
      ? `Last write: ${new Date(knowledgeState.lastWriteAt).toISOString()}`
      : "No writes this session",
  ].join("\n");
}
