import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo as getOsUserInfo } from "node:os";
import { dirname, resolve } from "node:path";

const TUNNEL_MODE_NAMED = "named";
const TUNNEL_MODE_QUICK = "quick";
const TUNNEL_MODE_DISABLED = "disabled";
const DEFAULT_TUNNEL_MODE = TUNNEL_MODE_NAMED;
const DEFAULT_CLOUDFLARE_DNS_RETRY_MAX = 3;
const DEFAULT_CLOUDFLARE_DNS_RETRY_BASE_MS = 750;
const RESERVED_HOSTNAME_LABELS = new Set([
  "www",
  "api",
  "admin",
  "root",
  "mail",
  "ftp",
  "smtp",
  "autodiscover",
  "localhost",
]);
const HOSTNAME_MAP_FILE = "cloudflare-hostname-map.json";
const hostnameMapCache = new Map();

export function normalizeTunnelMode(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) return DEFAULT_TUNNEL_MODE;
  if (["disabled", "off", "false", "0"].includes(value)) return TUNNEL_MODE_DISABLED;
  if (["quick", "quick-tunnel", "ephemeral", "trycloudflare"].includes(value)) {
    return TUNNEL_MODE_QUICK;
  }
  if (["cloudflared", "auto", "named", "permanent"].includes(value)) {
    return TUNNEL_MODE_NAMED;
  }
  return DEFAULT_TUNNEL_MODE;
}

function parseBooleanEnvValue(rawValue, fallback = false) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallback;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parseBoundedInt(rawValue, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function normalizeDomainName(rawValue) {
  const value = String(rawValue || "").trim().toLowerCase();
  if (!value) return "";
  const withoutScheme = value.replace(/^https?:\/\//, "");
  const withoutPath = withoutScheme.split("/")[0].replace(/:\d+$/, "");
  return withoutPath.replace(/\.+$/, "");
}

export function sanitizeHostnameLabel(rawValue, fallback = "operator") {
  const normalized = String(rawValue || "")
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  if (!normalized) return fallback;
  return normalized.slice(0, 63).replace(/-+$/, "") || fallback;
}

function getTunnelIdentity() {
  const candidates = [
    process.env.CLOUDFLARE_TUNNEL_USERNAME,
    process.env.CLOUDFLARE_HOSTNAME_USER,
    process.env.BOSUN_OPERATOR_ID,
    process.env.USERNAME,
    process.env.USER,
  ];
  for (const value of candidates) {
    const trimmed = String(value || "").trim();
    if (trimmed) return trimmed;
  }
  try {
    const info = getOsUserInfo();
    if (info?.username) return info.username;
  } catch {
    // best effort
  }
  return "operator";
}

function resolveTunnelConfigDir(configDir = "") {
  const injectedConfigDir = String(configDir || "").trim();
  if (injectedConfigDir) {
    const resolvedConfigDir = resolve(injectedConfigDir);
    try { mkdirSync(resolvedConfigDir, { recursive: true }); } catch { /* ok */ }
    return resolvedConfigDir;
  }
  if (process.env.BOSUN_CONFIG_PATH) {
    const fromConfigPath = dirname(resolve(process.env.BOSUN_CONFIG_PATH));
    try { mkdirSync(fromConfigPath, { recursive: true }); } catch { /* ok */ }
    return fromConfigPath;
  }
  const isWslInteropRuntime = Boolean(
    process.env.WSL_DISTRO_NAME
    || process.env.WSL_INTEROP
    || (process.platform === "win32"
      && String(process.env.HOME || "")
        .trim()
        .startsWith("/home/")),
  );
  const preferWindowsDirs = process.platform === "win32" && !isWslInteropRuntime;
  const baseDir = preferWindowsDirs
    ? process.env.APPDATA
      || process.env.LOCALAPPDATA
      || process.env.USERPROFILE
      || process.env.HOME
      || homedir()
    : process.env.HOME
      || process.env.XDG_CONFIG_HOME
      || process.env.USERPROFILE
      || process.env.APPDATA
      || process.env.LOCALAPPDATA
      || homedir();

  const dir = process.env.BOSUN_HOME || process.env.BOSUN_DIR || resolve(baseDir, "bosun");
  try { mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
  return dir;
}

function resolveTunnelCachePath(fileName, { configDir } = {}) {
  const cacheDir = resolve(resolveTunnelConfigDir(configDir), ".cache");
  mkdirSync(cacheDir, { recursive: true });
  return resolve(cacheDir, fileName);
}

function readHostnameMapStore(configDir) {
  const fallback = { version: 1, domains: {} };
  const mapPath = resolveTunnelCachePath(HOSTNAME_MAP_FILE, { configDir });
  if (hostnameMapCache.has(mapPath)) {
    return hostnameMapCache.get(mapPath);
  }
  try {
    if (!existsSync(mapPath)) {
      hostnameMapCache.set(mapPath, fallback);
      return fallback;
    }
    const parsed = JSON.parse(readFileSync(mapPath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      hostnameMapCache.set(mapPath, fallback);
      return fallback;
    }
    if (!parsed.domains || typeof parsed.domains !== "object") {
      parsed.domains = {};
    }
    hostnameMapCache.set(mapPath, parsed);
    return parsed;
  } catch {
    hostnameMapCache.set(mapPath, fallback);
    return fallback;
  }
}

function writeHostnameMapStore(data, configDir) {
  try {
    const mapPath = resolveTunnelCachePath(HOSTNAME_MAP_FILE, { configDir });
    writeFileSync(mapPath, JSON.stringify(data, null, 2), "utf8");
    hostnameMapCache.set(mapPath, data);
  } catch {
    // best effort
  }
}

function getDomainMap(store, baseDomain) {
  const normalizedBaseDomain = normalizeDomainName(baseDomain);
  if (!normalizedBaseDomain) {
    return { normalizedBaseDomain: "", map: { byIdentity: {}, byLabel: {} } };
  }
  if (!store.domains[normalizedBaseDomain] || typeof store.domains[normalizedBaseDomain] !== "object") {
    store.domains[normalizedBaseDomain] = {
      byIdentity: {},
      byLabel: {},
    };
  }
  const domainMap = store.domains[normalizedBaseDomain];
  if (!domainMap.byIdentity || typeof domainMap.byIdentity !== "object") {
    domainMap.byIdentity = {};
  }
  if (!domainMap.byLabel || typeof domainMap.byLabel !== "object") {
    domainMap.byLabel = {};
  }
  return { normalizedBaseDomain, map: domainMap };
}

function allocateStableHostnameLabel(domainMap, identity, preferredLabel) {
  const normalizedIdentity = String(identity || "").trim().toLowerCase();
  const existing = String(domainMap.byIdentity?.[normalizedIdentity] || "").trim().toLowerCase();
  if (existing && domainMap.byLabel?.[existing] === normalizedIdentity) {
    return existing;
  }

  const safeBaseLabel = sanitizeHostnameLabel(preferredLabel, "operator");
  let baseLabel = RESERVED_HOSTNAME_LABELS.has(safeBaseLabel)
    ? `${safeBaseLabel}-user`
    : safeBaseLabel;
  baseLabel = sanitizeHostnameLabel(baseLabel, "operator");
  let candidate = baseLabel;
  let suffix = 1;

  while (true) {
    const owner = String(domainMap.byLabel?.[candidate] || "").trim().toLowerCase();
    const reserved = RESERVED_HOSTNAME_LABELS.has(candidate);
    if ((!owner || owner === normalizedIdentity) && !reserved) {
      domainMap.byLabel[candidate] = normalizedIdentity;
      domainMap.byIdentity[normalizedIdentity] = candidate;
      return candidate;
    }
    suffix += 1;
    candidate = sanitizeHostnameLabel(`${baseLabel}-${suffix}`, baseLabel);
  }
}

export function resolveDeterministicTunnelHostname({
  baseDomain,
  explicitHostname,
  username,
  policy,
  configDir,
} = {}) {
  const normalizedBaseDomain = normalizeDomainName(
    baseDomain || process.env.CLOUDFLARE_BASE_DOMAIN || process.env.CF_BASE_DOMAIN,
  );
  const explicit = normalizeDomainName(
    explicitHostname || process.env.CLOUDFLARE_TUNNEL_HOSTNAME || process.env.CF_TUNNEL_HOSTNAME,
  );
  if (explicit) {
    return {
      hostname: explicit,
      baseDomain: explicit.split(".").slice(1).join("."),
      label: explicit.split(".")[0] || "operator",
      identity: "",
      policy: "explicit",
      source: "explicit",
    };
  }
  if (!normalizedBaseDomain) {
    throw new Error(
      "Missing CLOUDFLARE_BASE_DOMAIN (or CLOUDFLARE_TUNNEL_HOSTNAME) for named tunnel hostname resolution",
    );
  }
  const resolvedPolicy = String(
    policy || process.env.CLOUDFLARE_USERNAME_HOSTNAME_POLICY || "per-user-fixed",
  )
    .trim()
    .toLowerCase();
  const perUserFixed = resolvedPolicy !== "fixed";
  const identityRaw = username || getTunnelIdentity();
  const identity = sanitizeHostnameLabel(identityRaw, "operator");

  if (!perUserFixed) {
    const fixedLabel = sanitizeHostnameLabel(
      process.env.CLOUDFLARE_FIXED_HOST_LABEL || process.env.CF_FIXED_HOST_LABEL || "bosun",
      "bosun",
    );
    const label = RESERVED_HOSTNAME_LABELS.has(fixedLabel)
      ? sanitizeHostnameLabel(`${fixedLabel}-app`, "bosun")
      : fixedLabel;
    return {
      hostname: `${label}.${normalizedBaseDomain}`,
      baseDomain: normalizedBaseDomain,
      label,
      identity,
      policy: "fixed",
      source: "fixed",
    };
  }

  const store = readHostnameMapStore(configDir);
  const { map } = getDomainMap(store, normalizedBaseDomain);
  const label = allocateStableHostnameLabel(map, identity, identity);
  writeHostnameMapStore(store, configDir);
  return {
    hostname: `${label}.${normalizedBaseDomain}`,
    baseDomain: normalizedBaseDomain,
    label,
    identity,
    policy: "per-user-fixed",
    source: "map",
  };
}

function getCloudflareApiConfig() {
  const token = String(
    process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || "",
  ).trim();
  const zoneId = String(
    process.env.CLOUDFLARE_ZONE_ID || process.env.CF_ZONE_ID || "",
  ).trim();
  const enabled = parseBooleanEnvValue(process.env.CLOUDFLARE_DNS_SYNC_ENABLED, true);
  return {
    enabled,
    token,
    zoneId,
    baseUrl: "https://api.cloudflare.com/client/v4",
  };
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function cloudflareApiRequest(api, path, { method = "GET", body = undefined } = {}) {
  const maxRetries = parseBoundedInt(
    process.env.CLOUDFLARE_DNS_MAX_RETRIES,
    DEFAULT_CLOUDFLARE_DNS_RETRY_MAX,
    { min: 1, max: 8 },
  );
  const retryBaseMs = parseBoundedInt(
    process.env.CLOUDFLARE_DNS_RETRY_BASE_MS,
    DEFAULT_CLOUDFLARE_DNS_RETRY_BASE_MS,
    { min: 100, max: 5000 },
  );
  if (!api?.token || !api?.zoneId) {
    throw new Error("Cloudflare API token/zone not configured");
  }
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await fetch(`${api.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${api.token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.success === false) {
        const errMessage = Array.isArray(payload?.errors)
          ? payload.errors.map((entry) => entry?.message).filter(Boolean).join("; ")
          : `${res.status} ${res.statusText || ""}`.trim();
        const err = new Error(`Cloudflare API ${method} ${path} failed: ${errMessage}`);
        err.status = res.status;
        throw err;
      }
      return payload;
    } catch (err) {
      lastError = err;
      const status = Number(err?.status || 0);
      const retryable = status === 429 || status >= 500 || status === 0;
      if (!retryable || attempt >= maxRetries) break;
      const backoff = retryBaseMs * 2 ** (attempt - 1);
      const jitter = Math.floor(Math.random() * Math.min(500, Math.max(100, backoff / 3)));
      await sleep(backoff + jitter);
    }
  }
  throw lastError || new Error(`Cloudflare API ${method} ${path} failed`);
}

export async function ensureCloudflareDnsCname({
  hostname,
  target,
  proxied = true,
  api = getCloudflareApiConfig(),
} = {}) {
  const normalizedHostname = normalizeDomainName(hostname);
  const normalizedTarget = normalizeDomainName(target);
  if (!normalizedHostname || !normalizedTarget) {
    throw new Error("Missing hostname/target for Cloudflare DNS sync");
  }
  if (!api?.enabled) {
    return { ok: true, changed: false, action: "disabled" };
  }
  if (!api.token || !api.zoneId) {
    return { ok: false, changed: false, action: "missing_credentials" };
  }

  const query = `/zones/${encodeURIComponent(api.zoneId)}/dns_records?type=CNAME&name=${encodeURIComponent(normalizedHostname)}&per_page=100`;
  const listed = await cloudflareApiRequest(api, query, { method: "GET" });
  const records = Array.isArray(listed?.result) ? listed.result : [];
  const existing = records.find(
    (record) => String(record?.type || "").toUpperCase() === "CNAME"
      && String(record?.name || "").toLowerCase() === normalizedHostname,
  );
  const payload = {
    type: "CNAME",
    name: normalizedHostname,
    content: normalizedTarget,
    proxied: Boolean(proxied),
    ttl: 1,
  };

  if (existing) {
    const sameTarget = String(existing.content || "").toLowerCase() === normalizedTarget;
    const sameProxy = Boolean(existing.proxied) === Boolean(payload.proxied);
    if (sameTarget && sameProxy) {
      return { ok: true, changed: false, action: "noop", id: existing.id };
    }
    const updated = await cloudflareApiRequest(
      api,
      `/zones/${encodeURIComponent(api.zoneId)}/dns_records/${encodeURIComponent(existing.id)}`,
      { method: "PUT", body: payload },
    );
    return {
      ok: true,
      changed: true,
      action: "updated",
      id: updated?.result?.id || existing.id,
    };
  }

  const created = await cloudflareApiRequest(
    api,
    `/zones/${encodeURIComponent(api.zoneId)}/dns_records`,
    { method: "POST", body: payload },
  );
  return {
    ok: true,
    changed: true,
    action: "created",
    id: created?.result?.id || null,
  };
}