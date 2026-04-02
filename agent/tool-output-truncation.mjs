import {
  truncateCompactedPreviewText,
  truncateCompactedToolOutput,
} from "../workspace/context-cache.mjs";

export function truncateToolOutput(output, options = {}) {
  return truncateCompactedToolOutput(output, options);
}

export const truncateText = truncateCompactedPreviewText;

export default truncateToolOutput;
