#!/usr/bin/env node

/**
 * prepublish-check.mjs — Pre-publish validation gate.
 *
 * Validates that every published local source file only imports other files
 * that are also published. This closes the gap where nested modules can import
 * `../foo.mjs` successfully in the repo, but fail after npm publish because the
 * target was omitted from package.json's `files` array.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init, parse } from "es-module-lexer";

const SOURCE_EXTENSIONS = new Set([".mjs", ".cjs", ".js"]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function isSourceFile(filePath) {
  return SOURCE_EXTENSIONS.has(extname(filePath));
}

function walkFiles(absPath, out = []) {
  const stats = statSync(absPath);
  if (stats.isDirectory()) {
    for (const entry of readdirSync(absPath)) {
      walkFiles(resolve(absPath, entry), out);
    }
    return out;
  }
  out.push(absPath);
  return out;
}

export function findDuplicateEntries(filesArray = []) {
  const seen = new Set();
  const duplicates = [];
  for (const entry of filesArray) {
    if (seen.has(entry)) duplicates.push(entry);
    seen.add(entry);
  }
  return duplicates;
}

export function expandPublishedFiles(rootDir, filesArray = []) {
  const published = new Set();
  for (const entry of filesArray) {
    const absEntry = resolve(rootDir, entry);
    if (!existsSync(absEntry)) continue;
    for (const absFile of walkFiles(absEntry)) {
      published.add(relative(rootDir, absFile).replaceAll("\\", "/"));
    }
  }
  return published;
}

export async function findLocalImportSpecifiers(source) {
  await init;
  const [imports] = parse(source);
  return imports
    .map((entry) => entry.n)
    .filter(
      (specifier) =>
        typeof specifier === "string" &&
        (specifier.startsWith("./") || specifier.startsWith("../")),
    );
}

export async function validatePublishedLocalImports({ rootDir, pkg }) {
  if (!pkg?.version) {
    return {
      duplicates: [],
      missing: [],
      scannedFiles: [],
      error: "Missing version in package.json",
    };
  }

  const filesArray = Array.isArray(pkg.files) ? pkg.files : [];
  const duplicates = findDuplicateEntries(filesArray);
  const publishedFiles = expandPublishedFiles(rootDir, filesArray);
  const scannedFiles = [...publishedFiles]
    .filter(isSourceFile)
    .sort((a, b) => a.localeCompare(b));
  const missing = [];

  for (const file of scannedFiles) {
    const absFile = resolve(rootDir, file);
    const content = readFileSync(absFile, "utf8");
    const imports = await findLocalImportSpecifiers(content);
    for (const specifier of imports) {
      const absTarget = resolve(dirname(absFile), specifier);
      if (!existsSync(absTarget)) continue;
      const target = relative(rootDir, absTarget).replaceAll("\\", "/");
      if (!publishedFiles.has(target)) {
        missing.push({ file, imported: specifier, resolved: target });
      }
    }
  }

  return { duplicates, missing, scannedFiles, error: null };
}

export async function runPrepublishCheck(rootDir = ROOT) {
  const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
  const result = await validatePublishedLocalImports({ rootDir, pkg });

  if (result.error) {
    console.error(`:close: ${result.error}`);
    process.exit(1);
  }
  if (result.duplicates.length > 0) {
    console.error(
      `:close: Duplicate entries in files array: ${result.duplicates.join(", ")}`,
    );
    process.exit(1);
  }
  if (result.missing.length > 0) {
    console.error(":close: Published local imports missing from package.json files array:");
    for (const { file, imported, resolved } of result.missing) {
      console.error(`   ${file} -> ${imported} (${resolved})`);
    }
    console.error("\nAdd the resolved targets to the 'files' array in package.json.");
    process.exit(1);
  }

  console.log(
    `:check: ${pkg.name}@${pkg.version} — ${pkg.files.length} manifest entries, ${result.scannedFiles.length} published source files scanned, 0 missing local imports`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runPrepublishCheck();
}
