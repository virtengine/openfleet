/**
 * WebSocket Bridge for TUI
 *
 * Connects to the Bosun UI server's WebSocket endpoint to receive
 * real-time stats, session events, and task updates.
 */

class TuiWsBridge {
	constructor({ host, port }) {
		this.host = host;
		this.port = port;
		this.ws = null;
		this.listeners = new Map();
		this.reconnectAttempts = 0;
		this.maxReconnectAttempts = 10;
		this.reconnectDelay = 1000;
		this.reconnectTimer = null;
		this._connected = false;
		this._url = `ws://${host}:${port}/ws`;
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
			case "stats":
				this._emit("stats", payload);
				break;
			case "session:start":
				this._emit("session:start", payload);
				break;
			case "session:update":
				this._emit("session:update", payload);
				break;
			case "sessions:update":
				this._emit("sessions:update", payload);
				break;
			case "session:end":
				this._emit("session:end", payload);
				break;
			case "session:event":
				this._emit("session:event", payload);
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
			case "retry-queue-updated":
				this._emit("retry-queue-updated", payload);
				this._emit("retry:update", payload);
				break;
			case "invalidate":
				this._emit("invalidate", payload);
				break;
			case "workflow:trigger":
				this._emit("workflow:trigger", payload);
				break;
			case "workflow:complete":
				this._emit("workflow:complete", payload);
				break;
			case "pong":
				break;
			default:
				this._emit(type, payload);
		}
	}

	send(type, payload = {}) {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type, payload }));
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

function createWsBridge({ host, port }) {
	_instance = new TuiWsBridge({ host, port });
	_lastHost = host;
	_lastPort = port;
	return _instance;
}

function wsBridge({ host, port }) {
	// If host/port changed, create new instance
	if (_instance && (host !== _lastHost || port !== _lastPort)) {
		_instance.disconnect();
		return createWsBridge({ host, port });
	}
	if (!_instance) {
		return createWsBridge({ host, port });
	}
	return _instance;
}

wsBridge._instance = null;

export default wsBridge;
export { TuiWsBridge, createWsBridge };
