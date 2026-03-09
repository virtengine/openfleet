#!/usr/bin/env node
// Diagnostic wrapper: captures exact exit code, signal, and stderr from monitor.mjs
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const monitorPath = resolve(__dirname, "infra", "monitor.mjs");
const logPath = resolve(__dirname, "diag-crash.log");

console.log(`[diag] Forking monitor: ${monitorPath}`);
console.log(`[diag] Crash log will be at: ${logPath}`);
console.log(`[diag] PID: ${process.pid}`);
console.log(`[diag] Started at: ${new Date().toISOString()}`);

const child = fork(monitorPath, process.argv.slice(2), {
  stdio: ["inherit", "inherit", "inherit", "ipc"],
  execArgv: ["--max-old-space-size=4096", "--trace-warnings"],
});

const startTime = Date.now();

child.on("exit", (code, signal) => {
  const uptimeSec = Math.round((Date.now() - startTime) / 1000);
  const entry = [
    `[${new Date().toISOString()}] CHILD EXIT`,
    `  code: ${code}`,
    `  signal: ${signal}`,
    `  uptime: ${uptimeSec}s`,
    `  childPid: ${child.pid}`,
    "",
  ].join("\n");
  console.log(entry);
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, entry + "\n");
  } catch {}
  process.exit(code ?? 1);
});

child.on("error", (err) => {
  const entry = `[${new Date().toISOString()}] CHILD ERROR: ${err.stack || err.message}\n`;
  console.error(entry);
  try { appendFileSync(logPath, entry); } catch {}
});
