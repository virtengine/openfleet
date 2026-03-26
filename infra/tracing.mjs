/**
 * OpenTelemetry tracing helpers for Bosun orchestration.
 *
 * Tracing stays external to agent prompts/context. When disabled, helpers
 * degrade to no-op wrappers so there is no agent token impact.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const DEFAULT_SERVICE_NAME = "bosun";
const DEFAULT_SERVICE_VERSION = process.env.npm_package_version || "0.42.0";
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const DEFAULT_EXPORT_TIMEOUT_MS = 1000;

const contextStore = new AsyncLocalStorage();

const NOOP_METER = Object.freeze({
  createHistogram() {
    return { record() {} };
  },
  createCounter() {
    return { add() {} };
  },
  createUpDownCounter() {
    return { add() {} };
  },
});

function randomId(bytes = 8) {
  let value = "";
  while (value.length < bytes * 2) {
    value += Math.random().toString(16).slice(2);
  }
  return value.slice(0, bytes * 2);
}

function nowHrTime() {
  return process.hrtime.bigint();
}

function durationMs(startTime) {
  return Number(process.hrtime.bigint() - startTime) / 1_000_000;
}

function omitUndefined(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

function inferProtocol(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    return "otlp-http";
  }
  return endpoint.startsWith("http") ? "otlp-http" : "otlp-grpc";
}

function createMetricStore() {
  const counters = new Map();
  const gauges = new Map();
  const histograms = new Map();

  return {
    counters,
    gauges,
    histograms,
    meter: {
      createCounter(name) {
        return {
          add(value, attributes = {}) {
            const bucket = counters.get(name) || [];
            bucket.push({ value, attributes });
            counters.set(name, bucket);
          },
        };
      },
      createUpDownCounter(name) {
        return {
          add(value, attributes = {}) {
            const bucket = gauges.get(name) || [];
            bucket.push({ value, attributes });
            gauges.set(name, bucket);
          },
        };
      },
      createHistogram(name) {
        return {
          record(value, attributes = {}) {
            const bucket = histograms.get(name) || [];
            bucket.push({ value, attributes });
            histograms.set(name, bucket);
          },
        };
      },
    },
  };
}

function createNoopState() {
  return {
    enabled: false,
    endpoint: null,
    sampleRate: 0,
    serviceName: DEFAULT_SERVICE_NAME,
    serviceVersion: DEFAULT_SERVICE_VERSION,
    exporter: null,
    meter: NOOP_METER,
    metrics: createMetricStore(),
    provider: null,
    tracer: null,
    sdk: null,
    api: null,
    statusCodes: null,
    spanKind: null,
    activeSpans: new Map(),
    finishedSpans: [],
    testSpans: [],
  };
}

let tracingState = createNoopState();
let metricInstruments = null;

function clampSampleRate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(1, Math.max(0, numeric));
}

function getCurrentContext() {
  return contextStore.getStore() || null;
}

function ensureMetricInstruments() {
  const meter = tracingState.meter || NOOP_METER;
  metricInstruments = {
    taskDuration: meter.createHistogram("bosun.task.duration"),
    taskTokensTotal: meter.createCounter("bosun.task.tokens.total"),
    taskCostUsd: meter.createCounter("bosun.task.cost.usd"),
    agentSessionsActive: meter.createUpDownCounter("bosun.agent.sessions.active"),
    agentErrors: meter.createCounter("bosun.agent.errors"),
    agentInterventions: meter.createCounter("bosun.agent.interventions"),
  };
}

function recordMetric(name, type, value, attributes = {}) {
  if (!metricInstruments) return;
  const instrument = metricInstruments[name];
  if (!instrument) return;
  if (type === "histogram") {
    instrument.record(value, attributes);
    return;
  }
  instrument.add(value, attributes);
}

function createLocalSpan(name, attributes = {}, parent = null) {
  const activeParent = parent || getCurrentContext();
  const traceId = activeParent?.traceId || randomId(TRACE_ID_BYTES);
  const spanId = randomId(SPAN_ID_BYTES);
  return {
    name,
    traceId,
    spanId,
    parentSpanId: activeParent?.spanId || null,
    startTime: nowHrTime(),
    endTime: null,
    durationMs: null,
    attributes: { ...attributes },
    status: { code: "OK" },
    events: [],
    exceptions: [],
    links: [],
    otelSpan: null,
  };
}

function attachOtelAttributes(otelSpan, attributes = {}) {
  if (!otelSpan || typeof otelSpan.setAttributes !== "function") return;
  const normalized = omitUndefined(attributes);
  if (Object.keys(normalized).length > 0) {
    otelSpan.setAttributes(normalized);
  }
}

function syncSpanContext(span) {
  const spanContext = span?.otelSpan?.spanContext?.();
  if (!spanContext) return;
  span.traceId = spanContext.traceId || span.traceId;
  span.spanId = spanContext.spanId || span.spanId;
}

function finalizeLocalSpan(span) {
  span.endTime = nowHrTime();
  span.durationMs = durationMs(span.startTime);
  tracingState.activeSpans.delete(span.spanId);
  const finishedSpan = {
    ...span,
    attributes: { ...span.attributes },
    events: [...span.events],
    exceptions: [...span.exceptions],
    links: [...span.links],
    status: { ...span.status },
  };
  tracingState.finishedSpans.push(finishedSpan);
  tracingState.testSpans.push(finishedSpan);
}

async function loadOtelBindings() {
  const [api, sdkNode, exporterTraceHttp, exporterMetricsHttp, resources, semantic] = await Promise.all([
    import("@opentelemetry/api"),
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
  ]);

  return {
    api,
    NodeSDK: sdkNode.NodeSDK,
    OTLPTraceExporter: exporterTraceHttp.OTLPTraceExporter,
    OTLPMetricExporter: exporterMetricsHttp.OTLPMetricExporter,
    resourceFromAttributes:
      resources.resourceFromAttributes ||
      ((attributes) => new resources.Resource(attributes)),
    semantic,
  };
}

async function shutdownSdk(sdk) {
  if (!sdk?.shutdown) return;
  try {
    await sdk.shutdown();
  } catch {
  }
}

export async function setupTracing(endpointOrConfig = null) {
  const inputConfig =
    typeof endpointOrConfig === "string"
      ? { endpoint: endpointOrConfig }
      : (endpointOrConfig ?? {});

  const endpoint = process.env.BOSUN_OTEL_ENDPOINT || inputConfig.endpoint || null;
  const enabled = endpoint ? true : (inputConfig.enabled ?? false);
  const sampleRate = Number(inputConfig.sampleRate ?? 1);
  const exportTimeoutMillis = Math.max(
    1,
    Number(inputConfig.exportTimeoutMillis ?? DEFAULT_EXPORT_TIMEOUT_MS),
  );

  await shutdownSdk(tracingState.sdk);

  if (!enabled || !endpoint) {
    tracingState = createNoopState();
    ensureMetricInstruments();
    return {
      enabled: false,
      endpoint: null,
      sampleRate: 0,
      serviceName: DEFAULT_SERVICE_NAME,
      serviceVersion: DEFAULT_SERVICE_VERSION,
      config: {
        enabled: false,
        endpoint: null,
        sampleRate: 0,
        serviceName: DEFAULT_SERVICE_NAME,
        serviceVersion: DEFAULT_SERVICE_VERSION,
      },
    };
  }

  const serviceName = inputConfig.serviceName || DEFAULT_SERVICE_NAME;
  const serviceVersion = inputConfig.serviceVersion || DEFAULT_SERVICE_VERSION;
  const resolvedSampleRate = clampSampleRate(sampleRate);
  const metrics = createMetricStore();

  let sdk = null;
  let tracer = null;
  let api = null;
  let statusCodes = null;
  let spanKind = null;
  const exporter = {
    protocol: inferProtocol(endpoint),
    processor: "batch",
  };

  try {
    const otel = await loadOtelBindings();
    api = otel.api;
    statusCodes = otel.api.SpanStatusCode;
    spanKind = otel.api.SpanKind;
    const resource = otel.resourceFromAttributes({
      [otel.semantic.SEMRESATTRS_SERVICE_NAME || "service.name"]: serviceName,
      [otel.semantic.SEMRESATTRS_SERVICE_VERSION || "service.version"]: serviceVersion,
    });

    const metricReader = new otel.PeriodicExportingMetricReader({
      exporter: new otel.OTLPMetricExporter({
        url: deriveMetricsEndpoint(endpoint),
        timeoutMillis: exportTimeoutMillis,
      }),
      exportIntervalMillis: 60_000,
      exportTimeoutMillis,
    });
    sdk = new otel.NodeSDK({
      resource,
      traceExporter: new otel.OTLPTraceExporter({
        url: endpoint,
        timeoutMillis: exportTimeoutMillis,
      }),
      metricReader,
      sampler: new otel.ParentBasedSampler({
        root: new otel.TraceIdRatioBasedSampler(resolvedSampleRate),
      }),
    });

    if (typeof sdk.start === "function") {
      await sdk.start();
    }

    tracer = otel.api.trace.getTracer(serviceName, serviceVersion);
  } catch {
    sdk = null;
    tracer = {
      startSpan(name, options = {}) {
        const attributes = options?.attributes || {};
        return {
          setAttributes() {},
          addEvent() {},
          recordException() {},
          setStatus() {},
          end() {},
          spanContext() {
            return { traceId: randomId(TRACE_ID_BYTES), spanId: randomId(SPAN_ID_BYTES) };
          },
          attributes,
          name,
        };
      },
    };
    api = null;
    statusCodes = null;
    spanKind = null;
  }

  tracingState = {
    enabled: true,
    endpoint,
    sampleRate: resolvedSampleRate,
    serviceName,
    serviceVersion,
    exporter,
    meter: metrics.meter,
    metrics,
    provider: sdk,
    tracer,
    sdk,
    api,
    statusCodes,
    spanKind,
    activeSpans: new Map(),
    finishedSpans: [],
    testSpans: [],
  };
  ensureMetricInstruments();

  return {
    enabled: true,
    endpoint,
    sampleRate: resolvedSampleRate,
    serviceName,
    serviceVersion,
    exporter,
    config: {
      enabled: true,
      endpoint,
      sampleRate: resolvedSampleRate,
      serviceName,
      serviceVersion,
    },
  };
}

export function getTracingState() {
  const activeSessions = (tracingState.metrics.gauges.get("bosun.agent.sessions.active") || []).reduce(
    (total, entry) => total + Number(entry?.value || 0),
    0,
  );
  const taskTokensTotal = (tracingState.metrics.counters.get("bosun.task.tokens.total") || []).reduce(
    (total, entry) => total + Number(entry?.value || 0),
    0,
  );
  const taskCostUsd = (tracingState.metrics.counters.get("bosun.task.cost.usd") || []).reduce(
    (total, entry) => total + Number(entry?.value || 0),
    0,
  );
  const errorsByType = {};
  for (const entry of tracingState.metrics.counters.get("bosun.agent.errors") || []) {
    const type = entry?.attributes?.["bosun.error.type"] || "Error";
    errorsByType[type] = (errorsByType[type] || 0) + Number(entry?.value || 0);
  }

  return {
    enabled: tracingState.enabled,
    endpoint: tracingState.endpoint,
    sampleRate: tracingState.sampleRate,
    serviceName: tracingState.serviceName,
    serviceVersion: tracingState.serviceVersion,
    exporter: tracingState.exporter,
    config: {
      enabled: tracingState.enabled,
      endpoint: tracingState.endpoint,
      sampleRate: tracingState.sampleRate,
      serviceName: tracingState.serviceName,
      serviceVersion: tracingState.serviceVersion,
    },
    tracer: tracingState.tracer,
    testSpans: [...tracingState.testSpans],
    metrics: {
      activeSessions,
      taskTokensTotal,
      taskCostUsd,
      errorsByType,
    },
  };
}

export function getFinishedSpans() {
  return [...tracingState.finishedSpans];
}

export function getMetricSnapshot() {
  return {
    counters: new Map(tracingState.metrics.counters),
    gauges: new Map(tracingState.metrics.gauges),
    histograms: new Map(tracingState.metrics.histograms),
  };
}

export async function shutdownTracing() {
  await shutdownSdk(tracingState.sdk);
  tracingState = createNoopState();
  metricInstruments = null;
  ensureMetricInstruments();
}

export function resetTracingForTests() {
  tracingState = createNoopState();
  metricInstruments = null;
  ensureMetricInstruments();
}

export function addSpanEvent(name, attributes = {}) {
  const current = getCurrentContext();
  if (!current) return;
  const normalized = omitUndefined(attributes);
  current.events.push({ name, attributes: normalized, at: Date.now() });
  if (current.otelSpan?.addEvent) {
    current.otelSpan.addEvent(name, normalized);
  }
}

export function recordAgentEvent(event = {}) {
  if (!event || typeof event !== "object") {
    return;
  }
  const eventName = typeof event.type === "string" && event.type.trim() ? event.type.trim() : "agent:event";
  addSpanEvent(eventName, {
    "bosun.task.id": event.taskId,
    "bosun.agent.id": event.agentId,
    "bosun.event.ts": event.ts,
    ...omitUndefined(event.payload || {}),
  });
}

export function recordIntervention(type, attributes = {}) {
  recordMetric("agentInterventions", "counter", 1, {
    "bosun.intervention.type": type,
    ...attributes,
  });
}

export function recordAgentError(type, attributes = {}) {
  recordMetric("agentErrors", "counter", 1, {
    "bosun.error.type": type,
    ...attributes,
  });
}

function resolveSpanAttributes(base = {}) {
  return omitUndefined({
    "bosun.workflow.id": base.workflowId || base.workflow?.id || base["bosun.workflow.id"],
    "bosun.workflow.run_id":
      base.workflowRunId ||
      base.runId ||
      base["bosun.workflow.run_id"],
    "bosun.workflow.parent_run_id":
      base.parentRunId ||
      base["bosun.workflow.parent_run_id"],
    "bosun.workflow.root_run_id":
      base.rootRunId ||
      base["bosun.workflow.root_run_id"],
    "bosun.workflow.node.id": base.nodeId || base["bosun.workflow.node.id"],
    "bosun.workflow.node.type": base.nodeType || base["bosun.workflow.node.type"],
    "bosun.task.id": base.taskId || base["bosun.task.id"],
    "bosun.agent.id": base.agentId || base["bosun.agent.id"],
  });
}

function getCarrierValue(carrier, key) {
  if (!carrier) return null;
  if (typeof carrier.get === "function") {
    const direct = carrier.get(key) ?? carrier.get(String(key || "").toLowerCase());
    return Array.isArray(direct) ? direct[0] : direct;
  }
  const direct = carrier[key] ?? carrier[String(key || "").toLowerCase()] ?? carrier[String(key || "").toUpperCase()];
  return Array.isArray(direct) ? direct[0] : direct;
}

function parseTraceparent(value) {
  const raw = String(value || "").trim();
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(raw);
  if (!match) return null;
  const [, traceId, spanId, flags] = match;
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    traceFlags: Number.parseInt(flags, 16),
    isRemote: true,
  };
}

export function formatTraceparent(traceContext = null) {
  const trace = traceContext || getCurrentTraceContext();
  const traceId = String(trace?.traceId || "").trim().toLowerCase();
  const spanId = String(trace?.spanId || "").trim().toLowerCase();
  const rawFlags = trace?.traceFlags;
  if (!Number.isFinite(Number(rawFlags))) {
    // If we cannot determine the correct trace flags, avoid emitting a potentially incorrect traceparent.
    return null;
  }
  const traceFlags = Number(rawFlags);
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) {
    return null;
  }
  const flagsHex = Math.max(0, Math.min(255, traceFlags)).toString(16).padStart(2, "0");
  return `00-${traceId}-${spanId}-${flagsHex}`;
}

function buildRemoteParentContext(carrier = null) {
  const spanContext = parseTraceparent(getCarrierValue(carrier, "traceparent"));
  if (!spanContext) return null;
  const otelContext = tracingState.api?.trace?.setSpanContext
    ? tracingState.api.trace.setSpanContext(
        tracingState.api.ROOT_CONTEXT || tracingState.api.context?.active?.(),
        spanContext,
      )
    : undefined;
  return {
    ...spanContext,
    otelContext,
  };
}

function normalizeSpanLink(link = {}, attributes = {}) {
  const traceId = String(link?.traceId || link?.["trace.trace_id"] || "").trim().toLowerCase();
  const spanId = String(link?.spanId || link?.["trace.span_id"] || "").trim().toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(traceId) || !/^[0-9a-f]{16}$/.test(spanId)) {
    return null;
  }
  return {
    traceId,
    spanId,
    traceFlags: Number.isFinite(Number(link?.traceFlags)) ? Number(link.traceFlags) : 1,
    attributes: omitUndefined(attributes),
  };
}

export function getCurrentTraceContext() {
  const current = getCurrentContext();
  if (!current) return null;
  return {
    name: current.name,
    traceId: current.traceId,
    spanId: current.spanId,
    parentSpanId: current.parentSpanId,
    attributes: { ...current.attributes },
  };
}

export function addSpanLink(link = {}, attributes = {}) {
  const current = getCurrentContext();
  if (!current) return;
  const normalized = normalizeSpanLink(link, attributes);
  if (!normalized) return;
  current.links.push(normalized);
  if (current.otelSpan?.addLink) {
    current.otelSpan.addLink({
      context: {
        traceId: normalized.traceId,
        spanId: normalized.spanId,
        traceFlags: normalized.traceFlags,
        isRemote: true,
      },
      attributes: normalized.attributes,
    });
  }
}

async function withSpan(name, attributes, fn, hooks = {}, options = {}) {
  if (!tracingState.enabled) {
    return fn({
      name,
      traceId: null,
      spanId: null,
      parentSpanId: null,
      attributes: omitUndefined(attributes),
      status: { code: "UNSET" },
      events: [],
      exceptions: [],
      links: [],
      otelSpan: null,
    });
  }

  const parent = options.parentSpan || getCurrentContext();
  const span = createLocalSpan(name, omitUndefined(attributes), parent);
  const otelOptions = { attributes: span.attributes };
  if (tracingState.spanKind && name === "bosun.llm.call") {
    otelOptions.kind = tracingState.spanKind.CLIENT;
  }

  if (tracingState.tracer?.startSpan) {
    const parentContext =
      options.parentContext ||
      (parent?.otelSpan && tracingState.api?.trace?.setSpan
        ? tracingState.api.trace.setSpan(tracingState.api.context.active(), parent.otelSpan)
        : parent?.otelContext);
    span.otelSpan = tracingState.tracer.startSpan(name, otelOptions, parentContext);
    syncSpanContext(span);
  }

  tracingState.activeSpans.set(span.spanId, span);

  return contextStore.run(span, async () => {
    try {
      hooks.onStart?.(span);
      const result = await fn(span);
      hooks.onSuccess?.(span, result);
      span.status = { code: "OK" };
      if (span.otelSpan?.setStatus) {
        span.otelSpan.setStatus({
          code: tracingState.statusCodes?.OK ?? 1,
        });
      }
      attachOtelAttributes(span.otelSpan, span.attributes);
      return result;
    } catch (error) {
      span.status = { code: "ERROR" };
      const exception = {
        message: error?.message || String(error),
        stack: error?.stack || "",
      };
      span.exceptions.push(exception);
      if (span.otelSpan?.recordException) {
        span.otelSpan.recordException(error);
      }
      if (span.otelSpan?.setStatus) {
        span.otelSpan.setStatus({
          code: tracingState.statusCodes?.ERROR ?? 2,
          message: exception.message,
        });
      }
      hooks.onError?.(span, error);
      if (!hooks.onError) {
        recordMetric("agentErrors", "counter", 1, {
          "bosun.error.type": error?.name || "Error",
          "trace.span_id": span.spanId,
          "trace.trace_id": span.traceId,
        });
      }
      throw error;
    } finally {
      hooks.onFinally?.(span);
      attachOtelAttributes(span.otelSpan, span.attributes);
      if (span.otelSpan?.end) {
        span.otelSpan.end();
      }
      finalizeLocalSpan(span);
    }
  });
}

export async function withIncomingTraceContext(carrier = {}, requestSpan = {}, fn) {
  const remoteParent = buildRemoteParentContext(carrier);
  return withSpan(
    requestSpan.name || "bosun.http.request",
    {
      ...resolveSpanAttributes(requestSpan),
      ...omitUndefined(requestSpan.attributes || {}),
      "http.method": requestSpan.method,
      "http.route": requestSpan.route,
      "http.target": requestSpan.target,
    },
    fn,
    {},
    remoteParent
      ? {
          parentSpan: remoteParent,
          parentContext: remoteParent.otelContext,
        }
      : {},
  );
}

export async function traceWorkflowRun(workflow = {}, fn) {
  return withSpan(
    "bosun.workflow.run",
    {
      ...resolveSpanAttributes(workflow),
      "bosun.workflow.name": workflow.name,
      "bosun.workflow.trigger_source": workflow.triggerSource,
    },
    fn,
  );
}

export async function traceWorkflowNode(node = {}, fn) {
  return withSpan(
    "bosun.workflow.node",
    {
      ...resolveSpanAttributes(node),
      "bosun.workflow.node.label": node.nodeLabel,
      "bosun.workflow.node.status": node.status,
    },
    fn,
  );
}

export async function traceTaskExecution(task = {}, fn) {
  const remoteParent = buildRemoteParentContext(task?.carrier || task?.headers || null);
  return withSpan(
    "bosun.task.execution",
    {
      ...resolveSpanAttributes(task),
      "bosun.task.title": task.title,
      "bosun.task.priority": task.priority,
      "bosun.task.assignee": task.assignee,
      "bosun.agent.sdk": task.sdk,
      "llm.model": task.model,
      "git.branch": task.branch,
    },
    fn,
    {
      onSuccess(span, result) {
        const inputTokens = Number(result?.inputTokens || result?.tokens?.input || 0);
        const outputTokens = Number(result?.outputTokens || result?.tokens?.output || 0);
        const totalTokens = Number(result?.totalTokens || inputTokens + outputTokens || 0);
        const costUsd = Number(result?.costUsd || result?.cost?.usd || 0);
        const metricAttributes = {
          "bosun.task.id": span.attributes["bosun.task.id"],
          "llm.model": span.attributes["llm.model"],
          "trace.span_id": span.spanId,
          "trace.trace_id": span.traceId,
        };
        if (totalTokens > 0) {
          recordMetric("taskTokensTotal", "counter", totalTokens, metricAttributes);
        }
        if (costUsd > 0) {
          recordMetric("taskCostUsd", "counter", costUsd, metricAttributes);
        }
      },
      onError(span, error) {
        recordMetric("agentErrors", "counter", 1, {
          "bosun.error.type": error?.name || "Error",
          "trace.span_id": span.spanId,
          "trace.trace_id": span.traceId,
        });
      },
      onFinally(span) {
        const metricAttributes = {
          "bosun.task.id": span.attributes["bosun.task.id"],
          "llm.model": span.attributes["llm.model"],
          "trace.span_id": span.spanId,
          "trace.trace_id": span.traceId,
        };
        recordMetric("taskDuration", "histogram", span.durationMs ?? 0, metricAttributes);
      },
    },
    remoteParent
      ? {
          parentSpan: remoteParent,
          parentContext: remoteParent.otelContext,
        }
      : {},
  );
}

export async function traceAgentSession(session = {}, fn) {
  return withSpan(
    "bosun.agent.session",
    {
      ...resolveSpanAttributes(session),
      "bosun.session.id": session.sessionId,
      "bosun.agent.sdk": session.sdk,
      "bosun.thread.key": session.threadKey,
      "bosun.session.start_time": session.startTime,
      "bosun.tokens.budget": session.tokensBudget,
    },
    fn,
    {
      onStart(span) {
        recordMetric("agentSessionsActive", "gauge", 1, {
          "bosun.session.id": span.attributes["bosun.session.id"],
          "trace.span_id": span.spanId,
          "trace.trace_id": span.traceId,
        });
      },
      onFinally(span) {
        recordMetric("agentSessionsActive", "gauge", -1, {
          "bosun.session.id": span.attributes["bosun.session.id"],
          "trace.span_id": span.spanId,
          "trace.trace_id": span.traceId,
        });
      },
    },
  );
}

export async function traceToolCall(tool = {}, fn) {
  return withSpan(
    "bosun.tool.call",
    {
      ...resolveSpanAttributes(tool),
      "bosun.tool.name": tool.toolName,
      "bosun.tool.tokens_used": tool.tokensUsed,
    },
    async (span) => {
      const startedAt = nowHrTime();
      const result = await fn(span);
      span.attributes["bosun.tool.success"] = result?.success ?? true;
      span.attributes["bosun.tool.duration_ms"] = durationMs(startedAt);
      if (result?.error) {
        span.attributes["bosun.tool.error"] = result.error;
      }
      return result;
    },
  );
}

export async function traceLLMCall(call = {}, fn) {
  return withSpan(
    "bosun.llm.call",
    {
      "llm.model": call.model,
      "llm.provider": call.provider,
      "llm.input_tokens": call.inputTokens,
      "llm.output_tokens": call.outputTokens,
      "llm.cost_usd": call.costUsd,
      "llm.latency_ms": call.latency,
    },
    async (span) => {
      const startedAt = nowHrTime();
      const result = await fn(span);
      const inputTokens = Number(result?.inputTokens ?? call.inputTokens ?? 0);
      const outputTokens = Number(result?.outputTokens ?? call.outputTokens ?? 0);
      const costUsd = Number(result?.costUsd ?? call.costUsd ?? 0);
      span.attributes["llm.input_tokens"] = inputTokens;
      span.attributes["llm.output_tokens"] = outputTokens;
      span.attributes["llm.cost_usd"] = costUsd;
      span.attributes["llm.latency_ms"] = Number(result?.latencyMs ?? result?.latency ?? call.latencyMs ?? call.latency ?? durationMs(startedAt));
      const totalTokens = inputTokens + outputTokens;
      const currentTaskId = call.taskId || span.attributes["bosun.task.id"];
      const metricAttributes = {
        "bosun.task.id": currentTaskId,
        "llm.model": call.model,
        "trace.span_id": span.spanId,
        "trace.trace_id": span.traceId,
      };
      if (totalTokens > 0) {
        recordMetric("taskTokensTotal", "counter", totalTokens, metricAttributes);
      }
      if (costUsd > 0) {
        recordMetric("taskCostUsd", "counter", costUsd, metricAttributes);
      }
      return result;
    },
  );
}

ensureMetricInstruments();


