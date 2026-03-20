/**
 * webhook-gateway.mjs — Per-Workflow Webhook Token Management & Rate Limiting
 *
 * Manages webhook tokens, activation state, rate limiting, delivery logs,
 * token expiry, and HMAC-SHA256 payload signing for workflows that use
 * the trigger.webhook node type.
 *
 * Tokens are 32-byte random hex strings stored in a JSON file.
 * Validation uses constant-time comparison (timingSafeEqual) to prevent
 * timing side-channel attacks.
 *
 * Features:
 *   - Token CRUD with activation/deactivation
 *   - Constant-time token validation
 *   - Per-workflow rate limiting (sliding window)
 *   - Token expiry (optional TTL)
 *   - HMAC-SHA256 payload signing for outbound webhooks
 *   - Delivery event log with status + payload hash
 *   - Payload transformation (JSONPath-like field extraction)
 *
 * EXPORTS:
 *   WebhookGateway — main gateway class
 */

import { randomBytes, timingSafeEqual, createHmac, createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TAG = "[webhook-gateway]";
const DEFAULT_RATE_LIMIT = 60;           // requests per window
const DEFAULT_RATE_WINDOW_MS = 60_000;   // 1 minute

// ── WebhookGateway ──────────────────────────────────────────────────────────

export class WebhookGateway {
  /** @type {string} path to webhook-tokens.json */
  #tokensPath;
  /** @type {Map<string, { token: string, active: boolean, createdAt: string, expiresAt: string|null, hmacSecret: string|null }>} */
  #store = new Map();
  /** @type {Map<string, { count: number, windowStart: number }>} */
  #rateLimits = new Map();
  /** @type {Map<string, number>} per-workflow rate limit overrides */
  #rateLimitOverrides = new Map();
  /** @type {Map<string, Array<{ timestamp: string, status: number, method: string, payloadHash: string, ip: string|null }>>} */
  #deliveryLog = new Map();
  #defaultRateLimit;
  #rateWindowMs;
  #maxDeliveryLogSize;

  /**
   * @param {object} opts
   * @param {string} opts.configDir — base config directory (tokens file stored at {configDir}/.bosun/webhook-tokens.json)
   * @param {number} [opts.rateLimit=60] — default requests per window
   * @param {number} [opts.rateWindowMs=60000] — rate limit window in ms
   * @param {number} [opts.maxDeliveryLogSize=100] — max entries per workflow in delivery log
   */
  constructor({ configDir, rateLimit = DEFAULT_RATE_LIMIT, rateWindowMs = DEFAULT_RATE_WINDOW_MS, maxDeliveryLogSize = 100 } = {}) {
    if (!configDir) {
      throw new Error("WebhookGateway requires a configDir option");
    }
    const bosunDir = resolve(configDir, ".bosun");
    this.#tokensPath = resolve(bosunDir, "webhook-tokens.json");
    this.#defaultRateLimit = Math.max(1, rateLimit);
    this.#rateWindowMs = Math.max(1000, rateWindowMs);
    this.#maxDeliveryLogSize = Math.max(10, maxDeliveryLogSize);
    this.#load();
  }

  // ── Token management ──────────────────────────────────────────────────

  /**
   * Generate a new webhook token for a workflow.
   * @param {string} workflowId
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] — optional time-to-live in ms (token expires after this)
   * @param {boolean} [opts.enableHmac=false] — generate an HMAC signing secret for this webhook
   * @returns {{ token: string, hmacSecret: string|null, expiresAt: string|null }}
   */
  generateToken(workflowId, { ttlMs, enableHmac } = {}) {
    const id = String(workflowId).trim();
    if (!id) throw new Error("workflowId is required");
    const token = randomBytes(32).toString("hex");
    const now = new Date();
    const expiresAt = ttlMs && ttlMs > 0 ? new Date(now.getTime() + ttlMs).toISOString() : null;
    const hmacSecret = enableHmac ? randomBytes(32).toString("hex") : null;

    this.#store.set(id, {
      token,
      active: true,
      createdAt: now.toISOString(),
      expiresAt,
      hmacSecret,
    });
    this.#save();
    return { token, hmacSecret, expiresAt };
  }

  /**
   * Constant-time token validation with expiry check.
   * @param {string} workflowId
   * @param {string} token
   * @returns {boolean}
   */
  validateToken(workflowId, token) {
    const id = String(workflowId).trim();
    const entry = this.#store.get(id);
    if (!entry || !entry.active) return false;

    // Expiry check
    if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) {
      return false;
    }

    const expected = Buffer.from(String(entry.token), "utf8");
    const actual = Buffer.from(String(token || ""), "utf8");

    if (expected.length !== actual.length) {
      // Perform a dummy compare to avoid leaking length via timing
      const dummy = Buffer.alloc(expected.length);
      timingSafeEqual(expected, dummy);
      return false;
    }

    return timingSafeEqual(expected, actual);
  }

  /**
   * Revoke a workflow's webhook token.
   * @param {string} workflowId
   * @returns {boolean} true if a token was revoked
   */
  revokeToken(workflowId) {
    const id = String(workflowId).trim();
    const existed = this.#store.delete(id);
    if (existed) this.#save();
    this.#rateLimits.delete(id);
    return existed;
  }

  /**
   * Rotate a workflow's webhook token (revoke + generate new).
   * @param {string} workflowId
   * @returns {string} the new token
   */
  rotateToken(workflowId) {
    this.revokeToken(workflowId);
    return this.generateToken(workflowId);
  }

  // ── Activation state ──────────────────────────────────────────────────

  /**
   * Get webhook info for a workflow.
   * @param {string} workflowId
   * @returns {{ active: boolean, token: string|null, createdAt: string|null, expiresAt: string|null, expired: boolean, hasHmac: boolean } | null}
   */
  getWebhookInfo(workflowId) {
    const id = String(workflowId).trim();
    const entry = this.#store.get(id);
    if (!entry) return null;
    const expired = entry.expiresAt ? new Date(entry.expiresAt) < new Date() : false;
    return {
      active: entry.active === true && !expired,
      token: entry.token,
      createdAt: entry.createdAt || null,
      expiresAt: entry.expiresAt || null,
      expired,
      hasHmac: !!entry.hmacSecret,
    };
  }

  /**
   * Activate the webhook for a workflow (token must already exist).
   * @param {string} workflowId
   * @returns {boolean}
   */
  activate(workflowId) {
    const id = String(workflowId).trim();
    const entry = this.#store.get(id);
    if (!entry) return false;
    entry.active = true;
    this.#save();
    return true;
  }

  /**
   * Deactivate the webhook for a workflow without revoking the token.
   * @param {string} workflowId
   * @returns {boolean}
   */
  deactivate(workflowId) {
    const id = String(workflowId).trim();
    const entry = this.#store.get(id);
    if (!entry) return false;
    entry.active = false;
    this.#save();
    return true;
  }

  /**
   * Check if a webhook is active.
   * @param {string} workflowId
   * @returns {boolean}
   */
  isActive(workflowId) {
    const entry = this.#store.get(String(workflowId).trim());
    return entry?.active === true;
  }

  // ── Rate limiting ─────────────────────────────────────────────────────

  /**
   * Set a per-workflow rate limit override.
   * @param {string} workflowId
   * @param {number} limit — requests per window
   */
  setRateLimit(workflowId, limit) {
    this.#rateLimitOverrides.set(String(workflowId).trim(), Math.max(1, limit));
  }

  /**
   * Check rate limit and consume one request slot.
   * @param {string} workflowId
   * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
   */
  checkRateLimit(workflowId) {
    const id = String(workflowId).trim();
    const limit = this.#rateLimitOverrides.get(id) || this.#defaultRateLimit;
    const now = Date.now();
    let bucket = this.#rateLimits.get(id);

    if (!bucket || now - bucket.windowStart >= this.#rateWindowMs) {
      bucket = { count: 0, windowStart: now };
      this.#rateLimits.set(id, bucket);
    }

    bucket.count++;
    const allowed = bucket.count <= limit;
    const remaining = Math.max(0, limit - bucket.count);
    const resetAt = bucket.windowStart + this.#rateWindowMs;

    return { allowed, remaining, resetAt };
  }

  // ── Persistence ───────────────────────────────────────────────────────

  // ── HMAC Signing ──────────────────────────────────────────────────────

  /**
   * Compute HMAC-SHA256 signature for a payload.
   * @param {string} workflowId
   * @param {string|Buffer} payload — raw request body
   * @returns {string|null} hex signature, or null if HMAC not enabled
   */
  signPayload(workflowId, payload) {
    const entry = this.#store.get(String(workflowId).trim());
    if (!entry?.hmacSecret) return null;
    return createHmac("sha256", entry.hmacSecret)
      .update(typeof payload === "string" ? payload : Buffer.from(payload))
      .digest("hex");
  }

  /**
   * Verify an HMAC-SHA256 signature against expected.
   * @param {string} workflowId
   * @param {string|Buffer} payload
   * @param {string} signature — hex string to verify
   * @returns {boolean}
   */
  verifySignature(workflowId, payload, signature) {
    const expected = this.signPayload(workflowId, payload);
    if (!expected) return false;
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(String(signature || ""), "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  // ── Delivery Log ──────────────────────────────────────────────────────

  /**
   * Record a delivery event for a workflow webhook.
   * @param {string} workflowId
   * @param {{ status: number, method: string, payload: string|object, ip?: string }} event
   */
  recordDelivery(workflowId, { status, method, payload, ip }) {
    const id = String(workflowId).trim();
    if (!this.#deliveryLog.has(id)) {
      this.#deliveryLog.set(id, []);
    }
    const log = this.#deliveryLog.get(id);
    const payloadStr = typeof payload === "string" ? payload : JSON.stringify(payload || "");
    const payloadHash = createHash("sha256").update(payloadStr).digest("hex").slice(0, 16);
    log.push({
      timestamp: new Date().toISOString(),
      status: status || 0,
      method: method || "POST",
      payloadHash,
      ip: ip || null,
    });
    // Trim to max size
    while (log.length > this.#maxDeliveryLogSize) {
      log.shift();
    }
  }

  /**
   * Get delivery log for a workflow.
   * @param {string} workflowId
   * @param {number} [limit=50]
   * @returns {Array<{ timestamp: string, status: number, method: string, payloadHash: string, ip: string|null }>}
   */
  getDeliveryLog(workflowId, limit = 50) {
    const id = String(workflowId).trim();
    const log = this.#deliveryLog.get(id) || [];
    return log.slice(-Math.min(limit, log.length));
  }

  // ── Payload Transformation ────────────────────────────────────────────

  /**
   * Extract fields from a webhook payload using a simple field map.
   * @param {object} payload — raw payload object
   * @param {Record<string, string>} fieldMap — { outputField: "input.dotted.path" }
   * @returns {object}
   */
  static transformPayload(payload, fieldMap) {
    if (!payload || typeof payload !== "object" || !fieldMap) return payload;
    const result = {};
    for (const [outKey, path] of Object.entries(fieldMap)) {
      const parts = String(path).split(".");
      let val = payload;
      for (const p of parts) {
        if (val == null || typeof val !== "object") { val = undefined; break; }
        val = val[p];
      }
      result[outKey] = val;
    }
    return result;
  }

  // ── Persistence (original) ────────────────────────────────────────────

  #load() {
    try {
      if (existsSync(this.#tokensPath)) {
        const raw = readFileSync(this.#tokensPath, "utf8");
        const data = JSON.parse(raw);
        if (data && typeof data === "object") {
          for (const [id, entry] of Object.entries(data)) {
            if (entry && typeof entry.token === "string") {
              this.#store.set(id, {
                token: entry.token,
                active: entry.active !== false,
                createdAt: entry.createdAt || null,
                expiresAt: entry.expiresAt || null,
                hmacSecret: entry.hmacSecret || null,
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn(`${TAG} failed to load webhook tokens: ${err?.message || err}`);
    }
  }

  #save() {
    try {
      const dir = dirname(this.#tokensPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = {};
      for (const [id, entry] of this.#store) {
        data[id] = {
          token: entry.token,
          active: entry.active,
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt || null,
          hmacSecret: entry.hmacSecret || null,
        };
      }
      writeFileSync(this.#tokensPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.warn(`${TAG} failed to save webhook tokens: ${err?.message || err}`);
    }
  }
}
