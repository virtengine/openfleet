/**
 * diff-stats.mjs — Collects git diff statistics and patch hunks for review UIs.
 *
 * @module diff-stats
 */

import { spawnSync } from "node:child_process";

const TAG = "[diff-stats]";

/**
 * @typedef {Object} DiffLine
 * @property {"context"|"addition"|"deletion"|"meta"} type
 * @property {number|null} oldNumber
 * @property {number|null} newNumber
 * @property {string} marker
 * @property {string} content
 * @property {string} raw
 */

/**
 * @typedef {Object} DiffHunk
 * @property {string} header
 * @property {number} oldStart
 * @property {number} oldLines
 * @property {number} newStart
 * @property {number} newLines
 * @property {DiffLine[]} lines
 */

/**
 * @typedef {Object} FileChangeStats
 * @property {string} file
 * @property {string} filename
 * @property {string} oldFilename
 * @property {string} newFilename
 * @property {string} status
 * @property {number} additions
 * @property {number} deletions
 * @property {boolean} binary
 * @property {string} patch
 * @property {DiffHunk[]} hunks
 */

/**
 * @typedef {Object} DiffStats
 * @property {FileChangeStats[]} files
 * @property {number} totalFiles
 * @property {number} totalAdditions
 * @property {number} totalDeletions
 * @property {string} formatted
 * @property {string} [sourceRange]
 */

/**
 * Collect diff stats for a worktree and optionally include parsed hunks.
 *
 * @param {string} worktreePath
 * @param {Object} [options]
 * @param {string} [options.baseBranch="origin/main"]
 * @param {string} [options.targetRef="HEAD"]
 * @param {string} [options.range]
 * @param {number} [options.timeoutMs=30000]
 * @param {boolean} [options.includePatch=false]
 * @param {number} [options.contextLines=3]
 * @returns {DiffStats}
 */
export function collectDiffStats(worktreePath, options = {}) {
  const {
    baseBranch = "origin/main",
    targetRef = "HEAD",
    range = "",
    timeoutMs = 30_000,
    includePatch = false,
    contextLines = 3,
  } = options;

  const candidates = buildRangeCandidates({ baseBranch, targetRef, range });

  for (const candidate of candidates) {
    const result = collectDiffForRange(worktreePath, candidate, {
      timeoutMs,
      includePatch,
      contextLines,
    });
    if (result) return result;
  }

  return emptyDiffStats("(no diff stats available)");
}

/**
 * Get a compact string summary of diff stats.
 *
 * @param {string} worktreePath
 * @param {Object} [options]
 * @returns {string}
 */
export function getCompactDiffSummary(worktreePath, options = {}) {
  const stats = collectDiffStats(worktreePath, options);
  return stats.formatted;
}

/**
 * Get the recent commits on the current branch (vs origin/main when available).
 *
 * @param {string} worktreePath
 * @param {number} [maxCommits=10]
 * @returns {string[]}
 */
export function getRecentCommits(worktreePath, maxCommits = 10) {
  try {
    const result = spawnSync(
      "git",
      ["log", "--oneline", `--max-count=${maxCommits}`, "origin/main..HEAD"],
      { cwd: worktreePath, encoding: "utf8", timeout: 10_000 },
    );

    if (result.status === 0 && (result.stdout || "").trim()) {
      return result.stdout.trim().split("\n").filter(Boolean);
    }

    const fallback = spawnSync(
      "git",
      ["log", "--oneline", `--max-count=${maxCommits}`],
      { cwd: worktreePath, encoding: "utf8", timeout: 10_000 },
    );

    if (fallback.status === 0 && (fallback.stdout || "").trim()) {
      return fallback.stdout.trim().split("\n").filter(Boolean);
    }
  } catch (err) {
    console.warn(`${TAG} getRecentCommits error: ${err.message}`);
  }

  return [];
}

/**
 * Parse a unified diff string into file + hunk structures suitable for review UIs.
 *
 * @param {string} rawDiff
 * @returns {FileChangeStats[]}
 */
export function parseUnifiedDiff(rawDiff) {
  if (!rawDiff || !String(rawDiff).trim()) return [];
  const text = String(rawDiff).replace(/\r\n/g, "\n");
  const lines = text.split("\n");

  const files = [];
  let currentFile = null;
  let currentHunk = null;

  const pushCurrentFile = () => {
    if (!currentFile) return;
    finalizeParsedFile(currentFile);
    files.push(currentFile);
    currentFile = null;
    currentHunk = null;
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      pushCurrentFile();
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      currentFile = {
        file: "",
        filename: "",
        oldFilename: match?.[1] || "",
        newFilename: match?.[2] || "",
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        patch: "",
        hunks: [],
        headers: [line],
        patchLines: [line],
      };
      continue;
    }

    if (!currentFile) continue;
    currentFile.patchLines.push(line);

    if (line.startsWith("new file mode ")) {
      currentFile.status = "added";
      currentFile.headers.push(line);
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      currentFile.status = "deleted";
      currentFile.headers.push(line);
      continue;
    }
    if (line.startsWith("rename from ")) {
      currentFile.status = "renamed";
      currentFile.oldFilename = line.slice("rename from ".length).trim();
      currentFile.headers.push(line);
      continue;
    }
    if (line.startsWith("rename to ")) {
      currentFile.status = "renamed";
      currentFile.newFilename = line.slice("rename to ".length).trim();
      currentFile.headers.push(line);
      continue;
    }
    if (line.startsWith("copy from ")) {
      currentFile.status = "copied";
      currentFile.oldFilename = line.slice("copy from ".length).trim();
      currentFile.headers.push(line);
      continue;
    }
    if (line.startsWith("copy to ")) {
      currentFile.status = "copied";
      currentFile.newFilename = line.slice("copy to ".length).trim();
      currentFile.headers.push(line);
      continue;
    }
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      currentFile.binary = true;
      currentFile.headers.push(line);
      continue;
    }
    if (line.startsWith("index ") || line.startsWith("similarity index ") || line.startsWith("dissimilarity index ")) {
      currentFile.headers.push(line);
      continue;
    }
    if (line.startsWith("--- ")) {
      currentFile.oldFilename = normalizeDiffPath(parsePatchFilename(line.slice(4)));
      currentFile.headers.push(line);
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentFile.newFilename = normalizeDiffPath(parsePatchFilename(line.slice(4)));
      currentFile.headers.push(line);
      continue;
    }
    if (line.startsWith("@@ ")) {
      currentHunk = createHunk(line);
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) {
      currentFile.headers.push(line);
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentFile.additions += 1;
      currentHunk.lines.push({
        type: "addition",
        oldNumber: null,
        newNumber: currentHunk.nextNewNumber,
        marker: "+",
        content: line.slice(1),
        raw: line,
      });
      currentHunk.nextNewNumber += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      currentFile.deletions += 1;
      currentHunk.lines.push({
        type: "deletion",
        oldNumber: currentHunk.nextOldNumber,
        newNumber: null,
        marker: "-",
        content: line.slice(1),
        raw: line,
      });
      currentHunk.nextOldNumber += 1;
      continue;
    }
    if (line.startsWith("\\ No newline at end of file")) {
      currentHunk.lines.push({
        type: "meta",
        oldNumber: null,
        newNumber: null,
        marker: "\\",
        content: line,
        raw: line,
      });
      continue;
    }

    const content = line.startsWith(" ") ? line.slice(1) : line;
    currentHunk.lines.push({
      type: "context",
      oldNumber: currentHunk.nextOldNumber,
      newNumber: currentHunk.nextNewNumber,
      marker: " ",
      content,
      raw: line,
    });
    currentHunk.nextOldNumber += 1;
    currentHunk.nextNewNumber += 1;
  }

  pushCurrentFile();
  return files;
}

function emptyDiffStats(formatted) {
  return {
    files: [],
    totalFiles: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    formatted,
  };
}

function buildRangeCandidates({ baseBranch, targetRef, range }) {
  if (String(range || "").trim()) {
    return [{ range: String(range).trim() }];
  }

  const target = String(targetRef || "HEAD").trim() || "HEAD";
  const targets = buildTargetCandidates(target);
  const bases = buildBaseCandidates(baseBranch);

  const candidates = [];
  for (const base of bases) {
    for (const candidateTarget of targets) {
      candidates.push({ range: `${base}...${candidateTarget}` });
      if (candidateTarget !== "HEAD") {
        candidates.push({ range: `${base}..${candidateTarget}` });
      }
    }
  }

  if (target === "HEAD") {
    candidates.push({ range: "HEAD~10...HEAD" });
    candidates.push({ range: "HEAD" });
  }

  return dedupeByRange(candidates);
}

function buildBaseCandidates(baseBranch) {
  const raw = String(baseBranch || "").trim() || "origin/main";
  const out = [raw];
  if (raw.startsWith("origin/")) {
    out.push(raw.slice("origin/".length));
  } else if (!raw.includes("/")) {
    out.push(`origin/${raw}`);
  }
  return dedupeStrings(out);
}

function buildTargetCandidates(targetRef) {
  const raw = String(targetRef || "").trim() || "HEAD";
  if (raw === "HEAD") return ["HEAD"];
  const out = [raw];
  if (!raw.includes("/")) out.push(`origin/${raw}`);
  return dedupeStrings(out);
}

function dedupeStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeByRange(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = String(item?.range || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectDiffForRange(worktreePath, candidate, options = {}) {
  const range = String(candidate?.range || "").trim();
  if (!range) return null;

  const patchFiles = options.includePatch
    ? tryPatch(worktreePath, range, options.timeoutMs, options.contextLines)
    : null;
  const statFiles =
    tryNumstat(worktreePath, range, options.timeoutMs) ||
    tryStat(worktreePath, range, options.timeoutMs) ||
    [];

  const combined = buildCombinedFiles(statFiles, patchFiles?.files || []);
  if (!combined.length) return null;

  return buildResult(combined, {
    sourceRange: range,
  });
}

function tryNumstat(cwd, range, timeoutMs) {
  try {
    const result = spawnSync(
      "git",
      ["diff", "--find-renames", "--find-copies", "--numstat", range],
      { cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] },
    );

    if (result.status !== 0 || !(result.stdout || "").trim()) return null;

    const files = [];
    for (const line of result.stdout.trim().split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 3) continue;
      const [addStr, delStr, ...fileParts] = parts;
      const file = fileParts.join("\t");
      if (addStr === "-" && delStr === "-") {
        files.push({
          file,
          filename: file,
          oldFilename: file,
          newFilename: file,
          status: "modified",
          additions: 0,
          deletions: 0,
          binary: true,
          patch: "",
          hunks: [],
        });
      } else {
        files.push({
          file,
          filename: file,
          oldFilename: file,
          newFilename: file,
          status: "modified",
          additions: parseInt(addStr, 10) || 0,
          deletions: parseInt(delStr, 10) || 0,
          binary: false,
          patch: "",
          hunks: [],
        });
      }
    }

    return files.length ? files : null;
  } catch {
    return null;
  }
}

function tryStat(cwd, range, timeoutMs) {
  try {
    const result = spawnSync(
      "git",
      ["diff", "--find-renames", "--find-copies", "--stat", range],
      { cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] },
    );

    if (result.status !== 0 || !(result.stdout || "").trim()) return null;

    const files = [];
    const lines = result.stdout.trim().split("\n");
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const pipeIndex = line.lastIndexOf("|");
      if (pipeIndex === -1) continue;
      const file = line.slice(0, pipeIndex).trim();
      const statsStr = line.slice(pipeIndex + 1).trim();
      if (statsStr.startsWith("Bin")) {
        files.push({
          file,
          filename: file,
          oldFilename: file,
          newFilename: file,
          status: "modified",
          additions: 0,
          deletions: 0,
          binary: true,
          patch: "",
          hunks: [],
        });
      } else {
        files.push({
          file,
          filename: file,
          oldFilename: file,
          newFilename: file,
          status: "modified",
          additions: (statsStr.match(/\+/g) || []).length,
          deletions: (statsStr.match(/-/g) || []).length,
          binary: false,
          patch: "",
          hunks: [],
        });
      }
    }

    return files.length ? files : null;
  } catch {
    return null;
  }
}

function tryPatch(cwd, range, timeoutMs, contextLines = 3) {
  try {
    const result = spawnSync(
      "git",
      [
        "diff",
        "--find-renames",
        "--find-copies",
        "--no-ext-diff",
        "--no-color",
        `--unified=${Math.max(0, Number(contextLines) || 3)}`,
        range,
      ],
      { cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["pipe", "pipe", "pipe"] },
    );

    if (result.status !== 0 || !(result.stdout || "").trim()) return null;
    const rawPatch = result.stdout.replace(/\r\n/g, "\n");
    return {
      rawPatch,
      files: parseUnifiedDiff(rawPatch),
    };
  } catch (err) {
    console.warn(`${TAG} tryPatch error: ${err.message}`);
    return null;
  }
}

function buildCombinedFiles(statFiles = [], patchFiles = []) {
  const normalizedStatFiles = Array.isArray(statFiles) ? statFiles : [];
  const normalizedPatchFiles = Array.isArray(patchFiles) ? patchFiles : [];
  const byKey = new Map();

  const upsert = (file) => {
    if (!file) return;
    const keys = buildFileLookupKeys(file);
    let target = null;
    for (const key of keys) {
      if (byKey.has(key)) {
        target = byKey.get(key);
        break;
      }
    }
    if (!target) {
      target = {
        file: "",
        filename: "",
        oldFilename: "",
        newFilename: "",
        status: "modified",
        additions: 0,
        deletions: 0,
        binary: false,
        patch: "",
        hunks: [],
      };
    }
    mergeFileData(target, file);
    for (const key of keys) {
      byKey.set(key, target);
    }
  };

  for (const patchFile of normalizedPatchFiles) upsert(patchFile);
  for (const statFile of normalizedStatFiles) upsert(statFile);

  const unique = [];
  const seen = new Set();
  for (const file of byKey.values()) {
    finalizeParsedFile(file);
    const key = buildStableFileKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(file);
  }
  return unique;
}

function mergeFileData(target, source) {
  if (source.file) target.file = source.file;
  if (source.filename) target.filename = source.filename;
  if (source.oldFilename) target.oldFilename = source.oldFilename;
  if (source.newFilename) target.newFilename = source.newFilename;
  if (source.status && (target.status === "modified" || target.status === "unknown")) {
    target.status = source.status;
  }
  if (source.status && source.status !== "modified") {
    target.status = source.status;
  }
  if (typeof source.additions === "number") target.additions = Math.max(target.additions, source.additions);
  if (typeof source.deletions === "number") target.deletions = Math.max(target.deletions, source.deletions);
  target.binary = Boolean(target.binary || source.binary);
  if (source.patch) target.patch = source.patch;
  if (Array.isArray(source.hunks) && source.hunks.length) target.hunks = source.hunks;
}

function buildFileLookupKeys(file) {
  const values = [
    file?.filename,
    file?.file,
    file?.newFilename,
    file?.oldFilename,
  ].map((value) => normalizeDiffPath(value)).filter(Boolean);
  return values.length ? values : [buildStableFileKey(file)];
}

function buildStableFileKey(file) {
  return normalizeDiffPath(file?.filename || file?.file || file?.newFilename || file?.oldFilename || "unknown");
}

function finalizeParsedFile(file) {
  if (!file || typeof file !== "object") return file;
  file.oldFilename = normalizeDiffPath(file.oldFilename);
  file.newFilename = normalizeDiffPath(file.newFilename);

  if (!file.filename) {
    if (file.status === "deleted") file.filename = file.oldFilename || file.newFilename;
    else file.filename = file.newFilename || file.oldFilename;
  }
  file.filename = normalizeDiffPath(file.filename);
  if (!file.file) file.file = file.filename;

  if (!file.status || file.status === "modified") {
    if (file.oldFilename === "/dev/null" || (file.oldFilename === "" && file.newFilename)) file.status = "added";
    else if (file.newFilename === "/dev/null" || (file.newFilename === "" && file.oldFilename)) file.status = "deleted";
    else if (file.oldFilename && file.newFilename && file.oldFilename !== file.newFilename) file.status = "renamed";
    else file.status = "modified";
  }

  if (!file.patch) {
    const patchLines = Array.isArray(file.patchLines) ? file.patchLines : [];
    file.patch = patchLines.join("\n").trim();
  }

  if (!Array.isArray(file.hunks)) file.hunks = [];
  for (const hunk of file.hunks) {
    delete hunk.nextOldNumber;
    delete hunk.nextNewNumber;
  }
  delete file.headers;
  delete file.patchLines;
  return file;
}

function createHunk(header) {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header);
  const oldStart = Number(match?.[1] || 0);
  const oldLines = Number(match?.[2] || 1);
  const newStart = Number(match?.[3] || 0);
  const newLines = Number(match?.[4] || 1);
  return {
    header,
    oldStart,
    oldLines,
    newStart,
    newLines,
    nextOldNumber: oldStart,
    nextNewNumber: newStart,
    lines: [],
  };
}

function parsePatchFilename(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed || trimmed === "/dev/null") return trimmed;
  return trimmed.replace(/^[ab]\//, "");
}

function normalizeDiffPath(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (trimmed === "/dev/null") return trimmed;
  return trimmed.replace(/^[ab]\//, "");
}

function buildResult(files, extra = {}) {
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const file of files) {
    totalAdditions += Number(file.additions || 0);
    totalDeletions += Number(file.deletions || 0);
  }

  const sorted = [...files].sort(
    (a, b) => (Number(b.additions || 0) + Number(b.deletions || 0)) - (Number(a.additions || 0) + Number(a.deletions || 0)),
  );

  const maxNameLen = Math.max(...sorted.map((file) => (file.filename || file.file || "").length), 10);

  const lines = sorted.map((file) => {
    const name = String(file.filename || file.file || "").padEnd(maxNameLen);
    if (file.binary) return `  ${name}  (binary)`;
    const add = `+${Number(file.additions || 0)}`.padStart(6);
    const del = `-${Number(file.deletions || 0)}`.padStart(6);
    return `  ${name} ${add} ${del}`;
  });

  const header = `${sorted.length} file(s) changed, +${totalAdditions} -${totalDeletions}`;
  return {
    files: sorted,
    totalFiles: sorted.length,
    totalAdditions,
    totalDeletions,
    formatted: `${header}\n${lines.join("\n")}`,
    ...(extra?.sourceRange ? { sourceRange: extra.sourceRange } : {}),
  };
}
