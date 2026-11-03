// The words the manufacturer matcher compares (SPEC 10, 8.2). A notice's product ("iş güvenliği botu",
// "Koruyucu ayakkabılar") and a manufacturer's products ("Emniyet ayakkabıları") meet as folded, stemmed
// terms: lower case without accents, the common suffixes cut, a final consonant hardened, a few synonyms
// made one. A product phrase is read as items ("kablo ve garnitür" is two), each with its head noun (the
// last word) and the words before it; the matcher compares heads first. Stop words say nothing about the
// product; weak words (materials, uses, qualities) add to a match but never make one; generic heads
// ("cihaz", "ekipman", "kıyafet") need a rare word beside them, unless the lot asks for nothing more
// specific. The lists are small and kept by hand. Pure.

/** Lower case without accents, Turkish rules first: "IŞIK" and "Işık" as "isik", "Jeneratör" as "jenerator". */
export function fold(text: string): string {
  return text.toLocaleLowerCase("tr").normalize("NFD").replace(/\p{M}/gu, "").replace(/ı/g, "i");
}

/**
 * Longest first, with the shortest stem each may leave ("botları" and "botu" as "bot"). "-lı/-lu" stays:
 * "motorlu" describes a vehicle, "motor" is a product.
 */
const SUFFIXES: readonly (readonly [string, number])[] = [
  ["lari", 3],
  ["leri", 3],
  ["lar", 3],
  ["ler", 3],
  ["si", 3],
  ["su", 3],
  // The maker of a thing: "itfaiyeci elbisesi" is a firefighter's suit, "kaynakçı" a welder.
  ["ci", 4],
  ["cu", 4],
  ["i", 3],
  ["u", 3],
];

const HARDEN: Record<string, string> = { b: "p", d: "t", g: "k" };

/**
 * A folded word without its common suffixes, its last consonant hardened, so the forms of a word meet:
 * "ayakkabıları", "ayakkabısı" and "ayakkabı" all as "ayakkap", "güvenliği" and "güvenlik" as "guvenlik".
 * Not a real stemmer: it only has to treat both sides alike.
 */
export function stem(word: string): string {
  let w = word;
  for (let pass = 0; pass < 2; pass++) {
    const cut = SUFFIXES.find(([suffix, min]) => w.endsWith(suffix) && w.length - suffix.length >= min);
    if (!cut) break;
    w = w.slice(0, -cut[0].length);
  }
  const last = w.at(-1);
  return last && HARDEN[last] ? w.slice(0, -1) + HARDEN[last] : w;
}

const stemOf = (word: string) => stem(fold(word));

// Words that say nothing about what is bought: grammar, procurement, company and quantity words.
const STOP_WORDS = [
  "ve", "ile", "için", "veya", "ya", "da", "de", "ki", "bir", "bu", "şu", "olan", "olarak", "gibi", "her", "tüm", "bütün",
  "diğer", "çeşitli", "muhtelif", "genel", "özel", "standart", "yeni", "temin", "alım", "satın", "satınalma", "tedarik",
  "teslim", "teslimat", "hizmet", "mal", "karşı", "kullanılmış", "ikinci", "tek", "çift", "iki", "üç", "dört", "beş",
  "adet", "lot", "kısım", "grup", "tip", "model", "çeşit", "çerçeve", "anlaşma", "yıllık", "aylık", "sözleşme", "iş",
  "imalat", "üretim", "üretici", "sanayi", "ticaret", "proje", "kapsam", "dahil", "amaçlı", "kullanım", "uygun",
  "gerekli", "ihtiyaç", "bakım", "onarım", "kurulum", "montaj", "ihale", "idare", "kurum", "belediye", "müdürlük",
  "garanti", "şartname", "belge", "sertifika", "teklif", "fiyat", "süre", "gün", "ay", "yıl", "yer", "adres",
  // Units and standard prefixes: sizes and codes are read on their own.
  "kw", "kva", "kwh", "mw", "mva", "mm", "cm", "kg", "ton", "en", "iso", "iec", "din", "ts", "bs", "astm", "ce", "ip",
  // The notice's own language, when nothing Turkish is there.
  "the", "of", "and", "for", "with", "to", "in", "on", "an", "supply", "delivery", "purchase", "procurement", "provision",
  "contract", "framework", "service", "services", "goods", "equipment",
];

// Words that describe the product but are not the product: materials, uses and qualities. They add to a
// match but never make one on their own.
const WEAK_WORDS = [
  "metal", "çelik", "paslanmaz", "demir", "plastik", "alüminyum", "bakır", "pirinç", "kauçuk", "ahşap", "cam", "beton",
  "kompozit", "elektrik", "elektrikli", "elektronik", "mekanik", "endüstriyel", "profesyonel", "ağır", "hafif", "büyük",
  "küçük", "dış", "iç", "mekân", "mekan", "açık", "kapalı", "yüksek", "düşük", "koruyucu", "koruma", "güvenlik", "emniyet",
  "askeri", "sivil", "sokak", "yol", "bina", "aydınlatma", "ışık", "taşıt", "otomatik",
  "manuel", "dijital", "mobil", "sabit", "dizel", "benzinli", "kişisel", "personel", "ofis", "kurumsal",
  "motorlu", "teknik", "yedek", "aksesuar", "ticari", "binek", "kalite",
];

// Heads that name a kind of thing, not a product: a match on one needs a rare word beside it as well
// ("görüntüleme cihazı" is not "iklimlendirme cihazları"), and a rare word beside one may meet a product
// ("dekontaminasyon altyapısı" and "Dekontaminasyon çadırları").
const GENERIC_WORDS = [
  "ürün", "malzeme", "ekipman", "donanım", "sistem", "parça", "aksesuar", "cihaz", "araç", "makine", "alet", "gereç",
  "ünite", "aparat", "eleman", "mamul", "madde", "aksam", "bileşen", "komponent", "altyapı",
  // Clothing in general: "motosiklet kıyafeti" is not "Aşçı kıyafetleri". A uniform is a product of its own.
  "giysi", "kıyafet", "elbise", "giyim",
];

// Generic heads that still name one class of products, made by one kind of maker: a lot asking for
// nothing more specific ("iş kıyafeti", "koruyucu giysi") meets any of them within its family. "Yedek
// parça" or "kurtarma ekipmanı" says too little for that.
const CLASS_WORDS = ["giysi", "kıyafet", "elbise", "giyim"];

// Collective heads that pass to the word before them: "Dizel jeneratör setleri" is about generators.
const TRANSPARENT_WORDS = ["set", "takım", "kit", "paket", "seri"];

// One canonical term per group; every word of a group is stemmed like the texts.
const SYNONYMS: readonly (readonly string[])[] = [
  ["portatif", "taşınabilir", "seyyar", "portable"],
  ["römork", "römorklu", "çekilir", "çekilebilir", "treyler"],
  ["ayakkabı", "bot", "çizme", "postal", "potin"],
  ["pano", "dolap"],
  ["giysi", "elbise", "kıyafet", "giyim"],
  ["ceket", "mont", "parka", "kaban"],
  ["baret", "kask"],
  ["reflektif", "yansıtıcı", "görünürlük", "görünürlüklü", "fosforlu"],
  ["jeneratör", "generatör", "generator"],
  ["konteyner", "konteynır", "container"],
  ["prefabrik", "modüler"],
  ["şelter", "shelter", "barınak"],
  ["cıvata", "bulon"],
  ["akü", "akümülatör", "batarya"],
  ["vana", "valf"],
  ["conta", "keçe", "salmastra", "sızdırmazlık"],
  ["armatür", "lamba", "luminer"],
  ["filtre", "süzgeç"],
];

const CANONICAL = new Map<string, string>();
for (const group of SYNONYMS) {
  const head = stemOf(group[0]!);
  for (const word of group) CANONICAL.set(stemOf(word), head);
}
const canonical = (term: string) => CANONICAL.get(term) ?? term;

const stems = (words: readonly string[]) => new Set(words.map((w) => canonical(stemOf(w))));
const STOP = stems(STOP_WORDS);
const WEAK = stems(WEAK_WORDS);
const GENERIC = stems(GENERIC_WORDS);
const CLASS = stems(CLASS_WORDS);
const TRANSPARENT = stems(TRANSPARENT_WORDS);

/** A term the matcher looks for, with the word it came from. */
export type Term = { term: string; word: string };

/**
 * The product terms of a text, in order and without repeats: stop words, numbers and one-letter
 * tokens left out ("M12", "6 kW" and "EN 388" are read by size.ts and the certificate rule).
 */
export function terms(text: string): Term[] {
  const seen = new Set<string>();
  const out: Term[] = [];
  for (const word of text.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 2 || /\d/.test(word)) continue;
    const term = canonical(stemOf(word));
    if (term.length < 2 || STOP.has(term) || GENERIC.has(term) || TRANSPARENT.has(term) || seen.has(term)) continue;
    seen.add(term);
    out.push({ term, word });
  }
  return out;
}

/** Materials, uses and qualities: they count, but a match needs at least one other term. */
export const isWeak = (term: string): boolean => WEAK.has(term);

/** A head that names a kind of thing ("cihaz", "ekipman"), not a product. */
export const isGeneric = (term: string): boolean => GENERIC.has(term);

/** A generic head that names a class of products one kind of maker makes ("kıyafet"). */
export const isProductClass = (term: string): boolean => CLASS.has(term);

/** A word of a product phrase, as the matcher compares it and as it was written. */
export type PhraseWord = { stem: string; canon: string; word: string };

/**
 * One item of a product phrase: its head noun (the last word that is not a stop word or a collective
 * like "set"), the words before it, and whether the head is generic.
 */
export type Phrase = { text: string; head: PhraseWord; modifiers: PhraseWord[]; generic: boolean };

/** Items are split at commas, semicolons, slashes and "ve", "ile", "veya" (and their English kin). */
const ITEM_SPLIT = /[,;/+&\n]|\s(?:ve|ile|veya|and|or)\s/iu;
/** A lone describing word ("Benzinli ve dizel jeneratörler") belongs to the next item's head. */
const DESCRIBING = /(?:li|lu|siz|suz|sel|sal)$/;

/**
 * The items of a product phrase: "rechapé ve yeni kamyon lastiği" as "rechapé" and "yeni kamyon lastiği".
 * What is in parentheses is read after the rest, as items of its own: "itfaiye çıkış kıyafeti (ceket ve
 * pantolon)" as "itfaiye çıkış kıyafeti", "ceket" and "pantolon", so the main item keeps its head; a lone
 * describing word there ("kurtarma botu (motorlu)") goes to the item before it.
 */
export function phrases(text: string): Phrase[] {
  const inner: string[] = [];
  const outer = text.replace(/\(([^()]*)\)/g, (_, group: string) => {
    inner.push(group);
    return " ";
  });
  const out: Phrase[] = [];
  for (const part of [outer, ...inner]) readItems(part, out);
  return out;
}

/** Adds the items of a text to out; describing words left at its end go to the last item so far. */
function readItems(text: string, out: Phrase[]): void {
  let pending: PhraseWord[] = [];
  for (const item of text.split(ITEM_SPLIT)) {
    const words: PhraseWord[] = [];
    for (const word of item.split(/[^\p{L}\p{N}]+/u)) {
      if (word.length < 2 || /\d/.test(word)) continue;
      const folded = fold(word);
      const s = stem(folded);
      const canon = canonical(s);
      if (canon.length < 2 || STOP.has(canon) || TRANSPARENT.has(canon)) continue;
      words.push({ stem: s, canon, word });
    }
    if (!words.length) continue;
    const describing = words.every((w) => WEAK.has(w.canon)) || (words.length === 1 && DESCRIBING.test(fold(words[0]!.word)));
    if (describing) {
      pending.push(...words);
      continue;
    }
    const head = words.at(-1)!;
    out.push({ text: item.trim(), head, modifiers: [...pending, ...words.slice(0, -1)], generic: GENERIC.has(head.canon) });
    pending = [];
  }
  if (pending.length && out.length) out.at(-1)!.modifiers.push(...pending);
}

/** How many of the pool's manufacturers use each term, for the rarity weight. */
export type TermIndex = { firms: number; counts: ReadonlyMap<string, number> };

export function termIndex(perFirm: Iterable<Iterable<string>>): TermIndex {
  const counts = new Map<string, number>();
  let firms = 0;
  for (const firmTerms of perFirm) {
    firms++;
    for (const term of new Set(firmTerms)) counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  return { firms, counts };
}

/** Weak terms weigh a quarter of a full one. */
const WEAK_WEIGHT = 0.25;

/** Rarer terms weigh more: "ayakkabı" (8 firms of 252) more than "cıvata" (32). Always above zero. */
export function weight(index: TermIndex, term: string): number {
  const rarity = Math.log((index.firms + 1) / ((index.counts.get(term) ?? 0) + 1)) + 1;
  return isWeak(term) ? rarity * WEAK_WEIGHT : rarity;
}

// ---------------------------------------------------------------------------
// Standards and certificates

const CODE = /\b(ISO|IEC|EN|ASTM|AQAP|AS|IATF|STANAG|DIN|TS|BS|UL|MIL-[A-Z]+)\s*-?\s*([A-Z]?\d+(?:[-.]\d+)*)/g;
const MARKS = /\b(CE|UKCA|GS)\b/g;

/**
 * Standard and certificate codes in a text, one spelling each: "TS EN ISO 20471:2013", "EN ISO 20471" and
 * "ISO 20471" all as "ISO20471" (a year after the colon is not part of the number); "AS/EN 9100" as
 * "AS9100"; the CE, UKCA and GS marks by name.
 */
export function standardCodes(text: string): string[] {
  let t = text.toLocaleUpperCase("tr").replace(/İ/g, "I").replace(/Ö/g, "O");
  // A code needs digits right after its body, so "TS EN ISO 20471" yields "ISO20471" alone; only the
  // reversed "ISO EN 8528-13" (as one firm writes it) would yield "EN8528-13".
  t = t.replace(/\bISO\s+EN\b/g, "ISO");
  t = t.replace(/\bAS\s*\/\s*EN\s*9100\b|\bEN\s*9100\b/g, "AS 9100");
  const out = new Set<string>();
  for (const m of t.matchAll(CODE)) out.add(`${m[1]}${m[2]}`);
  for (const m of t.matchAll(MARKS)) out.add(m[1]!);
  return [...out];
}

/** A required code is held when the firm names it, or a part of it ("ISO 8528-5" for "ISO 8528"), or its family. */
export function holdsCode(held: readonly string[], code: string): boolean {
  return held.some((h) => h === code || h.startsWith(`${code}-`) || code.startsWith(`${h}-`));
}
