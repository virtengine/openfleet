/**
 * runtime-accumulator.mjs — Persists runtime and completed session totals across restarts.
 *
 * Source of truth for completed-session lifetime stats is an append-only JSONL log written
 * synchronously on every terminal session completion. A compact snapshot file is also kept as a
 * best-effort cache for faster startup and legacy compatibility, but restart recovery never
 * depends on the snapshot being current.
 *
 * @module runtime-accumulator
 */

import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = resolve(__dirname, "..", ".cache");
const SNAPSHOT_FILE_NAME = "runtime-accumulator.json";
const SESSION_LOG_FILE_NAME = "session-accumulator.jsonl";
const MAX_SESSION_TOKENS = 100;
const DEFAULT_MAX_COMPLETED_SESSIONS = 50_000;
const MAX_COMPLETED_SESSIONS = (() => {
	const raw = process.env.RUNTIME_MAX_COMPLETED_SESSIONS;
	if (!raw) return DEFAULT_MAX_COMPLETED_SESSIONS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_COMPLETED_SESSIONS;
	// Hard cap to avoid unbounded memory use even if misconfigured.
	return Math.min(parsed, DEFAULT_MAX_COMPLETED_SESSIONS);
})();

let _cacheDir = DEFAULT_CACHE_DIR;
let _runtimeFile = resolve(_cacheDir, SNAPSHOT_FILE_NAME);
let _sessionLogFile = resolve(_cacheDir, SESSION_LOG_FILE_NAME);

const DEFAULT_STATE = {
	runtimeMs: 0,
	totalCostUsd: 0,
	sessionTokens: [],
	completedSessions: [],
	taskLifetimeTotals: {},
	lastUpdated: null,
	startedAt: null,
};

let _state = cloneDefaultState();
let _initialized = false;
let _lastSaveTime = 0;
let _saveHooksInstalled = false;
let _seenSessionKeys = new Set();

const SAVE_INTERVAL_MS = 5000;
const SESSION_ACCUMULATION_LISTENERS = new Set();

function cloneDefaultState() {
	return {
		...DEFAULT_STATE,
		sessionTokens: [],
		completedSessions: [],
		taskLifetimeTotals: {},
	};
}

function configureCachePaths(cacheDir = DEFAULT_CACHE_DIR) {
	_cacheDir = resolve(cacheDir || DEFAULT_CACHE_DIR);
	_runtimeFile = resolve(_cacheDir, SNAPSHOT_FILE_NAME);
	_sessionLogFile = resolve(_cacheDir, SESSION_LOG_FILE_NAME);
}

function ensureCacheDir() {
	try {
		mkdirSync(_cacheDir, { recursive: true });
	} catch {
		/* best effort */
	}
}

function toFiniteNumber(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeFileCounts(fileCounts = {}) {
	const counts = fileCounts && typeof fileCounts === "object" ? fileCounts : {};
	return {
		openedFiles: Math.max(0, toFiniteNumber(counts.openedFiles, 0)),
		editedFiles: Math.max(0, toFiniteNumber(counts.editedFiles, 0)),
		referencedFiles: Math.max(0, toFiniteNumber(counts.referencedFiles, 0)),
		openOps: Math.max(0, toFiniteNumber(counts.openOps, 0)),
		editOps: Math.max(0, toFiniteNumber(counts.editOps, 0)),
	};
}

function normalizeTopTools(topTools = [], limit = 6) {
	return (Array.isArray(topTools) ? topTools : [])
		.map((entry) => ({
			name: String(entry?.name || "").trim(),
			count: Math.max(0, toFiniteNumber(entry?.count, 0)),
		}))
		.filter((entry) => entry.name && entry.count > 0)
		.slice(0, limit);
}

function normalizeRecentActions(recentActions = [], limit = 8) {
	return (Array.isArray(recentActions) ? recentActions : [])
		.map((entry) => ({
			type: String(entry?.type || "").trim() || "event",
			label: String(entry?.label || "").trim(),
			level: String(entry?.level || "info").trim() || "info",
			timestamp: String(entry?.timestamp || "").trim() || null,
		}))
		.filter((entry) => entry.label)
		.slice(0, limit);
}

function normalizeContextWindow(contextWindow = {}, fallbackUsedTokens = 0) {
	const snapshot = contextWindow && typeof contextWindow === "object" ? contextWindow : {};
	const usedTokens = Math.max(
		0,
		toFiniteNumber(snapshot.usedTokens ?? fallbackUsedTokens, 0),
	);
	const totalTokens = (() => {
		const numeric = Number(snapshot.totalTokens);
		return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null;
	})();
	const percent = (() => {
		const numeric = Number(snapshot.percent);
		if (Number.isFinite(numeric)) return Math.max(0, Math.min(100, Number(numeric.toFixed(1))));
		if (usedTokens > 0 && totalTokens) {
			return Math.max(0, Math.min(100, Number(((usedTokens / totalTokens) * 100).toFixed(1))));
		}
		return null;
	})();
	return {
		usedTokens,
		totalTokens,
		percent,
	};
}

function getContextPressureLevel(percent) {
	if (!Number.isFinite(Number(percent))) return "unknown";
	const safePercent = Number(percent);
	if (safePercent >= 95) return "critical";
	if (safePercent >= 85) return "high";
	if (safePercent >= 70) return "medium";
	return "low";
}

function normalizeTerminalRuntimeState(state, { live = false } = {}) {
	const normalizedState = String(state || "").trim() || "unknown";
	if (live) return normalizedState;
	if (normalizedState === "implementation_done_commit_blocked") return "completed";
	return normalizedState;
}

function normalizeRuntimeHealth(runtimeHealth = {}, fallback = {}) {
	const source = runtimeHealth && typeof runtimeHealth === "object" ? runtimeHealth : {};
	const reasons = Array.isArray(source.reasons)
		? source.reasons.map((reason) => String(reason || "").trim()).filter(Boolean)
		: [];
	const live = Boolean(source.live ?? fallback.live ?? false);
	return {
		state: normalizeTerminalRuntimeState(source.state || fallback.state || "completed", { live }),
		severity: String(source.severity || fallback.severity || "info").trim() || "info",
		live,
		idleMs: Math.max(0, toFiniteNumber(source.idleMs ?? fallback.idleMs, 0)),
		contextPressure: String(source.contextPressure || fallback.contextPressure || "unknown").trim() || "unknown",
		contextUsagePercent: (() => {
			const numeric = Number(source.contextUsagePercent ?? fallback.contextUsagePercent);
			return Number.isFinite(numeric) ? Math.max(0, Math.min(100, Number(numeric.toFixed(1)))) : null;
		})(),
		toolCalls: Math.max(0, toFiniteNumber(source.toolCalls ?? fallback.toolCalls, 0)),
		toolResults: Math.max(0, toFiniteNumber(source.toolResults ?? fallback.toolResults, 0)),
		errors: Math.max(0, toFiniteNumber(source.errors ?? fallback.errors, 0)),
		hasEdits: Boolean(source.hasEdits ?? fallback.hasEdits ?? false),
		hasCommits: Boolean(source.hasCommits ?? fallback.hasCommits ?? false),
		reasons,
	};
}

function buildRuntimeAggregates(sessions = []) {
	const toolCounts = new Map();
	const statusBuckets = {};
	const severityBuckets = {};
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalTokens = 0;
	let totalTurns = 0;
	let toolCalls = 0;
	let toolResults = 0;
	let totalErrors = 0;
	let totalEdits = 0;
	let totalCommits = 0;
	let sessionsWithEdits = 0;
	let sessionsWithCommits = 0;
	let sessionsNearContextLimit = 0;
	let sessionsHighContextPressure = 0;
	let contextPercentTotal = 0;
	let contextPercentCount = 0;
	let maxContextUsagePercent = null;

	for (const session of Array.isArray(sessions) ? sessions : []) {
		const inputTokens = Math.max(0, toFiniteNumber(session?.inputTokens, 0));
		const outputTokens = Math.max(0, toFiniteNumber(session?.outputTokens, 0));
		const tokenCount = Math.max(
			0,
			toFiniteNumber(session?.tokenCount ?? session?.totalTokens, inputTokens + outputTokens),
		);
		const turnCount = Math.max(0, toFiniteNumber(session?.turnCount, 0));
		const healthState = String(session?.runtimeHealth?.state || session?.status || "completed").trim() || "completed";
		const severity = String(session?.runtimeHealth?.severity || "info").trim() || "info";
		const contextPercent = Number(session?.contextUsagePercent ?? session?.contextWindow?.percent);
		const hasEdits = Boolean(session?.hasEdits);
		const hasCommits = Boolean(session?.hasCommits);

		totalInputTokens += inputTokens;
		totalOutputTokens += outputTokens;
		totalTokens += tokenCount;
		totalTurns += turnCount;
		toolCalls += Math.max(0, toFiniteNumber(session?.toolCalls, 0));
		toolResults += Math.max(0, toFiniteNumber(session?.toolResults, 0));
		totalErrors += Math.max(0, toFiniteNumber(session?.errors, 0));
		totalEdits += Math.max(0, toFiniteNumber(session?.fileCounts?.editOps, 0));
		totalCommits += hasCommits ? 1 : 0;
		if (hasEdits) sessionsWithEdits += 1;
		if (hasCommits) sessionsWithCommits += 1;
		statusBuckets[healthState] = Math.max(0, toFiniteNumber(statusBuckets[healthState], 0)) + 1;
		severityBuckets[severity] = Math.max(0, toFiniteNumber(severityBuckets[severity], 0)) + 1;

		if (Number.isFinite(contextPercent)) {
			const safePercent = Math.max(0, Math.min(100, Number(contextPercent)));
			contextPercentTotal += safePercent;
			contextPercentCount += 1;
			maxContextUsagePercent = maxContextUsagePercent == null
				? safePercent
				: Math.max(maxContextUsagePercent, safePercent);
			if (safePercent >= 85) sessionsNearContextLimit += 1;
			if (safePercent >= 70) sessionsHighContextPressure += 1;
		}

		for (const tool of normalizeTopTools(session?.topTools, 8)) {
			toolCounts.set(tool.name, (toolCounts.get(tool.name) || 0) + tool.count);
		}
	}

	const sessionsHighPressure = sessionsHighContextPressure;

	return {
		totalInputTokens,
		totalOutputTokens,
		totalTokens,
		totalTurns,
		toolSummary: {
			toolCalls,
			toolResults,
			errors: totalErrors,
			editOps: totalEdits,
			commitOps: totalCommits,
			sessionsWithEdits,
			sessionsWithCommits,
			topTools: Array.from(toolCounts.entries())
				.map(([name, count]) => ({ name, count }))
				.sort((a, b) => b.count - a.count)
				.slice(0, 8),
		},
		healthBuckets: statusBuckets,
		severityBuckets,
		contextSummary: {
			sessionCount: Array.isArray(sessions) ? sessions.length : 0,
			maxUsagePercent: maxContextUsagePercent,
			avgUsagePercent: contextPercentCount > 0
				? Number((contextPercentTotal / contextPercentCount).toFixed(1))
				: null,
			sessionsNearLimit: sessionsNearContextLimit,
			sessionsHighPressure,
		},
	};
}

function syncGlobals() {
	globalThis.__bosun_runtimeMs = _state.runtimeMs;
	globalThis.__bosun_totalCostUsd = _state.totalCostUsd;
	globalThis.__bosun_sessionTokens = getSessionTokens;
}

function normalizeCompletedSession(session = {}) {
	const taskId = String(session.taskId || session.id || session.sessionId || "").trim();
	const endedAt = toFiniteNumber(session.endedAt, Date.now());
	const startedAt = toFiniteNumber(session.startedAt, endedAt);
	const terminalStatus = String(session.status || "completed").trim() || "completed";
	const inputTokens = toFiniteNumber(
		session.inputTokens ?? session.prompt_tokens ?? session.promptTokens ?? session.input_tokens,
		0,
	);
	const outputTokens = toFiniteNumber(
		session.outputTokens ?? session.completion_tokens ?? session.completionTokens ?? session.output_tokens,
		0,
	);
	const tokenCount = toFiniteNumber(
		session.tokenCount ?? session.totalTokens ?? session.total_tokens ?? session.tokens ?? (inputTokens + outputTokens),
		inputTokens + outputTokens,
	);
	const durationMs = Math.max(
		0,
		toFiniteNumber(session.durationMs, endedAt > startedAt ? endedAt - startedAt : 0),
	);
	const costUsd = Math.max(
		0,
		toFiniteNumber(session.costUsd ?? session.cost_usd ?? session.cost ?? session.total_cost ?? session.usd, 0),
	);
	const stableId = String(session.id || session.sessionId || `${taskId || "session"}:${startedAt}:${endedAt}`).trim();
	const sessionKey = String(
		session.sessionKey || `${taskId || "task"}:${stableId}:${startedAt}:${endedAt}`,
	).trim();
	const turnCount = Math.max(0, toFiniteNumber(session.turnCount, 0));
	const turns = Array.isArray(session.turns)
		? session.turns.map((turn) => ({ ...turn }))
		: [];
	const contextWindow = normalizeContextWindow(session.contextWindow, tokenCount);
	const contextUsagePercent = Number.isFinite(Number(session.contextUsagePercent))
		? Math.max(0, Math.min(100, Number(Number(session.contextUsagePercent).toFixed(1))))
		: contextWindow.percent;
	const contextPressure = String(
		session.contextPressure || getContextPressureLevel(contextUsagePercent),
	).trim() || getContextPressureLevel(contextUsagePercent);
	const runtimeHealth = normalizeRuntimeHealth(session.runtimeHealth, {
		state: terminalStatus,
		contextPressure,
		contextUsagePercent,
		toolCalls: session.toolCalls,
		toolResults: session.toolResults,
		errors: session.errors,
		hasEdits: session.hasEdits,
		hasCommits: session.hasCommits,
	});
	const canonicalTerminalState = normalizeTerminalRuntimeState(terminalStatus, { live: runtimeHealth.live });
	if (runtimeHealth.state !== canonicalTerminalState && runtimeHealth.live !== true) {
		runtimeHealth.state = canonicalTerminalState;
	}

	return {
		type: "completed_session",
		sessionKey,
		id: stableId,
		taskId,
		taskTitle: String(session.taskTitle || "").trim() || null,
		executor: String(session.executor || "").trim() || null,
		model: String(session.model || "").trim() || null,
		startedAt,
		endedAt,
		durationMs,
		status: terminalStatus,
		tokenCount,
		inputTokens,
		outputTokens,
		turnCount,
		turns,
		costUsd,
		totalEvents: Math.max(0, toFiniteNumber(session.totalEvents, 0)),
		lastEventType: String(session.lastEventType || "").trim() || null,
		hasEdits: Boolean(session.hasEdits),
		hasCommits: Boolean(session.hasCommits),
		toolCalls: Math.max(0, toFiniteNumber(session.toolCalls, 0)),
		toolResults: Math.max(0, toFiniteNumber(session.toolResults, 0)),
		errors: Math.max(0, toFiniteNumber(session.errors, 0)),
		commandExecutions: Math.max(0, toFiniteNumber(session.commandExecutions, 0)),
		fileCounts: normalizeFileCounts(session.fileCounts),
		topTools: normalizeTopTools(session.topTools, 6),
		recentActions: normalizeRecentActions(session.recentActions, 8),
		contextWindow,
		contextUsagePercent,
		contextPressure,
		lastToolName: String(session.lastToolName || "").trim() || null,
		runtimeHealth,
		recordedAt: String(session.recordedAt || new Date().toISOString()),
	};
}

function buildSessionDedupKey(record) {
	return String(record?.sessionKey || "").trim();
}

function cloneLifetimeTotals(totals) {
	if (!totals) return null;
	return { ...totals };
}

function applyCompletedSessionRecord(record) {
	if (!record?.taskId) return null;
	const dedupKey = buildSessionDedupKey(record);
	if (!dedupKey || _seenSessionKeys.has(dedupKey)) {
		return record.taskId ? cloneLifetimeTotals(_state.taskLifetimeTotals[record.taskId]) : null;
	}
	_seenSessionKeys.add(dedupKey);

	_state.completedSessions.push({ ...record });
	if (_state.completedSessions.length > MAX_COMPLETED_SESSIONS) {
		_state.completedSessions = _state.completedSessions.slice(-MAX_COMPLETED_SESSIONS);
	}

	_state.sessionTokens.push({
		id: record.id,
		expiresAt: Date.now() + 24 * 60 * 60 * 1000,
	});
	if (_state.sessionTokens.length > MAX_SESSION_TOKENS) {
		_state.sessionTokens = _state.sessionTokens.slice(-MAX_SESSION_TOKENS);
	}

	const currentTotals = _state.taskLifetimeTotals[record.taskId] || {
		taskId: record.taskId,
		taskTitle: record.taskTitle,
		attemptsCount: 0,
		tokenCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		durationMs: 0,
		lastSessionId: null,
		lastSessionEndedAt: null,
		lastStatus: null,
		updatedAt: null,
	};

	const nextTotals = {
		...currentTotals,
		taskId: record.taskId,
		taskTitle: record.taskTitle || currentTotals.taskTitle || null,
		attemptsCount: currentTotals.attemptsCount + 1,
		tokenCount: currentTotals.tokenCount + record.tokenCount,
		inputTokens: currentTotals.inputTokens + record.inputTokens,
		outputTokens: currentTotals.outputTokens + record.outputTokens,
		durationMs: currentTotals.durationMs + record.durationMs,
		lastSessionId: record.id,
		lastSessionEndedAt: record.endedAt,
		lastStatus: record.status,
		updatedAt: record.recordedAt,
	};
	_state.taskLifetimeTotals[record.taskId] = nextTotals;

	_state.runtimeMs += record.durationMs;
	_state.totalCostUsd += record.costUsd;
	_state.lastUpdated = record.recordedAt;
	syncGlobals();
	return cloneLifetimeTotals(nextTotals);
}

function loadLegacySnapshot() {
	if (!existsSync(_runtimeFile)) return;
	try {
		const raw = readFileSync(_runtimeFile, "utf8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return;

		_state.startedAt = parsed.startedAt || _state.startedAt;
		_state.lastUpdated = parsed.lastUpdated || _state.lastUpdated;
		_state.sessionTokens = Array.isArray(parsed.sessionTokens) ? parsed.sessionTokens : [];

		const completedSessions = Array.isArray(parsed.completedSessions)
			? parsed.completedSessions
			: Array.isArray(parsed.sessions)
				? parsed.sessions
				: [];
		for (const session of completedSessions) {
			applyCompletedSessionRecord(normalizeCompletedSession(session));
		}

		if (parsed.taskLifetimeTotals && typeof parsed.taskLifetimeTotals === "object") {
			for (const [taskId, totals] of Object.entries(parsed.taskLifetimeTotals)) {
				if (!_state.taskLifetimeTotals[taskId]) {
					_state.taskLifetimeTotals[taskId] = { ...totals };
				}
			}
		}
	} catch (err) {
		console.warn(`[runtime-accumulator] failed to load snapshot: ${err.message}`);
	}
}

function loadSessionLog() {
	if (!existsSync(_sessionLogFile)) return;
	try {
		const raw = readFileSync(_sessionLogFile, "utf8");
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed);
				if (!parsed || typeof parsed !== "object") continue;
				applyCompletedSessionRecord(normalizeCompletedSession(parsed));
			} catch {
				// Ignore malformed lines to preserve append-only recovery.
			}
		}
	} catch (err) {
		console.warn(`[runtime-accumulator] failed to load session log: ${err.message}`);
	}
}

function loadState() {
	if (_initialized) return;
	_initialized = true;
	ensureCacheDir();
	loadLegacySnapshot();
	loadSessionLog();
	_state.startedAt = _state.startedAt || Date.now();
	syncGlobals();
}

function saveState(force = false) {
	const now = Date.now();
	if (!force && now - _lastSaveTime < SAVE_INTERVAL_MS) return;
	_lastSaveTime = now;

	try {
		ensureCacheDir();
		const payload = {
			runtimeMs: _state.runtimeMs,
			totalCostUsd: _state.totalCostUsd,
			sessionTokens: _state.sessionTokens.slice(-MAX_SESSION_TOKENS),
			completedSessions: _state.completedSessions.slice(-MAX_COMPLETED_SESSIONS),
			taskLifetimeTotals: _state.taskLifetimeTotals,
			lastUpdated: _state.lastUpdated,
			startedAt: _state.startedAt,
		};
		writeFileSync(_runtimeFile, JSON.stringify(payload, null, 2), "utf8");
	} catch (err) {
		console.warn(`[runtime-accumulator] failed to save state: ${err.message}`);
	}
}

function appendCompletedSessionRecord(record) {
	ensureCacheDir();
	const fd = openSync(_sessionLogFile, "a");
	try {
		const line = `${JSON.stringify(record)}\n`;
		writeSync(fd, line, undefined, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function emitSessionAccumulated(taskId, session, totals) {
	if (!taskId || SESSION_ACCUMULATION_LISTENERS.size === 0) return;
	const payload = {
		type: "session-accumulated",
		taskId,
		session: { ...session },
		totals: cloneLifetimeTotals(totals),
		ts: Date.now(),
	};
	for (const listener of SESSION_ACCUMULATION_LISTENERS) {
		try {
			listener(payload);
		} catch {
			/* best effort */
		}
	}
}

export function addSessionAccumulationListener(listener) {
	if (typeof listener !== "function") return () => {};
	SESSION_ACCUMULATION_LISTENERS.add(listener);
	return () => SESSION_ACCUMULATION_LISTENERS.delete(listener);
}

export function initRuntimeAccumulator() {
	loadState();
	_state.startedAt = Date.now();
	syncGlobals();

	if (!_saveHooksInstalled) {
		_saveHooksInstalled = true;
		setInterval(() => saveState(false), SAVE_INTERVAL_MS).unref?.();
		process.on("exit", () => saveState(true));
		process.on("SIGINT", () => saveState(true));
		process.on("SIGTERM", () => saveState(true));
	}

	return {
		runtimeMs: _state.runtimeMs,
		totalCostUsd: _state.totalCostUsd,
		startedAt: _state.startedAt,
	};
}

export function getRuntimeStats() {
	loadState();
	const completedSessions = _state.completedSessions.map((entry) => ({ ...entry }));
	const aggregates = buildRuntimeAggregates(completedSessions);
	return {
		runtimeMs: _state.runtimeMs,
		totalCostUsd: _state.totalCostUsd,
		sessionCount: completedSessions.length,
		completedSessions,
		sessions: completedSessions,
		startedAt: _state.startedAt,
		lastUpdated: _state.lastUpdated,
		totalInputTokens: aggregates.totalInputTokens,
		totalOutputTokens: aggregates.totalOutputTokens,
		totalTokens: aggregates.totalTokens,
		totalTurns: aggregates.totalTurns,
		toolSummary: aggregates.toolSummary,
		healthBuckets: aggregates.healthBuckets,
		severityBuckets: aggregates.severityBuckets,
		contextSummary: aggregates.contextSummary,
	};
}

export function addRuntime(ms) {
	loadState();
	_state.runtimeMs += Math.max(0, toFiniteNumber(ms, 0));
	_state.lastUpdated = new Date().toISOString();
	syncGlobals();
	saveState(false);
}

export function addCost(usd) {
	loadState();
	_state.totalCostUsd += Math.max(0, toFiniteNumber(usd, 0));
	_state.lastUpdated = new Date().toISOString();
	syncGlobals();
	saveState(false);
}

export function addCompletedSession(session) {
	loadState();
	const record = normalizeCompletedSession(session);
	if (!record.taskId) return record;
	const dedupKey = buildSessionDedupKey(record);
	if (dedupKey && _seenSessionKeys.has(dedupKey)) {
		return record;
	}

	appendCompletedSessionRecord(record);
	const totals = applyCompletedSessionRecord(record);
	saveState(true);
	emitSessionAccumulated(record.taskId, record, totals);
	return record;
}

export function getSessionTokens() {
	loadState();
	const now = Date.now();
	return _state.sessionTokens
		.filter((token) => toFiniteNumber(token?.expiresAt, 0) > now)
		.map((token) => token.id);
}

export function getCompletedSessions(limit = 100) {
	loadState();
	return _state.completedSessions
		.slice(-Math.max(0, Number(limit) || 0))
		.map((entry) => ({ ...entry }));
}

export function getTaskLifetimeTotals(taskId) {
	loadState();
	const normalizedTaskId = String(taskId || "").trim();
	if (!normalizedTaskId) return null;
	const totals = _state.taskLifetimeTotals[normalizedTaskId];
	if (!totals) {
		return {
			taskId: normalizedTaskId,
			taskTitle: null,
			attemptsCount: 0,
			tokenCount: 0,
			inputTokens: 0,
			outputTokens: 0,
			durationMs: 0,
			lastSessionId: null,
			lastSessionEndedAt: null,
			lastStatus: null,
			updatedAt: null,
		};
	}
	return cloneLifetimeTotals(totals);
}

export function withTaskLifetimeTotals(task) {
	if (!task || typeof task !== "object") return task;
	const taskId = String(task.id || task.taskId || "").trim();
	if (!taskId) return task;
	const lifetimeTotals = getTaskLifetimeTotals(taskId);
	return {
		...task,
		lifetimeTotals,
		meta: {
			...(task.meta || {}),
			lifetimeTotals,
		},
	};
}

export function clearCompletedSessions() {
	loadState();
	_state = cloneDefaultState();
	_seenSessionKeys = new Set();
	try {
		unlinkSync(_sessionLogFile);
	} catch {
		/* best effort */
	}
	syncGlobals();
	saveState(true);
}

export function exportRuntimeData() {
	loadState();
	const sessions = _state.completedSessions.map((entry) => ({ ...entry }));
	const aggregates = buildRuntimeAggregates(sessions);
	return {
		runtimeMs: _state.runtimeMs,
		totalCostUsd: _state.totalCostUsd,
		sessionCount: sessions.length,
		startedAt: _state.startedAt,
		lastUpdated: _state.lastUpdated,
		taskLifetimeTotals: { ..._state.taskLifetimeTotals },
		sessions,
		totalInputTokens: aggregates.totalInputTokens,
		totalOutputTokens: aggregates.totalOutputTokens,
		totalTokens: aggregates.totalTokens,
		totalTurns: aggregates.totalTurns,
		toolSummary: aggregates.toolSummary,
		healthBuckets: aggregates.healthBuckets,
		severityBuckets: aggregates.severityBuckets,
		contextSummary: aggregates.contextSummary,
	};
}

export function importRuntimeData(data) {
	if (!data || typeof data !== "object") return false;
	loadState();
	if (Array.isArray(data.sessions)) {
		for (const session of data.sessions) {
			addCompletedSession(session);
		}
	}
	if (typeof data.runtimeMs === "number") {
		_state.runtimeMs = Math.max(_state.runtimeMs, data.runtimeMs);
	}
	if (typeof data.totalCostUsd === "number") {
		_state.totalCostUsd = Math.max(_state.totalCostUsd, data.totalCostUsd);
	}
	syncGlobals();
	saveState(true);
	return true;
}

export function getSessionAccumulatorLogPath() {
	return _sessionLogFile;
}

export function _resetRuntimeAccumulatorForTests(options = {}) {
	// When no explicit cacheDir is given, prefer the test-sandbox dir set by
	// bootstrapTestRuntime() so that bare reset calls (e.g. in finally blocks)
	// never redirect writes back to the real workspace .cache folder.
	const fallback = process.env.BOSUN_TEST_CACHE_DIR || DEFAULT_CACHE_DIR;
	configureCachePaths(options.cacheDir || fallback);
	_state = cloneDefaultState();
	_initialized = false;
	_lastSaveTime = 0;
	_seenSessionKeys = new Set();
	syncGlobals();
}
