import { randomUUID } from "node:crypto";
import type { AppDb } from "@/db";
import { analyses, criteriaProfiles, documents, profileMatches, tenderAssessments, tenderReviews, tenders } from "@/db/schema";
import type { Status } from "@/policy/engine";

/** Small builders for database tests that need a tender in a given state. */

const DAY = 24 * 60 * 60 * 1000;

export async function insertTender(db: AppDb, fields: Partial<typeof tenders.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(tenders)
    .values({
      source: "uk_fat",
      externalId: randomUUID(),
      procedureKey: randomUUID(),
      title: "Supply of generator sets",
      submissionDeadline: new Date(Date.now() + 30 * DAY),
      ...fields,
    })
    .returning({ id: tenders.id });
  return row!.id;
}

export async function insertProfile(db: AppDb, active = true): Promise<string> {
  const [row] = await db.insert(criteriaProfiles).values({ name: "Güç", active, rules: {} }).returning({ id: criteriaProfiles.id });
  return row!.id;
}

export async function insertMatch(db: AppDb, profileId: string, tenderId: string, fields: Partial<typeof profileMatches.$inferInsert> = {}) {
  await db.insert(profileMatches).values({ profileId, tenderId, filterReasons: {}, ...fields });
}

/** A policy verdict, with the facts analysis it needs. */
export async function insertAssessment(db: AppDb, tenderId: string, status: Status) {
  const [analysis] = await db
    .insert(analyses)
    .values({ tenderId, kind: "facts", model: "claude-haiku-5-5", promptVersion: "facts.v4", valid: true })
    .returning({ id: analyses.id });
  await db.insert(tenderAssessments).values({
    tenderId,
    factsAnalysisId: analysis!.id,
    policyVersion: "policy.v3",
    status,
    bestLot: "",
    explanation: "",
    fitLow: 50,
    fitHigh: 70,
    preliminaryLow: 40,
    preliminaryHigh: 60,
    confidence: 50,
  });
}

export async function insertDecision(db: AppDb, tenderId: string, decision: "GO" | "REVIEW" | "NO_GO" | "WATCH" | null, decidedAt = new Date()) {
  await db.insert(tenderReviews).values({ tenderId, decision, decidedBy: "ekip@bozkor.com", decidedAt });
}

export async function insertDocument(db: AppDb, fields: typeof documents.$inferInsert): Promise<string> {
  const [row] = await db.insert(documents).values(fields).returning({ id: documents.id });
  return row!.id;
}
