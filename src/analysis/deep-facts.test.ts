import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { facts, lot } from "../../tests/helpers/facts";
import { createTestDb } from "../../tests/helpers/test-db";
import { insertTender } from "../../tests/helpers/tenders";
import { analyses, tenderAssessments } from "@/db/schema";
import { assessTenders, latestFacts } from "@/policy/assess";
import {
  applyDeepFacts,
  buildDeepFactsMessage,
  certificateKey,
  DEEP_CHECK_PREFIX,
  DEEP_FACTS_PROMPT_VERSION,
  offeredClaims,
  parseDeepFacts,
  pendingDeepFacts,
  readStoredDeepFacts,
  runDeepFacts,
  type DeepFactsOutput,
  type StoredDeepFacts,
} from "./deep-facts";
import type { DeepOutput, StoredDeep } from "./deep-schema";
import { FACTS_PROMPT_VERSION, pendingFacts } from "./facts";
import { evidencedFacts, QUOTED_FACTS, type FactsQuoteChecks, type ReadFacts } from "./facts-evidence";
import type { FactsOutput } from "./facts-schema";
import type { LlmClient, LlmResponse } from "./llm";

// The deep analysis' facts for the assessment (SPEC 7.2): which claims the small model is shown, what of its
// answer is kept, how the result goes over the facts stage's facts, and the run that converts and assesses.

const empty = { value: "", quote: "", file: 0, page: 0 };

function deepOutput(overrides: Partial<DeepOutput> = {}): DeepOutput {
  return {
    summaryTr: "Jeneratör tedariki.",
    items: [],
    delivery: { location: empty, country: empty, incoterm: empty, leadTime: empty, schedule: empty },
    eligibility: {
      supplierLocation: empty,
      productOrigin: empty,
      minTurnover: empty,
      references: empty,
      qualityCerts: [],
      insurance: [],
      securityRequirements: empty,
      localPresence: empty,
    },
    commercial: { contractType: empty, duration: empty, pricingBasis: empty, paymentTerms: empty, bonds: empty, penalties: empty, warranty: empty },
    servicesScope: { installation: empty, maintenance: empty, training: empty },
    evaluation: [],
    timeline: { clarificationDeadline: empty, submissionDeadline: empty, siteVisit: empty },
    redFlags: [],
    profileAnswers: [],
    missingInfo: [],
    suggestedDecision: { decision: "REVIEW", reasons: ["İncelenmeli"] },
    ...overrides,
  };
}

const INSTALL = "Der Auftragnehmer übernimmt die Aufstellung und den Anschluss";

/** A generator tender read in depth: installation, training, turnover and certificates stated; the warranty's quote not found. */
const analysis = deepOutput({
  servicesScope: {
    installation: { value: "Tedarikçi jeneratörleri sahada kuracak ve bağlayacak", quote: INSTALL, file: 1, page: 4 },
    maintenance: empty,
    training: { value: "Yerinde operatör eğitimi", quote: "Einweisung des Bedienpersonals vor Ort", file: 1, page: 5 },
  },
  eligibility: {
    supplierLocation: empty,
    productOrigin: empty,
    minTurnover: { value: "Son üç yılda yıllık en az 500.000 EUR", quote: "Mindestjahresumsatz von 500.000 EUR", file: 2, page: 1 },
    references: empty,
    qualityCerts: [{ value: "ISO 9001 belgesi", quote: "Zertifizierung nach ISO 9001", file: 2, page: 2 }],
    insurance: [],
    securityRequirements: empty,
    localPresence: empty,
  },
  commercial: {
    contractType: empty,
    duration: empty,
    pricingBasis: empty,
    paymentTerms: empty,
    bonds: empty,
    penalties: empty,
    warranty: { value: "24 ay garanti", quote: "Gewährleistung 24 Monate", file: 1, page: 9 },
  },
  items: [
    { lot: "", description: "60 kVA jeneratör", quantity: "2", unit: "adet", specs: [], standards: ["ISO 8528"], certifications: ["CE"], quote: "Netzersatzanlage 60 kVA nach ISO 8528, CE", file: 1, page: 2 },
    { lot: "", description: "Kablo", quantity: "", unit: "", specs: [], standards: [], certifications: [], quote: "Kabel", file: 1, page: 3 },
  ],
  evaluation: [
    { criterion: "Fiyat", weight: "%70", quote: "Preis 70 %", file: 2, page: 3 },
    { criterion: "Teslim süresi", weight: "%30", quote: "Lieferzeit 30 %", file: 2, page: 3 },
  ],
});

const storedDeep: StoredDeep = {
  output: analysis,
  quoteChecks: {
    "servicesScope.installation": "file:1:p4",
    "servicesScope.training": "file:1:p5",
    "eligibility.minTurnover": "file:2:p1",
    "eligibility.qualityCerts.0": "file:2:p2",
    "commercial.warranty": null,
    "items.0": "file:1:p2",
    "items.1": "file:1:p3",
    "evaluation.0": "file:2:p3",
    "evaluation.1": "file:2:p3",
  },
  parts: 1,
  skipped: [],
  inputUpdatedAt: "2026-10-19T12:00:00.000Z",
};

/** An answer with every fact unknown except what is given. */
function deepAnswer(overrides: Partial<DeepFactsOutput> = {}): DeepFactsOutput {
  return {
    installation: { value: "UNKNOWN", detail: "", lots: [], from: "" },
    commissioningTraining: { value: "UNKNOWN", detail: "", lots: [], from: "" },
    localService: { value: "UNKNOWN", detail: "", lots: [], from: "" },
    warranty: { years: null, detail: "", from: "" },
    deliveryPattern: { value: "UNKNOWN", detail: "", from: "" },
    deliveryPoints: { value: "UNKNOWN", detail: "", from: "" },
    contractDuration: { months: null, from: "" },
    framework: { value: "UNKNOWN", from: "" },
    pastPerformance: { value: "UNKNOWN", detail: "", from: "" },
    turnover: { value: "UNKNOWN", detail: "", from: "" },
    siteVisit: { value: "UNKNOWN", from: "" },
    awardCriteria: { value: "UNKNOWN", detail: "", from: "" },
    certifications: [],
    ...overrides,
  };
}

describe("what the model is shown", () => {
  const offered = offeredClaims(storedDeep);

  it("offers each fact only the claims it may rest on whose quote was found", () => {
    expect(offered.facts.installation.map((c) => c.path)).toEqual(["servicesScope.installation"]);
    expect(offered.facts.commissioningTraining.map((c) => c.path)).toEqual(["servicesScope.training"]);
    // The warranty's quote was not found; an empty claim is no claim.
    expect(offered.facts.warranty).toEqual([]);
    expect(offered.facts.localService).toEqual([]);
    expect(offered.facts.awardCriteria.map((c) => c.path)).toEqual(["evaluation.0", "evaluation.1"]);
    expect(offered.facts.awardCriteria[1]).toEqual({ path: "evaluation.1", text: "Teslim süresi (%30)", quote: "Lieferzeit 30 %" });
    // An item without certificates says nothing of them.
    expect(offered.certifications.map((c) => c.path)).toEqual(["eligibility.qualityCerts.0", "items.0"]);
    expect(offered.certifications[1]!.text).toBe("60 kVA jeneratör; belgeler: CE; standartlar: ISO 8528");
  });

  it("lists the lots, then every fact with its claims and quotes", () => {
    const message = buildDeepFactsMessage(offered, ["1", "2"]);
    expect(message).toContain("<lotlar>1, 2</lotlar>");
    expect(message).toContain(`<alan ad="installation" konu="Sahada kurulum ya da montaj">\n<iddia yol="servicesScope.installation">\nTedarikçi jeneratörleri sahada kuracak ve bağlayacak\nAlıntı: ${INSTALL}\n</iddia>\n</alan>`);
    expect(message).toContain('<alan ad="warranty" konu="Garanti süresi">\n(iddia yok)\n</alan>');
    expect(buildDeepFactsMessage(offered, [])).toContain("<lotlar>ilanda lot yok</lotlar>");
  });
});

describe("what is kept of the answer", () => {
  const offered = offeredClaims(storedDeep);
  const dash = String.fromCharCode(0x2014);

  it("keeps a value only on a claim it was offered for that fact", () => {
    const parsed = parseDeepFacts(
      deepAnswer({
        installation: { value: "REQUIRED", detail: `Sahada kurulum ${dash} iki jeneratör`, lots: [], from: "servicesScope.installation" },
        // Offered nothing: its quote was not found.
        warranty: { years: 2, detail: "24 ay", from: "commercial.warranty" },
        // A claim offered for another fact.
        turnover: { value: "REQUIRED", detail: "500.000 EUR", from: "servicesScope.installation" },
        certifications: [
          { name: "ISO 9001", level: "BIDDER", from: "eligibility.qualityCerts.0" },
          { name: "Kablo belgesi", level: "PRODUCT", from: "items.1" },
        ],
      }),
      offered,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.output.installation).toEqual({ value: "REQUIRED", detail: "Sahada kurulum, iki jeneratör", lots: [], from: "servicesScope.installation" });
    expect(parsed.output.warranty).toEqual({ years: null, detail: "", from: "" });
    expect(parsed.output.turnover).toEqual({ value: "UNKNOWN", detail: "", from: "" });
    expect(parsed.output.certifications).toEqual([{ name: "ISO 9001", level: "BIDDER", from: "eligibility.qualityCerts.0" }]);
  });

  it("rejects an answer that does not fit the schema", () => {
    expect(parseDeepFacts({ installation: { value: "YES" } }, offered).ok).toBe(false);
  });
});

const noChecks = (f: FactsOutput): FactsQuoteChecks => ({
  facts: Object.fromEntries(QUOTED_FACTS.map((key) => [key, null])) as FactsQuoteChecks["facts"],
  certifications: f.certifications.map(() => null),
  lots: f.lots.map(() => ({ category: null, nature: null, quantity: null })),
});

function read(f: FactsOutput, checks: Partial<FactsQuoteChecks["facts"]> = {}, certifications?: (string | null)[]): ReadFacts {
  const base = noChecks(f);
  return { facts: f, quoteChecks: { ...base, facts: { ...base.facts, ...checks }, certifications: certifications ?? base.certifications }, sourcesHash: "h" };
}

const converted: StoredDeepFacts = {
  output: deepAnswer({
    installation: { value: "REQUIRED", detail: "Sahada kurulum", lots: [], from: "servicesScope.installation" },
    turnover: { value: "REQUIRED", detail: "500.000 EUR", from: "eligibility.minTurnover" },
    certifications: [
      { name: "ISO 9001", level: "BIDDER", from: "eligibility.qualityCerts.0" },
      { name: "ISO 8528", level: "PRODUCT", from: "items.0" },
    ],
  }),
  deepAnalysisId: "d1",
  inputUpdatedAt: "2026-10-19T12:00:00.000Z",
  evidence: {
    "servicesScope.installation": { quote: INSTALL, check: "file:1:p4" },
    "eligibility.minTurnover": { quote: "Mindestjahresumsatz von 500.000 EUR", check: "file:2:p1" },
    "eligibility.qualityCerts.0": { quote: "Zertifizierung nach ISO 9001", check: "file:2:p2" },
    "items.0": { quote: "Netzersatzanlage 60 kVA nach ISO 8528, CE", check: "file:1:p2" },
  },
};

const generatorLot = lot({ productTr: "jeneratör", category: "COMPLEX_GENERATORS" });

describe("over the facts stage's facts", () => {
  const deliveryOnly = facts({
    lots: [generatorLot],
    installation: { value: "NONE", detail: "Yalnızca teslim", quote: "Lieferung frei Haus" },
    warranty: { years: 1, detail: "", quote: "Gewährleistung ein Jahr" },
  });
  const notice = read(deliveryOnly, { installation: "description", warranty: "description" });

  it("puts a value the analysis states on a found quote over the facts stage's verified one, and says where it was found", () => {
    const applied = applyDeepFacts(notice, converted);
    expect(applied.keys).toEqual(["installation", "turnover"]);
    expect(applied.read.facts.installation).toEqual({ value: "REQUIRED", detail: "Sahada kurulum", lots: [], quote: INSTALL });
    expect(applied.read.quoteChecks!.facts.installation).toBe(`${DEEP_CHECK_PREFIX}file:1:p4`);
    expect(applied.read.quoteChecks!.facts.turnover).toBe(`${DEEP_CHECK_PREFIX}file:2:p1`);
    // What the analysis does not state stays the facts stage's.
    expect(applied.read.facts.warranty).toEqual(deliveryOnly.warranty);
    expect(applied.read.quoteChecks!.facts.warranty).toBe("description");
    const used = evidencedFacts(applied.read.facts, applied.read.quoteChecks);
    expect([used.installation.value, used.turnover.value, used.warranty.years]).toEqual(["REQUIRED", "REQUIRED", 1]);
  });

  it("adds a certificate the facts lack and verifies one they hold unverified, without doubling one they hold", () => {
    const withCertificates = facts({
      lots: [generatorLot],
      certifications: [
        { name: "EN ISO 9001:2015", level: "BIDDER", quote: "ISO 9001" },
        { name: "ISO 8528", level: "PRODUCT", quote: "not in the notice" },
      ],
    });
    const applied = applyDeepFacts(read(withCertificates, {}, ["description", null]), converted);
    expect(applied.read.facts.certifications).toEqual([
      { name: "EN ISO 9001:2015", level: "BIDDER", quote: "ISO 9001" },
      { name: "ISO 8528", level: "PRODUCT", quote: "Netzersatzanlage 60 kVA nach ISO 8528, CE" },
    ]);
    expect(applied.read.quoteChecks!.certifications).toEqual(["description", `${DEEP_CHECK_PREFIX}file:1:p2`]);
    expect(applied.certifications).toBe(1);
    const added = applyDeepFacts(read(facts({ lots: [generatorLot] })), converted);
    expect(added.read.facts.certifications.map((c) => c.name)).toEqual(["ISO 9001", "ISO 8528"]);
    expect(added.certifications).toBe(2);
  });

  it("counts only the analysis' facts when the facts stage's answer has no checks", () => {
    const old: ReadFacts = { facts: deliveryOnly, quoteChecks: null, sourcesHash: null };
    const { read: merged } = applyDeepFacts(old, converted);
    const used = evidencedFacts(merged.facts, merged.quoteChecks);
    expect(used.installation.value).toBe("REQUIRED");
    expect(used.warranty.years).toBeNull();
  });

  it("compares certificates by one spelling", () => {
    expect(certificateKey("TS EN ISO 20471:2013")).toBe(certificateKey("ISO 20471"));
    expect(certificateKey("ISO 9001")).not.toBe(certificateKey("ISO 14001"));
    expect(certificateKey("CE")).toBe("CE");
  });
});

// ---------------------------------------------------------------------------
// The run

const MINUTE = 60_000;
const usage = { inputTokens: 2_000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0 };
const reply = (body: unknown): LlmResponse => ({
  text: typeof body === "string" ? body : JSON.stringify(body),
  stopReason: "end_turn",
  refusalCategory: null,
  model: "claude-haiku-5-5-20261001",
  usage,
});
const llm = (answer: () => unknown): LlmClient => ({ complete: async () => reply(answer()) });
const installs = () => deepAnswer({ installation: { value: "REQUIRED", detail: "Sahada kurulum", lots: [], from: "servicesScope.installation" } });

describe("the conversion run", () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    testDb = await createTestDb();
  });
  beforeEach(async () => {
    vi.stubEnv("LLM_MONTHLY_BUDGET_USD", "5");
    await testDb.reset();
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    await testDb.close();
  });

  async function deepResult(tenderId: string, at: Date, documentIds: string[] = []) {
    const [row] = await testDb.db
      .insert(analyses)
      .values({ tenderId, kind: "deep", model: "claude-sonnet-5-5", promptVersion: "deep.v1", documentIds, output: storedDeep, valid: true, createdAt: at })
      .returning({ id: analyses.id });
    return row!.id;
  }

  async function storeFacts(tenderId: string, f: FactsOutput, inputUpdatedAt: Date) {
    await testDb.db.insert(analyses).values({
      tenderId,
      kind: "facts",
      model: "claude-haiku-5-5",
      promptVersion: FACTS_PROMPT_VERSION,
      valid: true,
      output: { ...f, quoteChecks: noChecks(f), sourcesHash: "h", inputUpdatedAt: inputUpdatedAt.toISOString() },
      createdAt: inputUpdatedAt,
    });
  }

  it("converts the latest result once, waits an hour after an attempt that gave none, and converts a newer result", async () => {
    const { db } = testDb;
    const tenderId = await insertTender(db);
    await deepResult(tenderId, new Date(Date.now() - 5 * MINUTE));
    expect(await pendingDeepFacts(db, 10)).toEqual([tenderId]);

    const failed = await runDeepFacts(db, llm(() => "not json"), { prompt: "p" });
    expect(failed).toMatchObject({ attempted: 1, invalid: 1, converted: [] });
    expect(await pendingDeepFacts(db, 10, new Date(Date.now() + 10 * MINUTE))).toEqual([]);
    expect(await pendingDeepFacts(db, 10, new Date(Date.now() + 61 * MINUTE))).toEqual([tenderId]);

    const done = await runDeepFacts(db, llm(installs), { prompt: "p", tenderIds: [tenderId] });
    expect(done).toMatchObject({ valid: 1, converted: [tenderId] });
    const [row] = await db.select().from(analyses).where(eq(analyses.kind, "deep_facts")).orderBy(analyses.createdAt).limit(10).then((rows) => rows.filter((r) => r.valid));
    expect(row).toMatchObject({ tenderId, promptVersion: DEEP_FACTS_PROMPT_VERSION, model: "claude-haiku-5-5-20261001" });
    expect(readStoredDeepFacts(row!.output)?.evidence).toEqual({ "servicesScope.installation": { quote: INSTALL, check: "file:1:p4" } });
    expect(await pendingDeepFacts(db, 10, new Date(Date.now() + 120 * MINUTE))).toEqual([]);

    await deepResult(tenderId, new Date(Date.now() + MINUTE));
    expect(await pendingDeepFacts(db, 10, new Date(Date.now() + 2 * MINUTE))).toEqual([tenderId]);
  });

  it("puts the analysis' facts over the facts stage's and changes the assessment", async () => {
    const { db } = testDb;
    const tenderId = await insertTender(db, { status: "open", contractNature: "goods", buyerCountry: "NL", valueEur: 80_000 });
    await storeFacts(tenderId, facts({ lots: [generatorLot] }), new Date(Date.now() - 60 * MINUTE));
    await assessTenders(db, { tenderIds: [tenderId] });
    const statusOf = async () => (await db.select({ status: tenderAssessments.status }).from(tenderAssessments).where(eq(tenderAssessments.tenderId, tenderId)))[0]?.status;
    const before = await statusOf();

    await deepResult(tenderId, new Date(Date.now() - 30 * MINUTE));
    const run = await runDeepFacts(db, llm(installs), { prompt: "p" });
    expect(run.converted).toEqual([tenderId]);
    await assessTenders(db, { tenderIds: run.converted });
    expect(before).toBe("NEEDS_DOCUMENTS");
    expect(await statusOf()).toBe("COMMERCIAL_NO_BID");

    const latest = (await latestFacts(db, [tenderId])).get(tenderId)!;
    expect(latest.deep).toMatchObject({ keys: ["installation"], certifications: 0, documentIds: [] });
    expect(latest.stored.quoteChecks?.facts.installation).toBe(`${DEEP_CHECK_PREFIX}file:1:p4`);
    expect(latest.facts.installation.value).toBe("REQUIRED");
  });

  it("asks for new facts of a deep-analysed tender whose files changed, whatever the profiles", async () => {
    const { db } = testDb;
    const tenderId = await insertTender(db, { status: "open", documentsChangedAt: new Date(Date.now() - 10 * MINUTE) });
    await storeFacts(tenderId, facts({ lots: [generatorLot] }), new Date(Date.now() - 60 * MINUTE));
    expect(await pendingFacts(db, 10)).not.toContain(tenderId);
    await deepResult(tenderId, new Date(Date.now() - 30 * MINUTE));
    expect(await pendingFacts(db, 10)).toContain(tenderId);
  });
});
