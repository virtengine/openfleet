import { EventEmitter } from "node:events";

const eventBus = new EventEmitter();
eventBus.setMaxListeners(50);

export function emitConfigReload(payload = {}) {
  eventBus.emit("config-reload", {
    ...payload,
    emittedAt: new Date().toISOString(),
  });
}

export function addConfigReloadListener(listener) {
  if (typeof listener !== "function") {
    return () => {};
  }
  eventBus.on("config-reload", listener);
  return () => {
    eventBus.off("config-reload", listener);
  };
}
