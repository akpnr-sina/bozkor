import { DOCUMENT_USER_AGENT } from "./limits";
import { urlRefusal } from "./fetch";
import { hostPolicy } from "./hosts";

// Public procurement pages that list their documents (SPEC Faz 5). Following
// the document links of a page anyone can open is within CLAUDE.md rule 1;
// logins, forms, captchas and JavaScript challenges are not. robots.txt is
// obeyed for every request, and the caller keeps the host spacing.

/** The product token robots.txt groups name us by (DOCUMENT_USER_AGENT carries it). */
export const ROBOTS_AGENT = "BozkorTenderBot";

/** RFC 9309: at least 500 KiB parsed, at most five redirects, cached up to a day. */
const ROBOTS_BYTES = 512 * 1024;
const ROBOTS_REDIRECTS = 5;
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
/** A robots.txt that could not be read is asked for again after this, so the next run tries again. */
const UNREACHABLE_TTL_MS = 5 * 60 * 1000;
const ROBOTS_TIMEOUT_MS = 15_000;

type Rule = { allow: boolean; pattern: string; regex: RegExp };
/** "all" without a robots.txt, "unreachable" while it cannot be read (RFC 9309 2.3.1.4). */
type Policy = Rule[] | "all" | "unreachable";

export type RobotsOptions = {
  fetch?: typeof fetch;
  /** Sent with the robots.txt request. */
  userAgent?: string;
  now?: () => number;
  /** The caller's host spacing; robots.txt requests keep it too. */
  wait?: (url: string) => Promise<void>;
  timeoutMs?: number;
};

/**
 * "unavailable": robots.txt could not be read just now (429, 5xx, a timeout,
 * a network error; RFC 9309 calls this unreachable). Nothing may be fetched
 * meanwhile, and a later run asks again.
 */
export type RobotsVerdict = "allowed" | "disallowed" | "unavailable";

export type Robots = {
  check(url: string): Promise<RobotsVerdict>;
  /** check() === "allowed". */
  allowed(url: string): Promise<boolean>;
};

/** robots.txt patterns: `*` for any characters, a final `$` for the end of the path. */
function patternRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split("*")
    .map((part) => normalizePath(part).replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Non-ASCII characters percent-encoded, as URL paths are, so the two compare (RFC 9309 2.2.2). */
function normalizePath(path: string): string {
  return path.replace(/[^\x21-\x7e]/gu, (c) => encodeURIComponent(c));
}

/**
 * The rules of the groups that name us, or of the "*" groups when none does
 * (RFC 9309 2.2.1). Rules before any user-agent line and other keys
 * (sitemap, crawl-delay) are ignored.
 */
export function robotsRules(text: string, agent: string = ROBOTS_AGENT): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !current) groups.push((current = { agents: [], rules: [] }));
      // "BozkorTenderBot/0.1" names the same product as "BozkorTenderBot".
      current.agents.push(value.split(/[/\s]/)[0]!.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      lastWasAgent = false;
      // An empty rule matches nothing.
      if (value) current.rules.push({ allow: key === "allow", pattern: value, regex: patternRegex(value) });
    } else {
      lastWasAgent = false;
    }
  }
  const token = agent.toLowerCase();
  const ours = groups.filter((g) => g.agents.includes(token));
  return (ours.length ? ours : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
}

/** The most specific (longest) matching rule decides; allow wins a tie. No match: allowed. */
export function robotsAllow(rules: readonly Rule[], pathAndQuery: string): boolean {
  const path = normalizePath(pathAndQuery);
  let best: Rule | null = null;
  for (const rule of rules) {
    if (!rule.regex.test(path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/** The body as text, read no further than `max` bytes. */
async function readText(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(total, max));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.max(0, bytes.length - offset));
    bytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Asks robots.txt before each request, read once a day per site. A missing
 * robots.txt (4xx) allows everything; one that cannot be read (5xx, 429, a
 * timeout, a network error) allows nothing and is asked for again after
 * UNREACHABLE_TTL_MS.
 */
export function createRobots(options: RobotsOptions = {}): Robots {
  const {
    fetch: fetchImpl = fetch,
    userAgent = DOCUMENT_USER_AGENT,
    now = Date.now,
    wait = async () => {},
    timeoutMs = ROBOTS_TIMEOUT_MS,
  } = options;
  const cache = new Map<string, { policy: Promise<Policy>; expiresAt: number }>();

  async function load(origin: string): Promise<Policy> {
    let target = `${origin}/robots.txt`;
    for (let hop = 0; hop <= ROBOTS_REDIRECTS; hop++) {
      if (urlRefusal(target)) return "unreachable";
      // A portal whose terms forbid automated access is never asked, not even
      // for robots.txt. A site that hands its robots.txt to one is most likely
      // that portal's tenant or copy, under the same terms: all of it counts as
      // disallowed, and so stays out for the day.
      if (hostPolicy(target) === "forbidden") return robotsRules("User-agent: *\nDisallow: /");
      await wait(target);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(target, {
          method: "GET",
          redirect: "manual",
          headers: { "User-Agent": userAgent, Accept: "text/plain, */*" },
          signal: controller.signal,
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel().catch(() => {});
          const location = response.headers.get("location");
          if (!location) return "all";
          target = new URL(location, target).href;
          continue;
        }
        if (response.ok) return robotsRules(await readText(response, ROBOTS_BYTES));
        await response.body?.cancel().catch(() => {});
        // Unavailable (RFC 9309 2.3.1.3) allows; unreachable (2.3.1.4) does not, and 429 asks us to wait.
        return response.status === 429 || response.status >= 500 ? "unreachable" : "all";
      } catch {
        return "unreachable";
      } finally {
        clearTimeout(timer);
      }
    }
    // More than five redirects: no robots.txt (RFC 9309 2.3.1.2).
    return "all";
  }

  /** The site's policy, read again a day after it was read, or minutes after it could not be. */
  function policyOf(origin: string): Promise<Policy> {
    const cached = cache.get(origin);
    if (cached && now() < cached.expiresAt) return cached.policy;
    const entry = { policy: load(origin), expiresAt: now() + ROBOTS_TTL_MS };
    void entry.policy.then((policy) => {
      if (policy === "unreachable") entry.expiresAt = now() + UNREACHABLE_TTL_MS;
    });
    cache.set(origin, entry);
    return entry.policy;
  }

  async function check(url: string): Promise<RobotsVerdict> {
    if (urlRefusal(url)) return "disallowed";
    const parsed = new URL(url);
    if (parsed.pathname === "/robots.txt") return "allowed";
    const policy = await policyOf(parsed.origin);
    if (policy === "unreachable") return "unavailable";
    if (policy === "all") return "allowed";
    return robotsAllow(policy, parsed.pathname + parsed.search) ? "allowed" : "disallowed";
  }

  return {
    check,
    async allowed(url) {
      return (await check(url)) === "allowed";
    },
  };
}

// ---------------------------------------------------------------------------
// Document links of a page

/** Links taken from one page. */
export const MAX_PAGE_LINKS = 30;

/** Extensions of documents; the old and the packed ones too, which the worker marks as not read. */
const DOCUMENT_EXTENSION = /\.(pdf|docx?|xlsx?|zip|rar|7z)$/i;
/** "Download" in the languages of the portals seen, without accents and in lower case. */
const DOWNLOAD_WORDS = [
  "download",
  "herunterladen",
  "telecharger",
  "scarica",
  "pobierz",
  "stahnout",
  "stiahnut",
  "prenesi",
  "prenos",
  "atsisiusti",
  "lejupiel",
  "allalaadi",
  "letolt",
  "descargar",
  "descarregar",
  "transferir",
  "ladda ner",
  "last ned",
  "hent",
  "lataa",
  "preuzmi",
  "preuzimanje",
  "descarca",
  "изтегли",
  "свали",
  "κατεβασμα",
  "ληψη",
];
/** A download word at the start of a word: "hent" in "Hent fil", not in "authentication". */
const DOWNLOAD_WORD = new RegExp(`(?<!\\p{L})(?:${DOWNLOAD_WORDS.join("|")})`, "u");
/** Parts of download addresses, anywhere in the path ("FileDownload.aspx" too). */
const DOWNLOAD_PATH = /\/files?\/|download|datoteka|attachment|document/i;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", times: "×",
  laquo: "«", raquo: "»", lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', bull: "•", middot: "·", copy: "©", reg: "®", euro: "€",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", yacute: "ý",
  agrave: "à", egrave: "è", igrave: "ì", ograve: "ò", ugrave: "ù",
  acirc: "â", ecirc: "ê", icirc: "î", ocirc: "ô", ucirc: "û",
  auml: "ä", euml: "ë", iuml: "ï", ouml: "ö", uuml: "ü", yuml: "ÿ",
  atilde: "ã", otilde: "õ", ntilde: "ñ", ccedil: "ç", aring: "å", aelig: "æ", oslash: "ø", szlig: "ß",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", Ccedil: "Ç", Ntilde: "Ñ",
};

/** Text with its character references written out. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

/** Lower case without accents, so "Télécharger" reads "telecharger". */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

const attributesOf = (tag: string): Map<string, string> => {
  const attributes = new Map<string, string>();
  for (const m of tag.matchAll(/([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = m[1]!.toLowerCase();
    if (!attributes.has(name)) attributes.set(name, decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return attributes;
};

const cleanText = (html: string) =>
  decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/** The same site: the same host, or one a subdomain of the other ("www." aside). */
function sameSite(pageHost: string, linkHost: string): boolean {
  const page = pageHost.replace(/^www\./, "");
  const link = linkHost.replace(/^www\./, "");
  if (!link.includes(".")) return false;
  return page === link || link.endsWith(`.${page}`) || page.endsWith(`.${link}`);
}

/**
 * How surely a link is a document: 0 by a file extension (in the path, the
 * text or a query value such as download.php?file=spec.pdf), 1 by a download
 * attribute or a download word in its text, 2 by a download-like path; null
 * when it is not one. A link to the page's own path (other tabs, sorting,
 * "forgot password" on tenderdocuments.html) never counts by its path.
 */
function documentTier(url: URL, text: string, hasDownload: boolean, samePath: boolean): 0 | 1 | 2 | null {
  let path = url.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Kept as written.
  }
  if (DOCUMENT_EXTENSION.test(path) || DOCUMENT_EXTENSION.test(text)) return 0;
  for (const value of url.searchParams.values()) if (DOCUMENT_EXTENSION.test(value)) return 0;
  if (hasDownload || DOWNLOAD_WORD.test(fold(text))) return 1;
  if (samePath) return null;
  return DOWNLOAD_WORD.test(fold(path)) || DOWNLOAD_PATH.test(path) ? 2 : null;
}

/**
 * Links of a public page that look like documents: by extension, by a
 * "download" word in many languages, or by a download-like path. Only http(s)
 * links of the page's site, in page order, each once, at most MAX_PAGE_LINKS.
 */
export function extractDocumentLinks(html: string, pageUrl: string): { url: string; text: string }[] {
  // Scripts, styles and comments hold no links a reader sees. Menus,
  // headers and footers hold the portal's own links (help, software
  // downloads, "forgot password"), not the tender's.
  const visible = html.replace(/<!--[\s\S]*?-->|<(script|style|template|noscript|nav|header|footer)\b[\s\S]*?<\/\1\s*>/gi, " ");
  let base: URL;
  try {
    base = new URL(pageUrl);
    // <base>, not a custom element such as <base-search-input>.
    const href = /<base(?=[\s/>])[^>]*>/i.exec(html)?.[0];
    const baseHref = href ? attributesOf(href.slice(5, -1)).get("href") : undefined;
    if (baseHref) base = new URL(baseHref, base);
  } catch {
    return [];
  }
  const page = new URL(pageUrl);
  page.hash = "";
  // By address, in the order first seen; a later mention may name the file better.
  const found = new Map<string, { text: string; tier: 0 | 1 | 2; order: number }>();

  for (const m of visible.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)) {
    const tag = m[1]!.toLowerCase();
    const attributes = attributesOf(m[2]!);
    const href = attributes.get("href");
    const dataHref = attributes.get("data-href");
    // A script link with its address in data-href.
    const usable = (value: string | undefined) => value && !/^\s*(#|javascript:|mailto:|tel:|data:)/i.test(value);
    const target = tag === "a" && usable(href) ? href : usable(dataHref) ? dataHref : null;
    if (!target) continue;

    let url: URL;
    try {
      url = new URL(target.trim(), base);
    } catch {
      continue;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !sameSite(page.hostname, url.hostname)) continue;
    url.hash = "";
    if (url.href === page.href) continue;

    // The element's own text: an anchor's, or a table row's with a data-href.
    const after = m.index! + m[0].length;
    const end = visible.slice(after, after + 20_000).search(new RegExp(`</${tag}\\s*>`, "i"));
    const inner = end >= 0 ? cleanText(visible.slice(after, after + end)) : "";
    const text = inner || cleanText(attributes.get("title") ?? attributes.get("aria-label") ?? attributes.get("download") ?? "");
    const tier = documentTier(url, text, attributes.has("download"), url.origin === page.origin && url.pathname === page.pathname);
    if (tier === null) continue;
    const known = found.get(url.href);
    if (!known) {
      found.set(url.href, { text, tier, order: found.size });
      continue;
    }
    // "Pobierz" first, "Specyfikacja.pdf" further down: the file's name is the better text.
    if (text && (!known.text || (DOCUMENT_EXTENSION.test(text) && !DOCUMENT_EXTENSION.test(known.text)))) known.text = text;
    known.tier = Math.min(known.tier, tier) as 0 | 1 | 2;
  }
  // When a page lists more, the surest links are kept; they come out in page order.
  return [...found.entries()]
    .sort(([, a], [, b]) => a.tier - b.tier || a.order - b.order)
    .slice(0, MAX_PAGE_LINKS)
    .sort(([, a], [, b]) => a.order - b.order)
    .map(([url, { text }]) => ({ url, text }));
}
