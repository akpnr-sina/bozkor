import { parseRetryAfter, sleep, type Sleep } from "@/sources/http";
import { DOCUMENT_LIMITS, DOCUMENT_USER_AGENT } from "./limits";
import { KIND_MIME, OLE2, sniffKind } from "./sniff";
import type { BlockReason, FetchGuard, FetchResult } from "./types";

// Fetches what a document link answers with. Never a login, a form or a
// captcha (CLAUDE.md rule 1): a page comes back with its HTML, and the
// document links of a public one are followed by the caller (portal.ts).
// Anonymous session cookies are kept as a browser would, when a jar is given.
// Redirects are followed by hand, so every hop is checked before it is
// requested: local addresses are refused, and the caller's guard (a site's
// terms, its robots.txt) is asked for each one. Retrying is left to the
// caller (FetchResult.retryable).

export type FetchDocumentOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
  fetch?: typeof fetch;
  /** Cookies the sites set during a run; without one, no cookie is sent. */
  cookies?: CookieJar;
  /**
   * Asked before every request, the redirects' too: a site's terms or its
   * robots.txt may turn an address down, wherever a redirect leads.
   */
  guard?: FetchGuard;
};

const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Bytes read before telling whether the answer is a page. */
const HEAD_BYTES = 1024;
/** A page is read this far, for its login form and its document links; the rest is never downloaded. */
const PAGE_BYTES = 1024 * 1024;
const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
/** Password fields, and the words of login forms in the languages of the portals seen (survey of 16 October 2026). */
const LOGIN =
  /type\s*=\s*["']?password|\blog\s+in\b|\bsign\s+in\b|inloggen|connexion|anmelden|přihlásit|zaloguj|iniciar sesión|autentificare|prisijungti|logg inn|kirjaudu|bejelentkez/iu;
/** Old Office files by extension; all share the OLE2 header. */
const OLE2_MIME: Record<string, string> = {
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  msg: "application/vnd.ms-outlook",
};

const failed = (error: string, status: number | null, retryable: boolean, retryAfterMs: number | null = null): FetchResult => ({
  kind: "failed",
  error,
  status,
  retryable,
  retryAfterMs,
});

/**
 * GETs a document link and says what it answered with. Never throws. What a
 * browser gets past and we do not (a login, a bot block, a redirect loop, a
 * refusal of requests that are not a browser's) is a page the team opens;
 * an address the guard turns down is `blocked`, never requested; other
 * problems are `failed`. One timeout covers the guard, the redirects and the
 * whole body.
 */
export async function fetchDocument(url: string, options: FetchDocumentOptions = {}): Promise<FetchResult> {
  const {
    maxBytes = DOCUMENT_LIMITS.fileBytes,
    timeoutMs = DOCUMENT_LIMITS.fetchTimeoutMs,
    userAgent = DOCUMENT_USER_AGENT,
    fetch: fetchImpl = fetch,
    cookies,
    guard,
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = url;
    // An address with the cookies sent to it: a portal that sets a cookie and
    // sends us back to the same address is answered with the cookie next time.
    const visited = new Set<string>();
    const visit = (address: string) => `${new URL(address).href}\n${cookies?.header(address) ?? ""}`;
    for (let hop = 0; ; hop++) {
      const refusal = urlRefusal(current);
      if (refusal) return failed(refusal, null, false);
      if (guard) {
        let reason: BlockReason | null;
        try {
          // Within the same timeout: a guard that hangs must not hold the run.
          reason = await untilAborted(guard(current), controller.signal);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          return failed(`Erişim kontrolü yapılamadı (${networkDetail(error)}).`, null, true);
        }
        // Not requested: a redirect to a site we may not fetch ends here.
        if (reason) return { kind: "blocked", finalUrl: current, reason };
      }
      visited.add(visit(current));
      const cookie = cookies?.header(current);
      const response = await fetchImpl(current, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": userAgent, Accept: "*/*", ...(cookie ? { Cookie: cookie } : {}) },
        signal: controller.signal,
      });
      cookies?.store(current, response.headers.getSetCookie());
      if (REDIRECT_STATUSES.has(response.status)) {
        await discard(response);
        const location = response.headers.get("location");
        if (!location) return failed(`Yönlendirme adresi gelmedi (HTTP ${response.status}).`, response.status, false);
        let next: string;
        try {
          next = new URL(location, current).href;
        } catch {
          return failed("Geçersiz yönlendirme adresi.", response.status, false);
        }
        // Still going round with the same cookies, or redirecting on and on:
        // such a portal works only in a browser.
        if (visited.has(visit(next)) || hop >= MAX_REDIRECTS) return { kind: "page", finalUrl: current, login: false, html: "" };
        current = next;
        continue;
      }
      if (!response.ok) {
        await discard(response);
        return httpAnswer(response.status, response.headers.get("retry-after"), current);
      }
      return await readAnswer(response, current, maxBytes, controller.signal);
    }
  } catch (error) {
    if (controller.signal.aborted) return failed(`Zaman aşımı: ${Math.round(timeoutMs / 1000)} saniyede yanıt tamamlanmadı.`, null, true);
    return failed(`Bağlantı kurulamadı (${networkDetail(error)}).`, null, true);
  } finally {
    clearTimeout(timer);
  }
}

/** Why a URL is not requested: not http(s), carrying credentials, or a local address. Null when it may be. */
export function urlRefusal(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Geçersiz bağlantı.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Sadece http ve https bağlantıları indirilir.";
  if (parsed.username || parsed.password) return "Kullanıcı adı ya da parola içeren bağlantılar indirilmez.";
  if (isLocalHost(parsed.hostname)) return "Yerel ağ adreslerine istek atılmaz.";
  return null;
}

/**
 * Loopback, private, link-local and similar addresses, as written in the URL
 * (the URL parser normalises 2130706433 and 0x7f.1 to 127.0.0.1). Names that
 * resolve to such addresses are not looked up.
 */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return isLocalV4(Number(v4[1]), Number(v4[2]));
  if (!host.startsWith("[")) return false;
  const v6 = host.slice(1, -1);
  if (v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return true;
  // IPv4-mapped, which the parser writes as hex: [::ffff:7f00:1] is 127.0.0.1.
  const mapped = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(v6);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    return isLocalV4(high >> 8, high & 0xff);
  }
  return false;
}

function isLocalV4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/**
 * An HTTP error. A 429 or 503 may say when to come back (Retry-After, in
 * seconds or as a date); rule 1 asks for that wait, which the caller keeps.
 */
function httpAnswer(status: number, retryAfter: string | null, finalUrl: string): FetchResult {
  if (status === 404 || status === 410) return failed(`Dosya bulunamadı (HTTP ${status}).`, status, false);
  // 408 is the server's own timeout, as transient as ours.
  const retryable = status === 408 || status === 429 || status >= 500;
  if (status >= 400 && status < 500 && !retryable) {
    // A portal login or a bot block (401, 403), or a server that takes
    // requests from browsers only (400, 405, 406...): the team opens the link.
    return { kind: "page", finalUrl, login: status === 401 || status === 403, html: "" };
  }
  const retryAfterMs = status === 429 || status === 503 ? parseRetryAfter(retryAfter, Date.now()) : null;
  const reason =
    status === 429
      ? "Sunucu çok fazla istek geldiğini bildirdi"
      : status === 408
        ? "Sunucu zaman aşımı bildirdi"
        : status >= 500
          ? "Sunucu hatası"
          : "Beklenmeyen yanıt";
  return failed(`${reason} (HTTP ${status}).`, status, retryable, retryAfterMs);
}

function networkDetail(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
  return String(detail).slice(0, 120);
}

/** Lets go of a body we will not read, so the connection is freed. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

async function readAnswer(response: Response, finalUrl: string, maxBytes: number, signal: AbortSignal): Promise<FetchResult> {
  const declared = contentLength(response.headers.get("content-length"));
  if (declared !== null && declared > maxBytes) {
    await discard(response);
    return { kind: "too_large", sizeBytes: declared, finalUrl };
  }
  const contentType = mediaType(response.headers.get("content-type"));
  const body = await readBody(response, maxBytes, signal, (head) => sniffKind(head) === null && isPage(contentType, head));
  // The server's length, if any, was within the limit, so it was not the real one.
  if (body === "too_large") return { kind: "too_large", sizeBytes: null, finalUrl };
  if (!body.length) return failed("Boş yanıt geldi.", response.status, false);

  const filename = filenameOf(response.headers.get("content-disposition"), finalUrl);
  const fileKind = sniffKind(body, filename);
  if (fileKind) return { kind: "file", fileKind, bytes: body, mime: KIND_MIME[fileKind], filename, finalUrl };
  if (isPage(contentType, body)) {
    const html = pageText(body, response.headers.get("content-type"));
    return { kind: "page", finalUrl, login: LOGIN.test(html), html };
  }
  return { kind: "unsupported", mime: unsupportedMime(contentType, body, filename), filename, finalUrl };
}

/**
 * The body, read until it ends; "too_large" as soon as it passes `maxBytes`,
 * without downloading the rest. Once the first bytes show a page, reading
 * stops at PAGE_BYTES: only its start is needed.
 */
async function readBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
  isPageHead: (head: Uint8Array) => boolean,
): Promise<Uint8Array | "too_large"> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let page: boolean | null = null;
  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) return joined(chunks, total);
      chunks.push(value);
      total += value.length;
      if (page === null && (total >= HEAD_BYTES || total > maxBytes)) page = isPageHead(joined(chunks, total));
      if (page && total >= Math.min(PAGE_BYTES, maxBytes)) {
        await reader.cancel().catch(() => {});
        return joined(chunks, total);
      }
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return "too_large";
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }
}

/** Rejects when the signal aborts, for bodies that do not watch it themselves. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The chunks as one array of its own (a chunk may be a view into a larger buffer). */
function joined(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

const latin1 = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes);

function contentLength(header: string | null): number | null {
  const value = header?.trim() ?? "";
  return /^\d+$/.test(value) ? Number(value) : null;
}

/** "text/html; charset=utf-8" as "text/html". */
function mediaType(header: string | null): string | null {
  return header?.split(";")[0]?.trim().toLowerCase() || null;
}

/** HTML by its Content-Type, or by an html tag or doctype in its first bytes. */
function isPage(contentType: string | null, bytes: Uint8Array): boolean {
  if (contentType && HTML_TYPES.has(contentType)) return true;
  return /<!doctype\s+html|<html[\s>]/i.test(latin1(bytes.subarray(0, HEAD_BYTES)));
}

/** The page as text, in the charset its Content-Type or meta tag names; UTF-8 otherwise. */
function pageText(bytes: Uint8Array, contentTypeHeader: string | null): string {
  const label =
    /charset\s*=\s*"?([\w.:-]+)/i.exec(contentTypeHeader ?? "")?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(latin1(bytes.subarray(0, HEAD_BYTES)))?.[1] ??
    "utf-8";
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

const extensionOf = (filename: string | null) => /\.([a-z0-9]{1,5})$/i.exec(filename ?? "")?.[1]?.toLowerCase() ?? "";

function unsupportedMime(contentType: string | null, bytes: Uint8Array, filename: string | null): string {
  if (contentType && contentType !== "application/octet-stream") return contentType;
  if (OLE2.every((b, i) => bytes[i] === b)) return OLE2_MIME[extensionOf(filename)] ?? "application/x-ole-storage";
  return contentType ?? "application/octet-stream";
}

/** The file name from Content-Disposition, otherwise the last part of the URL's path. */
function filenameOf(disposition: string | null, url: string): string | null {
  return cleanFilename(dispositionFilename(disposition)) ?? cleanFilename(urlFilename(url));
}

/** filename* (RFC 6266, in its charset) before filename. */
function dispositionFilename(header: string | null): string | null {
  if (!header) return null;
  // Some servers quote the extended value, which RFC 6266 does not allow.
  const extended = /filename\*\s*=\s*"?([^'"]*)'[^']*'([^;\s"]+)/i.exec(header);
  if (extended) {
    try {
      return new TextDecoder(extended[1] || "utf-8").decode(percentBytes(extended[2]!));
    } catch {
      // An unknown charset: fall back to the plain parameter.
    }
  }
  const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header);
  const value = plain?.[1]?.replace(/\\(.)/g, "$1") ?? plain?.[2]?.trim();
  return value ? utf8FromLatin1(value) : null;
}

function percentBytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const hex = value.slice(i + 1, i + 3);
    if (value[i] === "%" && /^[0-9a-f]{2}$/i.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Header values arrive as Latin-1; servers that put raw UTF-8 in a plain
 * filename ("TechnickÃ¡.pdf") get it back as written ("Technická.pdf").
 */
function utf8FromLatin1(value: string): string {
  if (!/[\u0080-ÿ]/.test(value) || /[^\u0000-ÿ]/.test(value)) return value;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));
  } catch {
    return value;
  }
}

function urlFilename(url: string): string | null {
  const segment = new URL(url).pathname.split("/").filter(Boolean).at(-1);
  if (!segment) return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** A bare file name: no folders or control characters, at most 200 characters with its extension kept. */
function cleanFilename(name: string | null): string | null {
  const base = (name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").split(/[\\/]/).at(-1)?.trim() ?? "";
  if (!base || base === "." || base === "..") return null;
  if (base.length <= 200) return base;
  const ext = /\.[^.]{1,10}$/.exec(base)?.[0] ?? "";
  return base.slice(0, 200 - ext.length) + ext;
}

/**
 * Spaces requests to one host by at least `intervalMs`, measured between
 * their starts. A call takes its host's next free slot before it waits, so
 * concurrent calls queue up instead of starting together.
 */
export function createHostThrottle(
  intervalMs: number = DOCUMENT_LIMITS.hostIntervalMs,
  sleepImpl: Sleep = sleep,
  now: () => number = Date.now,
): { wait(url: string): Promise<void> } {
  const nextFree = new Map<string, number>();
  return {
    async wait(url: string) {
      const host = hostOf(url);
      const start = Math.max(now(), nextFree.get(host) ?? -Infinity);
      nextFree.set(host, start + intervalMs);
      const delay = start - now();
      if (delay > 0) await sleepImpl(delay);
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/\.$/, "");
  } catch {
    return "";
  }
}

/** Cookies a run collects, kept and sent as a browser would (RFC 6265, without the public suffix list). */
export type CookieJar = {
  /** The Cookie header for a request to `url`, or null when no cookie applies. */
  header(url: string): string | null;
  /** Keeps what the Set-Cookie headers of a response to `url` set, and drops what they expire. */
  store(url: string, setCookies: readonly string[]): void;
};

type Cookie = { name: string; value: string; domain: string; hostOnly: boolean; path: string; secure: boolean; expires: number | null; order: number };

/** Cookies a jar keeps, and the longest one; an odd site cannot fill the worker's memory. */
const MAX_COOKIES = 300;
const MAX_COOKIE_CHARS = 4096;

const isIpHost = (host: string) => /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[");

function domainMatches(host: string, domain: string): boolean {
  return host === domain || (!isIpHost(host) && host.endsWith(`.${domain}`));
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  return requestPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/");
}

/** The directory of the request path, where a cookie without Path applies (RFC 6265 5.1.4). */
function defaultPath(pathname: string): string {
  if (!pathname.startsWith("/")) return "/";
  const last = pathname.lastIndexOf("/");
  return last <= 0 ? "/" : pathname.slice(0, last);
}

function parseSetCookie(line: string, url: URL, now: number, order: number): Cookie | null {
  if (line.length > MAX_COOKIE_CHARS) return null;
  const [pair = "", ...attributes] = line.split(";");
  const equals = pair.indexOf("=");
  if (equals <= 0) return null;
  const host = url.hostname.toLowerCase();
  const cookie: Cookie = {
    name: pair.slice(0, equals).trim(),
    value: pair.slice(equals + 1).trim(),
    domain: host,
    hostOnly: true,
    path: defaultPath(url.pathname),
    secure: false,
    expires: null,
    order,
  };
  if (!cookie.name) return null;
  let maxAge: number | null = null;
  for (const attribute of attributes) {
    const at = attribute.indexOf("=");
    const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const value = at < 0 ? "" : attribute.slice(at + 1).trim();
    if (key === "domain" && value) {
      const domain = value.replace(/^\./, "").toLowerCase();
      // Another site's cookie, or one for a whole top-level domain: not kept.
      if (!domainMatches(host, domain) || !domain.includes(".")) return null;
      cookie.domain = domain;
      cookie.hostOnly = domain === host;
    } else if (key === "path" && value.startsWith("/")) {
      cookie.path = value;
    } else if (key === "secure") {
      cookie.secure = true;
    } else if (key === "max-age" && /^-?\d+$/.test(value)) {
      maxAge = Number(value);
    } else if (key === "expires") {
      const time = Date.parse(value);
      if (!Number.isNaN(time)) cookie.expires = time;
    }
  }
  // Max-Age wins over Expires.
  if (maxAge !== null) cookie.expires = maxAge <= 0 ? now - 1 : now + maxAge * 1000;
  return cookie;
}

export function createCookieJar(now: () => number = Date.now): CookieJar {
  const cookies = new Map<string, Cookie>();
  let order = 0;
  return {
    header(url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      const host = parsed.hostname.toLowerCase();
      const time = now();
      const sent = [...cookies.values()]
        .filter(
          (c) =>
            (c.expires === null || c.expires > time) &&
            (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)) &&
            pathMatches(parsed.pathname || "/", c.path) &&
            (!c.secure || parsed.protocol === "https:"),
        )
        // Longer paths first, then the older cookie (RFC 6265 5.4).
        .sort((a, b) => b.path.length - a.path.length || a.order - b.order);
      return sent.length ? sent.map((c) => `${c.name}=${c.value}`).join("; ") : null;
    },
    store(url, setCookies) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      for (const line of setCookies) {
        const cookie = parseSetCookie(line, parsed, now(), order++);
        if (!cookie) continue;
        const key = `${cookie.domain}\n${cookie.path}\n${cookie.name}`;
        const known = cookies.get(key);
        if (cookie.expires !== null && cookie.expires <= now()) {
          cookies.delete(key);
          continue;
        }
        if (!known && cookies.size >= MAX_COOKIES) continue;
        // A replaced cookie keeps its place among the others.
        cookies.set(key, known ? { ...cookie, order: known.order } : cookie);
      }
    },
  };
}
