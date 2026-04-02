import {
  buildHarnessProviderSdkPath,
  buildHarnessThreadPath,
} from "../ui/modules/harness-client.js";

function appendWorkspace(path, workspace = "all") {
  if (!workspace) return path;
  return `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(workspace)}`;
}

export function createTelegramHarnessApiClient(request) {
  if (typeof request !== "function") {
    throw new Error("createTelegramHarnessApiClient requires a request function");
  }

  return {
    async createSession(body = {}) {
      return request("/api/sessions/create", {
        method: "POST",
        body,
      });
    },
    async getSession(sessionId, options = {}) {
      const query = new URLSearchParams();
      query.set("workspace", String(options.workspace || "all"));
      if (options.full !== false) query.set("full", "1");
      if (options.limit != null) query.set("limit", String(options.limit));
      if (options.offset != null) query.set("offset", String(options.offset));
      return request(`/api/sessions/${encodeURIComponent(sessionId)}?${query.toString()}`);
    },
    async sendSessionMessage(sessionId, body = {}, workspace = "all") {
      return request(appendWorkspace(`/api/sessions/${encodeURIComponent(sessionId)}/message`, workspace), {
        method: "POST",
        body,
      });
    },
    async stopSession(sessionId, workspace = "all") {
      return request(appendWorkspace(`/api/sessions/${encodeURIComponent(sessionId)}/stop`, workspace), {
        method: "POST",
      });
    },
    async deleteSession(sessionId, workspace = "all") {
      return request(appendWorkspace(`/api/sessions/${encodeURIComponent(sessionId)}/delete`, workspace), {
        method: "POST",
      });
    },
    async getProviderSelection() {
      return request(buildHarnessProviderSdkPath());
    },
    async setProviderSelection(sdk) {
      return request(buildHarnessProviderSdkPath(), {
        method: "POST",
        body: { sdk },
      });
    },
    async listThreads() {
      return request(buildHarnessThreadPath());
    },
    async clearThreads() {
      return request(buildHarnessThreadPath("", "reset"), {
        method: "POST",
      });
    },
    async invalidateThread(taskKey) {
      return request(buildHarnessThreadPath(taskKey, "invalidate"), {
        method: "POST",
      });
    },
  };
}
