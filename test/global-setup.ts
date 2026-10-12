import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";
import { testDatabaseUrl } from "./helpers.js";

export async function setup() {
  const db = createPool(testDatabaseUrl());
  await migrate(db);
  await db.end();
}
