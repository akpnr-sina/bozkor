import { toZonedLocal } from "@/lib/time";

// BOZKOR Tender Scoring Rubric V2 (docs/scoring-rubric-v2.md): section 4's
// 32 weighted metrics and section 5's evidence-aware score interval. Pure;
// shared by every stage that rates a tender (notice triage now, documents,
// suppliers and the cash model later). The rubric's policy rules are the
// caller's job: D1 comes only from the cash model, E1-E3 stay MISSING without
// verified costs, BID_REVIEW needs 80% verified weight and a lower bound of 85.

export const RUBRIC_GROUPS = {
  A: "Ürün ve üretici uyumu",
  B: "Teknik ve yeterlilik uyumu",
  C: "Sözleşme ifası",
  D: "Likidite ve finans",
  E: "Birim ekonomisi ve katkı",
  F: "Lojistik ve gümrük",
  G: "Son tarih ve teslim hazırlığı",
  H: "Rekabet ve teklif eforu",
} as const;
export type RubricGroup = keyof typeof RUBRIC_GROUPS;

export const RUBRIC_METRICS = [
  { id: "A1", group: "A", weight: 5, label: "Tam ürün uyumu" },
  { id: "A2", group: "A", weight: 4, label: "Üretici kanıtı" },
  { id: "A3", group: "A", weight: 3, label: "Kapasite ve teslim süresi" },
  { id: "A4", group: "A", weight: 3, label: "Kaynak dayanıklılığı" },
  { id: "B1", group: "B", weight: 5, label: "Şartname satır matrisi" },
  { id: "B2", group: "B", weight: 4, label: "Mevzuat ve test" },
  { id: "B3", group: "B", weight: 4, label: "Şirket yeterliliği" },
  { id: "B4", group: "B", weight: 2, label: "Dokümantasyon izlenebilirliği" },
  { id: "C1", group: "C", weight: 4, label: "Yerel teknik servis" },
  { id: "C2", group: "C", weight: 4, label: "Kurulum ve devreye alma" },
  { id: "C3", group: "C", weight: 4, label: "Garanti ve yedek parça" },
  { id: "C4", group: "C", weight: 3, label: "Sipariş (call-off) düzeni" },
  { id: "D1", group: "D", weight: 9, label: "Stres nakit karşılama" },
  { id: "D2", group: "D", weight: 4, label: "Fon kanıtı" },
  { id: "D3", group: "D", weight: 4, label: "Ödeme ve tahsilat" },
  { id: "D4", group: "D", weight: 3, label: "Teminat ve rezerv" },
  { id: "E1", group: "E", weight: 6, label: "Baz katkı marjı" },
  { id: "E2", group: "E", weight: 3, label: "Stres katkı marjı" },
  { id: "E3", group: "E", weight: 3, label: "Mutlak katkı" },
  { id: "E4", group: "E", weight: 3, label: "Sipariş kesinliği" },
  { id: "F1", group: "F", weight: 4, label: "Teslim dahil toplam maliyet" },
  { id: "F2", group: "F", weight: 3, label: "Teslimat tamponu" },
  { id: "F3", group: "F", weight: 2, label: "Sahada elleçleme ve teslim alma" },
  { id: "F4", group: "F", weight: 1, label: "Menşe ve ithalat belgesi" },
  { id: "G1", group: "G", weight: 2, label: "Teklif penceresi" },
  { id: "G2", group: "G", weight: 1, label: "Üretim ve teslim planı" },
  { id: "G3", group: "G", weight: 1, label: "Numune ve teklif dili" },
  { id: "G4", group: "G", weight: 1, label: "Saha ziyareti ve sorular" },
  { id: "H1", group: "H", weight: 2, label: "Rekabet avantajı" },
  { id: "H2", group: "H", weight: 1, label: "Değerlendirme kriterine uyum" },
  { id: "H3", group: "H", weight: 1, label: "Teklif maliyetinin getirisi" },
  { id: "H4", group: "H", weight: 1, label: "Rakip ve emsal bilgisi" },
] as const satisfies readonly { id: string; group: RubricGroup; weight: number; label: string }[];

export type RubricMetricId = (typeof RUBRIC_METRICS)[number]["id"];

export const RUBRIC_METRIC_BY_ID = Object.fromEntries(RUBRIC_METRICS.map((m) => [m.id, m])) as Record<
  RubricMetricId,
  (typeof RUBRIC_METRICS)[number]
>;

/** Section 5 evidence states. */
export type RubricQuality = "VERIFIED" | "PROVISIONAL" | "MISSING" | "CONFLICT";

export type RubricEntry = { rating: number | null; quality: RubricQuality };

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Section 5: each metric's rating becomes an interval by its evidence
 * (VERIFIED [r, r], PROVISIONAL [r-1.5, r+1.5] within 0-5, anything unknown
 * [0, 5]) and S = sum of weight x bound / 5. The interval and the evidence
 * coverage are shown together; the midpoint is never a GO score.
 */
export function rubricInterval(entries: Partial<Record<RubricMetricId, RubricEntry>>): {
  lower: number;
  upper: number;
  verifiedWeightPct: number;
  assessedWeightPct: number;
} {
  let lower = 0;
  let upper = 0;
  let verified = 0;
  let assessed = 0;
  for (const { id, weight } of RUBRIC_METRICS) {
    const entry = entries[id];
    // A rating outside the scale counts as unknown rather than skewing the sum.
    const raw = entry?.rating;
    const rating = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 5 ? raw : null;
    let low = 0;
    let high = 5;
    if (rating !== null && entry?.quality === "VERIFIED") {
      low = high = rating;
      verified += weight;
      assessed += weight;
    } else if (rating !== null && entry?.quality === "PROVISIONAL") {
      low = Math.max(0, rating - 1.5);
      high = Math.min(5, rating + 1.5);
      assessed += weight;
    }
    lower += (weight * low) / 5;
    upper += (weight * high) / 5;
  }
  return { lower: round1(lower), upper: round1(upper), verifiedWeightPct: verified, assessedWeightPct: assessed };
}

const TIMEZONE = "Europe/Istanbul";
const DAY_MS = 24 * 60 * 60_000;

/** Istanbul calendar day of an instant, as a UTC midnight timestamp for day arithmetic. */
function istanbulDay(instant: Date): number {
  return Date.parse(`${toZonedLocal(instant, TIMEZONE).slice(0, 10)}T00:00:00Z`);
}

/**
 * G1, the bid window, computed from the deadline (CLAUDE.md rule 3): weekdays
 * from tomorrow up to the deadline's day, Istanbul calendar, no holidays (the
 * rubric's own simplification). 5 or fewer score 1, 6-10 score 2, 11-20 score
 * 3, 21-35 score 4, more score 5. A passed deadline scores 0.
 */
export function bidWindow(deadline: Date | null, now: Date): { workingDays: number | null; rating: number | null } {
  if (!deadline) return { workingDays: null, rating: null };
  if (deadline.getTime() <= now.getTime()) return { workingDays: 0, rating: 0 };
  // A deadline at 23:59 in the UK or Brussels falls just after midnight in
  // Istanbul; that last day leaves no time to work, so it does not count.
  const earlyMorning = Number(toZonedLocal(deadline, TIMEZONE).slice(11, 13)) < 6;
  const last = istanbulDay(deadline) - (earlyMorning ? DAY_MS : 0);
  let workingDays = 0;
  for (let day = istanbulDay(now) + DAY_MS; day <= last; day += DAY_MS) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) workingDays++;
  }
  const rating = workingDays <= 5 ? 1 : workingDays <= 10 ? 2 : workingDays <= 20 ? 3 : workingDays <= 35 ? 4 : 5;
  return { workingDays, rating };
}
