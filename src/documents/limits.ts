// Limits of the documents stage. Supabase's free plan stores 1 GB of files
// and takes at most 50 MB per file.

export const DOCUMENT_LIMITS = {
  /** Largest file fetched, uploaded or extracted from a ZIP. */
  fileBytes: 50 * 1024 * 1024,
  /** All stored files of one tender together. */
  tenderBytes: 200 * 1024 * 1024,
  /** All stored files together: the free plan's storage, less some room. */
  totalBytes: 950 * 1024 * 1024,
  /** Members taken from one ZIP, and their uncompressed total. */
  zipEntries: 200,
  zipBytes: 200 * 1024 * 1024,
  /** Text kept per file; the rest is cut and marked. */
  textChars: 300_000,
  /** One link's answer, redirects and body together, must arrive within this; 50 MB needs a fast server. */
  fetchTimeoutMs: 60_000,
  /** Requests to one host are spaced by at least this. */
  hostIntervalMs: 2_000,
} as const;

/** Sent with every request; says who is asking and how to reach them. */
export const DOCUMENT_USER_AGENT = "Mozilla/5.0 (compatible; BozkorTenderBot/0.1; +mailto:rfq@bozkor.com)";
