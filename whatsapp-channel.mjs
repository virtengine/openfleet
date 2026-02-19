/**
 * whatsapp-channel.mjs — Optional WhatsApp channel for openfleet.
 *
 * Uses the @whiskeysockets/baileys library for WhatsApp Web multi-device API.
 * When configured (WHATSAPP_ENABLED=1), this module bridges WhatsApp messages
 * to the primary agent, similar to the Telegram bot but over WhatsApp.
 *
 * Inspired by nanoclaw's WhatsApp channel architecture.
 *
 * Setup:
 *   1. Set WHATSAPP_ENABLED=1 in .env
 *   2. Run: openfleet --whatsapp-auth   (scans QR code once)
 *   3. Messages from WHATSAPP_CHAT_ID are routed to the primary agent
 *
 * Security: Only messages from the configured WHATSAPP_CHAT_ID are processed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { resolveRepoRoot } from "./repo-root.mjs";

const __dirname = dirname(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolveRepoRoot();

// ── Configuration ────────────────────────────────────────────────────────────

const whatsappEnabled = ["1", "true", "yes"].includes(
  String(process.env.WHATSAPP_ENABLED || "").toLowerCase(),
);
const whatsappChatId = process.env.WHATSAPP_CHAT_ID || "";
const assistantName =
  process.env.WHATSAPP_ASSISTANT_NAME ||
  process.env.PROJECT_NAME ||
  "OpenFleet";
const storeDir = resolve(
  process.env.WHATSAPP_STORE_DIR ||
    resolve(repoRoot, ".cache", "whatsapp-store"),
);
const authDir = resolve(storeDir, "auth");

// ── State ────────────────────────────────────────────────────────────────────

let sock = null;
let connected = false;
let outgoingQueue = [];
let flushing = false;
let baileys = null; // Lazy-loaded
const moduleRequire = createRequire(import.meta.url);

// Callbacks set by the monitor
let _onMessage = null;
let _sendToPrimaryAgent = null;

// ── Lazy Baileys Loader ──────────────────────────────────────────────────────

async function loadBaileys() {
  if (baileys) return baileys;

  const attempts = [];
  const requireCandidates = [
    {
      label: "cwd resolve",
      packageJson: resolve(process.cwd(), "package.json"),
    },
    {
      label: "cwd/scripts/openfleet resolve",
      packageJson: resolve(process.cwd(), "scripts", "openfleet", "package.json"),
    },
  ];

  try {
    baileys = await import("@whiskeysockets/baileys");
    return baileys;
  } catch (err) {
    attempts.push(`default import: ${err.message}`);
  }

  for (const candidate of requireCandidates) {
    try {
      if (!existsSync(candidate.packageJson)) {
        attempts.push(`${candidate.label}: package.json not found (${candidate.packageJson})`);
        continue;
      }
      const scopedRequire = createRequire(candidate.packageJson);
      const resolved = scopedRequire.resolve("@whiskeysockets/baileys");
      baileys = await import(pathToFileURL(resolved).href);
      return baileys;
    } catch (err) {
      attempts.push(`${candidate.label}: ${err.message}`);
    }
  }

  try {
    const resolvedFromModule = moduleRequire.resolve("@whiskeysockets/baileys");
    baileys = await import(pathToFileURL(resolvedFromModule).href);
    return baileys;
  } catch (err) {
    attempts.push(`module resolve: ${err.message}`);
  }

  console.error(
    `[whatsapp] Failed to load @whiskeysockets/baileys:\n` +
      attempts.map((line) => `  - ${line}`).join("\n") +
      `\n  Install in the same runtime context as openfleet:` +
      `\n    - Global install: npm install -g @whiskeysockets/baileys` +
      `\n    - Project install (run openfleet from that folder): npm install @whiskeysockets/baileys`,
  );
  return null;
}

// ── Channel Implementation ───────────────────────────────────────────────────

/**
 * Check if WhatsApp is configured and available.
 */
export function isWhatsAppEnabled() {
  return whatsappEnabled;
}

/**
 * Check WhatsApp connection status.
 */
export function isWhatsAppConnected() {
  return connected;
}

/**
 * Get WhatsApp channel status for diagnostics.
 */
export function getWhatsAppStatus() {
  return {
    enabled: whatsappEnabled,
    connected,
    chatId: whatsappChatId ? `${whatsappChatId.slice(0, 8)}...` : "(not set)",
    storeDir,
    queuedMessages: outgoingQueue.length,
    hasBaileys: !!baileys,
  };
}

/**
 * Send a message via WhatsApp.
 * If disconnected, messages are queued and flushed on reconnect.
 */
export async function sendWhatsAppMessage(jid, text) {
  if (!sock || !connected) {
    outgoingQueue.push({ jid, text });
    console.log(
      `[whatsapp] disconnected, message queued (queue: ${outgoingQueue.length})`,
    );
    return;
  }
  try {
    await sock.sendMessage(jid, { text });
    console.log(`[whatsapp] sent message to ${jid} (${text.length} chars)`);
  } catch (err) {
    outgoingQueue.push({ jid, text });
    console.warn(
      `[whatsapp] send failed, queued: ${err.message} (queue: ${outgoingQueue.length})`,
    );
  }
}

/**
 * Send a message to the configured WhatsApp chat.
 */
export async function notifyWhatsApp(text) {
  if (!whatsappChatId) return;
  await sendWhatsAppMessage(whatsappChatId, text);
}

/**
 * Set typing indicator on WhatsApp.
 */
export async function setWhatsAppTyping(jid, isTyping) {
  if (!sock || !connected) return;
  try {
    await sock.sendPresenceUpdate(isTyping ? "composing" : "paused", jid);
  } catch {
    /* best effort */
  }
}

async function flushOutgoingQueue() {
  if (flushing || outgoingQueue.length === 0) return;
  flushing = true;
  try {
    console.log(`[whatsapp] flushing ${outgoingQueue.length} queued messages`);
    while (outgoingQueue.length > 0) {
      const item = outgoingQueue.shift();
      await sendWhatsAppMessage(item.jid, item.text);
    }
  } finally {
    flushing = false;
  }
}

// ── Connection ───────────────────────────────────────────────────────────────

async function connectInternal(onFirstOpen) {
  const b = await loadBaileys();
  if (!b) {
    console.error("[whatsapp] baileys not available, cannot connect");
    return;
  }

  mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await b.useMultiFileAuthState(authDir);

  // Suppress baileys internal logs (very noisy)
  const silentLogger = {
    level: "silent",
    info: () => {},
    warn: () => {},
    error: (...args) => console.error("[whatsapp-baileys]", ...args),
    debug: () => {},
    trace: () => {},
    fatal: (...args) => console.error("[whatsapp-baileys-fatal]", ...args),
    child: () => silentLogger,
  };

  sock = b.default({
    auth: {
      creds: state.creds,
      keys: b.makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    printQRInTerminal: false,
    logger: silentLogger,
    browser: b.Browsers?.macOS?.("Chrome") || ["OpenFleet", "Chrome", "1.0"],
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.error(
        "[whatsapp] Authentication required! Run: openfleet --whatsapp-auth",
      );
      // Write QR data for external auth tool
      try {
        writeFileSync(resolve(storeDir, "qr-data.txt"), qr);
        writeFileSync(resolve(storeDir, "auth-status.txt"), "waiting_for_scan");
      } catch {
        /* best effort */
      }
      return;
    }

    if (connection === "close") {
      connected = false;
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== 401; // 401 = logged out
      console.log(
        `[whatsapp] connection closed (reason: ${reason}, reconnect: ${shouldReconnect})`,
      );

      if (shouldReconnect) {
        setTimeout(() => {
          connectInternal().catch((err) =>
            console.error(`[whatsapp] reconnection failed: ${err.message}`),
          );
        }, 5000);
      } else {
        console.error(
          "[whatsapp] Logged out. Run: openfleet --whatsapp-auth",
        );
      }
    } else if (connection === "open") {
      connected = true;
      console.log("[whatsapp] connected to WhatsApp");
      try {
        writeFileSync(resolve(storeDir, "auth-status.txt"), "connected");
      } catch {
        /* best effort */
      }

      // Flush queued messages
      flushOutgoingQueue().catch((err) =>
        console.error(`[whatsapp] queue flush error: ${err.message}`),
      );

      if (onFirstOpen) {
        onFirstOpen();
        onFirstOpen = undefined;
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const rawJid = msg.key.remoteJid;
      if (!rawJid || rawJid === "status@broadcast") continue;

      // Skip own messages
      if (msg.key.fromMe) continue;

      // Security: only process messages from configured chat
      if (whatsappChatId && rawJid !== whatsappChatId) continue;

      const content =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      if (!content) continue;

      const sender = msg.key.participant || rawJid || "";
      const senderName = msg.pushName || sender.split("@")[0];
      const timestamp = new Date(
        Number(msg.messageTimestamp) * 1000,
      ).toISOString();

      console.log(
        `[whatsapp] message from ${senderName} (jid=${rawJid}): "${content.slice(0, 80)}${content.length > 80 ? "..." : ""}"`,
      );

      // Route to primary agent
      if (_sendToPrimaryAgent) {
        try {
          await setWhatsAppTyping(rawJid, true);
          const response = await _sendToPrimaryAgent(content, {
            source: "whatsapp",
            sender: senderName,
            chatJid: rawJid,
            timestamp,
          });
          await setWhatsAppTyping(rawJid, false);

          if (response) {
            await sendWhatsAppMessage(rawJid, `${assistantName}: ${response}`);
          }
        } catch (err) {
          await setWhatsAppTyping(rawJid, false);
          console.error(`[whatsapp] agent error: ${err.message}`);
          await sendWhatsAppMessage(rawJid, `❌ Error: ${err.message}`);
        }
      }

      // Also notify external handler if set
      if (_onMessage) {
        _onMessage({
          source: "whatsapp",
          chatJid: rawJid,
          sender: senderName,
          content,
          timestamp,
        });
      }
    }
  });
}

/**
 * Start the WhatsApp channel.
 * @param {object} options
 * @param {function} options.onMessage - Called with each inbound message
 * @param {function} options.sendToPrimaryAgent - Async function to route text to primary agent
 */
export async function startWhatsAppChannel(options = {}) {
  if (!whatsappEnabled) {
    console.log("[whatsapp] disabled (set WHATSAPP_ENABLED=1 to enable)");
    return;
  }

  if (!whatsappChatId) {
    console.warn(
      "[whatsapp] WHATSAPP_CHAT_ID not set — accepting messages from all chats. Use logs to capture target jid, then set WHATSAPP_CHAT_ID (recommended).",
    );
  }

  _onMessage = options.onMessage || null;
  _sendToPrimaryAgent = options.sendToPrimaryAgent || null;

  console.log("[whatsapp] starting WhatsApp channel...");

  return new Promise((resolve, reject) => {
    connectInternal(() => {
      console.log("[whatsapp] channel ready");
      resolve();
    }).catch(reject);
  });
}

/**
 * Stop the WhatsApp channel.
 */
export async function stopWhatsAppChannel() {
  connected = false;
  if (sock) {
    try {
      sock.end(undefined);
    } catch {
      /* best effort */
    }
    sock = null;
  }
  console.log("[whatsapp] channel stopped");
}

// ── Standalone Auth Mode ─────────────────────────────────────────────────────

/**
 * Run interactive WhatsApp authentication (QR code or pairing code).
 * This is meant to be run standalone: openfleet --whatsapp-auth
 */
export async function runWhatsAppAuth(mode = "qr") {
  const b = await loadBaileys();
  if (!b) {
    console.error(
      "Failed to load @whiskeysockets/baileys.\n" +
        "Install with: npm install @whiskeysockets/baileys",
    );
    process.exit(1);
  }

  let qrTerminal;
  try {
    qrTerminal = await import("qrcode-terminal");
  } catch {
    console.warn(
      "qrcode-terminal not installed — QR will be saved to file only.\n" +
        "Install with: npm install qrcode-terminal",
    );
  }

  mkdirSync(authDir, { recursive: true });
  const { state, saveCreds } = await b.useMultiFileAuthState(authDir);

  const silentLogger = {
    level: "silent",
    info: () => {},
    warn: () => {},
    error: (...args) => console.error("[auth]", ...args),
    debug: () => {},
    trace: () => {},
    fatal: (...args) => console.error("[auth-fatal]", ...args),
    child: () => silentLogger,
  };

  const authSock = b.default({
    auth: {
      creds: state.creds,
      keys: b.makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    printQRInTerminal: false,
    logger: silentLogger,
    browser: b.Browsers?.macOS?.("Chrome") || ["OpenFleet", "Chrome", "1.0"],
  });

  let pairingRequested = false;

  authSock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      writeFileSync(resolve(storeDir, "qr-data.txt"), qr);
      writeFileSync(resolve(storeDir, "auth-status.txt"), "waiting_for_scan");

      if (mode === "pairing-code" && !pairingRequested) {
        pairingRequested = true;
        const phoneNumber = process.env.WHATSAPP_PHONE_NUMBER;
        if (!phoneNumber) {
          console.error(
            "Set WHATSAPP_PHONE_NUMBER env var for pairing code auth",
          );
          process.exit(1);
        }
        try {
          const code = await authSock.requestPairingCode(
            phoneNumber.replace(/[^0-9]/g, ""),
          );
          console.log(`\n📱 Pairing code: ${code}\n`);
          console.log(
            "Enter this code in WhatsApp:\n" +
              "Settings → Linked Devices → Link a Device → Link with phone number\n",
          );
        } catch (err) {
          console.error(`Pairing code request failed: ${err.message}`);
        }
      } else if (qrTerminal) {
        console.log("\n📱 Scan this QR code with WhatsApp:\n");
        qrTerminal.generate?.(qr, { small: true });
      } else {
        console.log(
          `\n📱 QR code saved to: ${resolve(storeDir, "qr-data.txt")}`,
        );
        console.log("   Use a QR reader to scan it with WhatsApp.\n");
      }
    }

    if (connection === "open") {
      console.log("\n✅ WhatsApp authenticated successfully!");
      console.log(`   Auth data saved to: ${authDir}`);
      writeFileSync(resolve(storeDir, "auth-status.txt"), "connected");
      process.exit(0);
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === 515) {
        // Stream error after pairing — need reconnect
        console.log("Reconnecting after pairing...");
        setTimeout(() => runWhatsAppAuth(mode), 2000);
      } else {
        console.error(`Connection closed (reason: ${reason})`);
        process.exit(1);
      }
    }
  });

  authSock.ev.on("creds.update", saveCreds);
}
