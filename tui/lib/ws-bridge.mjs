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
			protocol,
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
				protocol: this.protocol,
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
			case "stats":
				this._emit("monitor:stats", payload);
				this._emit("stats", payload);
				break;
			case "sessions:update":
				this._emit("sessions:update", payload);
				break;
			case "session:event":
				this._emit("session:event", payload);
				break;
			case "logs:stream":
				this._emit("logs:stream", payload);
				break;
			case "workflow:status":
				this._emit("workflow:status", payload);
				break;
			case "tasks:update":
				this._emit("tasks:update", payload);
				break;
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
	resolveTuiAuthToken,
};
