import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LotMatch, MatchCandidate } from "@/manufacturers/types";
import { ManufacturerLots, ManufacturersCard } from "./manufacturers-card";

// The card's layout of an answer, rendered to HTML; the fetch itself runs in the browser.

const candidate = (rank: number, fields: Partial<MatchCandidate> = {}): MatchCandidate => ({
  manufacturerId: `BZ-00000000000${rank}`,
  legalName: `Jeneratör ${rank} A.Ş.`,
  rank,
  reasons: [{ rule: "product", text: `Ürün: "taşınabilir jeneratör" (havuzda: Portatif jeneratörler)` }],
  missing: [],
  warnings: [],
  ...fields,
});

const render = (lots: LotMatch[]) => renderToStaticMarkup(createElement(ManufacturerLots, { lots }));

describe("ManufacturerLots", () => {
  it("shows the best three as candidates with their reasons, gaps and warnings, the rest folded", () => {
    const html = render([
      {
        lotNumber: "",
        status: "matched",
        families: ["F16"],
        top: [
          candidate(1, { missing: ["Güç 7,5 kVA havuzdaki aralığın dışında (18-1.100 kVA)"] }),
          candidate(2, { warnings: ["Araştırmacı notu: Düşük uygunluk"] }),
          candidate(3),
        ],
        others: [candidate(4), candidate(5)],
        notes: ["Aranan: taşınabilir jeneratör"],
      },
    ]);
    expect(html).toContain("1. aday");
    expect(html).toContain('href="/manufacturers/BZ-000000000001"');
    expect(html).toContain("Jeneratör");
    expect(html).toContain("Güç 7,5 kVA havuzdaki aralığın dışında (18-1.100 kVA)");
    expect(html).toContain("Araştırmacı notu: Düşük uygunluk");
    expect(html).toContain("2 aday daha");
    expect(html).toContain("Aranan: taşınabilir jeneratör");
    expect(html).not.toContain("\u2014");
  });

  it("says when the pool has no maker of the product, and why a lot is not matched", () => {
    const html = render([
      { lotNumber: "LOT-0001", status: "no_pool_match", families: [], top: [], others: [], notes: ["Aranan: sokak aydınlatma armatürü"] },
      { lotNumber: "LOT-0002", status: "not_goods", families: [], top: [], others: [], notes: ["Hizmet alımı: üretici eşleştirmesi yapılmaz."] },
    ]);
    expect(html).toContain("Lot 1");
    expect(html).toContain("Havuzda bu ürün için üretici yok.");
    expect(html).toContain("Hizmet alımı: üretici eşleştirmesi yapılmaz.");
  });
});

describe("ManufacturersCard", () => {
  it("starts with the button and asks nothing until it is pressed", () => {
    const html = renderToStaticMarkup(createElement(ManufacturersCard, { tenderId: "t1" }));
    expect(html).toContain("Uygun üreticileri bul");
    expect(html).toContain("Yapay zekâ kullanılmaz");
  });
});
