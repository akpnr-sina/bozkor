import { createHash } from "node:crypto";
import { and, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import type { PgInsertValue, PgUpdateSetSource } from "drizzle-orm/pg-core";
import type { AppDb } from "@/db";
import { criteriaProfiles, documents, hostRests, profileMatches, tenderAssessments, tenderReviews, tenders } from "@/db/schema";
import { openTender } from "@/matching/apply";
import { API_HOSTS, apiOf, FOLLOW_LINKS_HOSTS, hostPolicy, takesDocuments } from "./hosts";
import type { RobotsVerdict } from "./portal";
import { DOCUMENT_LIMITS } from "./limits";
import { storedBytes } from "./queries";
import { KIND_EXTENSION } from "./sniff";
import { type DocumentStorage, storagePathFor } from "./storage";
import type { BlockReason, DocumentListing, FetchGuard, FetchResult, FileKind } from "./types";

// Fetches the document links of tenders the team may bid on (SPEC Faz 5).
// A link that answers with a file we read is stored. A public page of a
// portal whose terms allow it gives the files it lists, and a portal with an
// official API lists them through it, over several runs if need be; portals
// whose terms forbid automated access get no request (hosts.ts); the rest is
// left for manual upload. Every request keeps to
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
  /**
   * The documents a portal's official API lists for a link of that portal
   * (API_HOSTS), every request through the guard; null for a link the API
   * does not answer for. Without it, such links are fetched as any other.
   */
  listDocuments?: (url: string, guard: FetchGuard) => Promise<DocumentListing | null>;
  /**
   * A document's identity on its portal, the same under each of its
   * addresses (an API may list one document under several), or null: a link
   * with the key of a document the tender has is that document.
   */
  documentKey?: (url: string) => string | null;
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
  /** Files taken from public portal pages and portal APIs. */
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

/** The link is on one of the portals (or a subdomain), as hostPolicy reads them. */
const onHostOf = (hosts: readonly string[]): SQL => {
  if (!hosts.length) return sql`false`;
  const host = linkHost(documents.sourceUrl);
  return sql`(${sql.join(
    hosts.map((h) => sql`(${host} = ${h} or ${host} like ${`%.${h}`})`),
    sql` or `,
  )})`;
};

/**
 * An API's list of a notice is asked again this long after it was last taken
 * to the end, while the tender is fetched: documents a buyer adds later (the
 * answers to bidders' questions, say) come in too. An API is cheap to ask; a
 * page is read once.
 */
const RELIST_HOURS = 24;

/**
 * Links to fetch: ones not fetched yet; links of portals whose documents are
 * taken that were not taken to the end (processed_at is when a page's or an
 * API's documents were all taken, or were left to the team); and notices whose
 * API list gave documents, a day after it was last read, until the list fails
 * on a few days running or is gone (fetch_attempts).
 */
const toFetch = (): SQL =>
  sql`(${documents.fetchStatus} = 'pending'
    or (${documents.fetchStatus} = 'needs_manual' and ${documents.parentDocumentId} is null and (
      (${documents.processedAt} is null and ${onHostOf([...Object.keys(FOLLOW_LINKS_HOSTS), ...Object.keys(API_HOSTS)])})
      or (${documents.processedAt} < now() - make_interval(hours => ${RELIST_HOURS}) and ${onHostOf(Object.keys(API_HOSTS))}
        and ${documents.fetchAttempts} < ${MAX_ATTEMPTS} and exists (select 1 from ${documents} c where c.parent_document_id = ${documents.id})))))`;

/** Links to fetch of the tenders fetchWanted takes, nearest deadline first. */
export async function pendingFetches(db: AppDb, limit: number) {
  return db
    .select({
      id: documents.id,
      tenderId: documents.tenderId,
      sourceUrl: documents.sourceUrl,
      filename: documents.filename,
      status: documents.fetchStatus,
      attempts: documents.fetchAttempts,
      processedAt: documents.processedAt,
    })
    .from(documents)
    .innerJoin(tenders, eq(tenders.id, documents.tenderId))
    .where(
      and(
        eq(documents.origin, "auto"),
        toFetch(),
        // As isFetchableUrl.
        sql`${documents.sourceUrl} ~* '^https?://'`,
        sql`(${documents.retryAt} is null or ${documents.retryAt} <= now())`,
        // A site resting after a 429 or 503 gets no request, from any of its links.
        sql`not exists (select 1 from ${hostRests} r where r.until > now() and r.host = ${restHostOf(documents.sourceUrl)})`,
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

/**
 * A site as its rests are kept (host_rests): a portal with an official API
 * as a whole (its API_HOSTS domain, subdomains included: its API, files and
 * pages are one service); any other host in lower case, without a trailing
 * dot or a leading "www." (one site either way, and no more: www.gov.uk
 * resting leaves the other gov.uk services alone); "" for a link that is not
 * a URL.
 */
export const restHost = (url: string) => {
  const host = hostOf(url);
  const api = Object.keys(API_HOSTS).find((domain) => host === domain || host.endsWith(`.${domain}`));
  return api ?? host.replace(/^www\./, "");
};
/** restHost of a link, as SQL reads it. */
const restHostOf = (url: SQL | typeof documents.sourceUrl) => {
  const host = sql`regexp_replace(coalesce(${linkHost(url)}, ''), '[.]$', '')`;
  const apis = Object.keys(API_HOSTS).map((domain) => sql`when ${host} = ${domain} or ${host} like ${`%.${domain}`} then ${domain}`);
  return sql`(case ${sql.join(apis, sql` `)} else regexp_replace(${host}, '^www[.]', '') end)`;
};
/** The link is on a site resting now. */
export const isResting = (resting: ReadonlySet<string>, url: string) => {
  const host = restHost(url);
  return host !== "" && resting.has(host);
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
 * A site said to slow down (429 or 503) at `url`, the address that answered:
 * none of its links is requested before `until` (host_rests: whichever row a
 * link is on, links that come due meanwhile too, and redirects to it, through
 * the guard), without an attempt counted (CLAUDE.md rule 1). Its links waiting
 * now say so; a notice whose list was taken to the end keeps its note.
 */
async function restSite(db: AppDb, resting: Set<string>, docId: string, url: string, until: SQL, status: number) {
  const host = restHost(url);
  if (!host) return;
  resting.add(host);
  await db
    .insert(hostRests)
    .values({ host, until, status })
    .onConflictDoUpdate({ target: hostRests.host, set: { until: sql`greatest(${hostRests.until}, excluded.until)`, status, updatedAt: sql`now()` } });
  await db
    .update(documents)
    .set({
      retryAt: until,
      fetchError: sql`case when ${documents.processedAt} is null then ${`Site çok fazla istek geldiğini bildirdi (HTTP ${status}); bekleniyor.`} else ${documents.fetchError} end`,
    })
    .where(
      and(
        eq(documents.origin, "auto"),
        toFetch(),
        sql`${documents.id} <> ${docId}`,
        sql`${restHostOf(documents.sourceUrl)} = ${host}`,
        sql`(${documents.retryAt} is null or ${documents.retryAt} < ${until})`,
      ),
    );
}

/** Sites resting now (host_rests), added to those a run knows of: another run may have rested one meanwhile. */
async function loadRests(db: AppDb, resting: Set<string>) {
  for (const { host } of await db.select({ host: hostRests.host }).from(hostRests).where(sql`${hostRests.until} > now()`)) resting.add(host);
}

/** When a link stopped by a site's rest is tried again: once the rest is over (an hour, should it have none). */
const restEnd = (url: string) =>
  sql`coalesce((select max(${hostRests.until}) from ${hostRests} where ${hostRests.host} = ${restHost(url)}), now() + interval '1 hour')`;

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
async function storeFile(db: AppDb, deps: FetchDeps, tenderId: string, answer: FileAnswer, url: string, listedName: string | null = null): Promise<Stored> {
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
      filename: withKindExtension(answer.filename ?? listedName ?? lastSegment(answer.finalUrl) ?? lastSegment(url), answer.fileKind),
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
/** A link whose robots.txt could not be read is tried an hour later, then hours later: a site's outage may last the night. */
const robotsRetryAt = (attempts: number) => (attempts <= 1 ? inMinutes(ROBOTS_RETRY_MINUTES) : inHours(RETRY_HOURS));
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
 * portal whose terms forbid automated access, no site resting after a 429 or
 * 503, nothing robots.txt closes, nothing while a robots.txt cannot be read,
 * and every request in its host's turn, a redirect to another host too.
 */
const guardOf =
  (deps: FetchDeps, resting: ReadonlySet<string>): FetchGuard =>
  async (url) => {
    if (hostPolicy(url) === "forbidden") return "terms";
    if (isResting(resting, url)) return "resting";
    const verdict = await deps.robots(url);
    if (verdict !== "allowed") return verdict === "disallowed" ? "robots" : "robots_unavailable";
    await deps.wait(url);
    return null;
  };

/** How far a page's (or an API's) document links were taken: all of them, or not yet (with why, and when to go on). */
type PageScan =
  /** `tried`: links requested; `listed`: documents recorded without a file (other kinds, too large, flagged); `known`: links the tender had already. */
  | { taken: number; complete: true; tried: number; listed: number; known: number }
  | { taken: number; complete: false; reason: "share" | "rate" | "robots" | "room"; retryAt: SQL | null };

/** A document link a public page or a portal API gives: the file's name and size when the API tells them, and why it is not fetched (`skip`). */
type ListedLink = { url: string; text: string | null; filename?: string | null; sizeBytes?: number | null; skip?: string | null };

const TENDER_FULL_NOTE = "İhalenin dosya alanı (200 MB) doldu; dosya portaldan indirilmeli.";
const TOO_LARGE_NOTE = "Dosya 50 MB sınırından büyük; portaldan indirilmeli.";

/** A listed document as a row under the page (or the notice link) that listed it. */
const childOf = (page: { id: string; tenderId: string }, link: ListedLink) => ({
  tenderId: page.tenderId,
  origin: "auto" as const,
  parentDocumentId: page.id,
  sourceUrl: link.url,
  title: link.text,
});

/**
 * Takes the documents a public portal page lists (team decision, 17 October
 * 2026) or a portal's official API gives: each link of that portal only
 * (`own`), kept to robots.txt and the host's spacing through the guard, in
 * the same run and with the same cookies as the page (some portals' links
 * live only that long). Files of a kind we read are stored as documents under
 * the page; other files, files too large and files the API flags are listed
 * without a file. A page's links are guesses: those that answer a page or
 * fail are left out (one level only). An API's list is what the documents
 * are (`fromApi`): each one not taken is listed with why, and those that
 * failed in a way worth retrying, or met a site that asked us to wait, wait
 * as links of their own. Links the tender has already are skipped, so a page
 * left unfinished goes on where it stopped the next time.
 */
async function takeListedFiles(
  db: AppDb,
  deps: FetchDeps,
  page: { id: string; tenderId: string },
  links: readonly ListedLink[],
  own: (url: string) => boolean,
  fromApi: boolean,
  resting: Set<string>,
  stats: FetchStats,
): Promise<PageScan | "stop"> {
  const log = deps.log ?? (() => {});
  const guard = guardOf(deps, resting);
  let taken = 0;
  let tried = 0;
  let listed = 0;
  let known = 0;
  const done = (): PageScan => ({ taken, complete: true, tried, listed, known });
  // What the tender has, by link and by portal identity (the same document under another address of its portal).
  const keyOf = deps.documentKey ?? (() => null);
  const urls = new Set<string>();
  const keys = new Set<string>();
  const have = (url: string) => {
    urls.add(url);
    const key = keyOf(url);
    if (key) keys.add(key);
  };
  const isKnown = (url: string) => {
    const key = keyOf(url);
    return urls.has(url) || (key !== null && keys.has(key));
  };
  const rows = await db
    .select({ url: documents.sourceUrl })
    .from(documents)
    .where(and(eq(documents.tenderId, page.tenderId), isNotNull(documents.sourceUrl)));
  for (const { url } of rows) have(url!);
  /** A listed document recorded without a file. */
  const record = async (link: ListedLink, fields: Partial<PgInsertValue<typeof documents>>) => {
    await db
      .insert(documents)
      .values({ ...childOf(page, link), filename: link.filename ?? link.text, ...fields })
      .onConflictDoNothing();
    have(link.url);
    listed++;
  };
  /** Listed for the team without a file: flagged by the API, or larger than any file we keep. */
  const withoutOf = (link: ListedLink) =>
    link.skip ?? (link.sizeBytes != null && link.sizeBytes > DOCUMENT_LIMITS.fileBytes ? TOO_LARGE_NOTE : null);
  /**
   * What is left of an API's list from `from` on, each recorded as `fields`
   * say, or as the list itself says (flagged, too large); what is left of a
   * page is left out.
   */
  const recordRest = async (from: number, fields: Partial<PgInsertValue<typeof documents>>) => {
    if (!fromApi) return;
    for (const link of links.slice(from)) {
      if (!isFetchableUrl(link.url) || !own(link.url) || isKnown(link.url)) continue;
      const without = withoutOf(link);
      await record(link, without ? { fetchStatus: "failed", fetchError: without, processedAt: sql`now()` } : fields);
    }
  };
  const tenderFull = { fetchStatus: "failed" as const, fetchError: TENDER_FULL_NOTE, processedAt: sql`now()` };
  for (const [index, link] of links.entries()) {
    // Only the portal's own files: a link elsewhere is left out.
    if (!isFetchableUrl(link.url) || !own(link.url)) continue;
    // A link the tender has already: a notice link, taken from this page before, or from another link of the tender.
    if (isKnown(link.url)) {
      known++;
      continue;
    }
    const without = withoutOf(link);
    if (without) {
      await record(link, { fetchStatus: "failed", fetchError: without, processedAt: sql`now()` });
      continue;
    }
    // From here a request is needed: the run's and the page's shares end the page for now.
    if (taken >= MAX_PAGE_FILES || stats.pageFiles >= MAX_RUN_PAGE_FILES) return { taken, complete: false, reason: "share", retryAt: null };
    if (isResting(resting, link.url)) {
      if (!fromApi) return { taken, complete: false, reason: "rate", retryAt: restEnd(link.url) };
      // The site rests: the rest of the list waits as links of their own.
      await recordRest(index, { fetchStatus: "pending", retryAt: restEnd(link.url), fetchError: "Site çok fazla istek geldiğini bildirdi; bekleniyor." });
      return done();
    }
    const room = await roomFor(db, page.tenderId);
    if (room.bytes <= 0) {
      if (room.limit === "tender") {
        await recordRest(index, tenderFull);
        return done();
      }
      stats.stoppedBy = "full";
      return { taken, complete: false, reason: "room", retryAt: inHours(ROOM_RETRY_HOURS) };
    }
    // A site another run rested meanwhile is refused by the guard too.
    await loadRests(db, resting);
    let file: FetchResult;
    try {
      file = await deps.fetchDocument(link.url, { guard, maxBytes: room.bytes });
    } catch (error) {
      log(`[documents] ${link.url}: ${errorMessage(error)}`);
      file = { kind: "failed", error: errorMessage(error), status: null, retryable: true, retryAfterMs: null };
    }
    if (file.kind === "blocked") {
      if (file.reason === "resting") {
        // A redirect to a resting site: as above.
        if (!fromApi) return { taken, complete: false, reason: "rate", retryAt: restEnd(file.finalUrl) };
        await recordRest(index, { fetchStatus: "pending", retryAt: restEnd(file.finalUrl), fetchError: "Site çok fazla istek geldiğini bildirdi; bekleniyor." });
        return done();
      }
      if (file.reason === "robots_unavailable") {
        if (!fromApi) return { taken, complete: false, reason: "robots", retryAt: inMinutes(ROBOTS_RETRY_MINUTES) };
        await recordRest(index, {
          fetchStatus: "pending",
          retryAt: inMinutes(ROBOTS_RETRY_MINUTES),
          fetchError: "Sitenin robots.txt dosyası şu an okunamadı; yeniden denenecek.",
        });
        return done();
      }
      if (file.reason === "terms") stats.forbidden++;
      else stats.blocked++;
      if (fromApi) {
        await record(link, { fetchStatus: "needs_manual", fetchError: file.reason === "terms" ? forbiddenNote(file.finalUrl) : ROBOTS_NOTE, processedAt: sql`now()` });
      }
      continue;
    }
    tried++;
    if (file.kind === "too_large") {
      if (room.limit === "tender") {
        await recordRest(index, tenderFull);
        return done();
      }
      if (room.limit === "storage") {
        stats.stoppedBy = "full";
        return { taken, complete: false, reason: "room", retryAt: inHours(ROOM_RETRY_HOURS) };
      }
      if (fromApi) await record(link, { fetchStatus: "failed", fetchAttempts: 1, fetchError: TOO_LARGE_NOTE, processedAt: sql`now()` });
    } else if (file.kind === "file") {
      const stored = await storeFile(db, deps, page.tenderId, file, link.url, link.filename ?? null);
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
        // The tender's room is full: the rest would not fit either.
        await recordRest(index, tenderFull);
        return done();
      }
      await db
        .insert(documents)
        .values({ ...childOf(page, link), ...(stored.values as typeof documents.$inferInsert) })
        .onConflictDoNothing();
      have(link.url);
      taken++;
      stats.pageFiles++;
    } else if (file.kind === "unsupported") {
      await db
        .insert(documents)
        .values({
          ...childOf(page, link),
          filename: file.filename,
          mime: file.mime,
          fetchStatus: "unsupported",
          fetchError: `Okunmayan dosya türü (${file.mime || "bilinmiyor"}).`,
          processedAt: sql`now()`,
        })
        .onConflictDoNothing();
      have(link.url);
      listed++;
    } else if (file.kind === "page") {
      if (fromApi) {
        await record(link, {
          fetchStatus: "needs_manual",
          fetchError: file.login ? "Portal girişi istiyor; dosya portaldan indirilmeli." : "Dosya yerine portal sayfası döndü; dosya portaldan indirilmeli.",
          processedAt: sql`now()`,
        });
      }
    } else if (file.status === 429 || file.status === 503) {
      // The site's other links wait as long, not only this page (CLAUDE.md rule 1).
      const until = retryAtFor(file.retryAfterMs);
      await restSite(db, resting, page.id, file.finalUrl ?? link.url, until, file.status);
      if (!fromApi) return { taken, complete: false, reason: "rate", retryAt: until };
      // The rest of the list, this file too, waits as links of their own.
      await recordRest(index, { fetchStatus: "pending", retryAt: until, fetchError: `Site çok fazla istek geldiğini bildirdi (HTTP ${file.status}); bekleniyor.` });
      return done();
    } else if (fromApi) {
      // Worth retrying: it waits as a link of its own, tried again as any link is. Else listed with why.
      await record(
        link,
        file.retryable
          ? { fetchStatus: "pending", fetchAttempts: 1, retryAt: retryAtFor(file.retryAfterMs), fetchError: file.error }
          : { fetchStatus: "failed", fetchAttempts: 1, fetchError: file.error, processedAt: sql`now()` },
      );
    }
  }
  return done();
}

const forbiddenNote = (url: string) =>
  `Bu portalın kullanım şartları otomatik erişimi yasaklıyor (${hostOf(url)}); dosyalar portaldan indirilmeli.`;
const ROBOTS_NOTE = "Site otomatik erişime kapalı (robots.txt); dosyalar portaldan indirilmeli.";

/** The notes of a portal page or a portal API whose documents are taken, by how far that went. */
type ScanNotes = {
  /** Files taken, and files of the list waiting as links of their own. */
  taken: (files: number, waiting: number) => string;
  waiting: (files: number) => string;
  known: string;
  without: string;
  none: string;
  noFilesRetry: string;
  noFiles: string;
  rate: string;
  robots: string;
  going: (files: number) => string;
  noRoom: string;
  stop: string;
  stopped: string;
};

const PAGE_NOTES: ScanNotes = {
  taken: (files, waiting) => `Portal sayfası; sayfadaki ${files} dosya alındı${waiting ? `, ${waiting} dosya yeniden denenecek` : ""}.`,
  waiting: (files) => `Portal sayfası; ${files} dosya yeniden denenecek.`,
  known: "Portal sayfası; sayfadaki dosyalar ihalede zaten var.",
  without: "Portal sayfası; sayfadaki dosyalardan hiçbiri alınamadı, her birinin nedeni altında yazıyor.",
  none: "Portal sayfası; sayfada indirilecek dosya bulunamadı.",
  noFilesRetry: "Portal sayfası; sayfadaki linkler dosya vermedi, yarın yeniden denenecek.",
  noFiles: "Portal sayfası; sayfadaki linkler dosya vermedi, dosyalar portaldan indirilmeli.",
  rate: "Portal sayfası; site istekleri sınırladığı için kalan dosyalar portaldan indirilmeli.",
  robots: "Portal sayfası; sitenin robots.txt dosyası okunamadığı için kalan dosyalar portaldan indirilmeli.",
  going: (files) => `Portal sayfası; dosyaları alınıyor${files ? `, bu turda ${files} dosya alındı` : ""}.`,
  noRoom: "Portal sayfası; dosya deposunda yer kalmadı, yer açılınca alınacak.",
  stop: "Portal sayfası; dosyaları alınırken depo hata verdi, yeniden denenecek.",
  stopped: "Portal sayfası; depo dosyaları kabul etmedi, dosyalar portaldan indirilmeli.",
};

const apiNotes = (api: string): ScanNotes => ({
  taken: (files, waiting) => `${api} API'si; ${files} dosya alındı${waiting ? `, ${waiting} dosya yeniden denenecek` : ""}.`,
  waiting: (files) => `${api} API'si; ${files} dosya yeniden denenecek.`,
  known: `${api} API'si; listelenen dosyalar ihalede zaten var.`,
  without: `${api} API'si; listelenen dosyalardan hiçbiri alınamadı, her birinin nedeni altında yazıyor.`,
  none: `${api} API'si; alınacak dosya bulunamadı.`,
  noFilesRetry: `${api} API'si; listelenen dosyalar inmedi, yarın yeniden denenecek.`,
  noFiles: `${api} API'si; listelenen dosyalar inmedi, dosyalar portaldan indirilmeli.`,
  rate: `${api} API'si; site istekleri sınırladığı için kalan dosyalar portaldan indirilmeli.`,
  robots: `${api} API'si; sitenin robots.txt dosyası okunamadığı için kalan dosyalar portaldan indirilmeli.`,
  going: (files) => `${api} API'si; dosyalar alınıyor${files ? `, bu turda ${files} dosya alındı` : ""}.`,
  noRoom: `${api} API'si; dosya deposunda yer kalmadı, yer açılınca alınacak.`,
  stop: `${api} API'si; dosyalar alınırken depo hata verdi, yeniden denenecek.`,
  stopped: `${api} API'si; depo dosyaları kabul etmedi, dosyalar portaldan indirilmeli.`,
});

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
  /** Sites resting after a 429 or 503 (restHost), in this run or another; the guard refuses them. */
  const resting = new Set<string>();
  const guard = guardOf(deps, resting);
  for (const doc of await pendingFetches(db, options.limit ?? 30)) {
    if (stats.stoppedBy) break;
    const url = doc.sourceUrl!;
    await loadRests(db, resting);
    if (isResting(resting, url)) continue;
    // The run's share of portal files is taken: links of portals whose documents are taken wait for the next run.
    if (stats.pageFiles >= MAX_RUN_PAGE_FILES && takesDocuments(url)) continue;
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
    /**
     * A notice whose API list was taken to the end before, read again for what
     * is new: it keeps its note until its list is taken to the end again, and a
     * list that fails on a few days running, or is gone, is not asked for again
     * (toFetch counts fetch_attempts).
     */
    const relist = doc.status === "needs_manual" && doc.processedAt !== null;
    /** A list read before that failed is asked again a day later at the soonest: it stops after a few days, not hours. */
    const relistRetryAt = (until: SQL) => sql`greatest(${until}, now() + make_interval(hours => ${RELIST_HOURS}))`;
    const noting = (note: string) => (relist ? {} : { fetchError: note });

    /** A request the guard stopped: the portal's terms, a site's rest, robots.txt, or a robots.txt that could not be read. */
    const blocked = async (reason: BlockReason, finalUrl: string) => {
      if (reason === "resting") {
        // Tried again once the site's rest is over, without an attempt counted.
        await set({ retryAt: restEnd(finalUrl), ...noting("Site çok fazla istek geldiğini bildirdi; bekleniyor.") });
        stats.retry++;
      } else if (reason === "terms" || reason === "robots") {
        if (reason === "terms") stats.forbidden++;
        else stats.blocked++;
        stats.manual++;
        if (relist) await set({ fetchAttempts: MAX_ATTEMPTS });
        else await settled(reason === "terms" ? forbiddenNote(finalUrl) : ROBOTS_NOTE);
      } else {
        // As a failure worth retrying, attempts counted so the link does not wait forever.
        const attempts = doc.attempts + 1;
        if (relist) {
          await set({ fetchAttempts: attempts, retryAt: relistRetryAt(robotsRetryAt(attempts)) });
          stats.retry++;
        } else if (attempts < MAX_ATTEMPTS) {
          await set({ fetchAttempts: attempts, retryAt: robotsRetryAt(attempts), fetchError: "Sitenin robots.txt dosyası şu an okunamadı; yeniden denenecek." });
          stats.retry++;
        } else {
          await settled("Sitenin robots.txt dosyası okunamadı; dosyalar portaldan indirilmeli.");
          stats.manual++;
        }
      }
    };

    /** Takes the documents a portal page or a portal API lists, and notes how far that went. */
    const scan = async (links: readonly ListedLink[], own: (url: string) => boolean, fromApi: boolean, notes: ScanNotes) => {
      stats.manual++;
      // A page is not started with storage nearly full; a list read before only looks for what is new, file by file.
      if (!relist && (await storedBytes(db)) > DOCUMENT_LIMITS.totalBytes - MIN_ROOM_FOR_PAGE) {
        await set({ fetchStatus: "needs_manual", retryAt: inHours(ROOM_RETRY_HOURS), fetchError: notes.noRoom });
        stats.stoppedBy = "full";
        return;
      }
      const taken = await takeListedFiles(db, deps, doc, links, own, fromApi, resting, stats);
      if (taken === "stop") {
        // As a file storage refused: tried again hours later, a few times.
        if (relist) {
          await set({ fetchAttempts: doc.attempts + 1, retryAt: relistRetryAt(retryAtFor(null)) });
        } else if (doc.attempts + 1 < MAX_ATTEMPTS) {
          await set({ fetchStatus: "needs_manual", fetchAttempts: doc.attempts + 1, retryAt: retryAtFor(null), fetchError: notes.stop });
        } else {
          await settled(notes.stopped);
        }
        return;
      }
      if (!taken.complete) {
        // A page whose site keeps asking us to slow down, or whose robots.txt cannot be read: what is left stays with the team.
        const counted = taken.reason === "rate" || taken.reason === "robots";
        if (counted && doc.attempts + 1 >= MAX_ATTEMPTS && !relist) {
          await settled(taken.reason === "rate" ? notes.rate : notes.robots);
        } else {
          await set({
            fetchStatus: "needs_manual",
            retryAt: taken.retryAt,
            fetchAttempts: counted ? doc.attempts + 1 : doc.attempts,
            ...noting(notes.going(taken.taken)),
          });
        }
        return;
      }
      // What all runs took from it, not only this one: a long list is taken over several runs.
      const [children] = await db
        .select({
          all: sql<number>`count(*)::int`,
          files: sql<number>`(count(*) filter (where ${documents.fetchStatus} = 'fetched'))::int`,
          waiting: sql<number>`(count(*) filter (where ${documents.fetchStatus} = 'pending'))::int`,
        })
        .from(documents)
        .where(eq(documents.parentDocumentId, doc.id));
      if (taken.tried > 0 && !children!.all) {
        // Every link answered a page or failed: perhaps the portal's hiccup or a flow we do not follow.
        // Tried again a day later a few times before it is left to the team.
        if (doc.attempts + 1 < MAX_ATTEMPTS) {
          await set({ fetchStatus: "needs_manual", fetchAttempts: doc.attempts + 1, retryAt: inHours(24), fetchError: notes.noFilesRetry });
        } else {
          await settled(notes.noFiles);
        }
        return;
      }
      // Taken to the end: the tries start over (an API's list is asked again a day later).
      const { all, files, waiting } = children!;
      const note = files ? notes.taken(files, waiting) : waiting ? notes.waiting(waiting) : all ? notes.without : taken.known ? notes.known : notes.none;
      await set({ fetchStatus: "needs_manual", fetchError: note, processedAt: sql`now()`, fetchAttempts: 0 });
    };

    const room = await roomFor(db, doc.tenderId);
    if (room.bytes <= 0) {
      if (room.limit === "tender" && relist) {
        // Nothing more fits the tender: its list is looked at again a day later.
        await set({ processedAt: sql`now()` });
      } else if (room.limit === "tender") {
        await set({ fetchStatus: "failed", fetchError: "İhalenin dosya alanı (200 MB) doldu; dosya portaldan indirilmeli." });
        stats.failed++;
      } else {
        await set({ retryAt: inHours(ROOM_RETRY_HOURS) });
        log("[documents] Dosya deposu dolu; indirme durdu.");
        stats.stoppedBy = "full";
      }
      continue;
    }

    // A portal whose documents come from its official API: the API lists them, and they are fetched as any other file.
    const api = apiOf(url);
    if (api && deps.listDocuments) {
      let listing: DocumentListing | null;
      try {
        listing = await deps.listDocuments(url, guard);
      } catch (error) {
        listing = { kind: "failed", error: errorMessage(error), status: null, retryable: true, retryAfterMs: null };
      }
      // null: a link of the portal the API does not answer for (not a notice's page); it is fetched as it is.
      if (listing) {
        if (listing.kind === "blocked") {
          await blocked(listing.reason, listing.finalUrl);
        } else if (listing.kind === "failed") {
          stats.attempted++;
          const until = retryAtFor(listing.retryAfterMs);
          if (listing.status === 429 || listing.status === 503) await restSite(db, resting, doc.id, listing.finalUrl ?? url, until, listing.status);
          if (relist) {
            // Kept with its note: tried again later while worth it; a list that is gone is not asked for again.
            await set(listing.retryable ? { fetchAttempts: doc.attempts + 1, retryAt: relistRetryAt(until) } : { fetchAttempts: MAX_ATTEMPTS });
            stats.retry++;
          } else if (listing.retryable && doc.attempts + 1 < MAX_ATTEMPTS) {
            await set({ fetchAttempts: doc.attempts + 1, retryAt: until, fetchError: `${api} API'si; dosya listesi alınamadı. ${listing.error} Yeniden denenecek.` });
            stats.retry++;
          } else {
            await settled(`${api} API'si; dosya listesi alınamadı. ${listing.error} Dosyalar portaldan indirilmeli.`);
            stats.manual++;
          }
        } else {
          stats.attempted++;
          const links = listing.documents.map((d) => ({ url: d.url, text: d.name, filename: d.name, sizeBytes: d.sizeBytes, skip: d.skip }));
          await scan(links, (link) => apiOf(link) === api, true, apiNotes(api));
        }
        continue;
      }
    }

    let result: FetchResult;
    try {
      result = await deps.fetchDocument(url, { guard, maxBytes: room.bytes });
    } catch (error) {
      result = { kind: "failed", error: errorMessage(error), status: null, retryable: true, retryAfterMs: null };
    }
    if (result.kind !== "blocked") stats.attempted++;

    if (result.kind === "blocked") {
      await blocked(result.reason, result.finalUrl);
    } else if (result.kind === "file") {
      // A file an API listed keeps the name it was listed with when the server sends none.
      const stored = await storeFile(db, deps, doc.tenderId, result, url, doc.filename);
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
      // Where the link led decides: a redirect may end on another site, whose terms were not read.
      if (hostPolicy(result.finalUrl) !== "follow") {
        stats.manual++;
        const note = result.login ? "Portal girişi istiyor." : "Portal sayfası; dosyalar portalda.";
        // A link of a portal whose documents are taken would be picked again at every run: it stays with the team.
        if (takesDocuments(url)) await settled(note);
        // Not marked read: should the portal's terms be found to allow it later, its pages are read then.
        else await set({ fetchStatus: "needs_manual", fetchError: note });
        continue;
      }
      // The login flag is weak here: many portals show a login form in the header and still offer the files.
      const finalUrl = result.finalUrl;
      await scan(deps.extractLinks(result.html, finalUrl), (link) => hostPolicy(link) === "follow", false, PAGE_NOTES);
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
      if (result.status === 429 || result.status === 503) await restSite(db, resting, doc.id, result.finalUrl ?? url, until, result.status);
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
