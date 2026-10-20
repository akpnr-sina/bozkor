import type { DeepClaim, DeepOutput } from "@/analysis/deep-schema";
import type { DeepResult, DeepView } from "@/analysis/deep-view";
import { DECISION_LABELS, formatDateTime, lotLabel } from "@/lib/format";

// What the deep analysis card says (SPEC 7.2, section 8): where each claim's
// quote was found (CLAUDE.md rule 5), which fields are shown, and the card's
// words for each state of the request. Pure, so the card only lays them out.

type Sources = Pick<DeepResult, "quoteChecks" | "files">;
type Read = Sources & { output: DeepOutput };

/** A claim's source as the card shows it; `quote` stays in the documents' language. */
export type SourceTag = { verified: true; label: string; quote: string } | { verified: false; label: string; quote: string; why: string };

export const UNVERIFIED = "doğrulanmadı";
export const NOT_IN_DOCUMENTS = "Dokümanlarda yok";

/** "file:3:p12" as "<the third file's name>, sayfa 12", "file:3" as its name, a part of the notice as "ilan metni". */
export function sourceLabel(check: string, files: DeepResult["files"]): string {
  const file = /^file:(\d+)(?::p(\d+))?$/.exec(check);
  if (file) {
    const n = Number(file[1]);
    const name = files.find((f) => f.n === n)?.name ?? `dosya ${n}`;
    return file[2] ? `${name}, sayfa ${file[2]}` : name;
  }
  if (check.startsWith("notice:")) return "ilan metni";
  return check;
}

/** Where the quote of the claim at `path` was found; a claim without a quote, or one not found, is unverified. */
export function sourceTag(sources: Sources, path: string, quote: string): SourceTag {
  const text = quote.trim();
  if (!text) return { verified: false, label: UNVERIFIED, quote: "", why: "Model bu bilgi için alıntı vermedi." };
  const check = sources.quoteChecks[path];
  if (!check) return { verified: false, label: UNVERIFIED, quote: text, why: "Alıntı, analizin okuduğu ilan metninde ve dosyalarda bulunamadı." };
  return { verified: true, label: sourceLabel(check, sources.files), quote: text };
}

// ---------------------------------------------------------------------------
// Fields

type ClaimSection = "delivery" | "eligibility" | "commercial" | "servicesScope" | "timeline";

const FIELDS: { [S in ClaimSection]: readonly (readonly [keyof DeepOutput[S] & string, string])[] } = {
  delivery: [
    ["location", "Teslim yeri"],
    ["country", "Teslim ülkesi"],
    ["incoterm", "Teslim şekli"],
    ["leadTime", "Teslim süresi"],
    ["schedule", "Teslim düzeni"],
  ],
  eligibility: [
    ["minTurnover", "Asgari ciro"],
    ["productOrigin", "Ürün menşei"],
    ["supplierLocation", "Tedarikçinin yeri"],
    ["references", "Referans"],
    ["qualityCerts", "Kalite belgesi"],
    ["insurance", "Sigorta"],
    ["securityRequirements", "Güvenlik şartları"],
    ["localPresence", "Yerel varlık"],
  ],
  commercial: [
    ["contractType", "Sözleşme türü"],
    ["duration", "Süre"],
    ["pricingBasis", "Fiyatlandırma"],
    ["paymentTerms", "Ödeme"],
    ["bonds", "Teminat"],
    ["penalties", "Cezalar"],
    ["warranty", "Garanti"],
  ],
  servicesScope: [
    ["installation", "Kurulum"],
    ["maintenance", "Bakım ve servis"],
    ["training", "Eğitim ve devreye alma"],
  ],
  timeline: [
    ["clarificationDeadline", "Soru sorma son tarihi"],
    ["submissionDeadline", "Teklif son tarihi"],
    ["siteVisit", "Saha ziyareti"],
  ],
};

/**
 * Shown when the documents do not say, as "Dokümanlarda yok": what the team
 * checks first on every tender (SPEC Faz 6: turnover, origin, the deadline).
 * Other empty fields are left out; missingInfo lists what is missing.
 */
const ALWAYS_SHOWN = new Set(["eligibility.minTurnover", "eligibility.productOrigin", "eligibility.supplierLocation", "timeline.submissionDeadline"]);

export type ClaimRow = { path: string; label: string; value: string; empty: boolean; source: SourceTag | null };

/** A section's claims with their sources, empty ones left out (the always shown ones as "Dokümanlarda yok"). */
export function claimRows(read: Read, section: ClaimSection): ClaimRow[] {
  const rows: ClaimRow[] = [];
  const claims = read.output[section] as Record<string, DeepClaim | DeepClaim[]>;
  for (const [key, label] of FIELDS[section]) {
    const path = `${section}.${key}`;
    const value = claims[key];
    if (Array.isArray(value)) {
      value.forEach((claim, i) => {
        if (claim.value.trim()) rows.push({ path: `${path}.${i}`, label, value: claim.value.trim(), empty: false, source: sourceTag(read, `${path}.${i}`, claim.quote) });
      });
    } else if (value?.value.trim()) {
      rows.push({ path, label, value: value.value.trim(), empty: false, source: sourceTag(read, path, value.quote) });
    } else if (ALWAYS_SHOWN.has(path)) {
      rows.push({ path, label, value: NOT_IN_DOCUMENTS, empty: true, source: null });
    }
  }
  return rows;
}

const clean = (values: readonly string[]) => values.map((v) => v.trim()).filter(Boolean);

export type ItemRow = {
  path: string;
  lot: string | null;
  description: string;
  quantity: string | null;
  specs: string[];
  standards: string[];
  certifications: string[];
  source: SourceTag;
};

/** The items bought, lot by lot, with what the documents say of each; an item without a description is left out. */
export function itemRows(read: Read): ItemRow[] {
  return read.output.items.flatMap((item, i) => {
    const description = item.description.trim();
    if (!description) return [];
    const path = `items.${i}`;
    return [
      {
        path,
        lot: item.lot.trim() ? lotLabel(item.lot) : null,
        description,
        quantity: clean([item.quantity, item.unit]).join(" ") || null,
        specs: clean(item.specs),
        standards: clean(item.standards),
        certifications: clean(item.certifications),
        source: sourceTag(read, path, item.quote),
      },
    ];
  });
}

export type ListRow = { path: string; text: string; detail: string | null; source: SourceTag | null };

/** The award criteria with their weights. */
export function evaluationRows(read: Read): ListRow[] {
  return read.output.evaluation.flatMap((row, i) =>
    row.criterion.trim()
      ? [{ path: `evaluation.${i}`, text: row.criterion.trim(), detail: row.weight.trim() || null, source: sourceTag(read, `evaluation.${i}`, row.quote) }]
      : [],
  );
}

export const SEVERITY_LABELS: Record<DeepOutput["redFlags"][number]["severity"], string> = { high: "Yüksek", medium: "Orta", low: "Düşük" };
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

export type RiskRow = ListRow & { severity: DeepOutput["redFlags"][number]["severity"] };

/** The red flags, the most severe first; within a severity the model's order (sort is stable). */
export function riskRows(read: Read): RiskRow[] {
  return read.output.redFlags
    .flatMap((flag, i) =>
      flag.issue.trim() ? [{ path: `redFlags.${i}`, text: flag.issue.trim(), detail: null, severity: flag.severity, source: sourceTag(read, `redFlags.${i}`, flag.quote) }] : [],
    )
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** An answer that only says the documents do not tell: no source to show. */
const NO_ANSWER = /^dokümanlarda (yok|bulunamadı|belirtilmemiş)/i;

/** The profile's questions with their answers; an answer the documents do not give has no source. */
export function answerRows(read: Read): ListRow[] {
  return read.output.profileAnswers.flatMap((row, i) => {
    const question = row.question.trim();
    if (!question) return [];
    const answer = row.answer.trim();
    const unanswered = !answer || NO_ANSWER.test(answer);
    return [
      {
        path: `profileAnswers.${i}`,
        text: question,
        detail: unanswered ? NOT_IN_DOCUMENTS : answer,
        source: unanswered ? null : sourceTag(read, `profileAnswers.${i}`, row.quote),
      },
    ];
  });
}

/** What the documents do not say and a bid needs. */
export const missingRows = (read: Pick<Read, "output">) => clean(read.output.missingInfo);

/** The model's suggestion, apart from the team's decision (CLAUDE.md rule 4). */
export function suggestion(read: Pick<Read, "output">): { label: string; reasons: string[] } {
  const { decision, reasons } = read.output.suggestedDecision;
  return { label: DECISION_LABELS[decision], reasons: clean(reasons) };
}

// ---------------------------------------------------------------------------
// States and footnotes

export type DeepStatus = {
  title: string;
  detail: string | null;
  /** The button's label, or null while a request is open. */
  action: string | null;
  /** A request is open: the page refreshes itself until it ends. */
  waiting: boolean;
  /** The last request failed; `error` says why, in full. */
  error: string | null;
};

const COST_NOTE = "Tek analiz yaklaşık 0,3-2 USD tutar.";

/** What the card says of the request and the button it offers. */
export function deepStatus(view: Pick<DeepView, "state" | "request" | "result">): DeepStatus {
  const { request } = view;
  const asker = request?.requestedBy ?? "Profilin otomatik analizi";
  switch (view.state) {
    case "queued":
      return {
        title: "Sırada",
        detail: request ? `${asker} istedi (${formatDateTime(request.requestedAt)}); worker analizleri sırayla alır.` : null,
        action: null,
        waiting: true,
        error: null,
      };
    case "running":
      return {
        title: "Analiz ediliyor",
        detail: `Başladı: ${formatDateTime(request?.startedAt ?? null)}. Dosyaların büyüklüğüne göre birkaç dakika sürebilir.`,
        action: null,
        waiting: true,
        error: null,
      };
    case "failed":
      return {
        title: "Son analiz başarısız",
        detail: `${formatDateTime(request?.finishedAt ?? request?.requestedAt ?? null)}: ${firstLine(request?.error) ?? "Hata metni yok."}`,
        action: "Yeniden dene",
        waiting: false,
        error: request?.error ?? null,
      };
    case "done":
      return { title: "Analiz edildi", detail: null, action: "Yeniden analiz et", waiting: false, error: null };
    default:
      return {
        title: "Henüz analiz edilmedi",
        detail: `İlan ve okunan dosyalar birlikte incelenir: kalemler, yeterlilik ve ticari şartlar, riskler, her biri kaynağıyla. ${COST_NOTE}`,
        action: "Analiz et",
        waiting: false,
        error: null,
      };
  }
}

const firstLine = (text: string | null | undefined) => {
  const line = text?.split("\n").find((l) => l.trim())?.trim();
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
};

/** The warning beside the button once the month's LLM budget is spent; a manual analysis still runs (CLAUDE.md rule 7). */
export function budgetNote(budget: DeepView["budget"]): string | null {
  return budget.spentUsd >= budget.budgetUsd ? "Aylık LLM bütçesi doldu; analiz yine çalışır ama maliyeti aşar." : null;
}

export const STALE_NOTE = "Dokümanlar ya da ilan analizden sonra değişti; sonuç güncel olmayabilir.";

/** Said above an earlier result while a new request is open or failed. */
export const olderResultNote = (result: Pick<DeepResult, "createdAt">) => `Aşağıdaki sonuç önceki analizin (${formatDateTime(result.createdAt)}).`;

const usd = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 0.4213 as "0,42 USD". */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.005) return "0,01 USD'den az";
  return `${usd.format(amount)} USD`;
}

/** The result's footnote: the model, the cost, when, and in how many parts the files were read. */
export function deepFooter(result: Pick<DeepResult, "model" | "costUsd" | "createdAt" | "parts">): string[] {
  return [
    `Model: ${result.model}`,
    `Maliyet: ${formatUsd(result.costUsd)}`,
    formatDateTime(result.createdAt),
    ...(result.parts > 1 ? [`${result.parts} parçada okundu`] : []),
  ];
}

/** The files the analysis did not read, each with why. */
export const skippedRows = (result: Pick<DeepResult, "skipped">) => result.skipped.map((file) => `${file.name}: ${file.reason}`);
