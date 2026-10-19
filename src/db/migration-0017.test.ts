import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { insertDocument, insertTender } from "../../tests/helpers/tenders";
import { documents } from "./schema";

let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

/** Runs the migration again over rows stored before it (it already ran, on the empty database). */
async function reopen() {
  const text = readFileSync("src/db/migrations/0017_reopen_tenderned_links.sql", "utf8");
  for (const statement of text.split("--> statement-breakpoint")) await testDb.db.execute(sql.raw(statement));
}

const ROBOTS_UNREAD = "Sitenin robots.txt dosyası okunamadı; dosyalar portaldan indirilmeli.";

describe("migration 0017", () => {
  it("tries again the TenderNed links left to the team only because robots.txt could not be read", async () => {
    const tenderId = await insertTender(testDb.db);
    const settled = { origin: "auto" as const, fetchStatus: "needs_manual" as const, fetchAttempts: 2, processedAt: new Date() };
    const unread = await insertDocument(testDb.db, { tenderId, ...settled, sourceUrl: "https://www.tenderned.nl/aankondigingen/overzicht/443706", fetchError: ROBOTS_UNREAD });
    // Left alone: robots.txt closed, another site, a page already taken.
    const closed = await insertDocument(testDb.db, {
      tenderId,
      ...settled,
      sourceUrl: "https://www.tenderned.nl/aankondigingen/overzicht/1",
      fetchError: "Site otomatik erişime kapalı (robots.txt); dosyalar portaldan indirilmeli.",
    });
    const elsewhere = await insertDocument(testDb.db, { tenderId, ...settled, sourceUrl: "https://nottenderned.nl/aankondigingen/overzicht/2", fetchError: ROBOTS_UNREAD });
    const taken = await insertDocument(testDb.db, {
      tenderId,
      ...settled,
      sourceUrl: "https://www.tenderned.nl/aankondigingen/overzicht/3",
      fetchError: "TenderNed API'si; 4 dosya alındı.",
    });

    await reopen();

    const rowOf = async (id: string) => (await testDb.db.select().from(documents).where(eq(documents.id, id)))[0]!;
    expect(await rowOf(unread)).toMatchObject({ fetchStatus: "pending", fetchAttempts: 0, fetchError: null, processedAt: null, retryAt: null });
    for (const id of [closed, elsewhere, taken]) expect(await rowOf(id)).toMatchObject({ fetchStatus: "needs_manual", fetchAttempts: 2 });
  });
});
