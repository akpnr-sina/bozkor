import { beforeEach, describe, expect, it, vi } from "vitest";
import { describeReason } from "@/matching/describe";
import type { PreviewResult } from "@/matching/apply";

// The profile form's reading routes: who may ask, what they check, what they answer.
// The session and the preview's database work are stand-ins; the CPV vocabulary is the real one.

vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn() }));
vi.mock("@/db", () => ({ getDb: vi.fn(() => "db") }));
vi.mock("@/matching/apply", () => ({ previewRules: vi.fn() }));
vi.mock("@/app/(app)/tenders/[id]/progress", () => ({ tenderProgress: vi.fn() }));

const { requireUser } = await import("@/lib/auth/session");
const { previewRules } = await import("@/matching/apply");
const { tenderProgress } = await import("@/app/(app)/tenders/[id]/progress");
const { GET: searchRoute } = await import("./cpv/search/route");
const { GET: treeRoute } = await import("./cpv/tree/route");
const { POST: previewRoute } = await import("./profiles/preview/route");
const { GET: progressRoute } = await import("./tenders/[id]/progress/route");

/** requireUser redirects to /login without a session; Next.js throws to do so. */
const signedOut = () => vi.mocked(requireUser).mockRejectedValue(new Error("NEXT_REDIRECT"));

beforeEach(() => {
  vi.mocked(requireUser).mockReset().mockResolvedValue({ id: "u1", email: "ekip@bozkor.com" });
  vi.mocked(previewRules).mockReset();
  vi.mocked(tenderProgress).mockReset();
});

const get = (path: string) => new Request(`http://localhost${path}`);
const post = (body: string) => new Request("http://localhost/api/profiles/preview", { method: "POST", body });

describe("GET /api/cpv/search", () => {
  it("answers goods codes for what was typed, cacheable for the session", async () => {
    const response = await searchRoute(get("/api/cpv/search?q=3112"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    const items = (await response.json()) as { prefix: string; label: string }[];
    expect(items[0]).toMatchObject({ prefix: "3112", label: "Generators" });
    expect(await (await searchRoute(get("/api/cpv/search"))).json()).toEqual([]);
  });

  it("refuses a query over 100 characters, and anyone signed out", async () => {
    const tooLong = await searchRoute(get(`/api/cpv/search?q=${"a".repeat(101)}`));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: "Arama en fazla 100 karakter olabilir." });
    signedOut();
    await expect(searchRoute(get("/api/cpv/search?q=3112"))).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("GET /api/cpv/tree", () => {
  it("answers the goods divisions without a prefix, the codes under one with it", async () => {
    const roots = (await (await treeRoute(get("/api/cpv/tree"))).json()) as { prefix: string }[];
    expect(roots).toHaveLength(22);
    expect(roots[0]).toMatchObject({ prefix: "03", level: "Bölüm" });
    const under = (await (await treeRoute(get("/api/cpv/tree?prefix=3112"))).json()) as { prefix: string }[];
    expect(under.map((item) => item.prefix)).toEqual(expect.arrayContaining(["31121", "31122"]));
  });

  it("refuses a prefix that is not 2 to 8 digits, and anyone signed out", async () => {
    for (const prefix of ["3", "123456789", "31a", "-1"]) {
      const response = await treeRoute(get(`/api/cpv/tree?prefix=${prefix}`));
      expect(response.status, prefix).toBe(400);
      expect(await response.json()).toEqual({ error: "Önek 2 ile 8 rakam arasında olmalı." });
    }
    signedOut();
    await expect(treeRoute(get("/api/cpv/tree"))).rejects.toThrow("NEXT_REDIRECT");
  });
});

describe("POST /api/profiles/preview", () => {
  const result: PreviewResult = {
    scanned: 120,
    matched: 2,
    openNow: 1,
    examples: [
      {
        id: "t1",
        title: "Generating sets for depots",
        publishedAt: new Date("2026-10-20T08:00:00Z"),
        reasons: [
          { rule: "noticeType", value: "tender" },
          { rule: "cpv", codes: ["31121000"], prefixes: ["3112"] },
          { rule: "country", value: "IE" },
        ],
      },
      { id: "t2", title: "Cables", publishedAt: null, reasons: [] },
    ],
    // Not in order: the route sorts them.
    rejections: { deadline: 18, topic: 100, value: 0 },
  };

  it("answers the preview of the rules with its words written, never cached", async () => {
    vi.mocked(previewRules).mockResolvedValue(result);
    const response = await previewRoute(post(JSON.stringify({ categoryIds: ["guc"], cpvInclude: ["31121000-7"] })));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "ok",
      result: {
        scanned: 120,
        matched: 2,
        openNow: 1,
        rejections: [
          { rule: "topic", label: "CPV ve anahtar kelimeler tutmuyor", count: 100 },
          { rule: "deadline", label: "Son tarih geçmiş ya da çok yakın", count: 18 },
        ],
        examples: [
          {
            id: "t1",
            title: "Generating sets for depots",
            publishedAt: "2026-10-20T08:00:00.000Z",
            reasons: result.examples[0]!.reasons.slice(0, 2).map(describeReason),
          },
          { id: "t2", title: "Cables", publishedAt: null, reasons: [] },
        ],
      },
    });
    // The rules as the schema reads them: the check digit dropped, defaults filled in.
    expect(vi.mocked(previewRules)).toHaveBeenCalledWith("db", expect.objectContaining({ categoryIds: ["guc"], cpvInclude: ["31121000"], triageThreshold: 60 }));
  });

  it("says why while the rules do not pass yet, asking the database nothing", async () => {
    const response = await previewRoute(post(JSON.stringify({ cpvInclude: ["3"] })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "invalid", message: "CPV öneki 2 ile 8 rakam arasında olmalı" });
    expect(previewRules).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON or is far too long, and anyone signed out", async () => {
    const notJson = await previewRoute(post("{cpvInclude:"));
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "Gövde JSON değil." });
    const tooLong = await previewRoute(post(JSON.stringify({ description: "x".repeat(70_000) })));
    expect(tooLong.status).toBe(413);
    signedOut();
    await expect(previewRoute(post("{}"))).rejects.toThrow("NEXT_REDIRECT");
    expect(previewRules).not.toHaveBeenCalled();
  });
});

describe("GET /api/tenders/[id]/progress", () => {
  const id = "4b0f3c9e-8f4e-4c2a-9d2b-1f6b2a3c4d5e";
  const context = (value: string) => ({ params: Promise.resolve({ id: value }) });

  it("answers what the tender page waits on, never cached", async () => {
    vi.mocked(tenderProgress).mockResolvedValue({ reading: 2, deep: "running" });
    const response = await progressRoute(get(`/api/tenders/${id}/progress`), context(id));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ reading: 2, deep: "running" });
    expect(tenderProgress).toHaveBeenCalledWith("db", id);
  });

  it("refuses an id that is not a tender's, and anyone signed out", async () => {
    const bad = await progressRoute(get("/api/tenders/x/progress"), context("x"));
    expect(bad.status).toBe(400);
    signedOut();
    await expect(progressRoute(get(`/api/tenders/${id}/progress`), context(id))).rejects.toThrow("NEXT_REDIRECT");
    expect(tenderProgress).not.toHaveBeenCalled();
  });
});
