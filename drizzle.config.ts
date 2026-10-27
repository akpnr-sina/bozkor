import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";

loadEnvConfig(process.cwd());

/** Encrypted, as the app's connection is (src/db/index.ts); a sslmode in DATABASE_URL wins. */
function withSsl(url: string): string {
  if (!url || /[?&]sslmode=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}sslmode=require`;
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: withSsl(process.env.DATABASE_URL ?? "") },
  // Leave Supabase (auth, storage) and pg-boss schemas alone.
  schemaFilter: ["public"],
  strict: true,
  verbose: true,
});
