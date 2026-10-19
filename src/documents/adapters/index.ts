import { fetchJson } from "../fetch";
import type { DocumentListing, FetchGuard } from "../types";
import { listTenderNedDocuments, tenderNedDocumentKey, tenderNedPublicationId } from "./tenderned";

// Portals whose documents come from their official API (hosts.ts API_HOSTS),
// each through its adapter.

/**
 * The documents a portal's API lists for one of its links (FetchDeps
 * listDocuments), every request through the run's guard, so the portal's
 * robots.txt and spacing hold. Null for a link no adapter answers for.
 */
export async function listPortalDocuments(url: string, guard: FetchGuard): Promise<DocumentListing | null> {
  const tenderNed = tenderNedPublicationId(url);
  if (tenderNed) return listTenderNedDocuments(tenderNed, (address) => fetchJson(address, { guard }));
  return null;
}

/** A document's identity on its portal, the same under each of its addresses (FetchDeps documentKey); null for any other link. */
export function portalDocumentKey(url: string): string | null {
  return tenderNedDocumentKey(url);
}
