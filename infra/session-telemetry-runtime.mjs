import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { cloneHotPathValue } from "../lib/hot-path-runtime.mjs";

const DEFAULT_STATUS = Object.freeze({
  service: "telemetry",
  mode: "javascript",
  transport: "in_process",
  available: true,
  reason: "javascript",
  queuedEvents: 0,
  queuedPersistEvents: 0,
  processedEvents: 0,
  droppedEvents: 0,
  persistBatches: 0,
  persistedEvents: 0,
  persistFailures: 0,
  pendingPersistBytes: 0,
  maxInMemoryEvents: 0,
  lastEnqueueAt: null,
  lastDrainAt: null,
  lastPersistAt: null,
});

function scheduleBackground(fn) {
  if (typeof setImmediate === "function") {
    setImmediate(fn);
    return;
  }
  setTimeout(fn, 0);
}

function createStatus(maxInMemoryEvents) {
  return {
    ...DEFAULT_STATUS,
    maxInMemoryEvents,
  };
}

export class HarnessTelemetryRuntime {
  constructor(options = {}) {
    this.persist = options.persist === true;
    this.maxInMemoryEvents = Math.max(
      100,
      Math.trunc(Number(options.maxInMemoryEvents) || 20_000),
    );
    this.paths = options.paths || {};
    this.projector = options.projector;
    this.metrics = options.metrics;
    this.providerUsage = options.providerUsage;
    this.events = [];
    this.pendingAnalytics = [];
    this.pendingPersist = [];
    this.analyticsScheduled = false;
    this.persistScheduled = false;
    this.persistPromise = null;
    this.status = createStatus(this.maxInMemoryEvents);
  }

  _appendEvent(normalized, { persist = false } = {}) {
    this.events.push(normalized);
    if (this.events.length > this.maxInMemoryEvents) {
      const overflow = this.events.length - this.maxInMemoryEvents;
      this.events.splice(0, overflow);
      this.status.droppedEvents += overflow;
    }
    this.pendingAnalytics.push(normalized);
    this.status.queuedEvents = this.pendingAnalytics.length;
    this.status.lastEnqueueAt = new Date().toISOString();

    if (persist && this.persist) {
      const serialized = JSON.stringify(normalized);
      this.pendingPersist.push(serialized);
      this.status.queuedPersistEvents = this.pendingPersist.length;
      this.status.pendingPersistBytes += Buffer.byteLength(`${serialized}\n`, "utf8");
    }
  }

  load(entries = []) {
    for (const entry of entries) {
      this._appendEvent(entry, { persist: false });
    }
    this.flushForeground();
  }

  record(normalized) {
    this._appendEvent(normalized, { persist: true });
    this._scheduleAnalyticsDrain();
    this._schedulePersistFlush();
    return normalized;
  }

  _drainAnalytics(limit = Number.POSITIVE_INFINITY) {
    let processed = 0;
    while (this.pendingAnalytics.length > 0 && processed < limit) {
      const event = this.pendingAnalytics.shift();
      this.projector.record(event);
      this.metrics.record(event);
      this.providerUsage.record(event);
      processed += 1;
    }
    if (processed > 0) {
      this.status.processedEvents += processed;
      this.status.lastDrainAt = new Date().toISOString();
    }
    this.status.queuedEvents = this.pendingAnalytics.length;
    return processed;
  }

  _scheduleAnalyticsDrain() {
    if (this.analyticsScheduled) return;
    this.analyticsScheduled = true;
    scheduleBackground(() => {
      this.analyticsScheduled = false;
      this._drainAnalytics(256);
      if (this.pendingAnalytics.length > 0) {
        this._scheduleAnalyticsDrain();
      }
    });
  }

  async _flushPersistBatch() {
    if (!this.persist || this.pendingPersist.length === 0) return;
    const batch = this.pendingPersist.splice(0, this.pendingPersist.length);
    this.status.queuedPersistEvents = this.pendingPersist.length;
    this.status.pendingPersistBytes = 0;

    try {
      await mkdir(dirname(this.paths.eventsPath), { recursive: true });
      await appendFile(this.paths.eventsPath, `${batch.join("\n")}\n`, "utf8");
      this.status.persistBatches += 1;
      this.status.persistedEvents += batch.length;
      this.status.lastPersistAt = new Date().toISOString();
    } catch {
      this.status.persistFailures += 1;
    }
  }

  _schedulePersistFlush() {
    if (!this.persist || this.persistScheduled) return;
    this.persistScheduled = true;
    scheduleBackground(() => {
      this.persistScheduled = false;
      this.persistPromise = (this.persistPromise || Promise.resolve())
        .then(() => this._flushPersistBatch())
        .finally(() => {
          this.persistPromise = null;
          if (this.pendingPersist.length > 0) {
            this._schedulePersistFlush();
          }
        });
    });
  }

  flushForeground() {
    this._drainAnalytics();
  }

  async flush() {
    this.flushForeground();
    if (this.persistPromise) {
      await this.persistPromise;
    } else if (this.pendingPersist.length > 0) {
      await this._flushPersistBatch();
    }
    this.flushForeground();
  }

  getEvents() {
    this.flushForeground();
    return this.events;
  }

  getStatus() {
    this.flushForeground();
    return cloneHotPathValue(this.status);
  }

  reset() {
    this.events = [];
    this.pendingAnalytics = [];
    this.pendingPersist = [];
    this.analyticsScheduled = false;
    this.persistScheduled = false;
    this.persistPromise = null;
    this.status = createStatus(this.maxInMemoryEvents);
  }
}

export function createHarnessTelemetryRuntime(options = {}) {
  return new HarnessTelemetryRuntime(options);
}

export default createHarnessTelemetryRuntime;
