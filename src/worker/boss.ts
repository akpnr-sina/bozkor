import { PgBoss } from "pg-boss";
import { requireEnv } from "@/lib/env";

export const TIMEZONE = "Europe/Istanbul";

/**
 * pg-boss uses LISTEN/NOTIFY and advisory locks, so DATABASE_URL must be a
 * direct or session-mode connection, not Supabase's transaction pooler.
 */
export function createBoss(): PgBoss {
  const options = {
    connectionString: requireEnv("DATABASE_URL"),
    schema: "pgboss",
    application_name: "bozkor-worker",
    // Encrypted, as the app's connection is (src/db/index.ts).
    ssl: { rejectUnauthorized: false },
    // Supabase session pooler slots are limited; leave room for the web app.
    max: 4,
    // Every answer counts against Supabase's egress quota. The queue list
    // (with its stats) was read every minute, by the cache and by supervise;
    // the flow check, every 5 seconds, serves parent and child jobs, which this
    // worker does not use. Supervise also fails the job of a stopped worker
    // (missed heartbeat), now within five minutes. The cron check reads every
    // schedule; 45 seconds is pg-boss's ceiling, still inside its one-minute window.
    queueCacheIntervalSeconds: 600,
    superviseIntervalSeconds: 300,
    flowIntervalSeconds: 300,
    cronMonitorIntervalSeconds: 45,
    // pg's pool option, which pg-boss passes on (its types leave it out). pg
    // closes a connection idle for 10 seconds, so every poll opened
    // new ones, each with a TLS handshake: about 7 a minute, 50 MB of egress a day.
    idleTimeoutMillis: 5 * 60_000,
    // pg's client options, passed on the same way. pg has no TCP keepalive by
    // default, so a connection that died while the Mac slept or the network
    // changed went unnoticed: its query hung and kept its slot, every other
    // query timed out waiting ("timeout exceeded when trying to connect"), and
    // no sync ran for two days (October 2026). Keepalive finds a dead peer; a
    // query without an answer in a minute fails, and the pool drops its connection.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    query_timeout: 60_000,
  };
  return new PgBoss(options);
}
