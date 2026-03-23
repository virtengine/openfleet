import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveTuiAuthToken as resolveSharedTuiAuthToken } from "../../infra/tui-bridge.mjs";

function defaultConfigDir() {
	const explicit = String(
		process.env.BOSUN_DIR
			|| process.env.BOSUN_HOME
			|| "",
	).trim();
	if (explicit) return resolve(explicit);
	return resolve(process.cwd(), ".bosun");
}

function normalizeProtocol(protocol) {
	const value = String(protocol || "").trim().toLowerCase();
	return value === "wss" ? "wss" : "ws";
}

function readUiInstanceLock(configDir = defaultConfigDir()) {
	try {
		const lockPath = resolve(configDir, ".cache", "ui-server.instance.lock.json");
		if (!existsSync(lockPath)) return null;
		const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
		if (!parsed || typeof parsed !== "object") return null;
		return parsed;
	} catch {
		return null;
	}
}

function resolveWebSocketProtocol({ protocol, configDir } = {}) {
	const explicit = String(protocol || "").trim().toLowerCase();
	if (explicit === "ws" || explicit === "wss") {
		return explicit;
	}
	const instance = readUiInstanceLock(configDir);
	return String(instance?.protocol || "").trim().toLowerCase() === "https" ? "wss" : "ws";
}

function resolveTuiAuthToken(options = {}) {
	return resolveSharedTuiAuthToken({
		env: options.env || process.env,
		configDir: options.configDir || (options.cwd ? resolve(options.cwd, ".bosun") : defaultConfigDir()),
		cacheDir: options.cacheDir || (options.cwd ? resolve(options.cwd, ".bosun", ".cache") : undefined),
	});
}

function buildTuiWebSocketUrl({ host, port, token = "", protocol = "ws" }) {
	const url = new URL(`${normalizeProtocol(protocol)}://${host}:${port}/ws`);
	const normalizedToken = String(token || "").trim();
	if (normalizedToken) {
		url.searchParams.set("token", normalizedToken);
	}
	return url.toString();
}

/**
 * WebSocket Bridge for TUI
 *
 * Connects to the Bosun UI server's WebSocket endpoint to receive
 * real-time stats, session events, and task updates.
 */

class TuiWsBridge {
	constructor({ host, port, configDir, protocol = "ws" }) {
		this.host = host;
		this.port = port;
		this.configDir = configDir || defaultConfigDir();
		this.protocol = protocol;
		this.ws = null;
		this.listeners = new Map();
		this.reconnectAttempts = 0;
		this.maxReconnectAttempts = 10;
		this.reconnectDelay = 1000;
		this.reconnectTimer = null;
		this._connected = false;
		this._url = buildTuiWebSocketUrl({
			host,
			port,
			protocol: resolveWebSocketProtocol({ protocol, configDir: this.configDir }),
			token: resolveTuiAuthToken({ configDir: this.configDir }),
		});
	}

	connect() {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			return;
		}

		try {
			this._url = buildTuiWebSocketUrl({
				host: this.host,
				port: this.port,
				protocol: resolveWebSocketProtocol({ protocol: this.protocol, configDir: this.configDir }),
				token: resolveTuiAuthToken({ configDir: this.configDir }),
			});
			this.ws = new WebSocket(this._url);

			this.ws.onopen = () => {
				this._connected = true;
				this.reconnectAttempts = 0;
				this.send("subscribe", {
					channels: ["monitor", "stats", "sessions", "tasks", "workflows", "tui"],
				});
				this._emit("connect", {});
			};

			this.ws.onmessage = (event) => {
				try {
					const data = JSON.parse(event.data);
					this._handleMessage(data);
				} catch (err) {
					this._emit("error", { message: err?.message || "Failed to parse message" });
				}
			};

			this.ws.onclose = () => {
				this._connected = false;
				this._emit("disconnect", {});
				this._scheduleReconnect();
			};

			this.ws.onerror = (err) => {
				const message = err?.message || err?.error?.message || "WebSocket error";
				this._emit("error", { message });
			};
		} catch (err) {
			this._emit("error", { message: err?.message || "Failed to connect" });
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
			this.connect();
		}, delay);
	}

	_handleMessage(data) {
		const { type, payload } = data;

		switch (type) {
			case "monitor:stats":
			case "stats":
				this._emit("monitor:stats", payload);
				this._emit("stats", payload);
				break;
			case "sessions:update":
				this._emit("sessions:update", payload);
				break;
			case "session:event": {
				this._emit("session:event", payload);
				// backward compat: bridge to legacy session lifecycle events
				const sessionEventReason = payload?.event?.reason || "";
				const sessionData = payload?.session || {};
				if (sessionEventReason === "session-started") {
					this._emit("session:start", sessionData);
				} else if (sessionEventReason === "session-ended") {
					this._emit("session:end", sessionData);
				} else {
					this._emit("session:update", sessionData);
				}
				break;
			}
			case "logs:stream":
				this._emit("logs:stream", payload);
				break;
			case "workflow:status":
				this._emit("workflow:status", payload);
				break;
			case "tasks:update": {
				this._emit("tasks:update", payload);
				// backward compat: bridge to legacy task events
				const taskReason = payload?.reason || "";
				const taskSourceEvent = payload?.sourceEvent || "";
				const taskId = payload?.taskId ?? payload?.patch?.id;
				const taskPatch = { ...payload?.patch, id: taskId };
				if (taskReason === "task-created" || taskSourceEvent === "task:created") {
					this._emit("task:create", taskPatch);
				} else if (
					taskReason === "task-deleted"
					|| taskSourceEvent === "task:deleted"
					|| taskSourceEvent === "delete"
				) {
					this._emit("task:delete", taskId);
				} else {
					this._emit("task:update", taskPatch);
				}
				break;
			}
			case "pong":
				break;
			default:
				this._emit(type, payload);
		}
	}

	send(type, payload = {}) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			const message = type === "subscribe"
				? { type, channels: Array.isArray(payload.channels) ? payload.channels : [] }
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
let _lastConfigDir = null;
let _lastProtocol = null;

function createWsBridge({ host, port, configDir, protocol }) {
	_instance = new TuiWsBridge({ host, port, configDir, protocol });
	_lastHost = host;
	_lastPort = port;
	_lastConfigDir = configDir || defaultConfigDir();
	_lastProtocol = protocol || "ws";
	wsBridge._instance = _instance;
	return _instance;
}

function wsBridge({ host, port, configDir, protocol }) {
	const resolvedConfigDir = configDir || defaultConfigDir();
	const resolvedProtocol = protocol || "ws";
	if (
		_instance
		&& (
			host !== _lastHost
			|| port !== _lastPort
			|| resolvedConfigDir !== _lastConfigDir
			|| resolvedProtocol !== _lastProtocol
		)
	) {
		_instance.disconnect();
		return createWsBridge({ host, port, configDir: resolvedConfigDir, protocol: resolvedProtocol });
	}
	if (!_instance) {
		return createWsBridge({ host, port, configDir: resolvedConfigDir, protocol: resolvedProtocol });
	}
	return _instance;
}

wsBridge._instance = null;

export default wsBridge;
export {
	TuiWsBridge,
	buildTuiWebSocketUrl,
	createWsBridge,
	defaultConfigDir,
	resolveWebSocketProtocol,
	resolveTuiAuthToken,
};
