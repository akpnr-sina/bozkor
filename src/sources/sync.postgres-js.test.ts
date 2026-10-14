import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFixture } from "../../tests/helpers/fixtures";
import * as schema from "@/db/schema";
import { lots, rawNotices, tenders } from "@/db/schema";
import { backfill, syncWindow } from "./sync";
import type { SourceAdapter } from "./types";
import { fatNoticeKeys, normalizeFatRelease } from "./uk-fat/normalize";

// Runs the pipeline through postgres-js, the driver used against Supabase,
// to catch serialization differences (jsonb, numeric, arrays, timestamps)
// that the PGlite driver in the other tests would hide.

const fixture = (name: string) => loadFixture<Record<string, unknown>>("uk-fat", name);

function fakeAdapter(pages: unknown[][]): SourceAdapter {
  return {
    id: "uk_fat",
    async *pages() {
      for (const page of pages) yield page;
    },
    keys: fatNoticeKeys,
    normalize: normalizeFatRelease,
  };
}

let pg: PGlite;
let server: PGLiteSocketServer;
let client: postgres.Sql;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  pg = await PGlite.create();
  await migrate(drizzlePglite(pg), { migrationsFolder: "src/db/migrations" });
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1" });
  await server.start();
  // Same options as src/db/index.ts, but a single connection for the socket server.
  client = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { prepare: false, max: 1 });
  db = drizzle(client, { schema });
});

afterAll(async () => {
  await client?.end({ timeout: 5 });
  await server?.stop();
  await pg?.close();
});

describe("sync through postgres-js", () => {
  it("stores and re-reads the same rows as the PGlite driver", async () => {
    const adapter = fakeAdapter([
      [fixture("uk4-tender-covered-multilot"), fixture("uk6-award"), fixture("uk4-goods-before-change")],
    ]);
    const first = await backfill(db, adapter, 1);
    expect(first).toMatchObject({ inserted: 2, skipped: 1, normalizeErrors: 0 });

    const again = await backfill(db, adapter, 1);
    expect(again).toMatchObject({ rawInserted: 0, inserted: 0, updated: 0 });
    expect(await db.$count(tenders)).toBe(2);
    expect(await db.$count(lots)).toBe(3);

    // Payloads must land as JSON objects, not JSON-encoded strings.
    const kinds = await db.select({ kind: sql<string>`jsonb_typeof(${rawNotices.payload})` }).from(rawNotices);
    expect(kinds.map((k) => k.kind)).toEqual(["object", "object", "object"]);
    expect(await db.$count(rawNotices, sql`${rawNotices.appliedAt} is null`)).toBe(0);

    const [tender] = await db.select().from(tenders).where(sql`${tenders.externalId} = '096253-2026'`);
    expect(tender?.valueAmount).toBe(6_000_000);
    expect(tender?.cpvAdditional).toEqual(["33170000", "33140000", "33190000"]);
    expect(tender?.submissionDeadline).toBeInstanceOf(Date);
    expect(tender?.submissionDeadline?.toISOString()).toBe("2026-11-09T17:00:00.000Z");
  });

  it("marks a later correction as changed", async () => {
    const stats = await syncWindow(db, fakeAdapter([[fixture("uk4-goods-change")]]), {
      from: new Date("2026-10-12T00:00:00Z"),
      to: new Date("2026-10-13T00:00:00Z"),
    });
    expect(stats).toMatchObject({ updated: 1, changed: 1 });
    const [tender] = await db.select().from(tenders).where(sql`${tenders.procedureKey} = 'ocds-h6vhtk-077f1f'`);
    expect(tender?.submissionDeadline?.toISOString()).toBe("2026-10-14T14:00:00.000Z");
    expect(tender?.changedAt).toBeInstanceOf(Date);
  });
});
