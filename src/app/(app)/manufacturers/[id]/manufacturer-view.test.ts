import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Manufacturer } from "@/db/schema";
import { countryName, formatDate } from "@/lib/format";
import { prepareImport } from "@/manufacturers/import";
import type { ManufacturerDetail } from "@/manufacturers/queries";
import { ManufacturerView } from "./manufacturer-view";

// The firm's page, from the fixture package (tests/fixtures/manufacturers) as loadManufacturer gives it.

const DIR = "tests/fixtures/manufacturers";
const result = prepareImport({
  version: "2.3",
  pool: { name: "BOZKOR_Havuz_v2.3_2026-11-02.jsonl", bytes: readFileSync(`${DIR}/BOZKOR_Havuz_v2.3_2026-11-02.jsonl`) },
  sources: { name: "BOZKOR_Alan_Kaynaklari_v2.3.csv", bytes: readFileSync(`${DIR}/BOZKOR_Alan_Kaynaklari_v2.3.csv`) },
  sha256Sums: readFileSync(`${DIR}/SHA256SUMS.txt`, "utf8"),
});
if (!result.ok) throw new Error(result.errors.join("\n"));
const { plan } = result;

const SOLE = "BZ-AE7D8CA8AA9A";
const TSE = "BZ-4E21F4C301FA";
const PPE = "BZ-DC76763A5D77";
const NO_FAMILY = "BZ-4B1BD4D46469";
const ALPHA2_COUNTRIES = "BZ-6AD814B277D2";
const EM_DASH = String.fromCharCode(0x2014);

function detailOf(id: string, fields: Partial<Manufacturer> = {}): ManufacturerDetail {
  const m = plan.manufacturers.find((x) => x.id === id)!;
  const at = new Date("2026-11-02T10:00:00Z");
  return {
    manufacturer: { ...m, importId: 1, active: true, createdAt: at, updatedAt: at, ...fields },
    certifications: plan.certifications.filter((c) => c.manufacturerId === id).map((c, i) => ({ ...c, id: `00000000-0000-4000-8000-00000000000${i}` })),
    sources: plan.sources.filter((s) => s.manufacturerId === id),
  };
}

const html = (detail: ManufacturerDetail) => renderToStaticMarkup(createElement(ManufacturerView, { detail }));

describe("ManufacturerView", () => {
  it("shows the record section by section, with every field source", () => {
    const detail = detailOf(TSE);
    const out = html(detail);
    const m = detail.manufacturer;
    expect(out).toContain(m.legalName);
    for (const title of ["Kimlik", "Konum", "Üretim", "Belgeler", "Savunma ve ihracat", "İletişim", "Üretim kanıtı", "Araştırmacı notu", "Alan kaynakları"]) {
      expect(out).toContain(`>${title}<`);
    }
    expect(out).toContain("Teyitli fabrika adresi");
    expect(out).toContain(">TSE<");
    expect(out).toContain(formatDate(new Date("2026-11-12T12:00:00Z")));
    expect(out).toContain("TS ISO 8528-5:2022 / TS EN ISO 8528-13:2018");
    expect(out).toContain("Ürün belgesi");
    for (const e of m.emails) expect(out).toContain(`href="mailto:${e}"`);
    for (const p of m.phones) expect(out).toContain(`href="tel:${p.replace(/[^\d+]/g, "")}"`);
    expect(out).toContain("Web sitesini aç");
    for (const s of detail.sources) expect(out).toContain(`>${s.field.replace(/&/g, "&amp;")}<`);
    expect(out).not.toContain(EM_DASH);
  });

  it("says what the pool does not know, and what a value rests on", () => {
    expect(html(detailOf(NO_FAMILY))).toContain("Rehber adresi");
    expect(html(detailOf(NO_FAMILY))).toContain("Aile kodu yok");
    const unplaced = html(detailOf(ALPHA2_COUNTRIES));
    expect(unplaced).toContain("Bu firma için alan kaynağı yok.");
    expect(unplaced).toMatch(/text-warn[^>]*>Bilinmiyor/);
    for (const code of ["US", "DE", "ES"]) expect(unplaced).toContain(countryName(code));
    expect(html(detailOf(SOLE))).toMatch(/Şahıs işletmesi<\/span><span[^>]*>Evet/);
    expect(html(detailOf(PPE))).toMatch(/Şahıs işletmesi<\/span><span[^>]*><span[^>]*>Bilinmiyor/);
  });

  it("warns when the firm left the pool and when its production has no quote", () => {
    const gone = html(detailOf(TSE, { active: false, evidenceQuote: null }));
    expect(gone).toContain("Bu firma son havuz sürümünde yok.");
    expect(gone).toContain("havuzun 2.3 sürümünden");
    expect(gone).toContain("Üretim alıntısı yok.");
    expect(html(detailOf(TSE))).not.toContain("son havuz sürümünde yok");
  });

  it("lists the notes' items and links only web addresses, in a new tab", () => {
    const out = html(detailOf(TSE, { notes: "Birinci not; ikinci not; üçüncü not", identityUrl: "ornek.com.tr/kunye", website: "https://www.ornek.com.tr" }));
    expect(out.match(/<li class="flex gap-2">/g)?.length).toBeGreaterThanOrEqual(3);
    expect(out).toContain("ikinci not");
    expect(out).not.toContain('href="ornek.com.tr/kunye"');
    expect(out).toContain("ornek.com.tr/kunye");
    expect(out).toContain('href="https://www.ornek.com.tr" target="_blank" rel="noreferrer noopener"');
  });
});
