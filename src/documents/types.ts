// The contract of the documents stage (SPEC Faz 5). Fetching (fetch.ts),
// extraction (extract.ts), storage (storage.ts) and the worker jobs talk
// through these types only.
//
// A survey on 16 October 2026 (191 links, 129 sites) found 2% of document
// links answering with a file; the rest are e-procurement portal pages, many
// behind a login. Fetching takes what a link answers with and, on a public
// page, the document links it lists (team decision, 17 October 2026), never
// logging in, filling forms or passing a captcha, and keeping to robots.txt
// (CLAUDE.md rule 1); the team downloads the rest from the portal and uploads it.

/** File types the platform reads. Everything else is stored as unsupported or not at all. */
export type FileKind = "pdf" | "docx" | "xlsx" | "zip";

/** Why a guard turns an address down (see FetchResult "blocked"). */
export type BlockReason = "terms" | "robots" | "robots_unavailable";

/** Asked before every request, the first and each redirect's: null to go on, or why not. */
export type FetchGuard = (url: string) => Promise<BlockReason | null>;

/** What a document link answered with. */
export type FetchResult =
  /** A file of a kind we read; `filename` from Content-Disposition or the URL, when there is one. */
  | { kind: "file"; fileKind: FileKind; bytes: Uint8Array; mime: string; filename: string | null; finalUrl: string }
  /**
   * An HTML page: a portal or a login form. `html` is what was read of it
   * (at most the first megabyte, decoded), for the document links a public
   * page lists; behind a login the team opens it and uploads the files.
   */
  | { kind: "page"; finalUrl: string; login: boolean; html: string }
  /** A file of a kind we do not read (an image, a CAD drawing, an old .doc). */
  | { kind: "unsupported"; mime: string; filename: string | null; finalUrl: string }
  /** Larger than the limit; `sizeBytes` from Content-Length when the server sent it. */
  | { kind: "too_large"; sizeBytes: number | null; finalUrl: string }
  /**
   * Not requested: the guard turned down `finalUrl`, the first address or one
   * a redirect led to (a portal whose terms forbid automated access, a path
   * robots.txt closes, or a robots.txt that cannot be read now).
   */
  | { kind: "blocked"; finalUrl: string; reason: BlockReason }
  /**
   * No usable answer: network error, timeout, HTTP error. `retryable` for
   * timeouts, 408, 429 and 5xx; `retryAfterMs` from the Retry-After header
   * of a 429 or 503, which the next attempt waits out (CLAUDE.md rule 1).
   */
  | { kind: "failed"; error: string; status: number | null; retryable: boolean; retryAfterMs: number | null };

/** What extraction found in one file. */
export type Extracted =
  | { kind: "pdf"; pageCount: number; text: string; truncated: boolean }
  | { kind: "docx"; text: string; truncated: boolean }
  | { kind: "xlsx"; text: string; truncated: boolean }
  /** Members of a ZIP that are worth keeping, in archive order; folders and junk are left out. */
  | { kind: "zip"; entries: { name: string; bytes: Uint8Array }[]; skipped: { name: string; reason: string }[] }
  | { kind: "unsupported"; reason: string }
  | { kind: "failed"; error: string };
