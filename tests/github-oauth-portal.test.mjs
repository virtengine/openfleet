/**
 * Tests for github-oauth-portal.mjs
 *
 * Covers:
 *  - isPortalRunning() returns false when not running
 *  - startOAuthPortal() starts server on port 54317 (or randomised port for tests)
 *  - GET / returns 200 HTML
 *  - GET /api/status returns JSON
 *  - POST /webhook with invalid signature returns 401
 *  - POST /webhook with valid signature returns 200
 *  - stopOAuthPortal() stops server cleanly
 */

import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────────

// We hoist mock factories so they run before imports
const mockExchangeOAuthCode = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    accessToken: "test-access-token",
    tokenType: "bearer",
    scope: "repo",
  }),
);

const mockGetOAuthUser = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ login: "octocat", id: 1, name: "Octocat", email: null }),
);

const mockVerifyAppWebhookSignature = vi.hoisted(() =>
  vi.fn().mockImplementation((body, sig) => {
    // Verify against test secret "test-webhook-secret"
    const testSecret = process.env.BOSUN_GITHUB_WEBHOOK_SECRET || "";
    if (!testSecret || !sig?.startsWith("sha256=")) return false;
    const expected = `sha256=${createHmac("sha256", testSecret).update(body).digest("hex")}`;
    return expected === sig;
  }),
);

const mockIsAppConfigured = vi.hoisted(() => vi.fn().mockReturnValue(false));
const mockIsOAuthConfigured = vi.hoisted(() => vi.fn().mockReturnValue(true));
const mockGetAppId = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockSaveOAuthState = vi.hoisted(() => vi.fn());
const mockLoadOAuthState = vi.hoisted(() => vi.fn().mockReturnValue(null));

vi.mock("../github/github-app-auth.mjs", () => ({
  signAppJWT: vi.fn(() => "test-jwt"),
  getInstallationToken: vi.fn(),
  getInstallationTokenForRepo: vi.fn(),
  exchangeOAuthCode: mockExchangeOAuthCode,
  getOAuthUser: mockGetOAuthUser,
  verifyAppWebhookSignature: mockVerifyAppWebhookSignature,
  isAppConfigured: mockIsAppConfigured,
  isOAuthConfigured: mockIsOAuthConfigured,
  getAppId: mockGetAppId,
  saveOAuthState: mockSaveOAuthState,
  loadOAuthState: mockLoadOAuthState,
  startDeviceFlow: vi.fn(),
  pollDeviceToken: vi.fn(),
  resetPrivateKeyCache: vi.fn(),
  getUserToken: vi.fn().mockReturnValue(null),
  getBestToken: vi.fn().mockResolvedValue(null),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function signBody(secret, body) {
  const digest = createHmac("sha256", secret)
    .update(typeof body === "string" ? body : body)
    .digest("hex");
  return `sha256=${digest}`;
}

async function getPortal() {
  return await import("../github/github-oauth-portal.mjs");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("github-oauth-portal", () => {
  let portal;
  let server;
  let baseUrl;
  const WEBHOOK_SECRET = "test-webhook-secret";

  const ENV_KEYS = [
    "BOSUN_GITHUB_CLIENT_ID",
    "BOSUN_GITHUB_CLIENT_SECRET",
    "BOSUN_GITHUB_WEBHOOK_SECRET",
    "BOSUN_GITHUB_APP_ID",
    "BOSUN_GITHUB_PRIVATE_KEY_PATH",
    "BOSUN_GITHUB_USER_TOKEN",
  ];
  let envSnapshot = {};

  beforeEach(async () => {
    envSnapshot = Object.fromEntries(
      ENV_KEYS.map((k) => [k, process.env[k]]),
    );
    process.env.BOSUN_GITHUB_WEBHOOK_SECRET = WEBHOOK_SECRET;
    vi.clearAllMocks();
    // Re-apply default mock return values after clearAllMocks
    mockLoadOAuthState.mockReturnValue(null);
    mockIsAppConfigured.mockReturnValue(false);
    mockIsOAuthConfigured.mockReturnValue(true);
    mockGetAppId.mockReturnValue(null);
    mockVerifyAppWebhookSignature.mockImplementation((body, sig) => {
      const secret = process.env.BOSUN_GITHUB_WEBHOOK_SECRET || "";
      if (!secret || !sig?.startsWith("sha256=")) return false;
      const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
      return expected === sig;
    });

    portal = await getPortal();
    portal.webhookEvents.removeAllListeners();
  });

  afterEach(async () => {
    // Always stop the server
    try {
      await portal.stopOAuthPortal();
    } catch {
      // Ignore if already stopped
    }
    server = null;
    baseUrl = null;

    for (const key of ENV_KEYS) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  // ── isPortalRunning ────────────────────────────────────────────────────────

  it("isPortalRunning() returns false when server is not running", async () => {
    // Use an unlikely port; server hasn't started yet
    const running = await portal.isPortalRunning(19999);
    expect(running).toBe(false);
  });

  // ── startOAuthPortal ───────────────────────────────────────────────────────

  it("startOAuthPortal() starts the server and returns port/url/webhookEvents", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;
    const addr = server.address();

    expect(result.port).toBe(addr.port);
    expect(typeof result.port).toBe("number");
    expect(result.url).toContain("127.0.0.1");
    expect(typeof result.webhookEvents?.on).toBe("function");
  });

  it("startOAuthPortal() returns same server on second call", async () => {
    const r1 = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = r1.server;
    baseUrl = r1.url;
    const r2 = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    expect(r1.server).toBe(r2.server);
  });

  // ── GET / ──────────────────────────────────────────────────────────────────

  it("GET / returns 200 with HTML", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("<!DOCTYPE html>");
    expect(text).toContain("Bosun");
    expect(text).toContain("github/callback");
    expect(text).toContain("Device Flow");
    expect(text).toContain("Setup URL");
  });

  it("GET / shows authenticated user when state is saved", async () => {
    mockLoadOAuthState.mockReturnValue({
      user: { login: "octocat", id: 1 },
      accessToken: "tok",
      tokenType: "bearer",
      scope: "repo",
      savedAt: new Date().toISOString(),
      installationIds: [],
    });

    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const res = await fetch(`${baseUrl}/`);
    const text = await res.text();
    expect(text).toContain("octocat");
  });

  // ── GET /api/status ────────────────────────────────────────────────────────

  it("GET /api/status returns JSON with expected keys", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.configured).toBe("boolean");
    expect(typeof json.authenticated).toBe("boolean");
    expect("user" in json).toBe(true);
    expect(typeof json.installationCount).toBe("number");
    expect(typeof json.webhookSecret).toBe("boolean");
    expect(json.webhookSecret).toBe(true); // BOSUN_GITHUB_WEBHOOK_SECRET is set
  });

  it("GET /api/status reflects authenticated state", async () => {
    mockLoadOAuthState.mockReturnValue({
      user: { login: "octocat", id: 1 },
      accessToken: "tok",
      tokenType: "bearer",
      scope: "repo",
      savedAt: new Date().toISOString(),
      installationIds: [12345],
    });

    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const res = await fetch(`${baseUrl}/api/status`);
    const json = await res.json();
    expect(json.authenticated).toBe(true);
    expect(json.user?.login).toBe("octocat");
    expect(json.installationCount).toBe(1);
  });

  // ── POST /webhook — invalid signature ─────────────────────────────────────

  it("POST /webhook with invalid signature returns 401", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const body = JSON.stringify({ action: "created" });
    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "installation",
        "X-Hub-Signature-256": "sha256=invalid",
      },
      body,
    });

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  // ── POST /webhook — valid signature ───────────────────────────────────────

  it("POST /webhook with valid signature returns 200", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const body = JSON.stringify({ action: "created" });
    const sig = signBody(WEBHOOK_SECRET, body);

    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "installation",
        "X-Hub-Signature-256": sig,
      },
      body,
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("POST /webhook emits correct events for bosun commands", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const events = [];
    result.webhookEvents.on("github:issue_comment", (event) => events.push(`issue:${event.action}`));
    result.webhookEvents.on("bosun:command:status", () => events.push("status"));
    result.webhookEvents.on("bosun:command:run", (e) => events.push(`run:${e.taskId}`));
    result.webhookEvents.on("bosun:command:retry", () => events.push("retry"));
    result.webhookEvents.on("bosun:command:assign", (e) => events.push(`assign:${e.arg}`));
    result.webhookEvents.on("bosun:mention", () => events.push("mention"));

    const comment = "/bosun status\n/bosun run task-123\n/bosun retry\n/bosun assign octocat\n@bosun-ve hello";
    const body = JSON.stringify({
      action: "created",
      comment: { body: comment },
    });
    const sig = signBody(WEBHOOK_SECRET, body);

    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issue_comment",
        "X-Hub-Signature-256": sig,
      },
      body,
    });

    // Small delay for event propagation
    await new Promise((r) => setTimeout(r, 20));

    expect(events).toContain("status");
    expect(events).toContain("run:task-123");
    expect(events).toContain("retry");
    expect(events).toContain("assign:octocat");
    expect(events).toContain("mention");
    expect(events).toContain("issue:created");
  });

  it("POST /webhook emits issue_comment events without processing edited comments", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const events = [];
    result.webhookEvents.on("github:issue_comment", (event) => events.push(`issue:${event.action}`));
    result.webhookEvents.on("bosun:command:status", () => events.push("status"));
    result.webhookEvents.on("bosun:mention", () => events.push("mention"));

    const body = JSON.stringify({
      action: "edited",
      comment: { body: "/bosun status\n@bosun-ve hello" },
    });
    const sig = signBody(WEBHOOK_SECRET, body);

    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "issue_comment",
        "X-Hub-Signature-256": sig,
      },
      body,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(events).toEqual(["issue:edited"]);
  });

  it("POST /webhook processes pull request review comments", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const events = [];
    result.webhookEvents.on("github:pull_request_review_comment", (event) => {
      events.push(`review:${event.action}`);
    });
    result.webhookEvents.on("bosun:command:run", (event) => events.push(`run:${event.taskId}`));
    result.webhookEvents.on("bosun:command:note", (event) => events.push(`note:${event.arg}`));
    result.webhookEvents.on("bosun:mention", () => events.push("mention"));

    const body = JSON.stringify({
      action: "edited",
      comment: { body: "/bosun run task-456\n/bosun note follow-up\n@bosun-ve hello" },
    });
    const sig = signBody(WEBHOOK_SECRET, body);

    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request_review_comment",
        "X-Hub-Signature-256": sig,
      },
      body,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(events).toContain("review:edited");
    expect(events).toContain("run:task-456");
    expect(events).toContain("note:follow-up");
    expect(events).toContain("mention");
  });

  it("POST /webhook emits github:pull_request_review on review submitted", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const events = [];
    result.webhookEvents.on("github:pull_request_review", (event) => {
      events.push(`review:${event.action}`);
    });

    const body = JSON.stringify({
      action: "submitted",
      review: { user: { login: "some-user" }, state: "approved" },
      pull_request: { number: 99 },
      repository: { full_name: "test/repo" },
    });
    const sig = signBody(WEBHOOK_SECRET, body);

    await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "pull_request_review",
        "X-Hub-Signature-256": sig,
      },
      body,
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(events).toContain("review:submitted");
  });

  // ── 404 ───────────────────────────────────────────────────────────────────

  it("unknown route returns 404", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    baseUrl = result.url;

    const res = await fetch(`${baseUrl}/nonexistent-path`);
    expect(res.status).toBe(404);
  });

  // ── stopOAuthPortal ────────────────────────────────────────────────────────

  it("stopOAuthPortal() stops server cleanly", async () => {
    const result = await portal.startOAuthPortal({ port: 0, host: "127.0.0.1", quiet: true });
    server = result.server;
    const listenPort = result.port;

    // Confirm it's running
    const res = await fetch(`${result.url}/api/status`);
    expect(res.status).toBe(200);

    await portal.stopOAuthPortal();
    server = null; // prevent afterEach from trying again

    // Confirm it's stopped
    const stillRunning = await portal.isPortalRunning(listenPort);
    expect(stillRunning).toBe(false);
  });

  it("stopOAuthPortal() is idempotent (no error if already stopped)", async () => {
    await expect(portal.stopOAuthPortal()).resolves.toBeUndefined();
  });

  // ── webhookEvents export ───────────────────────────────────────────────────

  it("exports webhookEvents EventEmitter", async () => {
    expect(typeof portal.webhookEvents.on).toBe("function");
    expect(typeof portal.webhookEvents.emit).toBe("function");
    expect(typeof portal.webhookEvents.off).toBe("function");
  });
});
