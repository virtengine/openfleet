/**
 * _helpers.mjs — Shared helpers for workflow template definitions.
 *
 * These utilities generate positioned nodes and edges in a consistent format.
 * All template module files import from here.
 */

// ── Layout state ────────────────────────────────────────────────────────────

let _nextX = 100;
let _nextY = 100;

const TEMPLATE_LAYOUT_DEFAULTS = Object.freeze({
  centerX: 480,
  topY: 80,
  columnGap: 280,
  rowGap: 180,
});

function toFiniteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function getNodeOriginalPosition(node, fallbackX = 0) {
  return {
    x: toFiniteNumber(node?.position?.x, fallbackX),
    y: toFiniteNumber(node?.position?.y, 0),
  };
}

/**
 * Create a workflow node definition with automatic positioning.
 * @param {string} id - Unique node identifier within the template
 * @param {string} type - Node type (e.g. "trigger.pr_event", "action.run_agent")
 * @param {string} label - Human-readable label
 * @param {object} [config] - Node configuration
 * @param {object} [opts] - Position overrides and extra fields
 * @returns {object} Node definition
 */
export function node(id, type, label, config = {}, opts = {}) {
  const x = opts.x ?? _nextX;
  const y = opts.y ?? _nextY;
  _nextX = x + 280;
  return {
    id,
    type,
    label,
    config,
    position: { x, y },
    outputs: opts.outputs || ["default"],
    ...(opts.extra || {}),
  };
}

/**
 * Create a workflow edge definition.
 * @param {string} source - Source node ID
 * @param {string} target - Target node ID
 * @param {object} [opts] - Port, condition, and extra fields
 * @returns {object} Edge definition
 */
export function edge(source, target, opts = {}) {
  const e = {
    id: `${source}->${target}`,
    source,
    target,
    sourcePort: opts.port || "default",
    condition: opts.condition || undefined,
  };
  if (opts.backEdge) e.backEdge = true;
  if (opts.maxIterations != null) e.maxIterations = opts.maxIterations;
  if (opts.label) e.label = opts.label;
  return e;
}

/**
 * Reset the auto-layout position counters.
 * Call this before defining each new template.
 */
export function resetLayout() {
  _nextX = 100;
  _nextY = 100;
}

export function normalizeTemplateLayoutInPlace(template, opts = {}) {
  const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
  const edges = Array.isArray(template?.edges) ? template.edges : [];
  if (nodes.length <= 1) return template;

  const centerX = toFiniteNumber(opts.centerX, TEMPLATE_LAYOUT_DEFAULTS.centerX);
  const topY = toFiniteNumber(opts.topY, TEMPLATE_LAYOUT_DEFAULTS.topY);
  const columnGap = Math.max(180, toFiniteNumber(opts.columnGap, TEMPLATE_LAYOUT_DEFAULTS.columnGap));
  const rowGap = Math.max(120, toFiniteNumber(opts.rowGap, TEMPLATE_LAYOUT_DEFAULTS.rowGap));

  const nodeIds = new Set(nodes.map((node) => node.id));
  const originalIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const originalPosition = new Map(
    nodes.map((node, index) => [node.id, getNodeOriginalPosition(node, index * columnGap)]),
  );

  const incoming = new Map(nodes.map((node) => [node.id, []]));
  const outgoing = new Map(nodes.map((node) => [node.id, []]));
  for (const edgeDef of edges) {
    if (!edgeDef || edgeDef.backEdge === true) continue;
    const source = String(edgeDef.source || "").trim();
    const target = String(edgeDef.target || "").trim();
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    outgoing.get(source).push(target);
    incoming.get(target).push(source);
  }

  const sortedNodeIds = [...nodeIds].sort((left, right) => {
    const leftPos = originalPosition.get(left) || { x: 0, y: 0 };
    const rightPos = originalPosition.get(right) || { x: 0, y: 0 };
    if (leftPos.y !== rightPos.y) return leftPos.y - rightPos.y;
    if (leftPos.x !== rightPos.x) return leftPos.x - rightPos.x;
    return (originalIndex.get(left) || 0) - (originalIndex.get(right) || 0);
  });

  const rootIds = sortedNodeIds.filter((nodeId) => {
    const node = nodes[originalIndex.get(nodeId) || 0];
    return (incoming.get(nodeId)?.length || 0) === 0 || String(node?.type || "").startsWith("trigger.");
  });
  const queue = rootIds.length > 0 ? [...rootIds] : [sortedNodeIds[0]];
  const indegree = new Map([...incoming.entries()].map(([nodeId, parents]) => [nodeId, parents.length]));
  const depthById = new Map(queue.map((nodeId) => [nodeId, 0]));
  const queued = new Set(queue);

  for (const nodeId of sortedNodeIds) {
    if ((indegree.get(nodeId) || 0) === 0 && !queued.has(nodeId)) {
      queue.push(nodeId);
      queued.add(nodeId);
      depthById.set(nodeId, 0);
    }
  }

  while (queue.length > 0) {
    const nodeId = queue.shift();
    const currentDepth = depthById.get(nodeId) || 0;
    for (const targetId of outgoing.get(nodeId) || []) {
      const nextDepth = currentDepth + 1;
      if (nextDepth > (depthById.get(targetId) || 0)) {
        depthById.set(targetId, nextDepth);
      }
      indegree.set(targetId, (indegree.get(targetId) || 0) - 1);
      if ((indegree.get(targetId) || 0) <= 0 && !queued.has(targetId)) {
        queue.push(targetId);
        queued.add(targetId);
      }
    }
  }

  const unresolved = sortedNodeIds.filter((nodeId) => !depthById.has(nodeId));
  while (unresolved.length > 0) {
    let progressed = false;
    for (let index = unresolved.length - 1; index >= 0; index -= 1) {
      const nodeId = unresolved[index];
      const parents = incoming.get(nodeId) || [];
      if (parents.every((parentId) => depthById.has(parentId))) {
        const nextDepth = parents.length > 0
          ? Math.max(...parents.map((parentId) => depthById.get(parentId) || 0)) + 1
          : 0;
        depthById.set(nodeId, nextDepth);
        unresolved.splice(index, 1);
        progressed = true;
      }
    }
    if (progressed) continue;
    const nodeId = unresolved.shift();
    const parents = incoming.get(nodeId) || [];
    const knownParentDepths = parents
      .map((parentId) => depthById.get(parentId))
      .filter((depth) => Number.isFinite(depth));
    const fallbackDepth = knownParentDepths.length > 0
      ? Math.max(...knownParentDepths) + 1
      : 0;
    depthById.set(nodeId, fallbackDepth);
  }

  const layerMap = new Map();
  for (const nodeId of sortedNodeIds) {
    const depth = depthById.get(nodeId) || 0;
    if (!layerMap.has(depth)) layerMap.set(depth, []);
    layerMap.get(depth).push(nodeId);
  }

  const assignedX = new Map();
  const sortedLayers = [...layerMap.keys()].sort((left, right) => left - right);
  for (const depth of sortedLayers) {
    const layerNodeIds = layerMap.get(depth) || [];
    layerNodeIds.sort((left, right) => {
      const leftParents = (incoming.get(left) || []).filter((parentId) => assignedX.has(parentId));
      const rightParents = (incoming.get(right) || []).filter((parentId) => assignedX.has(parentId));
      const leftBarycenter = leftParents.length > 0
        ? leftParents.reduce((sum, parentId) => sum + assignedX.get(parentId), 0) / leftParents.length
        : (originalPosition.get(left)?.x || 0);
      const rightBarycenter = rightParents.length > 0
        ? rightParents.reduce((sum, parentId) => sum + assignedX.get(parentId), 0) / rightParents.length
        : (originalPosition.get(right)?.x || 0);
      if (leftBarycenter !== rightBarycenter) return leftBarycenter - rightBarycenter;
      const leftPos = originalPosition.get(left) || { x: 0, y: 0 };
      const rightPos = originalPosition.get(right) || { x: 0, y: 0 };
      if (leftPos.x !== rightPos.x) return leftPos.x - rightPos.x;
      if (leftPos.y !== rightPos.y) return leftPos.y - rightPos.y;
      return (originalIndex.get(left) || 0) - (originalIndex.get(right) || 0);
    });

    const startX = centerX - ((layerNodeIds.length - 1) * columnGap) / 2;
    layerNodeIds.forEach((nodeId, index) => {
      const node = nodes[originalIndex.get(nodeId) || 0];
      const x = Math.round(startX + index * columnGap);
      const y = topY + depth * rowGap;
      node.position = { x, y };
      assignedX.set(nodeId, x);
    });
  }

  return template;
}
