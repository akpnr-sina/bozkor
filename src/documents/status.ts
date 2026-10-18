import { and, desc, eq, gt, isNotNull, ne, or, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import { documentFetchStatus, documents, tenders } from "@/db/schema";
import { DOCUMENT_LIMITS } from "./limits";
import { storedBytes } from "./queries";

// The documents stage at a glance (SPEC Faz 5), for the settings page and
// `pnpm documents --report`, which show the same numbers.

export type FetchStatus = (typeof documentFetchStatus.enumValues)[number];

/** In the words of the tender page's document list. */
export const FETCH_STATUS_LABELS: Record<FetchStatus, string> = {
  pending: "İndirilmedi",
  fetched: "Depoda",
  needs_manual: "Portalda (elle yüklenecek)",
  failed: "Alınamadı",
  unsupported: "Okunmuyor",
};

/** Supabase's free plan stores this much; the platform stops storing at DOCUMENT_LIMITS.totalBytes. */
export const PLAN_BYTES = 1024 * 1024 * 1024;

export type DocumentProblem = {
  documentId: string;
  tenderId: string;
  tenderTitle: string;
  /** The file name, the notice's description of the link, or the link. */
  document: string;
  status: FetchStatus;
  message: string;
  at: Date;
};

export type DocumentsStatus = {
  storedBytes: number;
  limitBytes: number;
  /** Documents per fetch status; every status is present. */
  byStatus: Record<FetchStatus, number>;
  /** Stored, not read by the worker yet. */
  unread: number;
  /** Waiting for another try after a timeout, a 429, a 5xx or a storage error (not a run's claim on a document). */
  retrying: number;
  /** Latest problems, newest first. A portal page is the usual answer of a link, not a problem. */
  recentProblems: DocumentProblem[];
};

const RECENT_PROBLEMS = 5;

/** The latest documents with a note that needs a look: failures, retries, unreadable or textless files. */
export async function recentProblems(db: AppDb, limit: number): Promise<DocumentProblem[]> {
  const rows = await db
    .select({
      documentId: documents.id,
      tenderId: documents.tenderId,
      tenderTitle: tenders.title,
      filename: documents.filename,
      title: documents.title,
      sourceUrl: documents.sourceUrl,
      status: documents.fetchStatus,
      message: documents.fetchError,
      at: documents.updatedAt,
    })
    .from(documents)
    .innerJoin(tenders, eq(tenders.id, documents.tenderId))
    .where(and(isNotNull(documents.fetchError), ne(documents.fetchStatus, "needs_manual")))
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(limit);
  return rows.map(({ filename, title, sourceUrl, message, ...row }) => ({
    ...row,
    document: filename ?? title ?? sourceUrl ?? "Doküman",
    message: message ?? "",
  }));
}

export async function loadDocumentsStatus(db: AppDb, now: Date): Promise<DocumentsStatus> {
  const [bytes, statusRows, [queue], problems] = await Promise.all([
    storedBytes(db),
    db.select({ status: documents.fetchStatus, count: sql<number>`count(*)::int` }).from(documents).groupBy(documents.fetchStatus),
    db
      .select({
        unread: sql<number>`(count(*) filter (where ${documents.storagePath} is not null and ${documents.processedAt} is null))::int`,
        // A claim (CLAIM_MINUTES) also sets retry_at, but with no failure behind it.
        retrying: sql<number>`(count(*) filter (where ${documents.retryAt} > ${now.toISOString()}::timestamptz
          and (${documents.fetchError} is not null or ${documents.fetchAttempts} > 0)))::int`,
      })
      .from(documents),
    recentProblems(db, RECENT_PROBLEMS),
  ]);
  const byStatus = Object.fromEntries(
    documentFetchStatus.enumValues.map((status) => [status, statusRows.find((row) => row.status === status)?.count ?? 0]),
  ) as Record<FetchStatus, number>;
  return {
    storedBytes: bytes,
    limitBytes: DOCUMENT_LIMITS.totalBytes,
    byStatus,
    unread: queue?.unread ?? 0,
    retrying: queue?.retrying ?? 0,
    recentProblems: problems,
  };
}

// ---------------------------------------------------------------------------
// For `pnpm documents --report`: what the Faz 5 acceptance check looks at.

/** A link's host in lower case, from the URL as stored. */
const linkHost = sql<string>`coalesce(lower(substring(${documents.sourceUrl} from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#:]+)')), '?')`;

/** Links that answered with a portal page, per host, the most first. */
export async function portalHosts(db: AppDb, limit: number): Promise<{ host: string; count: number }[]> {
  return db
    .select({ host: linkHost, count: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.fetchStatus, "needs_manual"))
    .groupBy(linkHost)
    .orderBy(desc(sql`count(*)`), linkHost)
    .limit(limit);
}

export type ClassifiedLink = {
  tenderId: string;
  tenderTitle: string;
  url: string;
  host: string;
  status: FetchStatus;
  message: string | null;
  retryAt: Date | null;
  at: Date;
};

/** The notice's links that have been tried, the latest first. */
export async function recentLinks(db: AppDb, limit: number): Promise<ClassifiedLink[]> {
  const rows = await db
    .select({
      tenderId: documents.tenderId,
      tenderTitle: tenders.title,
      url: documents.sourceUrl,
      host: linkHost,
      status: documents.fetchStatus,
      message: documents.fetchError,
      retryAt: documents.retryAt,
      at: documents.updatedAt,
    })
    .from(documents)
    .innerJoin(tenders, eq(tenders.id, documents.tenderId))
    .where(
      and(
        eq(documents.origin, "auto"),
        isNotNull(documents.sourceUrl),
        or(ne(documents.fetchStatus, "pending"), gt(documents.fetchAttempts, 0)),
      ),
    )
    .orderBy(desc(documents.updatedAt), desc(documents.id))
    .limit(limit);
  return rows.map((row) => ({ ...row, url: row.url ?? "" }));
}
