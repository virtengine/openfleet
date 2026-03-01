import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import vm from "node:vm";

function listTopLevelModules() {
  return readdirSync(process.cwd())
    .filter((name) => name.endsWith(".mjs"))
    .sort((a, b) => a.localeCompare(b));
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

/**
 * Parse a JS file using the Module compiler.
 * Catches syntax errors such as unterminated statements or bad tokens.
 * UI files use ES module syntax (import/export) via browser importmaps.
 */
function validateScriptSyntax(filePath) {
  const source = readFileSync(filePath, "utf8");
  new vm.SourceTextModule(source, { identifier: filePath });
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

  // ── Phase 2: Parse-check UI JavaScript files ──────────────────────────
  // These are classic scripts (not ESM modules) loaded via importmap in the
  // browser.  We use vm.Script to catch syntax errors.
  const uiDir = resolve(process.cwd(), "ui");
  const uiFiles = listJsFilesRecursive(uiDir);
  let uiFailed = false;

  for (const filePath of uiFiles) {
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

  console.log(`Syntax OK: ${files.length} modules + ${uiFiles.length} UI files checked`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
