import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireEnv } from "@/lib/env";
import * as schema from "./schema";

function createDb() {
  // prepare: false keeps this working behind Supabase's transaction pooler too.
  const client = postgres(requireEnv("DATABASE_URL"), { prepare: false, max: 5 });
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;

// Reuse one pool across dev hot reloads.
const globalForDb = globalThis as unknown as { bozkorDb?: Db };

export function getDb(): Db {
  globalForDb.bozkorDb ??= createDb();
  return globalForDb.bozkorDb;
}
