const ALIASES: Record<string, string> = {
  uk: "GB",
  "great britain": "GB",
  britain: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  turkey: "TR",
};

// Region codes that Intl knows but that are not countries.
const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "QO", "ZZ"]);

/** Deprecated codes map to their successor, e.g. DD -> DE, UK -> GB. */
function canonicalRegion(code: string): string | null {
  try {
    return new Intl.Locale(`und-${code}`).region ?? null;
  } catch {
    return null;
  }
}

function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

let byName: Map<string, string> | null = null;

function nameIndex(): Map<string, string> {
  if (byName) return byName;
  const names = new Intl.DisplayNames(["en"], { type: "region" });
  const index = new Map<string, string>();
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code)) continue;
      let name: string | undefined;
      try {
        name = names.of(code);
      } catch {
        continue;
      }
      if (!name || name === code) continue;
      const canonical = canonicalRegion(code);
      if (!canonical || NOT_COUNTRIES.has(canonical)) continue;
      const key = normalizeName(name);
      if (!index.has(key)) index.set(key, canonical);
    }
  }
  byName = index;
  return index;
}

/** English country name to ISO 3166 alpha-2, e.g. "United Kingdom" -> "GB". */
export function countryNameToAlpha2(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = normalizeName(name);
  if (!key) return null;
  return ALIASES[key] ?? nameIndex().get(key) ?? null;
}

/** Accepts an alpha-2 code in any case; returns it uppercased or null if malformed. */
export function normalizeAlpha2(code: string | null | undefined): string | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  if (upper === "UK") return "GB";
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

let countryCodes: Set<string> | null = null;

/** Whether `code` is a canonical ISO 3166 alpha-2 country code: "GB" is, "UK", "EU" and "EN" are not. */
export function isCountryCode(code: string): boolean {
  countryCodes ??= new Set(nameIndex().values());
  return countryCodes.has(code);
}
