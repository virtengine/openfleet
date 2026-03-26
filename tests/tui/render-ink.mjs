import { PassThrough } from "node:stream";

import { render } from "ink";

function delay(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(value) {
  return String(value || "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "");
}

export function createInputTty() {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.setRawMode = () => {};
  stream.resume = () => {};
  stream.pause = () => {};
  stream.ref = () => {};
  stream.unref = () => {};
  return stream;
}

export function createOutputTty({ columns = 120, rows = 40 } = {}) {
  const stream = new PassThrough();
  stream.isTTY = true;
  stream.columns = columns;
  stream.rows = rows;
  return stream;
}

export async function renderInk(element, options = {}) {
  const stdin = options.stdin || createInputTty();
  const stdout = options.stdout || createOutputTty(options);
  let buffer = "";
  stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
  });

  const app = render(element, {
    stdin,
    stdout,
    stderr: stdout,
    debug: true,
  });

  await delay(options.waitMs ?? 40);

  return {
    app,
    stdin,
    stdout,
    frames() {
      return buffer;
    },
    text() {
      return stripAnsi(buffer).replace(/\r/g, "");
    },
    latestText() {
      const cleaned = stripAnsi(buffer).replace(/\r/g, "");
      const lastIndex = cleaned.lastIndexOf("Agents:");
      return lastIndex >= 0 ? cleaned.slice(lastIndex) : cleaned;
    },
    async press(chars, waitMs = 40) {
      stdin.write(chars);
      await delay(waitMs);
    },
    async unmount(waitMs = 20) {
      app.unmount();
      await delay(waitMs);
    },
  };
}
