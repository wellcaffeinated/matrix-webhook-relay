import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from "matrix-bot-sdk";
import { readFileSync, existsSync } from "fs";

// Config from env
const HOMESERVER_URL = process.env.HOMESERVER_URL || "https://matrix.org";
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || "30000");

// Access token: env var or file
function getAccessToken() {
  if (process.env.ACCESS_TOKEN) {
    return process.env.ACCESS_TOKEN;
  }
  const tokenFile = process.env.ACCESS_TOKEN_FILE || "/run/secrets/matrix_token";
  if (existsSync(tokenFile)) {
    return readFileSync(tokenFile, "utf-8").trim();
  }
  throw new Error("No access token provided. Set ACCESS_TOKEN or ACCESS_TOKEN_FILE.");
}

async function main() {
  if (!WEBHOOK_URL) {
    throw new Error("WEBHOOK_URL is required");
  }

  const accessToken = getAccessToken();
  const storage = new SimpleFsStorageProvider("/data/bot-state.json");

  const client = new MatrixClient(HOMESERVER_URL, accessToken, storage);
  AutojoinRoomsMixin.setupOnClient(client);

  const botUserId = await client.getUserId();
  console.log(`Bot logged in as ${botUserId}`);
  console.log(`Forwarding messages to ${WEBHOOK_URL}`);

  client.on("room.message", async (roomId, event) => {
    // Ignore own messages
    if (event.sender === botUserId) return;

    // Only handle text messages
    if (event.content?.msgtype !== "m.text") return;

    const message = event.content.body;
    console.log(`[${roomId}] ${event.sender}: ${message}`);

    try {
      const response = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          room_id: roomId,
          sender: event.sender,
          message: message,
          event_id: event.event_id,
        }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });

      if (!response.ok) {
        console.error(`Webhook returned ${response.status}`);
        return;
      }

      const contentType = response.headers.get("content-type") || "";
      let reply;

      if (contentType.includes("application/json")) {
        const data = await response.json();
        reply = data.message || data.text || data.response || data.body;
      } else {
        reply = await response.text();
      }

      if (reply && reply.trim()) {
        await client.sendText(roomId, reply.trim());
      }
    } catch (err) {
      console.error(`Error forwarding message: ${err.message}`);
      await client.sendText(roomId, "⚠️ Error processing your message.");
    }
  });

  await client.start();
  console.log("Bot started and listening");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
