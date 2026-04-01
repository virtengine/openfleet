/**
 * Bosun Vault — AES-256-GCM encrypted credential store.
 *
 * Storage: ~/.bosun-vault/vault.enc
 * Envelope:  { v: 1, iv: "<hex>", tag: "<hex>", data: "<hex>" }
 * Plaintext: { secrets: {...}, env: {...}, mcpRefs: {...} }
 *
 * The master key is managed by lib/vault-keychain.mjs.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const VAULT_VERSION = 1;
const VAULT_DIR = join(homedir(), ".bosun-vault");
const VAULT_PATH = join(VAULT_DIR, "vault.enc");
const KEY_BYTES = 32; // 256-bit
const IV_BYTES = 12;  // 96-bit GCM nonce
const TAG_BYTES = 16;

// ─── Encryption helpers ────────────────────────────────────────────────────────

function encrypt(key, plaintext) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: enc.toString("hex"),
  };
}

function decrypt(key, iv, tag, data) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(data, "hex")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

// ─── Persistence helpers ───────────────────────────────────────────────────────

function readEnvelope() {
  if (!existsSync(VAULT_PATH)) return null;
  return JSON.parse(readFileSync(VAULT_PATH, "utf8"));
}

function writeEnvelope(envelope) {
  if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true });
  writeFileSync(VAULT_PATH, JSON.stringify(envelope), "utf8");
}

// ─── Empty vault payload ───────────────────────────────────────────────────────

function emptyPayload() {
  return { secrets: {}, env: {}, mcpRefs: {} };
}

// ─── VaultStore class ──────────────────────────────────────────────────────────

export class VaultStore {
  constructor() {
    this._key = null;   // Buffer(32) when unlocked
    this._data = null;  // decrypted payload object
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** Returns true when the vault file exists. */
  isInitialized() {
    return existsSync(VAULT_PATH);
  }

  /** Returns true when the vault is unlocked (key loaded in memory). */
  isUnlocked() {
    return this._key !== null && this._data !== null;
  }

  /**
   * Initialize a brand-new vault with the given 32-byte key.
   * Throws if vault already exists.
   */
  init(key) {
    if (this.isInitialized()) {
      throw new Error("Vault already initialized. Use open() to unlock it.");
    }
    this._key = this._validateKey(key);
    this._data = emptyPayload();
    this._flush();
    return this;
  }

  /**
   * Open (unlock) an existing vault with the given key.
   * Throws if vault does not exist or key is wrong.
   */
  open(key) {
    const envelope = readEnvelope();
    if (!envelope) {
      throw new Error("Vault not initialized. Call init() first.");
    }
    if (envelope.v !== VAULT_VERSION) {
      throw new Error(`Unsupported vault version: ${envelope.v}`);
    }
    this._key = this._validateKey(key);
    const plaintext = decrypt(this._key, envelope.iv, envelope.tag, envelope.data);
    this._data = JSON.parse(plaintext);
    return this;
  }

  /** Lock the vault — clears the key and decrypted data from memory. */
  seal() {
    if (this._key) this._key.fill(0);
    this._key = null;
    this._data = null;
  }

  // ── Secrets ──────────────────────────────────────────────────────────────────

  /**
   * List all secrets (without field values).
   * @returns {{ id, name, integration, label, permissions, createdAt, updatedAt }[]}
   */
  listSecrets() {
    this._requireUnlocked();
    return Object.values(this._data.secrets).map((s) => ({
      id: s.id,
      name: s.name,
      integration: s.integration,
      label: s.label,
      permissions: s.permissions,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  }

  /**
   * Get a secret including its decrypted field values.
   */
  getSecret(id) {
    this._requireUnlocked();
    const s = this._data.secrets[id];
    if (!s) throw new Error(`Secret not found: ${id}`);
    return { ...s };
  }

  /**
   * Create a new secret.
   * @param {{ name, integration, label, fields, permissions }} opts
   * @returns {string} new secret id
   */
  createSecret({ name, integration, label, fields, permissions } = {}) {
    this._requireUnlocked();
    const id = randomUUID();
    const now = new Date().toISOString();
    this._data.secrets[id] = {
      id,
      name: name ?? "Unnamed",
      integration: integration ?? "custom",
      label: label ?? "",
      fields: fields ?? {},
      permissions: permissions ?? { agents: ["*"], workflows: ["*"], deny: [] },
      createdAt: now,
      updatedAt: now,
    };
    this._flush();
    return id;
  }

  /**
   * Update an existing secret's name/label/fields.
   */
  updateSecret(id, { name, label, fields, permissions } = {}) {
    this._requireUnlocked();
    const s = this._data.secrets[id];
    if (!s) throw new Error(`Secret not found: ${id}`);
    if (name !== undefined) s.name = name;
    if (label !== undefined) s.label = label;
    if (fields !== undefined) s.fields = { ...s.fields, ...fields };
    if (permissions !== undefined) s.permissions = permissions;
    s.updatedAt = new Date().toISOString();
    this._flush();
  }

  /**
   * Delete a secret by id.
   */
  deleteSecret(id) {
    this._requireUnlocked();
    if (!this._data.secrets[id]) throw new Error(`Secret not found: ${id}`);
    delete this._data.secrets[id];
    // Remove any mcpRefs pointing to this secret
    for (const [k, v] of Object.entries(this._data.mcpRefs)) {
      if (v === id) delete this._data.mcpRefs[k];
    }
    this._flush();
  }

  /**
   * Update RBAC permissions for a secret.
   * @param {string} id
   * @param {{ agents?: string[], workflows?: string[], deny?: string[] }} permissions
   */
  setPermissions(id, permissions) {
    this._requireUnlocked();
    const s = this._data.secrets[id];
    if (!s) throw new Error(`Secret not found: ${id}`);
    s.permissions = { agents: ["*"], workflows: ["*"], deny: [], ...permissions };
    s.updatedAt = new Date().toISOString();
    this._flush();
  }

  // ── Env vars ─────────────────────────────────────────────────────────────────

  /**
   * List all env var keys stored in the vault (no values).
   */
  listEnvKeys() {
    this._requireUnlocked();
    return Object.keys(this._data.env);
  }

  /**
   * Get an env var value.
   */
  getEnv(key) {
    this._requireUnlocked();
    return this._data.env[key];
  }

  /**
   * Set (create or update) an env var.
   */
  setEnv(key, value) {
    this._requireUnlocked();
    this._data.env[key] = value;
    this._flush();
  }

  /**
   * Delete an env var.
   */
  deleteEnv(key) {
    this._requireUnlocked();
    delete this._data.env[key];
    this._flush();
  }

  // ── RBAC helpers ─────────────────────────────────────────────────────────────

  /**
   * Check whether an agent is allowed to access a secret.
   * @param {string} secretId
   * @param {string} agentId
   */
  canAgentAccess(secretId, agentId) {
    const s = this._data?.secrets?.[secretId];
    if (!s) return false;
    const { agents = ["*"], deny = [] } = s.permissions ?? {};
    if (deny.includes(agentId) || deny.includes("*")) return false;
    return agents.includes("*") || agents.includes(agentId);
  }

  /**
   * Check whether a workflow is allowed to access a secret.
   */
  canWorkflowAccess(secretId, workflowId) {
    const s = this._data?.secrets?.[secretId];
    if (!s) return false;
    const { workflows = ["*"], deny = [] } = s.permissions ?? {};
    if (deny.includes(workflowId) || deny.includes("*")) return false;
    return workflows.includes("*") || workflows.includes(workflowId);
  }

  // ── Process env injection ─────────────────────────────────────────────────────

  /**
   * Merge vault env vars into a plain object suitable for process.env injection.
   * Only includes keys not already present in the provided base env.
   * @param {Record<string, string>} [baseEnv] — defaults to {}
   * @returns {Record<string, string>}
   */
  resolveEnv(baseEnv = {}) {
    if (!this.isUnlocked()) return {};
    const out = {};
    for (const [k, v] of Object.entries(this._data.env)) {
      if (!(k in baseEnv)) out[k] = v;
    }
    return out;
  }

  /**
   * Resolve env vars that the given agentId is allowed to access.
   * Right now env vars are not RBAC-scoped (unlike secrets), but
   * this method is exposed for future scoping.
   */
  resolveEnvForAgent(_agentId, baseEnv = {}) {
    return this.resolveEnv(baseEnv);
  }

  // ── MCP refs ──────────────────────────────────────────────────────────────────

  /**
   * Link an MCP env key to a secret id.
   * e.g. "github.GITHUB_PERSONAL_ACCESS_TOKEN" → "<uuid>"
   */
  setMcpRef(mcpKey, secretId) {
    this._requireUnlocked();
    this._data.mcpRefs[mcpKey] = secretId;
    this._flush();
  }

  getMcpRef(mcpKey) {
    this._requireUnlocked();
    return this._data.mcpRefs[mcpKey] ?? null;
  }

  // ── Status ────────────────────────────────────────────────────────────────────

  status() {
    return {
      initialized: this.isInitialized(),
      unlocked: this.isUnlocked(),
      secretCount: this.isUnlocked() ? Object.keys(this._data.secrets).length : null,
      envCount: this.isUnlocked() ? Object.keys(this._data.env).length : null,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  _requireUnlocked() {
    if (!this.isUnlocked()) throw new Error("Vault is locked. Call open(key) first.");
  }

  _validateKey(key) {
    if (Buffer.isBuffer(key) && key.length === KEY_BYTES) return key;
    if (typeof key === "string") {
      const buf = Buffer.from(key, "hex");
      if (buf.length === KEY_BYTES) return buf;
    }
    throw new Error(`Vault key must be a 32-byte Buffer or 64-char hex string (got ${typeof key}).`);
  }

  _flush() {
    const plaintext = JSON.stringify(this._data);
    const { iv, tag, data } = encrypt(this._key, plaintext);
    writeEnvelope({ v: VAULT_VERSION, iv, tag, data });
  }
}

// Shared singleton for use in server-side code
let _defaultVault = null;
export function getDefaultVault() {
  if (!_defaultVault) _defaultVault = new VaultStore();
  return _defaultVault;
}

export { VAULT_PATH, VAULT_DIR, KEY_BYTES };
