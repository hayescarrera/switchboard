import pg from "pg";

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Pick<pg.Pool, "query">;

export function createPool(connectionString: string): Db {
  const ssl =
    /sslmode=require/.test(connectionString) || process.env.DATABASE_SSL === "1"
      ? { rejectUnauthorized: false }
      : undefined;
  return new pg.Pool({ connectionString, ssl, max: 10 });
}

/** Run fn in a transaction; commits on success, rolls back on throw. */
export async function inTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const out = await fn(tx);
    await tx.query("COMMIT");
    return out;
  } catch (err) {
    await tx.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    tx.release();
  }
}
