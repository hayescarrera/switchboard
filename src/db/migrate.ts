import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPool, type Db } from "./pool.js";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

/** Create or update the hub's tables. Safe to run more than once. */
export async function migrate(db: Db): Promise<void> {
  await db.query(readFileSync(schemaPath, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool();
  await migrate(db);
  await db.end();
  console.log("Database is up to date.");
}
