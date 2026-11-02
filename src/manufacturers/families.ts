// Product families of the manufacturer pool (F01-F17) and the hand-kept bridge from CPV codes to them
// (Faz 8 plan, SPEC 10). Peer 63 drafted the prefixes from the CPV 2008 catalogue on 2 November 2026 and
// the lead trimmed them after measuring open tenders; the user approves changes. A lot's family comes from
// its CPV codes; the matcher still requires a product word to name a manufacturer (a family alone never
// makes a candidate).
//
// Prefixes are catalogue prefixes (trailing zeros dropped, see cpvPrefixOf). "?" marks a code the draft
// was unsure of; each of those has at least one manufacturer in pool v2.3. Left out on purpose:
// 349138 (ship anchors, not wall anchors), 315 (lighting: the pool has no luminaire maker yet),
// 3121 (switching devices pulled 22 electrical lots into F16 in the 2 November measurement),
// 3314142 (surgical gloves are medical), and codes no pool firm makes (hoses 44165, hand tools 4451).

export const FAMILIES = {
  F01: { label: "Bağlantı elemanları", prefixes: ["4453", "441922", "44316" /* ? */, "44523" /* ? */] },
  F02: { label: "Conta, kauçuk ve sızdırmazlık", prefixes: ["44425", "343125", "1951", "3936" /* ? */] },
  F03: { label: "Talaşlı imalat, kalıp ve döküm", prefixes: ["4447", "43415", "4214", "3473", "4267" /* ? */] },
  F04: {
    label: "Sac, metal ürün ve gövde",
    prefixes: ["44212", "4417", "4433", "44315", "4461", "14715" /* ? */, "312133" /* ? */, "34941" /* ? */],
  },
  F05: { label: "Elektrik, kablo ve aydınlatma", prefixes: ["313", "4432", "312", "3111", "31162", "314"] },
  F06: { label: "Vana, boru, hortum ve hidrolik", prefixes: ["4213", "44163", "44167", "42121", "44615"] },
  F07: { label: "Tekstil, iş giyimi ve branda", prefixes: ["192", "194", "197", "18317", "3953", "1845", "18412" /* ? */] },
  F08: {
    label: "Ambalaj ve plastik parçalar",
    prefixes: ["1952", "1964", "18937", "446171", "229934", "44143", "44618", "392257" /* ? */],
  },
  F09: { label: "El aleti, kesici takım ve kaynak sarfı", prefixes: ["443152", "443151" /* ? */] },
  F10: { label: "Kaldırma, halat ve taşıma", prefixes: ["42417", "42419", "44311" /* ? */, "44317" /* ? */, "42416" /* ? */] },
  F11: {
    label: "Mobilya, raf ve tesis donanımı",
    prefixes: ["3911", "3912", "3914", "391511", "39131", "3917" /* ? */, "44221" /* ? */],
  },
  F12: {
    label: "Pompa, HVAC ve mekanik ekipman",
    prefixes: ["42122", "42124", "4252", "4251", "42913", "4214", "4234" /* ? */, "161" /* ? */],
  },
  F13: { label: "İş kıyafeti ve üniforma", prefixes: ["181", "182", "1833", "351134", "35812", "35111" /* ? */] },
  F14: { label: "Kişisel koruyucu donanım", prefixes: ["1883", "18815", "188122", "18141", "18424", "33735", "18143", "351134"] },
  F15: {
    label: "Çadır, barınak ve prefabrik",
    prefixes: ["44211", "3952253", "441121", "395221", "34221" /* ? */, "44613" /* ? */, "44212" /* ? */],
  },
  F16: { label: "Jeneratör", prefixes: ["3112", "3113", "31161"] },
  F17: {
    label: "Araç, iş ve tarım makinesi yedek parçaları",
    prefixes: ["3432", "3431", "3433", "3435", "34913", "436", "1681", "3542"],
  },
} as const satisfies Record<string, { label: string; prefixes: readonly string[] }>;

export type FamilyCode = keyof typeof FAMILIES;
export const FAMILY_CODES = Object.keys(FAMILIES) as [FamilyCode, ...FamilyCode[]];

export const isFamilyCode = (code: string): code is FamilyCode => Object.hasOwn(FAMILIES, code);

/** A CPV code ("31121000", "31121000-3") as a catalogue prefix ("31121"). */
const prefixOf = (cpv: string): string => cpv.replace(/\D/g, "").slice(0, 8).replace(/0+$/, "");

/**
 * The families a set of CPV codes falls under: a code belongs to a family when it is that prefix or
 * narrower. A broader code ("18000000" for clothing) names no family; it would point at most of them.
 */
export function familiesOfCpvs(cpvs: Iterable<string>): FamilyCode[] {
  const found = new Set<FamilyCode>();
  for (const cpv of cpvs) {
    const prefix = prefixOf(cpv);
    if (prefix.length < 2) continue;
    for (const code of FAMILY_CODES) {
      if (FAMILIES[code].prefixes.some((p) => prefix.startsWith(p))) found.add(code);
    }
  }
  return FAMILY_CODES.filter((code) => found.has(code));
}
