import type { PreviewResult } from "@/matching/apply";
import { describeReason, REJECTION_LABELS } from "@/matching/describe";
import type { RuleKey } from "@/matching/types";

// The profile form's live preview as the browser gets it from
// /api/profiles/preview: previewRules' result with its words written here,
// so the matching modules (Zod, the schema) stay out of the browser. The form
// imports only the types.

export type PreviewView = {
  scanned: number;
  matched: number;
  openNow: number;
  /** The rules that turned tenders away, most first. */
  rejections: { rule: RuleKey; label: string; count: number }[];
  /** Most recent matches first, with their first two reasons. */
  examples: { id: string; title: string; publishedAt: string | null; reasons: string[] }[];
};

/** "invalid" while the rules being typed do not pass the schema yet; the form shows why. */
export type PreviewAnswer = { status: "ok"; result: PreviewView } | { status: "invalid"; message: string };

export function previewView(result: PreviewResult): PreviewView {
  return {
    scanned: result.scanned,
    matched: result.matched,
    openNow: result.openNow,
    rejections: (Object.entries(result.rejections) as [RuleKey, number][])
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => ({ rule, label: REJECTION_LABELS[rule], count })),
    examples: result.examples.map((example) => ({
      id: example.id,
      title: example.title,
      publishedAt: example.publishedAt?.toISOString() ?? null,
      reasons: example.reasons.slice(0, 2).map(describeReason),
    })),
  };
}
