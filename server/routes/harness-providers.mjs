function toTrimmedString(value) {
  return String(value ?? "").trim();
}

function buildProviderSelectionPayload(deps = {}) {
  return {
    poolSdk: toTrimmedString(deps.getPoolSdkName?.() || "") || null,
    primaryAgent: toTrimmedString(deps.getPrimaryAgentName?.() || "") || null,
    availableSdks: Array.isArray(deps.getAvailableSdks?.())
      ? deps.getAvailableSdks()
      : [],
  };
}

export function getHarnessProviderSelection(deps = {}) {
  return buildProviderSelectionPayload(deps);
}

export async function tryHandleHarnessProviderRoutes(context = {}) {
  const { req, res, path, deps = {} } = context;
  const {
    jsonResponse,
    buildResolvedSettingsState,
    buildProviderInventory,
    readJsonBody,
  } = deps;

  if (path === "/api/providers" && req.method === "GET") {
    try {
      const { rawValues } = buildResolvedSettingsState();
      jsonResponse(res, 200, {
        ok: true,
        ...buildProviderInventory(rawValues),
        selection: buildProviderSelectionPayload(deps),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/providers/sdk" && req.method === "GET") {
    try {
      jsonResponse(res, 200, {
        ok: true,
        selection: buildProviderSelectionPayload(deps),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  if (path === "/api/providers/sdk" && req.method === "POST") {
    try {
      const body = await readJsonBody(req).catch(() => ({}));
      const target = toTrimmedString(body?.sdk || body?.provider || "").toLowerCase();
      if (!target) {
        jsonResponse(res, 400, { ok: false, error: "sdk is required" });
        return true;
      }
      if (target === "auto" || target === "reset") {
        deps.resetPoolSdkCache?.();
        jsonResponse(res, 200, {
          ok: true,
          reset: true,
          selection: buildProviderSelectionPayload(deps),
        });
        return true;
      }

      const available = new Set(
        (Array.isArray(deps.getAvailableSdks?.()) ? deps.getAvailableSdks() : [])
          .map((entry) => toTrimmedString(entry).toLowerCase())
          .filter(Boolean),
      );
      if (available.size > 0 && !available.has(target)) {
        jsonResponse(res, 400, {
          ok: false,
          error: `Unknown sdk: ${target}`,
          availableSdks: [...available],
        });
        return true;
      }

      deps.setPoolSdk?.(target);
      const switchResult = await deps.switchPrimaryAgent?.(`${target}-sdk`);
      jsonResponse(res, switchResult?.ok === false ? 409 : 200, {
        ok: switchResult?.ok !== false,
        target,
        switchResult: switchResult || null,
        selection: buildProviderSelectionPayload(deps),
      });
    } catch (err) {
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
    return true;
  }

  return false;
}
