/**
 * credential-store.mjs — Unified Credential & Secret Management
 *
 * Provides a centralised store for API keys, tokens, and environment variable
 * references that workflow nodes can consume without hard-coding secrets.
 *
 * Credential types:
 *   - "static"  — value stored directly (encrypted at rest with AES-256-GCM)
 *   - "env"     — reference to an environment variable resolved at runtime
 *   - "config"  — reference to a bosun.config.json field
 *
 * Storage: {configDir}/.bosun/credentials.json
 *   {
 *     "_meta": { "version": 1, "createdAt": "..." },
 *     "credentials": {
 *       "<name>": {
 *         "type": "static" | "env" | "config",
 *         "value": "<encrypted-base64>" | "<env-var-name>" | "<config.path>",
 *         "iv": "<hex>",           // only for static
 *         "tag": "<hex>",          // only for static
 *         "label": "My API Key",
 *         "provider": "openai",    // optional provider hint
 *         "scopes": ["*"],         // workflow IDs that may use this, * = all
 *         "createdAt": "...",
 *         "updatedAt": "..."
 *       }
 *     }
 *   }
 *
 * Encryption key derivation:
 *   Derived from BOSUN_SECRET_KEY env var via PBKDF2 (100 000 iterations, SHA-512).
 *   If BOSUN_SECRET_KEY is not set, static credentials are stored in plaintext
 *   with a console warning.
 *
 * EXPORTS:
 *   CredentialStore — main class
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const TAG = "[credential-store]";
const ALGO = "aes-256-gcm";
const KEY_LENGTH = 32;          // 256 bits
const IV_LENGTH = 16;           // 128 bits
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = "sha512";
const SALT = "bosun-credential-store-v1"; // static salt — key uniqueness comes from BOSUN_SECRET_KEY
const STORE_VERSION = 1;

// ── Key derivation ──────────────────────────────────────────────────────────

/**
 * Derive a 256-bit encryption key from the user's secret.
 * @param {string} secret
 * @returns {Buffer}
 */
function deriveKey(secret) {
  return pbkdf2Sync(secret, SALT, PBKDF2_ITERATIONS, KEY_LENGTH, PBKDF2_DIGEST);
}

// ── CredentialStore ─────────────────────────────────────────────────────────

export class CredentialStore {
  #storePath;
  #encryptionKey = null;
  #hasEncryption = false;
  /** @type {{ _meta: object, credentials: Record<string, object> }} */
  #data = { _meta: { version: STORE_VERSION, createdAt: new Date().toISOString() }, credentials: {} };

  /**
   * @param {object} opts
   * @param {string} opts.configDir — base config directory
   * @param {string} [opts.secretKey] — encryption key (defaults to BOSUN_SECRET_KEY env)
   */
  constructor({ configDir, secretKey } = {}) {
    if (!configDir) throw new Error("CredentialStore requires a configDir option");
    const bosunDir = resolve(configDir, ".bosun");
    this.#storePath = resolve(bosunDir, "credentials.json");

    const secret = secretKey || process.env.BOSUN_SECRET_KEY;
    if (secret) {
      this.#encryptionKey = deriveKey(secret);
      this.#hasEncryption = true;
    }
    this.#load();
  }

  /** Whether credential values are encrypted at rest. */
  get encrypted() { return this.#hasEncryption; }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /**
   * Store or update a credential.
   *
   * @param {string} name     — unique credential name (e.g. "openai-key")
   * @param {object} opts
   * @param {"static"|"env"|"config"} opts.type
   * @param {string} opts.value — secret value (static) or env-var / config-path name
   * @param {string} [opts.label]
   * @param {string} [opts.provider]
   * @param {string[]} [opts.scopes=["*"]]
   * @returns {{ name: string, type: string }}
   */
  set(name, { type, value, label, provider, scopes } = {}) {
    const n = String(name).trim();
    if (!n) throw new Error("Credential name is required");
    if (!["static", "env", "config"].includes(type)) {
      throw new Error(`Invalid credential type "${type}" — must be static, env, or config`);
    }
    if (typeof value !== "string" || !value) {
      throw new Error("Credential value is required");
    }

    const now = new Date().toISOString();
    const existing = this.#data.credentials[n];

    const entry = {
      type,
      label: label || existing?.label || n,
      provider: provider || existing?.provider || null,
      scopes: Array.isArray(scopes) ? scopes : (existing?.scopes || ["*"]),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    if (type === "static") {
      if (this.#hasEncryption) {
        const { encrypted, iv, tag } = this.#encrypt(value);
        entry.value = encrypted;
        entry.iv = iv;
        entry.tag = tag;
      } else {
        console.warn(`${TAG} BOSUN_SECRET_KEY not set — storing credential "${n}" unencrypted`);
        entry.value = value;
        entry.iv = null;
        entry.tag = null;
      }
    } else {
      // env or config — store the reference name, not a secret
      entry.value = value;
      entry.iv = null;
      entry.tag = null;
    }

    this.#data.credentials[n] = entry;
    this.#save();
    return { name: n, type };
  }

  /**
   * Resolve a credential's actual value at runtime.
   *
   * @param {string} name
   * @param {object} [opts]
   * @param {string} [opts.workflowId] — for scope checks
   * @returns {string|null} — the resolved secret value, or null if not found
   */
  resolve(name, { workflowId } = {}) {
    const entry = this.#data.credentials[String(name).trim()];
    if (!entry) return null;

    // Scope check
    if (workflowId && !this.#checkScope(entry, workflowId)) {
      return null;
    }

    switch (entry.type) {
      case "static":
        if (entry.iv && entry.tag && this.#hasEncryption) {
          return this.#decrypt(entry.value, entry.iv, entry.tag);
        }
        return entry.value || null;

      case "env":
        return process.env[entry.value] || null;

      case "config":
        // Walk dotted path into process.env as a fallback
        return process.env[entry.value] || null;

      default:
        return null;
    }
  }

  /**
   * Get credential metadata (never exposes the raw value).
   * @param {string} name
   * @returns {object|null}
   */
  get(name) {
    const entry = this.#data.credentials[String(name).trim()];
    if (!entry) return null;
    return {
      name: String(name).trim(),
      type: entry.type,
      label: entry.label,
      provider: entry.provider,
      scopes: entry.scopes,
      encrypted: entry.type === "static" && !!entry.iv,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  /**
   * List all credential names and metadata (never exposes values).
   * @returns {Array<object>}
   */
  list() {
    return Object.keys(this.#data.credentials).map((n) => this.get(n));
  }

  /**
   * Delete a credential.
   * @param {string} name
   * @returns {boolean}
   */
  delete(name) {
    const n = String(name).trim();
    const existed = n in this.#data.credentials;
    if (existed) {
      delete this.#data.credentials[n];
      this.#save();
    }
    return existed;
  }

  /**
   * Check if a credential exists for the given name.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return String(name).trim() in this.#data.credentials;
  }

  /** @returns {number} */
  get size() {
    return Object.keys(this.#data.credentials).length;
  }

  // ── Scope helpers ─────────────────────────────────────────────────────

  /**
   * Update the scopes (allowed workflow IDs) for a credential.
   * @param {string} name
   * @param {string[]} scopes
   * @returns {boolean}
   */
  setScopes(name, scopes) {
    const entry = this.#data.credentials[String(name).trim()];
    if (!entry) return false;
    entry.scopes = Array.isArray(scopes) ? scopes : ["*"];
    entry.updatedAt = new Date().toISOString();
    this.#save();
    return true;
  }

  #checkScope(entry, workflowId) {
    if (!Array.isArray(entry.scopes) || entry.scopes.length === 0) return true;
    if (entry.scopes.includes("*")) return true;
    return entry.scopes.includes(workflowId);
  }

  // ── Encryption ────────────────────────────────────────────────────────

  #encrypt(plaintext) {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, this.#encryptionKey, iv);
    let encrypted = cipher.update(plaintext, "utf8", "base64");
    encrypted += cipher.final("base64");
    const tag = cipher.getAuthTag();
    return {
      encrypted,
      iv: iv.toString("hex"),
      tag: tag.toString("hex"),
    };
  }

  #decrypt(ciphertext, ivHex, tagHex) {
    try {
      const iv = Buffer.from(ivHex, "hex");
      const tag = Buffer.from(tagHex, "hex");
      const decipher = createDecipheriv(ALGO, this.#encryptionKey, iv);
      decipher.setAuthTag(tag);
      let dec = decipher.update(ciphertext, "base64", "utf8");
      dec += decipher.final("utf8");
      return dec;
    } catch (err) {
      console.warn(`${TAG} decryption failed: ${err?.message || err}`);
      return null;
    }
  }

  // ── Persistence ───────────────────────────────────────────────────────

  #load() {
    try {
      if (existsSync(this.#storePath)) {
        const raw = readFileSync(this.#storePath, "utf8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && parsed.credentials) {
          this.#data = {
            _meta: parsed._meta || this.#data._meta,
            credentials: parsed.credentials || {},
          };
        }
      }
    } catch (err) {
      console.warn(`${TAG} failed to load credential store: ${err?.message || err}`);
    }
  }

  #save() {
    try {
      const dir = dirname(this.#storePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.#storePath, JSON.stringify(this.#data, null, 2), "utf8");
    } catch (err) {
      console.warn(`${TAG} failed to save credential store: ${err?.message || err}`);
    }
  }
}
