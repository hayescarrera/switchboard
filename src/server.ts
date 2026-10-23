import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
const { app } = createApp({ db, baseUrl: config.baseUrl, trustProxyHops: config.trustProxyHops });
app.listen(config.port, () => {
  console.log(`Switchboard listening on ${config.port} · ${config.baseUrl} · connector address ${config.baseUrl}/mcp`);
});
