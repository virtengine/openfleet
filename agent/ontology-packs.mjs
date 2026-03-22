import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function toTrimmedString(value) {
  return String(value || "").trim();
}

function appendUnique(target, values) {
  for (const value of values) {
    const normalized = toTrimmedString(value);
    if (normalized && !target.includes(normalized)) target.push(normalized);
  }
}

function parseRequiredFields(schema) {
  if (!schema || typeof schema !== "object" || !Array.isArray(schema.required)) return "";
  return schema.required
    .map((value) => toTrimmedString(value))
    .filter(Boolean)
    .join(",");
}

function normalizeTypedField(field) {
  if (typeof field === "string") return toTrimmedString(field);
  if (!field || typeof field !== "object") return "";
  const name = toTrimmedString(field.name || field.id || field.key);
  if (!name) return "";
  const type = toTrimmedString(field.type || field.kind);
  const required = field.required === true ? " required" : "";
  return `${name}${type ? `:${type}` : ""}${required}`;
}

function summarizeTypedFields(fields) {
  if (!Array.isArray(fields)) return "";
  return fields
    .map((field) => normalizeTypedField(field))
    .filter(Boolean)
    .join(",");
}

function normalizeInstallHint(pack) {
  return toTrimmedString(pack.installHint || pack.install || pack.package || pack.packageName);
}

function normalizeWorkflowNodeEntry(node) {
  if (typeof node === "string") return toTrimmedString(node);
  if (!node || typeof node !== "object") return "";
  const type = toTrimmedString(node.type || node.name || node.id);
  if (!type) return "";
  const fields = summarizeTypedFields(node.inputs || node.inputFields || node.fields);
  return fields ? `${type} inputs=${fields}` : type;
}

function normalizeMcpToolEntry(tool) {
  if (typeof tool === "string") return toTrimmedString(tool);
  if (!tool || typeof tool !== "object") return "";
  const server = toTrimmedString(tool.server);
  const name = toTrimmedString(tool.name || tool.tool || tool.id);
  const qualified = server && name ? `${server}/${name}` : (name || server);
  if (!qualified) return "";
  const required = parseRequiredFields(tool.inputSchema);
  const typedInputSummary = summarizeTypedFields(tool.inputs || tool.inputFields || tool.args);
  const detailParts = [];
  if (required) detailParts.push(`required=${required}`);
  if (typedInputSummary) detailParts.push(`inputs=${typedInputSummary}`);
  return detailParts.length ? `${qualified} ${detailParts.join(" ")}` : qualified;
}

function normalizeIntegrationSchemaEntry(schema) {
  if (typeof schema === "string") return toTrimmedString(schema);
  if (!schema || typeof schema !== "object") return "";
  const name = toTrimmedString(schema.name || schema.id);
  if (!name) return "";
  const fields = summarizeTypedFields(schema.fields);
  return fields ? `${name} fields=${fields}` : name;
}

function normalizeOntologyPack(pack, fallbackId = "") {
  if (!pack || typeof pack !== "object") return null;
  const id = toTrimmedString(pack.id || pack.name || fallbackId);
  if (!id) return null;

  const nodes = [];
  appendUnique(nodes, Array.isArray(pack.nodes) ? pack.nodes : []);
  appendUnique(
    nodes,
    Array.isArray(pack.workflowNodes)
      ? pack.workflowNodes.map((node) => normalizeWorkflowNodeEntry(node))
      : [],
  );

  const tools = [];
  appendUnique(tools, Array.isArray(pack.tools) ? pack.tools : []);
  appendUnique(
    tools,
    Array.isArray(pack.mcpTools)
      ? pack.mcpTools.map((tool) => normalizeMcpToolEntry(tool))
      : [],
  );

  const schemas = [];
  appendUnique(schemas, Array.isArray(pack.schemas) ? pack.schemas : []);
  appendUnique(
    schemas,
    Array.isArray(pack.integrationSchemas)
      ? pack.integrationSchemas.map((schema) => normalizeIntegrationSchemaEntry(schema))
      : [],
  );

  return {
    id,
    kind: toTrimmedString(pack.kind || pack.type || "capability-pack"),
    version: toTrimmedString(pack.version),
    description: toTrimmedString(pack.description),
    installHint: normalizeInstallHint(pack),
    nodes,
    tools,
    schemas,
  };
}

function readJsonOntologyFile(fullPath, fallbackId) {
  try {
    const parsed = JSON.parse(readFileSync(fullPath, "utf8"));
    const rawPacks = Array.isArray(parsed?.packs) ? parsed.packs : [parsed];
    return rawPacks
      .map((pack, index) => normalizeOntologyPack(pack, index === 0 ? fallbackId : `${fallbackId}-${index + 1}`))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function loadLocalCapabilityOntologyPacks(rootDir) {
  const baseDir = resolve(toTrimmedString(rootDir) || process.cwd(), ".bosun", "ontology-packs");
  if (!existsSync(baseDir)) return [];
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.json$/i.test(entry.name))
      .slice(0, 12)
      .flatMap((entry) => readJsonOntologyFile(resolve(baseDir, entry.name), entry.name.replace(/\.json$/i, "")));
  } catch {
    return [];
  }
}

export function formatCapabilityOntologyPacks(packs, options = {}) {
  const title = toTrimmedString(options.title) || "## Capability Ontology Packs";
  const subtitle = toTrimmedString(options.subtitle)
    || "Use these installable typed capability bundles to ground workflow nodes, MCP tools, and integration schemas.";
  const normalized = Array.isArray(packs)
    ? packs.map((pack) => normalizeOntologyPack(pack)).filter(Boolean)
    : [];
  if (!normalized.length) return "";

  const lines = [title, subtitle];
  for (const pack of normalized) {
    const header = [
      `- **${pack.id}**`,
      `(${pack.kind}${pack.version ? `@${pack.version}` : ""})`,
    ].filter(Boolean).join(" ");
    lines.push(header);
    if (pack.description) lines.push(`  - ${pack.description}`);
    if (pack.installHint) lines.push(`  - Install: ${pack.installHint}`);
    if (pack.nodes.length) lines.push(`  - Workflow nodes: ${pack.nodes.join(", ")}`);
    if (pack.tools.length) lines.push(`  - MCP tools: ${pack.tools.join(", ")}`);
    if (pack.schemas.length) lines.push(`  - Integration schemas: ${pack.schemas.join(", ")}`);
  }
  return lines.join("\n");
}

export function buildLocalOntologyPromptBlock(rootDir) {
  return formatCapabilityOntologyPacks(loadLocalCapabilityOntologyPacks(rootDir), {
    title: "## Local Ontology Packs",
  });
}
