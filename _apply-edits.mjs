#!/usr/bin/env node
/**
 * Apply three critical edits to task-executor.mjs ON DISK.
 * Uses line-based replacement to avoid template literal escaping issues.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = resolve(__dirname, "task-executor.mjs");

const content = readFileSync(filePath, "utf8");
const lines = content.split("\n");
const originalLineCount = lines.length;
console.log(`Read ${lines.length} lines from disk`);

// ═══════════════════════════════════════════════════════════════════════
// EDIT 1: Replace _pushBranch's merge block with rebase
// ═══════════════════════════════════════════════════════════════════════

if (!content.includes("--strategy-option=theirs")) {
  console.log("EDIT 1: SKIP - Already applied");
} else {
  // Find the merge block boundaries
  const mergeStartIdx = lines.findIndex((l) =>
    l.includes("// First merge upstream main to avoid conflicts"),
  );
  const pushLineIdx = lines.findIndex((l) =>
    l.includes('"push", "--set-upstream", "origin", branch, "--no-verify"'),
  );

  if (mergeStartIdx === -1 || pushLineIdx === -1) {
    console.error("EDIT 1: FAIL - Cannot find merge block boundaries");
    console.log(`  mergeStart: ${mergeStartIdx}, pushLine: ${pushLineIdx}`);
    process.exit(1);
  }

  // Find the ");' closing of spawnSync after the push line
  let endIdx = pushLineIdx;
  for (let i = pushLineIdx + 1; i < lines.length && i < pushLineIdx + 10; i++) {
    if (lines[i].trim() === ");") {
      endIdx = i;
      break;
    }
  }

  console.log(`  Replacing lines ${mergeStartIdx + 1}-${endIdx + 1}`);

  const newLines = [
    "      // First rebase onto upstream main to keep agent's work and stay up to date.",
    "      // We use rebase instead of merge to avoid polluting the branch with merge commits",
    "      // that can wipe out agent work (as --strategy-option=theirs did before).",
    "      try {",
    '        spawnSync("git", ["fetch", "origin", "main", "--quiet"], {',
    "          cwd: worktreePath,",
    '          encoding: "utf8",',
    "          timeout: 30_000,",
    "        });",
    "        // Try rebase — this keeps agent's commits on top of latest main",
    "        const rebaseResult = spawnSync(",
    '          "git",',
    '          ["rebase", "origin/main"],',
    '          { cwd: worktreePath, encoding: "utf8", timeout: 60_000 },',
    "        );",
    "        if (rebaseResult.status !== 0) {",
    "          // Rebase failed (conflicts) — abort and push as-is",
    "          console.warn(",
    "            `${TAG} rebase failed during upstream sync — aborting rebase, will push as-is`,",
    "          );",
    '          spawnSync("git", ["rebase", "--abort"], {',
    "            cwd: worktreePath,",
    '            encoding: "utf8",',
    "            timeout: 10_000,",
    "          });",
    "        }",
    "      } catch {",
    "        /* best-effort upstream rebase */",
    "      }",
    "",
    "      // Push with --set-upstream, skip pre-push hooks.",
    "      // Use --force-with-lease after rebase since history may be rewritten.",
    "      const result = spawnSync(",
    '        "git",',
    "        [",
    '          "push",',
    '          "--set-upstream",',
    '          "--force-with-lease",',
    '          "origin",',
    "          branch,",
    '          "--no-verify",',
    "        ],",
    "        {",
    "          cwd: worktreePath,",
    '          encoding: "utf8",',
    "          timeout: 120_000, // 2 min — push can be slow",
    "          env: { ...process.env },",
    "        },",
    "      );",
  ];

  lines.splice(mergeStartIdx, endIdx - mergeStartIdx + 1, ...newLines);
  console.log("EDIT 1: OK - Replaced _pushBranch merge with rebase");
}

// ═══════════════════════════════════════════════════════════════════════
// EDIT 2: Add diff check in _createPR between Step 1 and Step 2
// ═══════════════════════════════════════════════════════════════════════

let joined = lines.join("\n");

if (joined.includes("skipping PR creation (would be empty)")) {
  console.log("EDIT 2: SKIP - Already applied");
} else {
  const step2Idx = lines.findIndex((l) =>
    l.includes("// ── Step 2: Create the PR"),
  );
  if (step2Idx === -1) {
    console.error("EDIT 2: FAIL - Cannot find Step 2 comment");
    process.exit(1);
  }

  const diffCheckLines = [
    "      // ── Step 1.5: Verify branch actually has a diff vs main ────────────",
    "      // If the branch is identical to main (0 file changes), skip PR creation.",
    "      // This prevents empty PRs from being created when merge/rebase wiped changes.",
    "      try {",
    "        const diffResult = spawnSync(",
    '          "git",',
    '          ["diff", "--name-only", "origin/main...HEAD"],',
    '          { cwd: worktreePath, encoding: "utf8", timeout: 15_000 },',
    "        );",
    '        const changedFiles = (diffResult.stdout || "").trim();',
    "        if (diffResult.status === 0 && changedFiles.length === 0) {",
    "          console.warn(",
    "            `${TAG} branch ${branch} has 0 file changes vs main — skipping PR creation (would be empty)`,",
    "          );",
    "          return null;",
    "        }",
    '        const fileCount = changedFiles.split("\\n").filter(Boolean).length;',
    "        console.log(",
    "          `${TAG} branch ${branch} has ${fileCount} changed file(s) vs main`,",
    "        );",
    "      } catch {",
    "        // If diff check fails, continue with PR creation anyway",
    "      }",
    "",
  ];

  // Insert before the Step 2 line
  lines.splice(step2Idx, 0, ...diffCheckLines);
  console.log("EDIT 2: OK - Added diff check in _createPR");
}

// ═══════════════════════════════════════════════════════════════════════
// EDIT 3: Add diff check in _recoverOrphanedWorktrees before creating PR
// ═══════════════════════════════════════════════════════════════════════

joined = lines.join("\n");

if (joined.includes("0 file changes vs main (would create empty PR)")) {
  console.log("EDIT 3: SKIP - Already applied");
} else {
  const buildMinimalIdx = lines.findIndex((l) =>
    l.includes("// Build a minimal task object for _createPR"),
  );
  if (buildMinimalIdx === -1) {
    console.error("EDIT 3: FAIL - Cannot find Build minimal task comment");
    process.exit(1);
  }

  const diffCheckOrphan = [
    "      // Verify branches actually has meaningful diff vs main BEFORE creating a PR",
    "      // This prevents empty PRs from being created when worktrees have merge artifacts.",
    "      try {",
    '        const diffCheck = execSync("git diff --name-only origin/main...HEAD", {',
    "          cwd: wtPath,",
    '          encoding: "utf8",',
    "          timeout: 15000,",
    "        }).trim();",
    "        if (diffCheck.length === 0) {",
    "          console.log(",
    "            `${TAG} [orphan-recovery] Skipping ${dirName} — 0 file changes vs main (would create empty PR)`,",
    "          );",
    "          skipped++;",
    "          continue;",
    "        }",
    '        const fileCount = diffCheck.split("\\n").filter(Boolean).length;',
    "        console.log(",
    "          `${TAG} [orphan-recovery] ${dirName} has ${fileCount} changed file(s) vs main`,",
    "        );",
    "      } catch {",
    "        // If diff check fails, skip this worktree rather than creating a potentially empty PR",
    "        console.warn(",
    "          `${TAG} [orphan-recovery] Cannot verify diff for ${dirName} — skipping`,",
    "        );",
    "        skipped++;",
    "        continue;",
    "      }",
    "",
  ];

  lines.splice(buildMinimalIdx, 0, ...diffCheckOrphan);
  console.log("EDIT 3: OK - Added diff check in _recoverOrphanedWorktrees");
}

// Write back
const final = lines.join("\n");
writeFileSync(filePath, final, "utf8");
console.log(`\nWritten ${lines.length} lines (was ${originalLineCount})`);
console.log("All edits applied.");
