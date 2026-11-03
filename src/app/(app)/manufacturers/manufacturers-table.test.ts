import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { prepareImport } from "@/manufacturers/import";
import { toProjection } from "@/manufacturers/projection";
import type { ManufacturerForMatch } from "@/manufacturers/types";
import { ManufacturersTable } from "./manufacturers-table";

// The list's rows, from the fixture package (tests/fixtures/manufacturers) as the projection gives them.

const DIR = "tests/fixtures/manufacturers";
const result = prepareImport({
  version: "2.3",
  pool: { name: "BOZKOR_Havuz_v2.3_2026-11-02.jsonl", bytes: readFileSync(`${DIR}/BOZKOR_Havuz_v2.3_2026-11-02.jsonl`) },
  sources: { name: "BOZKOR_Alan_Kaynaklari_v2.3.csv", bytes: readFileSync(`${DIR}/BOZKOR_Alan_Kaynaklari_v2.3.csv`) },
  sha256Sums: readFileSync(`${DIR}/SHA256SUMS.txt`, "utf8"),
});
if (!result.ok) throw new Error(result.errors.join("\n"));
const { plan } = result;

const rows: ManufacturerForMatch[] = toProjection(
  plan.manufacturers.map((m) => ({
    id: m.id,
    legalName: m.legalName,
    province: m.province,
    categories: m.categories,
    families: m.families,
    products: m.products,
    materials: m.materials,
    standards: m.standards,
    sizeRange: m.sizeRange,
    productionMethod: m.productionMethod,
    aqap: m.aqap,
    as9100: m.as9100,
    exports: m.exports,
    fitLevel: m.fitLevel,
    hasEvidenceQuote: m.evidenceQuote !== null,
    hasContact: m.emails.length > 0 || m.phones.length > 0,
    contactState: m.contactState,
  })),
  plan.certifications,
);

const html = (list: ManufacturerForMatch[]) => renderToStaticMarkup(createElement(ManufacturersTable, { rows: list }));

describe("ManufacturersTable", () => {
  it("links each firm to its page and shows its fields in Turkish", () => {
    const out = html(rows);
    for (const m of rows) expect(out).toContain(`href="/manufacturers/${m.id}"`);
    expect(out).toContain("Karmaşık jeneratörler");
    expect(out).toContain("F16 Jeneratör");
    expect(out).toContain("Temel endüstriyel ekipman");
    expect(out).toContain("İletişime geçilmedi");
    expect(out).not.toContain("\u2014");
  });

  it("shortens long product and certificate lists, AQAP once", () => {
    const genset = rows.find((m) => m.id === "BZ-09082A7038E3")!;
    const out = html([{ ...genset, products: ["a", "b", "c", "d", "e"], certifications: [...genset.certifications, { name: "ISO 9001", kind: "management", validUntil: null }, { name: "CE", kind: "product", validUntil: null }] }]);
    expect(out).toContain("a, b, c");
    expect(out).toContain("ve 2 ürün daha");
    // AQAP 2110 from the column and from the certificates is one badge: 4 names, 3 shown.
    expect(out.match(/>AQAP 2110</g)).toHaveLength(1);
    expect(out).toContain(">+1<");
  });

  it("says what is not known: the province, certificates, contacts; and warns of a low fit", () => {
    const bare = { ...rows[0]!, province: null, certifications: [], aqap: "unknown" as const, hasContact: false, fitLevel: "low" as const, products: [] };
    const out = html([bare]);
    expect(out).toContain("Bilinmiyor");
    expect(out).toContain("İletişim bilgisi yok");
    expect(out).toContain("Araştırmacı notu: Düşük");
    expect(out).toContain(">Yok<");
  });
});
