/*
 * Session API path helpers.
 * Keeps workspace scoping explicit for /api/sessions/:id routes.
 */

function normalizeWorkspaceHint(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (lower === "all" || lower === "*") return "";
  if (lower === "active") return "active";
  return raw;
}

export function resolveSessionWorkspaceHint(session, fallback = "active") {
  const direct = String(session?.workspaceId || session?.workspace || "").trim();
  if (direct) return normalizeWorkspaceHint(direct);
  const metadata =
    session?.metadata && typeof session.metadata === "object"
      ? session.metadata
      : null;
  const fromMetadata = String(metadata?.workspaceId || "").trim();
  if (fromMetadata) return normalizeWorkspaceHint(fromMetadata);
  return normalizeWorkspaceHint(fallback);
}

export function buildSessionApiPath(sessionId, action = "", opts = {}) {
  const safeId = encodeURIComponent(String(sessionId || "").trim());
  if (!safeId) return "";
  const suffix = action ? `/${String(action || "").trim()}` : "";
  const path = `/api/sessions/${safeId}${suffix}`;
  const params = new URLSearchParams();

  const workspace = normalizeWorkspaceHint(opts?.workspace);
  if (workspace) params.set("workspace", workspace);

  if (opts?.query && typeof opts.query === "object") {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value == null) continue;
      const stringValue = String(value).trim();
      if (!stringValue) continue;
      params.set(key, stringValue);
    }
  }

  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
