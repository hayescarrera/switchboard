export interface Config {
  /** Public origin, e.g. https://switchboard.onrender.com. No trailing slash. */
  baseUrl: string;
  databaseUrl: string;
  port: number;
  /** How many proxy hops sit in front of us (Render: 1). */
  trustProxyHops: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const baseUrl = (env.BASE_URL ?? env.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`).replace(/\/+$/, "");
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (see .env.example)");
  const url = new URL(baseUrl);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !local) throw new Error("BASE_URL must be https outside localhost");
  return { baseUrl, databaseUrl, port, trustProxyHops: Number(env.TRUST_PROXY_HOPS ?? (env.RENDER ? 1 : 0)) };
}
