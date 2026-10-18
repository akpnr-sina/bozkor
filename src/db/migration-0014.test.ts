import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { insertDocument, insertTender } from "../../tests/helpers/tenders";
import { documents, tenders } from "./schema";

let testDb: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(async () => {
  await testDb.close();
});

/** Runs the migration again over rows stored the old way (it already ran, on the empty database). */
async function decodeAmpersands() {
  const text = readFileSync("src/db/migrations/0014_decode_ted_url_ampersands.sql", "utf8");
  for (const statement of text.split("--> statement-breakpoint")) await testDb.db.execute(sql.raw(statement));
}

describe("migration 0014", () => {
  it("decodes the escaped ampersands of stored TED links, once or twice escaped", async () => {
    const tenderId = await insertTender(testDb.db, {
      source: "eu_ted",
      documentsPortalUrl: "https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematEnt.login&amp;type=DCE&amp;IDM=1854555",
    });
    const once = await insertDocument(testDb.db, { tenderId, origin: "auto", sourceUrl: "https://a.example/?x=1&amp;y=2" });
    const twice = await insertDocument(testDb.db, { tenderId, origin: "auto", sourceUrl: "https://b.example/?x=1&amp;amp;y=2" });
    // Its decoded form is stored too: left alone, as the pair must stay unique.
    const clash = await insertDocument(testDb.db, { tenderId, origin: "auto", sourceUrl: "https://c.example/?x=1&amp;y=2" });
    await insertDocument(testDb.db, { tenderId, origin: "auto", sourceUrl: "https://c.example/?x=1&y=2" });
    const plain = await insertDocument(testDb.db, { tenderId, origin: "auto", sourceUrl: "https://d.example/a.pdf" });

    await decodeAmpersands();

    const urlOf = async (id: string) => (await testDb.db.select({ url: documents.sourceUrl }).from(documents).where(eq(documents.id, id)))[0]!.url;
    expect(await urlOf(once)).toBe("https://a.example/?x=1&y=2");
    expect(await urlOf(twice)).toBe("https://b.example/?x=1&y=2");
    expect(await urlOf(clash)).toBe("https://c.example/?x=1&amp;y=2");
    expect(await urlOf(plain)).toBe("https://d.example/a.pdf");
    const [tender] = await testDb.db.select({ portal: tenders.documentsPortalUrl }).from(tenders).where(eq(tenders.id, tenderId));
    expect(tender!.portal).toBe("https://www.marches-publics.info/mpiaws/index.cfm?fuseaction=dematEnt.login&type=DCE&IDM=1854555");
  });
});
