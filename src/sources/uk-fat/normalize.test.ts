import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../tests/helpers/fixtures";
import { extractUrl, fatNoticeKeys, normalizeFatRelease } from "./normalize";

const fixture = (name: string) => loadFixture("uk-fat", name);

function normalized(name: string) {
  const notice = normalizeFatRelease(fixture(name));
  if (!notice) throw new Error(`${name} normalized to null`);
  return notice;
}

describe("normalizeFatRelease", () => {
  it("maps an above-threshold tender notice with lots", () => {
    const n = normalized("uk4-tender-covered-multilot");
    expect(n).toMatchObject({
      source: "uk_fat",
      externalId: "096253-2026",
      procedureKey: "ocds-h6vhtk-060198",
      noticeType: "tender",
      noticeCode: "UK4",
      regime: "covered",
      status: "open",
      buyerName: "LEIDOS SUPPLY, LIMITED",
      buyerCountry: "GB",
      cpvMain: "33100000",
      cpvAdditional: ["33170000", "33140000", "33190000"],
      // Net value, not the VAT-inclusive amountGross of 7,200,000.
      valueAmount: 6_000_000,
      valueCurrency: "GBP",
      procedureType: "Open procedure",
      noticeLanguage: "EN",
      noticeUrl: "https://www.find-tender.service.gov.uk/Notice/096253-2026",
      documentsPortalUrl: "https://leidos-supply.app.jaggaer.com/",
    });
    expect(n.publishedAt.toISOString()).toBe("2026-10-12T15:26:28.000Z");
    expect(n.submissionDeadline?.toISOString()).toBe("2026-11-09T17:00:00.000Z");
    expect(n.clarificationDeadline?.toISOString()).toBe("2026-11-03T12:00:00.000Z");
    expect(n.lots).toEqual([
      expect.objectContaining({ lotNumber: "1", title: "IO Sternal Access Device", valueAmount: 3_000_000, valueCurrency: "GBP" }),
      expect.objectContaining({ lotNumber: "2", title: "IO Limb Access System", valueAmount: 3_000_000, valueCurrency: "GBP" }),
    ]);
    expect(n.lots?.[0]?.cpv).toEqual(["33100000", "33170000", "33140000", "33190000"]);
    // The notice page itself and the unpublished conflict-of-interest entry are not documents.
    expect(n.documents).toEqual([]);
  });

  it("reads below-threshold notices with a gross-only value and a bare portal domain", () => {
    const n = normalized("uk4-tender-below-threshold");
    expect(n.regime).toBe("below_threshold");
    expect(n.valueAmount).toBe(185_000);
    expect(n.documentsPortalUrl).toBe("https://www.suffolksourcing.uk");
    expect(n.documents).toEqual([
      {
        url: "https://www.find-tender.service.gov.uk/Notice/Attachment/A-23996",
        title: null,
        documentType: "biddingDocuments",
      },
    ]);
  });

  it("replaces the AED form default on lots with the tender currency", () => {
    const n = normalized("uk4-tender-below-threshold");
    expect(n.lots).toEqual([expect.objectContaining({ valueAmount: 185_000, valueCurrency: "GBP" })]);
  });

  it("uses the expression of interest deadline when there is no tender period", () => {
    const n = normalized("uk4-tender-utilities-eoi-deadline");
    expect(n.regime).toBe("utilities");
    expect(n.procedureType).toBe("Competitive flexible procedure");
    expect(n.submissionDeadline?.toISOString()).toBe("2026-11-09T14:00:00.000Z");
  });

  it("maps defence and security notices to the defence regime", () => {
    expect(normalized("uk4-tender-defence").regime).toBe("defence");
  });

  it("maps a market engagement notice as planning without a deadline", () => {
    const n = normalized("uk2-planning-market-engagement");
    expect(n).toMatchObject({ noticeType: "planning", noticeCode: "UK2", regime: "utilities", status: "open" });
    expect(n.submissionDeadline).toBeNull();
    expect(n.description).toBeTruthy();
  });

  it("maps a planned procurement notice with its future deadline", () => {
    const n = normalized("uk3-planning-planned-procurement");
    expect(n).toMatchObject({ noticeType: "planning", noticeCode: "UK3", regime: "covered", valueAmount: 290_000 });
    expect(n.submissionDeadline?.toISOString()).toBe("2026-12-07T14:00:00.000Z");
    expect(n.lots).toEqual([expect.objectContaining({ lotNumber: "LOT-0000", cpv: ["80500000", "80000000"] })]);
  });

  it("marks a procurement termination notice as cancelled and leaves unknown fields empty", () => {
    const n = normalized("uk12-tender-cancellation");
    expect(n).toMatchObject({ noticeType: "tender", noticeCode: "UK12", status: "cancelled", regime: null, cpvMain: null });
    expect(n.cpvAdditional).toEqual([]);
    expect(n.submissionDeadline).toBeNull();
    // Lots listed by number and status only do not redefine the tender's lots.
    expect(n.lots).toBeNull();
  });

  it("treats a termination of some lots, with the procurement still active, as no status change", () => {
    const raw = fixture("uk12-tender-cancellation") as { tender: Record<string, unknown> };
    const n = normalizeFatRelease({ ...raw, tender: { ...raw.tender, status: "active" } });
    expect(n?.status).toBeNull();
  });

  it("skips lots without an id instead of inventing one", () => {
    const raw = fixture("uk4-tender-covered-multilot") as { tender: { lots: Record<string, unknown>[] } };
    const [first, second] = raw.tender.lots;
    const n = normalizeFatRelease({ ...raw, tender: { ...raw.tender, lots: [first, { ...second, id: undefined }] } });
    expect(n?.lots?.map((l) => l.lotNumber)).toEqual(["1"]);
  });

  it("reads old-regime notices with a main CPV and many lots", () => {
    const n = normalized("celex-tender-old-regime");
    expect(n).toMatchObject({ regime: "covered", noticeCode: null, cpvMain: "33132000", valueAmount: null });
    expect(n.cpvAdditional).toContain("72267100");
    expect(n.lots).toHaveLength(6);
    expect(n.documentsPortalUrl).toBe("https://www.publictendersscotland.publiccontractsscotland.gov.uk/");
  });

  it("keeps an old-regime correction partial so it cannot overwrite the original notice", () => {
    const n = normalized("celex-tender-update");
    expect(n).toMatchObject({ noticeType: "tender", status: null, submissionDeadline: null, valueAmount: null });
    expect(n.title).toContain("Population Health Improvement Programme");
    // Its description is the correction text and it repeats only the main CPV.
    expect(n.description).toBeNull();
    expect(n.cpvMain).toBeNull();
    expect(n.cpvAdditional).toEqual([]);
    expect(n.lots).toBeNull();
  });

  it("reads the main nature of the contract", () => {
    expect(normalized("uk4-goods-below-threshold").contractNature).toBe("goods");
    expect(normalized("uk4-tender-below-threshold").contractNature).toBe("services");
    expect(normalized("uk6-award").contractNature).toBeNull();
    const raw = fixture("uk4-goods-below-threshold") as { tender: Record<string, unknown> };
    const other = normalizeFatRelease({ ...raw, tender: { ...raw.tender, mainProcurementCategory: "other" } });
    expect(other).not.toBeNull();
    expect(other!.contractNature).toBeNull();
  });

  it("maps award and contract notices to a status-only notice", () => {
    const n = normalized("uk6-award");
    expect(n).toMatchObject({ noticeType: "award", status: "awarded", title: null, noticeUrl: null, lots: null });
    expect(n.documents).toEqual([]);
  });

  it("throws when identity fields are missing", () => {
    expect(() => normalizeFatRelease({ id: "1", date: "2026-10-12T10:00:00Z", tag: ["tender"] })).toThrow();
    expect(() => normalizeFatRelease("not a release")).toThrow();
  });
});

describe("fatNoticeKeys", () => {
  it("returns keys for every stage, so every raw payload is stored", () => {
    expect(fatNoticeKeys(fixture("uk4-tender-change"))).toEqual({
      externalId: "096284-2026",
      procedureKey: "ocds-h6vhtk-078603",
    });
    expect(fatNoticeKeys(fixture("uk2-planning-market-engagement"))).not.toBeNull();
    expect(fatNoticeKeys(fixture("uk6-award"))).not.toBeNull();
  });

  it("skips payloads without an identity", () => {
    expect(fatNoticeKeys({ id: 1 })).toBeNull();
    expect(fatNoticeKeys({ id: "1", ocid: "" })).toBeNull();
    expect(fatNoticeKeys(null)).toBeNull();
  });
});

describe("extractUrl", () => {
  it("finds a URL inside free text", () => {
    expect(extractUrl("Register at https://example.com/portal. Thanks")).toBe("https://example.com/portal");
  });

  it("adds https to bare domains", () => {
    expect(extractUrl("www.suffolksourcing.uk")).toBe("https://www.suffolksourcing.uk");
  });

  it("returns null for text without a link", () => {
    expect(extractUrl("By email to the contact named above")).toBeNull();
    expect(extractUrl(null)).toBeNull();
  });
});
