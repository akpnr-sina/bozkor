import { asc, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { rawNotices, sources } from "./schema";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

describe("migrations", () => {
  it("apply to an empty database and seed both sources", async () => {
    const rows = await testDb.db.select({ id: sources.id }).from(sources).orderBy(asc(sources.id));
    expect(rows.map((r) => r.id)).toEqual(["eu_ted", "uk_fat"]);
  });

  it("enable row level security on every app table", async () => {
    const result = await testDb.db.execute<{ relname: string }>(sql`
      select c.relname from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
    `);
    expect(result.rows).toEqual([]);
  });

  it("dedupe identical raw payloads but keep changed ones", async () => {
    await testDb.reset();
    const { db } = testDb;
    const row = { source: "uk_fat", externalId: "N-1", payload: { a: 1 }, sha256: "aaa" };
    await db.insert(rawNotices).values(row).onConflictDoNothing();
    await db.insert(rawNotices).values(row).onConflictDoNothing();
    await db.insert(rawNotices).values({ ...row, payload: { a: 2 }, sha256: "bbb" });

    expect(await db.$count(rawNotices)).toBe(2);
  });
});
