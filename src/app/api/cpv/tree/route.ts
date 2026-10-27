import { z } from "zod";
import { requireUser } from "@/lib/auth/session";
import { cpvChildren } from "@/matching/cpv";

// The profile form's CPV tree (src/app/(app)/profiles/cpv-picker.tsx), loaded
// a level at a time as the team opens it.

const input = z.object({ prefix: z.union([z.literal(""), z.string().regex(/^\d{2,8}$/, "Önek 2 ile 8 rakam arasında olmalı.")]) });

/** The codes under ?prefix=; without one, the goods divisions. */
export async function GET(request: Request) {
  await requireUser();
  const parsed = input.safeParse({ prefix: new URL(request.url).searchParams.get("prefix") ?? "" });
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message }, { status: 400 });
  return Response.json(cpvChildren(parsed.data.prefix || null), { headers: { "Cache-Control": "private, max-age=3600" } });
}
