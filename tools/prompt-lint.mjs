#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_PROMPT_DEFINITIONS,
  DEFAULT_PROMPTS,
  PROMPT_WORKSPACE_DIR,
} from "../agent/agent-prompt-catalog.mjs";

export const NARRATION_PHRASES = Object.freeze([
  "I am going to",
  "I'm going to",
  "I’m going to",
  "I'll",
  "I’ll",
  "Let me",
  "Let me now",
  "I have completed",
  "I will use",
  "I will now",
  "First, I",
  "Next, I",
  "Then, I",
  "Before I",
  "After I",
  "To do this, I",
]);

function escapeRegex(text) {
  return String(text).replace(/[.*+?^$()|[\]\\]/g, "\\$&");
}

function walkMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

export function lintPromptText(text, source = "<inline>") {
  const issues = [];
  const lines = String(text || "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const phrase of NARRATION_PHRASES) {
      const matcher = new RegExp("\\b" + escapeRegex(phrase) + "\\b", "i");
      if (!matcher.test(line)) continue;
      issues.push({
        path: source,
        line: index + 1,
        phrase,
        excerpt: line.trim(),
      });
      break;
    }
  }

  return issues;
}

export function collectPromptLintTargets(rootDir = process.cwd()) {
  const root = resolve(rootDir);
  const targets = new Map();

  for (const definition of AGENT_PROMPT_DEFINITIONS) {
    const promptPath = PROMPT_WORKSPACE_DIR + "/" + definition.filename;
    targets.set(promptPath, {
      path: promptPath,
      source: "builtin",
      content: DEFAULT_PROMPTS[definition.key] || "",
    });
  }

  const promptDir = resolve(root, PROMPT_WORKSPACE_DIR);
  for (const filePath of walkMarkdownFiles(promptDir)) {
    const relPath = relative(root, filePath).replace(/\\/g, "/");
    targets.set(relPath, {
      path: relPath,
      source: "workspace",
      content: readFileSync(filePath, "utf8"),
    });
  }

  return [...targets.values()];
}

export function lintPromptWorkspace(rootDir = process.cwd()) {
  const targets = collectPromptLintTargets(rootDir);
  const issues = targets.flatMap((target) => lintPromptText(target.content, target.path));
  return {
    ok: issues.length === 0,
    targets,
    issues,
  };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const rootDir = process.argv[2] || process.cwd();
  const result = lintPromptWorkspace(rootDir);

  if (!result.ok) {
    console.error("[prompt-lint] narration patterns detected:");
    for (const issue of result.issues) {
      console.error(
        "- " + issue.path + ":" + issue.line + " (" + issue.phrase + ") " + issue.excerpt,
      );
    }
    process.exit(1);
  }

  console.log("[prompt-lint] ok (" + result.targets.length + " targets)");
}
