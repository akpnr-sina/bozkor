import { z } from "zod";
import { getDb } from "@/db";
import { requireUser } from "@/lib/auth/session";
import { matchManufacturers, type ManufacturersAnswer } from "@/manufacturers/match";
import { loadMatchInput } from "@/manufacturers/match-input";
import { loadManufacturerPool } from "@/manufacturers/projection";

// The tender page's "Uygun üreticileri bul" (SPEC 10, 8.2): the pool's candidates for each lot, worked
// out on each click from the pool the web process keeps (one small read of the latest import id) and the
// tender's lots, facts and translation. Nothing is written. A route, not a Server Action, so the decision
// form does not wait behind it and the browser can drop an outdated request.

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) return Response.json({ error: "Geçersiz ihale." }, { status: 400 });
  const db = getDb();
  const [pool, input] = await Promise.all([loadManufacturerPool(db), loadMatchInput(db, parsed.data)]);
  if (!input) return Response.json({ error: "İhale bulunamadı." }, { status: 404, headers: NO_STORE });
  const answer: ManufacturersAnswer = pool ? { pool: pool.poolVersion, result: matchManufacturers(input, pool) } : { pool: null };
  return Response.json(answer, { headers: NO_STORE });
}
