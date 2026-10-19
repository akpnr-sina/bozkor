import { describe, expect, it } from "vitest";
import { apiOf, hostPolicy, takesDocuments } from "./hosts";

describe("hostPolicy", () => {
  it("follows the pages of portals whose terms allow it, and leaves alone those whose terms forbid it", () => {
    expect(hostPolicy("https://ausschreibungen.giz.de/Satellite/notice/CXTRYY6Y1FY/documents")).toBe("follow");
    expect(hostPolicy("https://platformazakupowa.pl/transakcja/1373180")).toBe("forbidden");
    expect(hostPolicy("https://www.platformazakupowa.pl/transakcja/1373180")).toBe("forbidden");
    expect(hostPolicy("https://www.evergabe-online.de/tenderdocuments.html?id=871102")).toBe("link-only");
    expect(hostPolicy("https://www.evergabe.nrw.de/VMPSatellite/notice/CXPNYYDYTR1/documents")).toBe("follow");
    expect(hostPolicy("https://bieterzugang.deutsche-evergabe.de/x")).toBe("forbidden");
    expect(hostPolicy("https://e-licitatie.ro/pub/notices/c-notice/v2/view/100211996")).toBe("forbidden");
    expect(hostPolicy("https://community.vortal.biz/Public/public-tender-documents/abc")).toBe("forbidden");
    expect(hostPolicy("https://notplatformazakupowa.pl/x")).toBe("link-only");
    expect(hostPolicy("https://www.tenderned.nl/aankondigingen/overzicht/442384")).toBe("api");
    expect(hostPolicy(null)).toBe("link-only");
    expect(hostPolicy("not a url")).toBe("link-only");
  });

  it("names the API a portal's documents come from, and tells which portals' documents are taken", () => {
    expect(apiOf("https://www.tenderned.nl/aankondigingen/overzicht/442384")).toBe("TenderNed");
    expect(apiOf("https://ausschreibungen.giz.de/Satellite/notice/X/documents")).toBeNull();
    expect(apiOf("https://nottenderned.nl/x")).toBeNull();
    expect(apiOf(null)).toBeNull();
    expect(takesDocuments("https://www.tenderned.nl/aankondigingen/overzicht/442384")).toBe(true);
    expect(takesDocuments("https://www.evergabe.nrw.de/VMPSatellite/notice/X/documents")).toBe(true);
    expect(takesDocuments("https://platformazakupowa.pl/transakcja/1")).toBe(false);
    expect(takesDocuments("https://example.org/x.pdf")).toBe(false);
  });
});
