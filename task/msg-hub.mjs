/**
 * @module task/msg-hub
 * @description Lightweight pub-sub hub for active agent sessions.
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const SAFE_KEYS = new Set([
  "taskId",
  "title",
  "summary",
  "branch",
  "baseBranch",
  "repoSlug",
  "workspace",
  "repository",
  "paths",
  "files",
  "status",
  "runId",
  "stage",
]);

function normalizeParticipant(participant, index = 0) {
  if (typeof participant === "string") {
    return { id: participant, name: participant };
  }
  if (participant && typeof participant === "object") {
    const id = String(participant.id || participant.name || `participant-${index + 1}`);
    return {
      ...participant,
      id,
      name: String(participant.name || id),
    };
  }
  throw new TypeError("MsgHub participant must be a string or object");
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function sanitizeMessageReference(message, options = {}) {
  const maxSummaryLength = Number(options.maxSummaryLength || 400);
  if (message == null) return { summary: "" };

  if (typeof message === "string") {
    return { summary: truncateText(message, maxSummaryLength) };
  }

  if (Array.isArray(message)) {
    return {
      items: message.slice(0, 20).map((entry) => sanitizeMessageReference(entry, options)),
    };
  }

  if (typeof message === "object") {
    const sanitized = {};
    for (const [key, value] of Object.entries(message)) {
      if (!SAFE_KEYS.has(key)) continue;
      if (typeof value === "string") {
        sanitized[key] = truncateText(value, maxSummaryLength);
        continue;
      }
      if (Array.isArray(value)) {
        sanitized[key] = value.slice(0, 50).map((entry) => truncateText(entry, maxSummaryLength));
        continue;
      }
      if (value != null && (typeof value === "number" || typeof value === "boolean")) {
        sanitized[key] = value;
      }
    }
    if (Object.keys(sanitized).length > 0) return sanitized;
  }

  return { summary: truncateText(JSON.stringify(message), maxSummaryLength) };
}

export class MsgHub {
  constructor(participants = [], options = {}) {
    this.options = { ...options };
    this._events = new EventEmitter();
    this._participants = new Map();
    this._queues = new Map();
    this._handlers = new Map();
    this._closed = false;

    participants.forEach((participant, index) => {
      this.add(participant, index);
    });
  }

  static async create(participants = [], options = {}) {
    return new MsgHub(participants, options);
  }

  add(participant, index = this._participants.size) {
    if (this._closed) throw new Error("MsgHub is closed");
    const normalized = normalizeParticipant(participant, index);
    this._participants.set(normalized.id, normalized);
    if (!this._queues.has(normalized.id)) this._queues.set(normalized.id, []);
    if (!this._handlers.has(normalized.id)) this._handlers.set(normalized.id, new Set());
    return normalized;
  }

  remove(participantOrId) {
    const id = typeof participantOrId === "string" ? participantOrId : participantOrId?.id;
    if (!id) return false;
    const existed = this._participants.delete(id);
    this._queues.delete(id);
    this._handlers.delete(id);
    return existed;
  }

  has(participantOrId) {
    const id = typeof participantOrId === "string" ? participantOrId : participantOrId?.id;
    return !!id && this._participants.has(id);
  }

  listParticipants() {
    return Array.from(this._participants.values());
  }

  subscribe(participantOrId, handler) {
    const id = typeof participantOrId === "string" ? participantOrId : participantOrId?.id;
    if (!id || typeof handler !== "function") {
      throw new TypeError("MsgHub.subscribe requires a participant id and handler");
    }
    if (!this._handlers.has(id)) this._handlers.set(id, new Set());
    this._handlers.get(id).add(handler);
    return () => {
      this._handlers.get(id)?.delete(handler);
    };
  }

  publish(fromParticipant, message, options = {}) {
    if (this._closed) throw new Error("MsgHub is closed");
    const fromId = typeof fromParticipant === "string" ? fromParticipant : fromParticipant?.id;
    if (!fromId || !this._participants.has(fromId)) {
      throw new Error("MsgHub.publish requires a known sender");
    }

    const reference = sanitizeMessageReference(message, this.options);
    const deliveries = [];

    for (const participant of this._participants.values()) {
      if (participant.id === fromId) continue;
      const envelope = {
        id: randomUUID(),
        from: fromId,
        to: participant.id,
        topic: String(options.topic || "reference"),
        createdAt: new Date().toISOString(),
        message: reference,
      };
      this._queues.get(participant.id)?.push(envelope);
      for (const handler of this._handlers.get(participant.id) || []) {
        handler(envelope);
      }
      this._events.emit("message", envelope);
      deliveries.push(envelope);
    }

    return deliveries;
  }

  observeOutput(fromParticipant, output, options = {}) {
    const descriptor = output?.descriptor || output?.reference || output?.output || output;
    return this.publish(fromParticipant, descriptor, options);
  }

  drain(participantOrId) {
    const id = typeof participantOrId === "string" ? participantOrId : participantOrId?.id;
    if (!id) return [];
    const queue = this._queues.get(id) || [];
    this._queues.set(id, []);
    return queue.slice();
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    this._participants.clear();
    this._queues.clear();
    this._handlers.clear();
    this._events.removeAllListeners();
  }
}

export default MsgHub;
