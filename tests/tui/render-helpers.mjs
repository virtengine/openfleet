import { PassThrough } from "node:stream";
import React from "react";
import { render } from "ink";

function createTtyStream() {
  const stream = new PassThrough();
  Object.assign(stream, {
    isTTY: true,
    columns: 120,
    rows: 40,
    setRawMode() {},
    resume() {},
    pause() {},
    ref() {},
    unref() {},
  });
  return stream;
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")
    .replace(/\r/g, "");
}

export function renderInk(element, options = {}) {
  const stdin = createTtyStream();
  const stdout = createTtyStream();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });

  const app = render(element, {
    stdin,
    stdout,
    stderr: stdout,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
    ...options,
  });

  return {
    app,
    stdin,
    stdout,
    rerender(nextElement) {
      app.rerender(nextElement);
    },
    input(chars) {
      stdin.write(chars);
    },
    output() {
      return stripAnsi(output);
    },
    clearOutput() {
      output = "";
    },
    unmount() {
      app.unmount();
    },
  };
}

export function renderComponent(Component, props = {}, options = {}) {
  return renderInk(React.createElement(Component, props), options);
}

export async function settle(ms = 40) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(assertion, { timeoutMs = 1500, intervalMs = 20 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = assertion();
    if (value) return value;
    await settle(intervalMs);
  }
  throw new Error("Timed out waiting for condition");
}
