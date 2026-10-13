import { asc, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { rawNotices, sources } from "./schema";

describe("migrations", () => {
  it("apply to an empty database and seed both sources", async () => {
    const { db, close } = await createTestDb();
    try {
      const rows = await db.select({ id: sources.id }).from(sources).orderBy(asc(sources.id));
      expect(rows.map((r) => r.id)).toEqual(["eu_ted", "uk_fat"]);
    } finally {
      await close();
    }
  });

  it("enable row level security on every app table", async () => {
    const { db, close } = await createTestDb();
    try {
      const result = await db.execute<{ relname: string }>(sql`
        select c.relname from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
      `);
      expect(result.rows).toEqual([]);
    } finally {
      await close();
    }
  });

  it("dedupe identical raw payloads but keep changed ones", async () => {
    const { db, close } = await createTestDb();
    try {
      const row = { source: "uk_fat", externalId: "N-1", payload: { a: 1 }, sha256: "aaa" };
      await db.insert(rawNotices).values(row).onConflictDoNothing();
      await db.insert(rawNotices).values(row).onConflictDoNothing();
      await db.insert(rawNotices).values({ ...row, payload: { a: 2 }, sha256: "bbb" });

      const count = await db.$count(rawNotices);
      expect(count).toBe(2);
    } finally {
      await close();
    }
  });
});
