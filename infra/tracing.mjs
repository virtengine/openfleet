/**
 * OpenTelemetry Tracing for Bosun Agent Observability
 *
 * Provides industry-standard tracing for:
 * - Agent sessions
 * - Workflow executions
 * - Task lifecycle
 * - Tool calls
 *
 * @module tracing
 */

import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACE_DIR = resolve(__dirname, "..", ".cache", "traces");

const DEFAULT_CONFIG = {
	enabled: process.env.OTEL_ENABLED === "true",
	serviceName: process.env.OTEL_SERVICE_NAME || "bosun",
	exporter: process.env.OTEL_EXPORTER || "console",
	endpoint: process.env.OTEL_EXPORTER_ENDPOINT || "http://localhost:4318/v1/traces",
	traceRatio: parseFloat(process.env.OTEL_TRACE_RATIO) || 1.0,
	consoleExport: process.env.OTEL_CONSOLE_EXPORT === "true",
	fileExport: process.env.OTEL_FILE_EXPORT === "true",
	filePath: process.env.OTEL_FILE_PATH || resolve(TRACE_DIR, "traces.jsonl"),
};

let _config = { ...DEFAULT_CONFIG };
let _tracer = null;
let _spans = new Map();
let _spanIdCounter = 0;

function generateSpanId() {
	return `span-${++_spanIdCounter}-${Date.now()}`;
}

function generateTraceId() {
	return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 15)}`;
}

function initTracing(config = {}) {
	_config = { ..._config, ...config };

	if (!_config.enabled) {
		console.log("[tracing] OpenTelemetry tracing disabled");
		return null;
	}

	try {
		mkdirSync(TRACE_DIR, { recursive: true });
	} catch { /* best effort */ }

	console.log(`[tracing] Initialized with exporter: ${_config.exporter}`);
	_tracer = {
		serviceName: _config.serviceName,
		startTime: Date.now(),
		spans: _spans,
	};

	return _tracer;
}

function shouldTrace() {
	if (!_config.enabled) return false;
	return Math.random() < _config.traceRatio;
}

function startSpan(name, attributes = {}, parentSpanId = null) {
	if (!shouldTrace()) return null;

	const span = {
		name,
		traceId: generateTraceId(),
		spanId: generateSpanId(),
		parentSpanId,
		attributes: { ...attributes },
		startTime: Date.now(),
		endTime: null,
		status: "ok",
		events: [],
	};

	_spans.set(span.spanId, span);
	return span;
}

function endSpan(spanId, status = "ok", error = null) {
	const span = _spans.get(spanId);
	if (!span) return;

	span.endTime = Date.now();
	span.durationMs = span.endTime - span.startTime;
	span.status = status;

	if (error) {
		span.status = "error";
		span.attributes.error = true;
		span.attributes["error.message"] = error.message || String(error);
		span.attributes["error.stack"] = error.stack || "";
	}

	exportSpan(span);
	return span;
}

function addSpanEvent(spanId, name, attributes = {}) {
	const span = _spans.get(spanId);
	if (!span) return;

	span.events.push({
		name,
		time: Date.now(),
		attributes,
	});
}

function setSpanAttribute(spanId, key, value) {
	const span = _spans.get(spanId);
	if (!span) return;

	span.attributes[key] = value;
}

function exportSpan(span) {
	if (_config.consoleExport || _config.exporter === "console") {
		console.log(
			`[tracing] ${span.name} ${span.spanId.slice(0, 8)} ${span.durationMs}ms [${span.status}]`,
		);
	}

	if (_config.fileExport || _config.exporter === "file") {
		try {
			const line = JSON.stringify({
				name: span.name,
				traceId: span.traceId,
				spanId: span.spanId,
				parentSpanId: span.parentSpanId,
				startTime: new Date(span.startTime).toISOString(),
				endTime: new Date(span.endTime).toISOString(),
				durationMs: span.durationMs,
				status: span.status,
				attributes: span.attributes,
				events: span.events,
			});
			appendFileSync(_config.filePath, line + "\n", "utf8");
		} catch { /* best effort */ }
	}

	if (_config.exporter === "otlp" || _config.exporter === "http") {
		exportToOtlp(span);
	}
}

async function exportToOtlp(span) {
	try {
		const payload = {
			resourceSpans: [{
				resource: {
					attributes: [
						{ key: "service.name", value: { stringValue: _config.serviceName } },
					],
				},
				scopeSpans: [{
					spans: [{
						name: span.name,
						traceId: span.traceId,
						spanId: span.spanId,
						parentSpanId: span.parentSpanId || undefined,
						startTimeUnixNano: span.startTime * 1_000_000,
						endTimeUnixNano: span.endTime * 1_000_000,
						status: { code: span.status === "error" ? 2 : 1 },
						attributes: Object.entries(span.attributes).map(([key, value]) => ({
							key,
							value: { stringValue: String(value) },
						})),
					}],
				}],
			}],
		};

		await fetch(_config.endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		}).catch(() => {});
	} catch { /* best effort */ }
}

function getActiveSpans() {
	return Array.from(_spans.values()).filter((s) => !s.endTime);
}

function getSpan(spanId) {
	return _spans.get(spanId);
}

function clearSpans() {
	_spans.clear();
}

function flush() {
	for (const span of _spans.values()) {
		if (!span.endTime) {
			endSpan(span.spanId, "ok");
		}
	}
}

function getTracer() {
	return _tracer;
}

function wrapFunction(fn, name, attributes = {}) {
	return function (...args) {
		const span = startSpan(name, attributes);
		try {
			const result = fn.apply(this, args);
			if (result && typeof result.then === "function") {
				return result
					.then((res) => {
						endSpan(span?.spanId, "ok");
						return res;
					})
					.catch((err) => {
						endSpan(span?.spanId, "error", err);
						throw err;
					});
			}
			endSpan(span?.spanId, "ok");
			return result;
		} catch (err) {
			endSpan(span?.spanId, "error", err);
			throw err;
		}
	};
}

async function wrapAsyncFunction(fn, name, attributes = {}) {
	return async function (...args) {
		const span = startSpan(name, attributes);
		try {
			const result = await fn.apply(this, args);
			endSpan(span?.spanId, "ok");
			return result;
		} catch (err) {
			endSpan(span?.spanId, "error", err);
			throw err;
		}
	};
}

function createAgentSpan(agentId, sessionId, type = "agent") {
	return startSpan(`agent.${type}`, {
		"agent.id": agentId,
		"session.id": sessionId,
		"agent.type": type,
	});
}

function createWorkflowSpan(workflowId, runId) {
	return startSpan(`workflow.${workflowId}`, {
		"workflow.id": workflowId,
		"workflow.run.id": runId,
	});
}

function createTaskSpan(taskId, taskTitle) {
	return startSpan(`task.${taskId}`, {
		"task.id": taskId,
		"task.title": taskTitle,
	});
}

export {
	initTracing,
	startSpan,
	endSpan,
	addSpanEvent,
	setSpanAttribute,
	getActiveSpans,
	getSpan,
	clearSpans,
	flush,
	getTracer,
	wrapFunction,
	wrapAsyncFunction,
	createAgentSpan,
	createWorkflowSpan,
	createTaskSpan,
};
