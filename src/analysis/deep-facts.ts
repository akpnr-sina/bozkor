import { readFileSync } from "node:fs";
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppDb } from "@/db";
import { analyses, lots } from "@/db/schema";
import { readStoredDeep, type DeepClaim, type DeepOutput, type StoredDeep } from "./deep-schema";
import type { FactsQuoteChecks, QuotedFact, ReadFacts } from "./facts-evidence";
import { factsModel } from "./facts";
import { factsOutputSchema, type FactsOutput } from "./facts-schema";
import type { LlmClient } from "./llm";
import { byLotNumber } from "./notice";
import { completeValidated, noEmDash, recordAnalysis, runWithinBudget, schemaError, type AnalysisOutcome, type Parsed, type RunOptions, type RunStats } from "./runner";

// The facts the policy weighs, from the deep analysis (SPEC 7.2): a small model reads the analysis' claims on
// obligations, terms and requirements and gives each the value the facts stage would, citing the claim it
// rests on. Only claims whose quote was found in the documents are offered, so every value carries a verified
// excerpt (rule 5). latestFacts puts these over the facts stage's values (applyDeepFacts); the model reads no
// document and decides nothing (rules 3 and 4).

export const DEEP_FACTS_PROMPT_VERSION = "deep-facts.v1";

/** The tender-level facts the deep analysis has claims on; it does not ask about brand, samples or a restricted product. */
export const DEEP_FACT_KEYS = [
  "installation",
  "commissioningTraining",
  "localService",
  "warranty",
  "deliveryPattern",
  "deliveryPoints",
  "contractDuration",
  "framework",
  "pastPerformance",
  "turnover",
  "siteVisit",
  "awardCriteria",
] as const satisfies readonly QuotedFact[];
export type DeepFactKey = (typeof DEEP_FACT_KEYS)[number];

/** The claims each fact may rest on, by their path in the analysis (deepQuotes). */
const CLAIM_PATHS: Record<DeepFactKey, (output: DeepOutput) => string[]> = {
  installation: () => ["servicesScope.installation"],
  commissioningTraining: () => ["servicesScope.training"],
  localService: () => ["servicesScope.maintenance", "eligibility.localPresence"],
  warranty: () => ["commercial.warranty"],
  deliveryPattern: () => ["delivery.schedule"],
  deliveryPoints: () => ["delivery.location"],
  contractDuration: () => ["commercial.duration"],
  framework: () => ["commercial.contractType"],
  pastPerformance: () => ["eligibility.references"],
  turnover: () => ["eligibility.minTurnover"],
  siteVisit: () => ["timeline.siteVisit"],
  awardCriteria: (output) => output.evaluation.map((_, i) => `evaluation.${i}`),
};

/** Certificates: the bidder's quality certificates, and what an item must carry. */
const certificatePaths = (output: DeepOutput): string[] => [
  ...output.eligibility.qualityCerts.map((_, i) => `eligibility.qualityCerts.${i}`),
  ...output.items.flatMap((item, i) => (item.certifications.length || item.standards.length ? [`items.${i}`] : [])),
];

const SUBJECTS: Record<DeepFactKey, string> = {
  installation: "Sahada kurulum ya da montaj",
  commissioningTraining: "Sahada devreye alma ya da yerinde eğitim",
  localService: "Yerinde bakım, onarım, servis ya da yerel destek",
  warranty: "Garanti süresi",
  deliveryPattern: "Teslimat düzeni",
  deliveryPoints: "Teslim noktalarının sayısı",
  contractDuration: "Sözleşme süresi",
  framework: "Çerçeve anlaşma ya da garanti edilmeyen miktar",
  pastPerformance: "Referans ya da iş deneyimi şartı",
  turnover: "Asgari ciro şartı",
  siteVisit: "Saha ziyareti",
  awardCriteria: "Değerlendirme ölçütü",
};

/** What the analysis says at a path, in Turkish, with its quote; null when it says nothing there. */
function claimAt(output: DeepOutput, at: string): { text: string; quote: string } | null {
  const [section, key, index] = at.split(".");
  if (section === "items") {
    const item = output.items[Number(key)];
    if (!item) return null;
    const parts = [
      item.lot ? `Lot ${item.lot}` : "",
      item.description,
      item.certifications.length ? `belgeler: ${item.certifications.join(", ")}` : "",
      item.standards.length ? `standartlar: ${item.standards.join(", ")}` : "",
    ];
    return { text: parts.filter(Boolean).join("; "), quote: item.quote };
  }
  if (section === "evaluation") {
    const criterion = output.evaluation[Number(key)];
    return criterion ? { text: criterion.weight ? `${criterion.criterion} (${criterion.weight})` : criterion.criterion, quote: criterion.quote } : null;
  }
  const group = (output as unknown as Record<string, Record<string, DeepClaim | DeepClaim[]> | undefined>)[section ?? ""];
  const value = group?.[key ?? ""];
  const claim = Array.isArray(value) ? value[Number(index)] : value;
  return claim?.value.trim() ? { text: claim.value, quote: claim.quote } : null;
}

export type OfferedClaim = { path: string; text: string; quote: string };
export type OfferedClaims = { facts: Record<DeepFactKey, OfferedClaim[]>; certifications: OfferedClaim[] };

/** The claims each fact may rest on whose quote was found: all the model is shown, and all it may cite. */
export function offeredClaims(stored: Pick<StoredDeep, "output" | "quoteChecks">): OfferedClaims {
  const offer = (paths: string[]): OfferedClaim[] =>
    paths.flatMap((at) => {
      const claim = claimAt(stored.output, at);
      return claim && claim.quote.trim() && stored.quoteChecks[at] ? [{ path: at, ...claim }] : [];
    });
  return {
    facts: Object.fromEntries(DEEP_FACT_KEYS.map((key) => [key, offer(CLAIM_PATHS[key](stored.output))])) as Record<DeepFactKey, OfferedClaim[]>,
    certifications: offer(certificatePaths(stored.output)),
  };
}

/** The message: the tender's lots, then for each fact the verified claims it may rest on. */
export function buildDeepFactsMessage(offered: OfferedClaims, lotNumbers: readonly string[]): string {
  const claim = (c: OfferedClaim) => `<iddia yol="${c.path}">\n${c.text}\nAlıntı: ${c.quote}\n</iddia>`;
  const field = (name: string, subject: string, claims: OfferedClaim[]) =>
    `<alan ad="${name}" konu="${subject}">\n${claims.length ? claims.map(claim).join("\n") : "(iddia yok)"}\n</alan>`;
  return [
    `<lotlar>${lotNumbers.length ? lotNumbers.join(", ") : "ilanda lot yok"}</lotlar>`,
    ...DEEP_FACT_KEYS.map((key) => field(key, SUBJECTS[key], offered.facts[key])),
    field("certifications", "İstenen belgeler ve standartlar", offered.certifications),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// The answer

const from = z.string().describe("Değerin dayandığı iddianın yolu, girdideki gibi (ör. 'servicesScope.installation'). Değer bilinmiyorsa boş.");
const shape = factsOutputSchema.shape;

export const deepFactsSchema = z.object({
  installation: shape.installation.omit({ quote: true }).extend({ from }),
  commissioningTraining: shape.commissioningTraining.omit({ quote: true }).extend({ from }),
  localService: shape.localService.omit({ quote: true }).extend({ from }),
  warranty: shape.warranty.omit({ quote: true }).extend({ from }),
  deliveryPattern: shape.deliveryPattern.omit({ quote: true }).extend({ from }),
  deliveryPoints: shape.deliveryPoints.omit({ quote: true }).extend({ from }),
  contractDuration: shape.contractDuration.omit({ quote: true }).extend({ from }),
  framework: shape.framework.omit({ quote: true }).extend({ from }),
  pastPerformance: shape.pastPerformance.omit({ quote: true }).extend({ from }),
  turnover: shape.turnover.omit({ quote: true }).extend({ from }),
  siteVisit: shape.siteVisit.omit({ quote: true }).extend({ from }),
  awardCriteria: shape.awardCriteria.omit({ quote: true }).extend({ from }),
  certifications: z.array(shape.certifications.element.omit({ quote: true }).extend({ from })).max(20),
});
export type DeepFactsOutput = z.infer<typeof deepFactsSchema>;
type DeepFact = DeepFactsOutput[DeepFactKey];

/** A value is stated: a code other than UNKNOWN, or a number. */
function stated(fact: object): boolean {
  if ("years" in fact) return fact.years !== null;
  if ("months" in fact) return fact.months !== null;
  return (fact as { value: string }).value !== "UNKNOWN";
}

/** The same fact unknown, as the facts stage writes one it cannot tell. */
function unknownOf<T extends DeepFact>(fact: T): T {
  if ("years" in fact) return { ...fact, years: null, detail: "", from: "" };
  if ("months" in fact) return { ...fact, months: null, from: "" };
  return { ...fact, value: "UNKNOWN", ...("detail" in fact ? { detail: "" } : {}), ...("lots" in fact ? { lots: [] } : {}), from: "" };
}

/** A stated value must cite a claim it was offered for that fact; one that does not becomes unknown, a certificate is left out. */
function keepOffered(output: DeepFactsOutput, offered: OfferedClaims): DeepFactsOutput {
  const kept = { ...output };
  for (const key of DEEP_FACT_KEYS) {
    const fact = output[key];
    const cited = offered.facts[key].some((c) => c.path === fact.from);
    (kept as Record<DeepFactKey, DeepFact>)[key] = stated(fact) && cited ? cleanDetail(fact) : unknownOf(fact);
  }
  kept.certifications = output.certifications.filter((c) => offered.certifications.some((o) => o.path === c.from));
  return kept;
}

const cleanDetail = <T extends DeepFact>(fact: T): T => ("detail" in fact ? { ...fact, detail: noEmDash(fact.detail) } : fact);

export function parseDeepFacts(value: unknown, offered: OfferedClaims): Parsed<DeepFactsOutput> {
  const parsed = deepFactsSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: schemaError(parsed.error.issues) };
  return { ok: true, output: keepOffered(parsed.data, offered) };
}

export function loadDeepFactsPrompt(version = DEEP_FACTS_PROMPT_VERSION): string {
  return readFileSync(path.join(process.cwd(), "prompts", `${version}.md`), "utf8");
}

/** The system prompt with the answer's JSON Schema appended, as the facts stage's. */
export function deepFactsSystemPrompt(prompt: string): string {
  return [
    prompt.trimEnd(),
    "",
    "## Yanıt biçimi",
    "",
    "Yanıtın, aşağıdaki JSON şemasına uyan tek bir JSON nesnesi olsun. Önüne ya da arkasına metin ya da kod bloğu işareti ekleme. Alan adlarını ve kodları şemadaki gibi aynen yaz; her alanı yaz.",
    "",
    JSON.stringify(z.toJSONSchema(deepFactsSchema)),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Stored conversions

/**
 * A conversion as stored: the answer, the deep result it read, when that result read its input (the tender's
 * inputChangedAt then), and the quote of every claim the answer cites with where the analysis found it.
 */
export type StoredDeepFacts = {
  output: DeepFactsOutput;
  deepAnalysisId: string;
  inputUpdatedAt: string;
  evidence: Record<string, { quote: string; check: string }>;
};

const storedDeepFactsSchema = z.object({
  output: deepFactsSchema,
  deepAnalysisId: z.string(),
  inputUpdatedAt: z.string(),
  evidence: z.record(z.string(), z.object({ quote: z.string(), check: z.string() })),
});

export function readStoredDeepFacts(value: unknown): StoredDeepFacts | null {
  const parsed = storedDeepFactsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The quote and check of every claim the answer cites. */
function evidenceOf(output: DeepFactsOutput, stored: StoredDeep): StoredDeepFacts["evidence"] {
  const evidence: StoredDeepFacts["evidence"] = {};
  const cited = [...DEEP_FACT_KEYS.map((key) => output[key].from), ...output.certifications.map((c) => c.from)];
  for (const at of cited) {
    const check = at ? stored.quoteChecks[at] : null;
    const claim = at ? claimAt(stored.output, at) : null;
    if (check && claim) evidence[at] = { quote: claim.quote, check };
  }
  return evidence;
}

/** A deep analysis' result, not one of its parts: the row whose output has quote checks (as deep-view reads it). */
const deepResult = sql`${analyses.output} -> 'quoteChecks' is not null`;

const MAX_TOKENS = 6_000;

/** Converts the latest deep result of one tender. Validated and retried once (rule 6), the call recorded with its cost (rule 7). */
export async function convertDeepFacts(db: AppDb, llm: LlmClient, tenderId: string, model: string, prompt: string): Promise<AnalysisOutcome> {
  const [latest] = await db
    .select({ id: analyses.id, output: analyses.output, documentIds: analyses.documentIds })
    .from(analyses)
    .where(and(eq(analyses.tenderId, tenderId), eq(analyses.kind, "deep"), eq(analyses.valid, true), deepResult))
    .orderBy(desc(analyses.createdAt))
    .limit(1);
  const stored = latest ? readStoredDeep(latest.output) : null;
  if (!latest || !stored) return { status: "gone", costUsd: 0 };
  const lotRows = await db.select({ lotNumber: lots.lotNumber }).from(lots).where(eq(lots.tenderId, tenderId));
  const offered = offeredClaims(stored);
  const result = await completeValidated(llm, {
    request: {
      model,
      system: deepFactsSystemPrompt(prompt),
      user: buildDeepFactsMessage(offered, lotRows.sort(byLotNumber).map((l) => l.lotNumber)),
      effort: "low",
    },
    maxTokens: MAX_TOKENS,
    parse: (value) => parseDeepFacts(value, offered),
    stored: (output): StoredDeepFacts => ({ output, deepAnalysisId: latest.id, inputUpdatedAt: stored.inputUpdatedAt, evidence: evidenceOf(output, stored) }),
    record: (entry) =>
      recordAnalysis(db, { tenderId, profileId: null, kind: "deep_facts", promptVersion: DEEP_FACTS_PROMPT_VERSION, documentIds: latest.documentIds }, entry),
  });
  return { status: result.status, costUsd: result.costUsd };
}

/** After an attempt that gave no conversion, the tender waits this long. */
const RETRY_MS = 60 * 60 * 1000;

/** Tenders whose latest deep result has no conversion yet, newest result first; an attempt after it waits an hour. */
export async function pendingDeepFacts(db: AppDb, limit: number, now = new Date()): Promise<string[]> {
  const results = await db
    .selectDistinctOn([analyses.tenderId], { id: analyses.id, tenderId: analyses.tenderId, createdAt: analyses.createdAt })
    .from(analyses)
    .where(and(eq(analyses.kind, "deep"), eq(analyses.valid, true), deepResult))
    .orderBy(analyses.tenderId, desc(analyses.createdAt));
  if (!results.length) return [];
  const attempts = await db
    .select({
      tenderId: analyses.tenderId,
      valid: analyses.valid,
      createdAt: analyses.createdAt,
      deepAnalysisId: sql<string | null>`${analyses.output} ->> 'deepAnalysisId'`,
    })
    .from(analyses)
    .where(and(eq(analyses.kind, "deep_facts"), inArray(analyses.tenderId, results.map((r) => r.tenderId))));
  return results
    .filter((result) => {
      const mine = attempts.filter((a) => a.tenderId === result.tenderId);
      if (mine.some((a) => a.valid && a.deepAnalysisId === result.id)) return false;
      return !mine.some((a) => a.createdAt > result.createdAt && now.getTime() - a.createdAt.getTime() < RETRY_MS);
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)
    .map((r) => r.tenderId);
}

export type DeepFactsRunStats = RunStats & { converted: string[] };

/** Converts pending deep results within the monthly budget; `converted` lists the tenders to assess again. */
export async function runDeepFacts(
  db: AppDb,
  llm: LlmClient,
  options: RunOptions & { limit?: number; tenderIds?: string[]; model?: string; prompt?: string } = {},
): Promise<DeepFactsRunStats> {
  const model = options.model ?? factsModel();
  let prompt = options.prompt;
  const converted: string[] = [];
  const stats = await runWithinBudget(
    db,
    {
      label: "derin analiz olguları",
      model,
      items: async () => options.tenderIds ?? (await pendingDeepFacts(db, options.limit ?? 20, options.now)),
      describe: (id) => id,
    },
    async (id) => {
      const outcome = await convertDeepFacts(db, llm, id, model, (prompt ??= loadDeepFactsPrompt()));
      if (outcome.status === "valid") converted.push(id);
      return outcome;
    },
    options,
  );
  return { ...stats, converted };
}

// ---------------------------------------------------------------------------
// Over the facts stage's facts

/** A fact taken from the deep analysis keeps the analysis' quote check behind this prefix ("deep:file:3:p12"). */
export const DEEP_CHECK_PREFIX = "deep:";

/** One spelling per certificate for comparing: "TS EN ISO 20471:2013" and "ISO 20471" as "ISO20471". */
export function certificateKey(name: string): string {
  return name
    .toLocaleUpperCase("tr")
    .replace(/İ/g, "I")
    .replace(/:\s*\d{4}\b/g, "")
    .replace(/\b(TS|EN|BS|DIN|NF|UNE|UNI|ÖNORM|SS|NEN)\b/g, "")
    .replace(/[^A-Z0-9]/g, "");
}

function noChecks(facts: FactsOutput): FactsQuoteChecks {
  return {
    facts: Object.fromEntries(Object.keys(factsOutputSchema.shape).map((key) => [key, null])) as FactsQuoteChecks["facts"],
    certifications: facts.certifications.map(() => null),
    lots: facts.lots.map(() => ({ category: null, nature: null, quantity: null })),
  };
}

export type AppliedDeepFacts = { read: ReadFacts; keys: DeepFactKey[]; certifications: number };

/**
 * The facts with the deep analysis' over them (SPEC 7.2, the team's decision of 4 November 2026): a value the
 * conversion states on a claim whose quote was found replaces the facts stage's, whatever that says; the deep
 * analysis read the documents whole, with the stronger model. What it does not state stays the facts stage's.
 * A certificate the facts lack, or hold unverified, is added or verified.
 */
export function applyDeepFacts(read: ReadFacts, deep: StoredDeepFacts): AppliedDeepFacts {
  const checks = read.quoteChecks ?? noChecks(read.facts);
  const facts: FactsOutput = { ...read.facts };
  const factChecks = { ...checks.facts };
  const keys: DeepFactKey[] = [];
  for (const key of DEEP_FACT_KEYS) {
    const { from: cited, ...value } = deep.output[key];
    const evidence = cited ? deep.evidence[cited] : undefined;
    if (!evidence || !stated(value)) continue;
    (facts as Record<DeepFactKey, unknown>)[key] = { ...value, quote: evidence.quote };
    factChecks[key] = DEEP_CHECK_PREFIX + evidence.check;
    keys.push(key);
  }
  const certifications = [...read.facts.certifications];
  const certificationChecks = [...checks.certifications];
  let added = 0;
  for (const { from: cited, ...certificate } of deep.output.certifications) {
    const evidence = deep.evidence[cited];
    const key = certificateKey(certificate.name);
    if (!evidence || !key) continue;
    const same = certifications.findIndex((c) => certificateKey(c.name) === key);
    if (same >= 0 && certificationChecks[same]) continue;
    const entry = { ...certificate, quote: evidence.quote };
    if (same >= 0) certifications[same] = entry;
    else certifications.push(entry);
    certificationChecks[same >= 0 ? same : certifications.length - 1] = DEEP_CHECK_PREFIX + evidence.check;
    added++;
  }
  return {
    read: { ...read, facts: { ...facts, certifications }, quoteChecks: { ...checks, facts: factChecks, certifications: certificationChecks } },
    keys,
    certifications: added,
  };
}
