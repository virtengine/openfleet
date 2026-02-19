#!/usr/bin/env node

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN environment variable.");
  process.exit(1);
}

const url = `https://api.telegram.org/bot${token}/getUpdates`;

async function main() {
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error(`Fetch error: ${err.message}`);
    process.exit(1);
  }

  if (!res.ok) {
    const body = await res.text();
    console.error(`Request failed: ${res.status} ${body}`);
    process.exit(1);
  }

  const data = await res.json();
  if (!data.result || data.result.length === 0) {
    console.log(
      "No updates found. Send a message to the bot first, then retry.",
    );
    return;
  }

  const chats = new Map();
  for (const update of data.result) {
    const message =
      update.message || update.channel_post || update.edited_message;
    if (!message || !message.chat) {
      continue;
    }
    const chat = message.chat;
    if (!chats.has(chat.id)) {
      chats.set(chat.id, {
        id: chat.id,
        type: chat.type,
        title: chat.title || "",
        username: chat.username || "",
      });
    }
  }

  if (chats.size === 0) {
    console.log(
      "No chat IDs found in updates. Send a message to the bot first.",
    );
    return;
  }

  console.log("Found chat IDs:");
  for (const chat of chats.values()) {
    const titlePart = chat.title ? ` title=\"${chat.title}\"` : "";
    const userPart = chat.username ? ` username=@${chat.username}` : "";
    console.log(`- id=${chat.id} type=${chat.type}${userPart}${titlePart}`);
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});
