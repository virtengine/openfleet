function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function cloneJson(value) {
  if (value == null) return value ?? null;
  return JSON.parse(JSON.stringify(value));
}

function normalizeRole(role, fallback = "user") {
  const normalized = toTrimmedString(role).toLowerCase();
  if (["system", "user", "assistant", "tool", "developer"].includes(normalized)) {
    return normalized;
  }
  return fallback;
}

function normalizeTextContent(value) {
  if (typeof value === "string") {
    return {
      text: value,
      parts: [{ type: "text", text: value }],
    };
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((entry) => {
        if (typeof entry === "string") {
          return { type: "text", text: entry };
        }
        if (entry && typeof entry === "object") {
          if (entry.type === "input_text" || entry.type === "output_text") {
            return { type: "text", text: toTrimmedString(entry.text || entry.content) };
          }
          if (entry.type === "text") {
            return { type: "text", text: toTrimmedString(entry.text || entry.content) };
          }
          return cloneJson(entry);
        }
        return null;
      })
      .filter(Boolean);
    const text = parts
      .filter((entry) => entry.type === "text")
      .map((entry) => toTrimmedString(entry.text))
      .filter(Boolean)
      .join("\n");
    return { text, parts };
  }
  const fallback = toTrimmedString(value);
  return {
    text: fallback,
    parts: fallback ? [{ type: "text", text: fallback }] : [],
  };
}

function normalizeMessageEntry(message, index = 0, fallbackRole = "user") {
  const base = message && typeof message === "object"
    ? message
    : { role: fallbackRole, content: message };
  const role = normalizeRole(base.role, fallbackRole);
  const content = normalizeTextContent(
    base.content
      ?? base.message
      ?? base.text
      ?? base.output_text
      ?? base.input_text
      ?? "",
  );
  return {
    id: toTrimmedString(base.id) || `msg-${index + 1}`,
    role,
    text: content.text,
    content: content.parts,
    metadata: base.metadata && typeof base.metadata === "object" ? cloneJson(base.metadata) : {},
  };
}

export function normalizeProviderMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [messages];
  const fallbackRole = normalizeRole(options.fallbackRole, "user");
  return list
    .map((entry, index) => normalizeMessageEntry(entry, index, fallbackRole))
    .filter((entry) => entry.text || entry.content.length > 0);
}

export function buildProviderTurnPayload(input, options = {}) {
  if (Array.isArray(input)) {
    const messages = normalizeProviderMessages(input, options);
    return {
      providerId: toTrimmedString(options.providerId) || null,
      model: toTrimmedString(options.model) || null,
      prompt: messages.at(-1)?.text || "",
      messages,
    };
  }

  if (input && typeof input === "object") {
    const messages = normalizeProviderMessages(
      input.messages || input.history || input.items || input.prompt || "",
      { fallbackRole: input.role || options.fallbackRole || "user" },
    );
    return {
      providerId: toTrimmedString(input.providerId || options.providerId) || null,
      model: toTrimmedString(input.model || options.model) || null,
      prompt: toTrimmedString(input.prompt) || messages.at(-1)?.text || "",
      messages,
      metadata: input.metadata && typeof input.metadata === "object" ? cloneJson(input.metadata) : {},
    };
  }

  const messages = normalizeProviderMessages([{ role: options.fallbackRole || "user", content: input }], options);
  return {
    providerId: toTrimmedString(options.providerId) || null,
    model: toTrimmedString(options.model) || null,
    prompt: messages.at(-1)?.text || "",
    messages,
  };
}

export function normalizeProviderUsage(usage = {}) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(
    usage.inputTokens
      ?? usage.promptTokens
      ?? usage.prompt_tokens
      ?? usage.input_tokens
      ?? 0,
  );
  const outputTokens = Number(
    usage.outputTokens
      ?? usage.completionTokens
      ?? usage.completion_tokens
      ?? usage.output_tokens
      ?? 0,
  );
  const totalTokens = Number(
    usage.totalTokens
      ?? usage.total_tokens
      ?? inputTokens + outputTokens,
  );
  const costUsd = Number(
    usage.costUsd
      ?? usage.costUSD
      ?? usage.cost_usd
      ?? usage.cost
      ?? 0,
  );
  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    totalTokens: Number.isFinite(totalTokens) ? totalTokens : 0,
    costUsd: Number.isFinite(costUsd) ? costUsd : 0,
    raw: cloneJson(usage),
  };
}

export function normalizeProviderStreamEvent(event = {}, options = {}) {
  const eventType = toTrimmedString(
    event.type
      || event.event
      || event.kind
      || options.defaultType
      || "message_update",
  );
  const message = normalizeMessageEntry(
    event.message
      || event.delta
      || event.item
      || {
        role: event.role || options.role || "assistant",
        content: event.text || event.content || "",
      },
    0,
    event.role || options.role || "assistant",
  );
  return {
    type: eventType,
    providerId: toTrimmedString(event.providerId || options.providerId) || null,
    sessionId: toTrimmedString(event.sessionId || options.sessionId) || null,
    threadId: toTrimmedString(event.threadId || options.threadId || event.sessionId) || null,
    message,
    usage: normalizeProviderUsage(event.usage),
    raw: cloneJson(event),
  };
}

export function normalizeProviderResultPayload(result, options = {}) {
  const messages = normalizeProviderMessages(
    result?.messages
      || result?.items
      || result?.content
      || result?.output
      || [],
    { fallbackRole: options.role || "assistant" },
  );
  const text = toTrimmedString(
    result?.finalResponse
      || result?.text
      || result?.message
      || messages.at(-1)?.text
      || "",
  );
  return {
    text,
    messages,
    usage: normalizeProviderUsage(result?.usage),
    providerId: toTrimmedString(result?.providerId || options.providerId) || null,
    model: toTrimmedString(result?.model || options.model) || null,
    sessionId: toTrimmedString(result?.sessionId || options.sessionId) || null,
    threadId: toTrimmedString(result?.threadId || options.threadId || result?.sessionId) || null,
  };
}

export default normalizeProviderResultPayload;
