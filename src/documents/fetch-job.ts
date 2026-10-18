import { createHash } from "node:crypto";
import { and, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { AppDb } from "@/db";
import { criteriaProfiles, documents, profileMatches, tenderAssessments, tenderReviews, tenders } from "@/db/schema";
import { openTender } from "@/matching/apply";
import { FOLLOW_LINKS_HOSTS, hostPolicy } from "./hosts";
import type { RobotsVerdict } from "./portal";
import { DOCUMENT_LIMITS } from "./limits";
import { storedBytes } from "./queries";
import { KIND_EXTENSION } from "./sniff";
import { type DocumentStorage, storagePathFor } from "./storage";
import type { FetchGuard, FetchResult, FileKind } from "./types";

// Fetches the document links of tenders the team may bid on (SPEC Faz 5).
// A link that answers with a file we read is stored. A public page of a
// portal whose terms allow it gives the files it lists, over several runs if
// need be; portals whose terms forbid automated access get no request
// (hosts.ts); the rest is left for manual upload. Every request keeps to
// robots.txt. Failures worth retrying (timeouts, 429, 5xx) are tried again a
// few times, hours apart or after the server's Retry-After, and a host that
// asked us to slow down gets no more requests.

export const MAX_ATTEMPTS = 3;
const RETRY_HOURS = 6;
/**
 * A document being worked on is claimed for this long (retry_at), so a
 * second run beside the worker (a command, say) leaves it alone; a run that
 * dies lets go when the time is up.
 */
export const CLAIM_MINUTES = 15;
/** A Retry-After longer than this is not waited out in full; the deadline is near anyway. */
const MAX_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Verdicts after which the team will not bid (WATCH: this tender is not worth it); their links are not fetched. */
const CLOSED_VERDICTS = ["COMMERCIAL_NO_BID", "NO_BID", "HARD_REJECT", "EXPIRED", "WATCH"];

export type FetchDeps = {
  /** fetchDocument with the guard every request (redirects included) must pass, and the room left for the file. */
  fetchDocument: (url: string, options: { guard: FetchGuard; maxBytes: number }) => Promise<FetchResult>;
  /** Waits for the host's turn (one request at a time per host, spaced); the guard calls it before every request. */
  wait: (url: string) => Promise<void>;
  /** What robots.txt says of the URL (CLAUDE.md rule 1). */
  robots: (url: string) => Promise<RobotsVerdict>;
  /** The document links a public page lists. */
  extractLinks: (html: string, pageUrl: string) => { url: string; text: string | null }[];
  storage: DocumentStorage;
  log?: (message: string) => void;
};

export type FetchStats = {
  attempted: number;
  fetched: number;
  manual: number;
  unsupported: number;
  failed: number;
  retry: number;
  /** Files taken from public portal pages. */
  pageFiles: number;
  /** Links robots.txt kept us from. */
  blocked: number;
  /** Links not requested at all: their portal's terms forbid automated access. */
  forbidden: number;
  /** Storage refused a file or is full; the run stopped, since the next files would fail too. */
  stoppedBy: "storage" | "full" | null;
};

export type { RobotsVerdict };

export const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Tenders whose links are fetched: open ones with a current match of an
 * active profile, a verdict that leaves a bid possible (or none yet) and no
 * NO_GO as the latest decision, or whose latest decision is GO, REVIEW or WATCH.
 */
export function fetchWanted(): SQL {
  const latestDecision = sql`(select r.decision from ${tenderReviews} r where r.tender_id = ${tenders.id} order by r.decided_at desc limit 1)`;
  return and(
    openTender(),
    sql`(
      (
        exists (
          select 1 from ${profileMatches} pm join ${criteriaProfiles} cp on cp.id = pm.profile_id and cp.active
          where pm.tender_id = ${tenders.id} and pm.unmatched_at is null
        )
        and coalesce((select ta.status from ${tenderAssessments} ta where ta.tender_id = ${tenders.id}), '')
          not in (${sql.join(CLOSED_VERDICTS.map((s) => sql`${s}`), sql`, `)})
        and ${latestDecision} is distinct from 'NO_GO'
      )
      or ${latestDecision} in ('GO', 'REVIEW', 'WATCH')
    )`,
  )!;
}

/** Whether the tender's links are fetched now (fetchWanted). */
export async function isFetchWanted(db: AppDb, tenderId: string): Promise<boolean> {
  const [row] = await db.select({ id: tenders.id }).from(tenders).where(and(eq(tenders.id, tenderId), fetchWanted()));
  return Boolean(row);
}

/** Only web links are requested. */
export const isFetchableUrl = (url: string | null) => !!url && /^https?:\/\//i.test(url);

/** A link's host as SQL reads it, to find the other links of a site. */
const linkHost = (url: SQL | typeof documents.sourceUrl) => sql`lower(substring(${url} from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#:]+)'))`;

/** The link is on a portal whose pages' document links are followed (as hostPolicy). */
const onFollowHost = (): SQL => {
  const hosts = Object.keys(FOLLOW_LINKS_HOSTS);
  if (!hosts.length) return sql`false`;
  const host = linkHost(documents.sourceUrl);
  return sql`(${sql.join(
    hosts.map((h) => sql`(${host} = ${h} or ${host} like ${`%.${h}`})`),
    sql` or `,
  )})`;
};

/**
 * Links to fetch: ones not fetched yet, and portal pages of portals whose
 * links are followed that were not read to the end (processed_at is when a
 * page's document links were all taken).
 */
const toFetch = (): SQL =>
  sql`(${documents.fetchStatus} = 'pending'
    or (${documents.fetchStatus} = 'needs_manual' and ${documents.processedAt} is null and ${documents.parentDocumentId} is null and ${onFollowHost()}))`;

/** Links to fetch of the tenders fetchWanted takes, nearest deadline first. */
export async function pendingFetches(db: AppDb, limit: number) {
  return db
    .select({ id: documents.id, tenderId: documents.tenderId, sourceUrl: documents.sourceUrl, attempts: documents.fetchAttempts })
    .from(documents)
    .innerJoin(tenders, eq(tenders.id, documents.tenderId))
    .where(
      and(
        eq(documents.origin, "auto"),
        toFetch(),
        // As isFetchableUrl.
        sql`${documents.sourceUrl} ~* '^https?://'`,
        sql`(${documents.retryAt} is null or ${documents.retryAt} <= now())`,
        fetchWanted(),
      ),
    )
    .orderBy(sql`${tenders.submissionDeadline} asc nulls last`, documents.createdAt, documents.id)
    .limit(limit);
}

const lastSegment = (url: string) => {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    return name || null;
  } catch {
    return null;
  }
};

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
};

/** Web page endings that download links often carry ("FileDownload.aspx" for a PDF). */
const PAGE_EXTENSION = /\.(aspx?|ashx|php|jsp|do|cgi|html?)$/i;

/** The file name with the extension of what the file is, so it opens when downloaded. */
export function withKindExtension(filename: string | null, kind: FileKind): string | null {
  if (!filename) return null;
  const ext = KIND_EXTENSION[kind];
  if (filename.toLowerCase().endsWith(ext)) return filename;
  return filename.replace(PAGE_EXTENSION, "") + ext;
}

/** When to try a failed link again: hours later, or after the server's Retry-After when that is longer. */
const retryAtFor = (retryAfterMs: number | null) => {
  const ms = Math.max(RETRY_HOURS * 60 * 60 * 1000, Math.min(retryAfterMs ?? 0, MAX_RETRY_AFTER_MS));
  return sql`now() + make_interval(secs => ${Math.ceil(ms / 1000)})`;
};

/**
 * A site said to slow down (429 or 503): its other links waiting to be
 * fetched wait as long as the failed one, without an attempt counted (CLAUDE.md rule 1).
 */
async function restSite(db: AppDb, docId: string, until: SQL, status: number) {
  const host = sql`(select ${linkHost(documents.sourceUrl)} from ${documents} where ${documents.id} = ${docId})`;
  await db
    .update(documents)
    .set({ retryAt: until, fetchError: `Site çok fazla istek geldiğini bildirdi (HTTP ${status}); bekleniyor.` })
    .where(
      and(
        eq(documents.origin, "auto"),
        eq(documents.fetchStatus, "pending"),
        sql`${documents.id} <> ${docId}`,
        sql`${linkHost(documents.sourceUrl)} = ${host}`,
        sql`(${documents.retryAt} is null or ${documents.retryAt} < ${until})`,
      ),
    );
}

type FileAnswer = Extract<FetchResult, { kind: "file" }>;

/** Where a fetched file went: stored (or found stored already) with what was read of it, or why not. */
type Stored =
  | { ok: true; values: PgUpdateSetSource<typeof documents> }
  | { ok: false; reason: "tender_full" | "storage_full" | "storage_error"; error?: string };

/**
 * Stores a fetched file of a tender, once per content and within the
 * tender's and the storage's limits. The fields to write on its document
 * come back; the same file read before needs no second reading.
 */
async function storeFile(db: AppDb, deps: FetchDeps, tenderId: string, answer: FileAnswer, url: string): Promise<Stored> {
  const sha = sha256Of(answer.bytes);
  const [existing] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.tenderId, tenderId), eq(documents.sha256, sha), isNotNull(documents.storagePath)))
    .limit(1);
  if (!existing) {
    if ((await storedBytes(db, tenderId)) + answer.bytes.length > DOCUMENT_LIMITS.tenderBytes) return { ok: false, reason: "tender_full" };
    if ((await storedBytes(db)) + answer.bytes.length > DOCUMENT_LIMITS.totalBytes) return { ok: false, reason: "storage_full" };
  }
  const path = existing?.storagePath ?? storagePathFor(tenderId, sha, answer.fileKind);
  if (!existing) {
    try {
      await deps.storage.upload(path, answer.bytes, answer.mime);
    } catch (error) {
      return { ok: false, reason: "storage_error", error: errorMessage(error) };
    }
  }
  return {
    ok: true,
    values: {
      fetchStatus: "fetched",
      filename: withKindExtension(answer.filename ?? lastSegment(answer.finalUrl) ?? lastSegment(url), answer.fileKind),
      mime: answer.mime,
      sizeBytes: answer.bytes.length,
      sha256: sha,
      storagePath: path,
      pageCount: existing?.pageCount ?? null,
      textContent: existing?.textContent ?? null,
      textTruncated: existing?.textTruncated ?? false,
      processedAt: existing?.processedAt ?? null,
      fetchError: existing?.processedAt ? existing.fetchError : null,
    },
  };
}

/** Files taken from one public page in one run, and from the pages of one run; a page not finished goes on in the next run. */
const MAX_PAGE_FILES = 20;
const MAX_RUN_PAGE_FILES = 60;
/** When a robots.txt that could not be read is asked again. */
const ROBOTS_RETRY_MINUTES = 60;
/** When a file that found no room in storage is tried again. */
const ROOM_RETRY_HOURS = 24;
/** A page is not started with less room than this left in storage. */
const MIN_ROOM_FOR_PAGE = 5 * 1024 * 1024;

const inHours = (hours: number) => sql`now() + make_interval(hours => ${hours})`;
const inMinutes = (minutes: number) => sql`now() + make_interval(mins => ${minutes})`;

/** Room left for one more file of the tender, and what limits it. */
async function roomFor(db: AppDb, tenderId: string): Promise<{ bytes: number; limit: "file" | "tender" | "storage" }> {
  const [tenderBytes, totalBytes] = await Promise.all([storedBytes(db, tenderId), storedBytes(db)]);
  const tender = DOCUMENT_LIMITS.tenderBytes - tenderBytes;
  const total = DOCUMENT_LIMITS.totalBytes - totalBytes;
  if (total < tender && total < DOCUMENT_LIMITS.fileBytes) return { bytes: Math.max(0, total), limit: "storage" };
  if (tender < DOCUMENT_LIMITS.fileBytes) return { bytes: Math.max(0, tender), limit: "tender" };
  return { bytes: DOCUMENT_LIMITS.fileBytes, limit: "file" };
}

/**
 * The guard of every request, redirects included (CLAUDE.md rule 1): no
 * portal whose terms forbid automated access, nothing robots.txt closes,
 * nothing while a robots.txt cannot be read, and every request in its host's
 * turn, a redirect to another host too.
 */
const guardOf =
  (deps: FetchDeps): FetchGuard =>
  async (url) => {
    if (hostPolicy(url) === "forbidden") return "terms";
    const verdict = await deps.robots(url);
    if (verdict !== "allowed") return verdict === "disallowed" ? "robots" : "robots_unavailable";
    await deps.wait(url);
    return null;
  };

/** How far a page's document links were taken: all of them, or not yet (with why, and when to go on). */
type PageScan =
  /** `tried`: links requested; `listed`: files of kinds we do not read, listed all the same. */
  | { taken: number; complete: true; tried: number; listed: number }
  | { taken: number; complete: false; reason: "share" | "rate" | "robots" | "room"; retryAt: SQL | null };

/**
 * Follows the document links a public portal page lists (team decision, 17
 * October 2026), on portals whose terms allow it: each link of such a portal
 * only, kept to robots.txt and the host's spacing through the guard, in the
 * same run and with the same cookies as the page (some portals' links live
 * only that long). Files of a kind we read are stored as documents under the
 * page; other files are listed as unsupported; pages and failures are left
 * out (one level only). Links the tender has already are skipped, so a page
 * left unfinished goes on where it stopped the next time.
 */
async function takePageFiles(
  db: AppDb,
  deps: FetchDeps,
  page: { id: string; tenderId: string },
  answer: Extract<FetchResult, { kind: "page" }>,
  resting: Set<string>,
  stats: FetchStats,
): Promise<PageScan | "stop"> {
  const log = deps.log ?? (() => {});
  const guard = guardOf(deps);
  let taken = 0;
  let tried = 0;
  let listed = 0;
  const done = (): PageScan => ({ taken, complete: true, tried, listed });
  for (const link of deps.extractLinks(answer.html, answer.finalUrl)) {
    // Only the allowed portals' own files: a link elsewhere is left out.
    if (!isFetchableUrl(link.url) || hostPolicy(link.url) !== "follow") continue;
    // A link the tender has already: a notice link, or taken from this page before.
    const [known] = await db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.tenderId, page.tenderId), eq(documents.sourceUrl, link.url)))
      .limit(1);
    if (known) continue;
    // From here a request is needed: the run's and the page's shares end the page for now.
    if (taken >= MAX_PAGE_FILES || stats.pageFiles >= MAX_RUN_PAGE_FILES) return { taken, complete: false, reason: "share", retryAt: null };
    if (resting.has(hostOf(link.url))) return { taken, complete: false, reason: "rate", retryAt: retryAtFor(null) };
    const room = await roomFor(db, page.tenderId);
    if (room.bytes <= 0) {
      if (room.limit === "tender") return done();
      stats.stoppedBy = "full";
      return { taken, complete: false, reason: "room", retryAt: inHours(ROOM_RETRY_HOURS) };
    }
    let file: FetchResult;
    try {
      file = await deps.fetchDocument(link.url, { guard, maxBytes: room.bytes });
    } catch (error) {
      log(`[documents] ${link.url}: ${errorMessage(error)}`);
      continue;
    }
    const child = { tenderId: page.tenderId, origin: "auto" as const, parentDocumentId: page.id, sourceUrl: link.url, title: link.text };
    if (file.kind === "blocked") {
      if (file.reason === "robots_unavailable") return { taken, complete: false, reason: "robots", retryAt: inMinutes(ROBOTS_RETRY_MINUTES) };
      if (file.reason === "terms") stats.forbidden++;
      else stats.blocked++;
      continue;
    }
    tried++;
    if (file.kind === "too_large" && room.limit !== "file") {
      if (room.limit === "tender") return done();
      stats.stoppedBy = "full";
      return { taken, complete: false, reason: "room", retryAt: inHours(ROOM_RETRY_HOURS) };
    }
    if (file.kind === "file") {
      const stored = await storeFile(db, deps, page.tenderId, file, link.url);
      if (!stored.ok) {
        if (stored.reason === "storage_error") {
          log(`[documents] ${link.url}: ${stored.error}`);
          stats.stoppedBy = "storage";
          return "stop";
        }
        if (stored.reason === "storage_full") {
          stats.stoppedBy = "full";
          return { taken, complete: false, reason: "room", retryAt: inHours(ROOM_RETRY_HOURS) };
        }
        // The tender's room is full: the rest of the page would not fit either.
        return done();
      }
      await db
        .insert(documents)
        .values({ ...child, ...(stored.values as typeof documents.$inferInsert) })
        .onConflictDoNothing();
      taken++;
      stats.pageFiles++;
    } else if (file.kind === "unsupported") {
      await db
        .insert(documents)
        .values({
          ...child,
          filename: file.filename,
          mime: file.mime,
          fetchStatus: "unsupported",
          fetchError: `Okunmayan dosya türü (${file.mime || "bilinmiyor"}).`,
          processedAt: sql`now()`,
        })
        .onConflictDoNothing();
      listed++;
    } else if (file.kind === "failed" && (file.status === 429 || file.status === 503)) {
      resting.add(hostOf(link.url));
      return { taken, complete: false, reason: "rate", retryAt: retryAtFor(file.retryAfterMs) };
    }
  }
  return done();
}

const forbiddenNote = (url: string) =>
  `Bu portalın kullanım şartları otomatik erişimi yasaklıyor (${hostOf(url)}); dosyalar portaldan indirilmeli.`;
const ROBOTS_NOTE = "Site otomatik erişime kapalı (robots.txt); dosyalar portaldan indirilmeli.";

export async function fetchDocuments(db: AppDb, deps: FetchDeps, options: { limit?: number } = {}): Promise<FetchStats> {
  const stats: FetchStats = {
    attempted: 0,
    fetched: 0,
    manual: 0,
    unsupported: 0,
    failed: 0,
    retry: 0,
    pageFiles: 0,
    blocked: 0,
    forbidden: 0,
    stoppedBy: null,
  };
  const log = deps.log ?? (() => {});
  // Full storage: nothing is fetched only to be thrown away.
  if ((await storedBytes(db)) >= DOCUMENT_LIMITS.totalBytes) {
    log("[documents] Dosya deposu dolu; indirme yapılmadı.");
    return { ...stats, stoppedBy: "full" };
  }
  const guard = guardOf(deps);
  /** Hosts that answered 429 or 503 in this run; their other links wait for a later run. */
  const resting = new Set<string>();
  for (const doc of await pendingFetches(db, options.limit ?? 30)) {
    if (stats.stoppedBy) break;
    const url = doc.sourceUrl!;
    if (resting.has(hostOf(url))) continue;
    // The run's share of page files is taken: pages of allowed portals wait for the next run.
    if (stats.pageFiles >= MAX_RUN_PAGE_FILES && hostPolicy(url) === "follow") continue;
    const [claimed] = await db
      .update(documents)
      .set({ retryAt: sql`now() + make_interval(mins => ${CLAIM_MINUTES})` })
      .where(and(eq(documents.id, doc.id), toFetch(), sql`(${documents.retryAt} is null or ${documents.retryAt} <= now())`))
      .returning({ id: documents.id });
    if (!claimed) continue;
    /** Ends the claim; a failure worth retrying sets the next attempt's time instead. */
    const set = (fields: PgUpdateSetSource<typeof documents>) =>
      db.update(documents).set({ retryAt: null, ...fields, updatedAt: sql`now()` }).where(eq(documents.id, doc.id));
    /** A portal page that is all it will be: its links were taken, or are not to be taken. */
    const settled = (note: string) => set({ fetchStatus: "needs_manual", fetchError: note, processedAt: sql`now()` });

    const room = await roomFor(db, doc.tenderId);
    if (room.bytes <= 0) {
      if (room.limit === "tender") {
        await set({ fetchStatus: "failed", fetchError: "İhalenin dosya alanı (200 MB) doldu; dosya portaldan indirilmeli." });
        stats.failed++;
      } else {
        await set({ retryAt: inHours(ROOM_RETRY_HOURS) });
        log("[documents] Dosya deposu dolu; indirme durdu.");
        stats.stoppedBy = "full";
      }
      continue;
    }
    let result: FetchResult;
    try {
      result = await deps.fetchDocument(url, { guard, maxBytes: room.bytes });
    } catch (error) {
      result = { kind: "failed", error: errorMessage(error), status: null, retryable: true, retryAfterMs: null };
    }
    if (result.kind !== "blocked") stats.attempted++;

    if (result.kind === "blocked") {
      if (result.reason === "terms") {
        await settled(forbiddenNote(result.finalUrl));
        stats.forbidden++;
        stats.manual++;
      } else if (result.reason === "robots") {
        await settled(ROBOTS_NOTE);
        stats.blocked++;
        stats.manual++;
      } else {
        // As a failure worth retrying, attempts counted so the link does not wait forever.
        const attempts = doc.attempts + 1;
        if (attempts < MAX_ATTEMPTS) {
          await set({ fetchAttempts: attempts, retryAt: inMinutes(ROBOTS_RETRY_MINUTES), fetchError: "Sitenin robots.txt dosyası şu an okunamadı; yeniden denenecek." });
          stats.retry++;
        } else {
          await settled("Sitenin robots.txt dosyası okunamadı; dosyalar portaldan indirilmeli.");
          stats.manual++;
        }
      }
    } else if (result.kind === "file") {
      const stored = await storeFile(db, deps, doc.tenderId, result, url);
      if (stored.ok) {
        await set({ ...stored.values, fetchAttempts: 0 });
        stats.fetched++;
      } else if (stored.reason === "tender_full") {
        await set({ fetchStatus: "failed", fetchError: "İhalenin dosya alanı (200 MB) doldu; dosya portaldan indirilmeli." });
        stats.failed++;
      } else if (stored.reason === "storage_full") {
        // Tried again once files are deleted or the plan grows, not at every run.
        await set({ retryAt: inHours(ROOM_RETRY_HOURS), fetchError: "Dosya deposunda yer kalmadı; yer açılınca yeniden denenecek." });
        log("[documents] Dosya deposu dolu; indirme durdu.");
        stats.stoppedBy = "full";
      } else {
        log(`[documents] ${url}: ${stored.error}`);
        const attempts = doc.attempts + 1;
        await set(
          attempts < MAX_ATTEMPTS
            ? { fetchAttempts: attempts, retryAt: retryAtFor(null), fetchError: "Dosya depoya yazılamadı; yeniden denenecek." }
            : { fetchStatus: "failed", fetchAttempts: attempts, fetchError: "Dosya depoya yazılamadı." },
        );
        stats.retry++;
        stats.stoppedBy = "storage";
      }
    } else if (result.kind === "page") {
      stats.manual++;
      // Where the link led decides: a redirect may end on another site, whose terms were not read.
      if (hostPolicy(result.finalUrl) !== "follow") {
        // Not marked read: should the portal's terms be found to allow it later, its pages are read then.
        await set({ fetchStatus: "needs_manual", fetchError: result.login ? "Portal girişi istiyor." : "Portal sayfası; dosyalar portalda." });
        continue;
      }
      if ((await storedBytes(db)) > DOCUMENT_LIMITS.totalBytes - MIN_ROOM_FOR_PAGE) {
        await set({ fetchStatus: "needs_manual", retryAt: inHours(ROOM_RETRY_HOURS), fetchError: "Portal sayfası; dosya deposunda yer kalmadı, yer açılınca alınacak." });
        stats.stoppedBy = "full";
        continue;
      }
      // The login flag is weak here: many portals show a login form in the header and still offer the files.
      const scan = await takePageFiles(db, deps, doc, result, resting, stats);
      if (scan === "stop") {
        await set({ fetchStatus: "needs_manual", fetchError: "Portal sayfası; dosyaları alınırken depo hata verdi, yeniden denenecek." });
      } else if (scan.complete && scan.tried > 0 && !scan.taken && !scan.listed) {
        // Every link answered a page or failed: perhaps the portal's hiccup or a flow we do not follow.
        // Tried again a day later a few times before the page is left to the team.
        if (doc.attempts + 1 < MAX_ATTEMPTS) {
          await set({
            fetchStatus: "needs_manual",
            fetchAttempts: doc.attempts + 1,
            retryAt: inHours(24),
            fetchError: "Portal sayfası; sayfadaki linkler dosya vermedi, yarın yeniden denenecek.",
          });
        } else {
          await settled("Portal sayfası; sayfadaki linkler dosya vermedi, dosyalar portaldan indirilmeli.");
        }
      } else if (scan.complete) {
        await settled(scan.taken ? `Portal sayfası; sayfadaki ${scan.taken} dosya alındı.` : "Portal sayfası; sayfada indirilecek dosya bulunamadı.");
      } else if (scan.reason === "rate" && doc.attempts + 1 >= MAX_ATTEMPTS) {
        // A site that keeps asking us to slow down: what is left of the page stays with the team.
        await settled("Portal sayfası; site istekleri sınırladığı için kalan dosyalar portaldan indirilmeli.");
      } else {
        await set({
          fetchStatus: "needs_manual",
          retryAt: scan.retryAt,
          fetchAttempts: scan.reason === "rate" ? doc.attempts + 1 : doc.attempts,
          fetchError: `Portal sayfası; dosyaları alınıyor${scan.taken ? `, bu turda ${scan.taken} dosya alındı` : ""}.`,
        });
      }
    } else if (result.kind === "unsupported") {
      await set({ fetchStatus: "unsupported", fetchError: `Okunmayan dosya türü (${result.mime || "bilinmiyor"}).` });
      stats.unsupported++;
    } else if (result.kind === "too_large") {
      if (room.limit === "storage") {
        await set({ retryAt: inHours(ROOM_RETRY_HOURS), fetchError: "Dosya deposunda yer kalmadı; yer açılınca yeniden denenecek." });
        stats.stoppedBy = "full";
      } else if (room.limit === "tender") {
        await set({ fetchStatus: "failed", fetchError: "İhalenin dosya alanı (200 MB) doldu; dosya portaldan indirilmeli." });
        stats.failed++;
      } else {
        await set({ fetchStatus: "failed", fetchError: "Dosya 50 MB sınırından büyük; portaldan indirilmeli." });
        stats.failed++;
      }
    } else {
      const until = retryAtFor(result.retryAfterMs);
      if (result.status === 429 || result.status === 503) {
        resting.add(hostOf(url));
        await restSite(db, doc.id, until, result.status);
      }
      if (result.retryable && doc.attempts + 1 < MAX_ATTEMPTS) {
        await set({ fetchAttempts: doc.attempts + 1, retryAt: until, fetchError: result.error });
        stats.retry++;
      } else {
        await set({ fetchStatus: "failed", fetchAttempts: doc.attempts + 1, fetchError: result.error });
        stats.failed++;
      }
    }
  }
  return stats;
}
