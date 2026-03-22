/**
 * apply-pr-suggestions.mjs — Batch-apply pending code-review suggestions on a PR.
 *
 * Fetches all review comments containing ```suggestion blocks, applies them to
 * the affected files, and creates a single commit on the PR branch via the
 * GitHub Git Data API (blobs → tree → commit → ref update).
 *
 * Usage:
 *   node tools/apply-pr-suggestions.mjs [--owner virtengine] [--repo bosun] <pr-number>
 *   bosun apply-suggestions <pr-number>
 *
 * Options:
 *   --owner   Repository owner (default: auto-detect from git remote)
 *   --repo    Repository name  (default: auto-detect from git remote)
 *   --dry-run Show what would be applied without committing
 *   --author  Only apply suggestions from this author (e.g. "copilot[bot]")
 *   --json    Output result as JSON
 */

import { execSync } from "node:child_process";

// ── GitHub API helper ─────────────────────────────────────────────────────────

function getToken() {
  // Try gh CLI first, then env vars
  try {
    return execSync("gh auth token", { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  }
}

async function ghApiFetch(path, options = {}) {
  const token = getToken();
  if (!token) throw new Error("No GitHub token found. Run `gh auth login` or set GITHUB_TOKEN.");
  const url = path.startsWith("http") ? path : `https://api.github.com/${path}`;
  const resp = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API ${resp.status} on ${path}: ${text}`);
  }
  return resp.json();
}

/** Paginate a list endpoint, collecting all pages. */
async function ghApiPaginate(path) {
  const results = [];
  let page = 1;
  while (true) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await ghApiFetch(`${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ── Suggestion parser ─────────────────────────────────────────────────────────

const SUGGESTION_RE = /```suggestion\r?\n([\s\S]*?)```/g;

/**
 * Parse review comments into structured suggestion objects.
 * @param {Array} comments - PR review comments from GitHub API
 * @param {string} [authorFilter] - Only include suggestions from this author
 * @returns {Array<{commentId, path, startLine, endLine, suggestedCode, author, url}>}
 */
function parseSuggestions(comments, authorFilter) {
  const suggestions = [];
  for (const comment of comments) {
    if (authorFilter && comment.user?.login !== authorFilter) continue;

    const body = comment.body || "";
    const matches = [...body.matchAll(SUGGESTION_RE)];
    if (matches.length === 0) continue;

    for (const match of matches) {
      const suggestedCode = match[1];
      // Single-line suggestions have line only; multi-line have start_line + line
      const endLine = comment.line ?? comment.original_line;
      const startLine = comment.start_line ?? comment.original_start_line ?? endLine;
      if (!endLine || !comment.path) continue;

      suggestions.push({
        commentId: comment.id,
        path: comment.path,
        startLine,
        endLine,
        suggestedCode,
        author: comment.user?.login || "unknown",
        url: comment.html_url,
      });
    }
  }
  return suggestions;
}

/**
 * Group suggestions by file path and sort within each file by endLine descending
 * so we can apply from bottom-to-top without shifting line numbers.
 */
function groupByFile(suggestions) {
  const groups = new Map();
  for (const s of suggestions) {
    if (!groups.has(s.path)) groups.set(s.path, []);
    groups.get(s.path).push(s);
  }
  // Sort each group by endLine DESC so bottom-up application preserves indices
  for (const [, arr] of groups) {
    arr.sort((a, b) => b.endLine - a.endLine);
  }
  return groups;
}

/**
 * Check for overlapping suggestions in a sorted-descending list.
 * Returns only non-overlapping suggestions (keeps first = highest line number).
 */
function removeOverlaps(sortedDesc) {
  const kept = [];
  let minLine = Infinity;
  for (const s of sortedDesc) {
    if (s.endLine < minLine) {
      kept.push(s);
      minLine = s.startLine;
    }
  }
  return kept;
}

/**
 * Apply suggestion replacements to file content.
 * Suggestions must be sorted by endLine descending.
 */
function applyToContent(content, sortedSuggestions) {
  const lines = content.split("\n");
  for (const s of sortedSuggestions) {
    // Lines are 1-indexed; convert to 0-indexed for splice
    const startIdx = s.startLine - 1;
    const count = s.endLine - s.startLine + 1;
    // Suggestion code may end with trailing newline from the code fence; strip it
    let code = s.suggestedCode;
    if (code.endsWith("\n")) code = code.slice(0, -1);
    const newLines = code.split("\n");
    lines.splice(startIdx, count, ...newLines);
  }
  return lines.join("\n");
}

// ── Git Data API commit helper ────────────────────────────────────────────────

/**
 * Create a single commit with all file changes on a branch using the Git Data API.
 * @returns {string} New commit SHA
 */
async function createBatchCommit(owner, repo, branch, fileChanges, message) {
  // 1. Get current branch head
  const ref = await ghApiFetch(`repos/${owner}/${repo}/git/refs/heads/${branch}`);
  const headSha = ref.object.sha;

  // 2. Get the tree SHA of the head commit
  const headCommit = await ghApiFetch(`repos/${owner}/${repo}/git/commits/${headSha}`);
  const baseTreeSha = headCommit.tree.sha;

  // 3. Create blobs for each changed file
  const treeItems = [];
  for (const [path, content] of fileChanges) {
    const blob = await ghApiFetch(`repos/${owner}/${repo}/git/blobs`, {
      method: "POST",
      body: { content, encoding: "utf-8" },
    });
    treeItems.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // 4. Create new tree
  const newTree = await ghApiFetch(`repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    body: { base_tree: baseTreeSha, tree: treeItems },
  });

  // 5. Create commit
  const newCommit = await ghApiFetch(`repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    body: { message, tree: newTree.sha, parents: [headSha] },
  });

  // 6. Update the branch ref
  await ghApiFetch(`repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: { sha: newCommit.sha, force: false },
  });

  return newCommit.sha;
}

// ── Repo detection ────────────────────────────────────────────────────────────

function detectOwnerRepo() {
  try {
    const url = execSync("git config --get remote.origin.url", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    // https://github.com/owner/repo.git or git@github.com:owner/repo.git
    const m = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
    if (m) return { owner: m[1], repo: m[2] };
  } catch { /* ignore */ }
  return { owner: "", repo: "" };
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Apply all pending review suggestions on a PR.
 * @param {Object} opts
 * @param {string} opts.owner - Repo owner
 * @param {string} opts.repo  - Repo name
 * @param {number} opts.prNumber - PR number
 * @param {boolean} [opts.dryRun=false] - Don't commit, just show what would be applied
 * @param {string} [opts.author] - Only apply suggestions from this author
 * @returns {Object} { applied, skipped, commitSha }
 */
export async function applyPrSuggestions({ owner, repo, prNumber, dryRun = false, author }) {
  // 1. Fetch PR info to get the branch name
  const pr = await ghApiFetch(`repos/${owner}/${repo}/pulls/${prNumber}`);
  const branch = pr.head.ref;
  const headSha = pr.head.sha;

  // 2. Fetch all review comments
  const comments = await ghApiPaginate(`repos/${owner}/${repo}/pulls/${prNumber}/comments`);

  // 3. Parse suggestions
  const suggestions = parseSuggestions(comments, author);
  if (suggestions.length === 0) {
    return { applied: 0, skipped: 0, commitSha: null, message: "No pending suggestions found." };
  }

  // 4. Group by file and remove overlaps
  const groups = groupByFile(suggestions);
  const fileChanges = new Map(); // path → new content
  let applied = 0;
  let skipped = 0;
  const appliedDetails = [];

  for (const [path, fileSuggestions] of groups) {
    // Fetch current file content from the PR branch head
    let content;
    try {
      const fileData = await ghApiFetch(
        `repos/${owner}/${repo}/contents/${encodeURIComponent(path)}?ref=${headSha}`
      );
      content = Buffer.from(fileData.content, "base64").toString("utf8");
    } catch (err) {
      console.error(`  ⚠ Could not fetch ${path}: ${err.message}`);
      skipped += fileSuggestions.length;
      continue;
    }

    // Remove overlapping suggestions
    const valid = removeOverlaps(fileSuggestions);
    skipped += fileSuggestions.length - valid.length;

    // Check if suggestions are still applicable (lines haven't changed)
    const contentLines = content.split("\n");
    const applicable = valid.filter((s) => {
      if (s.endLine > contentLines.length) return false;
      return true;
    });
    skipped += valid.length - applicable.length;

    if (applicable.length === 0) continue;

    // Apply changes
    const newContent = applyToContent(content, applicable);
    if (newContent === content) {
      skipped += applicable.length;
      continue;
    }

    fileChanges.set(path, newContent);
    applied += applicable.length;
    for (const s of applicable) {
      appliedDetails.push({
        path: s.path,
        lines: `${s.startLine}-${s.endLine}`,
        author: s.author,
        url: s.url,
      });
    }
  }

  if (applied === 0) {
    return { applied: 0, skipped, commitSha: null, message: "All suggestions were already applied or inapplicable." };
  }

  if (dryRun) {
    return { applied, skipped, commitSha: null, dryRun: true, details: appliedDetails };
  }

  // 5. Create batch commit
  const paths = [...fileChanges.keys()];
  const commitMsg = applied === 1
    ? `Apply code review suggestion\n\nApply suggestion in ${paths[0]}`
    : `Apply ${applied} code review suggestions\n\nFiles: ${paths.join(", ")}`;

  const commitSha = await createBatchCommit(owner, repo, branch, fileChanges, commitMsg);

  return { applied, skipped, commitSha, details: appliedDetails };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let owner = "";
  let repo = "";
  let prNumber = 0;
  let dryRun = false;
  let author = "";
  let jsonOut = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--owner" && args[i + 1]) { owner = args[++i]; continue; }
    if (arg === "--repo" && args[i + 1]) { repo = args[++i]; continue; }
    if (arg === "--author" && args[i + 1]) { author = args[++i]; continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--json") { jsonOut = true; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log("Usage: node tools/apply-pr-suggestions.mjs [options] <pr-number>");
      console.log("");
      console.log("Options:");
      console.log("  --owner <owner>   Repo owner (default: auto-detect)");
      console.log("  --repo <repo>     Repo name (default: auto-detect)");
      console.log("  --author <login>  Only apply from this author (e.g. copilot[bot])");
      console.log("  --dry-run         Show what would be applied without committing");
      console.log("  --json            Output result as JSON");
      process.exit(0);
    }
    if (/^\d+$/.test(arg)) { prNumber = parseInt(arg, 10); continue; }
  }

  if (!prNumber) {
    console.error("Error: PR number is required.");
    console.error("Usage: node tools/apply-pr-suggestions.mjs <pr-number>");
    process.exit(1);
  }

  if (!owner || !repo) {
    const detected = detectOwnerRepo();
    owner = owner || detected.owner;
    repo = repo || detected.repo;
  }
  if (!owner || !repo) {
    console.error("Error: Could not detect owner/repo. Use --owner and --repo flags.");
    process.exit(1);
  }

  try {
    const result = await applyPrSuggestions({ owner, repo, prNumber, dryRun, author: author || undefined });

    if (jsonOut) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.dryRun) {
        console.log(`\n  🔍 Dry run — ${result.applied} suggestion(s) would be applied:`);
        for (const d of result.details || []) {
          console.log(`     ${d.path}:${d.lines} (by ${d.author})`);
        }
      } else if (result.commitSha) {
        console.log(`\n  ✅ Applied ${result.applied} suggestion(s) in commit ${result.commitSha.slice(0, 8)}`);
        if (result.skipped) console.log(`     (${result.skipped} skipped — overlapping or inapplicable)`);
        for (const d of result.details || []) {
          console.log(`     ${d.path}:${d.lines}`);
        }
      } else {
        console.log(`\n  ℹ ${result.message}`);
      }
      console.log("");
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

// Run as CLI script
const isDirectRun = process.argv[1]?.replace(/\\/g, "/").endsWith("tools/apply-pr-suggestions.mjs");
if (isDirectRun) main();
