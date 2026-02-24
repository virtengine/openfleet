/**
 * task-attachments.mjs — Local registry for task attachment metadata.
 *
 * Stores attachments in .bosun/.cache/task-attachments.json and provides
 * helpers to merge local uploads with backend attachments.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { resolveRepoRoot } from "./repo-root.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAG = "[task-attachments]";

function nowIso() {
  return new Date().toISOString();
}

function resolveDefaultStorePath() {
  let repoRoot = "";
  try {
    repoRoot = resolveRepoRoot();
  } catch {
    repoRoot = resolve(__dirname, "..");
  }
  return resolve(repoRoot, ".bosun", ".cache", "task-attachments.json");
}

let storePath = resolveDefaultStorePath();
let storeTmpPath = `${storePath}.tmp`;
let _store = null;
let _loaded = false;

function defaultStore() {
  return {
    _meta: {
      version: 1,
      updatedAt: nowIso(),
    },
    tasks: {},
  };
}

function ensureStoreDir() {
  const dir = dirname(storePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function normalizeBackend(backend) {
  const value = String(backend || "internal").trim().toLowerCase();
  return value || "internal";
}

function normalizeTaskId(taskId) {
  return String(taskId || "").trim();
}

function taskKey(taskId, backend) {
  const id = normalizeTaskId(taskId);
  if (!id) return "";
  return `${normalizeBackend(backend)}:${id}`;
}

function attachmentKey(att) {
  if (!att) return "";
  if (att.url) return `url:${att.url}`;
  if (att.filePath) return `file:${att.filePath}`;
  if (att.path) return `path:${att.path}`;
  if (att.id) return `id:${att.id}`;
  return `raw:${JSON.stringify(att)}`;
}

function normalizeAttachment(att, backend) {
  if (!att || typeof att !== "object") return null;
  const normalized = { ...att };
  if (!normalized.id) normalized.id = randomUUID();
  if (!normalized.createdAt) normalized.createdAt = nowIso();
  if (!normalized.source) normalized.source = "upload";
  if (!normalized.backend) normalized.backend = normalizeBackend(backend);
  return normalized;
}

function saveStore() {
  if (!_store) return;
  _store._meta = _store._meta || {};
  _store._meta.updatedAt = nowIso();
  ensureStoreDir();
  try {
    writeFileSync(storeTmpPath, JSON.stringify(_store, null, 2), "utf8");
    renameSync(storeTmpPath, storePath);
  } catch (err) {
    console.warn(`${TAG} failed to persist store: ${err.message || err}`);
  }
}

export function resolveTaskAttachmentsStorePath(options = {}) {
  if (options.storePath) {
    return resolve(options.baseDir || process.cwd(), options.storePath);
  }
  return storePath;
}

export function configureTaskAttachmentsStore(options = {}) {
  const nextPath = resolveTaskAttachmentsStorePath(options);
  if (nextPath !== storePath) {
    storePath = nextPath;
    storeTmpPath = `${storePath}.tmp`;
    _store = null;
    _loaded = false;
  }
  return storePath;
}

export function loadStore() {
  if (_loaded && _store) return _store;
  ensureStoreDir();
  if (!existsSync(storePath)) {
    _store = defaultStore();
    _loaded = true;
    return _store;
  }
  try {
    const raw = readFileSync(storePath, "utf8");
    _store = JSON.parse(raw);
    if (!_store || typeof _store !== "object") {
      _store = defaultStore();
    }
  } catch (err) {
    console.warn(`${TAG} failed to read store: ${err.message || err}`);
    _store = defaultStore();
  }
  _loaded = true;
  return _store;
}

export function mergeTaskAttachments(primary = [], secondary = []) {
  const result = [];
  const seen = new Set();
  const add = (att) => {
    if (!att) return;
    const key = attachmentKey(att);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(att);
  };
  for (const att of Array.isArray(primary) ? primary : []) add(att);
  for (const att of Array.isArray(secondary) ? secondary : []) add(att);
  return result;
}

export function listTaskAttachments(taskId, backend = "internal") {
  const store = loadStore();
  const key = taskKey(taskId, backend);
  if (!key) return [];
  const entry = store.tasks?.[key];
  const attachments = Array.isArray(entry?.attachments) ? entry.attachments : [];
  return attachments.slice();
}

export function addTaskAttachment(taskId, backend, attachment) {
  const store = loadStore();
  const key = taskKey(taskId, backend);
  if (!key) return null;
  const normalized = normalizeAttachment(attachment, backend);
  if (!normalized) return null;
  const entry = store.tasks?.[key] || {
    taskId: normalizeTaskId(taskId),
    backend: normalizeBackend(backend),
    attachments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  entry.attachments = mergeTaskAttachments(entry.attachments, [normalized]);
  entry.updatedAt = nowIso();
  store.tasks[key] = entry;
  saveStore();
  return normalized;
}

