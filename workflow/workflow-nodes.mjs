import {
  getNodeType,
  getNodeTypeMeta,
  listNodeTypes,
  registerNodeType as registerRuntimeNodeType,
  unregisterNodeType,
} from "./workflow-engine.mjs";
import { listBuiltinNodeDefinitions } from "./workflow-nodes/definitions.mjs";
import {
  CUSTOM_NODE_DIR_NAME,
  ensureCustomWorkflowNodesLoaded,
  getCustomNodeDir,
  scaffoldCustomNodeFile,
  startCustomNodeDiscovery,
  stopCustomNodeDiscovery,
} from "./workflow-nodes/custom-loader.mjs";
import "./workflow-nodes/triggers.mjs";
import "./workflow-nodes/conditions.mjs";
import "./workflow-nodes/actions.mjs";
import "./workflow-nodes/meetings.mjs";
import "./workflow-nodes/validation.mjs";
import "./workflow-nodes/transforms.mjs";
import "./workflow-nodes/notifications.mjs";
import "./workflow-nodes/agent.mjs";
import "./workflow-nodes/flow.mjs";
import "./workflow-nodes/loop.mjs";

let builtinRegistered = false;
let customLoadPromise = null;
let discoveryStarted = false;

function ensureBuiltinNodesRegistered() {
  if (builtinRegistered) return;
  for (const { type, handler } of listBuiltinNodeDefinitions()) {
    registerRuntimeNodeType(type, handler, { source: "builtin" });
  }
  builtinRegistered = true;
}

export async function ensureWorkflowNodeTypesLoaded(options = {}) {
  ensureBuiltinNodesRegistered();
  if (!customLoadPromise || options.forceReload) {
    customLoadPromise = ensureCustomWorkflowNodesLoaded(options);
  }
  await customLoadPromise;
  if (!discoveryStarted) {
    startCustomNodeDiscovery(options);
    discoveryStarted = true;
  }
  return listNodeTypes();
}

await ensureWorkflowNodeTypesLoaded();

export {
  CUSTOM_NODE_DIR_NAME,
  getCustomNodeDir,
  getNodeType,
  getNodeTypeMeta,
  listNodeTypes,
  scaffoldCustomNodeFile,
  startCustomNodeDiscovery,
  stopCustomNodeDiscovery,
  unregisterNodeType,
};
export { registerRuntimeNodeType as registerNodeType };
