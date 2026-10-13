import { count } from "drizzle-orm";
import { io } from "next/cache";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { rawNotices, sources, tenders } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import type { SourceId } from "@/sources/types";

const SOURCE_LABELS: Record<string, string> = {
  uk_fat: "Find a Tender (UK)",
  eu_ted: "TED (AB)",
} satisfies Record<SourceId, string>;
const SOURCE_ORDER = Object.keys(SOURCE_LABELS);

const dateTimeFormat = new Intl.DateTimeFormat("tr-TR", {
  timeZone: "Europe/Istanbul",
  dateStyle: "medium",
  timeStyle: "short",
});
const numberFormat = new Intl.NumberFormat("tr-TR");

type SourceStatusRow = {
  id: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  tenderCount: number;
  rawNoticeCount: number;
};

async function loadSourceStatus(): Promise<SourceStatusRow[]> {
  // postgres-js calls Math.random() while it builds its pool, which the
  // App Shell prerender rejects; io() keeps the queries to request time.
  await io();
  const db = getDb();
  const [sourceRows, tenderCounts, rawNoticeCounts] = await Promise.all([
    db.select({ id: sources.id, lastSyncedAt: sources.lastSyncedAt, lastError: sources.lastError }).from(sources),
    db.select({ source: tenders.source, count: count() }).from(tenders).groupBy(tenders.source),
    db.select({ source: rawNotices.source, count: count() }).from(rawNotices).groupBy(rawNotices.source),
  ]);
  const tendersBySource = new Map(tenderCounts.map((row) => [row.source, row.count]));
  const rawNoticesBySource = new Map(rawNoticeCounts.map((row) => [row.source, row.count]));

  return sourceRows
    .map((row) => ({
      ...row,
      tenderCount: tendersBySource.get(row.id) ?? 0,
      rawNoticeCount: rawNoticesBySource.get(row.id) ?? 0,
    }))
    .sort((a, b) => sourceRank(a.id) - sourceRank(b.id) || a.id.localeCompare(b.id));
}

/** Known sources in label order, unknown ids after them. */
function sourceRank(id: string): number {
  const index = SOURCE_ORDER.indexOf(id);
  return index === -1 ? SOURCE_ORDER.length : index;
}

/** Sync status per data source. Reads the session, so render it inside <Suspense>. */
export async function SourceStatus() {
  await getCurrentUser();
  const rows = await loadSourceStatus();

  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">Kayıtlı kaynak yok.</p>;
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Kaynak</TableHead>
            <TableHead>Son başarılı senkron</TableHead>
            <TableHead>Son hata</TableHead>
            <TableHead className="text-right">İhale sayısı</TableHead>
            <TableHead className="text-right">Ham ilan sayısı</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="font-medium">{SOURCE_LABELS[row.id] ?? row.id}</TableCell>
              <TableCell>
                {row.lastSyncedAt ? (
                  dateTimeFormat.format(row.lastSyncedAt)
                ) : (
                  <span className="text-muted-foreground">Henüz yok</span>
                )}
              </TableCell>
              <TableCell className="whitespace-normal">
                {row.lastError ? (
                  // Errors can be up to 2,000 characters; clamp them and keep the full text on hover.
                  <p title={row.lastError} className="line-clamp-2 min-w-48 max-w-md text-destructive wrap-anywhere">
                    {row.lastError}
                  </p>
                ) : (
                  <span className="text-muted-foreground">Yok</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{numberFormat.format(row.tenderCount)}</TableCell>
              <TableCell className="text-right tabular-nums">{numberFormat.format(row.rawNoticeCount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
