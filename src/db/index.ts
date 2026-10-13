import { drizzle } from "drizzle-orm/postgres-js";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { requireEnv } from "@/lib/env";
import * as schema from "./schema";

/** Any Drizzle Postgres database with our schema: postgres-js in the app, PGlite in tests. */
export type AppDb = PgDatabase<PgQueryResultHKT, typeof schema>;

function createDb() {
  // prepare: false keeps this working behind Supabase's transaction pooler too.
  const client = postgres(requireEnv("DATABASE_URL"), { prepare: false, max: 5 });
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
