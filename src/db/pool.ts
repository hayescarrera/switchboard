import pg from "pg";

export type Db = pg.Pool;

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) throw new Error("DATABASE_URL is not set (see .env.example)");
  return new pg.Pool({ connectionString });
}
