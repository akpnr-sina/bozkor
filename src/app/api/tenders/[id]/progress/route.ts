import { z } from "zod";
import { tenderProgress } from "@/app/(app)/tenders/[id]/progress";
import { getDb } from "@/db";
import { requireUser } from "@/lib/auth/session";

// What an open tender page asks every 15-20 seconds while files are read or a
// deep analysis runs (refresh-while-reading.tsx, deep-refresh.tsx); the page
// refreshes only when the answer changes.

/** The tender's files still being read and its latest deep analysis request. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) return Response.json({ error: "Geçersiz ihale." }, { status: 400 });
  return Response.json(await tenderProgress(getDb(), parsed.data), { headers: { "Cache-Control": "no-store" } });
}
