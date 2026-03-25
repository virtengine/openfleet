import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NARRATION_LINT_PATTERNS = Object.freeze([
  Object.freeze({
    id: "i-am-going-to",
    description: 'First-person execution narration ("I am going to")',
    pattern: /\bI am going to\b/i,
  }),
  Object.freeze({
    id: "i-have-completed",
    description: 'First-person completion narration ("I have completed")',
    pattern: /\bI have completed\b/i,
  }),
  Object.freeze({
    id: "im-noticing",
    description: 'First-person coaching example ("I\'m noticing")',
    pattern: /"I[''’]m noticing\b/i,
  }),
  Object.freeze({
    id: "this-makes-me-think",
    description: 'First-person coaching example ("This makes me think of")',
    pattern: /"This makes me think of\b/i,
  }),
  Object.freeze({
    id: "im-shifting",
    description: 'First-person transition example ("I\'m shifting")',
    pattern: /"I[''’]m shifting\b/i,
  }),
  Object.freeze({
    id: "im-sending",
    description: 'Delegation narration example ("I\'m sending that to")',
    pattern: /"I[''’]m sending that to\b/i,
  }),
  Object.freeze({
    id: "lets-make-sure",
    description: 'Sequential explain-before-act phrase ("Let\'s make sure")',
    pattern: /\bLet[''’]s make sure\b/i,
  }),
  Object.freeze({
    id: "lets-take-each-option",
    description: 'Sequential explain-before-act phrase ("Let\'s take each option")',
    pattern: /\bLet[''’]s take each option\b/i,
  }),
  Object.freeze({
    id: "lets-move-on",
    description: 'Sequential transition phrase ("Let\'s move on")',
    pattern: /\bLet[''’]s move on to\b/i,
  }),
  Object.freeze({
    id: "i-will-use",
    description: 'First-person execution narration ("I will use")',
    pattern: /\bI will use\b/i,
  }),
  Object.freeze({
    id: "i-will-now",
    description: 'First-person execution narration ("I will now")',
    pattern: /\bI will now\b/i,
  }),
  Object.freeze({
    id: "let-me-now",
    description: 'First-person execution narration ("Let me now")',
    pattern: /\bLet me now\b/i,
  }),
  Object.freeze({
    id: "i-noticed-example",
    description: 'First-person coaching example ("I noticed [element]")',
    pattern: /"I noticed \[element\]\b/i,
  }),
  Object.freeze({
    id: "well-plan-adr",
    description: 'Sequential planning narration ("We\'ll plan to finalize your ADR")',
    pattern: /"We[''’]ll plan to finalize your ADR\b/i,
  }),
  Object.freeze({
    id: "ive-placed-adr",
    description: 'First-person completion narration ("I\'ve placed your ADR")',
    pattern: /"I[''’]ve placed your ADR\b/i,
  }),
  Object.freeze({
    id: "i-can-pick-up",
    description: 'First-person resume narration ("I can pick up where we left off")',
    pattern: /\bI can pick up where we left off\b/i,
  }),
  Object.freeze({
    id: "i-can-connect",
    description: 'First-person handoff narration ("I can connect you with")',
    pattern: /\bI can connect you with\b/i,
  }),
  Object.freeze({
    id: "well-work-through",
    description: 'Sequential explain-before-act phrase ("We\'ll work through the methodology")',
    pattern: /\bWe[''’]ll work through the methodology\b/i,
  }),
  Object.freeze({
    id: "shift-focus-narration",
    description: 'Sequential coaching narration ("It sounds like we should shift focus")',
    pattern: /"It sounds like we should shift focus\b/i,
  }),
]);

function listPromptFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listPromptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.sort((a, b) => a.localeCompare(b));
}

export function collectPromptLintViolations(rootDir = process.cwd(), opts = {}) {
  const promptDir = resolve(rootDir, ".bosun", "agents");
  const patterns = opts.patterns ?? NARRATION_LINT_PATTERNS;
  const violations = [];

  for (const filePath of listPromptFiles(promptDir)) {
    const text = readFileSync(filePath, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const rule of patterns) {
        if (rule.pattern.test(line)) {
          violations.push({
            file: relative(rootDir, filePath).replace(/\\/g, "/"),
            line: index + 1,
            rule: rule.id,
            description: rule.description,
            snippet: line.trim(),
          });
        }
      }
    });
  }

  return violations;
}

export function formatPromptLintViolations(violations) {
  return violations
    .map((violation) => {
      const location = violation.file + ":" + violation.line;
      return location + " [" + violation.rule + "] " + violation.description + "\n  " + violation.snippet;
    })
    .join("\n");
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const violations = collectPromptLintViolations(process.cwd());
  if (violations.length > 0) {
    console.error("Prompt lint failed. Remove verbose narration patterns from .bosun/agents/.\n");
    console.error(formatPromptLintViolations(violations));
    process.exit(1);
  }
  console.log("Prompt lint OK: no narration anti-patterns found in .bosun/agents");
}
