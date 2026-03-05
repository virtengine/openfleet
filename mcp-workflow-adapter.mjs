/**
 * mcp-workflow-adapter.mjs — MCP-to-Workflow Structured Data Bridge
 *
 * Bridges MCP tool outputs into structured, schema-aware data that the
 * workflow engine can route, filter, and pipe between nodes. Provides:
 *
 *   1. Output Schema Discovery — introspect MCP server tool schemas
 *   2. Structured Data Extraction — extract fields from MCP tool results
 *   3. Output Mapping — rename/reshape MCP output for downstream nodes
 *   4. Pipeline Orchestration — chain multiple MCP tool calls with data piping
 *   5. Type Coercion — safely coerce MCP text results to typed values
 *
 * MCP tools return content blocks (type: "text" | "image" | "resource").
 * This adapter parses text content as JSON when possible, extracts fields
 * via dot-paths or JSON pointers, and produces clean typed output objects
 * that downstream workflow nodes can consume via {{nodeId.field}} templates.
 *
 * EXPORTS:
 *   extractMcpOutput(raw, extractConfig)   — extract structured data from MCP result
 *   mapOutputFields(data, mapping)         — rename/reshape output fields
 *   coerceValue(value, targetType)         — type coercion with safety
 *   buildPipelineInput(prevOutput, inputMap) — build next tool's input from prev output
 *   parseMcpContent(mcpResult)             — parse MCP content blocks to usable data
 *   inferOutputSchema(toolSchema, sample)  — infer output schema from tool def + sample
 *   createPipelineSpec(steps)              — validate and normalize a pipeline spec
 */

// ── Constants ─────────────────────────────────────────────────────────────────

const TAG = "[mcp-workflow-adapter]";

// ── Content Parsing ───────────────────────────────────────────────────────────

/**
 * Parse MCP tool call result content blocks into structured data.
 * MCP returns { content: [{ type, text?, data?, ... }], isError? }
 *
 * Strategy:
 *   1. Collect all text blocks, join them
 *   2. Try to parse as JSON → return parsed object
 *   3. If multiple text blocks, try each individually
 *   4. Fall back to { text: rawText } for plain text results
 *
 * @param {Object} mcpResult — raw MCP tool/call response
 * @returns {{ data: any, text: string, contentType: string, isError: boolean }}
 */
export function parseMcpContent(mcpResult) {
  if (!mcpResult) {
    return { data: null, text: "", contentType: "empty", isError: false };
  }

  const isError = mcpResult.isError === true;
  const content = mcpResult.content || mcpResult;

  // Handle direct primitives
  if (typeof content === "string") {
    return { ...tryParseJson(content), isError };
  }
  if (typeof content === "number" || typeof content === "boolean") {
    return { data: content, text: String(content), contentType: "primitive", isError };
  }

  // Handle content block array (standard MCP response)
  if (Array.isArray(content)) {
    const textBlocks = content.filter((c) => c?.type === "text" && c.text != null);
    const imageBlocks = content.filter((c) => c?.type === "image");
    const resourceBlocks = content.filter((c) => c?.type === "resource");

    // Build return with all content types
    const result = {
      data: null,
      text: "",
      contentType: "mixed",
      isError,
      images: imageBlocks.length > 0 ? imageBlocks : undefined,
      resources: resourceBlocks.length > 0 ? resourceBlocks : undefined,
    };

    if (textBlocks.length === 0) {
      // No text content — try the whole content array as data
      result.data = content;
      result.text = JSON.stringify(content);
      result.contentType = "raw";
      return result;
    }

    // Join all text blocks
    const fullText = textBlocks.map((b) => b.text).join("\n");
    const parsed = tryParseJson(fullText);
    result.data = parsed.data;
    result.text = fullText;
    result.contentType = parsed.contentType;

    // If single text block didn't parse, try each individually
    if (parsed.contentType === "text" && textBlocks.length > 1) {
      const parsedBlocks = textBlocks.map((b) => tryParseJson(b.text));
      const jsonBlocks = parsedBlocks.filter((b) => b.contentType === "json");
      if (jsonBlocks.length > 0) {
        result.data = jsonBlocks.length === 1 ? jsonBlocks[0].data : jsonBlocks.map((b) => b.data);
        result.contentType = "json";
      }
    }

    return result;
  }

  // Handle plain objects (non-standard but possible)
  if (typeof content === "object") {
    return { data: content, text: JSON.stringify(content), contentType: "json", isError };
  }

  return { data: content, text: String(content), contentType: "unknown", isError };
}

/**
 * Try to parse a string as JSON, falling back to plain text.
 * @param {string} text
 * @returns {{ data: any, text: string, contentType: string }}
 */
function tryParseJson(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { data: null, text: "", contentType: "empty" };

  try {
    const parsed = JSON.parse(trimmed);
    return { data: parsed, text: trimmed, contentType: "json" };
  } catch {
    // Not JSON — return as text
    return { data: { text: trimmed }, text: trimmed, contentType: "text" };
  }
}

// ── Structured Data Extraction ────────────────────────────────────────────────

/**
 * Extract structured fields from MCP tool output.
 *
 * Supports three extraction modes:
 *   1. `fields` — dot-path field extraction (e.g. "data.items[0].title")
 *   2. `jsonPointer` — RFC 6901 JSON pointer (e.g. "/data/items/0/title")
 *   3. `jmesPath` — simplified JMESPath subset (e.g. "data.items[*].title")
 *
 * @param {any} rawData — parsed MCP output data
 * @param {Object} extractConfig — extraction configuration
 * @param {Object} [extractConfig.fields] — map of outputKey → sourcePath
 * @param {Object} [extractConfig.defaults] — default values for missing fields
 * @param {Object} [extractConfig.types] — type coercion map (outputKey → "string"|"number"|"boolean"|"array"|"json")
 * @param {string} [extractConfig.root] — root path to start extraction from
 * @returns {Object} — extracted structured data
 */
export function extractMcpOutput(rawData, extractConfig = {}) {
  if (!rawData || !extractConfig) return {};

  let data = rawData;

  // Apply root path if specified
  if (extractConfig.root) {
    data = getByPath(data, extractConfig.root);
    if (data === undefined) {
      return Object.fromEntries(
        Object.keys(extractConfig.fields || {}).map((k) => [
          k,
          extractConfig.defaults?.[k] ?? null,
        ]),
      );
    }
  }

  const fields = extractConfig.fields || {};
  const defaults = extractConfig.defaults || {};
  const types = extractConfig.types || {};
  const result = {};

  for (const [outputKey, sourcePath] of Object.entries(fields)) {
    let value;

    if (typeof sourcePath === "string") {
      if (sourcePath.startsWith("/")) {
        // JSON Pointer
        value = getByJsonPointer(data, sourcePath);
      } else if (sourcePath.includes("[*]")) {
        // Array wildcard — collect all matching values
        value = collectByWildcardPath(data, sourcePath);
      } else {
        // Dot-path
        value = getByPath(data, sourcePath);
      }
    } else if (typeof sourcePath === "function") {
      // Custom extractor function
      try {
        value = sourcePath(data);
      } catch {
        value = undefined;
      }
    } else {
      value = sourcePath; // Literal value
    }

    // Apply default if missing
    if (value === undefined || value === null) {
      value = defaults[outputKey] ?? null;
    }

    // Apply type coercion
    if (types[outputKey]) {
      value = coerceValue(value, types[outputKey]);
    }

    result[outputKey] = value;
  }

  return result;
}

/**
 * Get a value by dot-path notation.
 * Supports array indexing: "items[0].name" or "items.0.name"
 *
 * @param {any} obj — source object
 * @param {string} path — dot-separated path
 * @returns {any}
 */
export function getByPath(obj, path) {
  if (obj == null || !path) return undefined;

  // Normalize array bracket notation to dot notation
  const normalized = String(path)
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/^\./, "");

  const parts = normalized.split(".");
  let current = obj;

  for (const part of parts) {
    if (current == null) return undefined;
    if (typeof current === "object") {
      current = current[part];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Get a value by JSON Pointer (RFC 6901).
 * @param {any} obj
 * @param {string} pointer — e.g. "/data/items/0/title"
 * @returns {any}
 */
export function getByJsonPointer(obj, pointer) {
  if (!pointer || pointer === "/") return obj;
  const tokens = pointer.split("/").slice(1); // Skip initial empty string from leading /
  let current = obj;

  for (const raw of tokens) {
    if (current == null) return undefined;
    // Unescape JSON Pointer: ~1 → /, ~0 → ~
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const idx = parseInt(token, 10);
      current = Number.isFinite(idx) ? current[idx] : undefined;
    } else if (typeof current === "object") {
      current = current[token];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Collect values using a wildcard path (e.g. "items[*].name").
 * Returns an array of all matching values.
 *
 * @param {any} obj
 * @param {string} path — path with [*] wildcard
 * @returns {any[]}
 */
export function collectByWildcardPath(obj, path) {
  const parts = String(path).split("[*]");
  if (parts.length < 2) return [getByPath(obj, path)];

  const beforeWild = parts[0].replace(/\.$/, "");
  const afterWild = parts.slice(1).join("[*]").replace(/^\./, "");

  const arr = beforeWild ? getByPath(obj, beforeWild) : obj;
  if (!Array.isArray(arr)) return [];

  if (!afterWild) return arr;

  // If there are more wildcards, recurse
  if (afterWild.includes("[*]")) {
    return arr.flatMap((item) => collectByWildcardPath(item, afterWild));
  }

  return arr.map((item) => getByPath(item, afterWild)).filter((v) => v !== undefined);
}

// ── Type Coercion ─────────────────────────────────────────────────────────────

/**
 * Safely coerce a value to a target type.
 * @param {any} value
 * @param {string} targetType — "string" | "number" | "boolean" | "array" | "json" | "integer"
 * @returns {any}
 */
export function coerceValue(value, targetType) {
  if (value === null || value === undefined) return value;

  switch (targetType) {
    case "string":
      return typeof value === "string" ? value : JSON.stringify(value);

    case "number": {
      if (typeof value === "number") return value;
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    }

    case "integer": {
      if (typeof value === "number") return Math.trunc(value);
      const parsed = parseInt(String(value), 10);
      return Number.isFinite(parsed) ? parsed : null;
    }

    case "boolean":
      if (typeof value === "boolean") return value;
      if (typeof value === "string") {
        const lower = value.toLowerCase().trim();
        if (lower === "true" || lower === "1" || lower === "yes") return true;
        if (lower === "false" || lower === "0" || lower === "no") return false;
      }
      return Boolean(value);

    case "array":
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        try { return JSON.parse(value); } catch { /* fall through */ }
      }
      return [value];

    case "json":
      if (typeof value === "string") {
        try { return JSON.parse(value); } catch { return value; }
      }
      return value;

    default:
      return value;
  }
}

// ── Output Mapping ────────────────────────────────────────────────────────────

/**
 * Rename and reshape output fields according to a mapping.
 *
 * Mapping can be:
 *   - Simple rename: { newKey: "oldKey" }
 *   - Nested path: { newKey: "data.items[0].title" }
 *   - Literal value: { newKey: { _literal: "constant" } }
 *   - Template: { newKey: { _template: "PR #{{number}} by {{user.login}}" } }
 *   - Computed: { newKey: { _from: "items", _transform: "count" } }
 *
 * @param {Object} data — source data object
 * @param {Object} mapping — field mapping configuration
 * @param {Object} [templateCtx] — context for template resolution
 * @returns {Object} — mapped output
 */
export function mapOutputFields(data, mapping, templateCtx = null) {
  if (!mapping || typeof mapping !== "object") return data;
  if (!data || typeof data !== "object") return {};

  const result = {};

  for (const [outputKey, spec] of Object.entries(mapping)) {
    if (typeof spec === "string") {
      // Simple path reference
      result[outputKey] = getByPath(data, spec);
    } else if (spec && typeof spec === "object") {
      if ("_literal" in spec) {
        result[outputKey] = spec._literal;
      } else if ("_template" in spec && templateCtx?.resolve) {
        result[outputKey] = templateCtx.resolve(spec._template);
      } else if ("_from" in spec) {
        const source = getByPath(data, spec._from);
        result[outputKey] = applyTransform(source, spec._transform);
      } else if ("_concat" in spec && Array.isArray(spec._concat)) {
        result[outputKey] = spec._concat
          .map((p) => (typeof p === "string" ? getByPath(data, p) : p))
          .filter((v) => v != null)
          .join(spec._separator || ", ");
      } else {
        // Nested mapping — recurse
        result[outputKey] = mapOutputFields(data, spec, templateCtx);
      }
    } else {
      result[outputKey] = spec;
    }
  }

  return result;
}

/**
 * Apply a simple transform to a value.
 * @param {any} value
 * @param {string} transform
 * @returns {any}
 */
function applyTransform(value, transform) {
  if (!transform) return value;

  switch (transform) {
    case "count":
    case "length":
      if (Array.isArray(value)) return value.length;
      if (typeof value === "string") return value.length;
      if (value && typeof value === "object") return Object.keys(value).length;
      return 0;

    case "first":
      return Array.isArray(value) ? value[0] : value;

    case "last":
      return Array.isArray(value) ? value[value.length - 1] : value;

    case "flatten":
      return Array.isArray(value) ? value.flat() : value;

    case "unique":
      return Array.isArray(value) ? [...new Set(value)] : value;

    case "sort":
      return Array.isArray(value) ? [...value].sort() : value;

    case "reverse":
      return Array.isArray(value) ? [...value].reverse() : value;

    case "keys":
      return value && typeof value === "object" ? Object.keys(value) : [];

    case "values":
      return value && typeof value === "object" ? Object.values(value) : [];

    case "entries":
      return value && typeof value === "object" ? Object.entries(value) : [];

    case "json":
      return JSON.stringify(value, null, 2);

    case "compact":
      return JSON.stringify(value);

    case "trim":
      return typeof value === "string" ? value.trim() : value;

    case "lowercase":
      return typeof value === "string" ? value.toLowerCase() : value;

    case "uppercase":
      return typeof value === "string" ? value.toUpperCase() : value;

    case "sum":
      return Array.isArray(value) ? value.reduce((a, b) => a + Number(b), 0) : value;

    case "join":
      return Array.isArray(value) ? value.join(", ") : value;

    case "boolean":
      return Boolean(value);

    case "not":
      return !value;

    default:
      return value;
  }
}

// ── Pipeline Input Building ───────────────────────────────────────────────────

/**
 * Build the input arguments for the next MCP tool in a pipeline,
 * using the previous tool's output and an input map.
 *
 * The inputMap specifies how to wire output fields to input parameters:
 *   {
 *     // Direct field reference from previous output
 *     "owner": "data.repository.owner.login",
 *     // Literal value
 *     "state": { "_literal": "open" },
 *     // From workflow context variable
 *     "repo": { "_variable": "repoName" },
 *     // Template with interpolation
 *     "title": { "_template": "Review: {{data.title}}" }
 *   }
 *
 * @param {Object} prevOutput — previous tool's structured output
 * @param {Object} inputMap — mapping from input param names → sources
 * @param {Object} [ctx] — workflow context for variable resolution
 * @returns {Object} — ready-to-use input arguments for the next tool
 */
export function buildPipelineInput(prevOutput, inputMap, ctx = null) {
  if (!inputMap || typeof inputMap !== "object") return {};
  const result = {};

  for (const [paramName, spec] of Object.entries(inputMap)) {
    if (typeof spec === "string") {
      // Direct path reference from previous output
      result[paramName] = getByPath(prevOutput, spec);
    } else if (spec && typeof spec === "object") {
      if ("_literal" in spec) {
        result[paramName] = spec._literal;
      } else if ("_variable" in spec && ctx) {
        result[paramName] = ctx.resolve?.(`{{${spec._variable}}}`) ?? ctx.data?.[spec._variable];
      } else if ("_template" in spec && ctx?.resolve) {
        result[paramName] = ctx.resolve(spec._template);
      } else if ("_from" in spec) {
        const source = getByPath(prevOutput, spec._from);
        result[paramName] = spec._transform ? applyTransform(source, spec._transform) : source;
      } else if ("_concat" in spec && Array.isArray(spec._concat)) {
        result[paramName] = spec._concat
          .map((p) => (typeof p === "string" ? getByPath(prevOutput, p) : p))
          .filter((v) => v != null)
          .join(spec._separator || "");
      } else if ("_index" in spec) {
        const source = getByPath(prevOutput, spec._from || "");
        result[paramName] = Array.isArray(source) ? source[spec._index] : undefined;
      } else {
        result[paramName] = spec;
      }
    } else {
      result[paramName] = spec;
    }
  }

  return result;
}

// ── Output Schema Inference ───────────────────────────────────────────────────

/**
 * Infer output schema from a tool's schema definition and/or a sample output.
 * Useful for the visual builder to show what fields are available for piping.
 *
 * @param {Object} [toolSchema] — the tool's input schema from MCP tools/list
 * @param {any} [sampleOutput] — a sample output from a previous invocation
 * @returns {Object} — inferred output schema { fields: [{ name, type, path, description }] }
 */
export function inferOutputSchema(toolSchema, sampleOutput) {
  const fields = [];

  // Always include standard MCP workflow adapter fields
  fields.push(
    { name: "success", type: "boolean", path: "success", description: "Whether the tool call succeeded" },
    { name: "server", type: "string", path: "server", description: "MCP server ID" },
    { name: "tool", type: "string", path: "tool", description: "Tool name" },
    { name: "text", type: "string", path: "text", description: "Raw text output" },
    { name: "isError", type: "boolean", path: "isError", description: "Whether MCP reported an error" },
  );

  // Infer from sample output if available
  if (sampleOutput && typeof sampleOutput === "object") {
    const discovered = discoverFields(sampleOutput, "", 0, 4);
    for (const field of discovered) {
      // Don't duplicate standard fields
      if (!fields.some((f) => f.path === field.path)) {
        fields.push(field);
      }
    }
  }

  return { fields };
}

/**
 * Recursively discover fields in an object for schema inference.
 * @param {any} obj
 * @param {string} prefix
 * @param {number} depth
 * @param {number} maxDepth
 * @returns {Array<{name: string, type: string, path: string, description: string}>}
 */
function discoverFields(obj, prefix, depth, maxDepth) {
  if (depth >= maxDepth || obj == null) return [];
  const fields = [];

  if (Array.isArray(obj)) {
    fields.push({
      name: prefix || "root",
      type: "array",
      path: prefix || ".",
      description: `Array with ${obj.length} item(s)`,
      itemCount: obj.length,
    });
    // Sample first element for sub-fields
    if (obj.length > 0 && typeof obj[0] === "object" && obj[0] !== null) {
      const subFields = discoverFields(obj[0], `${prefix}[0]`, depth + 1, maxDepth);
      fields.push(...subFields);
      // Also add wildcard paths for array access
      for (const sf of subFields) {
        const wildcardPath = sf.path.replace(`${prefix}[0]`, `${prefix}[*]`);
        if (wildcardPath !== sf.path) {
          fields.push({
            ...sf,
            name: `${sf.name} (all)`,
            path: wildcardPath,
            description: `All ${sf.name} values from each item`,
          });
        }
      }
    }
    return fields;
  }

  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const type = value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value;

      fields.push({
        name: key,
        type,
        path,
        description: type === "array" ? `Array (${value.length} items)` : `${type} value`,
      });

      if (typeof value === "object" && value !== null) {
        fields.push(...discoverFields(value, path, depth + 1, maxDepth));
      }
    }
  }

  return fields;
}

// ── Pipeline Specification ────────────────────────────────────────────────────

/**
 * Validate and normalize a pipeline specification.
 * A pipeline is an ordered list of MCP tool invocations where each step
 * can reference the output of previous steps.
 *
 * @param {Array<Object>} steps — pipeline step definitions
 * @returns {{ valid: boolean, steps: Array, errors: string[] }}
 *
 * Each step:
 * {
 *   id: "step-1",                    // Unique step identifier
 *   server: "github",                // MCP server ID
 *   tool: "list_pull_requests",      // Tool name on that server
 *   input: { owner: "...", ... },    // Static input or pipeline references
 *   inputMap: { ... },               // Map previous step output → this step's input
 *   extract: { fields: { ... } },    // Extract specific fields from output
 *   outputMap: { ... },              // Rename/reshape output for downstream
 *   condition: "{{prev.success}}",   // Skip this step if condition is falsy
 *   continueOnError: false,          // Whether to continue pipeline on failure
 * }
 */
export function createPipelineSpec(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return { valid: false, steps: [], errors: ["Pipeline must have at least one step"] };
  }

  const errors = [];
  const normalized = [];
  const stepIds = new Set();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (!step || typeof step !== "object") {
      errors.push(`Step ${i}: invalid step definition`);
      continue;
    }

    const id = step.id || `step-${i}`;
    if (stepIds.has(id)) {
      errors.push(`Step ${i}: duplicate step ID "${id}"`);
      continue;
    }
    stepIds.add(id);

    if (!step.server) {
      errors.push(`Step ${i} (${id}): 'server' is required`);
    }
    if (!step.tool) {
      errors.push(`Step ${i} (${id}): 'tool' is required`);
    }

    normalized.push({
      id,
      server: step.server || "",
      tool: step.tool || "",
      input: step.input || {},
      inputMap: step.inputMap || null,
      extract: step.extract || null,
      outputMap: step.outputMap || null,
      condition: step.condition || null,
      continueOnError: step.continueOnError === true,
      timeoutMs: step.timeoutMs || 30000,
    });
  }

  return {
    valid: errors.length === 0,
    steps: normalized,
    errors,
  };
}

// ── Port Resolution for Routing ───────────────────────────────────────────────

/**
 * Determine the output port for an MCP tool result, enabling conditional
 * routing in the workflow DAG based on the tool's response.
 *
 * @param {Object} output — the structured tool output
 * @param {Object} [portConfig] — port routing configuration
 * @param {string} [portConfig.field] — field to use as port selector
 * @param {Object} [portConfig.map] — map field values to port names
 * @param {string} [portConfig.default] — default port name
 * @returns {string} — resolved output port name
 */
export function resolveOutputPort(output, portConfig) {
  if (!portConfig || typeof portConfig !== "object") {
    return output?.success === false ? "error" : "default";
  }

  const field = portConfig.field || "success";
  const value = getByPath(output, field);
  const portMap = portConfig.map || {};
  const defaultPort = portConfig.default || "default";

  // Check the mapping for a matching value
  const normalizedValue = String(value ?? "").toLowerCase().trim();
  if (portMap[normalizedValue]) return portMap[normalizedValue];
  if (portMap[String(value)]) return portMap[String(value)];

  // Boolean convenience: success → "default", failure → "error"
  if (field === "success" || field === "isError") {
    if (value === true && field === "success") return "default";
    if (value === false && field === "success") return "error";
    if (value === true && field === "isError") return "error";
    if (value === false && field === "isError") return "default";
  }

  return normalizedValue || defaultPort;
}
