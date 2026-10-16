import { and, desc, eq, inArray } from "drizzle-orm";
import type { AppDb } from "@/db";
import { analyses } from "@/db/schema";
import { translationOutputSchema, type TranslationOutput } from "./translation-schema";

// Read side of the Turkish translations, for pages: no LLM client here.

/**
 * A translation as stored: the model's answer, the fingerprint of the notice
 * texts it translated, and whether the input was cut (the note is added by
 * code, not by the model).
 */
export type StoredTranslation = TranslationOutput & { sourcesHash: string; truncated: boolean };

export function readStoredTranslation(output: unknown): (TranslationOutput & { sourcesHash: string | null; truncated: boolean }) | null {
  const parsed = translationOutputSchema.safeParse(output);
  if (!parsed.success) return null;
  const stored = output as { sourcesHash?: unknown; truncated?: unknown };
  return { ...parsed.data, sourcesHash: typeof stored.sourcesHash === "string" ? stored.sourcesHash : null, truncated: stored.truncated === true };
}

/** The latest valid translation of each tender, keyed by tender id. */
export async function latestTranslations(db: AppDb, tenderIds: readonly string[]) {
  const result = new Map<string, TranslationOutput & { sourcesHash: string | null; truncated: boolean; createdAt: Date; model: string }>();
  if (!tenderIds.length) return result;
  const rows = await db
    .selectDistinctOn([analyses.tenderId], {
      tenderId: analyses.tenderId,
      output: analyses.output,
      createdAt: analyses.createdAt,
      model: analyses.model,
    })
    .from(analyses)
    .where(and(inArray(analyses.tenderId, [...tenderIds]), eq(analyses.kind, "translation"), eq(analyses.valid, true)))
    .orderBy(analyses.tenderId, desc(analyses.createdAt));
  for (const row of rows) {
    const translation = readStoredTranslation(row.output);
    if (translation) result.set(row.tenderId, { ...translation, createdAt: row.createdAt, model: row.model });
  }
  return result;
}
