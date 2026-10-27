import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixture } from "../../../../tests/helpers/fixtures";
import { createTestDb } from "../../../../tests/helpers/test-db";
import { analyses, criteriaProfiles, documents, profileMatches, tenderAssessments, tenderReviews, tenders } from "@/db/schema";
import { KIND_MIME } from "@/documents/sniff";
import { rematch } from "@/matching/apply";
import { profileRulesSchema } from "@/matching/rules";
import { syncWindow } from "@/sources/sync";
import type { SourceAdapter } from "@/sources/types";
import { fatNoticeKeys, normalizeFatRelease } from "@/sources/uk-fat/normalize";
import { inboxCounts, inboxQuery, loadInbox, readFilters, type Filters } from "./data";

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

const all: Filters = { profile: "", source: "", status: "open", decision: "", assessment: "", sort: "deadline", q: "", page: 1 };

let testDb: Awaited<ReturnType<typeof createTestDb>>;
let wide: string;
let narrow: string;

beforeAll(async () => {
  testDb = await createTestDb();
});
beforeEach(async () => {
  await testDb.reset();
  const { db } = testDb;
  await syncWindow(
    db,
    fakeAdapter([
      [
        loadFixture("uk-fat", "uk4-tender-defence"),
        loadFixture("uk-fat", "uk4-tender-covered-multilot"),
        loadFixture("uk-fat", "uk4-goods-below-threshold"),
      ],
    ]),
    { from: new Date("2026-10-12T00:00:00Z"), to: new Date("2026-10-13T00:00:00Z") },
  );
  await db.update(tenders).set({ submissionDeadline: sql`now() + interval '30 days'` });
  const profiles = await db
    .insert(criteriaProfiles)
    .values([
      { name: "Hepsi", rules: profileRulesSchema.parse({}) },
      { name: "Giyim", rules: profileRulesSchema.parse({ categoryIds: ["giyim"] }) },
    ])
    .returning({ id: criteriaProfiles.id });
  [wide, narrow] = profiles.map((p) => p.id) as [string, string];
  await rematch(db);
});
afterAll(async () => {
  await testDb.close();
});

describe("loadInbox", () => {
  it("lists each tender once with every profile it matched, nearest deadline first", async () => {
    await testDb.db.update(tenders).set({ submissionDeadline: sql`now() + interval '5 days'` }).where(eq(tenders.externalId, "096156-2026"));
    await testDb.db.update(tenders).set({ submissionDeadline: null }).where(eq(tenders.externalId, "096253-2026"));
    const { list, total, profiles } = await loadInbox(testDb.db, all);
    expect(total).toBe(3);
    expect(list.map((row) => row.tenderId.length > 0 && row.title.slice(0, 12))).toEqual([
      "High Quality",
      "715794488 - ",
      "LSL/MED/0222",
    ]);
    expect(profiles.map((p) => p.name)).toEqual(["Giyim", "Hepsi"]);
    const helmet = list.find((row) => row.title.includes("Helmet"));
    expect(helmet?.profiles.sort()).toEqual(["Giyim", "Hepsi"]);
    // No document links, but the notice names the buyer's portal.
    expect(helmet).toMatchObject({ isNew: true, current: true, decision: null, documents: { state: "portal" } });
  });

  it("summarises each tender's documents: files the analysis reads, files being read, the portal, or nothing", async () => {
    const { db } = testDb;
    const ids = new Map((await db.select({ id: tenders.id, externalId: tenders.externalId }).from(tenders)).map((t) => [t.externalId, t.id]));
    const [a, b, c] = ["096156-2026", "096253-2026", "096315-2026"].map((n) => ids.get(n)!) as [string, string, string];
    await db.delete(documents);
    await db.update(tenders).set({ documentsPortalUrl: null });
    const read = { fetchStatus: "fetched" as const, processedAt: new Date() };
    await db.insert(documents).values([
      // Two links to one PDF count once; a ZIP and a PDF without pages are not read by the analysis.
      { tenderId: a, origin: "auto", sourceUrl: "https://buyer.example/spec.pdf", ...read, storagePath: "a/spec.pdf", mime: KIND_MIME.pdf, pageCount: 4, sha256: "s1" },
      { tenderId: a, origin: "auto", sourceUrl: "https://buyer.example/spec-copy.pdf", ...read, storagePath: "a/spec.pdf", mime: KIND_MIME.pdf, pageCount: 4, sha256: "s1" },
      { tenderId: a, origin: "manual", filename: "terms.docx", ...read, storagePath: "a/terms.docx", mime: KIND_MIME.docx, textContent: "Terms", sha256: "s2" },
      { tenderId: a, origin: "auto", sourceUrl: "https://buyer.example/pack.zip", ...read, storagePath: "a/pack.zip", mime: KIND_MIME.zip, sha256: "s3" },
      { tenderId: a, origin: "auto", sourceUrl: "https://buyer.example/empty.pdf", ...read, storagePath: "a/empty.pdf", mime: KIND_MIME.pdf, pageCount: 0, sha256: "s4" },
      { tenderId: a, origin: "auto", sourceUrl: "https://portal.example/a", fetchStatus: "needs_manual" },
      // A stored file not read yet comes before the portal.
      { tenderId: b, origin: "manual", filename: "spec.pdf", fetchStatus: "fetched", storagePath: "b/spec.pdf", mime: KIND_MIME.pdf, sha256: "s5" },
      { tenderId: b, origin: "auto", sourceUrl: "https://portal.example/b", fetchStatus: "needs_manual" },
      { tenderId: c, origin: "auto", sourceUrl: "https://buyer.example/later.pdf", fetchStatus: "pending" },
    ]);
    const summaries = async () => new Map((await loadInbox(db, all)).list.map((row) => [row.tenderId, row.documents]));

    let docs = await summaries();
    expect(docs.get(a)).toEqual({ state: "files", files: 2 });
    expect(docs.get(b)).toEqual({ state: "reading" });
    expect(docs.get(c)).toEqual({ state: "none" });

    // Read but without pages, the upload leaves only the portal; a notice may name nothing but the portal.
    await db.update(documents).set({ processedAt: new Date() }).where(eq(documents.tenderId, b));
    await db.delete(documents).where(eq(documents.tenderId, c));
    await db.update(tenders).set({ documentsPortalUrl: "https://portal.example/c" }).where(eq(tenders.id, c));
    docs = await summaries();
    expect(docs.get(b)).toEqual({ state: "portal" });
    expect(docs.get(c)).toEqual({ state: "portal" });
  });

  it("pages over tenders, not match rows, and counts all of them", async () => {
    const first = await loadInbox(testDb.db, all, 2);
    expect(first.list).toHaveLength(2);
    expect(first.total).toBe(3);
    const second = await loadInbox(testDb.db, { ...all, page: 2 }, 2);
    expect(second.list).toHaveLength(1);
    expect(second.total).toBe(3);
    expect(second.list[0]?.tenderId).not.toBe(first.list[0]?.tenderId);
    expect(second.list[0]?.tenderId).not.toBe(first.list[1]?.tenderId);
  });

  it("filters by the latest decision, including a withdrawn one", async () => {
    const { db } = testDb;
    const [helmet] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, "096315-2026"));
    await db.insert(tenderReviews).values({ tenderId: helmet!.id, decision: "GO", decidedBy: "a@bozkor.com" });
    expect((await loadInbox(db, { ...all, decision: "GO" })).total).toBe(1);
    expect((await loadInbox(db, { ...all, decision: "none" })).total).toBe(2);

    await db.insert(tenderReviews).values({
      tenderId: helmet!.id,
      decision: null,
      decidedBy: "a@bozkor.com",
      decidedAt: sql`now() + interval '1 second'`,
    });
    expect((await loadInbox(db, { ...all, decision: "GO" })).total).toBe(0);
    expect((await loadInbox(db, { ...all, decision: "none" })).total).toBe(3);
  });

  it("hides ended matches and paused profiles, but keeps decided tenders findable", async () => {
    const { db } = testDb;
    await db.update(criteriaProfiles).set({ active: false }).where(eq(criteriaProfiles.id, wide));
    expect((await loadInbox(db, all)).total).toBe(1);

    await db.update(profileMatches).set({ unmatchedAt: sql`now()` }).where(eq(profileMatches.profileId, narrow));
    expect((await loadInbox(db, all)).total).toBe(0);

    const [helmet] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, "096315-2026"));
    await db.insert(tenderReviews).values({ tenderId: helmet!.id, decision: "GO", decidedBy: "a@bozkor.com" });
    // Every profile paused, as during a holiday.
    await db.update(criteriaProfiles).set({ active: false });
    const decided = await loadInbox(db, { ...all, decision: "GO" });
    expect(decided.total).toBe(1);
    expect(decided.list[0]?.current).toBe(false);
    // The page still offers the filters: there are profiles, just none active.
    expect(decided).toMatchObject({ hasAnyProfile: true, profiles: [] });
  });

  it("sorts by the qualification verdict and filters by its group", async () => {
    const { db } = testDb;
    const idOf = async (externalId: string) => (await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, externalId)))[0]!.id;
    const medical = await idOf("096253-2026");
    const helmet = await idOf("096315-2026");
    const verdict = async (tenderId: string, status: "NEEDS_SUPPLIER" | "COMMERCIAL_NO_BID", fit: [number, number]) => {
      const [facts] = await db
        .insert(analyses)
        .values({ tenderId, kind: "facts", model: "claude-haiku-5-5", promptVersion: "facts.v1", output: {}, valid: true })
        .returning({ id: analyses.id });
      await db.insert(tenderAssessments).values({
        tenderId,
        factsAnalysisId: facts!.id,
        policyVersion: "policy.v1",
        status,
        bestLot: "",
        explanation: `${status} gerekçesi`,
        fitLow: fit[0],
        fitHigh: fit[1],
        preliminaryLow: fit[0],
        preliminaryHigh: fit[1],
        confidence: 50,
      });
    };
    await verdict(helmet, "COMMERCIAL_NO_BID", [20, 60]);
    await verdict(medical, "NEEDS_SUPPLIER", [70, 90]);

    const { list, total } = await loadInbox(db, { ...all, sort: "assessment" });
    expect(total).toBe(3);
    expect(list.map((row) => [row.tenderId, row.assessmentStatus])).toEqual([
      [medical, "NEEDS_SUPPLIER"],
      [helmet, "COMMERCIAL_NO_BID"],
      [expect.any(String), null],
    ]);
    expect(list[0]).toMatchObject({ fitLow: 70, fitHigh: 90, assessmentExplanation: "NEEDS_SUPPLIER gerekçesi" });

    expect((await loadInbox(db, { ...all, assessment: "rejected" })).list.map((row) => row.tenderId)).toEqual([helmet]);
    expect((await loadInbox(db, { ...all, assessment: "promising" })).list.map((row) => row.tenderId)).toEqual([medical]);
    expect((await loadInbox(db, { ...all, assessment: "none" })).list.map((row) => row.assessmentStatus)).toEqual([null]);

    // The decision view carries verdicts too.
    await db.insert(tenderReviews).values({ tenderId: helmet, decision: "WATCH", decidedBy: "a@bozkor.com" });
    expect((await loadInbox(db, { ...all, decision: "WATCH" })).list[0]).toMatchObject({ tenderId: helmet, assessmentStatus: "COMMERCIAL_NO_BID" });

    // Out of scope leaves the everyday list but stays findable; a tender the team works on stays.
    await db.update(tenderAssessments).set({ status: "HARD_REJECT" });
    const everyday = (await loadInbox(db, all)).list.map((row) => row.tenderId);
    expect(everyday).not.toContain(medical);
    expect(everyday).toContain(helmet);
    expect((await loadInbox(db, { ...all, assessment: "rejected" })).list.map((row) => row.tenderId).sort()).toEqual([helmet, medical].sort());

    expect(inboxQuery({ ...all, sort: "assessment", assessment: "promising" }, 2)).toBe("?assessment=promising&sort=assessment&page=2");
    expect(readFilters({ assessment: "rejected", sort: "assessment" })).toMatchObject({ assessment: "rejected", sort: "assessment" });
    expect(readFilters({ assessment: "toString", sort: "score" })).toMatchObject({ assessment: "", sort: "deadline" });
  });

  it("reports the total on a page past the end", async () => {
    const page = await loadInbox(testDb.db, { ...all, page: 5 }, 2);
    expect(page).toMatchObject({ list: [], total: 3 });
  });

  it("keeps tenders the team is working on in the default view after their match ended", async () => {
    const { db } = testDb;
    const [helmet] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, "096315-2026"));
    const [medical] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, "096253-2026"));
    await db.insert(tenderReviews).values([
      { tenderId: helmet!.id, decision: "GO", decidedBy: "a@bozkor.com" },
      { tenderId: medical!.id, decision: "NO_GO", decidedBy: "a@bozkor.com" },
    ]);
    await db.update(profileMatches).set({ unmatchedAt: sql`now()` });

    const { list, total } = await loadInbox(db, all);
    expect(total).toBe(1);
    expect(list[0]).toMatchObject({ tenderId: helmet!.id, decision: "GO", current: false, profiles: [] });
    // A profile filter shows only that profile's current matches.
    expect((await loadInbox(db, { ...all, profile: narrow })).total).toBe(0);
  });

  it("finds a decided tender that never matched any profile", async () => {
    const { db } = testDb;
    const [medical] = await db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, "096253-2026"));
    await db.delete(profileMatches).where(eq(profileMatches.tenderId, medical!.id));
    await db.insert(tenderReviews).values({ tenderId: medical!.id, decision: "WATCH", decidedBy: "a@bozkor.com" });
    const watched = await loadInbox(db, { ...all, decision: "WATCH" });
    expect(watched.total).toBe(1);
    expect(watched.list[0]).toMatchObject({ profiles: [], current: false, isNew: false, decision: "WATCH" });
  });

  it("separates open from closed tenders", async () => {
    const { db } = testDb;
    await db.update(tenders).set({ status: "cancelled" }).where(eq(tenders.externalId, "096315-2026"));
    expect((await loadInbox(db, all)).total).toBe(2);
    expect((await loadInbox(db, { ...all, status: "closed" })).total).toBe(1);
    expect((await loadInbox(db, { ...all, status: "all" })).total).toBe(3);
  });
});

describe("search and counts", () => {
  const idOf = async (externalId: string) =>
    (await testDb.db.select({ id: tenders.id }).from(tenders).where(eq(tenders.externalId, externalId)))[0]!.id;
  const verdict = async (tenderId: string, status: "NEEDS_DOCUMENTS" | "COMMERCIAL_NO_BID" | "HARD_REJECT") => {
    const { db } = testDb;
    const [facts] = await db
      .insert(analyses)
      .values({ tenderId, kind: "facts", model: "claude-haiku-5-5", promptVersion: "facts.v1", output: {}, valid: true })
      .returning({ id: analyses.id });
    await db.insert(tenderAssessments).values({
      tenderId,
      factsAnalysisId: facts!.id,
      policyVersion: "policy.v1",
      status,
      bestLot: "",
      explanation: "",
      fitLow: 40,
      fitHigh: 60,
      preliminaryLow: 40,
      preliminaryHigh: 60,
      confidence: 50,
    });
  };

  it("searches the title, its Turkish translation, the buyer and the notice number", async () => {
    const { db } = testDb;
    const helmet = await idOf("096315-2026");
    const [row] = await db.select({ title: tenders.title, buyerName: tenders.buyerName }).from(tenders).where(eq(tenders.id, helmet));
    const ids = async (q: string) => (await loadInbox(db, { ...all, q })).list.map((r) => r.tenderId);

    expect(await ids(row!.title.slice(2, 14).toUpperCase())).toContain(helmet);
    expect(await ids(row!.buyerName!.slice(0, 8))).toContain(helmet);
    expect(await ids("096315")).toEqual([helmet]);
    expect(await ids("Kask alımı")).toEqual([]);
    await db
      .insert(analyses)
      .values({ tenderId: helmet, kind: "translation", model: "claude-haiku-5-5", promptVersion: "translate.v1", output: { title: "Polis için kask alımı" }, valid: true });
    expect(await ids("kask alımı")).toEqual([helmet]);
    // Wildcards are taken literally.
    expect(await ids("%")).toEqual([]);
    expect((await inboxCounts(db, { ...all, q: "096315" })).all).toBe(1);

    expect(readFilters({ q: "  zırh   yelek  " }).q).toBe("zırh yelek");
    expect(readFilters({ q: "x".repeat(300) }).q).toHaveLength(100);
    expect(inboxQuery({ ...all, q: "zırh yelek", source: "uk_fat" }, 2)).toBe("?source=uk_fat&q=z%C4%B1rh+yelek&page=2");
  });

  it("counts every verdict group over the same scope, matching what each tab lists", async () => {
    const { db } = testDb;
    const medical = await idOf("096253-2026");
    const helmet = await idOf("096315-2026");
    await verdict(medical, "NEEDS_DOCUMENTS");
    await verdict(helmet, "COMMERCIAL_NO_BID");

    const counts = await inboxCounts(db, all);
    expect(counts).toEqual({
      all: 3,
      unassessed: 1,
      newToday: 3,
      closingSoon: 0,
      needsDocuments: 1,
      groups: { promising: 1, conditional: 0, watch: 0, rejected: 1, expired: 0 },
    });
    expect((await loadInbox(db, all)).total).toBe(counts.all);
    for (const group of ["promising", "conditional", "watch", "rejected", "expired"] as const) {
      expect((await loadInbox(db, { ...all, assessment: group })).total).toBe(counts.groups[group]);
    }
    expect((await loadInbox(db, { ...all, assessment: "none" })).total).toBe(counts.unassessed);

    // Out of scope leaves "Tümü" but is counted in "Elenen", where the tab lists it.
    await db.update(tenderAssessments).set({ status: "HARD_REJECT" }).where(eq(tenderAssessments.tenderId, helmet));
    const after = await inboxCounts(db, all);
    expect(after).toMatchObject({ all: 2, groups: { rejected: 1 } });
    expect((await loadInbox(db, { ...all, assessment: "rejected" })).total).toBe(1);

    // Matched more than a day ago, and closing within a week.
    await db.update(profileMatches).set({ matchedAt: sql`now() - interval '2 days'` }).where(eq(profileMatches.tenderId, medical));
    await db.update(tenders).set({ submissionDeadline: sql`now() + interval '3 days'` }).where(eq(tenders.id, medical));
    expect(await inboxCounts(db, all)).toMatchObject({ newToday: 1, closingSoon: 1 });
  });

  it("narrows a read with an extra condition", async () => {
    const page = await loadInbox(testDb.db, all, 10, eq(tenders.externalId, "096253-2026"));
    expect(page.list.map((row) => row.externalId)).toEqual(["096253-2026"]);
    expect(page.total).toBe(1);
  });
});

describe("readFilters", () => {
  it("accepts known values and drops the rest", () => {
    expect(readFilters({ profile: "not-a-uuid", source: "x", status: "weird", decision: "MAYBE" })).toEqual(all);
    expect(readFilters({ source: "uk_fat", status: "closed", decision: "GO", page: "3" })).toMatchObject({
      source: "uk_fat",
      status: "closed",
      decision: "GO",
      page: 3,
    });
    for (const page of ["0", "-1", "2.5", "abc", "999999"]) expect(readFilters({ page }).page).toBe(1);
  });

  it("builds links that keep the filters and leave out defaults", () => {
    expect(inboxQuery(all)).toBe("");
    expect(inboxQuery({ ...all, source: "eu_ted", decision: "GO" }, 2)).toBe("?source=eu_ted&decision=GO&page=2");
    expect(inboxQuery({ ...all, status: "all", page: 4 }, 1)).toBe("?status=all");
  });
});
