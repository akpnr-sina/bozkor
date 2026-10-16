import { describe, expect, it } from "vitest";
import { loadFixture } from "../../tests/helpers/fixtures";
import { foldNotices } from "./fold";
import type { NormalizedNotice } from "./types";
import { normalizeFatRelease } from "./uk-fat/normalize";

function notice(name: string, overrides: Record<string, unknown> = {}): NormalizedNotice {
  const raw = { ...loadFixture<Record<string, unknown>>("uk-fat", name), ...overrides };
  const n = normalizeFatRelease(raw);
  if (!n) throw new Error(`${name} normalized to null`);
  return n;
}

describe("foldNotices", () => {
  it("applies a change notice on top of the original tender", () => {
    const folded = foldNotices([notice("uk4-tender-before-change"), notice("uk4-tender-change")]);
    expect(folded.externalId).toBe("096284-2026");
    expect(folded.noticeCount).toBe(2);
    // The deadline moved from 30 November to 13 November.
    expect(folded.submissionDeadline?.toISOString()).toBe("2026-11-13T09:30:00.000Z");
    expect(folded.noticeUrl).toBe("https://www.find-tender.service.gov.uk/Notice/096284-2026");
    // Published date stays the date of the first tender notice.
    expect(folded.publishedAt.toISOString()).toBe("2026-10-12T15:42:20.000Z");
  });

  it("gives the same result whatever order the notices arrive in", () => {
    const a = foldNotices([notice("uk4-tender-before-change"), notice("uk4-tender-change")]);
    const b = foldNotices([notice("uk4-tender-change"), notice("uk4-tender-before-change")]);
    expect(b).toEqual(a);
  });

  it("keeps earlier facts when a cancellation only states the status", () => {
    const tender = notice("uk4-tender-before-change");
    const cancellation = notice("uk12-tender-cancellation", {
      ocid: tender.procedureKey,
      date: "2026-10-20T10:00:00+01:00",
    });
    const folded = foldNotices([tender, cancellation]);
    expect(folded.status).toBe("cancelled");
    expect(folded.regime).toBe("covered");
    expect(folded.cpvMain).toBe("71351914");
    expect(folded.submissionDeadline?.toISOString()).toBe("2026-11-30T09:30:00.000Z");
    // The cancellation lists lot 1 by number only; its CPVs and value survive.
    expect(folded.lots).toEqual([
      expect.objectContaining({ lotNumber: "1", cpv: ["71351914", "71354500", "73110000", "73112000"], valueAmount: 312_000 }),
    ]);
  });

  it("turns a planning record into a tender when the call for competition arrives", () => {
    const planning = notice("uk3-planning-planned-procurement");
    const tender = notice("uk4-tender-below-threshold", {
      ocid: planning.procedureKey,
      date: "2026-11-01T09:00:00Z",
    });
    const folded = foldNotices([planning, tender]);
    expect(folded.noticeType).toBe("tender");
    expect(folded.publishedAt.toISOString()).toBe("2026-11-01T09:00:00.000Z");
    expect(folded.regime).toBe("below_threshold");
  });

  it("takes the value and its currency from the same notice", () => {
    const withValue = notice("uk4-tender-before-change");
    const withoutValue = { ...notice("uk4-tender-change"), valueAmount: null, valueCurrency: null };
    const folded = foldNotices([withValue, withoutValue]);
    expect(folded).toMatchObject({ valueAmount: 312_000, valueCurrency: "GBP" });
  });

  it("collects document links from every notice", () => {
    const first = { ...notice("uk4-tender-before-change"), documents: [{ url: "https://a.test/1.pdf", title: "ITT", documentType: "biddingDocuments" }] };
    const second = { ...notice("uk4-tender-change"), documents: [{ url: "https://a.test/2.pdf", title: null, documentType: null }] };
    expect(foldNotices([first, second]).documents.map((d) => d.url)).toEqual(["https://a.test/1.pdf", "https://a.test/2.pdf"]);
  });

  it("lets an award notice change the status but not the tender's identity", () => {
    const tender = notice("uk4-tender-before-change");
    const award = notice("uk6-award", { ocid: tender.procedureKey, date: "2027-01-15T10:00:00Z" });
    const folded = foldNotices([tender, award]);
    expect(folded.status).toBe("awarded");
    expect(folded.externalId).toBe("096277-2026");
    expect(folded.noticeUrl).toBe("https://www.find-tender.service.gov.uk/Notice/096277-2026");
    expect(folded.publishedAt.toISOString()).toBe("2026-10-12T15:42:20.000Z");
    expect(folded.title).toBe(tender.title);
    expect(folded.submissionDeadline?.toISOString()).toBe("2026-11-30T09:30:00.000Z");
  });

  it("keeps the original description and CPVs when an old-regime correction arrives", () => {
    const correction = notice("celex-tender-update");
    const original = notice("celex-tender-old-regime", {
      ocid: correction.procedureKey,
      date: "2026-01-10T10:00:00Z",
    });
    const folded = foldNotices([original, correction]);
    expect(folded.externalId).toBe("096110-2026");
    expect(folded.description).toBe(original.description);
    expect(folded.cpvMain).toBe("33132000");
    expect(folded.cpvAdditional).toEqual(original.cpvAdditional);
    expect(folded.lots).toHaveLength(6);
    expect(folded.status).toBe("open");
  });

  it("keeps the contract details until a later notice states them again", () => {
    const correction = notice("celex-tender-update");
    const original = notice("celex-tender-old-regime", {
      ocid: correction.procedureKey,
      date: "2026-01-10T10:00:00Z",
    });
    // The correction repeats only the changed fragments.
    expect(original.details).not.toBeNull();
    expect(correction.details).toBeNull();
    expect(foldNotices([original, correction]).details).toEqual(original.details);

    const restated = { ...correction, details: { ...original.details!, durationMonths: 12 } };
    expect(foldNotices([restated, original]).details?.durationMonths).toBe(12);
  });

  it("refuses a list without a planning or tender notice", () => {
    expect(() => foldNotices([])).toThrow();
    expect(() => foldNotices([notice("uk6-award")])).toThrow();
  });
});
