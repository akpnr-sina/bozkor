import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { searchCpv } from "@/matching/cpv";

// The profile form's CPV search box (src/app/(app)/profiles/cpv-picker.tsx).
// A route, not a Server Action: the browser runs actions one at a time, and a
// search must not wait behind the live preview.

const input = z.object({ q: z.string().trim().max(100, "Arama en fazla 100 karakter olabilir.") });

/** Goods codes for ?q=: digits begin a code, words are in its English name. */
export async function GET(request: Request) {
  await requireUser();
  const parsed = input.safeParse({ q: new URL(request.url).searchParams.get("q") ?? "" });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  // The vocabulary does not change between deployments.
  return Response.json(searchCpv(parsed.data.q, 30), { headers: { "Cache-Control": "private, max-age=3600" } });
}
