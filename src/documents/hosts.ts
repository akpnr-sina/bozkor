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

/** Portals whose terms forbid automated access, with the clause. */
export const NO_AUTOMATION_HOSTS: Readonly<Record<string, string>> = {
  // OWŚUW §3 ust. 7, §5 ust. 4, §7 ust. 8: no automated retrieval, scraping or systematic downloads (8 May 2026). Checked 17 October 2026.
  "platformazakupowa.pl": "platformazakupowa.pl",
  // Terms for unregistered users (April 2016) §4(a): use for own search only; no commercial evaluation, directories, copying or processing. Checked 17 October 2026.
  "deutsche-evergabe.de": "Deutsche eVergabe",
};

export type HostPolicy = "follow" | "forbidden" | "link-only";

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
};

/** The host or a subdomain of it. */
const under = (host: string, listed: string) => host === listed || host.endsWith(`.${listed}`);

export function hostPolicy(url: string | null): HostPolicy {
  const host = url ? hostOf(url) : "";
  if (!host) return "link-only";
  if (Object.keys(NO_AUTOMATION_HOSTS).some((listed) => under(host, listed))) return "forbidden";
  if (Object.keys(FOLLOW_LINKS_HOSTS).some((listed) => under(host, listed))) return "follow";
  return "link-only";
}
