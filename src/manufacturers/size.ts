// Power and thread sizes for the manufacturer matcher (SPEC 10, 8.2): what a notice asks for ("6 kW",
// "12,5 kVa", "M12x50") and the range a manufacturer publishes ("Dizel setler: 18-1100 kVA",
// "Somun M5-M72;Cıvata M8-M20"). Numbers and units read alike in every language, so the original text
// serves. A size never drops a candidate; it only says whether the range fits. Pure.

export type SizeKind = "power" | "thread";

/** kVA = kW / 0.8: the power factor of a standard generating set. An assumption, said so on the page. */
export const POWER_FACTOR = 0.8;

/** A size in the matcher's units: kVA for power, the nominal diameter in mm for a metric thread. */
export type SizeRange = { kind: SizeKind; low: number; high: number };

/** What a lot asks for, and whether a kW figure was turned into kVA. */
export type LotSize = SizeRange & { fromKw: boolean };

/** "12,5" and "5.5" as decimals, "1.100" and "1,500" as thousands. */
export function parseNumber(text: string): number {
  if (/^\d{1,3}([.,]\d{3})+$/.test(text)) return Number(text.replace(/[.,]/g, ""));
  return Number(text.replace(",", "."));
}

const NUMBER = String.raw`\d+(?:[.,]\d+)?`;
// Case matters for M only: MW is mega, mW milli (no generator). "kWh" is energy, not power.
const POWER_UNIT = String.raw`([kK][vV][aA]|[kK][wW]|MVA|MW)(?![a-zA-Z])`;
const POWER_RANGE = new RegExp(String.raw`(${NUMBER})\s*(?:-|–|to|ila|ile)\s*(${NUMBER})\s*${POWER_UNIT}`, "g");
const POWER_POINT = new RegExp(String.raw`(${NUMBER})\s*${POWER_UNIT}`, "g");
// "M6x10-M12x100" and "M2.5-M12" as ranges, "M12" or "M12x50" as a point; upper-case M only (m2 is an area).
const THREAD_RANGE = new RegExp(String.raw`\bM(${NUMBER})(?:\s*[x×]\s*${NUMBER})?\s*(?:-|–)\s*M(${NUMBER})`, "g");
const THREAD_POINT = new RegExp(String.raw`\bM(${NUMBER})`, "g");

/** A power value in kVA: MW and MVA scale by a thousand, kW and MW divide by the power factor. */
function toKva(value: number, unit: string): { kva: number; fromKw: boolean } {
  const scaled = unit.startsWith("M") ? value * 1000 : value;
  const fromKw = /w$/i.test(unit);
  return { kva: fromKw ? scaled / POWER_FACTOR : scaled, fromKw };
}

type Reading = { low: number; high: number; fromKw: boolean };

function readPower(text: string): Reading[] {
  const out: Reading[] = [];
  const ranged = text.replace(POWER_RANGE, (_all, a: string, b: string, unit: string) => {
    const low = toKva(parseNumber(a), unit);
    const high = toKva(parseNumber(b), unit);
    out.push({ low: Math.min(low.kva, high.kva), high: Math.max(low.kva, high.kva), fromKw: low.fromKw });
    return " ";
  });
  for (const m of ranged.matchAll(POWER_POINT)) {
    const { kva, fromKw } = toKva(parseNumber(m[1]!), m[2]!);
    out.push({ low: kva, high: kva, fromKw });
  }
  return out.filter((r) => Number.isFinite(r.low) && Number.isFinite(r.high) && r.high > 0);
}

function readThread(text: string): Reading[] {
  const out: Reading[] = [];
  const ranged = text.replace(THREAD_RANGE, (_all, a: string, b: string) => {
    const low = parseNumber(a);
    const high = parseNumber(b);
    out.push({ low: Math.min(low, high), high: Math.max(low, high), fromKw: false });
    return " ";
  });
  for (const m of ranged.matchAll(THREAD_POINT)) {
    const value = parseNumber(m[1]!);
    out.push({ low: value, high: value, fromKw: false });
  }
  return out.filter((r) => Number.isFinite(r.low) && r.high > 0);
}

const READERS: Record<SizeKind, (text: string) => Reading[]> = { power: readPower, thread: readThread };
const KINDS: readonly SizeKind[] = ["power", "thread"];

/** Everything the readings cover, from the smallest to the largest value. */
function envelope(readings: readonly Reading[]): Reading | null {
  if (!readings.length) return null;
  return {
    low: Math.min(...readings.map((r) => r.low)),
    high: Math.max(...readings.map((r) => r.high)),
    fromKw: readings.some((r) => r.fromKw),
  };
}

/** The sizes a lot's text asks for, one per kind (from the smallest to the largest it names). */
export function lotSizes(text: string): LotSize[] {
  return KINDS.flatMap((kind) => {
    const e = envelope(READERS[kind](text));
    return e ? [{ kind, low: e.low, high: e.high, fromKw: e.fromKw }] : [];
  });
}

/**
 * The range a manufacturer publishes for a kind, from all the figures it gives: "Endüstriyel: 10-3300 kVA;
 * Portatif: 1-12 kVA" as 1-3300, "KD13 13 kVA;KD1500 1500 kVA" as 13-1500. Null when it gives none.
 */
export function publishedRange(text: string | null, kind: SizeKind): SizeRange | null {
  if (!text) return null;
  const e = envelope(READERS[kind](text));
  return e ? { kind, low: e.low, high: e.high } : null;
}

export type SizeFit = "in" | "out" | "unknown";

/** Whether what the lot asks for overlaps what the manufacturer makes. */
export function sizeFit(lot: SizeRange, range: SizeRange | null): SizeFit {
  if (!range) return "unknown";
  return lot.low <= range.high && lot.high >= range.low ? "in" : "out";
}

const numberFormat = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

/** "7,5 kVA", "3-16 kVA", "M12", "M6-M30". */
export function formatSize(size: SizeRange): string {
  const value = (n: number) => numberFormat.format(n);
  if (size.kind === "thread") return size.low === size.high ? `M${value(size.low)}` : `M${value(size.low)}-M${value(size.high)}`;
  return size.low === size.high ? `${value(size.low)} kVA` : `${value(size.low)}-${value(size.high)} kVA`;
}
