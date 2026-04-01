function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function estimateBytes(value) {
  return Buffer.byteLength(String(value ?? ""), "utf8");
}

function truncateText(text, options = {}) {
  const value = String(text ?? "");
  const maxChars = Number.isFinite(Number(options.maxChars))
    ? Math.max(32, Math.trunc(Number(options.maxChars)))
    : 4000;
  const marker = String(options.marker ?? "…truncated");
  if (value.length <= maxChars) {
    return {
      text: value,
      truncated: false,
      originalChars: value.length,
      retainedChars: value.length,
    };
  }
  const tailChars = Number.isFinite(Number(options.tailChars))
    ? Math.max(0, Math.trunc(Number(options.tailChars)))
    : Math.min(400, Math.floor(maxChars * 0.2));
  const headChars = Math.max(0, maxChars - tailChars - marker.length - 2);
  const nextValue = `${value.slice(0, headChars)}\n${marker}\n${tailChars > 0 ? value.slice(-tailChars) : ""}`;
  return {
    text: nextValue,
    truncated: true,
    originalChars: value.length,
    retainedChars: nextValue.length,
  };
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ type: typeof value, preview: String(value) }, null, 2);
  }
}

export function truncateToolOutput(output, options = {}) {
  const format = typeof output === "string" ? "text" : "json";
  const serialized = format === "text" ? String(output ?? "") : safeJsonStringify(output);
  const truncatedText = truncateText(serialized, options);
  const originalBytes = estimateBytes(serialized);
  const retainedBytes = estimateBytes(truncatedText.text);
  if (!truncatedText.truncated) {
    return {
      format,
      data: format === "text" ? serialized : cloneJson(output),
      preview: serialized,
      truncated: false,
      originalChars: truncatedText.originalChars,
      retainedChars: truncatedText.retainedChars,
      originalBytes,
      retainedBytes,
    };
  }
  return {
    format,
    data: format === "text"
      ? truncatedText.text
      : {
          truncated: true,
          preview: truncatedText.text,
        },
    preview: truncatedText.text,
    truncated: true,
    originalChars: truncatedText.originalChars,
    retainedChars: truncatedText.retainedChars,
    originalBytes,
    retainedBytes,
  };
}

export { truncateText };

export default truncateToolOutput;
