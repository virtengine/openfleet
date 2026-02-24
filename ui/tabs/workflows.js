/* ─────────────────────────────────────────────────────────────
 *  Tab: Workflows — N8N-style Visual Workflow Builder
 *  Drag-and-drop canvas for creating/editing Bosun workflows
 * ────────────────────────────────────────────────────────────── */
import { h } from "preact";
import { useState, useCallback, useEffect, useRef, useMemo } from "preact/hooks";
import { signal } from "@preact/signals";
import htm from "htm";

const html = htm.bind(h);

import { haptic } from "../modules/telegram.js";
import { apiFetch } from "../modules/api.js";
import { showToast, refreshTab } from "../modules/state.js";
import { navigateTo } from "../modules/router.js";
import { ICONS } from "../modules/icons.js";
import { iconText, resolveIcon } from "../modules/icon-utils.js";
import { formatRelative } from "../modules/utils.js";
import { Card, Badge, EmptyState } from "../components/shared.js";

/* ═══════════════════════════════════════════════════════════════
 *  State
 * ═══════════════════════════════════════════════════════════════ */

const workflows = signal([]);
const templates = signal([]);
const nodeTypes = signal([]);
const activeWorkflow = signal(null);
const workflowRuns = signal([]);
const canvasZoom = signal(1);
const canvasOffset = signal({ x: 0, y: 0 });
const selectedNodeId = signal(null);
const selectedEdgeId = signal(null);
const draggingNode = signal(null);
const connectingFrom = signal(null);
const isLoading = signal(false);
const viewMode = signal("list"); // "list" | "canvas" | "runs"

/* ═══════════════════════════════════════════════════════════════
 *  API Helpers
 * ═══════════════════════════════════════════════════════════════ */

async function loadWorkflows() {
  try {
    const data = await apiFetch("/api/workflows");
    if (data?.workflows) workflows.value = data.workflows;
  } catch (err) {
    console.error("[workflows] Failed to load:", err);
  }
}

async function loadTemplates() {
  try {
    const data = await apiFetch("/api/workflows/templates");
    if (data?.templates) templates.value = data.templates;
  } catch (err) {
    console.error("[workflows] Failed to load templates:", err);
  }
}

async function loadNodeTypes() {
  try {
    const data = await apiFetch("/api/workflows/node-types");
    if (data?.nodeTypes) nodeTypes.value = data.nodeTypes;
  } catch (err) {
    console.error("[workflows] Failed to load node types:", err);
  }
}

async function saveWorkflow(def) {
  try {
    const data = await apiFetch("/api/workflows/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(def),
    });
    if (data?.workflow) {
      activeWorkflow.value = data.workflow;
      showToast("Workflow saved", "success");
      loadWorkflows();
    }
    return data?.workflow;
  } catch (err) {
    showToast("Failed to save workflow", "error");
  }
}

async function deleteWorkflow(id) {
  try {
    await apiFetch(`/api/workflows/${id}`, { method: "DELETE" });
    showToast("Workflow deleted", "success");
    if (activeWorkflow.value?.id === id) {
      activeWorkflow.value = null;
      viewMode.value = "list";
    }
    loadWorkflows();
  } catch (err) {
    showToast("Failed to delete workflow", "error");
  }
}

async function executeWorkflow(id) {
  try {
    isLoading.value = true;
    const data = await apiFetch(`/api/workflows/${id}/execute`, { method: "POST" });
    showToast("Workflow started", "success");
    return data;
  } catch (err) {
    showToast("Failed to execute workflow", "error");
  } finally {
    isLoading.value = false;
  }
}

async function installTemplate(templateId) {
  try {
    const data = await apiFetch("/api/workflows/install-template", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId }),
    });
    if (data?.workflow) {
      activeWorkflow.value = data.workflow;
      viewMode.value = "canvas";
      showToast("Template installed", "success");
      loadWorkflows();
    }
  } catch (err) {
    showToast("Failed to install template", "error");
  }
}

async function loadRuns(workflowId) {
  try {
    const url = workflowId
      ? `/api/workflows/${workflowId}/runs`
      : "/api/workflows/runs";
    const data = await apiFetch(url);
    if (data?.runs) workflowRuns.value = data.runs;
  } catch (err) {
    console.error("[workflows] Failed to load runs:", err);
  }
}

/* ═══════════════════════════════════════════════════════════════
 *  Node Type Metadata (colors, icons)
 * ═══════════════════════════════════════════════════════════════ */

const NODE_CATEGORY_META = {
  trigger:    { color: "#10b981", bg: "#10b98120", icon: "zap", label: "Triggers" },
  condition:  { color: "#f59e0b", bg: "#f59e0b20", icon: "filter", label: "Conditions" },
  action:     { color: "#3b82f6", bg: "#3b82f620", icon: "play", label: "Actions" },
  validation: { color: "#8b5cf6", bg: "#8b5cf620", icon: "check", label: "Validation" },
  transform:  { color: "#ec4899", bg: "#ec489920", icon: "refresh", label: "Transform" },
  notify:     { color: "#06b6d4", bg: "#06b6d420", icon: "bell", label: "Notify" },
  agent:      { color: "#f97316", bg: "#f9731620", icon: "bot", label: "Agent" },
  loop:       { color: "#64748b", bg: "#64748b20", icon: "repeat", label: "Loop" },
};

function getNodeMeta(type) {
  const [cat] = (type || "").split(".");
  return NODE_CATEGORY_META[cat] || { color: "#6b7280", bg: "#6b728020", icon: "diamond", label: "Other" };
}

function stripEmoji(text) {
  return String(text || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* ═══════════════════════════════════════════════════════════════
 *  Canvas — SVG-based Workflow Editor
 * ═══════════════════════════════════════════════════════════════ */

function WorkflowCanvas({ workflow, onSave }) {
  const canvasRef = useRef(null);
  const [nodes, setNodes] = useState(workflow?.nodes || []);
  const [edges, setEdges] = useState(workflow?.edges || []);
  const [dragState, setDragState] = useState(null);
  const [panStart, setPanStart] = useState(null);
  const [connecting, setConnecting] = useState(null);
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  const [editingNode, setEditingNode] = useState(null);
  const [showNodePalette, setShowNodePalette] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState(null);

  useEffect(() => {
    setNodes(workflow?.nodes || []);
    setEdges(workflow?.edges || []);
  }, [workflow?.id, workflow?.nodes?.length, workflow?.edges?.length]);

  // Canvas dimensions
  const NODE_W = 220;
  const NODE_H = 60;
  const PORT_R = 8;

  const toCanvas = useCallback((clientX, clientY) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - pan.x) / zoom,
      y: (clientY - rect.top - pan.y) / zoom,
    };
  }, [zoom, pan]);

  // ── Mouse events ──────────────────────────────────────────

  const onMouseDown = useCallback((e) => {
    if (e.button === 1 || (e.button === 0 && e.ctrlKey)) {
      // Middle click or ctrl+click = pan
      setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
      e.preventDefault();
    } else if (e.button === 0 && e.target === canvasRef.current?.querySelector(".canvas-bg")) {
      // Click on background = deselect
      selectedNodeId.value = null;
      selectedEdgeId.value = null;
      setEditingNode(null);
      setContextMenu(null);
    }
  }, [pan]);

  const onMouseMove = useCallback((e) => {
    const canvasPos = toCanvas(e.clientX, e.clientY);
    setMousePos(canvasPos);

    if (panStart) {
      setPan({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
      return;
    }
    if (dragState) {
      setNodes(prev => prev.map(n =>
        n.id === dragState.nodeId
          ? { ...n, position: { x: canvasPos.x - dragState.offsetX, y: canvasPos.y - dragState.offsetY } }
          : n
      ));
    }
  }, [panStart, dragState, toCanvas]);

  const onMouseUp = useCallback(() => {
    if (panStart) setPanStart(null);
    if (dragState) {
      setDragState(null);
      autoSave();
    }
    if (connecting) {
      setConnecting(null);
    }
  }, [panStart, dragState, connecting]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => Math.max(0.2, Math.min(3, z + delta)));
  }, []);

  // ── Node interaction ──────────────────────────────────────

  const onNodeMouseDown = useCallback((nodeId, e) => {
    e.stopPropagation();
    selectedNodeId.value = nodeId;
    setContextMenu(null);
    const canvasPos = toCanvas(e.clientX, e.clientY);
    const node = nodes.find(n => n.id === nodeId);
    if (node) {
      setDragState({
        nodeId,
        offsetX: canvasPos.x - (node.position?.x || 0),
        offsetY: canvasPos.y - (node.position?.y || 0),
      });
    }
  }, [nodes, toCanvas]);

  const onNodeDoubleClick = useCallback((nodeId) => {
    setEditingNode(nodeId);
  }, []);

  const onNodeContextMenu = useCallback((nodeId, e) => {
    e.preventDefault();
    e.stopPropagation();
    selectedNodeId.value = nodeId;
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId });
  }, []);

  // ── Port / connection interaction ─────────────────────────

  const onOutputPortMouseDown = useCallback((nodeId, e) => {
    e.stopPropagation();
    setConnecting({ sourceId: nodeId, startX: e.clientX, startY: e.clientY });
  }, []);

  const onInputPortMouseUp = useCallback((nodeId) => {
    if (connecting && connecting.sourceId !== nodeId) {
      const edgeId = `${connecting.sourceId}->${nodeId}`;
      const exists = edges.some(e => e.source === connecting.sourceId && e.target === nodeId);
      if (!exists) {
        setEdges(prev => [...prev, {
          id: edgeId,
          source: connecting.sourceId,
          target: nodeId,
          sourcePort: "default",
        }]);
        autoSave();
      }
    }
    setConnecting(null);
  }, [connecting, edges]);

  // ── CRUD ──────────────────────────────────────────────────

  const addNode = useCallback((type) => {
    const id = `node-${Date.now()}`;
    const [cat, name] = type.split(".");
    const meta = getNodeMeta(type);
    const newNode = {
      id,
      type,
      label: name?.replace(/_/g, " ") || type,
      config: {},
      position: { x: mousePos.x || 300, y: mousePos.y || 300 },
      outputs: ["default"],
    };
    setNodes(prev => [...prev, newNode]);
    selectedNodeId.value = id;
    setShowNodePalette(false);
    haptic("light");
  }, [mousePos]);

  const deleteNode = useCallback((nodeId) => {
    setNodes(prev => prev.filter(n => n.id !== nodeId));
    setEdges(prev => prev.filter(e => e.source !== nodeId && e.target !== nodeId));
    if (selectedNodeId.value === nodeId) selectedNodeId.value = null;
    setEditingNode(null);
    setContextMenu(null);
    autoSave();
  }, []);

  const deleteEdge = useCallback((edgeId) => {
    setEdges(prev => prev.filter(e => e.id !== edgeId));
    selectedEdgeId.value = null;
    autoSave();
  }, []);

  const updateNodeConfig = useCallback((nodeId, configPatch) => {
    setNodes(prev => prev.map(n =>
      n.id === nodeId ? { ...n, config: { ...n.config, ...configPatch } } : n
    ));
    autoSave();
  }, []);

  const updateNodeLabel = useCallback((nodeId, label) => {
    setNodes(prev => prev.map(n =>
      n.id === nodeId ? { ...n, label } : n
    ));
    autoSave();
  }, []);

  // ── Auto-save (debounced) ─────────────────────────────────

  const saveTimer = useRef(null);
  const autoSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (!workflow?.id) return;
      const updated = {
        ...workflow,
        nodes: nodes,
        edges: edges,
      };
      // Use latest state
      saveWorkflow(updated);
    }, 1500);
  }, [workflow, nodes, edges]);

  // cleanup
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  // ── Render helpers ────────────────────────────────────────

  const getNodeCenter = (nodeId) => {
    const n = nodes.find(n => n.id === nodeId);
    if (!n) return { x: 0, y: 0 };
    return { x: (n.position?.x || 0) + NODE_W / 2, y: (n.position?.y || 0) + NODE_H / 2 };
  };

  const getInputPort = (nodeId) => {
    const n = nodes.find(n => n.id === nodeId);
    if (!n) return { x: 0, y: 0 };
    return { x: (n.position?.x || 0), y: (n.position?.y || 0) + NODE_H / 2 };
  };

  const getOutputPort = (nodeId) => {
    const n = nodes.find(n => n.id === nodeId);
    if (!n) return { x: 0, y: 0 };
    return { x: (n.position?.x || 0) + NODE_W, y: (n.position?.y || 0) + NODE_H / 2 };
  };

  // Bezier curve between points
  const curvePath = (x1, y1, x2, y2) => {
    const dx = Math.abs(x2 - x1) * 0.5;
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  };

  // ── Render ────────────────────────────────────────────────

  return html`
    <div class="wf-canvas-container" style="position: relative; width: 100%; overflow: hidden; background: var(--color-bg-secondary, #0f1117);">

      <!-- Toolbar -->
      <div class="wf-toolbar" style="position: absolute; top: 12px; left: 12px; right: 12px; z-index: 20; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <button class="wf-btn wf-btn-primary" onClick=${() => setShowNodePalette(!showNodePalette)} style="display: flex; align-items: center; gap: 6px;">
          <span style="font-size: 18px;">+</span> Add Node
        </button>
        <button class="wf-btn" onClick=${() => { if (workflow) saveWorkflow({ ...workflow, nodes, edges }); }}>
          <span class="btn-icon">${resolveIcon("save")}</span>
          Save
        </button>
        <button class="wf-btn" onClick=${() => { if (workflow?.id) executeWorkflow(workflow.id); }}>
          <span class="btn-icon">${resolveIcon("play")}</span>
          Run
        </button>
        <div style="flex:1;"></div>
        <span class="wf-badge" style="font-size: 11px; opacity: 0.7;">
          ${nodes.length} nodes · ${edges.length} edges · Zoom: ${Math.round(zoom * 100)}%
        </span>
        <button class="wf-btn wf-btn-sm" onClick=${() => setZoom(1)}>Reset Zoom</button>
        <button class="wf-btn wf-btn-sm" onClick=${() => setPan({ x: 0, y: 0 })}>Reset Pan</button>
        <button class="wf-btn wf-btn-sm" onClick=${() => viewMode.value = "list"}>← Back</button>
      </div>

      <!-- Node Palette (dropdown) -->
      ${showNodePalette && html`
        <${NodePalette}
          nodeTypes=${nodeTypes.value}
          onSelect=${(type) => addNode(type)}
          onClose=${() => setShowNodePalette(false)}
        />
      `}

      <!-- SVG Canvas -->
      <svg
        ref=${canvasRef}
        style="position: absolute; inset: 0; width: 100%; height: 100%; cursor: ${panStart ? 'grabbing' : dragState ? 'move' : 'default'};"
        onMouseDown=${onMouseDown}
        onMouseMove=${onMouseMove}
        onMouseUp=${onMouseUp}
        onWheel=${onWheel}
        onContextMenu=${(e) => e.preventDefault()}
      >
        <defs>
          <pattern id="grid-pattern" width="20" height="20" patternUnits="userSpaceOnUse" patternTransform="translate(${pan.x} ${pan.y}) scale(${zoom})">
            <circle cx="1" cy="1" r="0.5" fill="#ffffff10" />
          </pattern>
          <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#6b7280" />
          </marker>
          <filter id="node-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.3" />
          </filter>
          <filter id="node-glow" x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="#3b82f6" flood-opacity="0.5" />
          </filter>
        </defs>

        <!-- Background grid — covers entire pannable area -->
        <rect class="canvas-bg" x="-10000" y="-10000" width="30000" height="30000" fill="url(#grid-pattern)" />

        <g transform="translate(${pan.x} ${pan.y}) scale(${zoom})">

          <!-- Edges -->
          ${edges.map(edge => {
            const from = getOutputPort(edge.source);
            const to = getInputPort(edge.target);
            const isSelected = selectedEdgeId.value === edge.id;
            const hasCondition = !!edge.condition;
            return html`
              <g key=${edge.id} class="wf-edge" onClick=${(e) => { e.stopPropagation(); selectedEdgeId.value = edge.id; }}>
                <path
                  d=${curvePath(from.x, from.y, to.x, to.y)}
                  fill="none"
                  stroke=${isSelected ? "#3b82f6" : hasCondition ? "#f59e0b" : "#6b7280"}
                  stroke-width=${isSelected ? 3 : 2}
                  stroke-dasharray=${hasCondition ? "6,4" : "none"}
                  marker-end="url(#arrowhead)"
                  style="cursor: pointer; transition: stroke 0.15s;"
                />
                <!-- Invisible wider hit area -->
                <path
                  d=${curvePath(from.x, from.y, to.x, to.y)}
                  fill="none"
                  stroke="transparent"
                  stroke-width="12"
                  style="cursor: pointer;"
                />
                ${hasCondition && html`
                  <text
                    x=${(from.x + to.x) / 2}
                    y=${(from.y + to.y) / 2 - 8}
                    text-anchor="middle"
                    fill="#f59e0b"
                    font-size="10"
                    font-family="monospace"
                  >${edge.condition?.slice(0, 30)}${edge.condition?.length > 30 ? "…" : ""}</text>
                `}
                ${isSelected && html`
                  <text
                    x=${(from.x + to.x) / 2}
                    y=${(from.y + to.y) / 2 + 16}
                    text-anchor="middle"
                    fill="#ef4444"
                    font-size="11"
                    style="cursor: pointer;"
                    onClick=${(e) => { e.stopPropagation(); deleteEdge(edge.id); }}
                  >Remove</text>
                `}
              </g>
            `;
          })}

          <!-- Connecting line (while dragging) -->
          ${connecting && html`
            <line
              x1=${getOutputPort(connecting.sourceId).x}
              y1=${getOutputPort(connecting.sourceId).y}
              x2=${mousePos.x}
              y2=${mousePos.y}
              stroke="#3b82f680"
              stroke-width="2"
              stroke-dasharray="6,4"
            />
          `}

          <!-- Nodes -->
          ${nodes.map(node => {
            const meta = getNodeMeta(node.type);
            const isSelected = selectedNodeId.value === node.id;
            const x = node.position?.x || 0;
            const y = node.position?.y || 0;
            return html`
              <g
                key=${node.id}
                class="wf-node"
                transform="translate(${x} ${y})"
                onMouseDown=${(e) => onNodeMouseDown(node.id, e)}
                onDblClick=${() => onNodeDoubleClick(node.id)}
                onContextMenu=${(e) => onNodeContextMenu(node.id, e)}
                style="cursor: grab;"
                filter=${isSelected ? "url(#node-glow)" : "url(#node-shadow)"}
              >
                <!-- Node body -->
                <rect
                  width=${NODE_W}
                  height=${NODE_H}
                  rx="8"
                  fill=${isSelected ? "#1e293b" : "#1a1f2e"}
                  stroke=${isSelected ? meta.color : "#2a3040"}
                  stroke-width=${isSelected ? 2 : 1}
                />

                <!-- Category color strip -->
                <rect
                  width="4"
                  height=${NODE_H}
                  rx="2"
                  fill=${meta.color}
                />

                <!-- Label -->
                <text
                  x=${NODE_W / 2}
                  y=${NODE_H / 2 - 6}
                  text-anchor="middle"
                  fill="white"
                  font-size="13"
                  font-weight="600"
                >${stripEmoji(node.label || node.type).slice(0, 25)}</text>

                <!-- Type subtitle -->
                <text
                  x=${NODE_W / 2}
                  y=${NODE_H / 2 + 12}
                  text-anchor="middle"
                  fill="#94a3b8"
                  font-size="10"
                >${node.type}</text>

                <!-- Input port (left) -->
                <circle
                  cx="0"
                  cy=${NODE_H / 2}
                  r=${PORT_R}
                  fill="#1a1f2e"
                  stroke=${connecting ? "#10b981" : "#4a5568"}
                  stroke-width="2"
                  style="cursor: crosshair;"
                  onMouseUp=${() => onInputPortMouseUp(node.id)}
                />

                <!-- Output port (right) -->
                <circle
                  cx=${NODE_W}
                  cy=${NODE_H / 2}
                  r=${PORT_R}
                  fill="#1a1f2e"
                  stroke=${meta.color}
                  stroke-width="2"
                  style="cursor: crosshair;"
                  onMouseDown=${(e) => onOutputPortMouseDown(node.id, e)}
                />
              </g>
            `;
          })}
        </g>
      </svg>

      <!-- Context Menu -->
      ${contextMenu && html`
        <div class="wf-context-menu" style="position: fixed; left: ${contextMenu.x}px; top: ${contextMenu.y}px; z-index: 50;">
          <button onClick=${() => { setEditingNode(contextMenu.nodeId); setContextMenu(null); }}>
            <span class="btn-icon">${resolveIcon("settings")}</span>
            Edit Config
          </button>
          <button onClick=${() => { const n = nodes.find(n => n.id === contextMenu.nodeId); if (n) { const clone = { ...n, id: `node-${Date.now()}`, position: { x: n.position.x + 40, y: n.position.y + 40 } }; setNodes(p => [...p, clone]); } setContextMenu(null); }}>
            <span class="btn-icon">${resolveIcon("clipboard")}</span>
            Duplicate
          </button>
          <button onClick=${() => { deleteNode(contextMenu.nodeId); }} style="color: #ef4444;">
            <span class="btn-icon">${resolveIcon("trash")}</span>
            Delete
          </button>
        </div>
      `}

      <!-- Node Config Editor (side panel) -->
      ${editingNode && html`
        <${NodeConfigEditor}
          node=${nodes.find(n => n.id === editingNode)}
          nodeTypes=${nodeTypes.value}
          onUpdate=${(config) => updateNodeConfig(editingNode, config)}
          onUpdateLabel=${(label) => updateNodeLabel(editingNode, label)}
          onClose=${() => setEditingNode(null)}
          onDelete=${() => deleteNode(editingNode)}
        />
      `}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Node Palette — categorized node type picker
 * ═══════════════════════════════════════════════════════════════ */

function NodePalette({ nodeTypes: types, onSelect, onClose }) {
  const [search, setSearch] = useState("");
  const [expandedCat, setExpandedCat] = useState(null);

  const grouped = useMemo(() => {
    const groups = {};
    for (const nt of (types || [])) {
      const cat = nt.category || "other";
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(nt);
    }
    return groups;
  }, [types]);

  const filtered = useMemo(() => {
    if (!search.trim()) return grouped;
    const q = search.toLowerCase();
    const result = {};
    for (const [cat, items] of Object.entries(grouped)) {
      const matched = items.filter(nt =>
        nt.type.toLowerCase().includes(q) ||
        (nt.description || "").toLowerCase().includes(q)
      );
      if (matched.length) result[cat] = matched;
    }
    return result;
  }, [grouped, search]);

  return html`
    <div class="wf-palette" style="position: absolute; top: 52px; left: 12px; z-index: 30; width: 320px; max-height: 70vh; overflow-y: auto; background: var(--color-bg, #0d1117); border: 1px solid var(--color-border, #2a3040); border-radius: 12px; padding: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);">
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">
        <input
          type="text"
          placeholder="Search nodes..."
          value=${search}
          onInput=${(e) => setSearch(e.target.value)}
          style="flex: 1; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--color-border, #2a3040); background: var(--color-bg-secondary, #1a1f2e); color: white; font-size: 13px; outline: none;"
          autofocus
        />
        <button onClick=${onClose} class="wf-btn wf-btn-sm" style="font-size: 16px; line-height: 1;">${resolveIcon("✕")}</button>
      </div>

      ${Object.entries(filtered).map(([cat, items]) => {
        const meta = NODE_CATEGORY_META[cat] || { color: "#6b7280", icon: "diamond", label: cat };
        return html`
          <div key=${cat} style="margin-bottom: 8px;">
            <div
              style="display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 6px; cursor: pointer; color: ${meta.color}; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;"
              onClick=${() => setExpandedCat(expandedCat === cat ? null : cat)}
            >
              <span>${resolveIcon(meta.icon) || ICONS.dot}</span>
              <span>${meta.label}</span>
              <span style="margin-left: auto; font-size: 10px; opacity: 0.5;">${items.length}</span>
              <span style="font-size: 10px;">${expandedCat === cat ? ICONS.chevronDown : ICONS.arrowRight}</span>
            </div>
            ${(expandedCat === cat || search.trim()) && items.map(nt => html`
              <button
                key=${nt.type}
                onClick=${() => { onSelect(nt.type); haptic("light"); }}
                class="wf-palette-item"
                style="display: block; width: 100%; text-align: left; padding: 8px 12px 8px 28px; background: none; border: none; color: var(--color-text, white); font-size: 13px; cursor: pointer; border-radius: 6px; margin: 1px 0;"
              >
                <div style="font-weight: 500;">${nt.type.split(".").pop()?.replace(/_/g, " ")}</div>
                <div style="font-size: 11px; opacity: 0.6; margin-top: 2px;">${(nt.description || "").slice(0, 60)}</div>
              </button>
            `)}
          </div>
        `;
      })}

      ${Object.keys(filtered).length === 0 && html`
        <div style="text-align: center; padding: 20px; opacity: 0.5;">No matching nodes</div>
      `}
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Smart Presets — real bosun commands and agent prompts
 * ═══════════════════════════════════════════════════════════════ */

const COMMAND_PRESETS = {
  testing: [
    { label: "Run Tests", cmd: "npm test", icon: "beaker" },
    { label: "Run Single File", cmd: 'npx vitest run tests/{{testFile}}', icon: "target" },
    { label: "Syntax Check", cmd: "npm run syntax:check", icon: "check" },
  ],
  build: [
    { label: "Build Project", cmd: "npm run build", icon: "hammer" },
    { label: "Build Watch", cmd: "npm run build -- --watch", icon: "eye" },
    { label: "Type Check", cmd: "npx tsc --noEmit", icon: "ruler" },
  ],
  git: [
    { label: "Diff Stats", cmd: "git diff --stat main...HEAD", icon: "chart" },
    { label: "Git Status", cmd: "git status --porcelain", icon: "clipboard" },
    { label: "Stage All", cmd: "git add -A", icon: "download" },
    { label: "Commit", cmd: 'git commit -m "{{commitMessage}}"', icon: "save" },
    { label: "Push", cmd: "git push --set-upstream origin HEAD", icon: "rocket" },
  ],
  github: [
    { label: "Check CI", cmd: "gh pr checks --json name,state,conclusion", icon: "search" },
    { label: "Merge PR (squash)", cmd: "gh pr merge --auto --squash", icon: "git" },
    { label: "Close PR", cmd: 'gh pr close --comment "{{reason}}"', icon: "ban" },
    { label: "PR Diff", cmd: "gh pr diff --stat", icon: "chart" },
    { label: "Create PR", cmd: 'gh pr create --title "{{title}}" --body "{{body}}" --base main', icon: "edit" },
    { label: "Add Label", cmd: 'gh pr edit --add-label "{{label}}"', icon: "tag" },
    { label: "Request Review", cmd: 'gh pr edit --add-reviewer {{reviewer}}', icon: "eye" },
  ],
  bosun: [
    { label: "List Tasks", cmd: "bosun task list --status todo --json", icon: "clipboard" },
    { label: "Count Tasks", cmd: "bosun task list --status todo --count", icon: "hash" },
    { label: "Task Stats", cmd: "bosun task stats --json", icon: "chart" },
    { label: "Plan Tasks", cmd: "bosun task plan --count 5", icon: "compass" },
    { label: "Create Task", cmd: 'bosun task create --title "{{title}}" --status todo', icon: "plus" },
    { label: "Monitor Status", cmd: "bosun --daemon-status", icon: "heart" },
  ],
  session: [
    { label: "Continue Session", cmd: 'bosun agent continue --session "{{sessionId}}" --prompt "continue"', icon: "play" },
    { label: "Restart Agent", cmd: 'bosun agent restart --session "{{sessionId}}"', icon: "refresh" },
    { label: "Kill Agent", cmd: 'bosun agent kill --session "{{sessionId}}"', icon: "stop" },
    { label: "List Sessions", cmd: "bosun agent list --json", icon: "server" },
  ],
  screenshots: [
    { label: "Desktop Screenshot", cmd: "bosun screenshot --viewport 1280x720", icon: "monitor" },
    { label: "Mobile Screenshot", cmd: "bosun screenshot --viewport 375x812", icon: "phone" },
    { label: "All Viewports", cmd: "bosun screenshot --viewport desktop,mobile", icon: "camera" },
  ],
};

const AGENT_PROMPT_PRESETS = [
  { label: "Continue Working", icon: "play", prompt: "Continue working on the current task. Pick up where you left off. Review your previous output and continue.", category: "session" },
  { label: "Fix Errors", icon: "settings", prompt: "Fix the following errors. Do NOT introduce new issues:\n\n{{lastError}}\n\nTask: {{taskTitle}}\nFiles changed: {{changedFiles}}", category: "fix" },
  { label: "PR Review", icon: "search", prompt: "Review this PR for quality, bugs, security issues, test coverage, and documentation.\n\nProvide:\n1. Summary of changes\n2. Issues found (critical/warning/info)\n3. Verdict: APPROVE, REQUEST_CHANGES, or COMMENT", category: "review" },
  { label: "Merge Decision", icon: "git", prompt: "Analyze this PR and decide the merge strategy. Consider: CI status, diff size, code quality, test coverage.\n\nDecide exactly ONE action:\n- merge_after_ci_pass: Ready to merge\n- prompt: Agent needs to continue working (explain what)\n- close_pr: PR should be closed (explain why)\n- re_attempt: Task should be restarted from scratch\n- manual_review: Needs human review (explain why)\n- wait: CI still running, check back later\n- noop: No action needed", category: "strategy" },
  { label: "Frontend Implement", icon: "palette", prompt: "Implement the following frontend changes:\n\nTask: {{taskTitle}}\n{{taskDescription}}\n\nRequirements:\n- Must pass build (npm run build) with 0 warnings\n- Must pass lint (npm run lint)\n- Match the provided design specs\n- Add/update tests if applicable", category: "implement" },
  { label: "Plan Tasks", icon: "clipboard", prompt: "Analyze the codebase and create {{planCount}} actionable improvement tasks.\n\nFor each task provide:\n- title: Concise action-oriented title\n- description: What needs to change and why\n- priority: 1-5 (1=highest)\n- tags: Relevant labels\n- complexity: low, medium, or high\n\nFocus on: code quality, missing tests, documentation gaps, performance improvements, and technical debt.", category: "planning" },
  { label: "Analyze Failure", icon: "bug", prompt: "Analyze this agent failure and suggest a fix:\n\nError: {{lastError}}\nTask: {{taskTitle}}\nAttempt: {{retryCount}}/{{maxRetries}}\n\nProvide:\n1. Root cause analysis\n2. Concrete fix steps\n3. Should we retry or escalate?", category: "fix" },
  { label: "Error Recovery", icon: "shield", prompt: "The previous agent attempt failed. Here's what happened:\n\n{{lastError}}\n\nOriginal task: {{taskTitle}}\n\nApproach this differently:\n1. Identify what went wrong\n2. Try an alternative approach\n3. Ensure tests pass before committing", category: "fix" },
  { label: "Code Analysis", icon: "chart", prompt: "Analyze the codebase for:\n\n1. Code complexity hotspots\n2. Test coverage gaps\n3. Security vulnerabilities\n4. Performance bottlenecks\n5. Documentation completeness\n\nOutput a structured JSON report.", category: "review" },
  { label: "Refactor", icon: "repeat", prompt: "Refactor {{targetFile}} to:\n\n1. Reduce complexity\n2. Extract reusable functions\n3. Improve naming conventions\n4. Add JSDoc comments\n5. Ensure all existing tests still pass\n\nDo NOT change external behavior.", category: "implement" },
];

const TRIGGER_EVENT_PRESETS = [
  { label: "Task Failed", value: "task.failed", icon: "close" },
  { label: "Task Completed", value: "task.completed", icon: "check" },
  { label: "Task Assigned", value: "task.assigned", icon: "user" },
  { label: "PR Merged", value: "pr.merged", icon: "git" },
  { label: "PR Opened", value: "pr.opened", icon: "mail" },
  { label: "Agent Started", value: "agent.started", icon: "bot" },
  { label: "Agent Crashed", value: "agent.crashed", icon: "zap" },
  { label: "Rate Limited", value: "rate.limited", icon: "alert" },
  { label: "Build Failed", value: "build.failed", icon: "hammer" },
  { label: "Deploy Completed", value: "deploy.completed", icon: "rocket" },
  { label: "Session Ended", value: "session.ended", icon: "plug" },
];

const CRON_PRESETS = [
  { label: "Every 5 min", value: "*/5 * * * *" },
  { label: "Every 15 min", value: "*/15 * * * *" },
  { label: "Every 30 min", value: "*/30 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Weekdays 9am", value: "0 9 * * 1-5" },
];

const EXPRESSION_PRESETS = [
  { label: "CI Passed", expr: "$ctx.getNodeOutput('check-ci')?.passed === true" },
  { label: "Previous Succeeded", expr: "$output?.success === true" },
  { label: "Retries Left", expr: "($data?.retryCount || 0) < ($data?.maxRetries || 3)" },
  { label: "Has Errors", expr: "$data?.errorCount > 0" },
  { label: "Is Draft PR", expr: "$data?.pr?.draft === true" },
  { label: "Large Diff", expr: "($data?.additions + $data?.deletions) > 500" },
  { label: "Task Tagged", expr: "($data?.tags || []).includes('{{tag}}')" },
  { label: "Branch Match", expr: "/^(feat|fix)\\//.test($data?.branch || '')" },
];

/* ═══════════════════════════════════════════════════════════════
 *  Node Config Editor (right side panel)
 * ═══════════════════════════════════════════════════════════════ */

function NodeConfigEditor({ node, nodeTypes: types, onUpdate, onUpdateLabel, onClose, onDelete }) {
  if (!node) return null;

  const meta = getNodeMeta(node.type);
  const typeInfo = (types || []).find(nt => nt.type === node.type);
  const schema = typeInfo?.schema?.properties || {};
  const config = node.config || {};
  const [presetExpanded, setPresetExpanded] = useState(true);

  const onFieldChange = useCallback((key, value) => {
    onUpdate({ [key]: value });
  }, [onUpdate]);

  const applyPreset = useCallback((overrides) => {
    onUpdate(overrides);
    haptic?.("light");
  }, [onUpdate]);

  // Determine which smart section to render
  const nodeCategory = node.type.split(".")[0];
  const nodeAction = node.type.split(".")[1] || "";

  return html`
    <div class="wf-config-panel" style="position: absolute; top: 0; right: 0; width: 380px; height: 100%; background: var(--color-bg, #0d1117); border-left: 1px solid var(--color-border, #2a3040); z-index: 25; overflow-y: auto; padding: 16px;">

      <!-- Header -->
      <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
        <span style="font-size: 20px;">${resolveIcon(meta.icon) || meta.icon}</span>
        <div style="flex: 1;">
          <input
            type="text"
            value=${node.label || ""}
            onInput=${(e) => onUpdateLabel(e.target.value)}
            style="width: 100%; background: transparent; border: none; color: white; font-size: 15px; font-weight: 600; outline: none; padding: 2px 0;"
          />
          <div style="font-size: 11px; color: ${meta.color}; font-family: monospace;">${node.type}</div>
        </div>
        <button onClick=${onClose} class="wf-btn wf-btn-sm">${resolveIcon("✕")}</button>
      </div>

      <!-- Description -->
      ${typeInfo?.description && html`
        <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5); margin-bottom: 12px; padding: 8px; background: var(--color-bg-secondary, #1a1f2e); border-radius: 8px;">
          ${typeInfo.description}
        </div>
      `}

      <!-- ═══ Smart Presets: action.run_command ═══ -->
      ${node.type === "action.run_command" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div
            style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 8px; opacity: 0.9;"
            onClick=${() => setPresetExpanded(!presetExpanded)}
          >
            <span style="font-size: 11px; color: #f59e0b;">${resolveIcon("zap")}</span>
            <span style="font-size: 12px; font-weight: 600; color: #f59e0b;">Quick Commands</span>
            <span style="font-size: 10px; margin-left: auto; color: #6b7280;">${presetExpanded ? ICONS.chevronDown : ICONS.arrowRight}</span>
          </div>
          ${presetExpanded && Object.entries(COMMAND_PRESETS).map(([group, items]) => html`
            <div key=${group} style="margin-bottom: 6px;">
              <div style="font-size: 10px; color: #6b7280; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 3px; padding-left: 4px;">${group}</div>
              <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                ${items.map(p => html`
                  <button
                    key=${p.label}
                    onClick=${() => applyPreset({ command: p.cmd })}
                    class="wf-preset-btn"
                    title=${p.cmd}
                    style="padding: 3px 8px; font-size: 11px; border: 1px solid #2a3040; border-radius: 6px; background: ${config.command === p.cmd ? '#1e3a5f' : '#1a1f2e'}; color: ${config.command === p.cmd ? '#60a5fa' : '#c9d1d9'}; cursor: pointer; white-space: nowrap; transition: all 0.1s;"
                  >
                    <span class="btn-icon">${resolveIcon(p.icon)}</span>
                    ${p.label}
                  </button>
                `)}
              </div>
            </div>
          `)}
        </div>
      `}

      <!-- ═══ Smart Presets: action.run_agent / agent.* ═══ -->
      ${(node.type === "action.run_agent" || nodeCategory === "agent") && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div
            style="display: flex; align-items: center; gap: 6px; cursor: pointer; margin-bottom: 8px;"
            onClick=${() => setPresetExpanded(!presetExpanded)}
          >
            <span style="font-size: 11px; color: #a78bfa;">${resolveIcon("bot")}</span>
            <span style="font-size: 12px; font-weight: 600; color: #a78bfa;">Agent Prompt Templates</span>
            <span style="font-size: 10px; margin-left: auto; color: #6b7280;">${presetExpanded ? ICONS.chevronDown : ICONS.arrowRight}</span>
          </div>
          ${presetExpanded && html`
            <div style="display: flex; flex-direction: column; gap: 3px; max-height: 200px; overflow-y: auto; padding-right: 4px;">
              ${AGENT_PROMPT_PRESETS.map(p => html`
                <button
                  key=${p.label}
                  onClick=${() => applyPreset({ prompt: p.prompt })}
                  class="wf-preset-btn"
                  style="padding: 6px 10px; font-size: 11px; border: 1px solid #2a3040; border-radius: 6px; background: #1a1f2e; color: #c9d1d9; cursor: pointer; text-align: left; transition: all 0.1s; line-height: 1.3;"
                >
                  <div style="font-weight: 500; display: flex; align-items: center; gap: 6px;">
                    <span class="btn-icon">${resolveIcon(p.icon)}</span>
                    <span>${p.label}</span>
                  </div>
                  <div style="font-size: 10px; color: #6b7280; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${p.prompt.split("\n")[0].slice(0, 60)}…</div>
                </button>
              `)}
            </div>
          `}
          ${(node.type === "action.run_agent") && html`
            <div style="margin-top: 8px; padding: 6px 8px; background: #1a1f2e; border-radius: 6px; border-left: 3px solid #a78bfa;">
              <div style="font-size: 10px; color: #a78bfa; font-weight: 600; margin-bottom: 2px; display: flex; align-items: center; gap: 6px;">
                <span class="btn-icon">${resolveIcon("lightbulb")}</span>
                Agent Variables
              </div>
              <div style="font-size: 10px; color: #6b7280; font-family: monospace; line-height: 1.6;">
                ${"{{taskTitle}}"} · ${"{{taskDescription}}"} · ${"{{lastError}}"}<br/>
                ${"{{branch}}"} · ${"{{changedFiles}}"} · ${"{{retryCount}}"}<br/>
                ${"{{sessionId}}"} · ${"{{maxRetries}}"} · ${"{{planCount}}"}
              </div>
            </div>
          `}
        </div>
      `}

      <!-- ═══ Smart Presets: trigger.event ═══ -->
      ${node.type === "trigger.event" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #34d399; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("zap")}</span>
            Event Types
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            ${TRIGGER_EVENT_PRESETS.map(p => html`
              <button
                key=${p.value}
                onClick=${() => applyPreset({ eventType: p.value })}
                style="padding: 3px 8px; font-size: 11px; border: 1px solid #2a3040; border-radius: 6px; background: ${config.eventType === p.value ? '#0d3320' : '#1a1f2e'}; color: ${config.eventType === p.value ? '#34d399' : '#c9d1d9'}; cursor: pointer; white-space: nowrap;"
              >
                <span class="btn-icon">${resolveIcon(p.icon)}</span>
                ${p.label}
              </button>
            `)}
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: trigger.cron / trigger.schedule ═══ -->
      ${(node.type === "trigger.cron" || node.type === "trigger.schedule") && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #34d399; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("clock")}</span>
            Schedule Presets
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            ${CRON_PRESETS.map(p => html`
              <button
                key=${p.value}
                onClick=${() => applyPreset({ cron: p.value })}
                style="padding: 3px 8px; font-size: 11px; border: 1px solid #2a3040; border-radius: 6px; background: ${config.cron === p.value ? '#0d3320' : '#1a1f2e'}; color: ${config.cron === p.value ? '#34d399' : '#c9d1d9'}; cursor: pointer; white-space: nowrap;"
              >
                ${p.label}
              </button>
            `)}
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: trigger.pr_event ═══ -->
      ${node.type === "trigger.pr_event" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #34d399; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("git")}</span>
            PR Events
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            ${["opened", "merged", "review_requested", "changes_requested", "approved", "closed"].map(ev => html`
              <button
                key=${ev}
                onClick=${() => applyPreset({ event: ev })}
                style="padding: 3px 8px; font-size: 11px; border: 1px solid #2a3040; border-radius: 6px; background: ${config.event === ev ? '#0d3320' : '#1a1f2e'}; color: ${config.event === ev ? '#34d399' : '#c9d1d9'}; cursor: pointer; white-space: nowrap;"
              >
                ${ev.replace(/_/g, " ")}
              </button>
            `)}
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: condition.expression ═══ -->
      ${node.type === "condition.expression" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #f472b6; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("terminal")}</span>
            Expression Presets
          </div>
          <div style="display: flex; flex-direction: column; gap: 3px;">
            ${EXPRESSION_PRESETS.map(p => html`
              <button
                key=${p.label}
                onClick=${() => applyPreset({ expression: p.expr })}
                style="padding: 4px 8px; font-size: 11px; border: 1px solid #2a3040; border-radius: 6px; background: #1a1f2e; color: #c9d1d9; cursor: pointer; text-align: left;"
              >
                <span style="font-weight: 500;">${p.label}</span>
                <span style="font-size: 10px; color: #6b7280; margin-left: 6px; font-family: monospace;">${p.expr.slice(0, 45)}${p.expr.length > 45 ? "…" : ""}</span>
              </button>
            `)}
          </div>
          <div style="margin-top: 6px; padding: 6px 8px; background: #1a1f2e; border-radius: 6px; border-left: 3px solid #f472b6;">
            <div style="font-size: 10px; color: #f472b6; font-weight: 600;">Context Variables</div>
            <div style="font-size: 10px; color: #6b7280; font-family: monospace; line-height: 1.6;">
              <b>$data</b> — workflow input data<br/>
              <b>$ctx</b> — execution context<br/>
              <b>$output</b> — all node outputs map<br/>
              <b>$ctx.getNodeOutput('id')</b> — specific node result
            </div>
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: condition.switch ═══ -->
      ${node.type === "condition.switch" && html`
        <div style="margin-bottom: 14px; padding: 6px 8px; background: #1a1f2e; border-radius: 6px; border-left: 3px solid #f472b6;">
          <div style="font-size: 10px; color: #f472b6; font-weight: 600;">Switch Node</div>
          <div style="font-size: 10px; color: #6b7280; line-height: 1.5;">
            Routes workflow to different edges based on the value of a field.<br/>
            Connect edges with <b>conditions</b> matching case names.
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: notify.telegram ═══ -->
      ${node.type === "notify.telegram" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #38bdf8; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("mail")}</span>
            Message Templates
          </div>
          <div style="display: flex; flex-direction: column; gap: 3px;">
            ${[
              { label: "Task Done", icon: "check", msg: "Task completed: {{taskTitle}}" },
              { label: "Task Failed", icon: "alert", msg: "Task {{taskTitle}} failed after {{retryCount}} attempts. Manual intervention needed." },
              { label: "PR Merged", icon: "git", msg: "PR merged: {{prTitle}} → {{baseBranch}}" },
              { label: "Review Done", icon: "edit", msg: "PR review complete for {{branch}}: {{verdict}}" },
              { label: "Tasks Planned", icon: "clipboard", msg: "Task planner added {{newTaskCount}} tasks to backlog" },
              { label: "Deployed", icon: "rocket", msg: "Deployment to production completed for {{branch}}" },
              { label: "Needs Review", icon: "eye", msg: "PR needs manual review: {{reason}}" },
              { label: "Rate Limited", icon: "alert", msg: "Agent rate limited. Cooling down for {{cooldownSec}}s. Provider: {{provider}}" },
            ].map(p => html`
              <button
                key=${p.label}
                onClick=${() => applyPreset({ message: p.msg })}
                style="padding: 4px 8px; font-size: 11px; border: 1px solid #2a3040; border-radius: 6px; background: #1a1f2e; color: #c9d1d9; cursor: pointer; text-align: left;"
              >
                <span style="display: inline-flex; align-items: center; gap: 6px;">
                  <span class="btn-icon">${resolveIcon(p.icon)}</span>
                  <span>${p.label}</span>
                </span>
              </button>
            `)}
          </div>
        </div>
      `}

      <!-- ═══ Smart Presets: notify.log ═══ -->
      ${node.type === "notify.log" && html`
        <div style="margin-bottom: 14px; display: flex; flex-wrap: wrap; gap: 4px;">
          ${["info", "warn", "error", "debug"].map(lv => html`
            <button
              key=${lv}
              onClick=${() => applyPreset({ level: lv })}
              style="padding: 3px 10px; font-size: 11px; border: 1px solid #2a3040; border-radius: 6px; background: ${config.level === lv ? '#1e293b' : '#1a1f2e'}; color: ${lv === 'error' ? '#ef4444' : lv === 'warn' ? '#f59e0b' : lv === 'debug' ? '#6b7280' : '#60a5fa'}; cursor: pointer;"
            >
              ${lv.toUpperCase()}
            </button>
          `)}
        </div>
      `}

      <!-- ═══ Smart Presets: validation nodes ═══ -->
      ${nodeCategory === "validation" && html`
        <div class="wf-preset-section" style="margin-bottom: 14px;">
          <div style="font-size: 12px; font-weight: 600; color: #34d399; margin-bottom: 6px; display: flex; align-items: center; gap: 6px;">
            <span class="btn-icon">${resolveIcon("check")}</span>
            Validation Commands
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            ${[
              ...(nodeAction === "build" ? [
                { label: "npm run build", cmd: "npm run build" },
                { label: "Zero Warnings", cmd: "npm run build", extra: { zeroWarnings: true } },
              ] : []),
              ...(nodeAction === "tests" ? [
                { label: "npm test", cmd: "npm test" },
                { label: "Vitest", cmd: "npx vitest run" },
                { label: "Jest", cmd: "npx jest" },
              ] : []),
              ...(nodeAction === "lint" ? [
                { label: "npm run lint", cmd: "npm run lint" },
                { label: "ESLint", cmd: "npx eslint ." },
              ] : []),
            ].map(p => html`
              <button
                key=${p.label}
                onClick=${() => applyPreset({ command: p.cmd, ...(p.extra || {}) })}
                style="padding: 3px 8px; font-size: 11px; border: 1px solid #2a3040; border-radius: 6px; background: ${config.command === p.cmd ? '#0d3320' : '#1a1f2e'}; color: ${config.command === p.cmd ? '#34d399' : '#c9d1d9'}; cursor: pointer;"
              >
                ${p.label}
              </button>
            `)}
          </div>
        </div>
      `}

      <!-- ═══ Config Fields (schema-driven) ═══ -->
      <div style="display: flex; flex-direction: column; gap: 12px;">
        ${Object.entries(schema).map(([key, fieldSchema]) => {
          const value = config[key] ?? fieldSchema.default ?? "";
          const fieldType = fieldSchema.type || "string";
          const isRequired = typeInfo?.schema?.required?.includes(key);

          return html`
            <div key=${key} class="wf-config-field">
              <label style="display: block; font-size: 12px; font-weight: 600; color: var(--color-text-secondary, #8b95a5); margin-bottom: 4px;">
                ${key.replace(/([A-Z])/g, " $1").replace(/_/g, " ").trim()}
                ${isRequired && html`<span style="color: #ef4444;">*</span>`}
              </label>
              ${fieldSchema.description && html`
                <div style="font-size: 10px; color: var(--color-text-secondary, #6b7280); margin-bottom: 4px;">${fieldSchema.description}</div>
              `}

              ${fieldType === "boolean" ? html`
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
                  <input
                    type="checkbox"
                    checked=${!!value}
                    onChange=${(e) => onFieldChange(key, e.target.checked)}
                    style="width: 16px; height: 16px;"
                  />
                  <span style="font-size: 13px; color: white;">${value ? "Enabled" : "Disabled"}</span>
                </label>
              ` : fieldType === "number" ? html`
                <input
                  type="number"
                  value=${value}
                  onInput=${(e) => onFieldChange(key, Number(e.target.value))}
                  class="wf-input"
                  placeholder=${fieldSchema.default != null ? `Default: ${fieldSchema.default}` : ""}
                />
              ` : fieldSchema.enum ? html`
                <select
                  value=${value}
                  onChange=${(e) => onFieldChange(key, e.target.value)}
                  class="wf-input"
                >
                  <option value="">— select —</option>
                  ${fieldSchema.enum.map(opt => html`<option key=${opt} value=${opt}>${opt}</option>`)}
                </select>
              ` : (typeof value === "string" && value.length > 80) || key === "prompt" || key === "expression" || key === "template" || key === "command" || key === "body" || key === "message" || key === "filter" ? html`
                <textarea
                  value=${typeof value === "object" ? JSON.stringify(value, null, 2) : value}
                  onInput=${(e) => onFieldChange(key, e.target.value)}
                  class="wf-input wf-textarea"
                  rows=${key === "prompt" ? "6" : "4"}
                  placeholder=${fieldSchema.default != null ? String(fieldSchema.default) : ""}
                />
              ` : html`
                <input
                  type="text"
                  value=${typeof value === "object" ? JSON.stringify(value) : value}
                  onInput=${(e) => onFieldChange(key, e.target.value)}
                  class="wf-input"
                  placeholder=${fieldSchema.default != null ? String(fieldSchema.default) : ""}
                />
              `}
            </div>
          `;
        })}
      </div>

      <!-- No schema fields hint -->
      ${Object.keys(schema).length === 0 && html`
        <div style="padding: 12px; background: var(--color-bg-secondary, #1a1f2e); border-radius: 8px; text-align: center; margin-bottom: 12px;">
          <div style="font-size: 12px; color: #6b7280;">This node has no configurable fields.</div>
          <div style="font-size: 10px; color: #4b5563; margin-top: 4px;">It executes with defaults or inherits from workflow context.</div>
        </div>
      `}

      <!-- Continue on Error toggle -->
      <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--color-border, #2a3040);">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
          <input
            type="checkbox"
            checked=${!!config.continueOnError}
            onChange=${(e) => onUpdate({ continueOnError: e.target.checked })}
            style="width: 16px; height: 16px;"
          />
          <span style="font-size: 13px; color: white;">Continue on Error</span>
        </label>
        <div style="font-size: 10px; color: var(--color-text-secondary, #6b7280); margin-top: 4px;">
          If checked, workflow continues even if this node fails
        </div>
      </div>

      <!-- Timeout -->
      <div style="margin-top: 12px;">
        <label style="font-size: 12px; font-weight: 600; color: var(--color-text-secondary, #8b95a5);">Timeout (ms)</label>
        <input
          type="number"
          value=${config.timeout || ""}
          onInput=${(e) => onUpdate({ timeout: Number(e.target.value) || undefined })}
          placeholder="Default: 600000"
          class="wf-input"
        />
      </div>

      <!-- Delete button -->
      <button
        onClick=${() => { if (confirm("Delete this node?")) onDelete(); }}
        class="wf-btn"
        style="width: 100%; margin-top: 20px; background: #dc262620; color: #ef4444; border-color: #ef444440;"
      >
        <span class="btn-icon">${resolveIcon("trash")}</span>
        Delete Node
      </button>

      <!-- Raw JSON -->
      <details style="margin-top: 16px;">
        <summary style="cursor: pointer; font-size: 12px; color: var(--color-text-secondary, #6b7280);">Raw JSON</summary>
        <pre style="font-size: 10px; color: #8b95a5; background: #1a1f2e; padding: 8px; border-radius: 6px; overflow-x: auto; margin-top: 6px; white-space: pre-wrap; word-break: break-all;">${JSON.stringify(node, null, 2)}</pre>
      </details>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Workflow List View
 * ═══════════════════════════════════════════════════════════════ */

function WorkflowListView() {
  const wfs = workflows.value || [];
  const tmpls = templates.value || [];

  return html`
    <div style="padding: 0 4px;">

      <!-- Header -->
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;">
        <h2 style="margin: 0; font-size: 18px; font-weight: 700;">Workflows</h2>
        <button
          class="wf-btn wf-btn-primary"
          onClick=${() => {
            const newWf = {
              name: "New Workflow",
              description: "",
              category: "custom",
              enabled: true,
              nodes: [],
              edges: [],
              variables: {},
            };
            saveWorkflow(newWf).then(wf => {
              if (wf) {
                activeWorkflow.value = wf;
                viewMode.value = "canvas";
              }
            });
          }}
        >
          <span class="btn-icon">${resolveIcon("plus")}</span>
          Create Workflow
        </button>
        <button class="wf-btn" onClick=${() => { viewMode.value = "runs"; loadRuns(); }}>
          <span class="btn-icon">${resolveIcon("chart")}</span>
          Run History
        </button>
      </div>

      <!-- Active Workflows -->
      ${wfs.length > 0 && html`
        <div style="margin-bottom: 24px;">
          <h3 style="font-size: 14px; font-weight: 600; color: var(--color-text-secondary, #8b95a5); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px;">
            Your Workflows (${wfs.length})
          </h3>
          <div style="display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));">
            ${wfs.map(wf => html`
              <div key=${wf.id} class="wf-card" style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 12px; padding: 14px; border: 1px solid var(--color-border, #2a3040); cursor: pointer; transition: border-color 0.15s;"
                   onClick=${() => {
                     apiFetch("/api/workflows/" + wf.id).then(d => {
                       activeWorkflow.value = d?.workflow || wf;
                       viewMode.value = "canvas";
                     }).catch(() => { activeWorkflow.value = wf; viewMode.value = "canvas"; });
                   }}>
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                  <span style="font-size: 14px;">${resolveIcon(getNodeMeta(wf.trigger || "action")?.icon) || ICONS.dot}</span>
                  <span style="font-weight: 600; font-size: 14px; flex: 1;">${wf.name}</span>
                  <span class="wf-badge" style="background: ${wf.enabled ? '#10b98130' : '#6b728030'}; color: ${wf.enabled ? '#10b981' : '#6b7280'}; font-size: 10px;">
                    ${wf.enabled ? "Active" : "Disabled"}
                  </span>
                </div>
                ${wf.description && html`
                  <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5); margin-bottom: 8px; line-height: 1.4;">
                    ${wf.description.slice(0, 120)}${wf.description.length > 120 ? "…" : ""}
                  </div>
                `}
                <div style="display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--color-text-secondary, #6b7280);">
                  <span>${wf.nodeCount || 0} nodes</span>
                  <span>·</span>
                  <span>${wf.category || "custom"}</span>
                  <div style="flex: 1;"></div>
                  <button class="wf-btn wf-btn-sm" style="font-size: 11px;" onClick=${(e) => { e.stopPropagation(); executeWorkflow(wf.id); }}>
                    ${resolveIcon("play")}
                  </button>
                  <button class="wf-btn wf-btn-sm wf-btn-danger" style="font-size: 11px;" onClick=${(e) => { e.stopPropagation(); if (confirm("Delete " + wf.name + "?")) deleteWorkflow(wf.id); }}>
                    ${resolveIcon("trash")}
                  </button>
                </div>
              </div>
            `)}
          </div>
        </div>
      `}

      ${wfs.length === 0 && html`
        <div style="text-align: center; padding: 40px 20px; background: var(--color-bg-secondary, #1a1f2e); border-radius: 12px; margin-bottom: 24px; border: 1px solid var(--color-border, #2a3040);">
          <div style="font-size: 36px; margin-bottom: 12px;">${resolveIcon("refresh")}</div>
          <div style="font-size: 16px; font-weight: 600; margin-bottom: 8px;">No Workflows Yet</div>
          <div style="font-size: 13px; color: var(--color-text-secondary, #8b95a5); margin-bottom: 16px; max-width: 400px; margin-left: auto; margin-right: auto; line-height: 1.5;">
            Workflows automate your development pipeline — from PR merging
            to error recovery. Install a template below or create one from scratch.
          </div>
          <div style="display: flex; gap: 8px; justify-content: center; flex-wrap: wrap;">
            <button class="wf-btn wf-btn-primary" onClick=${() => {
              const newWf = { name: "New Workflow", description: "", category: "custom", enabled: true, nodes: [], edges: [], variables: {} };
              saveWorkflow(newWf).then(wf => { if (wf) { activeWorkflow.value = wf; viewMode.value = "canvas"; } });
            }}>+ Create Blank</button>
            ${tmpls.length > 0 && html`
              <button class="wf-btn" style="border-color: #f59e0b60; color: #f59e0b;" onClick=${() => installTemplate(tmpls[0]?.id)}>
                <span class="btn-icon">${resolveIcon("zap")}</span>
                Quick Install: ${tmpls[0]?.name}
              </button>
            `}
          </div>
        </div>
      `}

      <!-- Templates (grouped by category) -->
      <div>
        <h3 style="font-size: 14px; font-weight: 600; color: var(--color-text-secondary, #8b95a5); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.5px;">
          Templates (${tmpls.length})
        </h3>
        ${(() => {
          // Group templates by category
          const groups = {};
          tmpls.forEach(t => {
            const key = t.category || "custom";
            if (!groups[key]) groups[key] = { label: t.categoryLabel || key, icon: t.categoryIcon || "settings", order: t.categoryOrder || 99, items: [] };
            groups[key].items.push(t);
          });
          const sorted = Object.entries(groups).sort((a, b) => a[1].order - b[1].order);
          return sorted.map(([cat, group]) => html`
            <div key=${cat} style="margin-bottom: 20px;">
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px; padding-bottom: 6px; border-bottom: 1px solid var(--color-border, #2a304060);">
                <span style="font-size: 16px;">${resolveIcon(group.icon) || ICONS.dot}</span>
                <span style="font-size: 13px; font-weight: 600; color: var(--color-text-secondary, #8b95a5);">${group.label}</span>
                <span style="font-size: 11px; color: var(--color-text-secondary, #6b7280);">(${group.items.length})</span>
              </div>
              <div style="display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));">
                ${group.items.map(t => html`
                  <div key=${t.id} class="wf-card wf-template-card" style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 12px; padding: 14px; border: 1px solid var(--color-border, #2a304080);">
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
                      <span style="font-size: 14px;">${resolveIcon(t.categoryIcon || group.icon) || ICONS.dot}</span>
                      <span style="font-weight: 600; font-size: 14px; flex: 1;">${t.name}</span>
                      ${t.recommended && html`
                        <span class="wf-badge" style="background: #10b98125; color: #10b981; border-color: #10b98140; font-size: 10px; padding: 2px 8px; font-weight: 600; letter-spacing: 0.3px; display: inline-flex; align-items: center; gap: 4px;">
                          ${resolveIcon("star")}
                          Recommended
                        </span>
                      `}
                    </div>
                    <div style="font-size: 12px; color: var(--color-text-secondary, #8b95a5); margin-bottom: 10px; line-height: 1.4;">
                      ${t.description?.slice(0, 120)}${(t.description?.length || 0) > 120 ? "…" : ""}
                    </div>
                    <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px;">
                      ${(t.tags || []).map(tag => html`
                        <span key=${tag} class="wf-badge" style="font-size: 10px; padding: 2px 6px;">${tag}</span>
                      `)}
                    </div>
                    <div style="display: flex; gap: 8px; align-items: center;">
                      <span style="font-size: 11px; color: var(--color-text-secondary, #6b7280);">${t.nodeCount} nodes</span>
                      <div style="flex: 1;"></div>
                      <button
                        class="wf-btn wf-btn-primary wf-btn-sm"
                        onClick=${() => installTemplate(t.id)}
                      >
                        Install →
                      </button>
                    </div>
                  </div>
                `)}
              </div>
            </div>
          `);
        })()}
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Run History View
 * ═══════════════════════════════════════════════════════════════ */

function RunHistoryView() {
  const runs = workflowRuns.value || [];
  return html`
    <div style="padding: 0 4px;">
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
        <button class="wf-btn wf-btn-sm" onClick=${() => viewMode.value = "list"}>← Back</button>
        <h2 style="margin: 0; font-size: 18px; font-weight: 700;">Run History</h2>
        <button class="wf-btn wf-btn-sm" onClick=${() => loadRuns()}>Refresh</button>
      </div>

      ${runs.length === 0 && html`
        <div style="text-align: center; padding: 40px; opacity: 0.5;">No workflow runs yet</div>
      `}

      <div style="display: flex; flex-direction: column; gap: 8px;">
        ${runs.map(run => html`
          <div key=${run.runId} style="background: var(--color-bg-secondary, #1a1f2e); border-radius: 8px; padding: 12px; border: 1px solid var(--color-border, #2a3040); display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 16px;">
              ${run.status === "completed" ? resolveIcon("check") : run.status === "failed" ? resolveIcon("close") : resolveIcon("clock")}
            </span>
            <div style="flex: 1;">
              <div style="font-weight: 500; font-size: 13px;">${run.workflowId}</div>
              <div style="font-size: 11px; color: var(--color-text-secondary, #6b7280);">
                ${run.nodeCount || 0} nodes · ${run.duration ? Math.round(run.duration / 1000) + "s" : "—"}
                ${run.errorCount ? ` · ${run.errorCount} errors` : ""}
              </div>
            </div>
            <span class="wf-badge" style="background: ${run.status === "completed" ? "#10b98130" : "#ef444430"}; color: ${run.status === "completed" ? "#10b981" : "#ef4444"};">
              ${run.status}
            </span>
          </div>
        `)}
      </div>
    </div>
  `;
}

/* ═══════════════════════════════════════════════════════════════
 *  Main Tab Export
 * ═══════════════════════════════════════════════════════════════ */

export function WorkflowsTab() {
  useEffect(() => {
    loadWorkflows();
    loadTemplates();
    loadNodeTypes();
  }, []);

  const mode = viewMode.value;

  return html`
    <style>
      .wf-btn {
        padding: 6px 14px;
        border: 1px solid var(--color-border, #2a3040);
        border-radius: 8px;
        background: var(--color-bg-secondary, #1a1f2e);
        color: var(--color-text, white);
        font-size: 13px;
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
        white-space: nowrap;
      }
      .wf-btn:hover { border-color: #3b82f6; background: #1e293b; }
      .wf-btn-primary { background: #3b82f6; border-color: #3b82f6; color: white; }
      .wf-btn-primary:hover { background: #2563eb; }
      .wf-btn-danger:hover { border-color: #ef4444; background: #dc262620; }
      .wf-btn-sm { padding: 3px 8px; font-size: 11px; border-radius: 6px; }
      .wf-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 10px;
        font-size: 11px;
        font-weight: 500;
        background: var(--color-bg-secondary, #1a1f2e);
        color: var(--color-text-secondary, #8b95a5);
        border: 1px solid var(--color-border, #2a3040);
      }
      .wf-input {
        width: 100%;
        padding: 6px 10px;
        border: 1px solid var(--color-border, #2a3040);
        border-radius: 6px;
        background: var(--color-bg-secondary, #1a1f2e);
        color: white;
        font-size: 13px;
        font-family: inherit;
        outline: none;
        transition: border-color 0.15s;
      }
      .wf-input:focus { border-color: #3b82f6; }
      .wf-textarea { font-family: monospace; font-size: 12px; resize: vertical; min-height: 60px; }
      .wf-card { transition: border-color 0.15s, transform 0.1s; }
      .wf-card:hover { border-color: #3b82f680 !important; }
      .wf-template-card:hover { border-color: #f59e0b80 !important; }
      .wf-palette-item:hover { background: var(--color-bg-secondary, #1a1f2e) !important; }
      .wf-context-menu {
        background: var(--color-bg, #0d1117);
        border: 1px solid var(--color-border, #2a3040);
        border-radius: 8px;
        overflow: hidden;
        box-shadow: 0 4px 16px rgba(0,0,0,0.5);
      }
      .wf-context-menu button {
        display: block;
        width: 100%;
        padding: 8px 14px;
        border: none;
        background: none;
        color: var(--color-text, white);
        font-size: 13px;
        text-align: left;
        cursor: pointer;
        font-family: inherit;
      }
      .wf-context-menu button:hover { background: var(--color-bg-secondary, #1a1f2e); }
      .wf-preset-btn:hover { border-color: #3b82f6 !important; background: #1e293b !important; }
      .wf-preset-section { animation: wf-fade-in 0.15s ease; }
      @keyframes wf-fade-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
      .wf-canvas-container { height: calc(100vh - 140px); min-height: 500px; }
      @media (min-width: 1200px) { .wf-canvas-container { height: calc(100vh - 120px); min-height: 700px; } }
    </style>

    <div style="padding: 8px;">
      ${mode === "canvas" && activeWorkflow.value
        ? html`<${WorkflowCanvas} workflow=${activeWorkflow.value} />`
        : mode === "runs"
        ? html`<${RunHistoryView} />`
        : html`<${WorkflowListView} />`
      }
    </div>
  `;
}
