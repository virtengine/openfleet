import { apiFetch } from "./api.js";
import { buildSessionApiPath } from "./session-api.js";

export async function updateSessionSurface(sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw new Error("Session id is required");
  }
  const workspace = String(options?.workspace || "active").trim() || "active";
  const path = buildSessionApiPath(normalizedSessionId, "surface", { workspace });
  if (!path) {
    throw new Error("Session path unavailable");
  }
  const body = {
    ...(options && typeof options === "object" ? options : {}),
  };
  delete body.workspace;
  return apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function loadSessionBranches(sessionId, options = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  if (!normalizedSessionId) {
    throw new Error("Session id is required");
  }
  const workspace = String(options?.workspace || "active").trim() || "active";
  const repoPath = String(options?.repoPath || "").trim();
  const query = repoPath ? { repoPath } : undefined;
  const path = buildSessionApiPath(normalizedSessionId, "branches", {
    workspace,
    query,
  });
  if (!path) {
    throw new Error("Session path unavailable");
  }
  return apiFetch(path, { _silent: true });
}

export function replaceSessionInList(sessions, nextSession) {
  const list = Array.isArray(sessions) ? sessions : [];
  const normalizedSessionId = String(nextSession?.id || "").trim();
  if (!normalizedSessionId) return list.slice();
  let replaced = false;
  const nextList = list.map((session) => {
    if (String(session?.id || "").trim() !== normalizedSessionId) return session;
    replaced = true;
    return {
      ...session,
      ...nextSession,
      metadata: {
        ...(session?.metadata && typeof session.metadata === "object" ? session.metadata : {}),
        ...(nextSession?.metadata && typeof nextSession.metadata === "object" ? nextSession.metadata : {}),
      },
      surface: nextSession?.surface || session?.surface || null,
    };
  });
  if (!replaced) nextList.unshift(nextSession);
  return nextList;
}
