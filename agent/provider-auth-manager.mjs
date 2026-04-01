import { getProviderCapabilities, normalizeProviderCapabilityId } from "./provider-capabilities.mjs";
import { getProviderAuthAdapter } from "./auth/index.mjs";
import { getBuiltinProviderEnvHints } from "./providers/index.mjs";

const AUTH_METHOD_ORDER = Object.freeze([
  "local",
  "subscription",
  "oauth",
  "apiKey",
]);

function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function hasValue(value) {
  if (Array.isArray(value)) return value.some(hasValue);
  if (value && typeof value === "object") return Object.values(value).some(hasValue);
  return toTrimmedString(value) !== "";
}

function normalizeMethodName(value) {
  const normalized = toTrimmedString(value).toLowerCase();
  if (normalized === "apikey") return "apiKey";
  return normalized;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getProviderEnvHints(providerId) {
  return getBuiltinProviderEnvHints(providerId);
}

function resolveAdapterSettings(providerId, options = {}) {
  const adapter = getProviderAuthAdapter(providerId);
  if (!adapter) {
    return {
      providerId: normalizeProviderCapabilityId(providerId),
      enabled: true,
      enabledSource: "default",
      authMode: null,
      authModeSource: null,
      defaultModel: null,
      defaultModelSource: null,
      baseUrl: null,
      baseUrlSource: null,
      endpoint: null,
      endpointSource: null,
      deployment: null,
      deploymentSource: null,
      apiVersion: null,
      apiVersionSource: null,
      workspace: null,
      workspaceSource: null,
    };
  }
  return adapter.resolveSettings({
    settings: options.settings || process.env,
    env: options.env || process.env,
  });
}

function readEnvHints(env = process.env, keys = []) {
  for (const key of keys) {
    const value = toTrimmedString(env?.[key]);
    if (!value) continue;
    return {
      configured: true,
      source: "env",
      key,
      value,
    };
  }
  return {
    configured: false,
    source: null,
    key: null,
    value: null,
  };
}

export function listProviderAuthModes(providerId, capabilities = null) {
  const adapter = getProviderAuthAdapter(providerId);
  if (adapter?.driver?.auth?.supportedModes?.length > 0) {
    return unique(adapter.driver.auth.supportedModes.map(normalizeMethodName));
  }
  const capabilitySnapshot = capabilities && typeof capabilities === "object"
    ? { ...capabilities }
    : getProviderCapabilities(providerId);
  if (capabilitySnapshot.auth === false) return [];
  const supported = [];
  if (capabilitySnapshot.local) supported.push("local");
  if (capabilitySnapshot.subscription) supported.push("subscription");
  if (capabilitySnapshot.oauth) supported.push("oauth");
  if (capabilitySnapshot.apiKey) supported.push("apiKey");
  return supported.length > 0 ? supported : ["apiKey"];
}

export function resolveProviderAuthEnv(providerId, env = process.env) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  const adapter = getProviderAuthAdapter(normalizedProviderId);
  if (adapter) {
    return adapter.resolveEnv(env);
  }
  const hints = getProviderEnvHints(normalizedProviderId);
  return {
    providerId: normalizedProviderId,
    apiKey: readEnvHints(env, hints.apiKey),
    oauth: readEnvHints(env, hints.oauth),
    subscription: readEnvHints(env, hints.subscription),
  };
}

function normalizeMethodState(method, authState = {}, envState = {}, capabilities = {}) {
  const credentials = authState.credentials && typeof authState.credentials === "object"
    ? authState.credentials
    : {};
  const errors = authState.errors && typeof authState.errors === "object"
    ? authState.errors
    : {};
  const lastError = toTrimmedString(errors[method] || authState.lastError || "");
  const expiresAt = toTrimmedString(authState.expiresAt || authState[`${method}ExpiresAt`] || "");
  const expired = authState.expired === true
    || authState[`${method}Expired`] === true
    || (expiresAt ? Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= Date.now() : false);
  const revoked = authState.revoked === true || authState[`${method}Revoked`] === true;
  if (method === "local") {
    const available = authState.localAvailable !== false && authState.available !== false;
    return {
      type: method,
      supported: capabilities.local === true,
      available,
      configured: available,
      authenticated: available && !revoked,
      source: "runtime",
      credentialKey: null,
      lastError,
      expiresAt: null,
    };
  }

  if (method === "apiKey") {
    const explicitValue =
      authState.apiKey
      || credentials.apiKey
      || authState.secret
      || credentials.secret;
    const envInfo = envState.apiKey || { configured: false, key: null, source: null };
    const configured = hasValue(explicitValue) || envInfo.configured;
    return {
      type: method,
      supported: capabilities.apiKey === true,
      available: true,
      configured,
      authenticated: configured && !expired && !revoked,
      source: hasValue(explicitValue) ? "input" : envInfo.source,
      credentialKey: envInfo.key,
      lastError,
      expiresAt: expired ? expiresAt || null : null,
    };
  }

  if (method === "oauth") {
    const token =
      authState.accessToken
      || authState.oauthToken
      || credentials.accessToken
      || credentials.oauthToken;
    const envInfo = envState.oauth || { configured: false, key: null, source: null };
    const configured = hasValue(token) || envInfo.configured || authState.connected === true;
    const authenticated = authState.authenticated === true
      || authState.connected === true
      || authState.loggedIn === true
      || (configured && !expired && !revoked);
    return {
      type: method,
      supported: capabilities.oauth === true,
      available: true,
      configured,
      authenticated,
      source: hasValue(token) ? "input" : envInfo.source,
      credentialKey: envInfo.key,
      lastError,
      expiresAt: expiresAt || null,
    };
  }

  const envInfo = envState.subscription || { configured: false, key: null, source: null };
  const configured = authState.loggedIn === true
    || authState.sessionActive === true
    || authState.subscriptionActive === true
    || hasValue(authState.accountId)
    || envInfo.configured;
  const authenticated = authState.authenticated === true
    || authState.loggedIn === true
    || authState.sessionActive === true
    || authState.subscriptionActive === true
    || (envInfo.configured && !revoked);
  return {
    type: "subscription",
    supported: capabilities.subscription === true,
    available: true,
    configured,
    authenticated,
    source: configured && !hasValue(authState.accountId) ? envInfo.source : "input",
    credentialKey: envInfo.key,
    lastError,
    expiresAt: expiresAt || null,
  };
}

export function normalizeProviderAuthState(providerId, authState = {}, options = {}) {
  const normalizedProviderId = normalizeProviderCapabilityId(providerId);
  const capabilitySnapshot = options.capabilities && typeof options.capabilities === "object"
    ? { ...getProviderCapabilities(normalizedProviderId), ...options.capabilities }
    : getProviderCapabilities(normalizedProviderId);
  const settingsState = resolveAdapterSettings(normalizedProviderId, options);
  const envState = resolveProviderAuthEnv(normalizedProviderId, options.env || process.env);
  const supportedModes = listProviderAuthModes(normalizedProviderId, capabilitySnapshot);
  const requestedMode = normalizeMethodName(
    options.preferredMode
    || authState.mode
    || authState.authMode
    || settingsState.authMode,
  );
  const methods = supportedModes
    .map((mode) => normalizeMethodState(mode, authState, envState, capabilitySnapshot))
    .sort((left, right) => AUTH_METHOD_ORDER.indexOf(left.type) - AUTH_METHOD_ORDER.indexOf(right.type));
  const preferredMethod =
    methods.find((entry) => entry.type === requestedMode)
    || methods.find((entry) => entry.authenticated)
    || methods.find((entry) => entry.configured)
    || methods[0]
    || null;
  const authenticated = capabilitySnapshot.auth === false || methods.some((entry) => entry.authenticated);
  const enabled = settingsState.enabled !== false;
  const available = enabled && (
    capabilitySnapshot.auth === false
    || methods.length === 0
    || methods.some((entry) => entry.available !== false)
  );
  const requiresAction = enabled
    && capabilitySnapshot.auth !== false
    && !!preferredMethod
    && preferredMethod.type !== "local"
    && !authenticated;
  let status = "unavailable";
  if (!enabled) {
    status = "disabled";
  } else if (capabilitySnapshot.auth === false) {
    status = "ready";
  } else if (!available) {
    status = "unavailable";
  } else if (preferredMethod?.type === "local" && preferredMethod.authenticated) {
    status = "local_ready";
  } else if (authenticated) {
    status = "authenticated";
  } else if (methods.some((entry) => entry.configured)) {
    status = "configured";
  } else {
    status = "unauthenticated";
  }
  return {
    providerId: normalizedProviderId,
    status,
    enabled,
    available,
    authenticated,
    canRun: enabled && (capabilitySnapshot.auth === false || authenticated || status === "local_ready"),
    requiresAction,
    preferredMode: preferredMethod?.type || null,
    supportedModes: unique(methods.map((entry) => entry.type)),
    capabilitySnapshot,
    methods,
    lastError: preferredMethod?.lastError || null,
    expiresAt: preferredMethod?.expiresAt || null,
    settings: settingsState,
    env: envState,
  };
}

export function createProviderAuthManager(defaultOptions = {}) {
  return {
    listAuthModes(providerId, capabilities = null) {
      return listProviderAuthModes(providerId, capabilities);
    },
    resolveEnv(providerId, env = defaultOptions.env || process.env) {
      return resolveProviderAuthEnv(providerId, env);
    },
    resolve(providerId, authState = {}, options = {}) {
      return normalizeProviderAuthState(providerId, authState, { ...defaultOptions, ...options });
    },
    isAuthenticated(providerId, authState = {}, options = {}) {
      return this.resolve(providerId, authState, options).authenticated;
    },
  };
}

export default createProviderAuthManager;
