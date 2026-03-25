import { EventEmitter } from "node:events";

const bus = globalThis.__bosunConfigEventBus || new EventEmitter();
globalThis.__bosunConfigEventBus = bus;

export function emitConfigReload(payload = {}) {
  bus.emit("config-reload", payload);
}

export function onConfigReload(listener) {
  bus.on("config-reload", listener);
  return () => bus.off("config-reload", listener);
}
