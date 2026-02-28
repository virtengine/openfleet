import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

function listTopLevelModules() {
  return readdirSync(process.cwd())
    .filter((name) => name.endsWith(".mjs"))
    .sort((a, b) => a.localeCompare(b));
}

function validateModuleSyntax(filePath) {
  const source = readFileSync(filePath, "utf8");
  // Construction parses source and throws on syntax errors without executing module code.
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

  console.log(`Syntax OK: ${files.length} files checked`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
