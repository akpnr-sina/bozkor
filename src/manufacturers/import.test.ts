import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseCsv } from "@/matching/cpv/source";
import {
  certificationKind,
  countryCode,
  emailsIn,
  findingLines,
  firmTokens,
  fold,
  hasCompanyForm,
  hasFreeMail,
  hasMobileNumber,
  hasPersonLink,
  hasTckn,
  isRoleOrFirmMailbox,
  isValidTckn,
  isValidVkn,
  packageFileNames,
  parseCertifications,
  parseSha256Sums,
  POOL_COLUMNS,
  prepareImport,
  sha256Hex,
  SOURCE_COLUMNS,
  splitList,
  type PackageInput,
} from "./import";

// tests/fixtures/manufacturers holds 8 firms of pool v2.3 and their field sources (rule 8; the pool itself
// stays out of the repository). The sole proprietor's mailbox and lines there are reserved examples
// (example.com, +90258000000x): a sole proprietor's contacts are the owner's.

const DIR = "tests/fixtures/manufacturers";
const POOL = "BOZKOR_Havuz_v2.3_2026-11-02.jsonl";
const SOURCES = "BOZKOR_Alan_Kaynaklari_v2.3.csv";
const poolBytes = readFileSync(`${DIR}/${POOL}`);
const sourcesBytes = readFileSync(`${DIR}/${SOURCES}`);
const sums = readFileSync(`${DIR}/SHA256SUMS.txt`, "utf8");
const fixtureRows = poolBytes
  .toString("utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const sourcesText = sourcesBytes.toString("utf8").replace(/^\uFEFF/, "");

const SOLE = "BZ-AE7D8CA8AA9A"; // sole proprietor
const GENSET = "BZ-09082A7038E3"; // two categories, AQAP, dated certificates, kVA
const TSE = "BZ-4E21F4C301FA"; // generator with a TSE certificate, factory address
const PPE = "BZ-DC76763A5D77"; // F14, sole proprietor unknown
const NO_FAMILY = "BZ-4B1BD4D46469";
const TURKISH_COUNTRIES = "BZ-DD4301247FEE";
const ALPHA2_COUNTRIES = "BZ-6AD814B277D2"; // no field sources
const TWO_PROVINCES = "BZ-B5782896F16B";

const fixture = (): PackageInput => ({
  version: "2.3",
  pool: { name: POOL, bytes: poolBytes },
  sources: { name: SOURCES, bytes: sourcesBytes },
  sha256Sums: sums,
});

const csvCell = (c: string) => (/[",\r\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c);

/** A package of these rows and sources, with SHA256SUMS that match. */
function pkg(rows: Record<string, unknown>[], sourceRows: string[][] = parseCsv(sourcesText)): PackageInput {
  const pool = Buffer.from(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  const sources = Buffer.from(`\uFEFF${sourceRows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`);
  return {
    version: "2.3",
    pool: { name: POOL, bytes: pool },
    sources: { name: SOURCES, bytes: sources },
    sha256Sums: `${sha256Hex(sources)}  ${SOURCES}\n${sha256Hex(pool)}  ${POOL}\n`,
  };
}

/** The fixture rows with one firm's columns replaced. */
const withFirm = (id: string, fields: Record<string, unknown>) => fixtureRows.map((r) => (r["Firma ID"] === id ? { ...r, ...fields } : r));

/** The fixture's source rows (header first), edited. */
function editedSources(edit: (rows: string[][]) => void): string[][] {
  const rows = parseCsv(sourcesText).filter((r) => !(r.length === 1 && r[0] === ""));
  edit(rows);
  return rows;
}

function planOf(input: PackageInput) {
  const result = prepareImport(input);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  return result.plan;
}

function errorsOf(input: PackageInput): string[] {
  const result = prepareImport(input);
  if (result.ok) throw new Error("The package passed");
  return result.errors;
}

const firm = (input: PackageInput, id: string) => planOf(input).manufacturers.find((m) => m.id === id);

describe("the fixture package", () => {
  it("has exactly the pool's 48 columns, in the package's order", () => {
    expect(POOL_COLUMNS).toHaveLength(48);
    for (const row of fixtureRows) expect(Object.keys(row)).toEqual([...POOL_COLUMNS]);
    expect(parseCsv(sourcesText)[0]).toEqual([...SOURCE_COLUMNS]);
  });

  it("maps every firm, certificate and field source, and notes what it decided", () => {
    const plan = planOf(fixture());
    expect(plan).toMatchObject({ version: "2.3", poolRows: 8, sourceRows: 237, poolSha256: sha256Hex(poolBytes), sourcesSha256: sha256Hex(sourcesBytes) });
    expect(plan.manufacturers.map((m) => m.id)).toEqual([SOLE, GENSET, TSE, PPE, NO_FAMILY, TURKISH_COUNTRIES, ALPHA2_COUNTRIES, TWO_PROVINCES]);
    expect(plan.sources).toHaveLength(237);
    expect(plan.sources.filter((s) => s.manufacturerId === ALPHA2_COUNTRIES)).toEqual([]);
    expect(plan.rejected).toEqual([]);
    expect(plan.notes).toEqual([{ manufacturerId: TWO_PROVINCES, text: "Fabrika il'de 2 il var; ilki alındı." }]);
    expect(prepareImport(fixture())).toEqual(prepareImport(fixture()));
  });

  it("keeps the pool's meaning in the records", () => {
    const plan = planOf(fixture());
    const byId = new Map(plan.manufacturers.map((m) => [m.id, m]));
    expect(byId.get(SOLE)).toMatchObject({
      legalName: "İLKETEKS",
      soleProprietor: true,
      vkn: null,
      mersis: null,
      kind: "producer_trader",
      province: "Denizli",
      district: "Merkezefendi",
      provinceBasis: "company",
      addressKind: "unknown",
      categories: ["TEXTILES_WORKWEAR"],
      families: ["F13"],
      emails: ["info@example.com"],
      phones: ["+902580000000", "+902580000001"],
      moq: "10 adet (özel renk/model/logo için değişebilir)",
      fitLevel: "medium",
      contactState: "not_contacted",
      checkedOn: "2026-11-02",
      poolVersion: "2.3",
    });
    expect(byId.get(GENSET)).toMatchObject({
      categories: ["LARGE_PREFAB_STRUCTURES", "COMPLEX_GENERATORS"],
      families: ["F15", "F16"],
      aqap: "2110",
      exports: "yes",
      sizeRange: "Katalog modelleri: standby 3-80 kVA;sürekli 2.5-62.5 kVA",
    });
    expect(byId.get(TSE)).toMatchObject({ province: "Tekirdağ", provinceBasis: "factory", addressKind: "factory", osbZones: [expect.any(String)] });
    expect(byId.get(TSE)!.vkn).toMatch(/^\d{10}$/);
    expect(byId.get(PPE)).toMatchObject({ soleProprietor: null, families: ["F14"], categories: ["BASIC_EQUIPMENT"] });
    // No factory province: the directory's, from the notes.
    expect(byId.get(NO_FAMILY)).toMatchObject({ families: [], province: "Tekirdağ", provinceBasis: "directory" });
    expect(byId.get(TURKISH_COUNTRIES)!.exportCountries).toEqual(["DE", "FR", "CH", "AZ", "KZ", "TJ", "IQ", "QA", "RU", "CI", "GA", "LY"]);
    expect(byId.get(ALPHA2_COUNTRIES)).toMatchObject({ exportCountries: ["US", "DE", "ES"], province: null, provinceBasis: "unknown" });
    expect(byId.get(ALPHA2_COUNTRIES)!.mersis!.slice(1, 11)).toBe(byId.get(ALPHA2_COUNTRIES)!.vkn);
    expect(byId.get(TWO_PROVINCES)).toMatchObject({ province: "İstanbul", provinceBasis: "company" });
  });

  it("parses the certificates with their validity, and links the firm's one source", () => {
    const plan = planOf(fixture());
    expect(plan.certifications.map(({ manufacturerId, name, kind, validUntil, note }) => [manufacturerId, name, kind, validUntil, note])).toEqual([
      [GENSET, "AQAP 2110", "defense", "2029-06-11", null],
      [GENSET, "AQAP 2310", "defense", "2029-06-11", null],
      [TSE, "TSE", "product", "2026-11-12", "TS ISO 8528-5:2022 / TS EN ISO 8528-13:2018"],
      [PPE, "ISO 9001:2015", "management", null, "bitiş tarihi bilinmiyor"],
      [PPE, "CE", "product", null, "kapsam/bitiş tarihi bilinmiyor"],
      [TWO_PROVINCES, "ISO 9001", "management", null, "bitiş tarihi bilinmiyor"],
      [TWO_PROVINCES, "CE", "product", null, "ürün kapsamı/bitiş tarihi bilinmiyor"],
    ]);
    const gensetUrl = fixtureRows.find((r) => r["Firma ID"] === GENSET)!["Sertifika kaynağı (URL)"];
    expect(plan.certifications.filter((c) => c.manufacturerId === GENSET).map((c) => c.sourceUrl)).toEqual([gensetUrl, gensetUrl]);
  });

  it("lists the sole proprietor's links and the unknowns for review, naming places only", () => {
    const plan = planOf(fixture());
    const tally = new Map<string, number>();
    for (const f of plan.review) tally.set(`${f.manufacturerId} ${f.rule}`, (tally.get(`${f.manufacturerId} ${f.rule}`) ?? 0) + 1);
    expect(Object.fromEntries(tally)).toEqual({
      [`${SOLE} sole_proprietor_link`]: 35,
      [`${PPE} sole_proprietor_unknown`]: 1,
      [`${PPE} no_company_form`]: 1,
    });
    expect(plan.review).toContainEqual({ manufacturerId: SOLE, place: "Web sitesi", rule: "sole_proprietor_link" });
    expect(plan.review).toContainEqual({ manufacturerId: SOLE, place: "Alan kaynakları: Genel telefon", rule: "sole_proprietor_link" });
    expect(JSON.stringify(plan.review)).not.toMatch(/https?:|@|\+90/);
  });
});

describe("the package checks", () => {
  it("compares both files with SHA256SUMS", () => {
    const changed = Buffer.from(poolBytes.toString("utf8").replace("İLKETEKS", "ILKETEKS"));
    expect(errorsOf({ ...fixture(), pool: { name: POOL, bytes: changed } })).toEqual([
      `${POOL}: SHA-256 özeti SHA256SUMS'takiyle aynı değil (dosya değişmiş ya da eksik).`,
    ]);
    const onlySources = sums.split("\n").filter((l) => l.includes(SOURCES)).join("\n");
    expect(errorsOf({ ...fixture(), sha256Sums: onlySources })).toEqual([`SHA256SUMS'ta ${POOL} yok.`]);
  });

  it("reads sha256sum's format", () => {
    const a = "a".repeat(64);
    const b = "B".repeat(64);
    expect(parseSha256Sums(`${a}  one.csv\r\n${b} *two.jsonl\nnot a line\n`)).toEqual(
      new Map([
        ["one.csv", a],
        ["two.jsonl", "b".repeat(64)],
      ]),
    );
  });

  it("finds the version's files in a folder", () => {
    const names = [POOL, SOURCES, "SHA256SUMS.txt", "BOZKOR_Havuz_v2.3_2026-11-02.csv", "BOZKOR_Havuz_v2.2_2026-11-01.jsonl"];
    expect(packageFileNames(names, "2.3")).toEqual({ pool: POOL, sources: SOURCES });
    expect(packageFileNames(names, "2.4")).toEqual({ error: "Klasörde BOZKOR_Havuz_v2.4_<tarih>.jsonl yok." });
    expect(packageFileNames([...names, "BOZKOR_Havuz_v2.3_2026-11-03.jsonl"], "2.3")).toMatchObject({ error: expect.stringContaining("birden çok havuz dosyası") });
    expect(packageFileNames([POOL], "2.3")).toEqual({ error: `Klasörde ${SOURCES} yok.` });
    // The version is text: "2x3" is not "2.3".
    expect(packageFileNames(["BOZKOR_Havuz_v2x3_2026-11-02.jsonl", "BOZKOR_Alan_Kaynaklari_v2x3.csv"], "2.3")).toMatchObject({ error: expect.any(String) });
  });

  it("stops on a file that is not UTF-8 or a line that is not JSON", () => {
    const binary = Buffer.concat([poolBytes, Buffer.from([0xff, 0x0a])]);
    const sumsFor = (bytes: Buffer) => `${sha256Hex(sourcesBytes)}  ${SOURCES}\n${sha256Hex(bytes)}  ${POOL}\n`;
    expect(errorsOf({ ...fixture(), pool: { name: POOL, bytes: binary }, sha256Sums: sumsFor(binary) })).toEqual([`${POOL}: UTF-8 değil.`]);
    const broken = Buffer.from(`${poolBytes.toString("utf8")}{"Firma ID": \n`);
    expect(errorsOf({ ...fixture(), pool: { name: POOL, bytes: broken }, sha256Sums: sumsFor(broken) })).toEqual([`${POOL} satır 9: JSON okunamadı.`]);
  });

  it("stops on a missing, renamed or extra column", () => {
    const rows = fixtureRows.map(({ Notlar, ...rest }) => ({ ...rest, Notes: Notlar }));
    expect(errorsOf(pkg(rows))).toEqual(['Havuzda "Notlar" sütunu yok (8 satır).', 'Havuzda bilinmeyen sütun "Notes" (8 satır).']);
  });

  it("stops on a firm ID twice or in the wrong form", () => {
    expect(errorsOf(pkg([...fixtureRows, fixtureRows[1]!]))).toEqual([`${GENSET}: "Firma ID" iki kez var.`]);
    const errors = errorsOf(pkg(withFirm(GENSET, { "Firma ID": "BZ-09082a7038e3" })));
    expect(errors[0]).toBe('Havuz satır 2: "Firma ID" biçimi geçersiz.');
  });

  it("stops on a sources header that is not the package's", () => {
    const sources = editedSources((rows) => {
      rows[0] = [...SOURCE_COLUMNS.slice(0, -1), "Tarih"];
    });
    expect(errorsOf(pkg(fixtureRows, sources))).toEqual([`${SOURCES}: başlık satırı beklenen değil (beklenen: ${SOURCE_COLUMNS.join(", ")}).`]);
  });
});

describe("the row checks", () => {
  it("quote codes of closed lists, and only those", () => {
    const errors = errorsOf(
      pkg(
        withFirm(GENSET, {
          "Bozkor kategorileri": "METAL_HARDWARE;METAL_PARTS",
          "Ürün ailesi kodları": "F15;F18",
          "İhracat ülkeleri": "Almanya;Narnia",
          "İhale uygunluğu (Yüksek/Orta/Düşük)": "Yüksek",
          "AQAP (2110/2120/Yok/Bilinmiyor)": null,
          "Kontrol tarihi": "02.11.2026",
        }),
      ),
    );
    expect(errors).toEqual([
      `${GENSET}: "AQAP (2110/2120/Yok/Bilinmiyor)" boş olamaz.`,
      `${GENSET}: "İhale uygunluğu (Yüksek/Orta/Düşük)" izin verilmeyen değer ("Yüksek").`,
      `${GENSET}: "Kontrol tarihi" biçimi geçersiz ("02.11.2026").`,
    ]);
    const mapped = errorsOf(pkg(withFirm(GENSET, { "Bozkor kategorileri": "METAL_HARDWARE;METAL_PARTS", "Ürün ailesi kodları": "F15;F18", "İhracat ülkeleri": "Almanya;Narnia" })));
    expect(mapped).toEqual([
      `${GENSET}: "Bozkor kategorileri" bilinmeyen kod ("METAL_PARTS").`,
      `${GENSET}: "Ürün ailesi kodları" bilinmeyen kod ("F18").`,
      `${GENSET}: "İhracat ülkeleri" ülke tanınmadı ("Narnia").`,
    ]);
  });

  it("check identifiers and contacts without quoting them", () => {
    const errors = errorsOf(
      pkg(
        withFirm(GENSET, {
          VKN: "1234567891",
          "MERSİS no": "0111111111400001",
          "Genel e-posta": "satis@firma.com.tr;satis-firma.com.tr",
          "Genel telefon": "+90 212 123 45 67;telefon",
        }),
      ),
    );
    expect(errors).toEqual([
      `${GENSET}: "Genel e-posta" biçimi geçersiz.`,
      `${GENSET}: "Genel telefon" biçimi geçersiz.`,
      `${GENSET}: "VKN" sağlama hanesini tutmuyor.`,
      `${GENSET}: "MERSİS no" VKN'yi içermiyor.`,
    ]);
    expect(errorsOf(pkg(withFirm(GENSET, { VKN: "123456789" })))).toEqual([`${GENSET}: "VKN" biçimi geçersiz.`]);
    expect(firm(pkg(withFirm(GENSET, { VKN: "1234567890", "MERSİS no": "0123456789000017" })), GENSET)).toMatchObject({ vkn: "1234567890", mersis: "0123456789000017" });
  });

  it("read empty text as null and split lists on ';'", () => {
    const m = firm(
      pkg(withFirm(GENSET, { "OSB / bölge": "", "Genel e-posta": "  ", "Fabrika adresi": "", Malzemeler: " Çelik ; Alüminyum;;Çelik ", "Termin (gün)": "21" })),
      GENSET,
    )!;
    expect(m).toMatchObject({ osbZones: [], emails: [], address: null, materials: ["Çelik", "Alüminyum"], leadTimeDays: 21 });
    expect(splitList(" a ; b;;a ")).toEqual(["a", "b"]);
    expect(splitList(null)).toEqual([]);
  });

  it("place a firm by its factory, its own statement or a directory", () => {
    const place = (fields: Record<string, unknown>) => {
      const m = firm(pkg(withFirm(GENSET, fields)), GENSET)!;
      return [m.province, m.district, m.provinceBasis];
    };
    const directory = "Firma beyanı. Kaynakta yayımlanan il/ilçe: Ankara / Yenimahalle. Diğer not.";
    expect(place({ "Fabrika il": "Kocaeli", "Fabrika ilçe": "Gebze", "Adres türü (Fabrika/Merkez ofis/Şube/Bilinmiyor)": "Fabrika" })).toEqual(["Kocaeli", "Gebze", "factory"]);
    expect(place({ "Fabrika il": "Kocaeli", "Fabrika ilçe": null, "Adres türü (Fabrika/Merkez ofis/Şube/Bilinmiyor)": "Merkez ofis", Notlar: directory })).toEqual(["Kocaeli", null, "company"]);
    expect(place({ "Fabrika il": null, "Fabrika ilçe": null, Notlar: directory })).toEqual(["Ankara", "Yenimahalle", "directory"]);
    expect(place({ "Fabrika il": null, "Fabrika ilçe": null, Notlar: "Kaynakta yayımlanan il/ilçe: Konya" })).toEqual(["Konya", null, "directory"]);
    expect(place({ "Fabrika il": null, "Fabrika ilçe": null, Notlar: "Adres yayımlanmamış." })).toEqual([null, null, "unknown"]);
  });

  it("map the closed lists to the schema's codes", () => {
    const m = firm(
      pkg(
        withFirm(GENSET, {
          "Adres türü (Fabrika/Merkez ofis/Şube/Bilinmiyor)": "Şube",
          "Tür (Üretici/Üretici ve ticaret)": "Üretici",
          "AQAP (2110/2120/Yok/Bilinmiyor)": "Yok",
          "AS9100 (Evet/Hayır/Bilinmiyor)": "Hayır",
          "Tesis Güvenlik Belgesi (Evet/Bilinmiyor)": "Evet",
          "İhracat (Evet/Hayır/Bilinmiyor)": "Bilinmiyor",
          "İhale uygunluğu (Yüksek/Orta/Düşük)": "Düşük",
          "İletişim durumu": "Bilgi istendi",
        }),
      ),
      GENSET,
    )!;
    expect(m).toMatchObject({ addressKind: "branch", kind: "producer", aqap: "none", as9100: "no", facilitySecurity: "yes", exports: "unknown", fitLevel: "low", contactState: "info_requested" });
    expect(errorsOf(pkg(withFirm(GENSET, { "İletişim durumu": "Arandı" })))).toEqual([`${GENSET}: "İletişim durumu" bilinmeyen durum ("Arandı").`]);
  });

  it("check the field sources against the pool", () => {
    const row = (firmId: string, field: string, verification = "firma beyanı", date = "2026-11-02") => [firmId, field, "değer", "https://ornek.com.tr", verification, "", "", date];
    const sources = editedSources((rows) => {
      rows.push(row("BZ-000000000000", "Notlar"));
      rows.push(row(GENSET, "Bilinmeyen alan"));
      rows.push(rows.find((r) => r[0] === GENSET)!);
      rows.push(row(ALPHA2_COUNTRIES, "Notlar", ""));
      rows.push(row(ALPHA2_COUNTRIES, "VKN", "firma beyanı", "2026-02-30"));
      rows.push(["a", "b"]);
    });
    const firstGensetField = parseCsv(sourcesText).find((r) => r[0] === GENSET)![1];
    expect(errorsOf(pkg(fixtureRows, sources))).toEqual([
      `${SOURCES} satır 239 (BZ-000000000000): firma havuzda yok.`,
      `${SOURCES} satır 240 (${GENSET}): "Alan" havuzun bir sütunu değil.`,
      `${SOURCES} satır 241 (${GENSET}): "${firstGensetField}" için ikinci kaynak satırı.`,
      `${SOURCES} satır 242 (${ALPHA2_COUNTRIES}): "Doğrulama türü" boş.`,
      `${SOURCES} satır 243 (${ALPHA2_COUNTRIES}): "Kontrol tarihi" biçimi geçersiz ("2026-02-30").`,
      `${SOURCES} satır 244: 2 alan var, 8 olmalı.`,
    ]);
  });
});

describe("the values", () => {
  it("read countries as the pool writes them", () => {
    expect(["Almanya", "DE", "de", "ABD", "Amerika Birleşik Devletleri", "Fildişi Sahili", "Çekya", "Germany", "UK"].map(countryCode)).toEqual([
      "DE",
      "DE",
      "DE",
      "US",
      "US",
      "CI",
      "CZ",
      "DE",
      "GB",
    ]);
    expect(countryCode("Narnia")).toBeNull();
    expect(countryCode("EU")).toBeNull();
  });

  it("fold Turkish letters", () => {
    expect(fold("ŞAHİN Çelik IĞDIR öğü")).toBe("sahin celik igdir ogu");
  });

  it("check the VKN and TCKN check digits", () => {
    expect(["1234567890", "5321234565", "1111111114"].map(isValidVkn)).toEqual([true, true, true]);
    expect(["1234567891", "123456789", "12345678901"].map(isValidVkn)).toEqual([false, false, false]);
    expect(isValidTckn("10000000146")).toBe(true);
    expect(["10000000147", "10000000156", "01000000146", "1000000014"].map(isValidTckn)).toEqual([false, false, false, false]);
  });

  it("parse certificate names, dates and notes", () => {
    expect(parseCertifications("ISO 9001:2015 (2027-04-16);CE - yüksek dayanımlı çelik cıvata grupları (bitiş tarihi bilinmiyor); NADCAP")).toEqual({
      certifications: [
        { name: "ISO 9001:2015", kind: "management", validUntil: "2027-04-16", note: null },
        { name: "CE - yüksek dayanımlı çelik cıvata grupları", kind: "product", validUntil: null, note: "bitiş tarihi bilinmiyor" },
        { name: "NADCAP", kind: "other", validUntil: null, note: null },
      ],
      problems: [],
    });
    expect(parseCertifications(null)).toEqual({ certifications: [], problems: [] });
    expect(parseCertifications("ISO 9001 (2027-02-30);CE (a);CE (b);(2027-01-01);TSE (2026-01-01, 2027-01-01)").problems).toEqual([
      '"ISO 9001" için tarih okunamadı',
      '"CE" iki kez yazılmış',
      "adı olmayan belge",
      '"TSE" için tarih okunamadı',
    ]);
  });

  it("tell management systems, product marks and defence standards apart", () => {
    const kinds = Object.fromEntries(
      ["ISO 9001", "ISO/IEC 27001:2022", "IATF 16949:2016", "AS9100 Rev D", "AS/EN 9100", "EN ISO 3834-2", "FSSC 22000", "CE EN 14399", "TSEK", "UKCA", "EN ISO 1090-2", "EN ISO 20471", "AQAP 2110", "NADCAP özel prosesler", "Uptime"].map((n) => [n, certificationKind(n)]),
    );
    expect(kinds).toEqual({
      "ISO 9001": "management",
      "ISO/IEC 27001:2022": "management",
      "IATF 16949:2016": "management",
      "AS9100 Rev D": "management",
      "AS/EN 9100": "management",
      "EN ISO 3834-2": "management",
      "FSSC 22000": "management",
      "CE EN 14399": "product",
      TSEK: "product",
      UKCA: "product",
      "EN ISO 1090-2": "product",
      "EN ISO 20471": "product",
      "AQAP 2110": "defense",
      "NADCAP özel prosesler": "other",
      Uptime: "other",
    });
  });

  it("see a company form in a legal name", () => {
    expect(["Aksa Jeneratör Sanayi A.Ş.", "ACAR VİDA AŞ", "Örnek San. ve Tic. Ltd. Şti.", "Örnek Anonim Şirketi", "Örnek Tarım Kooperatifi"].map(hasCompanyForm)).toEqual([true, true, true, true, true]);
    expect(["Örnek Makina", "Kaan Savunma", "Asil Metal"].map(hasCompanyForm)).toEqual([false, false, false]);
  });
});

describe("the KVKK guard", () => {
  /** The firm's findings and whether it was left out with everything it owns. */
  function guarded(input: PackageInput, id = GENSET) {
    const result = prepareImport(input);
    if (!result.ok) throw new Error(result.errors.join("\n"));
    const { plan } = result;
    const loaded = plan.manufacturers.some((m) => m.id === id);
    if (!loaded) {
      expect(plan.sources.some((s) => s.manufacturerId === id)).toBe(false);
      expect(plan.certifications.some((c) => c.manufacturerId === id)).toBe(false);
      expect(plan.manufacturers).toHaveLength(7);
    }
    return {
      loaded,
      rejected: plan.rejected.filter((f) => f.manufacturerId === id).map((f) => `${f.place}: ${f.rule}`),
      review: plan.review.filter((f) => f.manufacturerId === id).map((f) => `${f.place}: ${f.rule}`),
    };
  }

  /** The fixture with one source row of GENSET's given a new value. */
  const gensetSource = (field: string, column: "Güncel değer" | "Açıklama" | "Kaynak (URL)", value: string) =>
    pkg(
      fixtureRows,
      editedSources((rows) => {
        const row = rows.find((r) => r[0] === GENSET && r[1] === field);
        if (!row) throw new Error(`No ${field} source for ${GENSET}`);
        row[SOURCE_COLUMNS.indexOf(column)] = value;
      }),
    );

  it("leaves a firm with a free mailbox out, wherever it is", () => {
    expect(guarded(pkg(withFirm(GENSET, { "Genel e-posta": "satis@firma.com.tr;kisi@gmail.com" })))).toEqual({ loaded: false, rejected: ["Genel e-posta: free_mail"], review: [] });
    expect(guarded(pkg(withFirm(GENSET, { Notlar: "Yetkili adresi kisi@hotmail.com.tr idi." }))).rejected).toEqual(["Notlar: free_mail"]);
    expect(guarded(gensetSource("Genel e-posta", "Güncel değer", "kisi@yandex.com")).rejected).toEqual(["Alan kaynakları: Genel e-posta: free_mail"]);
    expect(guarded(pkg(withFirm(GENSET, { "Genel e-posta": "satis@gmailmakina.com.tr;info@outlookgrup.com" })))).toMatchObject({ loaded: true, rejected: [] });
    expect(["a@gmail.com", "a@live.com", "a@icloud.com", "a@yahoo.com.tr"].map(hasFreeMail)).toEqual([true, true, true, true]);
    expect(["a@firma.com.tr", "a@gmail-makina.com", "a@delive.com"].map(hasFreeMail)).toEqual([false, false, false]);
  });

  it("leaves a firm with a mobile number out, wherever it is", () => {
    expect(guarded(pkg(withFirm(GENSET, { "Genel telefon": "+902121234567;+905321234567" })))).toEqual({ loaded: false, rejected: ["Genel telefon: mobile_number"], review: [] });
    expect(guarded(pkg(withFirm(GENSET, { Notlar: "Satış sorumlusu: 0 (532) 123 45 67." }))).rejected).toEqual(["Notlar: mobile_number"]);
    expect(guarded(gensetSource("Genel telefon", "Güncel değer", "+905551112233")).rejected).toEqual(["Alan kaynakları: Genel telefon: mobile_number"]);
    // Lines, call centres, identifiers and dates are not mobile numbers.
    const kept = guarded(
      pkg(
        withFirm(GENSET, {
          "Genel telefon": "+902121234567;+904441234;+908501234567",
          VKN: "5321234565",
          "MERSİS no": "0532123456500018",
          Notlar: "MERSİS 0532123456500018; kayıt BZ-5163994605F2; 2026-11-02 ve 2027-01-15.",
        }),
      ),
    );
    expect(kept).toMatchObject({ loaded: true, rejected: [] });
  });

  it("finds mobile numbers in their usual writings only", () => {
    const mobiles = ["+90 532 123 45 67", "0532 123 45 67", "05321234567", "5321234567", "(0532) 123-45-67", "0090 532 1234567", "https://wa.me/905321234567", "Tel 0212 123 45 67 Cep 0532 765 43 21", "0212 123 45 67 0532 765 43 21"];
    expect(mobiles.filter((t) => !hasMobileNumber(t))).toEqual([]);
    const others = ["+90 212 123 45 67", "0850 123 45 67", "+90 444 12 34", "0178146299300001", "2026-11-02", "18-1100 kVA", "7990511245", "BZ-5163994605F2", "SKU5321234567", "5321234567X"];
    expect(others.filter(hasMobileNumber)).toEqual([]);
  });

  it("leaves a firm with a number that passes the TCKN check out", () => {
    expect(guarded(pkg(withFirm(GENSET, { Notlar: "Kimlik no 10000000146." }))).rejected).toEqual(["Notlar: tckn"]);
    expect(guarded(pkg(withFirm(GENSET, { Notlar: "Sipariş no 10000000147." })))).toMatchObject({ loaded: true, rejected: [] });
    expect(["10000000146", "no:10000000146."].map(hasTckn)).toEqual([true, true]);
    expect(["10000000147", "100000001460", "A10000000146"].map(hasTckn)).toEqual([false, false, false]);
  });

  it("leaves a firm with a person's profile link out, but not a company page", () => {
    expect(guarded(pkg(withFirm(GENSET, { "Kimlik kaynağı (URL)": "https://www.linkedin.com/in/kisi-adi-123/" }))).rejected).toEqual(["Kimlik kaynağı (URL): person_link"]);
    expect(guarded(gensetSource("Genel telefon", "Kaynak (URL)", "https://tr.linkedin.com/pub/kisi/1/2/3")).rejected).toEqual(["Alan kaynakları: Genel telefon: person_link"]);
    expect(guarded(pkg(withFirm(GENSET, { "Kimlik kaynağı (URL)": "https://www.linkedin.com/company/firma/" })))).toMatchObject({ loaded: true, rejected: [] });
    expect(hasPersonLink("linkedin.com/in/x")).toBe(true);
  });

  it("leaves a sole proprietor with a VKN or MERSİS out", () => {
    expect(guarded(pkg(withFirm(SOLE, { VKN: "1234567890", "MERSİS no": "0123456789000017" })), SOLE).rejected).toEqual(["VKN: sole_proprietor_id", "MERSİS no: sole_proprietor_id"]);
    expect(guarded(pkg(withFirm(GENSET, { VKN: "1234567890" })))).toMatchObject({ loaded: true, rejected: [] });
  });

  it("never writes a value it found into a finding or an error", () => {
    const values = ["kisi@gmail.com", "5321234567", "10000000146", "kisi-adi", "1234567891", "yanlis-adres", "ahmet.yilmaz"];
    const result = prepareImport(
      pkg(
        withFirm(GENSET, {
          "Genel e-posta": "kisi@gmail.com;yanlis-adres;ahmet.yilmaz@firma.com.tr",
          "Genel telefon": "+905321234567",
          Notlar: "TCKN 10000000146",
          "Kimlik kaynağı (URL)": "https://www.linkedin.com/in/kisi-adi",
          VKN: "1234567891",
        }),
      ),
    );
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    expect(values.filter((v) => text.includes(v))).toEqual([]);
    expect(result).toMatchObject({ rejected: expect.arrayContaining([expect.objectContaining({ manufacturerId: GENSET, rule: "free_mail" })]) });
  });

  it("lists a mailbox that is neither a role nor the firm's name for review, and loads the firm", () => {
    expect(guarded(pkg(withFirm(GENSET, { "Genel e-posta": "info@firma.com.tr;ahmet.yilmaz@firma.com.tr" })))).toEqual({ loaded: true, rejected: [], review: ["Genel e-posta: personal_mailbox"] });
    expect(guarded(gensetSource("Genel e-posta", "Açıklama", "Eski adres: ayse@firma.com.tr")).review).toEqual(["Alan kaynakları: Genel e-posta: personal_mailbox"]);
    const tokens = firmTokens("Alimar Makina Sanayi ve Ticaret A.Ş.", "https://www.alimar.com.tr");
    expect(tokens).toEqual(["alimar"]);
    expect(["info@x.com", "satis2@x.com", "dis.ticaret@x.com", "export-tr@x.com", "alimar@x.com", "alimarjenerator@x.com"].filter((a) => !isRoleOrFirmMailbox(a, tokens))).toEqual([]);
    expect(["ali@x.com", "ahmet.yilmaz@x.com", "a.kaya@x.com"].filter((a) => isRoleOrFirmMailbox(a, tokens))).toEqual([]);
    expect(emailsIn("Yaz: Info@Firma.com.tr.")).toEqual(["info@firma.com.tr"]);
  });

  it("lists an unknown or a sole proprietor and a name without a company form for review", () => {
    expect(guarded(pkg(withFirm(GENSET, { "Şahıs işletmesi (Evet/Hayır)": null, "Tüzel kişi unvanı": "Örnek Makina" }))).review).toEqual([
      "Şahıs işletmesi (Evet/Hayır): sole_proprietor_unknown",
      "Tüzel kişi unvanı: no_company_form",
    ]);
    expect(guarded(pkg(withFirm(GENSET, { "Şahıs işletmesi (Evet/Hayır)": "Hayır" }))).review).toEqual([]);
    // A sole proprietor has no company form by definition; its links are what to look at.
    const sole = guarded(pkg(fixtureRows), SOLE).review;
    expect(sole.filter((f) => !f.endsWith("sole_proprietor_link"))).toEqual([]);
    expect(sole.slice(0, 4)).toEqual(["Kimlik kaynağı (URL): sole_proprietor_link", "Web sitesi: sole_proprietor_link", "Üretim kanıtı bağlantısı: sole_proprietor_link", "İlk kayıt kaynakları: sole_proprietor_link"]);
  });
});

describe("the command's report", () => {
  it("prints a line per firm and rule, naming places, counting many source rows", () => {
    const lines = findingLines([
      ...planOf(fixture()).review,
      { manufacturerId: GENSET, place: "Genel e-posta", rule: "personal_mailbox" },
      { manufacturerId: GENSET, place: "Alan kaynakları: Genel e-posta", rule: "personal_mailbox" },
    ]);
    expect(lines).toEqual([
      `${SOLE}: şahıs işletmesinin bağlantısı: Kimlik kaynağı (URL), Web sitesi, Üretim kanıtı bağlantısı, İlk kayıt kaynakları, 31 alan kaynağı satırı`,
      `${PPE}: şahıs işletmesi olup olmadığı bilinmiyor: Şahıs işletmesi (Evet/Hayır)`,
      `${PPE}: unvanda şirket türü yok: Tüzel kişi unvanı`,
      `${GENSET}: rol ya da firma adı olmayan e-posta yerel kısmı: Genel e-posta, alan kaynakları (Genel e-posta)`,
    ]);
    expect(findingLines([])).toEqual([]);
  });
});
