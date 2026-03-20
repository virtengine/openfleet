/**
 * webhook-gateway.mjs — Per-Workflow Webhook Token Management & Rate Limiting
 *
 * Manages webhook tokens, activation state, and rate limiting for workflows
 * that use the trigger.webhook node type.
 *
 * Tokens are 32-byte random hex strings stored in a JSON file.
 * Validation uses constant-time comparison (timingSafeEqual) to prevent
 * timing side-channel attacks.
 *
 * EXPORTS:
 *   WebhookGateway — main gateway class
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TAG = "[webhook-gateway]";
const DEFAULT_RATE_LIMIT = 60;           // requests per window
const DEFAULT_RATE_WINDOW_MS = 60_000;   // 1 minute

// ── WebhookGateway ──────────────────────────────────────────────────────────

export class WebhookGateway {
  /** @type {string} path to webhook-tokens.json */
  #tokensPath;
  /** @type {Map<string, { token: string, active: boolean, createdAt: string }>} */
  #store = new Map();
  /** @type {Map<string, { count: number, windowStart: number }>} */
  #rateLimits = new Map();
  /** @type {Map<string, number>} per-workflow rate limit overrides */
  #rateLimitOverrides = new Map();
  #defaultRateLimit;
  #rateWindowMs;

  /**
   * @param {object} opts
   * @param {string} opts.configDir — base config directory (tokens file stored at {configDir}/.bosun/webhook-tokens.json)
   * @param {number} [opts.rateLimit=60] — default requests per window
   * @param {number} [opts.rateWindowMs=60000] — rate limit window in ms
   */
  constructor({ configDir, rateLimit = DEFAULT_RATE_LIMIT, rateWindowMs = DEFAULT_RATE_WINDOW_MS } = {}) {
    if (!configDir) {
      throw new Error("WebhookGateway requires a configDir option");
    }
    const bosunDir = resolve(configDir, ".bosun");
    this.#tokensPath = resolve(bosunDir, "webhook-tokens.json");
    this.#defaultRateLimit = Math.max(1, rateLimit);
    this.#rateWindowMs = Math.max(1000, rateWindowMs);
    this.#load();
  }

  // ── Token management ──────────────────────────────────────────────────

  /**
   * Generate a new webhook token for a workflow.
   * @param {string} workflowId
   * @returns {string} the generated token
   */
  generateToken(workflowId) {
    const id = String(workflowId).trim();
    if (!id) throw new Error("workflowId is required");
    const token = randomBytes(32).toString("hex");
    this.#store.set(id, {
      token,
      active: true,
      createdAt: new Date().toISOString(),
    });
    this.#save();
    return token;
  }

  /**
   * Constant-time token validation.
   * @param {string} workflowId
   * @param {string} token
   * @returns {boolean}
   */
  validateToken(workflowId, token) {
    const id = String(workflowId).trim();
    const entry = this.#store.get(id);
    if (!entry || !entry.active) return false;

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
   * @returns {{ active: boolean, token: string|null, createdAt: string|null } | null}
   */
  getWebhookInfo(workflowId) {
    const id = String(workflowId).trim();
    const entry = this.#store.get(id);
    if (!entry) return null;
    return {
      active: entry.active === true,
      token: entry.token,
      createdAt: entry.createdAt || null,
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
        };
      }
      writeFileSync(this.#tokensPath, JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
      console.warn(`${TAG} failed to save webhook tokens: ${err?.message || err}`);
    }
  }
}
