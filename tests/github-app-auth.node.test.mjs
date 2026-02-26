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
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const MODULE_URL = pathToFileURL(resolve(process.cwd(), "github-app-auth.mjs")).href;

const ENV_KEYS = [
  "BOSUN_GITHUB_APP_ID",
  "BOSUN_GITHUB_PRIVATE_KEY_PATH",
  "BOSUN_GITHUB_WEBHOOK_SECRET",
  "BOSUN_GITHUB_USER_TOKEN",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
];

let envSnapshot = {};
let originalFetch = globalThis.fetch;
let originalDateNow = Date.now;
let importCounter = 0;
let tempDirs = [];

function snapshotEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
}

function createTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs() {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
}

function setTempHome(homePath) {
  process.env.HOME = homePath;
  process.env.USERPROFILE = homePath;
  delete process.env.HOMEDRIVE;
  delete process.env.HOMEPATH;
}

function createRsaKeyPairPem() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs1" }),
    publicKeyPem: publicKey.export({ format: "pem", type: "pkcs1" }),
  };
}

function writePrivateKey(dir, name) {
  const { privateKeyPem, publicKeyPem } = createRsaKeyPairPem();
  const privateKeyPath = join(dir, `${name}.pem`);
  writeFileSync(privateKeyPath, privateKeyPem, "utf8");
  return { privateKeyPath, publicKeyPem };
}

function fromBase64Url(value) {
  const padLength = (4 - (value.length % 4)) % 4;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padLength);
  return Buffer.from(padded, "base64");
}

function parseJwt(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3, "JWT must have three segments");
  const [headerSeg, payloadSeg, signatureSeg] = parts;
  const header = JSON.parse(fromBase64Url(headerSeg).toString("utf8"));
  const payload = JSON.parse(fromBase64Url(payloadSeg).toString("utf8"));
  return {
    header,
    payload,
    signingInput: `${headerSeg}.${payloadSeg}`,
    signature: fromBase64Url(signatureSeg),
  };
}

function verifyJwtSignature(token, publicKeyPem) {
  const parsed = parseJwt(token);
  const verifier = createVerify("SHA256");
  verifier.update(parsed.signingInput);
  return verifier.verify(publicKeyPem, parsed.signature);
}

function createMockResponse({ status = 200, jsonBody, textBody }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      if (jsonBody !== undefined) return jsonBody;
      if (textBody !== undefined) return JSON.parse(textBody);
      return {};
    },
    async text() {
      if (textBody !== undefined) return String(textBody);
      if (jsonBody !== undefined) return JSON.stringify(jsonBody);
      return "";
    },
  };
}

function mockFetchSequence(sequence, calls) {
  let callIndex = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    callIndex += 1;
    const next = sequence[callIndex - 1];
    if (!next) {
      throw new Error(`Unexpected fetch call #${callIndex}: ${String(url)}`);
    }
    if (typeof next === "function") return next(url, init);
    return createMockResponse(next);
  };
}

async function importGithubAppAuthFresh() {
  importCounter += 1;
  return import(`${MODULE_URL}?test_case=${importCounter}`);
}

beforeEach(() => {
  envSnapshot = snapshotEnv();
  originalFetch = globalThis.fetch;
  originalDateNow = Date.now;
});

afterEach(() => {
  restoreEnv(envSnapshot);
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  cleanupTempDirs();
});

describe("github-app-auth JWT helpers", () => {
  it("signs JWTs with required claims and a verifiable RS256 signature", async () => {
    const keyDir = createTempDir("github-app-auth-key-");
    const { privateKeyPath, publicKeyPem } = writePrivateKey(keyDir, "app-key");
    process.env.BOSUN_GITHUB_APP_ID = "2911413";
    process.env.BOSUN_GITHUB_PRIVATE_KEY_PATH = privateKeyPath;
    Date.now = () => 1_700_000_000_000;

    const { signAppJWT } = await importGithubAppAuthFresh();
    const token = signAppJWT();
    const parsed = parseJwt(token);

    assert.deepEqual(parsed.header, { alg: "RS256", typ: "JWT" });
    assert.equal(parsed.payload.iss, "2911413");
    assert.equal(parsed.payload.iat, 1_700_000_000 - 60);
    assert.equal(parsed.payload.exp, 1_700_000_000 + 600);
    assert.equal(verifyJwtSignature(token, publicKeyPem), true);
  });

  it("caches the private key until resetPrivateKeyCache() is called", async () => {
    const keyDir = createTempDir("github-app-auth-cache-");
    const keyA = writePrivateKey(keyDir, "key-a");
    const keyB = writePrivateKey(keyDir, "key-b");
    process.env.BOSUN_GITHUB_APP_ID = "2911413";
    Date.now = () => 1_700_000_123_000;

    const mod = await importGithubAppAuthFresh();

    process.env.BOSUN_GITHUB_PRIVATE_KEY_PATH = keyA.privateKeyPath;
    const tokenA = mod.signAppJWT();

    process.env.BOSUN_GITHUB_PRIVATE_KEY_PATH = keyB.privateKeyPath;
    const tokenB = mod.signAppJWT();

    assert.equal(tokenA, tokenB);
    assert.equal(verifyJwtSignature(tokenB, keyA.publicKeyPem), true);
    assert.equal(verifyJwtSignature(tokenB, keyB.publicKeyPem), false);

    mod.resetPrivateKeyCache();
    const tokenC = mod.signAppJWT();
    assert.notEqual(tokenC, tokenA);
    assert.equal(verifyJwtSignature(tokenC, keyB.publicKeyPem), true);
  });

  it("throws deterministic errors when required JWT env vars are missing", async () => {
    const mod = await importGithubAppAuthFresh();
    assert.throws(
      () => mod.signAppJWT(),
      /BOSUN_GITHUB_APP_ID is not set/,
    );

    process.env.BOSUN_GITHUB_APP_ID = "2911413";
    assert.throws(
      () => mod.signAppJWT(),
      /BOSUN_GITHUB_PRIVATE_KEY_PATH is not set/,
    );
  });
});

describe("github-app-auth webhook signature verification", () => {
  it("accepts valid signatures and rejects tampered payloads", async () => {
    process.env.BOSUN_GITHUB_WEBHOOK_SECRET = "webhook-secret";
    const { verifyAppWebhookSignature } = await importGithubAppAuthFresh();

    const body = Buffer.from('{"action":"created","id":42}');
    const signature = `sha256=${createHmac("sha256", "webhook-secret").update(body).digest("hex")}`;

    assert.equal(verifyAppWebhookSignature(body, signature), true);
    assert.equal(
      verifyAppWebhookSignature('{"action":"edited","id":42}', signature),
      false,
    );
  });

  it("rejects missing secret, malformed headers, and size mismatches", async () => {
    const { verifyAppWebhookSignature } = await importGithubAppAuthFresh();
    const body = Buffer.from('{"event":"installation"}');

    assert.equal(verifyAppWebhookSignature(body, "sha256=abc"), false);

    process.env.BOSUN_GITHUB_WEBHOOK_SECRET = "webhook-secret";
    assert.equal(verifyAppWebhookSignature(body, ""), false);
    assert.equal(verifyAppWebhookSignature(body, "sha1=abcdef"), false);
    assert.equal(verifyAppWebhookSignature(body, "sha256=deadbeef"), false);
  });
});

describe("github-app-auth installation token flows", () => {
  function configureAppKey() {
    const keyDir = createTempDir("github-app-auth-install-");
    const { privateKeyPath } = writePrivateKey(keyDir, "install-key");
    process.env.BOSUN_GITHUB_APP_ID = "2911413";
    process.env.BOSUN_GITHUB_PRIVATE_KEY_PATH = privateKeyPath;
  }

  it("fetches an installation token and returns normalized fields", async () => {
    configureAppKey();
    const fetchCalls = [];
    mockFetchSequence(
      [
        {
          status: 201,
          jsonBody: {
            token: "inst-token-123",
            expires_at: "2026-02-26T12:00:00Z",
          },
        },
      ],
      fetchCalls,
    );

    const { getInstallationToken } = await importGithubAppAuthFresh();
    const token = await getInstallationToken(12345);

    assert.deepEqual(token, {
      token: "inst-token-123",
      expiresAt: "2026-02-26T12:00:00Z",
    });
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /\/app\/installations\/12345\/access_tokens$/);
    assert.equal(fetchCalls[0].init.method, "POST");
    assert.match(fetchCalls[0].init.headers.Authorization, /^Bearer\s+\S+/);
  });

  it("includes status and body text when installation token fetch fails", async () => {
    configureAppKey();
    const fetchCalls = [];
    mockFetchSequence(
      [
        {
          status: 403,
          textBody: "Forbidden by policy",
        },
      ],
      fetchCalls,
    );

    const { getInstallationToken } = await importGithubAppAuthFresh();
    await assert.rejects(
      () => getInstallationToken(7),
      /GitHub installation token request failed 403: Forbidden by policy/,
    );
    assert.equal(fetchCalls.length, 1);
  });

  it("resolves repo installation first, then exchanges for installation token", async () => {
    configureAppKey();
    const fetchCalls = [];
    mockFetchSequence(
      [
        { status: 200, jsonBody: { id: 999 } },
        {
          status: 201,
          jsonBody: {
            token: "repo-token-xyz",
            expires_at: "2026-03-01T00:00:00Z",
          },
        },
      ],
      fetchCalls,
    );

    const { getInstallationTokenForRepo } = await importGithubAppAuthFresh();
    const result = await getInstallationTokenForRepo("virtengine", "bosun");

    assert.deepEqual(result, {
      token: "repo-token-xyz",
      expiresAt: "2026-03-01T00:00:00Z",
      installationId: 999,
    });
    assert.equal(fetchCalls.length, 2);
    assert.match(fetchCalls[0].url, /\/repos\/virtengine\/bosun\/installation$/);
    assert.match(fetchCalls[1].url, /\/app\/installations\/999\/access_tokens$/);
  });

  it("propagates deterministic repo lookup and token exchange failure errors", async () => {
    configureAppKey();
    const repoLookupCalls = [];
    mockFetchSequence(
      [
        { status: 404, textBody: "Not Found" },
      ],
      repoLookupCalls,
    );

    const mod = await importGithubAppAuthFresh();
    await assert.rejects(
      () => mod.getInstallationTokenForRepo("virtengine", "missing-repo"),
      /Could not find GitHub App installation for virtengine\/missing-repo \(404\): Not Found/,
    );
    assert.equal(repoLookupCalls.length, 1);

    const tokenFailureCalls = [];
    mockFetchSequence(
      [
        { status: 200, jsonBody: { id: 321 } },
        { status: 500, textBody: "Internal Server Error" },
      ],
      tokenFailureCalls,
    );

    await assert.rejects(
      () => mod.getInstallationTokenForRepo("virtengine", "bosun"),
      /GitHub installation token request failed 500: Internal Server Error/,
    );
    assert.equal(tokenFailureCalls.length, 2);
  });
});

describe("github-app-auth OAuth state persistence", () => {
  it("saves and loads OAuth state in the expected home-scoped file", async () => {
    const tempHome = createTempDir("github-app-auth-home-");
    setTempHome(tempHome);
    const mod = await importGithubAppAuthFresh();

    const state = {
      user: { login: "octocat", id: 1 },
      accessToken: "oauth-token-123",
      tokenType: "bearer",
      scope: "repo",
      savedAt: "2026-02-26T00:00:00.000Z",
      installationIds: [111, 222],
    };

    mod.saveOAuthState(state);

    const authPath = join(tempHome, ".bosun", "github-auth-state.json");
    assert.equal(existsSync(authPath), true);
    assert.deepEqual(JSON.parse(readFileSync(authPath, "utf8")), state);
    assert.deepEqual(mod.loadOAuthState(), state);
    assert.equal(mod.getUserToken(), "oauth-token-123");
  });

  it("returns null for invalid OAuth state JSON and falls back to env token", async () => {
    const tempHome = createTempDir("github-app-auth-home-invalid-");
    setTempHome(tempHome);
    const authPath = join(tempHome, ".bosun", "github-auth-state.json");
    mkdirSync(dirname(authPath), { recursive: true });
    writeFileSync(authPath, "{invalid-json", "utf8");
    process.env.BOSUN_GITHUB_USER_TOKEN = "env-user-token";

    const mod = await importGithubAppAuthFresh();
    assert.equal(mod.loadOAuthState(), null);
    assert.equal(mod.getUserToken(), "env-user-token");
  });
});
