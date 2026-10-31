import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FormattedText, numberedLines } from "./formatted-text";

const html = (text: string, numbered?: boolean) => renderToStaticMarkup(createElement(FormattedText, { text, numbered }));
const LEAD = '<p class="font-medium whitespace-pre-line text-ink-900">';
// [number, text] of each numbered item.
const items = (out: string) => [...out.matchAll(/<li class="flex items-baseline[^"]*"><span[^>]*>([^<]*)<\/span><div[^>]*>([^<]*)/g)].map((m) => [m[1], m[2]]);

describe("FormattedText", () => {
  it("shows paragraphs and bullet lists, with a lone lead line as its list's heading", () => {
    const out = html("Kafe mobilyası alınacak.\n\nÜrünler:\n- 20 sandalye\n- 5 masa\n\nTeslim yeri: Gwynedd.");
    expect(out).toContain('<p class="whitespace-pre-line">Kafe mobilyası alınacak.</p>');
    expect(out).toContain(`${LEAD}Ürünler:</p><ul class="list-[square] space-y-1 pl-5 marker:text-ink-400"><li>20 sandalye</li><li>5 masa</li></ul>`);
    expect(out).toContain('<p class="whitespace-pre-line">Teslim yeri: Gwynedd.</p>');
  });

  it("keeps a block without blank lines as one paragraph, and a dash inside text as text", () => {
    const out = html("Sıcaklık -5 ile 40 derece arası.\nİkinci satır.");
    expect(out).toContain("Sıcaklık -5 ile 40 derece arası.\nİkinci satır.");
    expect(out).not.toContain("<li>");
  });

  it("leads with a short line ending in a colon right before a list, a blank line between or not", () => {
    expect(html("Ürünler:\n\n- 20 sandalye\n- 5 masa")).toContain(`${LEAD}Ürünler:</p>`);
    expect(html("Parçalar:\n\n2.1 Pano\n2.2 Trafo")).toContain(`${LEAD}Parçalar:</p>`);
    expect(html("Kapsam aşağıdadır.\nÜrünler:\n- 20 sandalye\n- 5 masa")).not.toContain(LEAD);
    expect(html("Ürünler:\nhepsi yeni\n- 20 sandalye")).not.toContain(LEAD);
    expect(html("İhale, aşağıda belirtilen beş lot için ayrı ayrı yürütülmektedir:\n\n- Lot 1\n- Lot 2")).not.toContain(LEAD);
    expect(html("Not:\n\nTeslim Atina'ya.")).not.toContain(LEAD);
    expect(html("Teslim yeri:")).not.toContain(LEAD);
  });

  it("puts numbered lines in a list, the numbers in a column as wide as the longest", () => {
    const out = html("Parçalar:\n2.1 Orta gerilim panosu\n2.2 250 kVA elektrik panosu\n2.10 Transformatör");
    expect(out).toContain(`${LEAD}Parçalar:</p><ol`);
    expect(items(out)).toEqual([
      ["2.1", "Orta gerilim panosu"],
      ["2.2", "250 kVA elektrik panosu"],
      ["2.10", "Transformatör"],
    ]);
    expect(out).toContain('style="min-width:4ch"');
  });

  it("reads the other numberings, across blocks too", () => {
    expect(items(html("3.4. Teknik şartname ektedir.\n\n3.5. Kısım 11 şunları kapsar:\n- Montaj"))).toEqual([
      ["3.4.", "Teknik şartname ektedir."],
      ["3.5.", "Kısım 11 şunları kapsar:"],
    ]);
    expect(items(html("1) Birinci\n2) İkinci"))).toEqual([
      ["1)", "Birinci"],
      ["2)", "İkinci"],
    ]);
    expect(items(html("a) Sergi modernizasyonu.\n\nb) Geçici sergi."))).toEqual([
      ["a)", "Sergi modernizasyonu."],
      ["b)", "Geçici sergi."],
    ]);
    expect(items(html("(a) Bir\n(b) İki"))).toEqual([
      ["(a)", "Bir"],
      ["(b)", "İki"],
    ]);
  });

  it("leaves a single numbered line, thousands and numbered bullets as they are", () => {
    const single = html("2.5 MW gücünde jeneratör.\nTeslim: Atina.");
    expect(single).not.toContain("<ol");
    expect(single).toContain("2.5 MW gücünde jeneratör.\nTeslim: Atina.");
    expect(html("10.000 adet maske\n10.500 adet eldiven")).not.toContain("<ol");
    const bullets = html("- 1.11 numaralı ek\n- 1.12 numaralı ek");
    expect(bullets).not.toContain("<ol");
    expect(bullets).toContain("<li>1.11 numaralı ek</li><li>1.12 numaralı ek</li>");
  });

  it("keeps bullet lines right under a numbered item inside that item", () => {
    const out = html("4. Belgeler:\n- a) Kurumsal model belgesi\n- b) Uygunluk belgesi\n5. Teslim Łódź'e\n\n- Ayrı madde");
    expect(items(out)).toEqual([
      ["4.", "Belgeler:"],
      ["5.", "Teslim Łódź&#x27;e"],
    ]);
    expect(out).toMatch(/4\.<\/span><div[^>]*>Belgeler:<ul[^>]*><li>a\) Kurumsal model belgesi<\/li><li>b\) Uygunluk belgesi<\/li><\/ul><\/div>/);
    expect(out).toMatch(/<\/ol><ul[^>]*><li>Ayrı madde<\/li><\/ul>/);
  });

  it("lets the caller decide, for a lot whose neighbours number their items", () => {
    expect(items(html("1.1 Otomatik yem besleme sistemi", true))).toEqual([["1.1", "Otomatik yem besleme sistemi"]]);
    expect(html("2.1 Pano\n2.2 Transformatör", false)).not.toContain("<ol");
  });

  it("counts the lines that carry a list number", () => {
    expect(numberedLines("2.1 Pano\r\n2.2 Trafo\n- 2.3 madde\n10.000 adet\na) Bir")).toBe(3);
    expect(numberedLines("Düz metin.")).toBe(0);
  });
});
