/**
 * import-check.mjs — ESM named-export validation gate.
 *
 * Uses vm.SourceTextModule.link() to validate that every named import
 * from a local module actually exists as an export in the target module.
 * This catches the class of errors where a named import is added but the
 * corresponding export doesn't exist (e.g., partial merges, abandoned WIP,
 * renames that missed a call-site).
 *
 * External dependencies (node: builtins, npm packages) are dynamically
 * imported and mirrored as SyntheticModules so that local module linking
 * succeeds without requiring the full dependency graph.
 */

import vm from "node:vm";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, relative, extname } from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const JS_EXTENSIONS = new Set([".mjs", ".js", ".cjs"]);

/**
 * Discover all .mjs source modules via git, excluding test/bench/site/desktop.
 */
function discoverModules(rootDir) {
  try {
    const output = execSync("git ls-files --cached", {
      encoding: "utf8",
      cwd: rootDir,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output
      .split("\n")
      .map((f) => f.trim())
      .filter(
        (f) =>
          f.endsWith(".mjs") &&
          !f.startsWith("tests/") &&
          !f.startsWith("bench/") &&
          !f.startsWith("site/") &&
          !f.startsWith("desktop/") &&
          !f.startsWith("tools/"),
      )
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Validate all ESM named imports by linking modules with vm.SourceTextModule.
 *
 * @param {object} [opts]
 * @param {string} [opts.rootDir] — project root (default: cwd)
 * @param {string[]} [opts.files] — explicit list of relative .mjs paths to check
 * @returns {{ errors: Array<{file: string, error: string}>, moduleCount: number }}
 */
export async function validateImports({ rootDir, files } = {}) {
  rootDir = rootDir ?? process.cwd();

  if (typeof vm.SourceTextModule !== "function") {
    throw new Error(
      "vm.SourceTextModule is unavailable. Run with --experimental-vm-modules.",
    );
  }

  const context = vm.createContext({});
  const moduleCache = new Map(); // absolute path → SourceTextModule | SyntheticModule
  const externalCache = new Map(); // specifier → SyntheticModule
  const errors = [];

  const moduleFiles = files ?? discoverModules(rootDir);

  // Phase 1: Parse all source modules into SourceTextModules.
  for (const file of moduleFiles) {
    const absPath = resolve(rootDir, file);
    if (!existsSync(absPath)) continue;
    try {
      const source = readFileSync(absPath, "utf8");
      const mod = new vm.SourceTextModule(source, {
        identifier: absPath,
        context,
      });
      moduleCache.set(absPath, mod);
    } catch {
      // Syntax errors are caught by syntax-check.mjs — skip silently.
    }
  }

  /**
   * Create a SyntheticModule stub for an external dependency.
   * Dynamically imports the real module to mirror its export names.
   */
  async function stubExternal(specifier) {
    if (externalCache.has(specifier)) return externalCache.get(specifier);

    let exportNames = ["default"];
    try {
      const real = await import(specifier);
      exportNames = Object.keys(real);
      if (!exportNames.includes("default")) exportNames.push("default");
    } catch {
      // Cannot import (optional dep, missing, etc.) — stub with default only.
    }

    const synth = new vm.SyntheticModule(
      exportNames,
      function () {
        for (const name of exportNames) this.setExport(name, undefined);
      },
      { identifier: `external:${specifier}`, context },
    );
    // SyntheticModules have no dependencies, so linker is never called.
    await synth.link(() => {});
    externalCache.set(specifier, synth);
    return synth;
  }

  /**
   * Create a SyntheticModule stub for a non-JS file (e.g., .json, .node).
   */
  async function stubNonJs(absPath) {
    if (moduleCache.has(absPath)) return moduleCache.get(absPath);

    const synth = new vm.SyntheticModule(
      ["default"],
      function () {
        this.setExport("default", undefined);
      },
      { identifier: absPath, context },
    );
    await synth.link(() => {});
    moduleCache.set(absPath, synth);
    return synth;
  }

  /**
   * Linker callback for vm.SourceTextModule.link().
   * Resolves specifiers to cached modules or creates stubs.
   */
  async function linker(specifier, referencingModule) {
    // ── External dependency (node: builtin or npm package) ──
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
      return stubExternal(specifier);
    }

    // ── Local import — resolve relative to referencing module ──
    const refDir = dirname(referencingModule.identifier);
    const resolved = resolve(refDir, specifier);

    // Already parsed / stubbed
    if (moduleCache.has(resolved)) return moduleCache.get(resolved);

    // Non-JS file (.json, .node, .wasm, etc.)
    if (!JS_EXTENSIONS.has(extname(resolved))) {
      return stubNonJs(resolved);
    }

    // JS file outside our initial scan (e.g., vendor/, tools/ dependency)
    if (existsSync(resolved)) {
      try {
        const source = readFileSync(resolved, "utf8");
        const mod = new vm.SourceTextModule(source, {
          identifier: resolved,
          context,
        });
        moduleCache.set(resolved, mod);
        return mod;
      } catch {
        // Parse error — syntax-check.mjs will report it.
        return stubNonJs(resolved);
      }
    }

    // File doesn't exist — report clearly.
    throw new Error(
      `Cannot find module '${specifier}' imported from ${relative(rootDir, referencingModule.identifier)}`,
    );
  }

  // Phase 2: Link all modules — this validates named export bindings.
  for (const [absPath, mod] of moduleCache) {
    // Already linked (as a transitive dependency of a previously linked module).
    if (mod.status !== "unlinked") continue;
    try {
      await mod.link(linker);
    } catch (err) {
      const rel = relative(rootDir, absPath);
      errors.push({ file: rel, error: err.message });
    }
  }

  return { errors, moduleCount: moduleCache.size };
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let rootDir = process.cwd();
  let files = undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1]) {
      rootDir = resolve(args[++i]);
    } else if (args[i] === "--files" && args[i + 1]) {
      files = args[++i].split(",").filter(Boolean);
    }
  }

  const { errors, moduleCount } = await validateImports({ rootDir, files });

  if (errors.length > 0) {
    console.error("Import validation failed:\n");
    for (const { file, error } of errors) {
      console.error(`  \u2717 ${file}`);
      console.error(`    ${error}\n`);
    }
    process.exit(1);
  }

  console.log(
    `Imports OK: ${moduleCount} modules linked, 0 broken imports`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}

