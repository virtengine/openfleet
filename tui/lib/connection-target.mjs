import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";

const REMOTE_CONNECTION_FILE = "remote-connection.json";
const UI_INSTANCE_LOCK_FILE = "ui-server.instance.lock.json";

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function toConnectionId(value, fallback = "") {
  const normalized = toTrimmedString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback || `connection-${Date.now()}`;
}

function normalizeConnectionName(entry, index) {
  return toTrimmedString(entry?.name)
    || toTrimmedString(entry?.label)
    || toTrimmedString(entry?.endpoint)
    || `Connection ${index + 1}`;
}

export function normalizeRemoteConnectionConfig(raw = {}) {
  const normalizedConnections = [];
  const sourceConnections = Array.isArray(raw?.connections)
    ? raw.connections
    : (raw?.endpoint || raw?.apiKey)
      ? [{
          id: raw?.id || raw?.activeConnectionId || raw?.currentConnectionId || "primary",
          name: raw?.name || raw?.label || raw?.endpoint || "Primary",
          endpoint: raw?.endpoint,
          apiKey: raw?.apiKey,
          enabled: raw?.enabled !== false,
        }]
      : [];

  for (let index = 0; index < sourceConnections.length; index += 1) {
    const entry = sourceConnections[index];
    const endpoint = toTrimmedString(entry?.endpoint);
    if (!endpoint) continue;
    const name = normalizeConnectionName(entry, index);
    normalizedConnections.push({
      id: toConnectionId(entry?.id || name, `connection-${index + 1}`),
      name,
      endpoint,
      apiKey: toTrimmedString(entry?.apiKey),
      enabled: entry?.enabled !== false,
    });
  }

  const enabled = raw?.enabled !== false && normalizedConnections.length > 0;
  let activeConnectionId = toTrimmedString(raw?.activeConnectionId || raw?.currentConnectionId);
  if (!activeConnectionId && normalizedConnections.length > 0) {
    const legacyEndpoint = toTrimmedString(raw?.endpoint);
    const matched = legacyEndpoint
      ? normalizedConnections.find((entry) => entry.endpoint === legacyEndpoint)
      : null;
    activeConnectionId = matched?.id || normalizedConnections.find((entry) => entry.enabled !== false)?.id || normalizedConnections[0].id;
  }

  const activeConnection = normalizedConnections.find((entry) => entry.id === activeConnectionId)
    || normalizedConnections.find((entry) => entry.enabled !== false)
    || normalizedConnections[0]
    || null;

  return {
    enabled: Boolean(enabled && activeConnection),
    activeConnectionId: activeConnection?.id || "",
    endpoint: activeConnection?.endpoint || "",
    apiKey: activeConnection?.apiKey || "",
    name: activeConnection?.name || "",
    connections: normalizedConnections,
  };
}

export function listRemoteConnections(config = {}) {
  return normalizeRemoteConnectionConfig(config).connections;
}

export function setActiveRemoteConnection(config = {}, connectionId = "") {
  const normalized = normalizeRemoteConnectionConfig(config);
  const nextActive = normalized.connections.find((entry) => entry.id === connectionId)
    || normalized.connections[0]
    || null;
  return normalizeRemoteConnectionConfig({
    ...normalized,
    activeConnectionId: nextActive?.id || "",
    enabled: Boolean(nextActive),
  });
}

export function upsertRemoteConnection(config = {}, entry = {}, options = {}) {
  const normalized = normalizeRemoteConnectionConfig(config);
  const endpoint = toTrimmedString(entry?.endpoint);
  if (!endpoint) {
    return normalized;
  }
  const requestedName = normalizeConnectionName(entry, normalized.connections.length);
  const id = toConnectionId(entry?.id || requestedName, `connection-${normalized.connections.length + 1}`);
  const nextEntry = {
    id,
    name: requestedName,
    endpoint,
    apiKey: toTrimmedString(entry?.apiKey),
    enabled: entry?.enabled !== false,
  };
  const existingIndex = normalized.connections.findIndex((item) => item.id === id || item.endpoint === endpoint);
  const nextConnections = [...normalized.connections];
  if (existingIndex >= 0) {
    nextConnections[existingIndex] = {
      ...nextConnections[existingIndex],
      ...nextEntry,
    };
  } else {
    nextConnections.push(nextEntry);
  }
  return normalizeRemoteConnectionConfig({
    ...normalized,
    enabled: true,
    activeConnectionId: options.makeActive === false ? normalized.activeConnectionId : nextEntry.id,
    connections: nextConnections,
  });
}

export function defaultConfigDir() {
  const explicit = toTrimmedString(
    process.env.BOSUN_DIR
      || process.env.BOSUN_HOME
      || "",
  );
  if (explicit) return resolve(explicit);
  return resolve(process.cwd(), ".bosun");
}

export function normalizeWsProtocol(protocol) {
  const value = toTrimmedString(protocol).toLowerCase();
  return value === "wss" ? "wss" : "ws";
}

export function normalizeHttpProtocol(protocol) {
  const value = toTrimmedString(protocol).toLowerCase();
  return value === "https" || value === "wss" ? "https" : "http";
}

export function readUiInstanceLock(configDir = defaultConfigDir()) {
  try {
    const lockPath = resolve(configDir, ".cache", UI_INSTANCE_LOCK_FILE);
    if (!existsSync(lockPath)) return null;
    const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function readRemoteConnectionConfig(configDir = defaultConfigDir()) {
  try {
    const filePath = resolve(configDir, REMOTE_CONNECTION_FILE);
    if (!existsSync(filePath)) {
      return normalizeRemoteConnectionConfig({});
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    return normalizeRemoteConnectionConfig(parsed);
  } catch {
    return normalizeRemoteConnectionConfig({});
  }
}

export function saveRemoteConnectionConfig(
  config = {},
  configDir = defaultConfigDir(),
) {
  const dir = resolve(configDir);
  mkdirSync(dir, { recursive: true });
  const payload = normalizeRemoteConnectionConfig(config);
  writeFileSync(
    resolve(dir, REMOTE_CONNECTION_FILE),
    JSON.stringify(payload, null, 2),
    "utf8",
  );
  return payload;
}

export function clearRemoteConnectionConfig(configDir = defaultConfigDir()) {
  return saveRemoteConnectionConfig(
    { enabled: false, activeConnectionId: "", endpoint: "", apiKey: "", connections: [] },
    configDir,
  );
}

export function parseConnectionEndpoint(endpoint, fallbackProtocol = "http") {
  const raw = toTrimmedString(endpoint);
  if (!raw) return null;
  const normalizedFallback = normalizeHttpProtocol(fallbackProtocol);
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)
    ? raw
    : `${normalizedFallback}://${raw}`;
  try {
    const parsed = new URL(candidate);
    const httpProtocol = normalizeHttpProtocol(parsed.protocol);
    const wsProtocol = httpProtocol === "https" ? "wss" : "ws";
    const port = Number(
      parsed.port || (httpProtocol === "https" ? 443 : 80),
    );
    if (!Number.isFinite(port) || port <= 0) return null;
    return {
      endpoint: parsed.origin,
      host: parsed.hostname,
      port,
      protocol: wsProtocol,
      httpProtocol,
    };
  } catch {
    return null;
  }
}

export function resolveLocalTuiConnectionTarget(options = {}) {
  const configDir = options.configDir || defaultConfigDir();
  const env = options.env || process.env;
  const config = options.config || {};
  const defaultPort = Number(
    env.TELEGRAM_UI_PORT
      || env.BOSUN_PORT
      || config?.telegramUiPort
      || 3080,
  ) || 3080;

  const instance = readUiInstanceLock(configDir);
  if (instance?.url || instance?.host || instance?.port) {
    const parsed = instance?.url
      ? parseConnectionEndpoint(instance.url, instance.protocol || "http")
      : null;
    if (parsed) {
      return {
        ...parsed,
        apiKey: "",
        source: "ui-instance-lock",
      };
    }
    const host = toTrimmedString(instance?.host || "127.0.0.1") || "127.0.0.1";
    const port = Number(instance?.port || 0) || defaultPort;
    const httpProtocol = normalizeHttpProtocol(instance?.protocol || "http");
    return {
      endpoint: `${httpProtocol}://${host}:${port}`,
      host,
      port,
      protocol: httpProtocol === "https" ? "wss" : "ws",
      httpProtocol,
      apiKey: "",
      source: "ui-instance-lock",
    };
  }

  return {
    endpoint: `http://127.0.0.1:${defaultPort}`,
    host: "127.0.0.1",
    port: defaultPort,
    protocol: "ws",
    httpProtocol: "http",
    apiKey: "",
    source: "default-local",
  };
}

export async function testConnectionTarget(endpoint, apiKey = "", options = {}) {
  const parsed = typeof endpoint === "string"
    ? parseConnectionEndpoint(endpoint, options.fallbackProtocol || "http")
    : endpoint;
  if (!parsed?.endpoint) {
    return {
      ok: false,
      error: "Invalid endpoint URL",
      target: null,
      statusCode: 0,
    };
  }

  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 4000));
  const targetUrl = new URL("/api/status", parsed.endpoint);
  const headers = {};
  const normalizedApiKey = toTrimmedString(apiKey);
  if (normalizedApiKey) {
    headers["x-api-key"] = normalizedApiKey;
  }
  const requester = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolveProbe) => {
    const req = requester(targetUrl, {
      method: "GET",
      headers,
      timeout: timeoutMs,
      rejectUnauthorized: false,
    }, (res) => {
      const statusCode = Number(res.statusCode || 0);
      res.resume();
      if (statusCode >= 200 && statusCode < 400) {
        resolveProbe({
          ok: true,
          error: "",
          target: parsed,
          statusCode,
        });
        return;
      }
      const authFailure = statusCode === 401 || statusCode === 403;
      resolveProbe({
        ok: false,
        error: authFailure ? "Authentication failed" : `Request failed (${statusCode || "unknown"})`,
        target: parsed,
        statusCode,
      });
    });
    req.on("error", (error) => {
      resolveProbe({
        ok: false,
        error: String(error?.message || "Connection failed"),
        target: parsed,
        statusCode: 0,
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("Connection timed out"));
    });
    req.end();
  });
}

export function resolveTuiConnectionTarget(options = {}) {
  const configDir = options.configDir || defaultConfigDir();
  const env = options.env || process.env;
  const config = options.config || {};
  const explicitEndpoint = toTrimmedString(options.endpoint);
  const explicitHost = toTrimmedString(options.host);
  const explicitPort = Number(options.port || 0);
  const explicitProtocol = toTrimmedString(options.protocol);
  const explicitApiKey = toTrimmedString(options.apiKey);
  const defaultPort = Number(
    env.TELEGRAM_UI_PORT
      || env.BOSUN_PORT
      || config?.telegramUiPort
      || 3080,
  ) || 3080;

  if (explicitEndpoint) {
    const parsed = parseConnectionEndpoint(explicitEndpoint, explicitProtocol || "http");
    if (parsed) {
      return {
        ...parsed,
        apiKey: explicitApiKey,
        source: "cli-endpoint",
      };
    }
  }

  if (explicitHost || explicitPort > 0 || explicitProtocol) {
    const wsProtocol = normalizeWsProtocol(explicitProtocol || "ws");
    const httpProtocol = normalizeHttpProtocol(wsProtocol);
    const host = explicitHost || "127.0.0.1";
    const port = explicitPort > 0 ? explicitPort : defaultPort;
    return {
      endpoint: `${httpProtocol}://${host}:${port}`,
      host,
      port,
      protocol: wsProtocol,
      httpProtocol,
      apiKey: explicitApiKey,
      source: "cli-host-port",
    };
  }

  const remote = readRemoteConnectionConfig(configDir);
  if (remote.enabled && remote.endpoint) {
    const parsed = parseConnectionEndpoint(remote.endpoint, "https");
    if (parsed) {
      return {
        ...parsed,
        apiKey: explicitApiKey || remote.apiKey || toTrimmedString(env.BOSUN_API_KEY),
        source: "saved-remote",
      };
    }
  }

  return {
    ...resolveLocalTuiConnectionTarget({ configDir, config, env }),
    apiKey: explicitApiKey,
  };
}
