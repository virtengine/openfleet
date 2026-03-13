/**
 * @module msg-hub
 * @description Lightweight reference-passing message hub for active agents.
 */

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_MAX_MESSAGE_BYTES = 4096;
const DISALLOWED_KEYS = new Set([
  "context",
  "conversation",
  "history",
  "messages",
  "raw",
  "transcript",
]);
const ALLOWED_KEYS = [
  "kind",
  "taskId",
  "taskIds",
  "workflowId",
  "runId",
  "branch",
  "filePaths",
  "paths",
  "summary",
  "metadata",
  "source",
];

function truncateText(value, limit = 320) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function normalizeParticipant(participant) {
  if (typeof participant === "string") {
    return {
      id: participant,
      name: participant,
      onMessage: null,
    };
  }
  if (!participant || typeof participant !== "object") {
    throw new TypeError("MsgHub participant must be a string or object.");
  }
  const id = String(participant.id || participant.name || randomUUID()).trim();
  if (!id) throw new Error("MsgHub participant must have an id or name.");
  return {
    id,
    name: String(participant.name || id),
    onMessage:
      typeof participant.onMessage === "function"
        ? participant.onMessage.bind(participant)
        : null,
  };
}

function sanitizeReference(message, maxBytes) {
  const raw =
    message && typeof message === "object" && !Array.isArray(message)
      ? message
      : { summary: String(message ?? "") };
  const ref = {};

  for (const key of ALLOWED_KEYS) {
    if (raw[key] == null) continue;
    if (key === "summary") {
      ref.summary = truncateText(raw.summary);
      continue;
    }
    if (key === "filePaths" || key === "paths") {
      const values = Array.isArray(raw[key])
        ? raw[key].map((entry) => String(entry || "").trim()).filter(Boolean)
        : [];
      if (values.length > 0) ref[key] = [...new Set(values)];
      continue;
    }
    ref[key] = raw[key];
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("_")) continue;
    if (DISALLOWED_KEYS.has(key) || ALLOWED_KEYS.includes(key)) continue;
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      if (!ref.metadata || typeof ref.metadata !== "object") ref.metadata = {};
      ref.metadata[key] = typeof value === "string" ? truncateText(value, 120) : value;
    }
  }

  let serialized = JSON.stringify(ref);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
    return ref;
  }

  if (ref.metadata && typeof ref.metadata === "object") {
    ref.metadata = { note: "trimmed" };
  }
  if (ref.summary) {
    ref.summary = truncateText(ref.summary, 160);
  }
  serialized = JSON.stringify(ref);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
    return ref;
  }

  return {
    kind: ref.kind || "reference",
    taskId: ref.taskId || null,
    branch: ref.branch || null,
    summary: truncateText(ref.summary || "reference trimmed", 96),
  };
}

export class MsgHub extends EventEmitter {
  static async create(participants = [], options = {}) {
    return new MsgHub(participants, options);
  }

  constructor(participants = [], options = {}) {
    super();
    this.options = {
      autoBroadcast: options.autoBroadcast !== false,
      historyLimit: Number(options.historyLimit || DEFAULT_HISTORY_LIMIT),
      maxMessageBytes: Number(options.maxMessageBytes || DEFAULT_MAX_MESSAGE_BYTES),
    };
    this._participants = new Map();
    this._history = [];
    this._closed = false;
    for (const participant of participants) {
      this.add(participant);
    }
  }

  add(participant) {
    if (this._closed) throw new Error("MsgHub is closed.");
    const normalized = normalizeParticipant(participant);
    this._participants.set(normalized.id, normalized);
    this.emit("participant:added", {
      participantId: normalized.id,
      participantName: normalized.name,
      size: this._participants.size,
    });
    return normalized;
  }

  remove(participantOrId) {
    const id = typeof participantOrId === "string"
      ? participantOrId
      : participantOrId?.id || participantOrId?.name || "";
    const removed = this._participants.delete(String(id || "").trim());
    if (removed) {
      this.emit("participant:removed", {
        participantId: String(id || "").trim(),
        size: this._participants.size,
      });
    }
    return removed;
  }

  listParticipants() {
    return [...this._participants.values()].map((participant) => ({
      id: participant.id,
      name: participant.name,
    }));
  }

  get history() {
    return this._history.map((entry) => ({ ...entry }));
  }

  subscribe(listener) {
    this.on("message", listener);
    return () => this.off("message", listener);
  }

  async publish(from, message, options = {}) {
    if (this._closed) throw new Error("MsgHub is closed.");
    const senderId = typeof from === "string"
      ? String(from).trim()
      : String(from?.id || from?.name || "").trim();
    if (senderId && !this._participants.has(senderId)) {
      this.add(senderId);
    }

    const to = Array.isArray(options.to)
      ? options.to.map((entry) => String(entry || "").trim()).filter(Boolean)
      : null;
    const recipients = to || [...this._participants.keys()].filter((id) => id !== senderId);
    const envelope = {
      id: randomUUID(),
      from: senderId || null,
      to: recipients,
      message: sanitizeReference(message, this.options.maxMessageBytes),
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
    };

    this._history.push(envelope);
    if (this._history.length > this.options.historyLimit) {
      this._history.splice(0, this._history.length - this.options.historyLimit);
    }

    this.emit("message", envelope);
    if (this.options.autoBroadcast) {
      for (const recipientId of recipients) {
        const participant = this._participants.get(recipientId);
        if (!participant?.onMessage) continue;
        try {
          await participant.onMessage(envelope, this);
        } catch (error) {
          this.emit("delivery:error", {
            participantId: recipientId,
            error: String(error?.message || error),
            envelope,
          });
        }
      }
    }
    return envelope;
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    this._participants.clear();
    this.emit("closed", { closedAt: new Date().toISOString() });
    this.removeAllListeners();
  }
}

export default MsgHub;
