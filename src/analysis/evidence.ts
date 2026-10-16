import { createHash } from "node:crypto";
import { findQuote } from "./quotes";
import { NOTICE_METRICS, readTriageOutput, type NoticeMetric, type TriageOutput, type TriageV1Output } from "./triage-schema";
import type { QuoteSources } from "./types";

// Rule 5 is checked when an answer comes in, against the exact texts the model
// read, and the result is stored with it. Checking later against the current
// notice would mark correct quotes as unverified after a correction.

/** Source key where each quote was found in the text the model saw; null when it was not. */
export type QuoteChecks = {
  reasons: (string | null)[];
  quantityHint: string | null;
  conditionFlags: (string | null)[];
  metrics: Record<NoticeMetric, string | null>;
};

/** Checks stored with triage.v1 answers. */
export type QuoteChecksV1 = {
  reasons: (string | null)[];
  quantityHint: string | null;
  noticeRedFlags: (string | null)[];
};

export function checkQuotes(output: TriageOutput, sources: QuoteSources): QuoteChecks {
  return {
    reasons: output.reasons.map((claim) => findQuote(claim.quote, sources)),
    quantityHint: findQuote(output.quantityHint.quote, sources),
    conditionFlags: output.conditionFlags.map((flag) => findQuote(flag.quote, sources)),
    metrics: Object.fromEntries(NOTICE_METRICS.map((id) => [id, findQuote(output.metrics[id].quote, sources)])) as Record<
      NoticeMetric,
      string | null
    >,
  };
}

/** Fingerprint of the notice texts an analysis read; it changes when the notice does. */
export function sourcesHash(sources: QuoteSources): string {
  const entries = Object.keys(sources)
    .sort()
    .map((key) => [key, sources[key]]);
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** A triage analysis' output: the model's answer plus what was checked when it came in. */
export type StoredTriage = TriageOutput & { quoteChecks: QuoteChecks; sourcesHash: string };

export type ReadTriage =
  | { version: 2; triage: TriageOutput; quoteChecks: QuoteChecks | null; sourcesHash: string | null }
  | { version: 1; triage: TriageV1Output; quoteChecks: QuoteChecksV1 | null; sourcesHash: string | null };

const isList = (value: unknown, length: number) => Array.isArray(value) && value.length === length;

/** The answer and its checks; checks are null when missing or not matching the answer. */
export function readStoredTriage(output: unknown): ReadTriage | null {
  const read = readTriageOutput(output);
  if (!read) return null;
  const stored = output as { quoteChecks?: Record<string, unknown>; sourcesHash?: unknown };
  const checks = stored.quoteChecks;
  const hash = typeof stored.sourcesHash === "string" ? stored.sourcesHash : null;
  if (read.version === 2) {
    const fits =
      !!checks &&
      isList(checks.reasons, read.triage.reasons.length) &&
      isList(checks.conditionFlags, read.triage.conditionFlags.length) &&
      typeof checks.metrics === "object" &&
      checks.metrics !== null;
    return { version: 2, triage: read.triage, quoteChecks: fits ? (checks as QuoteChecks) : null, sourcesHash: hash };
  }
  const fits = !!checks && isList(checks.reasons, read.triage.reasons.length) && isList(checks.noticeRedFlags, read.triage.noticeRedFlags.length);
  return { version: 1, triage: read.triage, quoteChecks: fits ? (checks as QuoteChecksV1) : null, sourcesHash: hash };
}
