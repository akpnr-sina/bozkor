import { eq } from "drizzle-orm";
import type { ReadFacts } from "@/analysis/facts-evidence";
import type { FactsOutput } from "@/analysis/facts-schema";
import { byLotNumber } from "@/analysis/notice";
import type { TranslationOutput } from "@/analysis/translation-schema";
import { latestTranslations } from "@/analysis/translations";
import type { AppDb } from "@/db";
import { lots, tenders } from "@/db/schema";
import { lotLabel } from "@/lib/format";
import { cpvItems } from "@/matching/cpv";
import { cpvPrefixOf } from "@/matching/cpv/catalog";
import { latestFacts } from "@/policy/assess";
import type { LotForMatch, MatchInput } from "./types";

// What the manufacturer matcher reads of a tender (SPEC 10, 8.2): its lots with the latest facts, the
// Turkish translation and the CPV codes with their Turkish names. Only the columns it needs: no raw
// payloads, no document texts. The builder is pure; loadMatchInput reads one tender.

export type TenderForMatch = {
  id: string;
  contractNature: LotForMatch["nature"];
  cpvMain: string | null;
  cpvAdditional: string[];
  title: string | null;
  description: string | null;
};

export type LotRowForMatch = { lotNumber: string; title: string | null; description: string | null; cpv: string[]; quantityText: string | null };

export type MatchSources = {
  tender: TenderForMatch;
  /** In lot order (byLotNumber); empty for a tender without lots. */
  lots: readonly LotRowForMatch[];
  /** The latest valid facts as stored, and what the policy may act on (evidencedFacts). */
  facts: { stored: ReadFacts; facts: FactsOutput } | null;
  translation: TranslationOutput | null;
};

/** A CPV code ("31121000-3") as its eight digits, or null for something else. */
const cpvCode = (code: string): string | null => {
  const digits = code.replace(/\D/g, "").slice(0, 8);
  return digits.length === 8 ? digits : null;
};

/** Below a class (four significant digits) a CPV name is a whole field, e.g. "Taşıt ve motor parçaları ile aksesuarları". */
const MIN_NAMED_PREFIX = 4;

/** The Turkish names of the codes, class level or finer, in the codes' order and without repeats. */
export function cpvNamesTr(codes: readonly string[]): string[] {
  const prefixes = codes.map(cpvPrefixOf).filter((p) => p.length >= MIN_NAMED_PREFIX);
  const items = cpvItems(prefixes);
  return [...new Set(prefixes.map((p) => items[p]?.labelTr ?? null).filter((name): name is string => !!name))];
}

/** A title and a description as one text, the title on the first line (match.ts reads it so). */
function joinText(title: string | null | undefined, description: string | null | undefined): string | null {
  const head = title?.replace(/\s+/g, " ").trim() ?? "";
  const body = description?.trim() ?? "";
  if (!head && !body) return null;
  return body ? `${head}\n${body}` : head;
}

const sameLot = (a: string, b: string) => lotLabel(a) === lotLabel(b);

export function buildMatchInput({ tender, lots: lotRows, facts, translation }: MatchSources): MatchInput {
  const tenderCpv = [tender.cpvMain, ...tender.cpvAdditional].map((c) => (c ? cpvCode(c) : null)).filter((c): c is string => !!c);
  const stored = facts?.stored.facts ?? null;
  const checks = facts?.stored.quoteChecks ?? null;
  const certifications = stored
    ? stored.certifications.map((c, i) => ({ name: c.name, level: c.level, verified: !!checks?.certifications[i] }))
    : [];
  // With one lot every fact is that lot's, whatever lot number came with it (as the policy reads them).
  const factsIndex = (lotNumber: string | null): number => {
    if (!stored) return -1;
    if (stored.lots.length === 1 && lotRows.length <= 1) return 0;
    return lotNumber === null ? -1 : stored.lots.findIndex((l) => sameLot(l.lotNumber, lotNumber));
  };

  const build = (row: LotRowForMatch | null): LotForMatch => {
    const i = factsIndex(row?.lotNumber ?? null);
    const raw = i >= 0 ? stored!.lots[i]! : null;
    const verified = i >= 0 ? facts!.facts.lots[i] ?? null : null;
    const lotCpv = (row?.cpv ?? []).map(cpvCode).filter((c): c is string => !!c);
    // With one lot or none the lot is the tender, so the tender's codes are its own when it has none. A lot
    // of several keeps only its own: the matcher decides what the tender's codes say of it (SPEC 10, 8.2).
    const cpv = [...new Set(lotCpv.length || lotRows.length > 1 ? lotCpv : tenderCpv)];
    const translatedLot = row ? translation?.lots.find((l) => sameLot(l.lotNumber, row.lotNumber)) : null;
    const ownText = joinText(row?.title, row?.description);
    return {
      lotNumber: row?.lotNumber ?? "",
      nature: tender.contractNature,
      objectType: verified?.objectType ?? null,
      category: raw?.category ?? null,
      productTr: raw?.productTr.trim() || null,
      productNature: verified?.productNature ?? null,
      cpv,
      cpvNamesTr: cpvNamesTr(cpv),
      textTr: row ? (joinText(translatedLot?.title, translatedLot?.description) ?? (ownText ? null : joinText(translation?.title, translation?.description))) : joinText(translation?.title, translation?.description),
      textOriginal: ownText ?? joinText(tender.title, tender.description),
      quantityText: raw?.quantity.text.trim() || row?.quantityText?.trim() || null,
      certifications,
    };
  };

  return {
    tenderId: tender.id,
    hasFacts: !!facts,
    tenderCpv: [...new Set(tenderCpv)],
    lots: lotRows.length ? lotRows.map(build) : [build(null)],
  };
}

/** The tender as the matcher reads it, or null when there is no such tender. */
export async function loadMatchInput(db: AppDb, tenderId: string): Promise<MatchInput | null> {
  const [tender] = await db
    .select({
      id: tenders.id,
      contractNature: tenders.contractNature,
      cpvMain: tenders.cpvMain,
      cpvAdditional: tenders.cpvAdditional,
      title: tenders.title,
      description: tenders.description,
    })
    .from(tenders)
    .where(eq(tenders.id, tenderId));
  if (!tender) return null;
  const [lotRows, facts, translations] = await Promise.all([
    db
      .select({ lotNumber: lots.lotNumber, title: lots.title, description: lots.description, cpv: lots.cpv, quantityText: lots.quantityText })
      .from(lots)
      .where(eq(lots.tenderId, tenderId)),
    latestFacts(db, [tenderId]),
    latestTranslations(db, [tenderId]),
  ]);
  const latest = facts.get(tenderId);
  return buildMatchInput({
    tender,
    lots: lotRows.sort(byLotNumber),
    facts: latest ? { stored: latest.stored, facts: latest.facts } : null,
    translation: translations.get(tenderId) ?? null,
  });
}
