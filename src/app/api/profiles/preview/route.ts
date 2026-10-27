import { previewView, type PreviewAnswer } from "@/app/(app)/profiles/preview";
import { getDb } from "@/db";
import { requireUser } from "@/lib/auth/session";
import { previewRules } from "@/matching/apply";
import { profileRulesSchema } from "@/matching/rules";

// The profile form's live preview: how the rules being typed would have done
// over the last 30 days. A route, not a Server Action, so that the browser can
// abort an outdated one and the CPV search does not wait behind it.

/** Rules are a few kilobytes; anything far larger is no form's. */
const MAX_BODY_CHARS = 64_000;

/** The rules as the form sends them (toRules); "invalid" with the first problem while they do not pass yet. */
export async function POST(request: Request) {
  await requireUser();
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return Response.json({ error: "Kurallar çok uzun." }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Gövde JSON değil." }, { status: 400 });
  }
  const parsed = profileRulesSchema.safeParse(body);
  const answer: PreviewAnswer = parsed.success
    ? { status: "ok", result: previewView(await previewRules(getDb(), parsed.data)) }
    : { status: "invalid", message: parsed.error.issues[0]?.message ?? "Kurallar geçersiz." };
  return Response.json(answer, { headers: { "Cache-Control": "no-store" } });
}
