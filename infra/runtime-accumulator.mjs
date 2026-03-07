/**
 * runtime-accumulator.mjs — Persists runtime and session tokens across restarts
 *
 * Tracks:
 * - Total runtime milliseconds across all monitor restarts
 * - Completed session tokens for continuity
 * - Total cost in USD
 * - Session history
 *
 * @module runtime-accumulator
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = resolve(__dirname, "..", ".cache");
const RUNTIME_FILE = resolve(CACHE_DIR, "runtime-accumulator.json");

const DEFAULT_STATE = {
	runtimeMs: 0,
	totalCostUsd: 0,
	sessionTokens: [],
	completedSessions: [],
	lastUpdated: null,
	startedAt: null,
};

let _state = { ...DEFAULT_STATE };
let _initialized = false;
let _lastSaveTime = 0;
const SAVE_INTERVAL_MS = 5000;

function loadState() {
	if (_initialized) return;
	_initialized = true;

	try {
		mkdirSync(CACHE_DIR, { recursive: true });
	} catch { /* best effort */ }

	try {
		if (existsSync(RUNTIME_FILE)) {
			const raw = readFileSync(RUNTIME_FILE, "utf8");
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object") {
				_state = {
					...DEFAULT_STATE,
					...parsed,
					sessionTokens: Array.isArray(parsed.sessionTokens) ? parsed.sessionTokens : [],
					completedSessions: Array.isArray(parsed.completedSessions) ? parsed.completedSessions : [],
				};
			}
		}
	} catch (err) {
		console.warn(`[runtime-accumulator] failed to load state: ${err.message}`);
	}

	_state.startedAt = _state.startedAt || Date.now();
}

function saveState() {
	const now = Date.now();
	if (now - _lastSaveTime < SAVE_INTERVAL_MS) return;
	_lastSaveTime = now;

	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		const payload = {
			runtimeMs: _state.runtimeMs,
			totalCostUsd: _state.totalCostUsd,
			sessionTokens: _state.sessionTokens.slice(-100),
			completedSessions: _state.completedSessions.slice(-500),
			lastUpdated: new Date().toISOString(),
			startedAt: _state.startedAt,
		};
		writeFileSync(RUNTIME_FILE, JSON.stringify(payload, null, 2), "utf8");
	} catch (err) {
		console.warn(`[runtime-accumulator] failed to save state: ${err.message}`);
	}
}

export function initRuntimeAccumulator() {
	loadState();
	_state.startedAt = Date.now();

	setInterval(saveState, SAVE_INTERVAL_MS);
	process.on("exit", saveState);
	process.on("SIGINT", saveState);
	process.on("SIGTERM", saveState);

	return {
		runtimeMs: _state.runtimeMs,
		totalCostUsd: _state.totalCostUsd,
		startedAt: _state.startedAt,
	};
}

export function getRuntimeStats() {
	loadState();
	return {
		runtimeMs: _state.runtimeMs,
		totalCostUsd: _state.totalCostUsd,
		sessionCount: _state.completedSessions.length,
		startedAt: _state.startedAt,
	};
}

export function addRuntime(ms) {
	loadState();
	_state.runtimeMs += Number(ms) || 0;
	saveState();
}

export function addCost(usd) {
	loadState();
	_state.totalCostUsd += Number(usd) || 0;
	saveState();
}

export function addCompletedSession(session) {
	loadState();
	const token = {
		id: session.id || session.sessionId,
		taskId: session.taskId,
		taskTitle: session.taskTitle,
		executor: session.executor,
		model: session.model,
		startedAt: session.startedAt,
		endedAt: session.endedAt || Date.now(),
		durationMs: session.durationMs || (session.endedAt ? session.endedAt - session.startedAt : 0),
		costUsd: session.costUsd || 0,
		status: session.status || "completed",
	};
	_state.completedSessions.push(token);

	if (token.costUsd) {
		_state.totalCostUsd += token.costUsd;
	}
	if (token.durationMs) {
		_state.runtimeMs += token.durationMs;
	}

	_state.sessionTokens.push({
		id: token.id,
		expiresAt: Date.now() + 24 * 60 * 60 * 1000,
	});

	saveState();
	return token;
}

export function getSessionTokens() {
	loadState();
	const now = Date.now();
	return _state.sessionTokens
		.filter((t) => t.expiresAt > now)
		.map((t) => t.id);
}

export function getCompletedSessions(limit = 100) {
	loadState();
	return _state.completedSessions.slice(-limit);
}

export function clearCompletedSessions() {
	loadState();
	_state.completedSessions = [];
	_state.sessionTokens = [];
	saveState();
}

export function exportRuntimeData() {
	loadState();
	return {
		runtimeMs: _state.runtimeMs,
		totalCostUsd: _state.totalCostUsd,
		sessionCount: _state.completedSessions.length,
		startedAt: _state.startedAt,
		lastUpdated: _state.lastUpdated,
		sessions: _state.completedSessions,
	};
}

export function importRuntimeData(data) {
	if (!data || typeof data !== "object") return false;

	loadState();

	if (typeof data.runtimeMs === "number") {
		_state.runtimeMs = Math.max(_state.runtimeMs, data.runtimeMs);
	}
	if (typeof data.totalCostUsd === "number") {
		_state.totalCostUsd = Math.max(_state.totalCostUsd, data.totalCostUsd);
	}
	if (Array.isArray(data.sessions)) {
		for (const session of data.sessions) {
			_state.completedSessions.push(session);
		}
		_state.completedSessions = _state.completedSessions.slice(-500);
	}

	saveState();
	return true;
}
