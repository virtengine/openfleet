/**
 * OpenTelemetry tracing + metrics for Bosun orchestration.
 *
 * Designed to be fully external to agent context windows and degrade to
 * near-zero overhead when disabled or when OTel packages are unavailable.
 */

const SERVICE_NAME = "bosun";
const SERVICE_VERSION = process.env.npm_package_version || "0.0.0";

const NOOP_DISPOSER = Object.freeze({
  span: null,
  end() {},
  setAttribute() {},
  addEvent() {},
  recordException() {},
});

const state = {
  initialized: false,
  enabled: false,
  sdk: null,
  api: null,
  config: Object.freeze({
    enabled: false,
    endpoint: "",
    sampleRate: 1,
    serviceName: SERVICE_NAME,
    serviceVersion: SERVICE_VERSION,
    metricsEndpoint: "",
  }),
  tracer: createNoopTracer(),
  meter: null,
  instruments: null,
  spansByKey: new Map(),
  llmSpansByKey: new Map(),
  activeSessionCount: 0,
  testSpans: [],
  metricsState: createMetricsState(),
};

function createMetricsState() {
  return {
    taskDurationRecords: [],
    taskTokensTotal: 0,
    taskCostUsd: 0,
    activeSessions: 0,
    errorsByType: {},
    interventionsByType: {},
  };
}

function createNoopTracer() {
  return {
    startActiveSpan(name, options, fn) {
      return fn(createNoopSpan(name, options?.attributes || {}));
    },
    startSpan(name, options = {}) {
      return createNoopSpan(name, options.attributes || {});
    },
  };
}

function createNoopSpan(name, attributes = {}) {
  return {
    name,
    attributes: { ...attributes },
    events: [],
    exceptions: [],
    ended: false,
    setAttribute(key, value) {
      if (value !== undefined && value !== null) this.attributes[key] = value;
    },
    addEvent(eventName, eventAttributes = {}) {
      this.events.push({ name: eventName, attributes: { ...eventAttributes } });
    },
    recordException(error) {
      this.exceptions.push(error);
    },
    setStatus() {},
    end() {
      this.ended = true;
    },
  };
}

function createTestTracer() {
  return {
    startActiveSpan(name, options, fn) {
      const span = createTestSpan(name, options?.attributes || {});
      return fn(span);
    },
    startSpan(name, options = {}) {
      return createTestSpan(name, options.attributes || {});
    },
  };
}

function createTestSpan(name, attributes = {}) {
  const span = {
    name,
    attributes: { ...attributes },
    events: [],
    exceptions: [],
    status: null,
    ended: false,
    setAttribute(key, value) {
      if (value !== undefined && value !== null) span.attributes[key] = value;
    },
    addEvent(eventName, eventAttributes = {}) {
      span.events.push({ name: eventName, attributes: { ...eventAttributes } });
    },
    recordException(error) {
      span.exceptions.push(error);
    },
    setStatus(status) {
      span.status = status;
    },
    end() {
      span.ended = true;
    },
  };
  state.testSpans.push(span);
  return span;
}

function clampSampleRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0, Math.min(1, numeric));
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function normalizeTracingConfig(config = {}) {
  const endpoint = String(
    config.endpoint || process.env.BOSUN_OTEL_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "",
  ).trim();
  const enabled = endpoint.length > 0 && parseBoolean(config.enabled ?? process.env.BOSUN_OTEL_ENABLED, true);
  return Object.freeze({
    enabled,
    endpoint,
    sampleRate: clampSampleRate(config.sampleRate ?? process.env.BOSUN_OTEL_SAMPLE_RATE ?? 1),
    serviceName: String(config.serviceName || SERVICE_NAME).trim() || SERVICE_NAME,
    serviceVersion: String(config.serviceVersion || SERVICE_VERSION).trim() || SERVICE_VERSION,
    metricsEndpoint: String(
      config.metricsEndpoint || process.env.BOSUN_OTEL_METRICS_ENDPOINT || endpoint,
    ).trim(),
  });
}

function coerceAttributes(attributes = {}) {
  const result = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    if (value === undefined || value === null || Number.isNaN(value)) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    } else if (value instanceof Date) {
      result[key] = value.toISOString();
    } else {
      result[key] = JSON.stringify(value);
    }
  }
  return result;
}

async function loadOpenTelemetry() {
  try {
    const api = await import("@opentelemetry/api");
    const resources = await import("@opentelemetry/resources");
    const sdkNode = await import("@opentelemetry/sdk-node");
    const traceExporter = await import("@opentelemetry/exporter-trace-otlp-http");
    const metricsExporter = await import("@opentelemetry/exporter-metrics-otlp-http");
    const metricsSdk = await import("@opentelemetry/sdk-metrics");
    let traceSdk = null;
    try {
      traceSdk = await import("@opentelemetry/sdk-trace-base");
    } catch {
      traceSdk = await import("@opentelemetry/sdk-trace-node");
    }
    let semantic = {};
    try {
      semantic = await import("@opentelemetry/semantic-conventions");
    } catch {}
    return {
      api,
      resourceFromAttributes: resources.resourceFromAttributes,
      NodeSDK: sdkNode.NodeSDK,
      OTLPTraceExporter: traceExporter.OTLPTraceExporter,
      OTLPMetricExporter: metricsExporter.OTLPMetricExporter,
      PeriodicExportingMetricReader: metricsSdk.PeriodicExportingMetricReader,
      BatchSpanProcessor: traceSdk.BatchSpanProcessor,
      ParentBasedSampler: traceSdk.ParentBasedSampler,
      TraceIdRatioBasedSampler: traceSdk.TraceIdRatioBasedSampler,
      ConsoleSpanExporter: traceSdk.ConsoleSpanExporter,
      ATTR_SERVICE_NAME: semantic.ATTR_SERVICE_NAME || "service.name",
      ATTR_SERVICE_VERSION: semantic.ATTR_SERVICE_VERSION || "service.version",
    };
  } catch {
    return null;
  }
}

function createInstrumentFacade() {
  return Object.freeze({
    taskDuration: {
      record(value, attributes = {}) {
        state.metricsState.taskDurationRecords.push({ value, attributes });
      },
    },
    taskTokensTotal: {
      add(value) {
        state.metricsState.taskTokensTotal += Number(value) || 0;
      },
    },
    taskCostUsd: {
      add(value) {
        state.metricsState.taskCostUsd += Number(value) || 0;
      },
    },
    agentErrors: {
      add(value, attributes = {}) {
        const key = String(attributes.errorType || "unknown");
        state.metricsState.errorsByType[key] =
          (state.metricsState.errorsByType[key] || 0) + (Number(value) || 0);
      },
    },
    agentInterventions: {
      add(value, attributes = {}) {
        const key = String(attributes.interventionType || "unknown");
        state.metricsState.interventionsByType[key] =
          (state.metricsState.interventionsByType[key] || 0) + (Number(value) || 0);
      },
    },
  });
}

function resetRuntimeState() {
  state.spansByKey.clear();
  state.llmSpansByKey.clear();
  state.activeSessionCount = 0;
  state.testSpans = [];
  state.metricsState = createMetricsState();
}

export async function setupTracing(config = {}) {
  const normalized = normalizeTracingConfig(config);
  if (state.sdk) await shutdownTracing();
  resetRuntimeState();
  state.config = normalized;
  state.initialized = true;

  if (!normalized.enabled) {
    state.enabled = false;
    state.api = null;
    state.tracer = createNoopTracer();
    state.instruments = createInstrumentFacade();
    return { enabled: false, tracer: state.tracer, config: normalized };
  }

  const otel = await loadOpenTelemetry();
  if (!otel) {
    state.enabled = true;
    state.api = null;
    state.tracer = createTestTracer();
    state.instruments = createInstrumentFacade();
    return { enabled: true, tracer: state.tracer, config: normalized, fallback: true };
  }

  const traceExporter = normalized.endpoint === "console"
    ? new otel.ConsoleSpanExporter()
    : new otel.OTLPTraceExporter({ url: normalized.endpoint });
  const metricReader = new otel.PeriodicExportingMetricReader({
    exporter: new otel.OTLPMetricExporter({ url: normalized.metricsEndpoint }),
    exportIntervalMillis: 15_000,
  });
  const sdk = new otel.NodeSDK({
    resource: otel.resourceFromAttributes({
      [otel.ATTR_SERVICE_NAME]: normalized.serviceName,
      [otel.ATTR_SERVICE_VERSION]: normalized.serviceVersion,
    }),
    sampler: new otel.ParentBasedSampler({
      root: new otel.TraceIdRatioBasedSampler(normalized.sampleRate),
    }),
    spanProcessors: [new otel.BatchSpanProcessor(traceExporter)],
    metricReader,
  });
  await sdk.start();

  state.enabled = true;
  state.sdk = sdk;
  state.api = otel.api;
  state.tracer = otel.api.trace.getTracer(normalized.serviceName, normalized.serviceVersion);
  state.instruments = createInstrumentFacade();
  return { enabled: true, tracer: state.tracer, config: normalized };
}

export async function shutdownTracing() {
  const sdk = state.sdk;
  state.sdk = null;
  state.enabled = false;
  state.api = null;
  state.tracer = createNoopTracer();
  state.instruments = null;
  resetRuntimeState();
  if (sdk) {
    await sdk.shutdown().catch(() => {});
  }
}

export async function resetTracingForTests() {
  await shutdownTracing();
  state.initialized = false;
  state.config = Object.freeze({
    enabled: false,
    endpoint: "",
    sampleRate: 1,
    serviceName: SERVICE_NAME,
    serviceVersion: SERVICE_VERSION,
    metricsEndpoint: "",
  });
}

function currentTraceApi() {
  return state.api?.trace || null;
}

function activeContextWithParent(parentSpan) {
  const traceApi = currentTraceApi();
  if (!traceApi || !parentSpan) return undefined;
  return traceApi.setSpan(state.api.context.active(), parentSpan);
}

async function withSpan(name, options = {}, fn) {
  if (!state.enabled) return fn(NOOP_DISPOSER);
  const runner = async (span) => {
    const disposer = {
      span,
      end(statusCode = "OK") {
        if (typeof span.setStatus === "function") {
          const status = state.api?.SpanStatusCode
            ? { code: state.api.SpanStatusCode[statusCode] ?? state.api.SpanStatusCode.OK }
            : { code: statusCode };
          span.setStatus(status);
        }
        span.end();
      },
      setAttribute(key, value) {
        if (value !== undefined && value !== null) span.setAttribute(key, value);
      },
      addEvent(eventName, attributes = {}) {
        span.addEvent(eventName, coerceAttributes(attributes));
      },
      recordException(error) {
        span.recordException(error);
      },
    };
    try {
      const result = await fn(disposer);
      return result;
    } catch (error) {
      disposer.recordException(error);
      recordAgentError(error?.name || "Error");
      if (typeof span.setStatus === "function") {
        span.setStatus(
          state.api?.SpanStatusCode
            ? { code: state.api.SpanStatusCode.ERROR, message: error?.message || String(error) }
            : { code: "ERROR", message: error?.message || String(error) },
        );
      }
      throw error;
    } finally {
      span.end();
    }
  };

  const traceApi = currentTraceApi();
  if (traceApi && typeof state.tracer.startActiveSpan === "function") {
    return state.tracer.startActiveSpan(name, options, runner);
  }
  return runner(state.tracer.startSpan(name, options));
}

function maybeRecordTaskMetrics(attributes = {}) {
  const totalTokens = Number(attributes.inputTokens || 0) + Number(attributes.outputTokens || 0);
  if (totalTokens > 0) state.instruments?.taskTokensTotal.add(totalTokens, coerceAttributes(attributes));
  const costUsd = Number(attributes.costUsd || 0);
  if (costUsd > 0) state.instruments?.taskCostUsd.add(costUsd, coerceAttributes(attributes));
}

export async function traceTaskExecution(attributesOrTaskId, maybeFn) {
  const attributes =
    typeof attributesOrTaskId === "string"
      ? { taskId: attributesOrTaskId }
      : (attributesOrTaskId || {});
  const fn = typeof attributesOrTaskId === "function" ? attributesOrTaskId : maybeFn;
  const taskId = String(attributes.taskId || attributes.id || "unknown");
  const spanAttributes = coerceAttributes({
    "bosun.task.id": taskId,
    "bosun.task.title": attributes.title,
    "bosun.task.priority": attributes.priority,
    "bosun.task.assignee": attributes.assignee,
    "bosun.task.sdk": attributes.sdk,
    "gen_ai.request.model": attributes.model,
    "bosun.git.branch": attributes.branch,
  });
  const startedAt = Date.now();
  return withSpan(
    "bosun.task.execution",
    { attributes: spanAttributes, kind: state.api?.SpanKind?.INTERNAL },
    async (spanCtx) => {
      if (spanCtx.span) bindTaskSpan(taskId, spanCtx.span);
      try {
        const result = await fn(spanCtx);
        return result;
      } finally {
        clearBoundTaskSpan(taskId);
        state.instruments?.taskDuration.record(Date.now() - startedAt, spanAttributes);
      }
    },
  );
}

export async function traceAgentSession(sessionOrId, attributesOrFn, maybeFn) {
  const descriptor =
    typeof sessionOrId === "string"
      ? { sessionId: sessionOrId }
      : (sessionOrId || {});
  const attributes = typeof attributesOrFn === "function" ? {} : (attributesOrFn || {});
  const fn = typeof attributesOrFn === "function" ? attributesOrFn : maybeFn;
  const sessionId = String(descriptor.sessionId || descriptor.id || descriptor.taskId || "unknown");
  const taskId = String(descriptor.taskId || attributes.taskId || "").trim();
  const parentSpan = taskId ? getBoundTaskSpan(taskId) : null;
  const options = {
    attributes: coerceAttributes({
      "bosun.session.id": sessionId,
      "bosun.task.id": taskId || undefined,
      "bosun.session.sdk": descriptor.sdk || attributes.sdk,
      "bosun.session.thread_key": descriptor.threadKey || attributes.threadKey,
      "bosun.session.start_time": descriptor.startTime || attributes.startTime,
      "bosun.session.tokens_budget": descriptor.tokensBudget || attributes.tokensBudget,
    }),
    kind: state.api?.SpanKind?.INTERNAL,
    context: activeContextWithParent(parentSpan),
  };
  state.activeSessionCount += 1;
  state.metricsState.activeSessions = state.activeSessionCount;
  return withSpan("bosun.agent.session", options, async (spanCtx) => {
    spanCtx.addEvent("session.lifecycle.start", { sessionId, taskId: taskId || undefined });
    try {
      return await fn(spanCtx);
    } finally {
      spanCtx.addEvent("session.lifecycle.end", { sessionId, taskId: taskId || undefined });
      state.activeSessionCount = Math.max(0, state.activeSessionCount - 1);
      state.metricsState.activeSessions = state.activeSessionCount;
    }
  });
}

export async function traceToolCall(toolOrAttrs, attributesOrFn, maybeFn) {
  const descriptor =
    typeof toolOrAttrs === "string"
      ? { toolName: toolOrAttrs }
      : (toolOrAttrs || {});
  const attributes = typeof attributesOrFn === "function" ? {} : (attributesOrFn || {});
  const fn = typeof attributesOrFn === "function" ? attributesOrFn : maybeFn;
  const taskId = String(descriptor.taskId || attributes.taskId || "").trim();
  const parentSpan = taskId ? getBoundTaskSpan(taskId) : null;
  const startedAt = Date.now();
  return withSpan(
    "bosun.tool.call",
    {
      attributes: coerceAttributes({
        "bosun.tool.name": descriptor.toolName,
        "bosun.task.id": taskId || undefined,
        ...attributes,
      }),
      kind: state.api?.SpanKind?.CLIENT,
      context: activeContextWithParent(parentSpan),
    },
    async (spanCtx) => {
      const result = await fn(spanCtx);
      spanCtx.setAttribute("bosun.tool.duration_ms", Date.now() - startedAt);
      if (descriptor.tokensUsed || attributes.tokensUsed) {
        spanCtx.setAttribute("bosun.tool.tokens_used", descriptor.tokensUsed || attributes.tokensUsed);
      }
      return result;
    },
  );
}

export async function traceLLMCall(modelOrAttrs, attributesOrFn, maybeFn) {
  const descriptor =
    typeof modelOrAttrs === "string"
      ? { model: modelOrAttrs }
      : (modelOrAttrs || {});
  const attributes = typeof attributesOrFn === "function" ? {} : (attributesOrFn || {});
  const fn = typeof attributesOrFn === "function" ? attributesOrFn : maybeFn;
  const merged = { ...descriptor, ...attributes };
  const taskId = String(merged.taskId || merged["bosun.task.id"] || "").trim();
  const parentSpan = taskId ? getBoundTaskSpan(taskId) : null;
  return withSpan(
    "bosun.llm.call",
    {
      attributes: coerceAttributes({
        "gen_ai.request.model": merged.model,
        "gen_ai.system": merged.provider,
        "bosun.task.id": taskId || undefined,
        "bosun.llm.input_tokens": merged.inputTokens,
        "bosun.llm.output_tokens": merged.outputTokens,
        "bosun.llm.latency_ms": merged.latencyMs,
        "bosun.llm.cost_usd": merged.costUsd,
      }),
      kind: state.api?.SpanKind?.CLIENT,
      context: activeContextWithParent(parentSpan),
    },
    async (spanCtx) => {
      const result = await fn(spanCtx);
      maybeRecordTaskMetrics(merged);
      return result;
    },
  );
}

export function bindTaskSpan(taskId, span) {
  if (!taskId || !span) return;
  state.spansByKey.set(`task:${taskId}`, span);
}

export function getBoundTaskSpan(taskId) {
  return state.spansByKey.get(`task:${taskId}`) || null;
}

export function clearBoundTaskSpan(taskId) {
  state.spansByKey.delete(`task:${taskId}`);
}

export function recordEventOnTaskSpan(taskId, eventName, attributes = {}) {
  const span = getBoundTaskSpan(taskId);
  if (!span) return;
  span.addEvent(eventName, coerceAttributes(attributes));
}

export function recordAgentEvent(event = {}) {
  const taskId = String(event.taskId || event.payload?.taskId || "").trim();
  if (!taskId) return;
  recordEventOnTaskSpan(taskId, String(event.type || "agent:event"), {
    ...(event.payload || {}),
    ts: event.ts,
  });
}

export function trackSessionLifecycle({ reason, sessionId, taskId, attributes = {} } = {}) {
  const key = `session:${sessionId || taskId}`;
  if (reason === "session-created") {
    const parentSpan = taskId ? getBoundTaskSpan(taskId) : null;
    const span = state.tracer.startSpan("bosun.session.lifecycle", {
      attributes: coerceAttributes({
        "bosun.session.id": sessionId || taskId,
        "bosun.task.id": taskId,
        ...attributes,
      }),
      kind: state.api?.SpanKind?.INTERNAL,
      context: activeContextWithParent(parentSpan),
    });
    state.spansByKey.set(key, span);
    state.activeSessionCount += 1;
    state.metricsState.activeSessions = state.activeSessionCount;
    return;
  }
  const span = state.spansByKey.get(key);
  if (!span) return;
  span.addEvent(String(reason || "session-updated"), coerceAttributes(attributes));
  if (reason === "session-ended") {
    span.end();
    state.spansByKey.delete(key);
    state.activeSessionCount = Math.max(0, state.activeSessionCount - 1);
    state.metricsState.activeSessions = state.activeSessionCount;
  }
}

export function beginLlmCallSpan(key, attributes = {}) {
  if (!key || !state.enabled) return null;
  const taskId = String(attributes.taskId || attributes["bosun.task.id"] || "").trim();
  const parentSpan = taskId ? getBoundTaskSpan(taskId) : null;
  const span = state.tracer.startSpan("bosun.llm.call", {
    attributes: coerceAttributes(attributes),
    kind: state.api?.SpanKind?.CLIENT,
    context: activeContextWithParent(parentSpan),
  });
  state.llmSpansByKey.set(key, span);
  return span;
}

export function updateLlmCallSpan(key, attributes = {}, eventName = "update") {
  const span = state.llmSpansByKey.get(key);
  if (!span) return;
  for (const [attrKey, value] of Object.entries(coerceAttributes(attributes))) {
    span.setAttribute(attrKey, value);
  }
  span.addEvent(eventName, coerceAttributes(attributes));
}

export function endLlmCallSpan(key, { error, attributes = {} } = {}) {
  const span = state.llmSpansByKey.get(key);
  if (!span) return;
  for (const [attrKey, value] of Object.entries(coerceAttributes(attributes))) {
    span.setAttribute(attrKey, value);
  }
  maybeRecordTaskMetrics(attributes);
  if (error) {
    span.recordException(error);
  }
  span.end();
  state.llmSpansByKey.delete(key);
}

export function recordAgentError(errorType = "Error", attributes = {}) {
  state.instruments?.agentErrors.add(1, coerceAttributes({ errorType, ...attributes }));
}

export function recordAgentIntervention(interventionType = "unknown", attributes = {}) {
  const taskId = String(attributes.taskId || "").trim();
  if (taskId) {
    recordEventOnTaskSpan(taskId, "agent.intervention", { interventionType, ...attributes });
  }
  state.instruments?.agentInterventions.add(
    1,
    coerceAttributes({ interventionType, ...attributes }),
  );
}

export function getTracingState() {
  return {
    initialized: state.initialized,
    enabled: state.enabled,
    config: state.config,
    tracer: state.tracer,
    testSpans: state.testSpans,
    metrics: state.metricsState,
  };
}


