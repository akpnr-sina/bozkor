import { describe, expect, it } from "vitest";
import { loadFixture } from "../../../tests/helpers/fixtures";
import { foldNotices } from "../fold";
import { normalizeTedNotice, tedNoticeKeys, tedTimestamp } from "./normalize";

type Raw = Record<string, unknown>;
const fixture = (name: string) => loadFixture<Raw>("eu-ted", name);

function normalized(name: string) {
  const notice = normalizeTedNotice(fixture(name));
  if (!notice) throw new Error(`${name} normalized to null`);
  return notice;
}

describe("normalizeTedNotice", () => {
  it("maps a single-lot supplies notice", () => {
    expect(normalized("ted-cn-supplies-single-lot")).toMatchObject({
      source: "eu_ted",
      externalId: "706689-2026",
      procedureKey: "995e9d05-5c76-401f-aa2c-2adea5c99bcf",
      noticeType: "tender",
      noticeCode: "cn-standard",
      regime: "covered",
      contractNature: "goods",
      status: "open",
      title: "FOURNITURE ET INSTALLATION DU NOUVEAU GROUPE ELECTROGENE DU CENTRE DRAMATIQUE NATIONAL NANTERRE AMANDIERS",
      buyerName: "Commune de Nanterre",
      buyerCountry: "FR",
      nutsCode: "FR105",
      cpvMain: "31121000",
      valueAmount: 600_000,
      valueCurrency: "EUR",
      procedureType: "Open procedure",
      noticeLanguage: "FR",
      noticeUrl: "https://ted.europa.eu/en/notice/-/detail/706689-2026",
      // Published on 13 October, Brussels calendar.
      publishedAt: new Date("2026-10-12T22:00:00Z"),
      submissionDeadline: new Date("2026-11-17T15:00:00Z"),
    });
  });

  it("maps lots by position and sums their values when the procedure has none", () => {
    const n = normalized("ted-cn-supplies-multi-lot");
    expect(n.lots).toEqual([
      expect.objectContaining({ lotNumber: "LOT-0001", title: "Analītiskie svari Lignīna ķīmijas laboratorijai", cpv: ["38000000"], valueAmount: 2000, valueCurrency: "EUR" }),
      expect.objectContaining({ lotNumber: "LOT-0002", valueAmount: 3500, valueCurrency: "EUR" }),
      expect.objectContaining({ lotNumber: "LOT-0003", title: "Apaļkolbu sildītāji Bioinženierijas laboratorijai", valueAmount: 1700 }),
    ]);
    expect(n).toMatchObject({ valueAmount: 7200, valueCurrency: "EUR", cpvMain: "38000000" });
    expect(n.cpvAdditional).toEqual(["38311100", "38436320"]);
    expect(n.documents).toEqual([
      { url: "https://www.eis.gov.lv/EKEIS/Supplier/Procurement/183715", title: null, documentType: "procurementDocuments" },
    ]);
  });

  it("leaves lot values empty when the field does not have one value per lot", () => {
    const n = normalized("ted-cn-supplies-partial-lot-values");
    expect(n.lots).toHaveLength(6);
    expect(n.lots?.every((l) => l.valueAmount === null && l.valueCurrency === null)).toBe(true);
    expect(n).toMatchObject({ valueAmount: 415_000_000, valueCurrency: "EUR" });
  });

  it("marks a cancellation intent as cancelled and reads zero amounts as unknown", () => {
    const n = normalized("ted-cn-cancel-intent");
    expect(n).toMatchObject({ status: "cancelled", valueAmount: null, valueCurrency: null });
    expect(n.lots?.map((l) => l.valueAmount)).toEqual([null, null, null, null]);
    expect(normalized("ted-cn-cancel-original").status).toBe("open");
  });

  it("treats a cancelled notice like a cancellation intent, but not a suspension", () => {
    const raw = fixture("ted-cn-cancel-intent");
    expect(normalizeTedNotice({ ...raw, "change-reason-code": "cancel" })?.status).toBe("cancelled");
    expect(normalizeTedNotice({ ...raw, "change-reason-code": "susp-review" })?.status).toBe("open");
  });

  it("keeps a tender cancelled when a correction follows the cancellation", () => {
    const correction = {
      ...fixture("ted-cn-cancel-intent"),
      "publication-number": "712000-2026",
      "publication-date": "2026-10-20+02:00",
      "change-reason-code": "cor-pub",
    };
    const notices = [fixture("ted-cn-cancel-original"), fixture("ted-cn-cancel-intent"), correction].map((raw) => normalizeTedNotice(raw)!);
    expect(notices.map((n) => n.status)).toEqual(["open", "cancelled", "open"]);
    expect(foldNotices(notices)).toMatchObject({ externalId: "712000-2026", status: "cancelled" });
  });

  it("skips qualification systems, which are supplier lists rather than purchases", () => {
    expect(normalizeTedNotice({ ...fixture("ted-cn-utilities"), "notice-type": "qu-sy" })).toBeNull();
  });

  it("maps the legal basis to a regime", () => {
    expect(normalized("ted-cn-utilities")).toMatchObject({ regime: "utilities", valueAmount: 3_600_000_000, valueCurrency: "CZK" });
    expect(normalized("ted-cn-defence").regime).toBe("defence");
    expect(normalized("ted-cn-other-legal-basis")).toMatchObject({ regime: "unknown", procedureType: "Other multiple stage procedure" });
    const raw = fixture("ted-cn-supplies-single-lot");
    expect(normalizeTedNotice({ ...raw, "legal-basis": ["32024R2509"] })?.regime).toBe("covered");
  });

  it("falls back to the deadline for requests to participate", () => {
    expect(normalized("ted-cn-request-deadline")).toMatchObject({
      procedureType: "Restricted procedure",
      submissionDeadline: new Date("2026-11-13T08:00:00Z"),
    });
  });

  it("prefers English texts and reports English as the notice language", () => {
    expect(normalized("ted-cn-english")).toMatchObject({
      title: "TENDER FOR THE SUPPLY AND DELIVERY OF HYUNDAI SPARE PARTS",
      noticeLanguage: "EN",
      buyerCountry: "IE",
    });
  });

  it("keeps the notice currency", () => {
    expect(normalized("ted-cn-non-eur-currency")).toMatchObject({ valueAmount: 4_000_000, valueCurrency: "DKK", cpvMain: "18110000" });
  });

  it("maps a prior information notice as planning, grouped by its own identifier", () => {
    expect(normalized("ted-pin-planning-supplies")).toMatchObject({
      noticeType: "planning",
      noticeCode: "pin-only",
      procedureKey: "b6941c41-100b-45d6-8d48-593708651a9f",
      status: "open",
      submissionDeadline: null,
      lots: null,
      documentsPortalUrl: null,
    });
  });

  it("uses the submission portal when there is no documents link", () => {
    expect(normalized("ted-cn-utilities")).toMatchObject({ documents: [], documentsPortalUrl: "https://josephine.proebiz.com/cs/" });
  });

  it("folds a chain of changes into the latest deadline", () => {
    const chain = ["ted-chain-4", "ted-chain-2", "ted-chain-1", "ted-chain-3"].map(normalized);
    const folded = foldNotices(chain);
    expect(folded).toMatchObject({
      externalId: "706847-2026",
      noticeCount: 4,
      publishedAt: new Date("2026-09-07T22:00:00Z"),
      submissionDeadline: new Date("2026-10-21T09:00:00Z"),
    });
  });

  it("returns null for other form types and throws without a publication number", () => {
    const raw = fixture("ted-cn-english");
    expect(normalizeTedNotice({ ...raw, "form-type": "result" })).toBeNull();
    expect(() => normalizeTedNotice({ ...raw, "publication-number": undefined })).toThrow();
    expect(() => normalizeTedNotice({ ...raw, "publication-date": "13 October" })).toThrow(/publication date/);
  });

  it("survives malformed optional fields", () => {
    const raw = fixture("ted-cn-english");
    const n = normalizeTedNotice({ ...raw, "estimated-value-proc": { amount: 1 }, "title-lot": "x", "identifier-lot": 7 });
    expect(n).toMatchObject({ valueAmount: 200_000, lots: [expect.objectContaining({ lotNumber: "7", title: null })] });
  });
});

describe("tedNoticeKeys", () => {
  it("groups a notice and its change by procedure identifier", () => {
    expect(tedNoticeKeys(fixture("ted-cn-original"))).toEqual({
      externalId: "633642-2026",
      procedureKey: "ee66f3ac-3344-4d4e-8247-d5982508bf96",
    });
    expect(tedNoticeKeys(fixture("ted-cn-change"))?.procedureKey).toBe("ee66f3ac-3344-4d4e-8247-d5982508bf96");
  });

  it("groups the change of a prior information notice with the notice it changes", () => {
    const pin = fixture("ted-pin-planning-supplies");
    const change = {
      ...pin,
      "publication-number": "712345-2026",
      "notice-identifier": "0c0c0c0c-1111-4222-8333-444444444444",
      "change-notice-version-identifier": "b6941c41-100b-45d6-8d48-593708651a9f-01",
    };
    expect(tedNoticeKeys(change)).toEqual({ externalId: "712345-2026", procedureKey: "b6941c41-100b-45d6-8d48-593708651a9f" });
  });

  it("skips payloads without a publication number", () => {
    expect(tedNoticeKeys({ "procedure-identifier": "x" })).toBeNull();
    expect(tedNoticeKeys(null)).toBeNull();
  });
});

describe("tedTimestamp", () => {
  it("combines a date and a time with their offset", () => {
    expect(tedTimestamp("2026-11-12+02:00", "10:00:00+02:00")).toEqual(new Date("2026-11-12T08:00:00Z"));
    expect(tedTimestamp("2026-11-16Z", "22:59:59Z")).toEqual(new Date("2026-11-16T22:59:59Z"));
  });

  it("takes the end of the day without a time and Brussels time without an offset", () => {
    expect(tedTimestamp("2026-11-12+01:00")).toEqual(new Date("2026-11-12T22:59:59Z"));
    expect(tedTimestamp("2026-07-01", "12:00:00")).toEqual(new Date("2026-07-01T10:00:00Z"));
  });

  it("returns null for unreadable dates", () => {
    expect(tedTimestamp(null)).toBeNull();
    expect(tedTimestamp("12/11/2026")).toBeNull();
  });
});
