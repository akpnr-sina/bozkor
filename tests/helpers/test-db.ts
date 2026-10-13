import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";

/**
 * In-memory Postgres (PGlite) with all migrations applied, so DB tests run
 * without Supabase or Docker. Starting one is slow, so create it once per
 * test file and call reset() between tests.
 */
export async function createTestDb() {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: "src/db/migrations" });

  async function reset() {
    const { rows } = await client.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' and tablename <> 'sources'",
    );
    if (rows.length) {
      await client.exec(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`);
    }
    await db.execute(sql`update sources set cursor = null, last_synced_at = null, last_error = null`);
  }

  return { db, reset, close: () => client.close() };
}
