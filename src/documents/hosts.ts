// What each portal's terms of use allow (CLAUDE.md rule 1: terms are not
// circumvented). robots.txt says nothing of terms, so following the document
// links of a public page is limited to portals whose terms were read and
// allow it; portals whose terms forbid automated access get no request at
// all. Every other link gets the single request its notice invites. Each
// entry was checked by hand on the date given; see SPEC 4.4.

/** Portals whose public pages' document links are followed, with the clause that allows it. */
export const FOLLOW_LINKS_HOSTS: Readonly<Record<string, string>> = {
  // §2(1): "Vergabeunterlagen registrierungsfrei herunterladen"; use for own participation only (§4(1)). Checked 17 October 2026.
  "ausschreibungen.giz.de": "GIZ Vergabemarktplatz",
  // Not evergabe-online.de, although its terms (22.05.2020) allow it: on 18 October 2026 its sessions reset at every
  // request and its download links wanted what only a browser sends (a firewall in front, Wicket's checks). Going
  // further would mean posing as a browser, which rule 1 does not allow. Its notices' links get their single request.
  // Nutzungsbedingungen VMP NRW: free of charge, registration voluntary (§(I)); §(X) no passing documents to third parties. Checked 17 October 2026.
  "evergabe.nrw.de": "Vergabemarktplatz NRW",
};

/**
 * Portals whose documents come from their official API instead of their
 * pages (src/documents/adapters), with the API.
 */
export const API_HOSTS: Readonly<Record<string, string>> = {
  // TNS, the keyless web service listed as the access route on the government's open data page
  // (data.overheid.nl, PIANOo); notices CC0. Checked 19 October 2026.
  "tenderned.nl": "TenderNed",
};

/** Portals whose terms forbid automated access, with the clause. */
export const NO_AUTOMATION_HOSTS: Readonly<Record<string, string>> = {
  // OWŚUW §3 ust. 7, §5 ust. 4, §7 ust. 8: no automated retrieval, scraping or systematic downloads (8 May 2026). Checked 17 October 2026.
  "platformazakupowa.pl": "platformazakupowa.pl",
  // Terms for unregistered users (April 2016) §4(a): use for own search only; no commercial evaluation, directories, copying or processing. Checked 17 October 2026.
  "deutsche-evergabe.de": "Deutsche eVergabe",
  // SICAP terms: access for individual use; systematic retrieval by robots, scripts, crawlers or scrapers forbidden
  // unless the operator authorises the integration; reCAPTCHA. Checked 19 October 2026.
  "e-licitatie.ro": "SICAP",
  // Terms of use (26 May 2026) 1.4 f): no automated data collection (scraping) without prior written authorization;
  // k): no reproduction without authorization. Covers community.vortal.biz. Checked 19 October 2026.
  "vortal.biz": "Vortal",
};

/** "follow": its public pages' document links are taken; "api": its documents come from its API; "forbidden": no request; "link-only": the notice's link once. */
export type HostPolicy = "follow" | "api" | "forbidden" | "link-only";

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
};

/** The host or a subdomain of it. */
const under = (host: string, listed: string) => host === listed || host.endsWith(`.${listed}`);

/** The name a table gives the URL's host (or a domain above it), or null. */
const listedIn = (table: Readonly<Record<string, string>>, url: string | null): string | null => {
  const host = url ? hostOf(url) : "";
  if (!host) return null;
  const listed = Object.keys(table).find((domain) => under(host, domain));
  return listed ? table[listed]! : null;
};

export function hostPolicy(url: string | null): HostPolicy {
  if (listedIn(NO_AUTOMATION_HOSTS, url)) return "forbidden";
  if (listedIn(API_HOSTS, url)) return "api";
  if (listedIn(FOLLOW_LINKS_HOSTS, url)) return "follow";
  return "link-only";
}

/** The API a portal's documents come from (API_HOSTS), unless its terms forbid automated access. */
export const apiOf = (url: string | null): string | null => (hostPolicy(url) === "api" ? listedIn(API_HOSTS, url) : null);

/** Its documents are taken by us: through its public pages' links or through its API. */
export const takesDocuments = (url: string | null) => {
  const policy = hostPolicy(url);
  return policy === "follow" || policy === "api";
};
