/**
 * WebSocket Bridge for TUI
 *
 * Connects to the Bosun UI server's WebSocket endpoint to receive
 * real-time stats, session events, and task updates.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import WebSocket from "ws";

function resolveBosunConfigDir() {
	if (process.env.BOSUN_CONFIG_PATH) {
		return dirname(resolve(process.env.BOSUN_CONFIG_PATH));
	}

	const candidates = [
		process.env.BOSUN_HOME,
		process.env.BOSUN_DIR,
		resolve(process.cwd(), ".bosun"),
		resolve(process.cwd()),
		resolve(homedir(), ".bosun"),
	];

	for (const candidate of candidates) {
		if (!candidate) continue;
		const normalized = resolve(String(candidate));
		if (existsSync(normalized)) {
			return normalized;
		}
	}

	return resolve(homedir(), ".bosun");
}

function readUiAuthToken() {
	const envToken = String(
		process.env.BOSUN_UI_TOKEN || process.env.BOSUN_UI_SESSION_TOKEN || "",
	).trim();
	if (envToken) return envToken;

	const configDir = resolveBosunConfigDir();
	const tokenFiles = [
		resolve(configDir, ".cache", "ui-token"),
		resolve(configDir, ".cache", "ui-session-token.json"),
	];

	for (const filePath of tokenFiles) {
		if (!existsSync(filePath)) continue;
		try {
			const raw = readFileSync(filePath, "utf8").trim();
			if (!raw) continue;
			if (filePath.endsWith(".json")) {
				const parsed = JSON.parse(raw);
				const token = String(parsed?.token || "").trim();
				if (token) return token;
				continue;
			}
			return raw;
		} catch {
			// best effort
		}
	}

	return "";
}

function adaptMonitorStats(payload = {}) {
	return {
		...payload,
		runtimeMs: payload.uptimeMs ?? 0,
		activeSessions: payload.activeAgents ?? 0,
		agents: {
			online: payload.activeAgents ?? 0,
			total: payload.maxAgents ?? 0,
		},
	};
}

function applyTaskDiff(tasks = [], diff = {}) {
	if (!Array.isArray(tasks)) return [];
	const next = [...tasks];
	const taskId = diff?.taskId == null ? "" : String(diff.taskId).trim();
	const task = diff?.task && typeof diff.task === "object" ? diff.task : null;
	const index = taskId
		? next.findIndex((entry) => String(entry?.id || entry?.taskId || "") === taskId)
		: -1;
	const reason = String(diff?.reason || "updated").trim().toLowerCase();

	if (task) {
		if (index >= 0) next[index] = { ...next[index], ...task };
		else next.push(task);
		return next;
	}

	if (index >= 0 && (reason.includes("delete") || reason.includes("remove"))) {
		next.splice(index, 1);
	}

	return next;
}

class TuiWsBridge {
	constructor({ host, port, token }) {
		this.host = host;
		this.port = port;
		this.token = String(token || readUiAuthToken()).trim();
		this.ws = null;
		this.listeners = new Map();
		this.reconnectAttempts = 0;
		this.maxReconnectAttempts = 10;
		this.reconnectDelay = 1000;
		this.reconnectTimer = null;
		this._connected = false;
		this._tasks = [];
		const query = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
		this._url = `ws://${host}:${port}/ws${query}`;
	}

	connect() {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			return;
		}

		try {
			this.ws = new WebSocket(this._url);

			this.ws.onopen = () => {
				this._connected = true;
				this.reconnectAttempts = 0;
				this.send("subscribe", {
					channels: ["tui", "stats", "sessions", "tasks", "workflows", "logs"],
				});
				this._emit("connect", {});
				console.log("[ws-bridge] Connected to UI server");
			};

			this.ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					this._handleMessage(data);
				} catch (err) {
					console.warn("[ws-bridge] Failed to parse message:", err.message);
				}
			};

			this.ws.onclose = () => {
				this._connected = false;
				this._emit("disconnect", {});
				console.log("[ws-bridge] Disconnected from UI server");
				this._scheduleReconnect();
			};

			this.ws.onerror = (err) => {
				console.error("[ws-bridge] WebSocket error:", err.message);
				this._emit("error", { message: err.message || "WebSocket error" });
			};
		} catch (err) {
			console.error("[ws-bridge] Failed to connect:", err.message);
			this._scheduleReconnect();
		}
	}

	disconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		this._connected = false;
	}

	_scheduleReconnect() {
		if (this.reconnectAttempts >= this.maxReconnectAttempts) {
			this._emit("error", { message: "Max reconnection attempts reached" });
			return;
		}

		const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
		this.reconnectAttempts++;

		this.reconnectTimer = setTimeout(() => {
			console.log(`[ws-bridge] Reconnecting (attempt ${this.reconnectAttempts})...`);
			this.connect();
		}, delay);
	}

	_handleMessage(data) {
		const { type, payload } = data;

		switch (type) {
			case "monitor:stats":
				this._emit("monitor:stats", payload);
				this._emit("stats", adaptMonitorStats(payload));
				break;
			case "sessions:update":
				this._emit("sessions:update", Array.isArray(payload) ? payload : []);
				break;
			case "stats":
				this._emit("stats", payload);
				break;
			case "session:start":
				this._emit("session:start", payload);
				break;
			case "session:update":
				this._emit("session:update", payload);
				break;
			case "session:end":
				this._emit("session:end", payload);
				break;
			case "session:event":
				this._emit("session:event", payload);
				break;
			case "tasks:update":
				this._tasks = applyTaskDiff(this._tasks, payload);
				this._emit("tasks:update", payload);
				this._emit("tasks:snapshot", [...this._tasks]);
				if (payload?.task) {
					this._emit("task:update", payload.task);
				} else if (payload?.taskId && /delete|remove/i.test(String(payload?.reason || ""))) {
					this._emit("task:delete", payload.taskId);
				}
				break;
			case "workflow:status":
				this._emit("workflow:status", payload);
				break;
			case "logs:stream":
				this._emit("logs:stream", payload);
				break;
			case "task:create":
				this._emit("task:create", payload);
				break;
			case "task:update":
				this._emit("task:update", payload);
				break;
			case "task:delete":
				this._emit("task:delete", payload);
				break;
			case "retry:update":
				this._emit("retry:update", payload);
				break;
			case "workflow:trigger":
				this._emit("workflow:trigger", payload);
				break;
			case "workflow:complete":
				this._emit("workflow:complete", payload);
				break;
			case "pong":
			case "hello":
			case "subscribed":
				break;
			default:
				this._emit(type, payload);
		}
	}

	send(type, payload = {}) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			const message = typeof payload === "object" && payload !== null
				? { type, ...payload }
				: { type, payload };
			this.ws.send(JSON.stringify(message));
		}
	}

	on(event, callback) {
		if (!this.listeners.has(event)) {
			this.listeners.set(event, new Set());
		}
		this.listeners.get(event).add(callback);
		return () => this.off(event, callback);
	}

	off(event, callback) {
		if (this.listeners.has(event)) {
			this.listeners.get(event).delete(callback);
		}
	}

	_emit(event, data) {
		if (this.listeners.has(event)) {
			for (const callback of this.listeners.get(event)) {
				callback(data);
			}
		}
	}

	get isConnected() {
		return this._connected;
	}
}

let _instance = null;
let _lastHost = null;
let _lastPort = null;

function createWsBridge({ host, port, token }) {
	_instance = new TuiWsBridge({ host, port, token });
	_lastHost = host;
	_lastPort = port;
	return _instance;
}

function wsBridge({ host, port, token }) {
	if (_instance && (host !== _lastHost || port !== _lastPort)) {
		_instance.disconnect();
		return createWsBridge({ host, port, token });
	}
	if (!_instance) {
		return createWsBridge({ host, port, token });
	}
	return _instance;
}

wsBridge._instance = null;

export default wsBridge;
export { TuiWsBridge, createWsBridge };