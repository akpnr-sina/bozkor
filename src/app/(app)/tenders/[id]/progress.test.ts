import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../../../tests/helpers/test-db";
import { deepRequests, documents, tenders } from "@/db/schema";
import { tenderProgress } from "./progress";

let testDb: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
});
afterAll(async () => {
  await testDb.close();
});

async function tender(procedureKey: string) {
  const [row] = await testDb.db
    .insert(tenders)
    .values({ source: "uk_fat", externalId: procedureKey, procedureKey, title: "Generators" })
    .returning({ id: tenders.id });
  return row!.id;
}

const file = (tenderId: string, name: string, { stored, read }: { stored: boolean; read: boolean }) => ({
  tenderId,
  origin: "manual" as const,
  filename: name,
  mime: "application/pdf",
  fetchStatus: "fetched" as const,
  storagePath: stored ? `${tenderId}/${name}` : null,
  processedAt: read ? new Date() : null,
});

describe("tenderProgress", () => {
  it("counts the stored files not read yet, and gives the state of the latest deep analysis request", async () => {
    const { db } = testDb;
    const id = await tender("ocds-test-1");
    const other = await tender("ocds-test-2");
    expect(await tenderProgress(db, id)).toEqual({ reading: 0, deep: null });

    await db.insert(documents).values([
      file(id, "spec.pdf", { stored: true, read: false }),
      file(id, "terms.pdf", { stored: true, read: true }),
      file(id, "portal.pdf", { stored: false, read: false }),
      file(other, "other.pdf", { stored: true, read: false }),
    ]);
    await db.insert(deepRequests).values([
      { tenderId: id, status: "failed", requestedAt: new Date("2026-10-20T08:00:00Z") },
      { tenderId: id, status: "queued", requestedAt: new Date("2026-10-21T08:00:00Z") },
      { tenderId: other, status: "running", requestedAt: new Date("2026-10-22T08:00:00Z") },
    ]);
    expect(await tenderProgress(db, id)).toEqual({ reading: 1, deep: "queued" });
  });
});
