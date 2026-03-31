import { EventEmitter } from "node:events";

const CONFIG_RELOAD_BUS_KEY = Symbol.for("bosun.configReloadBus");

function resolveEventBus() {
  const existing = globalThis[CONFIG_RELOAD_BUS_KEY];
  if (existing instanceof EventEmitter) {
    return existing;
  }
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  globalThis[CONFIG_RELOAD_BUS_KEY] = bus;
  return bus;
}

const eventBus = resolveEventBus();

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
