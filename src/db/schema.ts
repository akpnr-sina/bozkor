import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Every table has RLS enabled with no policies. The app talks to Postgres
// directly as the table owner (bypasses RLS); this only closes the Supabase
// Data API, which would otherwise expose these tables to the public key.

const timestamptz = (name: string) => timestamp(name, { withTimezone: true });
const createdAt = () => timestamptz("created_at").notNull().defaultNow();
const updatedAt = () =>
  timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const money = (name: string) => numeric(name, { precision: 18, scale: 2, mode: "number" });
const emptyTextArray = sql`'{}'::text[]`;

export const regime = pgEnum("regime", [
  "covered",
  "below_threshold",
  "utilities",
  "defence",
  "unknown",
]);
export const tenderStatus = pgEnum("tender_status", ["open", "closed", "awarded", "cancelled"]);
export const documentOrigin = pgEnum("document_origin", ["auto", "manual"]);
export const documentFetchStatus = pgEnum("document_fetch_status", [
  "pending",
  "fetched",
  "needs_manual",
  "failed",
  "unsupported",
]);
export const matchState = pgEnum("match_state", ["new", "seen", "dismissed"]);
export const analysisKind = pgEnum("analysis_kind", ["triage", "deep"]);
export const reviewDecision = pgEnum("review_decision", ["GO", "REVIEW", "NO_GO", "WATCH"]);

/** One row per data source (`uk_fat`, `eu_ted`), seeded by migration. */
export const sources = pgTable("sources", {
  id: text("id").primaryKey(),
  cursor: text("cursor"),
  lastSyncedAt: timestamptz("last_synced_at"),
  lastError: text("last_error"),
}).enableRLS();

/** Untouched API payloads. Identical re-fetches dedupe on sha256; changed payloads add a row. */
export const rawNotices = pgTable(
  "raw_notices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source")
      .notNull()
      .references(() => sources.id),
    externalId: text("external_id").notNull(),
    payload: jsonb("payload").$type<unknown>(),
    payloadXml: text("payload_xml"),
    sha256: text("sha256").notNull(),
    fetchedAt: timestamptz("fetched_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("raw_notices_source_external_id_sha256_idx").on(t.source, t.externalId, t.sha256),
    index("raw_notices_fetched_at_idx").on(t.fetchedAt),
    check("raw_notices_payload_present", sql`${t.payload} is not null or ${t.payloadXml} is not null`),
  ],
).enableRLS();

export const tenders = pgTable(
  "tenders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source")
      .notNull()
      .references(() => sources.id),
    /** Id of the most recent notice applied to this tender. */
    externalId: text("external_id").notNull(),
    /** Groups notices of one procedure (call, corrigendum, award) into a single tender. */
    procedureKey: text("procedure_key").notNull(),
    noticeType: text("notice_type"),
    regime: regime("regime").notNull().default("unknown"),
    status: tenderStatus("status").notNull().default("open"),
    title: text("title").notNull(),
    description: text("description"),
    buyerName: text("buyer_name"),
    /** ISO 3166 alpha-2. */
    buyerCountry: text("buyer_country"),
    nutsCode: text("nuts_code"),
    cpvMain: text("cpv_main"),
    cpvAdditional: text("cpv_additional").array().notNull().default(emptyTextArray),
    valueAmount: money("value_amount"),
    valueCurrency: text("value_currency"),
    valueEur: money("value_eur"),
    publishedAt: timestamptz("published_at"),
    submissionDeadline: timestamptz("submission_deadline"),
    clarificationDeadline: timestamptz("clarification_deadline"),
    procedureType: text("procedure_type"),
    noticeLanguage: text("notice_language"),
    noticeUrl: text("notice_url"),
    documentsPortalUrl: text("documents_portal_url"),
    /** Set when a later notice changes the tender; drives the "değişti" badge. */
    changedAt: timestamptz("changed_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tenders_source_procedure_key_idx").on(t.source, t.procedureKey),
    index("tenders_external_id_idx").on(t.source, t.externalId),
    index("tenders_submission_deadline_idx").on(t.submissionDeadline),
    index("tenders_published_at_idx").on(t.publishedAt),
  ],
).enableRLS();

export const lots = pgTable(
  "lots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenderId: uuid("tender_id")
      .notNull()
      .references(() => tenders.id, { onDelete: "cascade" }),
    lotNumber: text("lot_number").notNull(),
    title: text("title"),
    description: text("description"),
    cpv: text("cpv").array().notNull().default(emptyTextArray),
    valueAmount: money("value_amount"),
    valueCurrency: text("value_currency"),
    quantityText: text("quantity_text"),
  },
  (t) => [uniqueIndex("lots_tender_id_lot_number_idx").on(t.tenderId, t.lotNumber)],
).enableRLS();

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenderId: uuid("tender_id")
      .notNull()
      .references(() => tenders.id, { onDelete: "cascade" }),
    origin: documentOrigin("origin").notNull(),
    sourceUrl: text("source_url"),
    filename: text("filename"),
    mime: text("mime"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    storagePath: text("storage_path"),
    pageCount: integer("page_count"),
    /** Extracted text for DOCX / XLSX; PDFs go to the model as files. */
    textContent: text("text_content"),
    fetchStatus: documentFetchStatus("fetch_status").notNull().default("pending"),
    fetchError: text("fetch_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("documents_tender_id_idx").on(t.tenderId),
    index("documents_sha256_idx").on(t.sha256),
  ],
).enableRLS();

/** Shared CPV taxonomy used by profiles now and manufacturers later. */
export const categories = pgTable("categories", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  cpvPrefixes: text("cpv_prefixes").array().notNull().default(emptyTextArray),
  description: text("description"),
}).enableRLS();

export const criteriaProfiles = pgTable("criteria_profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  active: boolean("active").notNull().default(true),
  /** Validated with the Zod schema in src/matching (SPEC section 6). */
  rules: jsonb("rules").$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}).enableRLS();

/** AI suggestions. Kept apart from human decisions (tender_reviews). */
export const analyses = pgTable(
  "analyses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenderId: uuid("tender_id")
      .notNull()
      .references(() => tenders.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id").references(() => criteriaProfiles.id, { onDelete: "set null" }),
    kind: analysisKind("kind").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    documentIds: uuid("document_ids").array().notNull().default(sql`'{}'::uuid[]`),
    output: jsonb("output").$type<unknown>(),
    valid: boolean("valid").notNull().default(false),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("analyses_tender_id_kind_idx").on(t.tenderId, t.kind, t.createdAt),
    index("analyses_created_at_idx").on(t.createdAt),
  ],
).enableRLS();

export const profileMatches = pgTable(
  "profile_matches",
  {
    profileId: uuid("profile_id")
      .notNull()
      .references(() => criteriaProfiles.id, { onDelete: "cascade" }),
    tenderId: uuid("tender_id")
      .notNull()
      .references(() => tenders.id, { onDelete: "cascade" }),
    matchedAt: timestamptz("matched_at").notNull().defaultNow(),
    filterReasons: jsonb("filter_reasons").$type<unknown>().notNull(),
    triageScore: integer("triage_score"),
    triageAnalysisId: uuid("triage_analysis_id").references(() => analyses.id, {
      onDelete: "set null",
    }),
    state: matchState("state").notNull().default("new"),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.tenderId] }),
    index("profile_matches_tender_id_idx").on(t.tenderId),
    check(
      "profile_matches_triage_score_range",
      sql`${t.triageScore} is null or (${t.triageScore} between 0 and 100)`,
    ),
  ],
).enableRLS();

/** Human decisions, append-only. The latest row per tender is the current decision. */
export const tenderReviews = pgTable(
  "tender_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenderId: uuid("tender_id")
      .notNull()
      .references(() => tenders.id, { onDelete: "cascade" }),
    decision: reviewDecision("decision").notNull(),
    note: text("note"),
    /** Email of the deciding user. */
    decidedBy: text("decided_by").notNull(),
    decidedAt: timestamptz("decided_at").notNull().defaultNow(),
  },
  (t) => [index("tender_reviews_tender_id_decided_at_idx").on(t.tenderId, t.decidedAt)],
).enableRLS();

export type Source = typeof sources.$inferSelect;
export type RawNotice = typeof rawNotices.$inferSelect;
export type Tender = typeof tenders.$inferSelect;
export type NewTender = typeof tenders.$inferInsert;
export type Lot = typeof lots.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type Category = typeof categories.$inferSelect;
export type CriteriaProfile = typeof criteriaProfiles.$inferSelect;
export type ProfileMatch = typeof profileMatches.$inferSelect;
export type Analysis = typeof analyses.$inferSelect;
export type TenderReview = typeof tenderReviews.$inferSelect;
