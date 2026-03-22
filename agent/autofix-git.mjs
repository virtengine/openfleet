import { execSync } from "node:child_process";

export function detectChangedFiles(repoRoot) {
  try {
    const output = execSync("git diff --name-only", {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split(/\r?\n/)
      .map((filePath) => filePath.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function getChangeSummary(repoRoot, files) {
  if (!files.length) return "(no file changes detected)";
  try {
    const diff = execSync("git diff --stat", {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return diff.trim() || files.join(", ");
  } catch {
    return files.join(", ");
  }
}
