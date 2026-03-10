import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const WORKFLOW_CONTRACT_FILENAME = "WORKFLOW.md";
export const REQUIRED_WORKFLOW_CONTRACT_FIELDS = Object.freeze([
  "terminalStates",
  "forbiddenPatterns",
]);

const DEFAULT_WORKFLOW_CONTRACT = Object.freeze({
  exists: false,
  found: false,
  enabled: false,
  path: "",
  projectRoot: "",
  content: "",
  raw: "",
  projectDescription: "",
  terminalStates: Object.freeze([]),
  forbiddenPatterns: Object.freeze([]),
  preferredTools: Object.freeze([]),
  preferredModel: "",
  escalationContact: "",
  escalationPaths: Object.freeze([]),
  rules: Object.freeze([]),
  sections: Object.freeze({}),
});

const KEY_ALIASES = Object.freeze({
  projectdescription: "projectDescription",
  project_description: "projectDescription",
  description: "projectDescription",
  terminalstates: "terminalStates",
  terminal_states: "terminalStates",
  forbiddenpatterns: "forbiddenPatterns",
  forbidden_patterns: "forbiddenPatterns",
  preferredtools: "preferredTools",
  preferred_tools: "preferredTools",
  preferredmodel: "preferredModel",
  preferred_model: "preferredModel",
  escalationcontact: "escalationContact",
  escalation_contact: "escalationContact",
  escalationpaths: "escalationPaths",
  escalation_paths: "escalationPaths",
  rules: "rules",
});

const LIST_FIELDS = new Set(["terminalStates", "forbiddenPatterns", "preferredTools", "escalationPaths", "rules"]);
const TEXT_FIELDS = new Set([
  "projectDescription",
  "preferredModel",
  "escalationContact",
]);

let contractCache = new Map();

function createEmptyContract(projectRoot = "") {
  return {
    ...DEFAULT_WORKFLOW_CONTRACT,
    projectRoot,
    terminalStates: [],
    forbiddenPatterns: [],
    preferredTools: [],
    escalationPaths: [],
    rules: [],
    sections: {},
  };
}

function hydrateCompatShape(contract) {
  const normalized = contract || createEmptyContract();
  normalized.found = normalized.exists === true;
  normalized.raw = normalized.content || "";
  normalized.parsed = {
    projectDescription: normalized.projectDescription || "",
    terminalStates: [...(normalized.terminalStates || [])],
    forbiddenPatterns: [...(normalized.forbiddenPatterns || [])],
    preferredTools: [...(normalized.preferredTools || [])],
    preferredModel: normalized.preferredModel || "",
    escalationContact: normalized.escalationContact || "",
    escalationPaths: [...(normalized.escalationPaths || [])],
    rules: [...(normalized.rules || [])],
  };
  return normalized;
}

function normalizeContractKey(rawKey = "") {
  const trimmed = String(rawKey || "").trim();
  if (!trimmed) return "";
  const compact = trimmed.replace(/[\s-]+/g, "_").replace(/[^A-Za-z0-9_]/g, "").toLowerCase();
  return KEY_ALIASES[compact] || "";
}

function normalizeHeadingKey(rawHeading = "") {
  return normalizeContractKey(String(rawHeading || "").replace(/^#+\s*/, ""));
}

function stripWrappingQuotes(value = "") {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseInlineList(rawValue = "") {
  const trimmed = String(rawValue || "").trim();
  if (!trimmed) return [];

  const normalized = trimmed.startsWith("[") && trimmed.endsWith("]")
    ? trimmed.slice(1, -1)
    : trimmed;

  return normalized
    .split(",")
    .map((entry) => stripWrappingQuotes(entry))
    .filter(Boolean);
}

function dedupeStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const rawValue of values) {
    const value = stripWrappingQuotes(rawValue);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function appendListValues(contract, key, values = []) {
  if (!LIST_FIELDS.has(key)) return;
  contract[key] = dedupeStrings([...(contract[key] || []), ...values]);
}

function appendTextValue(contract, key, value = "") {
  if (!TEXT_FIELDS.has(key)) return;
  const trimmed = String(value || "").trim();
  if (!trimmed) return;
  contract[key] = contract[key]
    ? `${contract[key]}\n${trimmed}`
    : trimmed;
}

function storeSectionValue(contract, key) {
  if (!key) return;
  if (LIST_FIELDS.has(key)) {
    contract.sections[key] = [...(contract[key] || [])];
    return;
  }
  if (TEXT_FIELDS.has(key)) {
    contract.sections[key] = contract[key] || "";
  }
}

function finalizeCollector(contract, collector) {
  if (!collector?.key) return;
  const key = collector.key;
  if (LIST_FIELDS.has(key)) {
    appendListValues(contract, key, collector.items || []);
  } else if (TEXT_FIELDS.has(key)) {
    const text = (collector.lines || [])
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .join("\n")
      .trim();
    appendTextValue(contract, key, text);
  }
  storeSectionValue(contract, key);
}

export function parseWorkflowContractMarkdown(content = "", projectRoot = "") {
  const contract = createEmptyContract(projectRoot);
  const source = String(content || "");
  contract.content = source.trim();
  contract.enabled = contract.content.length > 0;
  if (!contract.enabled) return contract;

  const lines = source.split(/\r?\n/);
  let inFence = false;
  let collector = null;

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headingMatch = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (headingMatch) {
      finalizeCollector(contract, collector);
      collector = null;
      const headingKey = normalizeHeadingKey(headingMatch[1]);
      if (headingKey) {
        collector = LIST_FIELDS.has(headingKey)
          ? { key: headingKey, items: [] }
          : { key: headingKey, lines: [] };
      }
      continue;
    }

    const fieldMatch = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]*)\s*:\s*(.*)$/);
    if (fieldMatch) {
      finalizeCollector(contract, collector);
      collector = null;

      const key = normalizeContractKey(fieldMatch[1]);
      if (!key) continue;

      const rawValue = String(fieldMatch[2] || "").trim();
      if (LIST_FIELDS.has(key)) {
        if (rawValue) {
          appendListValues(contract, key, parseInlineList(rawValue));
          storeSectionValue(contract, key);
        } else {
          collector = { key, items: [] };
        }
        continue;
      }

      if (TEXT_FIELDS.has(key)) {
        if (rawValue) {
          appendTextValue(contract, key, stripWrappingQuotes(rawValue));
          storeSectionValue(contract, key);
        } else {
          collector = { key, lines: [] };
        }
      }
      continue;
    }

    if (!collector) continue;

    if (LIST_FIELDS.has(collector.key)) {
      const bulletMatch = line.match(/^\s*[-*]\s+(.*)$/);
      if (bulletMatch) {
        collector.items.push(stripWrappingQuotes(bulletMatch[1]));
        continue;
      }
      if (!trimmed) continue;
      finalizeCollector(contract, collector);
      collector = null;
      continue;
    }

    if (TEXT_FIELDS.has(collector.key)) {
      if (!trimmed) {
        if ((collector.lines || []).length > 0) collector.lines.push("");
        continue;
      }
      collector.lines.push(trimmed);
    }
  }

  finalizeCollector(contract, collector);
  contract.projectDescription = String(contract.projectDescription || "").trim();
  contract.preferredModel = String(contract.preferredModel || "").trim();
  contract.escalationContact = String(contract.escalationContact || "").trim();
  contract.terminalStates = dedupeStrings(contract.terminalStates);
  contract.forbiddenPatterns = dedupeStrings(contract.forbiddenPatterns);
  contract.preferredTools = dedupeStrings(contract.preferredTools);
  contract.escalationPaths = dedupeStrings(contract.escalationPaths);
  contract.rules = dedupeStrings(contract.rules);
  storeSectionValue(contract, "projectDescription");
  storeSectionValue(contract, "preferredTools");
  storeSectionValue(contract, "preferredModel");
  storeSectionValue(contract, "escalationContact");
  storeSectionValue(contract, "escalationPaths");
  storeSectionValue(contract, "rules");
  return hydrateCompatShape(contract);
}

export function loadWorkflowContract(projectRoot = process.cwd(), options = {}) {
  const normalizedRoot = resolve(projectRoot || process.cwd());
  const workflowMdPath = resolve(normalizedRoot, WORKFLOW_CONTRACT_FILENAME);
  const useCache = options.useCache !== false;

  if (useCache && contractCache.has(normalizedRoot)) {
    return contractCache.get(normalizedRoot);
  }

  if (!existsSync(workflowMdPath)) {
    const empty = {
      ...createEmptyContract(normalizedRoot),
      path: workflowMdPath,
    };
    hydrateCompatShape(empty);
    if (useCache) contractCache.set(normalizedRoot, empty);
    return empty;
  }

  const content = readFileSync(workflowMdPath, "utf8");
  const contract = parseWorkflowContractMarkdown(content, normalizedRoot);
  contract.exists = true;
  contract.found = true;
  contract.enabled = true;
  contract.path = workflowMdPath;
  contract.raw = contract.content;
  hydrateCompatShape(contract);
  if (useCache) contractCache.set(normalizedRoot, contract);
  return contract;
}

export function validateWorkflowContract(input) {
  const contract = typeof input === "string"
    ? loadWorkflowContract(input, { useCache: false })
    : { ...createEmptyContract(input?.projectRoot || ""), ...(input || {}) };

  const errors = [];
  if (!contract.exists && !contract.enabled) {
    return { valid: true, errors, contract };
  }

  for (const field of REQUIRED_WORKFLOW_CONTRACT_FIELDS) {
    const values = Array.isArray(contract[field]) ? contract[field] : [];
    if (values.length === 0) {
      const hint = field === "terminalStates"
        ? "Add `terminalStates: [done]` or a `## Terminal States` section."
        : "Add `forbiddenPatterns:` with at least one disallowed shell pattern.";
      errors.push({
        field,
        message: `WORKFLOW.md is missing required field \`${field}\`. ${hint}`,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    contract,
  };
}

export function buildWorkflowContractPromptBlock(input) {
  const contract = typeof input === "string"
    ? loadWorkflowContract(input)
    : input;

  if (!contract?.exists || !contract?.content) return "";

  const lines = [
    "## WORKFLOW.md Contract",
    `- **Source:** ${contract.path}`,
    "- **Behavior:** Treat this file as a project-specific runtime contract.",
    "",
    contract.content.trim(),
  ];

  return lines.join("\n").trim();
}

export function clearWorkflowContractCache(projectRoot) {
  if (!projectRoot) {
    contractCache.clear();
    return;
  }
  contractCache.delete(resolve(projectRoot));
}

export function getWorkflowContract(projectRoot) {
  return loadWorkflowContract(projectRoot);
}

export function clearContractCache(projectRoot) {
  clearWorkflowContractCache(projectRoot);
}

export function hasWorkflowContract(projectRoot) {
  return loadWorkflowContract(projectRoot).exists;
}

export function validateContract(projectRoot) {
  return validateWorkflowContract(projectRoot);
}
