import { eq } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { documents } from "@/db/schema";
import { createDocumentStorage, storageConfigured } from "@/documents/storage";
import { requireUser } from "@/lib/auth/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A stored document, through a signed link that works for two minutes:
 * downloaded, or shown in the browser with `?view=1` (PDFs).
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/documents/[id]">) {
  await requireUser();
  const { id } = await ctx.params;
  if (!UUID.test(id)) return new NextResponse("Dosya bulunamadı.", { status: 404 });
  if (!storageConfigured()) return new NextResponse("Dosya deposu ayarlı değil.", { status: 503 });
  const [doc] = await getDb()
    .select({ storagePath: documents.storagePath, filename: documents.filename })
    .from(documents)
    .where(eq(documents.id, id));
  if (!doc?.storagePath) return new NextResponse("Dosya bulunamadı.", { status: 404 });
  const url = await createDocumentStorage().signedDownload(doc.storagePath, {
    filename: doc.filename,
    inline: request.nextUrl.searchParams.get("view") === "1",
  });
  return NextResponse.redirect(url, 303);
}
