import { describe, expect, it } from "vitest";
import { matchManufacturers, NO_FACTS_NOTE, NO_FAMILY_GATE_NOTE, NO_FAMILY_NOTE, TENDER_FAMILIES_NOTE, TENDER_FAMILY_NOTE } from "./match";
import type { LotForMatch, LotMatch, ManufacturerForMatch } from "./types";

// The matcher on small pools shaped like pool v2.3's rows, and lots shaped like real notices: the cases of
// the 2 November review and of the lead's probe of 45 tenders on 3 November first, then each rule with a
// case where it holds and one where it does not. CPV codes give the lot its families (families.ts):
// 31120000 F16, 18830000 F14, 35113400 F13 and F14, 34350000 F17, 44211100 F15, 44531000 F01, 44311000 F10.

function firm(id: string, fields: Partial<ManufacturerForMatch> = {}): ManufacturerForMatch {
  return {
    id,
    legalName: `Firma ${id}`,
    province: null,
    categories: [],
    families: [],
    products: [],
    materials: [],
    standards: [],
    sizeRange: null,
    productionMethod: null,
    certifications: [],
    aqap: "unknown",
    as9100: "unknown",
    exports: "unknown",
    fitLevel: "medium",
    hasEvidenceQuote: false,
    hasContact: true,
    contactState: "not_contacted",
    ...fields,
  };
}

function lot(fields: Partial<LotForMatch> = {}): LotForMatch {
  return {
    lotNumber: "",
    nature: "goods",
    objectType: "GOODS",
    category: null,
    productTr: null,
    productNature: null,
    cpv: [],
    cpvNamesTr: [],
    textTr: null,
    textOriginal: null,
    quantityText: null,
    certifications: [],
    ...fields,
  };
}

const run = (lots: LotForMatch[], manufacturers: ManufacturerForMatch[], hasFacts = true, tenderCpv: string[] = []) =>
  matchManufacturers({ tenderId: "t1", hasFacts, tenderCpv, lots }, { poolVersion: "2.3", manufacturers });
const one = (l: LotForMatch, manufacturers: ManufacturerForMatch[], hasFacts = true): LotMatch => run([l], manufacturers, hasFacts).lots[0]!;
const ids = (m: LotMatch) => [...m.top, ...m.others].map((c) => c.manufacturerId);
const candidate = (m: LotMatch, id: string) => [...m.top, ...m.others].find((c) => c.manufacturerId === id)!;
const rules = (m: LotMatch, id: string) => candidate(m, id).reasons.map((r) => r.rule);
const productReason = (m: LotMatch, id: string) => candidate(m, id).reasons[0]!.text;

const generator = (id: string, fields: Partial<ManufacturerForMatch> = {}) =>
  firm(id, { categories: ["COMPLEX_GENERATORS"], families: ["F16"], products: ["Dizel jeneratör setleri"], ...fields });
const generatorLot = (fields: Partial<LotForMatch> = {}) => lot({ productTr: "dizel jeneratör", cpv: ["31121000"], ...fields });
const bolts = (id: string, fields: Partial<ManufacturerForMatch> = {}) => firm(id, { families: ["F01"], products: ["Cıvatalar"], ...fields });
const boltLot = (fields: Partial<LotForMatch> = {}) => lot({ productTr: "cıvata", cpv: ["44531000"], ...fields });

describe("the review's cases (2 November)", () => {
  it("711554-2026: names the generator makers for a portable 6 kW set the facts call basic equipment", () => {
    const pool = [
      generator("PORT", { products: ["Benzinli ve dizel portatif jeneratörler", "Dizel jeneratör setleri"], sizeRange: "Portatif benzinli/dizel: 3-16 kVA;Dizel setler: 10-2500 kVA" }),
      generator("BIG", { sizeRange: "Dizel setler: 18-1100 kVA" }),
      firm("PUMP", { categories: ["BASIC_EQUIPMENT"], families: ["F12"], products: ["Santrifüj pompalar"] }),
    ];
    const m = one(
      lot({ category: "BASIC_EQUIPMENT", productTr: "taşınabilir jeneratör", cpv: ["31120000"], cpvNamesTr: ["Jeneratörler"], textOriginal: "Nešiojamas 6 kW elektros generatorius" }),
      pool,
    );
    expect(m.status).toBe("matched");
    expect(m.families).toEqual(["F16"]);
    expect(ids(m)).toEqual(["PORT", "BIG"]);
    expect(rules(m, "PORT")).toEqual(["product", "family", "size"]);
    expect(productReason(m, "PORT")).toBe('Ürün: "taşınabilir jeneratör" (havuzda: dizel portatif jeneratörler)');
    expect(candidate(m, "BIG").missing).toEqual(["Güç 7,5 kVA havuzdaki aralığın dışında (18-1.100 kVA)"]);
    expect(m.notes).toContain("Güç kW'tan kVA'ya 0,8 güç katsayısıyla çevrildi (varsayım).");
  });

  it("599159-2026: says the pool has no maker of street luminaires, lighting towers and cables notwithstanding", () => {
    const pool = [
      generator("TOWER", { products: ["Dizel jeneratör setleri", "Aydınlatma kuleleri"] }),
      firm("CABLE", { categories: ["ELECTRICAL_LIGHTING"], families: ["F05"], products: ["Elektrik kabloları ve halojensiz kablolar"] }),
    ];
    const m = one(
      lot({ category: "ELECTRICAL_LIGHTING", productTr: "sokak aydınlatma armatürü", cpv: ["34928500", "34928530"], cpvNamesTr: ["Sokak aydınlatma ekipmanı", "Sokak lambaları"] }),
      pool,
    );
    expect(m.status).toBe("no_pool_match");
    expect(m.top).toEqual([]);
    expect(m.notes).toContain("Aranan: sokak aydınlatma armatürü");
    expect(m.notes).toContain(NO_FAMILY_GATE_NOTE);
  });

  it("puts the safety boot maker first for a PPE boot, comparing only the product's verified certificate", () => {
    const pool = [
      firm("BOOT", { categories: ["BASIC_EQUIPMENT"], families: ["F14"], products: ["Emniyet ayakkabıları", "Teknik iş güvenliği botları"], standards: ["EN ISO 20345", "S1P"] }),
      firm("WEAR", { categories: ["TEXTILES_WORKWEAR"], families: ["F13"], products: ["İş elbiseleri", "Koruyucu tulumlar"] }),
      firm("GLOVE", { categories: ["BASIC_EQUIPMENT"], families: ["F14"], products: ["Deri iş eldivenleri"] }),
    ];
    const m = one(
      lot({
        category: "TEXTILES_WORKWEAR",
        productTr: "iş güvenliği botu",
        cpv: ["18830000"],
        cpvNamesTr: ["Koruyucu ayakkabılar"],
        certifications: [
          { name: "EN ISO 20345:2011", level: "PRODUCT", verified: true },
          { name: "ISO 9001", level: "BIDDER", verified: true },
        ],
      }),
      pool,
    );
    expect(ids(m)).toEqual(["BOOT"]);
    expect(productReason(m, "BOOT")).toBe('Ürün: "iş güvenliği botu" (havuzda: Teknik iş güvenliği botları)');
    expect(candidate(m, "BOOT").reasons).toContainEqual({ rule: "certification", text: "Belge: EN ISO 20345:2011 (havuzda var)" });
    expect(m.notes).toContain("İstekliden istenen belgeler üreticiyle karşılaştırılmadı (üretici niteliği istekliye aktarılmaz): ISO 9001.");
  });
});

describe("the probe of 45 tenders (3 November)", () => {
  // Firms whose products share a word with these lots, but not the product.
  const pool = [
    firm("AIRFRAME", { families: ["F03", "F04"], products: ["Hava aracı gövde montajları"] }),
    firm("STATION", { families: ["F13"], products: ["İstasyon üniformaları", "Elektrik arkına karşı koruyucu giysiler"] }),
    firm("AMPOULE", { families: ["F08"], products: ["Cam ampul ve flakon ambalajlar"] }),
    firm("DATACENTRE", { families: ["F16"], products: ["Veri merkezi jeneratör setleri"] }),
    firm("SCREW", { families: ["F01"], products: ["Metrik vidalar ve altı köşe başlı cıvatalar"] }),
    firm("FILM", { families: ["F08"], products: ["Nefes alan ve almayan PE filmler"] }),
    firm("TOOLS", { families: ["F02", "F08"], products: ["plastik el aletleri"] }),
    firm("HVAC", { families: ["F12"], products: ["Havalandırma ve iklimlendirme cihazları", "ısı geri kazanım cihazları"] }),
    firm("APRON", { families: ["F14"], products: ["İş önlükleri", "Deri iş eldivenleri"] }),
  ];
  const cases: [string, Partial<LotForMatch>][] = [
    ["breathing-air compressor", { productTr: "solunum havası kompresörü", cpv: ["35111100"], cpvNamesTr: ["Yangınla mücadele için solunum cihazları"] }],
    ["EV charging station", { productTr: "elektrikli araç şarj istasyonu", cpv: ["31200000"], textTr: "Şarj İstasyonları\nElektrikli araçlar için" }],
    ["luminaires and bulbs", { productTr: "aydınlatma armatürü ve ampuller", cpv: ["31520000"], cpvNamesTr: ["Lambalar ve aydınlatma armatürleri"] }],
    ["vacuum blood tubes", { productTr: "vakumlu kan alma tüpü", cpv: ["33192500"], cpvNamesTr: ["Test tüpleri"], textTr: "Bölüm 1\nKan Bağışı ve Kan Tedavisi Merkezi için" }],
    ["internal radiotherapy", { productTr: "iç radyasyon tedavi ürünü", cpv: ["33151400"], cpvNamesTr: ["Radyoterapi malzemeleri"], textTr: "İç Radyasyon Tedavileri\nalt kategoriler" }],
    ["used refuse truck", { productTr: "kullanılmış çöp toplama aracı", cpv: ["34000000"], textTr: "Kullanılmış atık toplama araçları\nalanı" }],
    ["playground equipment", { productTr: "çocuk oyun alanı ekipmanı", cpv: ["37410000"], cpvNamesTr: ["Açık hava spor ekipmanı"] }],
    ["motorcycle (untranslated facts)", { productTr: "moottoripyörä ve varaosa", cpv: ["34410000"], cpvNamesTr: ["Motosikletler"], textTr: "Motosiklet\nel ile" }],
    ["ECG device", { productTr: "ekg cihazı", cpv: ["33100000"] }],
    ["diagnostic imaging", { productTr: "tanısal görüntüleme cihazı", cpv: ["33111000"], cpvNamesTr: ["BT tarayıcıları"] }],
    ["surgical gown", { productTr: "steril örtü ve cerrahi önlük", cpv: ["33141620"], cpvNamesTr: ["Tıbbi kitler"] }],
  ];

  it.each(cases)("names no maker for %s, though a word is shared", (_label, fields) => {
    const m = one(lot(fields), pool);
    expect(m.status).toBe("no_pool_match");
    expect(m.top).toEqual([]);
  });

  it("rechapé and new truck tyres: the tyre makers, not a gear maker that shares only 'kamyon'", () => {
    const m = one(lot({ objectType: "MIXED", category: "OTHER_GOODS", productTr: "rechapé ve yeni kamyon lastiği", cpv: ["34350000"] }), [
      firm("GEAR", { legalName: "A Dişli", families: ["F03", "F17"], products: ["Kamyon şanzıman dişlileri", "Traktör dişlileri"] }),
      firm("TRUCKTYRE", { legalName: "B Lastik", families: ["F17"], products: ["Binek araç lastikleri", "Kamyon lastikleri"], fitLevel: "low" }),
      firm("TRACTORTYRE", { legalName: "C Lastik", families: ["F17"], products: ["Traktör lastikleri", "İş makinesi lastikleri"], fitLevel: "low" }),
    ]);
    expect(ids(m)).toEqual(["TRUCKTYRE", "TRACTORTYRE"]);
    expect(productReason(m, "TRUCKTYRE")).toBe('Ürün: "yeni kamyon lastiği" (havuzda: Kamyon lastikleri)');
  });

  it("softshell jacket: the softshell maker first, then the same head, then a rare describing word alone", () => {
    const m = one(lot({ category: "TEXTILES_WORKWEAR", productTr: "yüksek görünürlüklü softshell mont", cpv: ["35113400"] }), [
      firm("HIVIS", { legalName: "A Tekstil", families: ["F13"], products: ["Yüksek görünürlüklü kıyafetler"] }),
      firm("COATS", { legalName: "B Tekstil", families: ["F13"], products: ["İş montları"] }),
      firm("SOFTSHELL", { legalName: "C Tekstil", families: ["F13"], products: ["Polar iş giysileri", "Softshell iş ceketleri"] }),
    ]);
    expect(ids(m)).toEqual(["SOFTSHELL", "COATS", "HIVIS"]);
    expect(productReason(m, "SOFTSHELL")).toBe('Ürün (eşanlam): "yüksek görünürlüklü softshell mont" (havuzda: Softshell iş ceketleri)');
    expect(productReason(m, "HIVIS")).toBe('Ürün (yalnız "görünürlüklü"): "yüksek görünürlüklü softshell mont" (havuzda: Yüksek görünürlüklü kıyafetler)');
  });

  it("standby generator: the generator maker, not the maker of generator parts", () => {
    const m = one(lot({ category: "COMPLEX_GENERATORS", productTr: "bekleme jeneratörü", cpv: ["31120000", "31122000"] }), [
      generator("GEN"),
      generator("PARTS", { products: ["Jeneratör metal aksamları", "Jeneratör kabinleri"] }),
    ]);
    expect(ids(m)).toEqual(["GEN"]);
  });

  it("switchgear container: the prefab maker, not a generator maker with cabins", () => {
    const m = one(lot({ objectType: "MIXED", category: "LARGE_PREFAB_STRUCTURES", productTr: "şalt konteyneri", cpv: ["44211100"] }), [
      generator("CANOPY", { products: ["Dizel jeneratör setleri", "Ses izolasyon kabinleri"] }),
      firm("PREFAB", { families: ["F15"], products: ["Yaşam konteynerleri", "Prefabrik binalar"] }),
    ]);
    expect(ids(m)).toEqual(["PREFAB"]);
  });

  it("firefighting suit: the firefighter clothing maker, not a uniform maker", () => {
    const m = one(lot({ category: "TEXTILES_WORKWEAR", productTr: "itfaiye müdahale elbisesi", cpv: ["35113400"] }), [
      firm("UNIFORM", { legalName: "A Giyim", families: ["F13"], products: ["Kurumsal üniformalar"] }),
      firm("FIRE", { legalName: "B Giyim", families: ["F13"], products: ["İtfaiyeci elbiseleri", "Alüminize koruyucu elbiseler"] }),
    ]);
    expect(ids(m)).toEqual(["FIRE"]);
    expect(productReason(m, "FIRE")).toBe('Ürün: "itfaiye müdahale elbisesi" (havuzda: İtfaiyeci elbiseleri)');
  });
});

describe("the head noun decides", () => {
  it("matches the same head and a synonym of it", () => {
    const m = one(lot({ productTr: "iş güvenliği ayakkabısı", cpv: ["18830000"] }), [
      firm("SHOES", { legalName: "A", families: ["F14"], products: ["Emniyet ayakkabıları"] }),
      firm("BOOTS", { legalName: "B", families: ["F14"], products: ["İş güvenliği botları"] }),
    ]);
    expect(ids(m)).toEqual(["SHOES", "BOOTS"]);
    expect(productReason(m, "BOOTS")).toMatch(/^Ürün \(eşanlam\): /);
  });

  it("does not take a shared word for the head: two different products do not meet on it, even inside the family", () => {
    const pool = [firm("AIR", { families: ["F12"], products: ["Hava perdeleri"] })];
    expect(one(lot({ productTr: "hava kompresörü" }), pool).status).toBe("no_pool_match");
    expect(one(lot({ productTr: "hava kompresörü", cpv: ["42520000"] }), pool).status).toBe("no_pool_match");
  });

  it("does not let a rare describing word join two different products: police shoes are not police uniforms", () => {
    const pool = [
      firm("UNIFORM", { legalName: "A Giyim", families: ["F13", "F14"], products: ["Polis üniformaları"] }),
      firm("SHOES", { legalName: "B Ayakkabı", families: ["F14"], products: ["Askeri botlar"] }),
    ];
    const m = one(lot({ productTr: "polis ayakkabısı", cpv: ["18830000"] }), pool);
    expect(ids(m)).toEqual(["SHOES"]);
    expect(productReason(m, "SHOES")).toBe('Ürün (eşanlam): "polis ayakkabısı" (havuzda: Askeri botlar)');
  });

  it("shows the firm's item closest to the lot's when two meet equally, else its first", () => {
    const m = one(lot({ productTr: "iş makinesi lastiği", cpv: ["34350000"] }), [firm("TYRE", { families: ["F17"], products: ["Traktör lastikleri", "İş makinesi lastikleri"] })]);
    expect(productReason(m, "TYRE")).toBe('Ürün: "iş makinesi lastiği" (havuzda: İş makinesi lastikleri)');
    const car = one(lot({ productTr: "otomobil lastiği", cpv: ["34350000"] }), [firm("TYRE", { families: ["F17"], products: ["Binek araç lastikleri", "Kamyon lastikleri"] })]);
    expect(productReason(car, "TYRE")).toBe('Ürün: "otomobil lastiği" (havuzda: Binek araç lastikleri)');
  });

  it("needs a rare word beside a generic head", () => {
    const pool = [firm("HVAC", { families: ["F12"], products: ["Havalandırma cihazları"] }), firm("THERMAL", { families: ["F12"], products: ["Termal görüntüleme cihazları"] })];
    const m = one(lot({ productTr: "görüntüleme cihazı", cpv: ["42520000"] }), pool);
    expect(ids(m)).toEqual(["THERMAL"]);
    expect(one(lot({ productTr: "elektrikli cihaz", cpv: ["42520000"] }), pool).status).toBe("no_pool_match");
    // 07ad41d8 LOT-0002: "yedek parça" names no product; vehicle parts makers are not candidates for it.
    const parts = [firm("PARTS", { families: ["F17"], products: ["Araç mekanik yedek parçaları"] })];
    expect(one(lot({ productTr: "araç ve bisiklet aksesuarı ile yedek parça", cpv: ["34913000"] }), parts).status).toBe("no_pool_match");
  });

  it("meets every clothing maker of the family for clothing in general, below a product, and asks more for a kind of clothing", () => {
    const pool = [
      firm("COOK", { legalName: "A Tekstil", families: ["F13"], products: ["Aşçı kıyafetleri", "İş kıyafetleri"] }),
      firm("HIVIS", { legalName: "B Tekstil", families: ["F13"], products: ["Yüksek görünürlüklü giysiler"] }),
      firm("COATS", { legalName: "C Tekstil", families: ["F13"], products: ["İş montları"] }),
      firm("MOTO", { legalName: "D Tekstil", families: ["F13"], products: ["Motosiklet montları"] }),
    ];
    const workwear = one(lot({ category: "TEXTILES_WORKWEAR", productTr: "iş kıyafeti", cpv: ["35113400"] }), pool);
    expect(ids(workwear)).toEqual(["COOK", "HIVIS"]);
    // Of two items meeting alike, the plain one is shown.
    expect(productReason(workwear, "COOK")).toBe('Ürün (genel): "iş kıyafeti" (havuzda: İş kıyafetleri)');
    expect(one(lot({ category: "TEXTILES_WORKWEAR", productTr: "iş kıyafeti" }), pool).status).toBe("no_pool_match");
    const moto = one(lot({ category: "TEXTILES_WORKWEAR", productTr: "motosiklet kıyafeti", cpv: ["35113400"] }), pool);
    expect(ids(moto)).toEqual(["MOTO"]);
    expect(productReason(moto, "MOTO")).toBe('Ürün (yalnız "motosiklet"): "motosiklet kıyafeti" (havuzda: Motosiklet montları)');
    expect(one(lot({ category: "TEXTILES_WORKWEAR", productTr: "bisiklet kıyafeti", cpv: ["35113400"] }), pool).status).toBe("no_pool_match");
    // A product named outright comes first.
    expect(ids(one(lot({ category: "TEXTILES_WORKWEAR", productTr: "iş kıyafeti ve mont", cpv: ["35113400"] }), pool)).slice(0, 2)).toEqual(["COATS", "MOTO"]);
  });
});

describe("the family gate", () => {
  it("names only firms of the lot's family, whatever their products", () => {
    const m = one(generatorLot(), [generator("IN"), firm("OUT", { families: ["F17"], products: ["Dizel jeneratörler"] })]);
    expect(ids(m)).toEqual(["IN"]);
  });

  it("lets a rare describing word alone carry a match inside the family beside a generic head, not a common one", () => {
    const systems = firm("SYSTEMS", { families: ["F06"], products: ["Hidrolik sistemler"] });
    const cylinder = lot({ productTr: "hidrolik silindir", cpv: ["42130000"] });
    const rare = one(cylinder, [systems, firm("PUMP", { families: ["F06"], products: ["Hidrolik pompalar"] })]);
    expect(ids(rare)).toEqual(["SYSTEMS"]);
    expect(productReason(rare, "SYSTEMS")).toBe('Ürün (yalnız "hidrolik"): "hidrolik silindir" (havuzda: Hidrolik sistemler)');
    // Thirteen firms with "hidrolik": one more than a rare word may have.
    const common = Array.from({ length: 12 }, (_, i) => firm(`H${i}`, { families: ["F06"], products: ["Hidrolik hortumlar"] }));
    expect(one(cylinder, [...common, systems]).status).toBe("no_pool_match");
  });

  it("asks a lot without a family for the head and a rare word together", () => {
    const pool = [firm("CAFE", { families: ["F11"], products: ["Kafe sandalyeleri"] })];
    expect(ids(one(lot({ productTr: "kafe sandalyesi" }), pool))).toEqual(["CAFE"]);
    expect(one(lot({ productTr: "sandalye" }), pool).status).toBe("no_pool_match");
    expect(one(lot({ productTr: "kafe masası" }), pool).status).toBe("no_pool_match");
  });

  it("counts a material's head only inside the family, and below a product's", () => {
    const pool = [
      firm("MATERIAL", { legalName: "A Halat", families: ["F10"], products: ["Asansör sistemleri"], materials: ["Çelik halat"] }),
      firm("PRODUCT", { legalName: "B Halat", families: ["F10"], products: ["Çelik halatlar"] }),
    ];
    const m = one(lot({ productTr: "çelik halat", cpv: ["44311000"] }), pool);
    expect(ids(m)).toEqual(["PRODUCT", "MATERIAL"]);
    expect(productReason(m, "MATERIAL")).toBe('Ürün (malzemede): "çelik halat" (havuzda: Çelik halat)');
    expect(ids(one(lot({ productTr: "çelik halat" }), pool))).toEqual([]);
  });
});

describe("the family from the tender's codes", () => {
  const pool = [
    firm("CABLE", { categories: ["ELECTRICAL_LIGHTING"], families: ["F05"], products: ["Elektrik kabloları ve halojensiz kablolar"] }),
    firm("PANEL", { categories: ["ELECTRICAL_LIGHTING"], families: ["F05"], products: ["Elektrik panoları"] }),
    firm("AMPOULE", { families: ["F08"], products: ["Cam ampul ve flakon ambalajlar"] }),
  ];
  // 4eb11c6f (Elektromaterial): the lots' codes are too broad or left out of the bridge; the tender's main code is 31300000 (F05).
  const cables = lot({ lotNumber: "LOT-0001", category: "ELECTRICAL_LIGHTING", productTr: "elektrik malzemesi, kablo ve piller", cpv: ["31000000"] });
  const lights = lot({ lotNumber: "LOT-0002", category: "ELECTRICAL_LIGHTING", productTr: "aydınlatma armatürü ve ampuller", cpv: ["31520000"] });

  it("takes the family from the tender when the lot's own codes name none, and says so", () => {
    const [first, second] = run([cables, lights], pool, true, ["31300000"]).lots;
    expect(first).toMatchObject({ status: "matched", families: ["F05"] });
    expect(ids(first!)).toEqual(["CABLE"]);
    expect(first!.notes).toContain(TENDER_FAMILY_NOTE);
    expect(second).toMatchObject({ status: "no_pool_match", families: ["F05"] });
    expect(second!.notes).toContain(TENDER_FAMILY_NOTE);
  });

  it("leaves the lot without a family when the tender's codes name several, and says so", () => {
    // 082472d9: rescue boats beside protective clothing; the tender's codes do not say which a lot is.
    const m = run([cables], pool, true, ["31300000", "44211000"]).lots[0]!;
    expect(m).toMatchObject({ status: "no_pool_match", families: [] });
    expect(m.notes).toContain(TENDER_FAMILIES_NOTE);
    expect(m.notes).not.toContain(TENDER_FAMILY_NOTE);
  });

  it("keeps the lot's own family when it has one, and asks for more without any", () => {
    const own = run([generatorLot()], [generator("GEN")], true, ["31300000"]).lots[0]!;
    expect(own.families).toEqual(["F16"]);
    expect(own.notes).not.toContain(TENDER_FAMILY_NOTE);
    const none = run([cables], pool).lots[0]!;
    expect(none).toMatchObject({ status: "no_pool_match", families: [] });
    expect(none.notes).toContain(NO_FAMILY_GATE_NOTE);
  });
});

describe("specialised categories", () => {
  const controls = firm("CONTROLS", { categories: ["ELECTRICAL_LIGHTING"], families: ["F05"], products: ["Kontrol kabloları", "Kontrol sistemleri"] });
  const apron = firm("APRON", { categories: ["BASIC_EQUIPMENT"], families: ["F14"], products: ["İş önlükleri"] });

  it("71d66e LOT-0002: names no maker for a lighting desk the facts call complex electronics, the pool having none", () => {
    const desk = lot({ category: "COMPLEX_ELECTRONICS", productTr: "ışık kontrol masası", cpv: ["31200000"] });
    expect(one(desk, [controls])).toMatchObject({ status: "no_pool_match", top: [], notes: ["Uzmanlık kategorisi (Karmaşık elektronik): havuzda bu kategoride üretici yok."] });
    // The same lot under an ordinary category would take the control systems maker on "kontrol" alone.
    expect(ids(one({ ...desk, category: "ELECTRICAL_LIGHTING" }, [controls]))).toEqual(["CONTROLS"]);
  });

  it("06fa96 LOT-0002: names no work-apron maker for a surgical gown", () => {
    const gown = lot({ category: "MEDICAL_SPECIALISED", productTr: "steril örtü ve cerrahi önlük", cpv: ["33141620"] });
    const m = run([gown], [apron], true, ["18143000"]).lots[0]!;
    expect(m).toMatchObject({ status: "no_pool_match", notes: ["Uzmanlık kategorisi (Uzmanlık gerektiren tıbbi ürünler): havuzda bu kategoride üretici yok."] });
  });

  it("names only firms of that category when the pool has some", () => {
    const medical = firm("MEDICAL", { categories: ["MEDICAL_SPECIALISED"], families: ["F14"], products: ["Cerrahi önlükler"] });
    expect(ids(one(lot({ category: "MEDICAL_SPECIALISED", productTr: "cerrahi önlük", cpv: ["18143000"] }), [apron, medical]))).toEqual(["MEDICAL"]);
  });

  it("does not hold a lot without facts to a category", () => {
    const m = one(lot({ category: "MEDICAL_SPECIALISED", cpv: ["18143000"], textTr: "Cerrahi önlükler" }), [apron], false);
    expect(ids(m)).toEqual(["APRON"]);
  });

  it("leaves ordinary categories alone: decontamination tents for a decontamination lot", () => {
    const tents = firm("TENTS", { categories: ["LARGE_PREFAB_STRUCTURES"], families: ["F15"], products: ["Şişme afet çadırları", "Dekontaminasyon çadırları"] });
    const m = one(lot({ category: "OTHER_GOODS", productTr: "sanitasyon ve dekontaminasyon altyapısı", cpv: ["44211000"] }), [tents]);
    expect(ids(m)).toEqual(["TENTS"]);
  });
});

describe("where the lot's product is read", () => {
  const pool = [firm("BOOT", { families: ["F14"], products: ["İş güvenliği botları"] }), firm("GLOVE", { families: ["F14"], products: ["Deri iş eldivenleri"] })];

  it("reads only the facts' product name when there is one, even when it finds nothing", () => {
    expect(ids(one(lot({ productTr: "iş güvenliği botu", cpv: ["18830000"], textTr: "KKD alımı\nBotlar ve deri eldivenler" }), pool))).toEqual(["BOOT"]);
    const m = one(lot({ productTr: "kişisel koruyucu donanım", cpv: ["18830000"], textTr: "KKD alımı\nİş güvenliği botları ve deri eldivenler" }), pool);
    expect(m.status).toBe("no_pool_match");
  });

  it("without the facts' product name reads the translation, then the CPV names, then the notice, inside the family", () => {
    const byTranslation = one(lot({ cpv: ["18830000"], textTr: "KKD alımı\nİş güvenliği botları ve deri eldivenler" }), pool, false);
    expect(ids(byTranslation).sort()).toEqual(["BOOT", "GLOVE"]);
    expect(productReason(byTranslation, "GLOVE")).toBe('Ürün (çeviri): "deri eldivenler" (havuzda: Deri iş eldivenleri)');
    const byCpv = one(lot({ cpv: ["18830000"], cpvNamesTr: ["Koruyucu ayakkabılar"], certifications: [{ name: "CE", level: "PRODUCT", verified: true }] }), pool, false);
    expect(ids(byCpv)).toEqual(["BOOT"]);
    expect(productReason(byCpv, "BOOT")).toBe('Ürün (CPV adı, eşanlam): "Koruyucu ayakkabılar" (havuzda: İş güvenliği botları)');
    expect(byCpv.notes[0]).toBe(NO_FACTS_NOTE);
    expect(candidate(byCpv, "BOOT").missing).toEqual([]);
    const byNotice = one(lot({ cpv: ["31120000"], textOriginal: "Generator\nPortable generator 5 kVA" }), [generator("GEN", { products: ["Portatif jeneratörler"] })], false);
    expect(ids(byNotice)).toEqual(["GEN"]);
  });

  it("matches no longer text for a lot with neither the facts' product name nor a family", () => {
    // The translation would meet the firm, rare word and all; without a family it is not read.
    const m = one(lot({ cpv: ["33100000"], textTr: "Burunlu iş güvenliği botları" }), [firm("TOECAP", { families: ["F14"], products: ["Burunlu iş güvenliği botları"] })], false);
    expect(m.status).toBe("no_pool_match");
    expect(m.notes).toContain(NO_FAMILY_NOTE);
  });
});

describe("goods only", () => {
  const pool = [generator("GEN")];

  it("leaves out services and works, by the notice or by the facts", () => {
    expect(one(generatorLot({ nature: "services" }), pool)).toMatchObject({ status: "not_goods", notes: ["Hizmet alımı: üretici eşleştirmesi yapılmaz."], top: [] });
    expect(one(generatorLot({ objectType: "WORKS" }), pool)).toMatchObject({ status: "not_goods", notes: ["Yapım işi: üretici eşleştirmesi yapılmaz."] });
  });

  it("matches mixed and unknown lots, saying so", () => {
    const mixed = one(generatorLot({ objectType: "MIXED" }), pool);
    expect(mixed.status).toBe("matched");
    expect(mixed.notes).toContain("Karışık lot: mal ve bağlı hizmet; mal kısmı eşleştirildi.");
    const unknown = one(generatorLot({ objectType: "UNKNOWN" }), pool);
    expect(unknown.status).toBe("matched");
    expect(unknown.notes).toContain("Alım türü olgulardan anlaşılmadı; mal sayıldı.");
  });
});

describe("order", () => {
  it("puts the stronger match before the researcher's 'Düşük' note, and 'Düşük' last within the same strength", () => {
    const m = one(lot({ productTr: "dizel portatif jeneratör", cpv: ["31120000"] }), [
      generator("LOWPORT", { legalName: "A Jeneratör", products: ["Portatif jeneratörler"], fitLevel: "low" }),
      generator("LOW", { legalName: "B Jeneratör", fitLevel: "low" }),
      generator("PLAIN", { legalName: "C Jeneratör" }),
    ]);
    expect(ids(m)).toEqual(["LOWPORT", "PLAIN", "LOW"]);
    expect(candidate(m, "LOW").warnings).toEqual(["Araştırmacı notu: Düşük uygunluk"]);
  });

  it("puts the team's 'Uygun değil' last of all, with a warning", () => {
    const m = one(lot({ productTr: "dizel portatif jeneratör", cpv: ["31120000"] }), [
      generator("UNSUITABLE", { legalName: "A Jeneratör", products: ["Portatif jeneratörler"], contactState: "unsuitable" }),
      generator("PLAIN", { legalName: "B Jeneratör" }),
    ]);
    expect(ids(m)).toEqual(["PLAIN", "UNSUITABLE"]);
    expect(candidate(m, "UNSUITABLE").warnings).toEqual(["İletişim durumu: Uygun değil"]);
  });

  it("weighs the lot's words among a firm's products above the same words among its materials", () => {
    const m = one(generatorLot(), [
      generator("MATERIALS", { legalName: "A Jeneratör", products: ["Jeneratörler"], materials: ["Dizel"] }),
      generator("PRODUCTS", { legalName: "B Jeneratör", products: ["Dizel jeneratörler"] }),
    ]);
    expect(ids(m)).toEqual(["PRODUCTS", "MATERIALS"]);
  });

  it("then by the product score: more of the lot's words among the products", () => {
    const m = one(generatorLot({ productTr: "dizel marin jeneratör" }), [
      generator("PLAIN", { legalName: "A Jeneratör", products: ["Jeneratörler"] }),
      generator("MARINE", { legalName: "B Jeneratör", products: ["Jeneratörler", "Marin dizel motorları"] }),
    ]);
    expect(ids(m)).toEqual(["MARINE", "PLAIN"]);
  });

  it("puts a fitting size before an unknown one, and an unknown one before one that does not fit", () => {
    const pool = [
      generator("OUT", { legalName: "A Jeneratör", sizeRange: "Dizel setler: 18-1100 kVA" }),
      generator("UNKNOWN", { legalName: "B Jeneratör" }),
      generator("IN", { legalName: "C Jeneratör", sizeRange: "Dizel setler: 10-4125 kVA" }),
    ];
    const m = one(generatorLot({ textOriginal: "Hinattavat sähkövoimakoneet 12,5 kVa" }), pool);
    expect(ids(m)).toEqual(["IN", "UNKNOWN", "OUT"]);
    expect(candidate(m, "IN").reasons).toContainEqual({ rule: "size", text: "Güç: 12,5 kVA, havuzdaki aralık 10-4.125 kVA" });
    expect(candidate(m, "OUT").missing).toEqual(["Güç 12,5 kVA havuzdaki aralığın dışında (18-1.100 kVA)"]);
    expect(rules(m, "UNKNOWN")).not.toContain("size");
  });

  it("reads thread sizes too", () => {
    const m = one(boltLot({ textOriginal: "Hexagon bolts M12x50" }), [bolts("FITS", { legalName: "A Cıvata", sizeRange: "Cıvata M6-M30" }), bolts("SMALL", { legalName: "B Cıvata", sizeRange: "M2-M8" })]);
    expect(candidate(m, "FITS").reasons).toContainEqual({ rule: "size", text: "Diş: M12, havuzdaki aralık M6-M30" });
    expect(candidate(m, "SMALL").missing).toEqual(["Diş M12 havuzdaki aralığın dışında (M2-M8)"]);
  });

  it("then by certificates held, category, evidence and contact", () => {
    const required = [{ name: "EN ISO 20471:2013", level: "PRODUCT" as const, verified: true }];
    const base = { families: ["F13" as const], products: ["Yüksek görünürlüklü yelekler"] };
    const pool = [
      firm("NOTHING", { ...base, legalName: "A", hasContact: false }),
      firm("CONTACT", { ...base, legalName: "B" }),
      firm("EVIDENCE", { ...base, legalName: "C", hasEvidenceQuote: true }),
      firm("CATEGORY", { ...base, legalName: "D", categories: ["TEXTILES_WORKWEAR"] }),
      firm("CERT", { ...base, legalName: "E", standards: ["ISO 20471"] }),
    ];
    const m = one(lot({ category: "TEXTILES_WORKWEAR", productTr: "yüksek görünürlüklü yelek", cpv: ["35113400"], certifications: required }), pool);
    expect(ids(m)).toEqual(["CERT", "CATEGORY", "EVIDENCE", "CONTACT", "NOTHING"]);
    expect(candidate(m, "CATEGORY").reasons).toContainEqual({ rule: "category", text: "Kategori: Tekstil ve iş kıyafeti" });
    expect(candidate(m, "EVIDENCE").reasons).toContainEqual({ rule: "evidence", text: "Üretim kanıtı alıntısı var" });
    expect(candidate(m, "NOTHING").warnings).toEqual(["Firma düzeyinde iletişim bilgisi yok"]);
    expect(candidate(m, "CONTACT").missing).toEqual(["EN ISO 20471:2013 havuzda yok (bilinmiyor)"]);
  });

  it("breaks ties by the legal name in Turkish, whatever order the pool comes in", () => {
    const pool = ["Çelik Cıvata", "Cıvata Dünyası", "Demir Cıvata"].map((name, i) => bolts(`F${i}`, { legalName: name }));
    const names = (p: ManufacturerForMatch[]) => [...one(boltLot(), p).top].map((c) => c.legalName);
    expect(names(pool)).toEqual(["Cıvata Dünyası", "Çelik Cıvata", "Demir Cıvata"]);
    expect(names([...pool].reverse())).toEqual(names(pool));
  });

  it("gives the best three and at most seven more, ranked from one", () => {
    const pool = Array.from({ length: 12 }, (_, i) => bolts(`F${String(i).padStart(2, "0")}`, { legalName: `Cıvata ${String(i).padStart(2, "0")}` }));
    const m = one(boltLot(), pool);
    expect(m.top.map((c) => c.rank)).toEqual([1, 2, 3]);
    expect(m.others.map((c) => c.rank)).toEqual([4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("certificates", () => {
  const boots = firm("BOOT", { families: ["F14"], products: ["Emniyet ayakkabıları"], standards: ["TS EN ISO 20345"], certifications: [{ name: "ISO 9001:2015", kind: "management", validUntil: null }] });
  const bootLot = (certifications: LotForMatch["certifications"]) => lot({ productTr: "emniyet ayakkabısı", cpv: ["18830000"], certifications });

  it("compares a verified product or maker requirement, whatever the spelling", () => {
    const m = one(bootLot([{ name: "EN ISO 20345:2011", level: "PRODUCT", verified: true }, { name: "ISO 9001", level: "MANUFACTURER", verified: true }]), [boots]);
    expect(candidate(m, "BOOT").reasons.filter((r) => r.rule === "certification").map((r) => r.text)).toEqual([
      "Belge: EN ISO 20345:2011 (havuzda var)",
      "Belge: ISO 9001 (havuzda var)",
    ]);
  });

  it("leaves out unverified and bidder requirements, and writes a missing one as unknown", () => {
    const m = one(
      bootLot([
        { name: "EN 388", level: "PRODUCT", verified: false },
        { name: "ISO 14001", level: "BIDDER", verified: true },
        { name: "CE", level: "PRODUCT", verified: true },
      ]),
      [boots],
    );
    const c = candidate(m, "BOOT");
    expect(c.reasons.map((r) => r.rule)).not.toContain("certification");
    expect(c.missing).toEqual(["CE havuzda yok (bilinmiyor)"]);
    expect(m.notes).toContain("Alıntısı doğrulanmayan belge şartı karşılaştırılmadı: EN 388.");
  });

  it("checks AQAP by the pool's own field, and says what the pool knows", () => {
    const m = one(generatorLot({ certifications: [{ name: "AQAP 2110", level: "MANUFACTURER", verified: true }] }), [
      generator("HAS", { legalName: "A", aqap: "2110" }),
      generator("UNKNOWN", { legalName: "B" }),
      generator("NONE", { legalName: "C", aqap: "none" }),
      generator("OTHER", { legalName: "D", aqap: "2120" }),
    ]);
    expect(candidate(m, "HAS").reasons).toContainEqual({ rule: "aqap", text: "AQAP: AQAP 2110 (havuzda: AQAP 2110)" });
    expect(ids(m)[0]).toBe("HAS");
    expect(candidate(m, "UNKNOWN").missing).toEqual(["AQAP 2110 havuzda yok (bilinmiyor)"]);
    expect(candidate(m, "NONE").missing).toEqual(["AQAP 2110: havuzda AQAP yok"]);
    expect(candidate(m, "OTHER").missing).toEqual(["AQAP 2110 havuzda yok (havuzda: AQAP 2120)"]);
  });
});

describe("matchManufacturers", () => {
  it("answers each lot of the tender with the pool's version, the same way every time", () => {
    const pool = [generator("GEN"), bolts("CIV")];
    const lots = [generatorLot({ lotNumber: "LOT-0001" }), boltLot({ lotNumber: "LOT-0002" })];
    const first = run(lots, pool);
    expect(first).toMatchObject({ tenderId: "t1", poolVersion: "2.3", hasFacts: true });
    expect(first.lots.map((l) => [l.lotNumber, ids(l)])).toEqual([
      ["LOT-0001", ["GEN"]],
      ["LOT-0002", ["CIV"]],
    ]);
    expect(run(lots, pool)).toEqual(first);
  });
});
