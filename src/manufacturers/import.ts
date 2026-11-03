import { createHash } from "node:crypto";
import { z } from "zod";
import type { manufacturerCertifications, manufacturerSources, NewManufacturer } from "@/db/schema";
import { countryNameToAlpha2, isCountryCode, normalizeAlpha2 } from "@/lib/countries";
import { parseCsv } from "@/matching/cpv/source";
import { PRODUCT_CATEGORIES, type ProductCategory } from "@/policy/categories";
import { type FamilyCode, isFamilyCode } from "./families";
import { CONTACT_STATE_LABELS } from "./labels";
import type { CertificationKind, ContactState } from "./types";

// Reads a pool package the team builds outside the platform (SPEC 10, 8.1): the pool JSONL with its 48
// columns and the field sources CSV, both checked against the package's SHA256SUMS. Pure: the command
// (src/worker/manufacturers.ts) reads the files and import-store.ts writes the result.
//
// The KVKK guard keeps personal data out: a firm with a free mailbox, a mobile number, a number that
// passes the TCKN check, a person's profile link or a sole proprietor's VKN or MERSİS anywhere in its row
// or its sources is not loaded. Findings and errors name the firm, the place and the rule, never a value:
// the command's output may be pasted into a chat. Only codes from closed lists are quoted.

export const POOL_COLUMNS = [
  "Firma ID",
  "Tüzel kişi unvanı",
  "Şube / tesis adı",
  "Şahıs işletmesi (Evet/Hayır)",
  "VKN",
  "MERSİS no",
  "Kimlik kaynağı (URL)",
  "Fabrika il",
  "Fabrika ilçe",
  "Fabrika adresi",
  "Adres türü (Fabrika/Merkez ofis/Şube/Bilinmiyor)",
  "OSB / bölge",
  "Tür (Üretici/Üretici ve ticaret)",
  "Bozkor kategorileri",
  "Ürün ailesi kodları",
  "Kendi üretimi ürünler",
  "Malzemeler",
  "Ölçü ya da güç aralığı",
  "Uyguladığı standartlar",
  "Üretim biçimi",
  "Sertifikalar",
  "Sertifika kaynağı (URL)",
  "AQAP (2110/2120/Yok/Bilinmiyor)",
  "AS9100 (Evet/Hayır/Bilinmiyor)",
  "NCAGE kodu",
  "NCAGE kaynağı (URL)",
  "Savunma deneyimi",
  "Savunma deneyimi kaynağı (URL)",
  "Tesis Güvenlik Belgesi (Evet/Bilinmiyor)",
  "İhracat (Evet/Hayır/Bilinmiyor)",
  "İhracat ülkeleri",
  "İhracat kaynağı (URL)",
  "İhale uygunluğu (Yüksek/Orta/Düşük)",
  "Uygunluk notu",
  "Genel e-posta",
  "Genel telefon",
  "Web sitesi",
  "Kanıt kaynağı türü",
  "Üretim kanıtı bağlantısı",
  "Kanıtın sayfa konumu",
  "Kanıttan kısa alıntı",
  "Şirket / kaynak eşleşmesi",
  "İlk kayıt kaynakları",
  "Kontrol tarihi",
  "İletişim durumu",
  "MOQ ve birim",
  "Termin (gün)",
  "Notlar",
] as const;

export type PoolColumn = (typeof POOL_COLUMNS)[number];

export const SOURCE_COLUMNS = [
  "Firma ID",
  "Alan",
  "Güncel değer",
  "Kaynak (URL)",
  "Doğrulama türü",
  "Açıklama",
  "Önceki kaynaklar (URL)",
  "Kontrol tarihi",
] as const;

/** Columns whose values are codes or closed-list words, so an error may quote them. */
const QUOTABLE = new Set<string>([
  "Şahıs işletmesi (Evet/Hayır)",
  "Adres türü (Fabrika/Merkez ofis/Şube/Bilinmiyor)",
  "Tür (Üretici/Üretici ve ticaret)",
  "Bozkor kategorileri",
  "Ürün ailesi kodları",
  "AQAP (2110/2120/Yok/Bilinmiyor)",
  "AS9100 (Evet/Hayır/Bilinmiyor)",
  "Tesis Güvenlik Belgesi (Evet/Bilinmiyor)",
  "İhracat (Evet/Hayır/Bilinmiyor)",
  "İhracat ülkeleri",
  "İhale uygunluğu (Yüksek/Orta/Düşük)",
  "Kontrol tarihi",
  "İletişim durumu",
  "Termin (gün)",
]);

const text = z.string().nullable();
const tri = z.enum(["Evet", "Hayır", "Bilinmiyor"]);

/** One pool row after trimming, with "" as null. The keys are the package's headers, exactly. */
const poolRowSchema = z.strictObject({
  "Firma ID": z.string().regex(/^BZ-[0-9A-F]{12}$/),
  "Tüzel kişi unvanı": z.string(),
  "Şube / tesis adı": text,
  "Şahıs işletmesi (Evet/Hayır)": z.enum(["Evet", "Hayır"]).nullable(),
  VKN: z.string().regex(/^\d{10}$/).nullable(),
  "MERSİS no": z.string().regex(/^0\d{15}$/).nullable(),
  "Kimlik kaynağı (URL)": text,
  "Fabrika il": text,
  "Fabrika ilçe": text,
  "Fabrika adresi": text,
  "Adres türü (Fabrika/Merkez ofis/Şube/Bilinmiyor)": z.enum(["Fabrika", "Merkez ofis", "Şube", "Bilinmiyor"]),
  "OSB / bölge": text,
  "Tür (Üretici/Üretici ve ticaret)": z.enum(["Üretici", "Üretici ve ticaret"]),
  "Bozkor kategorileri": text,
  "Ürün ailesi kodları": text,
  "Kendi üretimi ürünler": text,
  Malzemeler: text,
  "Ölçü ya da güç aralığı": text,
  "Uyguladığı standartlar": text,
  "Üretim biçimi": text,
  Sertifikalar: text,
  "Sertifika kaynağı (URL)": text,
  "AQAP (2110/2120/Yok/Bilinmiyor)": z.enum(["2110", "2120", "Yok", "Bilinmiyor"]),
  "AS9100 (Evet/Hayır/Bilinmiyor)": tri,
  "NCAGE kodu": text,
  "NCAGE kaynağı (URL)": text,
  "Savunma deneyimi": text,
  "Savunma deneyimi kaynağı (URL)": text,
  "Tesis Güvenlik Belgesi (Evet/Bilinmiyor)": tri,
  "İhracat (Evet/Hayır/Bilinmiyor)": tri,
  "İhracat ülkeleri": text,
  "İhracat kaynağı (URL)": text,
  // The schema has no "Yüksek" (fit_level): a pool that starts using it needs a migration first.
  "İhale uygunluğu (Yüksek/Orta/Düşük)": z.enum(["Orta", "Düşük"]).nullable(),
  "Uygunluk notu": text,
  "Genel e-posta": text,
  "Genel telefon": text,
  "Web sitesi": text,
  "Kanıt kaynağı türü": text,
  "Üretim kanıtı bağlantısı": text,
  "Kanıtın sayfa konumu": text,
  "Kanıttan kısa alıntı": text,
  "Şirket / kaynak eşleşmesi": text,
  "İlk kayıt kaynakları": text,
  "Kontrol tarihi": z.iso.date().nullable(),
  "İletişim durumu": text,
  "MOQ ve birim": text,
  "Termin (gün)": z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]).nullable(),
  Notlar: text,
});

type PoolRow = z.infer<typeof poolRowSchema>;

export type PreparedManufacturer = Required<Omit<NewManufacturer, "importId" | "active" | "createdAt" | "updatedAt">>;
export type PreparedCertification = Required<Omit<typeof manufacturerCertifications.$inferInsert, "id">>;
export type PreparedSource = Required<typeof manufacturerSources.$inferInsert>;

export type RejectRule = "free_mail" | "mobile_number" | "tckn" | "person_link" | "sole_proprietor_id";
export type ReviewRule = "personal_mailbox" | "sole_proprietor_unknown" | "no_company_form" | "sole_proprietor_link";

export const RULE_LABELS: Record<RejectRule | ReviewRule, string> = {
  free_mail: "ücretsiz posta alan adı",
  mobile_number: "cep telefonu numarası",
  tckn: "TCKN sağlamasından geçen sayı",
  person_link: "kişi profili bağlantısı",
  sole_proprietor_id: "şahıs işletmesinde VKN ya da MERSİS",
  personal_mailbox: "rol ya da firma adı olmayan e-posta yerel kısmı",
  sole_proprietor_unknown: "şahıs işletmesi olup olmadığı bilinmiyor",
  no_company_form: "unvanda şirket türü yok",
  sole_proprietor_link: "şahıs işletmesinin bağlantısı",
};

/** The place of a finding in a field sources row: "Alan kaynakları: Genel telefon". */
export const SOURCE_PLACE = "Alan kaynakları: ";

/** Where a finding is: a pool column, or a field sources row (SOURCE_PLACE and the field). */
export type Finding<R extends string = RejectRule | ReviewRule> = { manufacturerId: string; place: string; rule: R };

export type ImportPlan = {
  version: string;
  poolSha256: string;
  sourcesSha256: string;
  poolRows: number;
  sourceRows: number;
  manufacturers: PreparedManufacturer[];
  certifications: PreparedCertification[];
  sources: PreparedSource[];
  /** Firms left out by the KVKK guard, with every place and rule that left them out. */
  rejected: Finding<RejectRule>[];
  /** Loaded, but someone should look. */
  review: Finding<ReviewRule>[];
  /** What the import decided on its own, e.g. the first of two provinces. */
  notes: { manufacturerId: string; text: string }[];
};

export type PrepareResult =
  | { ok: true; plan: ImportPlan }
  | { ok: false; errors: string[]; rejected: Finding<RejectRule>[]; review: Finding<ReviewRule>[] };

export type PackageInput = {
  /** As the package names it: "2.3". */
  version: string;
  pool: { name: string; bytes: Uint8Array };
  sources: { name: string; bytes: Uint8Array };
  /** SHA256SUMS.txt of the package. */
  sha256Sums: string;
};

// ---------------------------------------------------------------------------------------------------
// The package

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The pool and sources files of a version among a folder's names. */
export function packageFileNames(names: readonly string[], version: string): { pool: string; sources: string } | { error: string } {
  const v = escapeRegExp(version);
  const pools = names.filter((n) => new RegExp(`^BOZKOR_Havuz_v${v}_\\d{4}-\\d{2}-\\d{2}\\.jsonl$`).test(n));
  const sources = names.filter((n) => n === `BOZKOR_Alan_Kaynaklari_v${version}.csv`);
  if (pools.length > 1) return { error: `Klasörde sürüm ${version} için birden çok havuz dosyası var: ${pools.join(", ")}.` };
  if (!pools.length) return { error: `Klasörde BOZKOR_Havuz_v${version}_<tarih>.jsonl yok.` };
  if (sources.length !== 1) return { error: `Klasörde BOZKOR_Alan_Kaynaklari_v${version}.csv yok.` };
  return { pool: pools[0]!, sources: sources[0]! };
}

export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** sha256sum's format: "<64 hex>  <name>", one file per line ("*" before the name marks binary mode). */
export function parseSha256Sums(sums: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m) out.set(m[2]!.trim(), m[1]!.toLowerCase());
  }
  return out;
}

function decode(file: { name: string; bytes: Uint8Array }, errors: string[]): string | null {
  try {
    // The decoder drops a leading BOM (the package's CSVs have one).
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    errors.push(`${file.name}: UTF-8 değil.`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------
// Values

/** "a;b; ;a" -> ["a", "b"]: the pool's list separator, trimmed, empty and repeated items dropped. */
export function splitList(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(";").map((s) => s.trim()).filter(Boolean))];
}

const clean = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/** Lower case, Turkish letters folded to ASCII: "ŞAHİN Çelik" -> "sahin celik". */
export function fold(s: string): string {
  return s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "");
}

/** The tax number's check digit (VKN, 10 digits). */
export function isValidVkn(vkn: string): boolean {
  if (!/^\d{10}$/.test(vkn)) return false;
  const d = [...vkn].map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const tmp = (d[i]! + 10 - (i + 1)) % 10;
    sum += tmp === 9 ? 9 : (tmp * 2 ** (10 - (i + 1))) % 9;
  }
  return (10 - (sum % 10)) % 10 === d[9];
}

/** The identity number's two check digits (TCKN, 11 digits, not starting with 0). */
export function isValidTckn(tckn: string): boolean {
  if (!/^[1-9]\d{10}$/.test(tckn)) return false;
  const d = [...tckn].map(Number);
  const odd = d[0]! + d[2]! + d[4]! + d[6]! + d[8]!;
  const even = d[1]! + d[3]! + d[5]! + d[7]!;
  if ((((odd * 7 - even) % 10) + 10) % 10 !== d[9]) return false;
  return d.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === d[10];
}

/** Names the pool uses that Intl's Turkish names do not ("Côte d’Ivoire" is "Fildişi Sahili" in the pool). */
const COUNTRY_ALIASES: Record<string, string> = { abd: "US", "fildisi sahili": "CI" };

let turkishCountryIndex: Map<string, string> | null = null;

function turkishCountries(): Map<string, string> {
  if (turkishCountryIndex) return turkishCountryIndex;
  const names = new Intl.DisplayNames(["tr"], { type: "region" });
  const index = new Map<string, string>();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (!isCountryCode(code)) continue;
      const name = names.of(code);
      if (name && name !== code) index.set(fold(name), code);
    }
  }
  turkishCountryIndex = index;
  return index;
}

/** A country as the pool writes it ("Almanya", "DE", "ABD", "Germany") to ISO 3166 alpha-2, or null. */
export function countryCode(token: string): string | null {
  const code = /^[A-Za-z]{2}$/.test(token) ? normalizeAlpha2(token) : null;
  if (code && isCountryCode(code)) return code;
  const key = fold(token).trim();
  return COUNTRY_ALIASES[key] ?? turkishCountries().get(key) ?? countryNameToAlpha2(token);
}

// ---------------------------------------------------------------------------------------------------
// Certificates

export type ParsedCertification = { name: string; kind: CertificationKind; validUntil: string | null; note: string | null };

const MANAGEMENT_NUMBERS = /(?<!\d)(?:9001|9100|10002|13485|14001|14064|16949|22000|27001|3834|45001|50001)(?!\d)/;
const PRODUCT_MARKS = /^(?:CE|UKCA|TSE|TSEK|UL|FM|MPA|GOST|GOST-R|EAC|VDE|ATEX|IECEx)\b|^(?:EN|TS|DIN|ASTM)\b|\bEN ISO\b/i;

/** What a certificate is, from its name: a management system, a product mark, a defence quality standard, or other. */
export function certificationKind(name: string): CertificationKind {
  if (/^AQAP\b/i.test(name)) return "defense";
  if (MANAGEMENT_NUMBERS.test(name)) return "management";
  if (PRODUCT_MARKS.test(name)) return "product";
  return "other";
}

/** Splits on ";" outside parentheses. */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

const isRealDate = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
};

/**
 * The pool's "Sertifikalar": "ISO 9001:2015 (2027-04-16);CE (kapsam/bitiş tarihi bilinmiyor)". The date in
 * the trailing parentheses is the validity; what else they say is kept as the note.
 */
export function parseCertifications(value: string | null): { certifications: ParsedCertification[]; problems: string[] } {
  const certifications: ParsedCertification[] = [];
  const problems: string[] = [];
  for (const token of splitTopLevel(value ?? "")) {
    const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(token);
    const name = (m ? m[1]! : token).trim();
    const inside = m ? m[2]!.trim() : "";
    if (!name) {
      problems.push("adı olmayan belge");
      continue;
    }
    const dates = [...inside.matchAll(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/g)].map((d) => d[1]!);
    if (dates.length > 1 || dates.some((d) => !isRealDate(d))) {
      problems.push(`"${name}" için tarih okunamadı`);
      continue;
    }
    const note = (dates[0] ? inside.replace(dates[0], "") : inside).replace(/^[\s,;]+|[\s,;]+$/g, "");
    if (certifications.some((c) => c.name === name)) {
      problems.push(`"${name}" iki kez yazılmış`);
      continue;
    }
    certifications.push({ name, kind: certificationKind(name), validUntil: dates[0] ?? null, note: note || null });
  }
  return { certifications, problems };
}

// ---------------------------------------------------------------------------------------------------
// The KVKK guard

const FREE_MAIL_BRANDS = /^(?:gmail|googlemail|hotmail|outlook|yahoo|ymail|yandex|icloud|mynet|windowslive|protonmail|gmx|aol)\.[a-z.]+$/;
const FREE_MAIL_DOMAINS = new Set(["live.com", "msn.com", "me.com", "mac.com", "web.de", "mail.ru", "proton.me", "superonline.com", "ttmail.com"]);
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/** The e-mail addresses in a text, lower case. */
export function emailsIn(value: string): string[] {
  return [...value.matchAll(EMAIL)].map((m) => m[0].toLowerCase().replace(/\.+$/, ""));
}

const isFreeMailDomain = (domain: string) => FREE_MAIL_BRANDS.test(domain) || FREE_MAIL_DOMAINS.has(domain);

/** Whether a text holds an address at a free mail provider (a person's, not the firm's). */
export function hasFreeMail(value: string): boolean {
  return emailsIn(value).some((address) => isFreeMailDomain(address.slice(address.indexOf("@") + 1)));
}

/**
 * Whether a text holds a Turkish mobile number in any common writing: +90 532 123 45 67, 0(532)1234567,
 * 05321234567, 0090..., wa.me/905321234567. The digit groups of a run are tried from each group's start, so
 * a number next to another one is still found, while a longer number (a 16-digit MERSİS) is not read as one.
 * Digits glued to letters are a code, not a number: "BZ-5163994605F2" is a firm ID.
 */
export function hasMobileNumber(value: string): boolean {
  for (const run of value.matchAll(/(?<![\p{L}\d])\d(?:[\d\s().-]*\d)?/gu)) {
    const after = value[run.index + run[0].length];
    if (after && /\p{L}/u.test(after)) continue;
    const groups = run[0].split(/[\s().-]+/).filter(Boolean);
    for (let i = 0; i < groups.length; i++) {
      let digits = "";
      for (let j = i; j < groups.length && digits.length < 14; j++) {
        digits += groups[j];
        if (digits.length >= 10 && isMobile(digits)) return true;
      }
    }
  }
  return false;
}

function isMobile(digits: string): boolean {
  const national =
    digits.length === 10 ? digits : digits.length === 11 && digits.startsWith("0") ? digits.slice(1) : digits.length === 12 && digits.startsWith("90") ? digits.slice(2) : digits.length === 14 && digits.startsWith("0090") ? digits.slice(4) : null;
  return national !== null && national.startsWith("5");
}

/** Whether a text holds an 11-digit number that passes the TCKN check. */
export function hasTckn(value: string): boolean {
  return [...value.matchAll(/(?<![\p{L}\d])\d{11}(?![\p{L}\d])/gu)].some((m) => isValidTckn(m[0]));
}

/** Whether a text links a person's profile (LinkedIn /in/ or /pub/). Company pages are fine. */
export function hasPersonLink(value: string): boolean {
  return /linkedin\.com\/(?:in|pub)\//i.test(value);
}

const ROLE_WORDS = new Set(
  (
    "info bilgi satis sales export ihracat iletisim contact office ofis destek support muhasebe accounting marketing pazarlama " +
    "order siparis teklif offer kalite quality ik hr genel mail admin webmaster purchasing satinalma planlama uretim production " +
    "teknik technical service servis customer musteri ticaret trade foreign international dt dis isg kurumsal corporate hello " +
    "finance finans fabrika factory merkez center lojistik logistics arge rd"
  ).split(" "),
);

/** Words of legal names that say nothing about which firm it is. */
const NAME_STOP = new Set(
  "san sanayi tic ticaret ltd limited sti sirketi anonim ith ihr ihracat ithalat dis ve ins insaat imalat mak makina makine paz pazarlama ltdsti tekstil metal".split(" "),
);

/** The words that make a firm's name in its mailboxes: its legal name and its website's name. */
export function firmTokens(legalName: string, website: string | null): string[] {
  const tokens = new Set(fold(legalName).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !NAME_STOP.has(t)));
  if (website) {
    const host = fold(website).replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/:?#]/)[0] ?? "";
    const label = host.split(".")[0];
    if (label && label.length >= 3) tokens.add(label.replace(/[^a-z0-9]/g, ""));
  }
  return [...tokens].filter(Boolean);
}

/** Whether a mailbox is a role ("info@", "satis2@", "dis.ticaret@") or carries the firm's name. */
export function isRoleOrFirmMailbox(address: string, tokens: readonly string[]): boolean {
  const local = fold(address.slice(0, address.indexOf("@")));
  const segments = local.split(/[._-]+/).map((s) => s.replace(/\d+$/, "")).filter(Boolean);
  if (segments.some((s) => ROLE_WORDS.has(s))) return true;
  const compact = local.replace(/[^a-z0-9]/g, "");
  // Only the firm's word inside the mailbox: "ali@" is not "alimar"'s.
  return tokens.some((t) => compact.includes(t));
}

const COMPANY_FORM = /(?:^| )(?:a s|as|anonim|ltd|limited|sti|koop\w*|kollektif|komandit|inc|gmbh|llc)(?: |$)/;

/** Whether a legal name says its company form (A.Ş., Ltd. Şti., kooperatif...). */
export function hasCompanyForm(legalName: string): boolean {
  return COMPANY_FORM.test(` ${fold(legalName).replace(/[^a-z0-9]+/g, " ").trim()} `);
}

const URL_COLUMNS: PoolColumn[] = [
  "Kimlik kaynağı (URL)",
  "Sertifika kaynağı (URL)",
  "NCAGE kaynağı (URL)",
  "Savunma deneyimi kaynağı (URL)",
  "İhracat kaynağı (URL)",
  "Web sitesi",
  "Üretim kanıtı bağlantısı",
  "İlk kayıt kaynakları",
];

/** Identifiers are not phone numbers: a VKN may start with 5. */
const ID_FIELDS = new Set<string>(["Firma ID", "VKN", "MERSİS no"]);

type SourceRow = Record<(typeof SOURCE_COLUMNS)[number], string | null>;

function guard(row: PoolRow, sources: readonly SourceRow[]): { rejected: Finding<RejectRule>[]; review: Finding<ReviewRule>[] } {
  const id = row["Firma ID"];
  const rejected: Finding<RejectRule>[] = [];
  const review: Finding<ReviewRule>[] = [];
  const reject = (place: string, rule: RejectRule) => {
    if (!rejected.some((f) => f.place === place && f.rule === rule)) rejected.push({ manufacturerId: id, place, rule });
  };
  const flag = (place: string, rule: ReviewRule) => {
    if (!review.some((f) => f.place === place && f.rule === rule)) review.push({ manufacturerId: id, place, rule });
  };
  const tokens = firmTokens(row["Tüzel kişi unvanı"], row["Web sitesi"]);
  const scan = (place: string, value: string | null, field: string) => {
    if (!value) return;
    if (hasFreeMail(value)) reject(place, "free_mail");
    if (!ID_FIELDS.has(field) && hasMobileNumber(value)) reject(place, "mobile_number");
    if (hasTckn(value)) reject(place, "tckn");
    if (hasPersonLink(value)) reject(place, "person_link");
    if (emailsIn(value).some((a) => !isFreeMailDomain(a.slice(a.indexOf("@") + 1)) && !isRoleOrFirmMailbox(a, tokens))) flag(place, "personal_mailbox");
  };

  for (const column of POOL_COLUMNS) {
    const value = row[column];
    if (typeof value === "string") scan(column, value, column);
  }
  for (const s of sources) {
    const place = `${SOURCE_PLACE}${s.Alan}`;
    scan(place, s["Güncel değer"], s.Alan ?? "");
    for (const column of ["Kaynak (URL)", "Açıklama", "Önceki kaynaklar (URL)"] as const) scan(place, s[column], column);
  }

  const sole = row["Şahıs işletmesi (Evet/Hayır)"];
  if (sole === "Evet") {
    if (row.VKN) reject("VKN", "sole_proprietor_id");
    if (row["MERSİS no"]) reject("MERSİS no", "sole_proprietor_id");
    for (const column of URL_COLUMNS) if (row[column]) flag(column, "sole_proprietor_link");
    for (const s of sources) if (s["Kaynak (URL)"] || s["Önceki kaynaklar (URL)"]) flag(`${SOURCE_PLACE}${s.Alan}`, "sole_proprietor_link");
  } else {
    if (sole === null) flag("Şahıs işletmesi (Evet/Hayır)", "sole_proprietor_unknown");
    if (!hasCompanyForm(row["Tüzel kişi unvanı"])) flag("Tüzel kişi unvanı", "no_company_form");
  }
  return { rejected, review };
}

// ---------------------------------------------------------------------------------------------------
// Rows to records

const ADDRESS_KINDS = { Fabrika: "factory", "Merkez ofis": "head_office", Şube: "branch", Bilinmiyor: "unknown" } as const;
const KINDS = { Üretici: "producer", "Üretici ve ticaret": "producer_trader" } as const;
const TRI = { Evet: "yes", Hayır: "no", Bilinmiyor: "unknown" } as const;
const AQAP = { "2110": "2110", "2120": "2120", Yok: "none", Bilinmiyor: "unknown" } as const;
const FIT = { Orta: "medium", Düşük: "low" } as const;
const CONTACT_STATES = new Map<string, ContactState>(Object.entries(CONTACT_STATE_LABELS).map(([code, label]) => [label, code as ContactState]));

const isProductCategory = (code: string): code is ProductCategory => Object.hasOwn(PRODUCT_CATEGORIES, code);

/** "Kaynakta yayımlanan il/ilçe: Ankara / Yenimahalle" in the notes: where a directory places the firm. */
const DIRECTORY_PLACE = /Kaynakta yayımlanan il\/ilçe:\s*([^.;\n]+)/u;

type Mapped = { manufacturer: PreparedManufacturer; certifications: PreparedCertification[]; notes: string[] };

function toRecords(row: PoolRow, version: string, problems: string[]): Mapped {
  const id = row["Firma ID"];
  const problem = (column: PoolColumn, what: string) => problems.push(`${id}: "${column}" ${what}.`);
  const notes: string[] = [];

  const categories: ProductCategory[] = [];
  for (const code of splitList(row["Bozkor kategorileri"])) {
    if (isProductCategory(code)) categories.push(code);
    else problem("Bozkor kategorileri", `bilinmeyen kod ("${code}")`);
  }
  const families: FamilyCode[] = [];
  for (const code of splitList(row["Ürün ailesi kodları"])) {
    if (isFamilyCode(code)) families.push(code);
    else problem("Ürün ailesi kodları", `bilinmeyen kod ("${code}")`);
  }
  const exportCountries: string[] = [];
  for (const token of splitList(row["İhracat ülkeleri"])) {
    const code = countryCode(token);
    if (!code) problem("İhracat ülkeleri", `ülke tanınmadı ("${token}")`);
    else if (!exportCountries.includes(code)) exportCountries.push(code);
  }
  const emails = splitList(row["Genel e-posta"]);
  if (emails.some((e) => !/^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/.test(e))) problem("Genel e-posta", "biçimi geçersiz");
  const phones = splitList(row["Genel telefon"]);
  if (phones.some((p) => !/^\+?[\d\s().-]{7,20}$/.test(p) || p.replace(/\D/g, "").length < 7)) problem("Genel telefon", "biçimi geçersiz");

  const vkn = row.VKN;
  if (vkn && !isValidVkn(vkn)) problem("VKN", "sağlama hanesini tutmuyor");
  const mersis = row["MERSİS no"];
  if (vkn && mersis && mersis.slice(1, 11) !== vkn) problem("MERSİS no", "VKN'yi içermiyor");

  const provinces = splitList(row["Fabrika il"]);
  if (provinces.length > 1) notes.push(`Fabrika il'de ${provinces.length} il var; ilki alındı.`);
  let province = provinces[0] ?? null;
  let district = row["Fabrika ilçe"];
  const addressKind = ADDRESS_KINDS[row["Adres türü (Fabrika/Merkez ofis/Şube/Bilinmiyor)"]];
  let provinceBasis: PreparedManufacturer["provinceBasis"] = province ? (addressKind === "factory" ? "factory" : "company") : "unknown";
  if (!province) {
    const listed = DIRECTORY_PLACE.exec(row.Notlar ?? "");
    if (listed) {
      const [p, d] = listed[1]!.split("/").map((s) => s.trim());
      province = p || null;
      district ??= d || null;
      if (province) provinceBasis = "directory";
    }
  }

  const certSources = splitList(row["Sertifika kaynağı (URL)"]);
  if (certSources.length > 1) notes.push("Sertifika kaynağında birden çok bağlantı var; belgelere tek tek bağlanmadı.");
  const parsed = parseCertifications(row.Sertifikalar);
  for (const p of parsed.problems) problem("Sertifikalar", p);

  const contactLabel = row["İletişim durumu"];
  const contactState = contactLabel === null ? "not_contacted" : CONTACT_STATES.get(contactLabel);
  if (!contactState) problem("İletişim durumu", `bilinmeyen durum ("${contactLabel}")`);

  const sole = row["Şahıs işletmesi (Evet/Hayır)"];
  const fit = row["İhale uygunluğu (Yüksek/Orta/Düşük)"];
  const manufacturer: PreparedManufacturer = {
    id,
    legalName: row["Tüzel kişi unvanı"],
    branchName: row["Şube / tesis adı"],
    soleProprietor: sole === null ? null : sole === "Evet",
    vkn,
    mersis,
    identityUrl: row["Kimlik kaynağı (URL)"],
    province,
    district,
    address: row["Fabrika adresi"],
    addressKind,
    provinceBasis,
    osbZones: splitList(row["OSB / bölge"]),
    kind: KINDS[row["Tür (Üretici/Üretici ve ticaret)"]],
    categories,
    families,
    products: splitList(row["Kendi üretimi ürünler"]),
    materials: splitList(row.Malzemeler),
    standards: splitList(row["Uyguladığı standartlar"]),
    sizeRange: row["Ölçü ya da güç aralığı"],
    productionMethod: row["Üretim biçimi"],
    certificationsText: row.Sertifikalar,
    certificationsUrl: row["Sertifika kaynağı (URL)"],
    aqap: AQAP[row["AQAP (2110/2120/Yok/Bilinmiyor)"]],
    as9100: TRI[row["AS9100 (Evet/Hayır/Bilinmiyor)"]],
    ncage: row["NCAGE kodu"],
    ncageUrl: row["NCAGE kaynağı (URL)"],
    defenseExperience: row["Savunma deneyimi"],
    defenseUrl: row["Savunma deneyimi kaynağı (URL)"],
    facilitySecurity: TRI[row["Tesis Güvenlik Belgesi (Evet/Bilinmiyor)"]],
    exports: TRI[row["İhracat (Evet/Hayır/Bilinmiyor)"]],
    exportCountries,
    exportUrl: row["İhracat kaynağı (URL)"],
    fitLevel: fit === null ? null : FIT[fit],
    fitNote: row["Uygunluk notu"],
    emails,
    phones,
    website: row["Web sitesi"],
    evidenceKind: row["Kanıt kaynağı türü"],
    evidenceUrl: row["Üretim kanıtı bağlantısı"],
    evidenceLocation: row["Kanıtın sayfa konumu"],
    evidenceQuote: row["Kanıttan kısa alıntı"],
    identityMatch: row["Şirket / kaynak eşleşmesi"],
    firstSources: row["İlk kayıt kaynakları"],
    contactState: contactState ?? "not_contacted",
    moq: row["MOQ ve birim"],
    leadTimeDays: row["Termin (gün)"],
    notes: row.Notlar,
    checkedOn: row["Kontrol tarihi"],
    poolVersion: version,
  };
  const certifications = parsed.certifications.map((c) => ({
    manufacturerId: id,
    name: c.name,
    kind: c.kind,
    validUntil: c.validUntil,
    note: c.note,
    sourceUrl: certSources.length === 1 ? certSources[0]! : null,
  }));
  return { manufacturer, certifications, notes };
}

function issueText(label: string, row: Record<string, unknown>, issue: z.core.$ZodIssue): string {
  const column = String(issue.path[0] ?? "");
  const value = row[column];
  const quoted = QUOTABLE.has(column) && (typeof value === "string" || typeof value === "number") ? ` ("${value}")` : "";
  const reason =
    value === null || value === undefined ? "boş olamaz" : issue.code === "invalid_value" ? "izin verilmeyen değer" : issue.code === "invalid_format" ? "biçimi geçersiz" : "geçersiz";
  return `${label}: "${column}" ${reason}${quoted}.`;
}

// ---------------------------------------------------------------------------------------------------
// The whole package

/** Reads, checks and maps a pool package. Errors stop the import; KVKK findings only leave firms out. */
export function prepareImport(input: PackageInput): PrepareResult {
  const errors: string[] = [];
  const version = input.version.trim();
  if (!/^\d+(?:\.\d+)*$/.test(version)) errors.push(`Sürüm "${input.version}" geçersiz; örnek: 2.3.`);

  const sums = parseSha256Sums(input.sha256Sums);
  const poolSha256 = sha256Hex(input.pool.bytes);
  const sourcesSha256 = sha256Hex(input.sources.bytes);
  for (const [file, sha] of [
    [input.pool, poolSha256],
    [input.sources, sourcesSha256],
  ] as const) {
    const expected = sums.get(file.name);
    if (!expected) errors.push(`SHA256SUMS'ta ${file.name} yok.`);
    else if (expected !== sha) errors.push(`${file.name}: SHA-256 özeti SHA256SUMS'takiyle aynı değil (dosya değişmiş ya da eksik).`);
  }

  const poolText = decode(input.pool, errors);
  const sourcesText = decode(input.sources, errors);
  if (poolText === null || sourcesText === null) return { ok: false, errors, rejected: [], review: [] };

  // Pool rows: one JSON object per line, exactly the 48 columns.
  const rawRows: Record<string, unknown>[] = [];
  poolText.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) rawRows.push(value as Record<string, unknown>);
      else errors.push(`${input.pool.name} satır ${i + 1}: JSON nesnesi değil.`);
    } catch {
      errors.push(`${input.pool.name} satır ${i + 1}: JSON okunamadı.`);
    }
  });
  const expected = new Set<string>(POOL_COLUMNS);
  const missing = new Map<string, number>();
  const extra = new Map<string, number>();
  for (const raw of rawRows) {
    for (const c of POOL_COLUMNS) if (!Object.hasOwn(raw, c)) missing.set(c, (missing.get(c) ?? 0) + 1);
    for (const c of Object.keys(raw)) if (!expected.has(c)) extra.set(c, (extra.get(c) ?? 0) + 1);
  }
  for (const [c, n] of missing) errors.push(`Havuzda "${c}" sütunu yok (${n} satır).`);
  for (const [c, n] of extra) errors.push(`Havuzda bilinmeyen sütun "${c}" (${n} satır).`);
  if (!rawRows.length) errors.push("Havuzda firma yok.");
  if (missing.size || extra.size) return { ok: false, errors, rejected: [], review: [] };

  const rows: PoolRow[] = [];
  // Every well-formed ID in the pool, valid row or not: a firm whose row has an error is reported once,
  // not again for each of its source rows.
  const known = new Set<string>();
  rawRows.forEach((raw, i) => {
    const cleaned = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, clean(v)]));
    const rawId = cleaned["Firma ID"];
    const id = typeof rawId === "string" && /^BZ-[0-9A-F]{12}$/.test(rawId) ? rawId : null;
    if (id) {
      if (known.has(id)) errors.push(`${id}: "Firma ID" iki kez var.`);
      known.add(id);
    }
    const parsed = poolRowSchema.safeParse(cleaned);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) errors.push(issueText(id ?? `Havuz satır ${i + 1}`, cleaned, issue));
      return;
    }
    rows.push(parsed.data);
  });

  // Field sources: the CSV's header, one row per firm and field.
  const table = parseCsv(sourcesText);
  const header = table[0] ?? [];
  if (header.join("\u0001") !== SOURCE_COLUMNS.join("\u0001")) {
    errors.push(`${input.sources.name}: başlık satırı beklenen değil (beklenen: ${SOURCE_COLUMNS.join(", ")}).`);
    return { ok: false, errors, rejected: [], review: [] };
  }
  const sourcesByFirm = new Map<string, SourceRow[]>();
  const fields = new Set<string>(POOL_COLUMNS);
  const pairs = new Set<string>();
  let sourceRows = 0;
  table.slice(1).forEach((cells, i) => {
    if (cells.length === 1 && cells[0] === "") return;
    sourceRows++;
    const line = i + 2;
    if (cells.length !== SOURCE_COLUMNS.length) {
      errors.push(`${input.sources.name} satır ${line}: ${cells.length} alan var, ${SOURCE_COLUMNS.length} olmalı.`);
      return;
    }
    const row = Object.fromEntries(SOURCE_COLUMNS.map((c, j) => [c, clean(cells[j]) as string | null])) as SourceRow;
    const firm = row["Firma ID"] ?? "";
    const where = `${input.sources.name} satır ${line} (${firm || "kimliksiz"})`;
    if (!known.has(firm)) errors.push(`${where}: firma havuzda yok.`);
    else if (!row.Alan || !fields.has(row.Alan)) errors.push(`${where}: "Alan" havuzun bir sütunu değil.`);
    else if (pairs.has(`${firm}\u0001${row.Alan}`)) errors.push(`${where}: "${row.Alan}" için ikinci kaynak satırı.`);
    else if (!row["Doğrulama türü"]) errors.push(`${where}: "Doğrulama türü" boş.`);
    else if (row["Kontrol tarihi"] && !(/^\d{4}-\d{2}-\d{2}$/.test(row["Kontrol tarihi"]) && isRealDate(row["Kontrol tarihi"]))) errors.push(`${where}: "Kontrol tarihi" biçimi geçersiz ("${row["Kontrol tarihi"]}").`);
    else {
      pairs.add(`${firm}\u0001${row.Alan}`);
      sourcesByFirm.set(firm, [...(sourcesByFirm.get(firm) ?? []), row]);
    }
  });

  const manufacturers: PreparedManufacturer[] = [];
  const certifications: PreparedCertification[] = [];
  const sources: PreparedSource[] = [];
  const rejected: Finding<RejectRule>[] = [];
  const review: Finding<ReviewRule>[] = [];
  const notes: ImportPlan["notes"] = [];
  for (const row of rows) {
    const id = row["Firma ID"];
    const firmSources = sourcesByFirm.get(id) ?? [];
    const mapped = toRecords(row, version, errors);
    const found = guard(row, firmSources);
    rejected.push(...found.rejected);
    review.push(...found.review);
    if (found.rejected.length) continue;
    manufacturers.push(mapped.manufacturer);
    certifications.push(...mapped.certifications);
    notes.push(...mapped.notes.map((text) => ({ manufacturerId: id, text })));
    for (const s of firmSources) {
      sources.push({
        manufacturerId: id,
        field: s.Alan!,
        value: s["Güncel değer"],
        sourceUrl: s["Kaynak (URL)"],
        verification: s["Doğrulama türü"]!,
        note: s.Açıklama,
        previousSources: s["Önceki kaynaklar (URL)"],
        checkedOn: s["Kontrol tarihi"],
      });
    }
  }
  if (rows.length && !manufacturers.length) errors.push("KVKK bekçisinden sonra yüklenecek firma kalmadı.");

  if (errors.length) return { ok: false, errors, rejected, review };
  return {
    ok: true,
    plan: { version, poolSha256, sourcesSha256, poolRows: rawRows.length, sourceRows, manufacturers, certifications, sources, rejected, review, notes },
  };
}

// ---------------------------------------------------------------------------------------------------
// The command's report

/**
 * Findings as the command prints them, a line per firm and rule: "BZ-...: kural: Genel e-posta, alan
 * kaynakları (Genel e-posta)". More than three source rows are counted, not listed. Never a value.
 */
export function findingLines(findings: readonly Finding[]): string[] {
  const groups = new Map<string, { id: string; rule: RejectRule | ReviewRule; pool: string[]; sources: string[] }>();
  for (const f of findings) {
    const key = `${f.manufacturerId}\u0001${f.rule}`;
    const group = groups.get(key) ?? { id: f.manufacturerId, rule: f.rule, pool: [], sources: [] };
    if (f.place.startsWith(SOURCE_PLACE)) group.sources.push(f.place.slice(SOURCE_PLACE.length));
    else group.pool.push(f.place);
    groups.set(key, group);
  }
  return [...groups.values()].map((g) => {
    const places = [...g.pool];
    if (g.sources.length) places.push(g.sources.length <= 3 ? `alan kaynakları (${g.sources.join(", ")})` : `${g.sources.length} alan kaynağı satırı`);
    return `${g.id}: ${RULE_LABELS[g.rule]}: ${places.join(", ")}`;
  });
}
