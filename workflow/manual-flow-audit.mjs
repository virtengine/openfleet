import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export async function executeAnnotationAudit(formValues, rootDir, context) {
  const {
    targetDir = "",
    fileExtensions = ".mjs, .js, .ts, .tsx, .jsx, .py",
    skipGenerated = true,
    phases = "all",
    dryRun = false,
  } = formValues;

  const extensions = fileExtensions
    .split(",")
    .map((extension) => extension.trim())
    .filter(Boolean);

  const scanRoot = targetDir ? resolve(rootDir, targetDir) : rootDir;
  const inventory = buildInventory(scanRoot, extensions, skipGenerated, rootDir);

  if (dryRun) {
    return {
      mode: "dry-run",
      filesScanned: inventory.length,
      filesNeedingSummary: inventory.filter((file) => !file.has_summary).length,
      filesNeedingWarn: inventory.filter((file) => !file.has_warn).length,
      phases,
      inventory,
    };
  }

  if (context.taskManager && typeof context.taskManager.createTask === "function") {
    const taskDescription = buildAuditTaskDescription(formValues, inventory);
    const task = await context.taskManager.createTask({
      title: `docs(audit): codebase annotation audit`,
      description: taskDescription,
      priority: "high",
      labels: ["audit", "documentation", "annotation"],
      skills: ["codebase-annotation-audit"],
    });
    return {
      mode: "task-dispatched",
      taskId: task.id || task._id,
      filesScanned: inventory.length,
      filesNeedingSummary: inventory.filter((file) => !file.has_summary).length,
      phases,
    };
  }

  const auditDir = resolve(rootDir, ".bosun", "audit");
  mkdirSync(auditDir, { recursive: true });
  writeFileSync(
    resolve(auditDir, "inventory.json"),
    JSON.stringify(inventory, null, 2) + "\n",
    "utf8",
  );

  return {
    mode: "inventory-saved",
    inventoryPath: resolve(auditDir, "inventory.json"),
    filesScanned: inventory.length,
    filesNeedingSummary: inventory.filter((file) => !file.has_summary).length,
    filesNeedingWarn: inventory.filter((file) => !file.has_warn).length,
    phases,
    instructions:
      "Inventory saved. Assign a docs(audit) task to an agent with the codebase-annotation-audit skill to complete annotation.",
  };
}

function buildInventory(scanDir, extensions, skipGenerated, repoRoot) {
  const inventory = [];
  const generatedPatterns = [
    /node_modules/,
    /\.min\.\w+$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.next\//,
    /dist\//,
    /build\//,
    /coverage\//,
    /\.bosun-worktrees\//,
    /\.git\//,
  ];

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      const relPath = fullPath.replace(repoRoot, "").replace(/\\/g, "/").replace(/^\//, "");

      if (entry.isDirectory()) {
        if (skipGenerated && generatedPatterns.some((pattern) => pattern.test(relPath))) continue;
        if (entry.name.startsWith(".") && entry.name !== ".bosun") continue;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (extensions.length > 0 && !extensions.some((ext) => entry.name.endsWith(ext))) continue;
      if (skipGenerated && generatedPatterns.some((pattern) => pattern.test(relPath))) continue;

      let content = "";
      let lines = 0;
      let hasSummary = false;
      let hasWarn = false;

      try {
        content = readFileSync(fullPath, "utf8");
        lines = content.split("\n").length;
        hasSummary = /(?:CLAUDE|BOSUN):SUMMARY/i.test(content);
        hasWarn = /(?:CLAUDE|BOSUN):WARN/i.test(content);
      } catch {
      }

      const ext = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")) : "";
      inventory.push({
        path: relPath,
        lang: ext,
        lines,
        has_summary: hasSummary,
        has_warn: hasWarn,
        category: categorizeFile(relPath),
      });
    }
  }

  walk(scanDir);
  return inventory;
}

function categorizeFile(relPath) {
  if (/test|spec|__tests__/i.test(relPath)) return "test";
  if (/\.config\.|tsconfig|jest\.config|webpack|vite\.config|\.env/i.test(relPath)) return "config";
  if (/\.min\.|dist\/|build\/|generated/i.test(relPath)) return "generated";
  if (/util|helper|lib\//i.test(relPath)) return "util";
  return "core";
}

function buildAuditTaskDescription(formValues, inventory) {
  const needsSummary = inventory.filter((file) => !file.has_summary).length;
  const needsWarn = inventory.filter((file) => !file.has_warn).length;
  return `## Codebase Annotation Audit

**Phases:** ${formValues.phases || "all"}
**Target:** ${formValues.targetDir || "(entire repo)"}
**Extensions:** ${formValues.fileExtensions || "all source files"}

### Inventory Summary
- Total files: ${inventory.length}
- Files needing CLAUDE:SUMMARY: ${needsSummary}
- Files needing CLAUDE:WARN review: ${needsWarn}

### Instructions
Follow the codebase-annotation-audit skill (loaded in your skills).
Run phases as specified above. Do NOT change any program behavior — documentation only.
${formValues.commitMessage ? `\nCommit with: \`${formValues.commitMessage}\`` : ""}
`;
}
