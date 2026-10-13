import { PgBoss } from "pg-boss";
import { requireEnv } from "@/lib/env";

export const TIMEZONE = "Europe/Istanbul";

/**
 * pg-boss uses LISTEN/NOTIFY and advisory locks, so DATABASE_URL must be a
 * direct or session-mode connection, not Supabase's transaction pooler.
 */
export function createBoss(): PgBoss {
  return new PgBoss({
    connectionString: requireEnv("DATABASE_URL"),
    schema: "pgboss",
    application_name: "bozkor-worker",
    // Supabase session pooler slots are limited; leave room for the web app.
    max: 4,
  });
}
