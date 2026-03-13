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

export function createGraphSnapshot(nodes = [], edges = []) {
  return {
    nodes: normalizeGraphValue(nodes),
    edges: normalizeGraphValue(edges),
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
    return createGraphSnapshot(parsed?.nodes, parsed?.edges);
  } catch {
    return createGraphSnapshot();
  }
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

  // Backfill older runs that only recorded nodeId in logs.
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
