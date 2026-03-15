import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { execSync } from "node:child_process";
import vm from "node:vm";

function listTopLevelModules() {
  try {
    // Use git ls-files so untracked WIP files with syntax errors don't block commits.
    // --cached: include staged files (new files added with git add)
    // --others --exclude-standard: also include untracked non-ignored files? No — just cached.
    const output = execSync("git ls-files --cached", {
      encoding: "utf8",
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.endsWith(".mjs") && !f.includes("/")) // top-level only
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // Fallback if not in a git repo
    return readdirSync(process.cwd())
      .filter((name) => name.endsWith(".mjs"))
      .sort((a, b) => a.localeCompare(b));
  }
}

/**
 * Recursively collect *.js files from a directory.
 */
function listJsFilesRecursive(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip vendor directories — those are third-party bundles
      if (entry.name === "vendor" || entry.name === "node_modules") continue;
      results.push(...listJsFilesRecursive(fullPath));
    } else if (entry.name.endsWith(".js")) {
      results.push(fullPath);
    }
  }
  return results;
}

function validateModuleSyntax(filePath) {
  const source = readFileSync(filePath, "utf8");
  // Construction parses source and throws on syntax errors without executing module code.
  new vm.SourceTextModule(source, { identifier: filePath });
}

function validateBrowserModuleSyntax(filePath) {
  const source = readFileSync(filePath, "utf8");
  const mod = new vm.SourceTextModule(source, { identifier: filePath });
  if (typeof mod.hasTopLevelAwait === "function" && mod.hasTopLevelAwait()) {
    throw new Error(
      "Top-level await is not allowed in browser-served modules because embedded WebViews can fail with 'Unexpected reserved word'.",
    );
  }
}

/**
 * Parse a JS file using the Module compiler.
 * Catches syntax errors such as unterminated statements or bad tokens.
 * UI files use ES module syntax (import/export) via browser importmaps.
 */
function validateScriptSyntax(filePath) {
  validateBrowserModuleSyntax(filePath);
}

async function main() {
  if (typeof vm.SourceTextModule !== "function") {
    throw new Error(
      "vm.SourceTextModule is unavailable. Run with --experimental-vm-modules.",
    );
  }

  const files = listTopLevelModules();
  let failed = false;

  for (const file of files) {
    const filePath = resolve(process.cwd(), file);
    try {
      validateModuleSyntax(filePath);
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Syntax error: ${file}`);
      console.error(message);
    }
  }

  if (failed) {
    process.exit(1);
  }

  // ── Phase 2: Parse-check browser JavaScript files ─────────────────────
  // These files are loaded directly in the browser via import maps. Keep
  // them free of syntax that older embedded WebViews reject at parse time.
  const browserRoots = [
    resolve(process.cwd(), "ui"),
    resolve(process.cwd(), "site", "ui"),
  ];
  const browserFiles = [...new Set(browserRoots.flatMap((dir) => listJsFilesRecursive(dir)))];
  let uiFailed = false;

  for (const filePath of browserFiles) {
    try {
      validateScriptSyntax(filePath);
    } catch (error) {
      uiFailed = true;
      const rel = relative(process.cwd(), filePath);
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Syntax error: ${rel}`);
      console.error(message);
    }
  }

  if (uiFailed) {
    process.exit(1);
  }

  console.log(`Syntax OK: ${files.length} modules + ${browserFiles.length} browser files checked`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
