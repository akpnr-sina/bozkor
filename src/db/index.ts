import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { requireEnv } from "@/lib/env";
import * as schema from "./schema";

/** Any Drizzle Postgres database with our schema: postgres-js in the app, PGlite in tests. */
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

// Reuse one pool across dev hot reloads.
const globalForDb = globalThis as unknown as { bozkorDb?: ReturnType<typeof createDb> };

/** How long an idle connection stays open; see configureDb. */
let idleTimeoutSeconds = 20;

/**
 * For a long-running process, before its first query: the worker keeps idle
 * connections for minutes, since its jobs run every minute and each new
 * connection costs a TLS handshake and a read of the type catalogue (egress,
 * CLAUDE.md "Veri çıkışı"). The web app gives them back after 20 seconds.
 */
export function configureDb(options: { idleTimeoutSeconds: number }): void {
  if (globalForDb.bozkorDb) throw new Error("configureDb must run before the first query");
  idleTimeoutSeconds = options.idleTimeoutSeconds;
}

function createDb() {
  const client = postgres(requireEnv("DATABASE_URL"), {
    // The pooler is reached over the internet, so the connection is encrypted.
    // Without Supabase's CA certificate the server is not verified ("require").
    ssl: "require",
    // Keeps this working behind Supabase's transaction pooler too.
    prepare: false,
    // Supabase's session pooler gives the whole project 15 connections (free
    // plan). The web app (3), the worker (3, plus 4 for pg-boss) and one
    // command (3) together use 13. Idle connections go back after
    // idleTimeoutSeconds (20 seconds, minutes in the worker).
    max: 3,
    idle_timeout: idleTimeoutSeconds,
    // Replaces connections now and then, so one the pooler has dropped does not fail a query.
    max_lifetime: 30 * 60,
  });
  return { db: drizzle(client, { schema }), client };
}

export type Db = ReturnType<typeof createDb>["db"];

export function getDb(): Db {
  globalForDb.bozkorDb ??= createDb();
  return globalForDb.bozkorDb.db;
}

/** Closes the pool so short-lived scripts can exit. */
export async function closeDb(): Promise<void> {
  const current = globalForDb.bozkorDb;
  globalForDb.bozkorDb = undefined;
  await current?.client.end({ timeout: 5 });
}
