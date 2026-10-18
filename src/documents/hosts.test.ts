import { describe, expect, it } from "vitest";
import { hostPolicy } from "./hosts";

describe("hostPolicy", () => {
  it("follows the pages of portals whose terms allow it, and leaves alone those whose terms forbid it", () => {
    expect(hostPolicy("https://ausschreibungen.giz.de/Satellite/notice/CXTRYY6Y1FY/documents")).toBe("follow");
    expect(hostPolicy("https://platformazakupowa.pl/transakcja/1373180")).toBe("forbidden");
    expect(hostPolicy("https://www.platformazakupowa.pl/transakcja/1373180")).toBe("forbidden");
    expect(hostPolicy("https://www.evergabe-online.de/tenderdocuments.html?id=871102")).toBe("link-only");
    expect(hostPolicy("https://www.evergabe.nrw.de/VMPSatellite/notice/CXPNYYDYTR1/documents")).toBe("follow");
    expect(hostPolicy("https://bieterzugang.deutsche-evergabe.de/x")).toBe("forbidden");
    expect(hostPolicy("https://notplatformazakupowa.pl/x")).toBe("link-only");
    expect(hostPolicy("https://www.tenderned.nl/aankondigingen/overzicht/442384")).toBe("link-only");
    expect(hostPolicy(null)).toBe("link-only");
    expect(hostPolicy("not a url")).toBe("link-only");
  });
});
