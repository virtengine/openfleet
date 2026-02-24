/**
 * _helpers.mjs — Shared helpers for workflow template definitions.
 *
 * These utilities generate positioned nodes and edges in a consistent format.
 * All template module files import from here.
 */

// ── Layout state ────────────────────────────────────────────────────────────

let _nextX = 100;
let _nextY = 100;

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
  return {
    id: `${source}->${target}`,
    source,
    target,
    sourcePort: opts.port || "default",
    condition: opts.condition || undefined,
  };
}

/**
 * Reset the auto-layout position counters.
 * Call this before defining each new template.
 */
export function resetLayout() {
  _nextX = 100;
  _nextY = 100;
}
