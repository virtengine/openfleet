import assert from "node:assert/strict";
import {
  createHmac,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

let moduleImportNonce = 0;

function setEnv(t, entries) {
  const snapshot = new Map();
  for (const [key, value] of Object.entries(entries)) {
    snapshot.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  t.after(() => {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function createTempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function setupIsolatedHome(t) {
  const home = createTempDir(t, "github-app-auth-home-");
  setEnv(t, {
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: undefined,
    HOMEPATH: undefined,
  });
  return home;
}

async function loadGithubAppAuth() {
  const moduleUrl = new URL("../github-app-auth.mjs", import.meta.url);
  moduleImportNonce += 1;
  moduleUrl.searchParams.set("node_test", String(moduleImportNonce));
  return import(moduleUrl.href);
}

function createKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs1", format: "pem" }),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  };
}

function base64urlToBuffer(value) {
  const padding = value.length % 4 === 0 ? "" : "=".repeat(4 - (value.length % 4));
  const b64 = `${value.replace(/-/g, "+").replace(/_/g, "/")}${padding}`;
  return Buffer.from(b64, "base64");
}

function parseJwt(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "JWT must have three sections");
  const header = JSON.parse(base64urlToBuffer(parts[0]).toString("utf8"));
  const payload = JSON.parse(base64urlToBuffer(parts[1]).toString("utf8"));
  return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2] };
}

function verifyJwtSignature(token, publicKeyPem) {
  const parsed = parseJwt(token);
  const verifier = createVerify("SHA256");
  verifier.update(parsed.signingInput);
  verifier.end();
  return verifier.verify(publicKeyPem, base64urlToBuffer(parsed.signature));
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function textResponse(status, text) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return {};
    },
    async text() {
      return text;
    },
  };
}

function withFetchMock(t, queue) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (queue.length === 0) {
      throw new Error(`Unexpected fetch call for ${String(url)}`);
    }
    const next = queue.shift();
    if (typeof next === "function") {
      return next(url, options);
    }
    return next;
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

function writePrivateKey(path, key) {
  writeFileSync(path, key.privateKeyPem, "utf8");
}

test("signAppJWT emits RS256 token with expected claims and valid signature", async (t) => {
  const dir = createTempDir(t, "github-app-auth-jwt-");
  const key = createKeyPair();
  const keyPath = join(dir, "app.pem");
  writePrivateKey(keyPath, key);

  setEnv(t, {
    BOSUN_GITHUB_APP_ID: "2911413",
    BOSUN_GITHUB_PRIVATE_KEY_PATH: keyPath,
  });

  const fixedEpochMs = Date.UTC(2026, 1, 26, 12, 0, 0);
  const originalNow = Date.now;
  Date.now = () => fixedEpochMs;
  t.after(() => {
    Date.now = originalNow;
  });

  const auth = await loadGithubAppAuth();
  const token = auth.signAppJWT();
  const parsed = parseJwt(token);

  assert.deepEqual(parsed.header, { alg: "RS256", typ: "JWT" });
  assert.equal(parsed.payload.iss, "2911413");
  assert.equal(parsed.payload.iat, Math.floor(fixedEpochMs / 1000) - 60);
  assert.equal(parsed.payload.exp, Math.floor(fixedEpochMs / 1000) + 600);
  assert.equal(verifyJwtSignature(token, key.publicKeyPem), true);
});

test("signAppJWT reuses cached key until resetPrivateKeyCache is called", async (t) => {
  const dir = createTempDir(t, "github-app-auth-cache-");
  const keyA = createKeyPair();
  const keyB = createKeyPair();
  const keyPathA = join(dir, "a.pem");
  const keyPathB = join(dir, "b.pem");
  writePrivateKey(keyPathA, keyA);
  writePrivateKey(keyPathB, keyB);

  setEnv(t, {
    BOSUN_GITHUB_APP_ID: "2911413",
    BOSUN_GITHUB_PRIVATE_KEY_PATH: keyPathA,
  });

  const auth = await loadGithubAppAuth();
  const tokenA = auth.signAppJWT();
  assert.equal(verifyJwtSignature(tokenA, keyA.publicKeyPem), true);

  process.env.BOSUN_GITHUB_PRIVATE_KEY_PATH = keyPathB;
  const tokenBeforeReset = auth.signAppJWT();
  assert.equal(verifyJwtSignature(tokenBeforeReset, keyA.publicKeyPem), true);
  assert.equal(verifyJwtSignature(tokenBeforeReset, keyB.publicKeyPem), false);

  auth.resetPrivateKeyCache();
  const tokenAfterReset = auth.signAppJWT();
  assert.equal(verifyJwtSignature(tokenAfterReset, keyB.publicKeyPem), true);
});

test("getInstallationToken calls GitHub API and returns token payload", async (t) => {
  const dir = createTempDir(t, "github-app-auth-install-");
  const key = createKeyPair();
  const keyPath = join(dir, "app.pem");
  writePrivateKey(keyPath, key);

  setEnv(t, {
    BOSUN_GITHUB_APP_ID: "2911413",
    BOSUN_GITHUB_PRIVATE_KEY_PATH: keyPath,
  });

  const calls = withFetchMock(t, [
    jsonResponse(201, {
      token: "ghs_install_token",
      expires_at: "2026-02-26T13:00:00Z",
    }),
  ]);

  const auth = await loadGithubAppAuth();
  const result = await auth.getInstallationToken(12345);

  assert.deepEqual(result, {
    token: "ghs_install_token",
    expiresAt: "2026-02-26T13:00:00Z",
  });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.github.com/app/installations/12345/access_tokens",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.equal(
    calls[0].options.headers.Authorization.startsWith("Bearer "),
    true,
  );
});

test("getInstallationToken surfaces non-2xx responses with status and body", async (t) => {
  const dir = createTempDir(t, "github-app-auth-install-error-");
  const key = createKeyPair();
  const keyPath = join(dir, "app.pem");
  writePrivateKey(keyPath, key);

  setEnv(t, {
    BOSUN_GITHUB_APP_ID: "2911413",
    BOSUN_GITHUB_PRIVATE_KEY_PATH: keyPath,
  });

  withFetchMock(t, [textResponse(401, "bad credentials")]);
  const auth = await loadGithubAppAuth();

  await assert.rejects(
    auth.getInstallationToken(555),
    /GitHub installation token request failed 401: bad credentials/,
  );
});

test("getInstallationTokenForRepo resolves installation ID then fetches token", async (t) => {
  const dir = createTempDir(t, "github-app-auth-install-repo-");
  const key = createKeyPair();
  const keyPath = join(dir, "app.pem");
  writePrivateKey(keyPath, key);

  setEnv(t, {
    BOSUN_GITHUB_APP_ID: "2911413",
    BOSUN_GITHUB_PRIVATE_KEY_PATH: keyPath,
  });

  const calls = withFetchMock(t, [
    jsonResponse(200, { id: 777 }),
    jsonResponse(201, {
      token: "ghs_repo_install_token",
      expires_at: "2026-02-26T13:00:00Z",
    }),
  ]);

  const auth = await loadGithubAppAuth();
  const result = await auth.getInstallationTokenForRepo("virtengine", "bosun");

  assert.deepEqual(result, {
    token: "ghs_repo_install_token",
    expiresAt: "2026-02-26T13:00:00Z",
    installationId: 777,
  });
  assert.equal(calls.length, 2);
  assert.equal(
    calls[0].url,
    "https://api.github.com/repos/virtengine/bosun/installation",
  );
  assert.equal(
    calls[1].url,
    "https://api.github.com/app/installations/777/access_tokens",
  );
});

test("getInstallationTokenForRepo throws explicit repo-installation lookup errors", async (t) => {
  const dir = createTempDir(t, "github-app-auth-install-repo-error-");
  const key = createKeyPair();
  const keyPath = join(dir, "app.pem");
  writePrivateKey(keyPath, key);

  setEnv(t, {
    BOSUN_GITHUB_APP_ID: "2911413",
    BOSUN_GITHUB_PRIVATE_KEY_PATH: keyPath,
  });

  withFetchMock(t, [textResponse(404, "installation not found")]);
  const auth = await loadGithubAppAuth();

  await assert.rejects(
    auth.getInstallationTokenForRepo("virtengine", "missing"),
    /Could not find GitHub App installation for virtengine\/missing \(404\): installation not found/,
  );
});

test("getInstallationTokenForRepo propagates installation-token exchange errors", async (t) => {
  const dir = createTempDir(t, "github-app-auth-install-token-error-");
  const key = createKeyPair();
  const keyPath = join(dir, "app.pem");
  writePrivateKey(keyPath, key);

  setEnv(t, {
    BOSUN_GITHUB_APP_ID: "2911413",
    BOSUN_GITHUB_PRIVATE_KEY_PATH: keyPath,
  });

  withFetchMock(t, [
    jsonResponse(200, { id: 888 }),
    textResponse(500, "upstream error"),
  ]);
  const auth = await loadGithubAppAuth();

  await assert.rejects(
    auth.getInstallationTokenForRepo("virtengine", "bosun"),
    /GitHub installation token request failed 500: upstream error/,
  );
});

test("verifyAppWebhookSignature validates known-good signatures and rejects bad input", async (t) => {
  setEnv(t, { BOSUN_GITHUB_WEBHOOK_SECRET: "super-secret" });
  const auth = await loadGithubAppAuth();
  const body = JSON.stringify({ action: "created", installation: { id: 42 } });
  const validSig = `sha256=${createHmac("sha256", "super-secret").update(body).digest("hex")}`;

  assert.equal(auth.verifyAppWebhookSignature(body, validSig), true);
  assert.equal(auth.verifyAppWebhookSignature(Buffer.from(body), validSig), true);
  assert.equal(auth.verifyAppWebhookSignature(body, "sha1=abc"), false);
  assert.equal(auth.verifyAppWebhookSignature(body, "sha256=deadbeef"), false);
  assert.equal(auth.verifyAppWebhookSignature(body, ""), false);
});

test("verifyAppWebhookSignature rejects all requests when webhook secret is absent", async (t) => {
  setEnv(t, { BOSUN_GITHUB_WEBHOOK_SECRET: undefined });
  const auth = await loadGithubAppAuth();
  const body = "payload";
  const sig = `sha256=${createHmac("sha256", "wrong").update(body).digest("hex")}`;
  assert.equal(auth.verifyAppWebhookSignature(body, sig), false);
});

test("saveOAuthState and loadOAuthState persist state in ~/.bosun/github-auth-state.json", async (t) => {
  const home = setupIsolatedHome(t);
  const auth = await loadGithubAppAuth();

  const state = {
    user: { login: "octocat", id: 1 },
    accessToken: "oauth-token",
    tokenType: "bearer",
    scope: "repo",
    savedAt: "2026-02-26T12:00:00.000Z",
    installationIds: [111, 222],
  };

  auth.saveOAuthState(state);

  const statePath = join(home, ".bosun", "github-auth-state.json");
  assert.equal(existsSync(statePath), true);
  assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), state);
  assert.deepEqual(auth.loadOAuthState(), state);
  assert.equal(auth.getUserToken(), "oauth-token");
});

test("loadOAuthState returns null for malformed state file and getUserToken falls back to env", async (t) => {
  const home = setupIsolatedHome(t);
  const stateDir = join(home, ".bosun");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "github-auth-state.json"), "{not-json", "utf8");
  setEnv(t, { BOSUN_GITHUB_USER_TOKEN: "env-user-token" });

  const auth = await loadGithubAppAuth();
  assert.equal(auth.loadOAuthState(), null);
  assert.equal(auth.getUserToken(), "env-user-token");
});
