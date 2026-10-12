// Run the hub: `npm run hub`. Prints the connector URL for your chat apps and
// the board URL. See the README for adding the connector to Claude.

import { randomBytes } from "node:crypto";
import { createPool } from "./db/pool.js";
import { modelsFromEnv, startHub } from "./hub.js";
import { startServer } from "./server.js";

let token = process.env.SWITCHBOARD_TOKEN;
if (!token) {
  token = randomBytes(18).toString("base64url");
  console.warn("SWITCHBOARD_TOKEN isn't set, so this run uses a one-off token. Put one in .env to keep your URLs.");
}
const port = Number(process.env.PORT ?? 3030);
const host = process.env.HOST ?? "127.0.0.1";
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");

const db = createPool();
const models = modelsFromEnv(process.env, Number(process.env.STAND_IN_DELAY_MS ?? 1500));
const hub = await startHub({ db, models, ownerName: process.env.OWNER_NAME });
const server = await startServer(hub, { token, port, host });

console.log(`
Switchboard hub is running.

  Board (open on laptop or phone):  ${publicUrl}/board/${token}
  Connector URL for your chat apps: ${publicUrl}/mcp/${token}
`);
if (models.missingKeys.length) {
  console.log(`Using stand-ins for: ${models.missingKeys.join(", ")} (add them to .env for the real models).\n`);
}

const shutdown = async () => {
  hub.stop();
  await server.close();
  await db.end();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
