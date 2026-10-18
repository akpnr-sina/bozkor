import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { documents, tenders } from "@/db/schema";
import { KIND_MIME } from "./sniff";

/** Bytes the stored files take, each stored object once: of one tender, or of all. */
export async function storedBytes(db: AppDb, tenderId?: string): Promise<number> {
  const stored = await db
    .selectDistinctOn([documents.storagePath], { size: documents.sizeBytes })
    .from(documents)
    .where(tenderId ? and(eq(documents.tenderId, tenderId), isNotNull(documents.storagePath)) : isNotNull(documents.storagePath));
  return stored.reduce((total, row) => total + (row.size ?? 0), 0);
}

/**
 * The files the analysis reads changed (one was read, or deleted): the facts
 * stage reads the tender again. updated_at is left alone; it is the notice's.
 */
export async function markDocumentsChanged(db: AppDb, tenderId: string): Promise<void> {
  await db
    .update(tenders)
    .set({ documentsChangedAt: sql`now()`, updatedAt: sql`${tenders.updatedAt}` })
    .where(eq(tenders.id, tenderId));
}

const READABLE_MIMES = new Set([KIND_MIME.pdf, KIND_MIME.docx, KIND_MIME.xlsx]);

/** The fields that decide whether a document goes into the deep analysis. */
type InputFields = {
  id: string;
  fetchStatus: string;
  stored: boolean;
  processed: boolean;
  mime: string | null;
  pageCount: number | null;
  textChars: number | null;
  sha256: string | null;
};

/**
 * Documents the deep analysis (SPEC 7.2, Faz 6) will read: stored, read by
 * the worker and of a kind it reads, with pages or text, each content once
 * (the first of `docs` with it). A ZIP's members go in, the ZIP does not. A
 * PDF without text still goes in: the model reads its pages as images.
 */
export function analysisInputIds(docs: readonly InputFields[]): Set<string> {
  const ids = new Set<string>();
  const seen = new Set<string>();
  for (const doc of docs) {
    if (doc.fetchStatus !== "fetched" || !doc.stored || !doc.processed || !doc.mime || !READABLE_MIMES.has(doc.mime)) continue;
    if (doc.mime === KIND_MIME.pdf ? !doc.pageCount : !doc.textChars) continue;
    if (doc.sha256) {
      if (seen.has(doc.sha256)) continue;
      seen.add(doc.sha256);
    }
    ids.add(doc.id);
  }
  return ids;
}

export type TenderDocument = Awaited<ReturnType<typeof loadTenderDocuments>>["documents"][number];

/**
 * A tender's documents for its page: the notice's links first (in the order
 * the facts stage reads them), then uploads, each ZIP followed by its members
 * (`depth` 1, or 2 inside a ZIP in a ZIP; `members` counts a row's own). Text
 * itself is not loaded, only its length.
 */
export async function loadTenderDocuments(db: AppDb, tenderId: string) {
  const rows = await db
    .select({
      id: documents.id,
      origin: documents.origin,
      title: documents.title,
      documentType: documents.documentType,
      filename: documents.filename,
      sourceUrl: documents.sourceUrl,
      mime: documents.mime,
      sizeBytes: documents.sizeBytes,
      sha256: documents.sha256,
      pageCount: documents.pageCount,
      fetchStatus: documents.fetchStatus,
      fetchError: documents.fetchError,
      fetchAttempts: documents.fetchAttempts,
      retryAt: documents.retryAt,
      stored: sql<boolean>`${documents.storagePath} is not null`,
      processed: sql<boolean>`${documents.processedAt} is not null`,
      textChars: sql<number | null>`length(${documents.textContent})`,
      textTruncated: documents.textTruncated,
      parentId: documents.parentDocumentId,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .where(eq(documents.tenderId, tenderId))
    .orderBy(
      sql`${documents.origin} = 'manual'`,
      sql`case ${documents.documentType}
        when 'technicalSpecifications' then 0 when 'biddingDocuments' then 1 when 'eligibilityCriteria' then 2
        when 'evaluationCriteria' then 3 when 'contractDraft' then 4 when 'billOfQuantity' then 5 else 6 end`,
      // The facts stage's order (factsDocumentOrder) for the notice's links, so the detail page's fingerprint agrees.
      documents.createdAt,
      documents.id,
    );

  const children = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.parentId) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  }
  const ordered: ((typeof rows)[number] & { depth: number; members: number })[] = [];
  const visit = (row: (typeof rows)[number], depth: number) => {
    ordered.push({ ...row, depth, members: children.get(row.id)?.length ?? 0 });
    for (const child of children.get(row.id) ?? []) visit(child, depth + 1);
  };
  for (const row of rows) if (!row.parentId) visit(row, 0);

  const inputs = analysisInputIds(ordered);
  return {
    documents: ordered.map((row) => ({ ...row, analysisInput: inputs.has(row.id) })),
    storedBytes: await storedBytes(db, tenderId),
  };
}
