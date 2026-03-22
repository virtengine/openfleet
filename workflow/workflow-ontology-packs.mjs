import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import {
  getNodeTypeMeta,
  registerNodeType,
  unregisterNodeType,
} from "./workflow-engine.mjs";
import { resolveRepoRoot } from "../config/repo-root.mjs";

const TAG = "[workflow-ontology-packs]";
export const ONTOLOGY_PACK_DIR_NAME = ".bosun/ontology-packs";

const loadedPacksByRepo = new Map();
const packNodeTypesByFile = new Map();
const fileVersions = new Map();

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function logWarn(message) {
  console.warn(`${TAG} ${message}`);
}

function defaultRepoRoot(repoRoot = "") {
  return resolve(repoRoot || resolveRepoRoot());
}

export function getWorkflowOntologyPackDir(options = {}) {
  return resolve(defaultRepoRoot(options.repoRoot), ONTOLOGY_PACK_DIR_NAME);
}

function isValidStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim());
}

function normalizeSchema(schema, label) {
  if (schema == null) {
    return {
      type: "object",
      properties: {},
      additionalProperties: true,
    };
  }
  if (typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error(`${label} schema must be an object`);
  }
  if (schema.type && schema.type !== "object") {
    throw new Error(`${label} schema.type must be 'object' when provided`);
  }
  return { ...schema, type: "object" };
}

function normalizeMcpTool(tool, index) {
  if (!tool || typeof tool !== "object") {
    throw new Error(`mcpTools[${index}] must be an object`);
  }
  const server = String(tool.server || tool.serverId || "").trim();
  const name = String(tool.name || tool.tool || "").trim();
  if (!server) throw new Error(`mcpTools[${index}].server is required`);
  if (!name) throw new Error(`mcpTools[${index}].name is required`);
  return {
    server,
    name,
    description: String(tool.description || "").trim(),
    inputSchema: normalizeSchema(tool.inputSchema, `mcpTools[${index}].inputSchema`),
  };
}

function normalizeOntologyNode(node, pack) {
  if (!node || typeof node !== "object") throw new Error("ontology node must be an object");
  const type = String(node.type || "").trim();
  if (!type) throw new Error("ontology node type is required");
  const description = String(node.description || node.name || type).trim();
  const schema = normalizeSchema(node.schema, `${type} schema`);
  const inputs = isValidStringArray(node.inputs) ? [...node.inputs] : [];
  const outputs = isValidStringArray(node.outputs) ? [...node.outputs] : [];
  const capabilities = isValidStringArray(node.capabilities) ? [...node.capabilities] : [];
  const integration = node.integration && typeof node.integration === "object"
    ? { ...node.integration }
    : null;
  const mcpTools = Array.isArray(node.mcpTools)
    ? node.mcpTools.map((tool, index) => normalizeMcpTool(tool, index))
    : [];

  return {
    type,
    category: String(node.category || type.split(".")[0] || "action").trim() || "action",
    description,
    schema,
    inputs,
    outputs,
    capabilities,
    integration,
    mcpTools,
    packId: pack.id,
    packVersion: pack.version || null,
    packName: pack.name || pack.id,
  };
}

function normalizePack(rawPack, filePath) {
  if (!rawPack || typeof rawPack !== "object") throw new Error("pack.json must export an object");
  const id = String(rawPack.id || "").trim();
  if (!id) throw new Error("pack id is required");
  const ontology = rawPack.ontology && typeof rawPack.ontology === "object" ? rawPack.ontology : {};
  const pack = {
    id,
    version: String(rawPack.version || "").trim() || null,
    name: String(rawPack.name || id).trim() || id,
    description: String(rawPack.description || "").trim(),
    tags: isValidStringArray(rawPack.tags) ? [...rawPack.tags] : [],
    capabilities: isValidStringArray(rawPack.capabilities) ? [...rawPack.capabilities] : [],
    install: rawPack.install && typeof rawPack.install === "object" ? cloneJson(rawPack.install) : null,
    filePath,
    ontology: {
      nodes: [],
      integrations: Array.isArray(ontology.integrations) ? ontology.integrations.map((entry) => cloneJson(entry)) : [],
      mcpTools: Array.isArray(ontology.mcpTools) ? ontology.mcpTools.map((entry, index) => normalizeMcpTool(entry, index)) : [],
      schemas: Array.isArray(ontology.schemas) ? ontology.schemas.map((entry) => cloneJson(entry)) : [],
    },
  };
  pack.ontology.nodes = Array.isArray(ontology.nodes)
    ? ontology.nodes.map((node) => normalizeOntologyNode(node, pack))
    : [];
  return pack;
}

function summarizePack(pack) {
  const nodes = Array.isArray(pack?.ontology?.nodes) ? pack.ontology.nodes : [];
  const integrations = Array.isArray(pack?.ontology?.integrations) ? pack.ontology.integrations : [];
  const mcpTools = Array.isArray(pack?.ontology?.mcpTools) ? pack.ontology.mcpTools : [];
  const schemas = Array.isArray(pack?.ontology?.schemas) ? pack.ontology.schemas : [];
  return {
    id: pack.id,
    version: pack.version || null,
    name: pack.name || pack.id,
    description: pack.description || "",
    filePath: pack.filePath,
    tags: [...(pack.tags || [])],
    capabilities: [...(pack.capabilities || [])],
    install: cloneJson(pack.install),
    counts: {
      nodes: nodes.length,
      integrations: integrations.length,
      mcpTools: mcpTools.length,
      schemas: schemas.length,
    },
    ontology: {
      nodes: nodes.map((node) => ({
        type: node.type,
        category: node.category,
        description: node.description,
        inputs: [...node.inputs],
        outputs: [...node.outputs],
        capabilities: [...node.capabilities],
        integration: cloneJson(node.integration),
        mcpTools: node.mcpTools.map((tool) => ({
          server: tool.server,
          name: tool.name,
          description: tool.description,
          inputSchema: cloneJson(tool.inputSchema),
        })),
        schema: cloneJson(node.schema),
      })),
      integrations: integrations.map((entry) => cloneJson(entry)),
      mcpTools: mcpTools.map((tool) => ({
        server: tool.server,
        name: tool.name,
        description: tool.description,
        inputSchema: cloneJson(tool.inputSchema),
      })),
      schemas: schemas.map((entry) => cloneJson(entry)),
    },
  };
}

function unloadPackFile(filePath) {
  const nodeTypes = packNodeTypesByFile.get(filePath) || [];
  for (const type of nodeTypes) unregisterNodeType(type);
  packNodeTypesByFile.delete(filePath);
  fileVersions.delete(filePath);
}

function createOntologyNodeHandler(nodeDef) {
  return {
    describe: () => nodeDef.description,
    schema: nodeDef.schema,
    inputs: nodeDef.inputs,
    outputs: nodeDef.outputs,
    ontology: {
      packId: nodeDef.packId,
      packVersion: nodeDef.packVersion,
      packName: nodeDef.packName,
      capabilities: [...nodeDef.capabilities],
      integration: nodeDef.integration ? { ...nodeDef.integration } : null,
      mcpTools: nodeDef.mcpTools.map((tool) => ({
        server: tool.server,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    },
    async execute(node, ctx) {
      const resolvedConfig = node?.config && typeof node.config === "object" ? { ...node.config } : {};
      const summary = `${nodeDef.packName}: ${nodeDef.type}`;
      if (ctx && typeof ctx.log === "function") {
        ctx.log(node?.id || nodeDef.type, `[ontology-pack] ${summary}`, "info");
      }
      return {
        success: true,
        port: "success",
        packId: nodeDef.packId,
        nodeType: nodeDef.type,
        integration: nodeDef.integration,
        capabilities: [...nodeDef.capabilities],
        config: resolvedConfig,
        mcpTools: nodeDef.mcpTools.map((tool) => ({ server: tool.server, name: tool.name })),
      };
    },
  };
}

function loadPackFile(filePath, repoRoot) {
  unloadPackFile(filePath);
  const raw = JSON.parse(readFileSync(filePath, "utf8"));
  const pack = normalizePack(raw, filePath);
  const registeredTypes = [];
  for (const nodeDef of pack.ontology.nodes) {
    const existingMeta = getNodeTypeMeta(nodeDef.type);
    if (existingMeta && existingMeta.filePath !== filePath) {
      throw new Error(`duplicate ontology node type '${nodeDef.type}' already registered from ${existingMeta.filePath || existingMeta.source}`);
    }
    registerNodeType(nodeDef.type, createOntologyNodeHandler(nodeDef), {
      source: "ontology-pack",
      badge: "pack",
      filePath,
      inputs: nodeDef.inputs,
      outputs: nodeDef.outputs,
      ontology: {
        packId: nodeDef.packId,
        packVersion: nodeDef.packVersion,
        packName: nodeDef.packName,
        capabilities: [...nodeDef.capabilities],
        integration: nodeDef.integration ? { ...nodeDef.integration } : null,
        mcpTools: nodeDef.mcpTools.map((tool) => ({
          server: tool.server,
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    });
    registeredTypes.push(nodeDef.type);
  }
  packNodeTypesByFile.set(filePath, registeredTypes);
  fileVersions.set(filePath, statSync(filePath).mtimeMs);
  const repoKey = defaultRepoRoot(repoRoot);
  const current = loadedPacksByRepo.get(repoKey) || [];
  loadedPacksByRepo.set(repoKey, [...current.filter((entry) => entry.filePath !== filePath), pack]);
  return pack;
}

export async function ensureWorkflowOntologyPacksLoaded(options = {}) {
  const repoRoot = defaultRepoRoot(options.repoRoot);
  const packRoot = getWorkflowOntologyPackDir({ repoRoot });
  loadedPacksByRepo.set(repoRoot, []);
  if (!existsSync(packRoot)) return [];

  const packFiles = readdirSync(packRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(packRoot, entry.name, "pack.json"))
    .filter((filePath) => existsSync(filePath))
    .sort();

  const loaded = [];
  for (const filePath of packFiles) {
    try {
      const version = statSync(filePath).mtimeMs;
      if (!options.forceReload && fileVersions.get(filePath) === version && packNodeTypesByFile.has(filePath)) {
        const existing = (loadedPacksByRepo.get(repoRoot) || []).find((entry) => entry.filePath === filePath);
        if (existing) loaded.push(existing);
        continue;
      }
      loaded.push(loadPackFile(filePath, repoRoot));
    } catch (error) {
      unloadPackFile(filePath);
      logWarn(`Skipping ${basename(filePath)}: ${error?.message || String(error)}`);
    }
  }

  loadedPacksByRepo.set(repoRoot, loaded);
  return loaded;
}

export function getInstalledWorkflowOntologyPacks(options = {}) {
  const repoRoot = defaultRepoRoot(options.repoRoot);
  return (loadedPacksByRepo.get(repoRoot) || []).map((pack) => summarizePack(pack));
}

export function findWorkflowOntologyCapabilities(options = {}) {
  const repoRoot = defaultRepoRoot(options.repoRoot);
  const query = String(options.query || "").trim().toLowerCase();
  const capabilityFilter = String(options.capability || "").trim().toLowerCase();
  const providerFilter = String(options.provider || "").trim().toLowerCase();

  const matchesQuery = (parts) => {
    if (!query) return true;
    return parts.some((part) => String(part || "").toLowerCase().includes(query));
  };

  const packs = getInstalledWorkflowOntologyPacks({ repoRoot });
  const results = [];
  for (const pack of packs) {
    const baseParts = [pack.id, pack.name, pack.description, ...(pack.tags || []), ...(pack.capabilities || [])];

    for (const node of pack.ontology?.nodes || []) {
      const provider = String(node?.integration?.provider || "").trim();
      const nodeCaps = [...(pack.capabilities || []), ...(node.capabilities || [])];
      if (capabilityFilter && !nodeCaps.some((entry) => String(entry).toLowerCase() === capabilityFilter)) continue;
      if (providerFilter && provider.toLowerCase() !== providerFilter) continue;
      if (!matchesQuery([...baseParts, node.type, node.category, node.description, provider, ...(node.capabilities || [])])) continue;
      results.push({
        kind: "node",
        packId: pack.id,
        packName: pack.name,
        packVersion: pack.version,
        type: node.type,
        category: node.category,
        description: node.description,
        capabilities: nodeCaps,
        integration: cloneJson(node.integration),
        mcpTools: cloneJson(node.mcpTools),
        schema: cloneJson(node.schema),
      });
    }

    for (const tool of pack.ontology?.mcpTools || []) {
      if (providerFilter && String(tool.server || "").toLowerCase() !== providerFilter) continue;
      if (!matchesQuery([...baseParts, tool.server, tool.name, tool.description])) continue;
      results.push({
        kind: "mcpTool",
        packId: pack.id,
        packName: pack.name,
        packVersion: pack.version,
        server: tool.server,
        name: tool.name,
        description: tool.description,
        inputSchema: cloneJson(tool.inputSchema),
      });
    }

    for (const integration of pack.ontology?.integrations || []) {
      const provider = String(integration?.provider || integration?.id || "").trim();
      if (providerFilter && provider.toLowerCase() !== providerFilter) continue;
      if (!matchesQuery([...baseParts, integration?.id, integration?.name, integration?.description, provider])) continue;
      results.push({
        kind: "integration",
        packId: pack.id,
        packName: pack.name,
        packVersion: pack.version,
        integration: cloneJson(integration),
      });
    }

    for (const schema of pack.ontology?.schemas || []) {
      if (!matchesQuery([...baseParts, schema?.id, schema?.name, schema?.description, schema?.provider])) continue;
      results.push({
        kind: "schema",
        packId: pack.id,
        packName: pack.name,
        packVersion: pack.version,
        schema: cloneJson(schema),
      });
    }
  }

  return results;
}
