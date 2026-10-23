import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPool, type Db } from "./pool.js";

const schemaPath = fileURLToPath(new URL("./schema.sql", import.meta.url));

/** Apply the schema. Every statement is idempotent, so this is safe on every boot. */
export async function migrate(db: Db): Promise<void> {
  const sql = readFileSync(schemaPath, "utf8");
  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock(726101)");
    await client.query(sql);
  } finally {
    await client.query("SELECT pg_advisory_unlock(726101)").catch(() => {});
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = createPool(url);
  await migrate(db);
  await db.end();
  console.log("Schema applied.");
}
