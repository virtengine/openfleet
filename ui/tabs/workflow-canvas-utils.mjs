function deepClone(value) {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {}
  return JSON.parse(JSON.stringify(value));
}

function normalizeGraphValue(value) {
  return Array.isArray(value) ? deepClone(value) : [];
}

function subsequenceScore(needle, haystack) {
  if (!needle || !haystack) return 0;
  let position = 0;
  for (const char of needle) {
    position = haystack.indexOf(char, position);
    if (position === -1) return 0;
    position += 1;
  }
  return Math.max(6, 18 - Math.max(0, haystack.length - needle.length));
}

function scoreField(value, token, weight = 1) {
  if (!value) return 0;
  if (value === token) return 160 * weight;
  if (value.startsWith(`${token}.`) || value.startsWith(`${token}_`)) return 140 * weight;
  if (value.startsWith(token)) return 120 * weight;
  if (value.includes(`.${token}`) || value.includes(`_${token}`) || value.includes(` ${token}`)) return 95 * weight;
  if (value.includes(token)) return 72 * weight;
  const fuzzy = subsequenceScore(token, value);
  return fuzzy ? fuzzy * weight : 0;
}

function getLabel(type) {
  return String(type || "").split(".").pop()?.replace(/_/g, " ") || String(type || "");
}

function normalizePreviewLine(text, maxLength = 84) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  return compact.length > maxLength
    ? `${compact.slice(0, Math.max(0, maxLength - 1))}…`
    : compact;
}

function collectPreviewText(value, lines = [], seen = new Set(), depth = 0) {
  if (value == null || depth > 2 || lines.length >= 6) return lines;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const rawLines = String(value)
      .split(/\r?\n/)
      .map((line) => normalizePreviewLine(line))
      .filter(Boolean);
    for (const line of rawLines) {
      if (seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
      if (lines.length >= 6) break;
    }
    return lines;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 4)) {
      collectPreviewText(item, lines, seen, depth + 1);
      if (lines.length >= 6) break;
    }
    return lines;
  }
  if (typeof value !== "object") return lines;

  const prioritizedKeys = [
    "summary",
    "narrative",
    "text",
    "message",
    "content",
    "output",
    "result",
    "answer",
    "response",
    "stdout",
    "stderr",
  ];
  let matched = false;
  for (const key of prioritizedKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    matched = true;
    collectPreviewText(value[key], lines, seen, depth + 1);
    if (lines.length >= 6) return lines;
  }
  if (Array.isArray(value.lines)) {
    matched = true;
    collectPreviewText(value.lines, lines, seen, depth + 1);
  }
  if (value.preview && typeof value.preview === "object") {
    matched = true;
    collectPreviewText(value.preview, lines, seen, depth + 1);
  }
  if (!matched) {
    try {
      const json = JSON.stringify(value);
      if (json) collectPreviewText(json, lines, seen, depth + 1);
    } catch {}
  }
  return lines;
}

function extractPreviewTokenCount(value) {
  if (!value || typeof value !== "object") return null;
  const candidates = [
    value.tokenCount,
    value.totalTokens,
    value.total_tokens,
    value.tokens,
    value.usage?.total_tokens,
    value.usage?.totalTokens,
    value.tokenUsage?.totalTokens,
    value.metrics?.total_tokens,
    value.metrics?.totalTokens,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.max(0, Math.round(parsed));
    }
  }
  const input = Number(
    value.inputTokens
    ?? value.input_tokens
    ?? value.promptTokens
    ?? value.prompt_tokens
    ?? value.usage?.prompt_tokens
    ?? value.usage?.inputTokens
    ?? value.tokenUsage?.inputTokens,
  );
  const output = Number(
    value.outputTokens
    ?? value.output_tokens
    ?? value.completionTokens
    ?? value.completion_tokens
    ?? value.usage?.completion_tokens
    ?? value.usage?.outputTokens
    ?? value.tokenUsage?.outputTokens,
  );
  if (Number.isFinite(input) || Number.isFinite(output)) {
    return Math.max(0, Math.round((Number.isFinite(input) ? input : 0) + (Number.isFinite(output) ? output : 0)));
  }
  return null;
}

function toNodeTypeMap(nodeTypes = []) {
  if (nodeTypes instanceof Map) return nodeTypes;
  return new Map((Array.isArray(nodeTypes) ? nodeTypes : []).map((type) => [type?.type, type]));
}

function normalizePortDescriptor(port, direction, index) {
  const fallbackName = index === 0 ? "default" : `${direction}-${index + 1}`;
  if (!port || typeof port !== "object") {
    return {
      name: fallbackName,
      label: fallbackName,
      type: "Any",
      description: "",
      accepts: [],
      color: null,
    };
  }
  return {
    ...port,
    name: String(port.name || fallbackName).trim() || fallbackName,
    label: String(port.label || port.name || fallbackName).trim() || fallbackName,
    type: String(port.type || "Any").trim() || "Any",
    description: String(port.description || "").trim(),
    accepts: Array.isArray(port.accepts)
      ? Array.from(new Set(port.accepts.map((value) => String(value || "").trim()).filter(Boolean)))
      : [],
    color: typeof port.color === "string" && port.color.trim() ? port.color.trim() : null,
  };
}

function resolvePortByName(ports, requestedName) {
  const normalizedName = String(requestedName || "").trim() || "default";
  return (Array.isArray(ports) ? ports : []).find((port) => port.name === normalizedName) || null;
}

function isWildcardPortType(type) {
  const normalized = String(type || "").trim();
  return normalized === "*" || normalized === "Any";
}

function isPortConnectionCompatible(sourcePort, targetPort) {
  if (!sourcePort || !targetPort) return { compatible: true, reason: null };
  const sourceType = String(sourcePort.type || "Any").trim() || "Any";
  const targetType = String(targetPort.type || "Any").trim() || "Any";
  const accepted = new Set(
    [targetType, ...(Array.isArray(targetPort.accepts) ? targetPort.accepts : [])]
      .map((value) => String(value || "").trim())
      .filter(Boolean),
  );
  if (isWildcardPortType(sourceType) || isWildcardPortType(targetType) || accepted.has("*") || accepted.has("Any")) {
    return { compatible: true, reason: null };
  }
  if (sourceType === targetType || accepted.has(sourceType)) {
    return { compatible: true, reason: null };
  }
  return {
    compatible: false,
    reason: `${sourcePort.label || sourcePort.name} emits ${sourceType}, but ${targetPort.label || targetPort.name} expects ${targetType}`,
  };
}

function buildUnknownPortIssue(edge, direction, requestedPortName, availablePorts = []) {
  const portLabel = direction === "output" ? "source" : "target";
  const availableNames = (Array.isArray(availablePorts) ? availablePorts : [])
    .map((port) => String(port?.name || "").trim())
    .filter(Boolean);
  const availableSuffix = availableNames.length ? ` Available ports: ${availableNames.join(", ")}.` : "";
  return {
    code: direction === "output" ? "unknown-output-port" : "unknown-input-port",
    edgeId: edge.id || `${edge.source}->${edge.target}`,
    source: edge.source,
    target: edge.target,
    sourcePort: direction === "output"
      ? requestedPortName
      : String(edge?.sourcePort ?? edge?.fromPort ?? "").trim() || "default",
    targetPort: direction === "input"
      ? requestedPortName
      : String(edge?.targetPort ?? edge?.toPort ?? "").trim() || "default",
    sourceType: null,
    targetType: null,
    severity: "error",
    message: `Unknown ${portLabel} port "${requestedPortName}" on edge ${edge.id || `${edge.source}->${edge.target}`}.${availableSuffix}`,
  };
}

export function createGraphSnapshot(nodes = [], edges = []) {
  const safeNodes = normalizeGraphValue(nodes);
  return {
    nodes: safeNodes,
    edges: hydrateCanvasEdges(safeNodes, normalizeGraphValue(edges)),
  };
}

export function serializeGraphSnapshot(nodesOrSnapshot = [], maybeEdges = []) {
  if (
    nodesOrSnapshot &&
    typeof nodesOrSnapshot === "object" &&
    !Array.isArray(nodesOrSnapshot) &&
    ("nodes" in nodesOrSnapshot || "edges" in nodesOrSnapshot)
  ) {
    return JSON.stringify(createGraphSnapshot(nodesOrSnapshot.nodes, nodesOrSnapshot.edges));
  }
  return JSON.stringify(createGraphSnapshot(nodesOrSnapshot, maybeEdges));
}

export function parseGraphSnapshot(snapshot) {
  if (!snapshot) return createGraphSnapshot();
  try {
    const parsed = typeof snapshot === "string" ? JSON.parse(snapshot) : snapshot;
    const edges = Array.isArray(parsed?.edges) ? parsed.edges : [];
    const shouldHydratePorts = edges.some((edge) => {
      if (!edge || typeof edge !== "object") return false;
      return ["sourcePort", "targetPort", "fromPort", "toPort"].some((key) => Object.prototype.hasOwnProperty.call(edge, key));
    });
    const normalizedEdges = shouldHydratePorts
      ? edges.map((edge) => {
        if (!edge || typeof edge !== "object") return edge;
        const sourcePort = String(edge.sourcePort ?? edge.fromPort ?? "").trim() || "default";
        const targetPort = String(edge.targetPort ?? edge.toPort ?? "").trim() || "default";
        const nextEdge = { ...edge, sourcePort, targetPort };
        delete nextEdge.fromPort;
        delete nextEdge.toPort;
        return nextEdge;
      })
      : edges;
    return createGraphSnapshot(parsed?.nodes, normalizedEdges);
  } catch {
    return createGraphSnapshot();
  }
}

export function resolveCanvasNodePorts(node, nodeTypes = []) {
  const typeInfo = toNodeTypeMap(nodeTypes).get(node?.type) || null;
  const typePorts = typeInfo?.ports || {};
  const typeInputs = Array.isArray(typeInfo?.inputs) ? typeInfo.inputs : typePorts.inputs;
  const typeOutputs = Array.isArray(typeInfo?.outputs) ? typeInfo.outputs : typePorts.outputs;
  const inputSource = Array.isArray(node?.inputPorts) && node.inputPorts.length
    ? node.inputPorts
    : typeInputs;
  const outputSource = Array.isArray(node?.outputPorts) && node.outputPorts.length
    ? node.outputPorts
    : typeOutputs;
  const inputs = (Array.isArray(inputSource) ? inputSource : [])
    .map((port, index) => normalizePortDescriptor(port, "input", index));
  const outputs = (Array.isArray(outputSource) ? outputSource : [])
    .map((port, index) => normalizePortDescriptor(port, "output", index));
  return {
    inputs: inputs.length ? inputs : [normalizePortDescriptor(null, "input", 0)],
    outputs: outputs.length ? outputs : [normalizePortDescriptor(null, "output", 0)],
  };
}

export function hydrateCanvasEdges(nodes = [], edges = [], nodeTypes = []) {
  const nodeTypeMap = toNodeTypeMap(nodeTypes);
  const nodeMap = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  return (Array.isArray(edges) ? edges : []).map((edge) => {
    const sourceNode = nodeMap.get(edge?.source);
    const targetNode = nodeMap.get(edge?.target);
    const sourcePorts = resolveCanvasNodePorts(sourceNode, nodeTypeMap).outputs;
    const targetPorts = resolveCanvasNodePorts(targetNode, nodeTypeMap).inputs;
    const requestedSourcePort = String(edge?.sourcePort ?? edge?.fromPort ?? "").trim() || "default";
    const requestedTargetPort = String(edge?.targetPort ?? edge?.toPort ?? "").trim() || "default";
    const sourcePort = resolvePortByName(sourcePorts, requestedSourcePort);
    const targetPort = resolvePortByName(targetPorts, requestedTargetPort);
    const normalized = {
      ...edge,
      sourcePort: sourcePort?.name || requestedSourcePort,
      targetPort: targetPort?.name || requestedTargetPort,
      sourcePortType: sourcePort?.type || String(edge?.sourcePortType || "").trim() || "Any",
      targetPortType: targetPort?.type || String(edge?.targetPortType || "").trim() || "Any",
    };
    delete normalized.fromPort;
    delete normalized.toPort;
    return normalized;
  });
}

function inspectCanvasEdgePortBinding(edge, nodeMap, nodeTypeMap) {
  const sourceNode = nodeMap.get(edge?.source);
  const targetNode = nodeMap.get(edge?.target);
  const sourcePorts = resolveCanvasNodePorts(sourceNode, nodeTypeMap).outputs;
  const targetPorts = resolveCanvasNodePorts(targetNode, nodeTypeMap).inputs;
  const requestedSourcePortName = String(edge?.sourcePort ?? edge?.fromPort ?? "").trim() || "default";
  const requestedTargetPortName = String(edge?.targetPort ?? edge?.toPort ?? "").trim() || "default";
  const sourcePort = resolvePortByName(sourcePorts, requestedSourcePortName);
  const targetPort = resolvePortByName(targetPorts, requestedTargetPortName);
  const issues = [];

  if (!sourcePort) {
    issues.push(buildUnknownPortIssue(edge, "output", requestedSourcePortName, sourcePorts));
  }
  if (!targetPort) {
    issues.push(buildUnknownPortIssue(edge, "input", requestedTargetPortName, targetPorts));
  }

  if (sourcePort && targetPort) {
    const compatibility = isPortConnectionCompatible(sourcePort, targetPort);
    if (!compatibility.compatible) {
      issues.push({
        code: "invalid-port-binding",
        edgeId: edge.id || `${edge.source}->${edge.target}`,
        source: edge.source,
        target: edge.target,
        sourcePort: sourcePort.name,
        targetPort: targetPort.name,
        sourceType: sourcePort.type,
        targetType: targetPort.type,
        severity: "error",
        message: compatibility.reason,
      });
    }
  }

  return {
    edge,
    sourceNode,
    targetNode,
    sourcePorts,
    targetPorts,
    sourcePort,
    targetPort,
    requestedSourcePortName,
    requestedTargetPortName,
    issues,
  };
}

export function inspectCanvasEdgePorts(edge, nodes = [], nodeTypes = []) {
  const nodeTypeMap = toNodeTypeMap(nodeTypes);
  const nodeMap = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  return inspectCanvasEdgePortBinding(edge, nodeMap, nodeTypeMap);
}

export function canUpdateCanvasEdgePortMapping(edge, patch = {}, nodes = [], nodeTypes = []) {
  const validation = inspectCanvasEdgePorts({ ...edge, ...patch }, nodes, nodeTypes);
  const changedSourcePort = Object.prototype.hasOwnProperty.call(patch, "sourcePort")
    || Object.prototype.hasOwnProperty.call(patch, "fromPort");
  const changedTargetPort = Object.prototype.hasOwnProperty.call(patch, "targetPort")
    || Object.prototype.hasOwnProperty.call(patch, "toPort");
  const blockingIssue = validation.issues.find((issue) => (
    (issue?.code === "unknown-output-port" && changedSourcePort)
    || (issue?.code === "unknown-input-port" && changedTargetPort)
  )) || null;
  return {
    allowed: !blockingIssue,
    blockingIssue,
    validation,
  };
}

export function validateCanvasEdgePorts(nodes = [], edges = [], nodeTypes = []) {
  const nodeTypeMap = toNodeTypeMap(nodeTypes);
  const nodeMap = new Map((Array.isArray(nodes) ? nodes : []).map((node) => [node.id, node]));
  const issues = [];
  for (const edge of Array.isArray(edges) ? edges : []) {
    issues.push(...inspectCanvasEdgePortBinding(edge, nodeMap, nodeTypeMap).issues);
  }
  return issues;
}

export const HISTORY_LIMIT = 50;
export const HISTORY_COMMIT_DEBOUNCE_MS = 220;

export function createHistoryState(nodes = [], edges = []) {
  return {
    past: [],
    present: serializeGraphSnapshot(nodes, edges),
    future: [],
  };
}

export function pushHistorySnapshot(history, nodes, edges, limit = 50) {
  const safeHistory = history || createHistoryState();
  const nextPresent = serializeGraphSnapshot(nodes, edges);
  if (nextPresent === safeHistory.present) return safeHistory;
  const nextPast = [...safeHistory.past, safeHistory.present];
  if (nextPast.length > limit) nextPast.splice(0, nextPast.length - limit);
  return {
    past: nextPast,
    present: nextPresent,
    future: [],
  };
}

export function undoHistory(history) {
  const safeHistory = history || createHistoryState();
  if (!safeHistory.past.length) {
    return { history: safeHistory, snapshot: parseGraphSnapshot(safeHistory.present) };
  }
  const previousPresent = safeHistory.past[safeHistory.past.length - 1];
  return {
    history: {
      past: safeHistory.past.slice(0, -1),
      present: previousPresent,
      future: [safeHistory.present, ...safeHistory.future],
    },
    snapshot: parseGraphSnapshot(previousPresent),
  };
}

export function redoHistory(history, limit = 50) {
  const safeHistory = history || createHistoryState();
  if (!safeHistory.future.length) {
    return { history: safeHistory, snapshot: parseGraphSnapshot(safeHistory.present) };
  }
  const [nextPresent, ...future] = safeHistory.future;
  const nextPast = [...safeHistory.past, safeHistory.present];
  if (nextPast.length > limit) nextPast.splice(0, nextPast.length - limit);
  return {
    history: {
      past: nextPast,
      present: nextPresent,
      future,
    },
    snapshot: parseGraphSnapshot(nextPresent),
  };
}

export function getNodeSearchMetadata(nodeType) {
  const schemaProps = Object.keys(nodeType?.schema?.properties || {});
  const declaredInputs = Array.isArray(nodeType?.inputs)
    ? nodeType.inputs.filter((value) => typeof value === "string" && value.trim())
    : [];
  const mergedInputs = [...new Set([...declaredInputs, ...schemaProps])];
  const outputs = Array.isArray(nodeType?.outputs) && nodeType.outputs.length ? nodeType.outputs : ["default"];
  return {
    category: nodeType?.category || String(nodeType?.type || "").split(".")[0] || "other",
    description: String(nodeType?.description || ""),
    inputs: mergedInputs,
    label: getLabel(nodeType?.type),
    outputs,
    type: String(nodeType?.type || ""),
  };
}

export function searchNodeTypes(types = [], query = "", limit = 30) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  const ranked = [];

  for (const nodeType of types) {
    const metadata = getNodeSearchMetadata(nodeType);
    const label = metadata.label.toLowerCase();
    const category = metadata.category.toLowerCase();
    const description = metadata.description.toLowerCase();
    const type = metadata.type.toLowerCase();
    const inputText = metadata.inputs.join(" ").toLowerCase();
    const outputText = metadata.outputs.join(" ").toLowerCase();
    const combined = `${type} ${label} ${category} ${description} ${inputText} ${outputText}`.trim();

    let score = normalizedQuery ? 0 : 1;
    let matched = !normalizedQuery;

    for (const token of tokens) {
      const tokenScore = Math.max(
        scoreField(type, token, 1.35),
        scoreField(label, token, 1.25),
        scoreField(category, token, 1.1),
        scoreField(inputText, token, 0.9),
        scoreField(outputText, token, 0.75),
        scoreField(description, token, 0.55),
      );
      if (!tokenScore) {
        matched = false;
        break;
      }
      matched = true;
      score += tokenScore;
    }

    if (!matched) continue;
    if (normalizedQuery) {
      if (type === normalizedQuery || label === normalizedQuery) score += 220;
      else if (type.startsWith(normalizedQuery) || label.startsWith(normalizedQuery)) score += 140;
      else if (combined.includes(normalizedQuery)) score += 60;
    }

    ranked.push({ ...nodeType, ...metadata, score });
  }

  ranked.sort((left, right) => right.score - left.score || left.type.localeCompare(right.type));
  return ranked.slice(0, Math.max(1, limit));
}

export function buildNodeStatusesFromRunDetail(run) {
  const detail = run?.detail || {};
  const statuses = { ...(detail?.nodeStatuses || {}) };
  const statusEvents = Array.isArray(detail?.nodeStatusEvents) ? detail.nodeStatusEvents : [];
  const logs = Array.isArray(detail?.logs) ? detail.logs : [];

  for (const event of statusEvents) {
    const nodeId = String(event?.nodeId || "").trim();
    const status = String(event?.status || "").trim();
    if (!nodeId || !status) continue;
    statuses[nodeId] = status;
  }

  if (Object.keys(statuses).length === 0) {
    const fallbackStatus = run?.status === "failed"
      ? "failed"
      : run?.status === "completed"
        ? "completed"
        : "running";
    for (const entry of logs) {
      const nodeId = String(entry?.nodeId || "").trim();
      if (!nodeId || statuses[nodeId]) continue;
      statuses[nodeId] = fallbackStatus;
    }
  }

  return statuses;
}

export function resolveNodeOutputPreview(_nodeType, livePreview = null, rawOutput = null) {
  const liveLines = Array.isArray(livePreview?.lines)
    ? livePreview.lines.map((line) => normalizePreviewLine(line)).filter(Boolean)
    : [];
  const liveTokenCount = extractPreviewTokenCount(livePreview);
  if (liveLines.length || liveTokenCount != null) {
    return {
      lines: liveLines.slice(0, 3),
      tokenCount: liveTokenCount,
    };
  }

  return {
    lines: collectPreviewText(rawOutput).slice(0, 3),
    tokenCount: extractPreviewTokenCount(rawOutput),
  };
}


