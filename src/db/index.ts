import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { requireEnv } from "@/lib/env";
import * as schema from "./schema";

/** Any Drizzle Postgres database with our schema: postgres-js in the app, PGlite in tests. */
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

function createDb() {
  const client = postgres(requireEnv("DATABASE_URL"), {
    // Keeps this working behind Supabase's transaction pooler too.
    prepare: false,
    // Supabase's session pooler gives the whole project 15 connections (free
    // plan). The web app (3), the worker (3, plus 4 for pg-boss) and one
    // command (3) together use 13. Idle connections go back after 20 seconds.
    max: 3,
    idle_timeout: 20,
    // Replaces connections now and then, so one the pooler has dropped does not fail a query.
    max_lifetime: 30 * 60,
  });
  return { db: drizzle(client, { schema }), client };
}

export type Db = ReturnType<typeof createDb>["db"];

// Reuse one pool across dev hot reloads.
const globalForDb = globalThis as unknown as { bozkorDb?: ReturnType<typeof createDb> };

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
