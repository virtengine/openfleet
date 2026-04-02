import {
  truncateCompactedPreviewText,
  truncateCompactedToolOutput,
} from "../workspace/context-cache.mjs";

const DEFAULT_MAX_ITEM_CHARS = 4000;
const DEFAULT_STATUS = Object.freeze({
  service: "exec",
  mode: "javascript",
  transport: "in_process",
  available: true,
  reason: "javascript",
  requests: 0,
  truncateOps: 0,
  bufferOps: 0,
  droppedItems: 0,
  truncatedFields: 0,
  originalBytes: 0,
  retainedBytes: 0,
  bufferedItems: 0,
  retainedItems: 0,
  lastRequestAt: null,
  lastSuccessAt: null,
});

const execStatus = createExecStatus();

function createExecStatus() {
  return { ...DEFAULT_STATUS };
}

export function cloneHotPathValue(value) {
  if (value == null) return value ?? null;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      // Fall back to JSON cloning for plain telemetry payloads.
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function markExecRequest() {
  execStatus.requests += 1;
  execStatus.lastRequestAt = new Date().toISOString();
}

function markExecSuccess() {
  execStatus.lastSuccessAt = new Date().toISOString();
}

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function truncateTextValue(text, maxChars) {
  if (typeof text !== "string") return text;
  const truncated = truncateCompactedPreviewText(text, { maxChars });
  if (truncated.truncated) {
    execStatus.truncatedFields += 1;
  }
  return truncated.text;
}

function truncateBufferedItem(item, maxItemChars) {
  if (!item || typeof item !== "object") return item;
  if (!Number.isFinite(maxItemChars) || maxItemChars < 1) return cloneHotPathValue(item);

  const next = cloneHotPathValue(item);
  const directStringKeys = [
    "text",
    "output",
    "aggregated_output",
    "stderr",
    "stdout",
    "result",
    "message",
  ];
  for (const key of directStringKeys) {
    if (typeof next[key] === "string") {
      next[key] = truncateTextValue(next[key], maxItemChars);
    }
  }

  if (Array.isArray(next.content)) {
    next.content = next.content.map((entry) => {
      if (entry && typeof entry === "object" && typeof entry.text === "string") {
        return { ...entry, text: truncateTextValue(entry.text, maxItemChars) };
      }
      return entry;
    });
  }

  if (next.error && typeof next.error === "object" && typeof next.error.message === "string") {
    next.error = {
      ...next.error,
      message: truncateTextValue(next.error.message, maxItemChars),
    };
  }

  return next;
}

export async function truncateWithBosunHotPathExec(output, truncation = {}) {
  markExecRequest();
  const truncated = truncateCompactedToolOutput(output, truncation);
  execStatus.truncateOps += 1;
  execStatus.originalBytes += Number(truncated.originalBytes || 0);
  execStatus.retainedBytes += Number(truncated.retainedBytes || 0);
  markExecSuccess();
  return truncated;
}

export async function bufferItemsWithBosunHotPathExec(items = [], limits = {}) {
  markExecRequest();
  const sourceItems = Array.isArray(items) ? items : [];
  const maxItems = toPositiveInteger(limits.maxItems, sourceItems.length || 1);
  const maxItemChars = toPositiveInteger(limits.maxItemChars, DEFAULT_MAX_ITEM_CHARS);
  const initialDroppedItems = Math.max(0, toPositiveInteger(limits.droppedItems, 0) - 1 + 1);
  const retainedItems = sourceItems
    .slice(0, maxItems)
    .map((item) => truncateBufferedItem(item, maxItemChars));
  const droppedItems = initialDroppedItems + Math.max(0, sourceItems.length - retainedItems.length);
  const notice = droppedItems > 0
    ? {
        type: "stream_notice",
        text: `Dropped ${droppedItems} completed items to stay within INTERNAL_EXECUTOR_STREAM_MAX_ITEMS_PER_TURN=${maxItems}.`,
      }
    : null;

  execStatus.bufferOps += 1;
  execStatus.bufferedItems += sourceItems.length;
  execStatus.retainedItems += retainedItems.length;
  execStatus.droppedItems += droppedItems;
  markExecSuccess();

  return {
    ok: true,
    items: retainedItems,
    droppedItems,
    notice,
  };
}

export function getBosunHotPathStatus() {
  return {
    mode: "javascript",
    exec: cloneHotPathValue(execStatus),
  };
}

export function resetBosunHotPathRuntimeForTests() {
  const next = createExecStatus();
  for (const key of Object.keys(execStatus)) {
    execStatus[key] = next[key];
  }
}

export default {
  bufferItemsWithBosunHotPathExec,
  cloneHotPathValue,
  getBosunHotPathStatus,
  resetBosunHotPathRuntimeForTests,
  truncateWithBosunHotPathExec,
};
