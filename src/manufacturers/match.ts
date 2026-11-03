import { PRODUCT_CATEGORIES, type ProductCategory } from "@/policy/categories";
import { FAMILIES, familiesOfCpvs, type FamilyCode } from "./families";
import { fold, holdsCode, isGeneric, isProductClass, isWeak, phrases, standardCodes, termIndex, terms, weight, type Phrase, type PhraseWord, type TermIndex } from "./match-text";
import { formatSize, lotSizes, POWER_FACTOR, publishedRange, sizeFit, type LotSize, type SizeFit, type SizeKind, type SizeRange } from "./size";
import type { LotForMatch, LotMatch, ManufacturerForMatch, MatchCandidate, MatchInput, MatchReason, MatchResult } from "./types";

// Rule-based matching of a tender's lots to the manufacturer pool (SPEC 10, 8.2), with no LLM and no
// writes. The lot's product is read as items, each with its head noun ("yeni kamyon lastiği": "lastik").
// A manufacturer is a candidate only when one of its products has the same head, or a synonym of it; a
// generic head ("cihaz", "kıyafet") needs a rare word beside it too; only clothing asked for in general
// ("iş kıyafeti") meets any clothing of the family without one, weakly. When the lot
// has a product family, the candidate must be in it, and there a rare describing word alone ("softshell")
// may carry a match, but not between two different products ("polis ayakkabısı" is not "polis
// üniformaları"); a lot without a family needs the head and a rare word together. Sizes and certificates
// add reasons or gaps and never drop a candidate; an unknown is said as unknown. The order is fixed and the
// same input always gives the same answer. Pure.

export type Pool = { poolVersion: string; manufacturers: readonly ManufacturerForMatch[] };

/** What GET /api/tenders/[id]/manufacturers answers: no pool before the first import. */
export type ManufacturersAnswer = { pool: null } | { pool: string; result: MatchResult };

const TOP = 3;
const OTHERS = 7;

export const NO_FACTS_NOTE = "Olgu yok: kategori ve belge kontrolü yapılmadı.";
export const NO_FAMILY_NOTE = "Olgularda ürün adı yok ve CPV kodundan ürün ailesi çıkmadı; ilan metniyle eşleştirme yapılmadı.";
export const TENDER_FAMILY_NOTE = "Aile ihalenin CPV'sinden: lotun kendi kodu aile vermiyor.";
export const TENDER_FAMILIES_NOTE = "İhalenin CPV kodları birden çok ürün ailesine düşüyor; lotun kendi kodu aile vermediği için lot ailesiz sayıldı.";
export const NO_FAMILY_GATE_NOTE = "CPV kodundan ürün ailesi çıkmadı; adayda baş isim ve nadir bir kelime birlikte aranır.";

/**
 * Categories whose products need a maker of that kind (a surgical gown is not a work apron): the facts'
 * category gates the candidates, and with no such firm in the pool the lot has no candidate.
 */
const SPECIALISED: readonly ProductCategory[] = ["MEDICAL_SPECIALISED", "COMPLEX_ELECTRONICS", "HIGH_VALUE_COMMODITIES"];

/** A word in at most this many of the pool's firms is rare: it may carry a match beside a generic head, or alone within the family. */
const RARE_FIRMS = 12;

// ---------------------------------------------------------------------------
// The pool, read once per pool

type Prepared = {
  firm: ManufacturerForMatch;
  /** Each term with the products and materials it appears in, as the pool writes them (for the product score). */
  products: Map<string, string[]>;
  materials: Map<string, string[]>;
  /** The items of the firm's products and materials, with their heads. */
  phrases: Phrase[];
  materialPhrases: Phrase[];
  codes: string[];
  ranges: Record<SizeKind, SizeRange | null>;
};

type PreparedPool = { firms: Prepared[]; index: TermIndex; categories: ReadonlySet<ProductCategory> };

const preparedPools = new WeakMap<readonly ManufacturerForMatch[], PreparedPool>();

function termMap(texts: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const text of texts) {
    for (const { term } of terms(text)) {
      const list = map.get(term) ?? [];
      if (!list.includes(text)) list.push(text);
      map.set(term, list);
    }
  }
  return map;
}

function prepare(firms: readonly ManufacturerForMatch[]): PreparedPool {
  const known = preparedPools.get(firms);
  if (known) return known;
  const prepared = firms.map(
    (firm): Prepared => ({
      firm,
      products: termMap(firm.products),
      materials: termMap(firm.materials),
      phrases: firm.products.flatMap(phrases),
      materialPhrases: firm.materials.flatMap(phrases),
      codes: standardCodes([...firm.certifications.map((c) => c.name), ...firm.standards].join(" ; ")),
      ranges: { power: publishedRange(firm.sizeRange, "power"), thread: publishedRange(firm.sizeRange, "thread") },
    }),
  );
  const pool = {
    firms: prepared,
    index: termIndex(prepared.map((p) => [...p.products.keys(), ...p.materials.keys()])),
    categories: new Set(firms.flatMap((f) => f.categories)),
  };
  preparedPools.set(firms, pool);
  return pool;
}

// ---------------------------------------------------------------------------
// The lot

type Source = "facts" | "translation" | "cpv" | "notice";

/** An item of the lot's product, with where it was read. */
type LotItem = Phrase & { source: Source };

/** A text's first line (its title) and the rest (its description); match-input joins them so. */
const split = (text: string | null): [string | null, string | null] => {
  if (!text) return [null, null];
  const at = text.indexOf("\n");
  return at < 0 ? [text, null] : [text.slice(0, at), text.slice(at + 1)];
};

type Step = { source: Source; texts: (string | null)[] };

/**
 * Where the lot's product is read (SPEC 10, 8.2). The facts' Turkish product name when there is one, and
 * nothing else: what it does not find, a longer text would find only by chance. Without it, the Turkish
 * translation (title, then description), the Turkish CPV names and the notice's own words, in that order,
 * a later one read only while the earlier ones find no candidate; the lot's family is required then.
 */
function lotSteps(lot: LotForMatch): Step[] {
  if (lot.productTr?.trim()) return [{ source: "facts", texts: [lot.productTr] }];
  const [titleTr, restTr] = split(lot.textTr);
  const [title, rest] = split(lot.textOriginal);
  return [
    { source: "translation", texts: [titleTr] },
    { source: "translation", texts: [restTr] },
    { source: "cpv", texts: lot.cpvNamesTr },
    { source: "notice", texts: [title] },
    { source: "notice", texts: [rest] },
  ];
}

const itemsOf = (step: Step): LotItem[] =>
  step.texts.flatMap((text) => (text?.trim() ? phrases(text).map((p) => ({ ...p, source: step.source })) : []));

/** The items' words as the product score counts them (generic heads say nothing of the product). */
const itemTerms = (items: readonly LotItem[]): { term: string; word: string }[] => {
  const seen = new Set<string>();
  return items.flatMap((item) =>
    [...item.modifiers, item.head].flatMap((w) => {
      if (isGeneric(w.canon) || seen.has(w.canon)) return [];
      seen.add(w.canon);
      return [{ term: w.canon, word: w.word }];
    }),
  );
};

type Requirement = { name: string; codes: string[]; aqap: string | null };

/** The certificates to compare: verified, and asked of the product or its maker (never of the bidder). */
function requirements(lot: LotForMatch): Requirement[] {
  const seen = new Set<string>();
  return lot.certifications.flatMap((c) => {
    if (!c.verified || (c.level !== "PRODUCT" && c.level !== "MANUFACTURER")) return [];
    const codes = standardCodes(c.name);
    const key = codes.length ? codes.join("+") : fold(c.name);
    if (seen.has(key)) return [];
    seen.add(key);
    const aqap = codes.find((code) => code.startsWith("AQAP")) ?? null;
    return [{ name: c.name.trim(), codes, aqap }];
  });
}

const join = (items: readonly string[]) => items.join(", ");

/** What the page says of the lot before any candidate: no facts, a mixed lot, the sizes read, what was left out. */
function lotNotes(lot: LotForMatch, hasFacts: boolean, families: readonly FamilyCode[], fromTender: boolean, items: readonly LotItem[], sizes: readonly LotSize[]): string[] {
  const notes: string[] = [];
  if (!hasFacts) notes.push(NO_FACTS_NOTE);
  if (lot.objectType === "MIXED") notes.push("Karışık lot: mal ve bağlı hizmet; mal kısmı eşleştirildi.");
  if (hasFacts && (lot.objectType === "UNKNOWN" || lot.objectType === null)) notes.push("Alım türü olgulardan anlaşılmadı; mal sayıldı.");
  const searched = [...new Set(items.map((item) => item.text))];
  if (searched.length) notes.push(`Aranan: ${searched.slice(0, 6).join("; ")}`);
  if (!families.length) notes.push(NO_FAMILY_GATE_NOTE);
  else if (fromTender) notes.push(TENDER_FAMILY_NOTE);
  if (sizes.some((s) => s.fromKw)) {
    notes.push(`Güç kW'tan kVA'ya ${POWER_FACTOR.toLocaleString("tr-TR")} güç katsayısıyla çevrildi (varsayım).`);
  }
  const bidder = lot.certifications.filter((c) => c.level === "BIDDER").map((c) => c.name);
  if (bidder.length) notes.push(`İstekliden istenen belgeler üreticiyle karşılaştırılmadı (üretici niteliği istekliye aktarılmaz): ${join(bidder)}.`);
  const unverified = lot.certifications.filter((c) => !c.verified && (c.level === "PRODUCT" || c.level === "MANUFACTURER")).map((c) => c.name);
  if (unverified.length) notes.push(`Alıntısı doğrulanmayan belge şartı karşılaştırılmadı: ${join(unverified)}.`);
  return notes;
}

// ---------------------------------------------------------------------------
// One manufacturer against one lot

type Scored = {
  candidate: Omit<MatchCandidate, "rank">;
  /** The team's "Uygun değil" after contacting the firm: after every other candidate. */
  unsuitable: boolean;
  /** How the product matched (strengthOf). */
  strength: number;
  /** The researcher's "Düşük" note: last among the candidates of the same family and strength. */
  low: boolean;
  product: number;
  /** 2 when the size fits, 1 when unknown, 0 when it does not. */
  size: number;
  certificates: number;
  category: boolean;
  evidence: boolean;
  contact: boolean;
};

type HeadKind = "exact" | "synonym" | "generic" | "modifier" | "material" | "general";
const STRENGTH: Record<HeadKind, number> = { exact: 3, synonym: 2, generic: 2, modifier: 1, material: 1, general: 1 };
/** A rare word shared beside a matching head counts for more than the head alone: "softshell mont" is nearer "Softshell iş ceketleri" than "İş montları". */
const RARE_BONUS = 2;

type HeadMatch = { kind: HeadKind; item: LotItem; phrase: Phrase; rare: PhraseWord | null };

/** 5 the same head and a rare word, 4 a synonym (or a generic head) and a rare word, 3 the same head, 2 a synonym, 1 a rare word, a material or a class of products alone. */
const strengthOf = (m: HeadMatch): number => STRENGTH[m.kind] + (m.rare && (m.kind === "exact" || m.kind === "synonym" || m.kind === "generic") ? RARE_BONUS : 0);

/** How one item of the lot meets one item of a firm's products or materials, if it does. */
function meet(item: LotItem, phrase: Phrase, material: boolean, hasFamily: boolean, rare: (term: string) => boolean): HeadMatch | null {
  const shared = item.modifiers.find((m) => rare(m.canon) && (phrase.head.canon === m.canon || phrase.modifiers.some((w) => w.canon === m.canon))) ?? null;
  const head = item.head.stem === phrase.head.stem ? "exact" : item.head.canon === phrase.head.canon ? "synonym" : null;
  if (head) {
    // A lot without a family needs a rare word beside the head as well.
    if (!hasFamily && !shared) return null;
    if (item.generic && !shared) {
      // A class of products with nothing more specific asked ("iş kıyafeti", "koruyucu giysi") meets any
      // product of the class inside the family, at the weakest strength; "motosiklet kıyafeti" asks for
      // more, and "yedek parça" says too little.
      if (material || !isProductClass(item.head.canon) || item.modifiers.some((m) => !isWeak(m.canon))) return null;
      return { kind: "general", item, phrase, rare: null };
    }
    if (material) return hasFamily ? { kind: "material", item, phrase, rare: shared } : null;
    return { kind: item.generic ? "generic" : head, item, phrase, rare: shared };
  }
  // Only a describing word meets: enough inside the lot's family, when the word is rare, and not between two
  // different products ("polis ayakkabısı" and "polis üniformaları"); a generic head on either side may.
  if (!hasFamily || !shared || material) return null;
  return item.generic || phrase.generic ? { kind: "modifier", item, phrase, rare: shared } : null;
}

/** How many words of the lot's item the firm's item shares; between equally strong meetings, the closer one is shown. */
const overlap = (m: HeadMatch) => m.item.modifiers.filter((w) => m.phrase.head.canon === w.canon || m.phrase.modifiers.some((v) => v.canon === w.canon)).length;

/** Only weak words beside the head, if any: "İş kıyafetleri", "Elektrik kabloları". */
const plain = (p: Phrase) => p.modifiers.every((w) => isWeak(w.canon));

/** Stronger first; between equals the one sharing more words, then a plain one ("İş kıyafetleri" before "Aşçı kıyafetleri"), else the firm's first. */
const closer = (m: HeadMatch, best: HeadMatch) =>
  strengthOf(m) > strengthOf(best) ||
  (strengthOf(m) === strengthOf(best) && (overlap(m) > overlap(best) || (overlap(m) === overlap(best) && plain(m.phrase) && !plain(best.phrase))));

function bestMeeting(items: readonly LotItem[], p: Prepared, hasFamily: boolean, rare: (term: string) => boolean): HeadMatch | null {
  let best: HeadMatch | null = null;
  for (const item of items) {
    for (const [list, material] of [[p.phrases, false], [p.materialPhrases, true]] as const) {
      for (const phrase of list) {
        const m = meet(item, phrase, material, hasFamily, rare);
        if (m && (!best || closer(m, best))) best = m;
      }
    }
  }
  return best;
}

const SOURCE_WORDS: Record<Source, string | null> = { facts: null, translation: "çeviri", cpv: "CPV adı", notice: "ilan metni" };

function productReason(m: HeadMatch): MatchReason {
  const how =
    m.kind === "synonym" ? "eşanlam" : m.kind === "modifier" ? `yalnız "${m.rare!.word}"` : m.kind === "material" ? "malzemede" : m.kind === "general" ? "genel" : null;
  const said = [SOURCE_WORDS[m.item.source], how].filter(Boolean);
  return { rule: "product", text: `Ürün${said.length ? ` (${said.join(", ")})` : ""}: "${m.item.text}" (havuzda: ${m.phrase.text})` };
}

const SIZE_WORDS: Record<SizeKind, string> = { power: "Güç", thread: "Diş" };

type LotContext = {
  lot: LotForMatch;
  families: readonly FamilyCode[];
  items: readonly LotItem[];
  sizes: readonly LotSize[];
  required: readonly Requirement[];
  index: TermIndex;
  rare: (term: string) => boolean;
  /** The facts' specialised category, which every candidate must carry. */
  specialised: ProductCategory | null;
};

function score(c: LotContext, p: Prepared): Scored | null {
  const { lot, families, sizes, required, index } = c;
  const firm = p.firm;
  // The lot's family, when it has one, is a gate; so is a specialised category.
  const shared = families.filter((f) => firm.families.includes(f));
  if (families.length && !shared.length) return null;
  if (c.specialised && !firm.categories.includes(c.specialised)) return null;
  const meeting = bestMeeting(c.items, p, families.length > 0, c.rare);
  if (!meeting) return null;
  const reasons: MatchReason[] = [productReason(meeting)];
  const missing: string[] = [];
  const warnings: string[] = [];

  const matched = itemTerms(c.items).filter((t) => p.products.has(t.term) || p.materials.has(t.term));
  const product = matched.reduce((sum, t) => sum + weight(index, t.term) * (p.products.has(t.term) ? 1 : 0.5), 0);

  for (const f of shared) reasons.push({ rule: "family", text: `Ürün ailesi: ${FAMILIES[f].label}` });

  const fits: SizeFit[] = [];
  for (const size of sizes) {
    const range = p.ranges[size.kind];
    const fit = sizeFit(size, range);
    fits.push(fit);
    if (fit === "in") reasons.push({ rule: "size", text: `${SIZE_WORDS[size.kind]}: ${formatSize(size)}, havuzdaki aralık ${formatSize(range!)}` });
    if (fit === "out") missing.push(`${SIZE_WORDS[size.kind]} ${formatSize(size)} havuzdaki aralığın dışında (${formatSize(range!)})`);
  }
  const sizeScore = fits.includes("out") ? 0 : fits.includes("in") ? 2 : 1;

  let certificates = 0;
  for (const r of required) {
    if (r.aqap) {
      const level = r.aqap.slice(4);
      const held = firm.aqap === level || p.codes.includes(r.aqap);
      if (held) {
        certificates++;
        reasons.push({ rule: "aqap", text: `AQAP: ${r.name} (havuzda: AQAP ${level})` });
      } else {
        missing.push(
          firm.aqap === "unknown"
            ? `${r.name} havuzda yok (bilinmiyor)`
            : firm.aqap === "none"
              ? `${r.name}: havuzda AQAP yok`
              : `${r.name} havuzda yok (havuzda: AQAP ${firm.aqap})`,
        );
      }
      continue;
    }
    const held = r.codes.length
      ? r.codes.every((code) => holdsCode(p.codes, code))
      : firm.certifications.some((c) => fold(c.name).includes(fold(r.name)));
    if (held) {
      certificates++;
      reasons.push({ rule: "certification", text: `Belge: ${r.name} (havuzda var)` });
    } else {
      missing.push(`${r.name} havuzda yok (bilinmiyor)`);
    }
  }

  const category = !!lot.category && firm.categories.includes(lot.category);
  if (category) reasons.push({ rule: "category", text: `Kategori: ${PRODUCT_CATEGORIES[lot.category!].label}` });
  if (firm.hasEvidenceQuote) reasons.push({ rule: "evidence", text: "Üretim kanıtı alıntısı var" });

  if (firm.fitLevel === "low") warnings.push("Araştırmacı notu: Düşük uygunluk");
  if (firm.contactState === "unsuitable") warnings.push("İletişim durumu: Uygun değil");
  if (!firm.hasContact) warnings.push("Firma düzeyinde iletişim bilgisi yok");

  return {
    candidate: { manufacturerId: firm.id, legalName: firm.legalName, reasons, missing, warnings },
    unsuitable: firm.contactState === "unsuitable",
    strength: strengthOf(meeting),
    low: firm.fitLevel === "low",
    product,
    size: sizeScore,
    certificates,
    category,
    evidence: firm.hasEvidenceQuote,
    contact: firm.hasContact,
  };
}

const flag = (b: boolean) => (b ? 1 : 0);

/**
 * The fixed order (SPEC 10, 8.2): the team's "Uygun değil" last of all; then how the product matched
 * (strengthOf), the researcher's "Düşük" last within that; then product score, size, certificates,
 * category, evidence and contact; ties by legal name in Turkish, then by id. The family needs no place:
 * with the gate every candidate of a lot shares it, or none does.
 */
function compareScored(a: Scored, b: Scored): number {
  return (
    flag(a.unsuitable) - flag(b.unsuitable) ||
    b.strength - a.strength ||
    flag(a.low) - flag(b.low) ||
    b.product - a.product ||
    b.size - a.size ||
    b.certificates - a.certificates ||
    flag(b.category) - flag(a.category) ||
    flag(b.evidence) - flag(a.evidence) ||
    flag(b.contact) - flag(a.contact) ||
    a.candidate.legalName.localeCompare(b.candidate.legalName, "tr") ||
    (a.candidate.manufacturerId < b.candidate.manufacturerId ? -1 : a.candidate.manufacturerId > b.candidate.manufacturerId ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------

/** Services and works are not matched: the notice's contract nature or the lot's object type says so. */
function notGoods(lot: LotForMatch): string | null {
  if (lot.nature === "services" || lot.objectType === "SERVICES") return "Hizmet alımı: üretici eşleştirmesi yapılmaz.";
  if (lot.nature === "works" || lot.objectType === "WORKS") return "Yapım işi: üretici eşleştirmesi yapılmaz.";
  return null;
}

function matchLot(lot: LotForMatch, hasFacts: boolean, tenderCpv: readonly string[], pool: PreparedPool): LotMatch {
  // A lot's own codes first; when they name no family (a broad "31000000"), the tender's codes, but only
  // when they name a single family: a tender spanning several ("bot" for rescue boats beside protective
  // clothing) says nothing about which one the lot is.
  const own = familiesOfCpvs(lot.cpv);
  const ofTender = own.length ? [] : familiesOfCpvs(tenderCpv);
  const fromTender = ofTender.length === 1;
  const families = own.length ? own : fromTender ? ofTender : [];
  const excluded = notGoods(lot);
  if (excluded) return { lotNumber: lot.lotNumber, status: "not_goods", families, top: [], others: [], notes: [excluded] };
  // Only the facts give a category; a lot without them is not held to it.
  const specialised = hasFacts && lot.category && SPECIALISED.includes(lot.category) ? lot.category : null;
  if (specialised && !pool.categories.has(specialised)) {
    const note = `Uzmanlık kategorisi (${PRODUCT_CATEGORIES[specialised].label}): havuzda bu kategoride üretici yok.`;
    return { lotNumber: lot.lotNumber, status: "no_pool_match", families, top: [], others: [], notes: [note] };
  }
  const sizes = lotSizes([lot.textOriginal, lot.textTr, lot.quantityText].filter(Boolean).join("\n"));
  const required = hasFacts ? requirements(lot) : [];
  const rare = (term: string) => !isWeak(term) && !isGeneric(term) && (pool.index.counts.get(term) ?? 0) <= RARE_FIRMS;
  const fromFacts = !!lot.productTr?.trim();
  let items: LotItem[] = [];
  let found: Scored[] = [];
  // Without the facts' product name only the lot's family keeps a longer text from matching by chance.
  if (fromFacts || families.length) {
    for (const step of lotSteps(lot)) {
      const added = itemsOf(step);
      if (!added.length) continue;
      items = [...items, ...added];
      const context: LotContext = { lot, families, items, sizes, required, index: pool.index, rare, specialised };
      found = pool.firms.map((p) => score(context, p)).filter((s): s is Scored => s !== null);
      if (found.length) break;
    }
  }
  const notes = lotNotes(lot, hasFacts, families, fromTender, items, sizes);
  if (ofTender.length > 1) notes.push(TENDER_FAMILIES_NOTE);
  if (!fromFacts && !families.length) notes.push(NO_FAMILY_NOTE);
  const scored = found
    .sort(compareScored)
    .slice(0, TOP + OTHERS)
    .map((s, i): MatchCandidate => ({ ...s.candidate, rank: i + 1 }));
  // The card says "Havuzda bu ürün için üretici yok." for the status; the notes say why and what was read.
  if (!scored.length) return { lotNumber: lot.lotNumber, status: "no_pool_match", families, top: [], others: [], notes };
  return { lotNumber: lot.lotNumber, status: "matched", families, top: scored.slice(0, TOP), others: scored.slice(TOP), notes };
}

/** The candidates for each lot of a tender, from the pool as it is now. */
export function matchManufacturers(input: MatchInput, pool: Pool): MatchResult {
  const prepared = prepare(pool.manufacturers);
  return {
    tenderId: input.tenderId,
    poolVersion: pool.poolVersion,
    hasFacts: input.hasFacts,
    lots: input.lots.map((lot) => matchLot(lot, input.hasFacts, input.tenderCpv, prepared)),
  };
}
