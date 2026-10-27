import { and, count, countDistinct, eq, gte, isNull } from "drizzle-orm";
import { io } from "next/cache";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { criteriaProfiles, profileMatches, sources, tenders } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { formatAgo, formatDateTime, formatNumber, SOURCE_LABELS } from "@/lib/format";
import { TED_SEARCH_URL } from "@/sources/eu-ted/fields";
import type { SourceId } from "@/sources/types";
import { FAT_API_BASE } from "@/sources/uk-fat/client";
import { syncState, type SyncState } from "../shell-data";

const SOURCE_ORDER = Object.keys(SOURCE_LABELS);

/** Where each source is read, as the clients call it. */
const API_URLS: Record<SourceId, string> = { uk_fat: FAT_API_BASE, eu_ted: TED_SEARCH_URL };

/** When the worker syncs each source: the crons of src/worker/jobs.ts, in Istanbul time. */
const SCHEDULES: Record<SourceId, string> = { uk_fat: "2 saatte bir", eu_ted: "Günde iki kez, 11:30 ve 17:30" };

const STATE_BADGES: Record<SyncState["tone"], { variant: "ok" | "warn" | "err"; label: string }> = {
  ok: { variant: "ok", label: "Çalışıyor" },
  warn: { variant: "warn", label: "Gecikti" },
  err: { variant: "err", label: "Hata" },
};

const DAY_MS = 24 * 60 * 60_000;
/** The window of the found and matched counts. */
const RECENT_DAYS = 30;

type SourceRow = {
  id: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  /** Tenders first seen in the last RECENT_DAYS days. */
  found: number;
  /** Of those, the ones an active profile matches now. */
  matched: number;
};

async function loadSources(now: Date): Promise<SourceRow[]> {
  const db = getDb();
  const since = new Date(now.getTime() - RECENT_DAYS * DAY_MS);
  const [sourceRows, foundRows, matchedRows] = await Promise.all([
    db.select({ id: sources.id, lastSyncedAt: sources.lastSyncedAt, lastError: sources.lastError }).from(sources),
    db.select({ source: tenders.source, n: count() }).from(tenders).where(gte(tenders.createdAt, since)).groupBy(tenders.source),
    db
      .select({ source: tenders.source, n: countDistinct(tenders.id) })
      .from(tenders)
      .innerJoin(profileMatches, and(eq(profileMatches.tenderId, tenders.id), isNull(profileMatches.unmatchedAt)))
      .innerJoin(criteriaProfiles, and(eq(criteriaProfiles.id, profileMatches.profileId), eq(criteriaProfiles.active, true)))
      .where(gte(tenders.createdAt, since))
      .groupBy(tenders.source),
  ]);
  const found = new Map(foundRows.map((row) => [row.source, row.n]));
  const matched = new Map(matchedRows.map((row) => [row.source, row.n]));
  return sourceRows
    .map((row) => ({ ...row, found: found.get(row.id) ?? 0, matched: matched.get(row.id) ?? 0 }))
    .sort((a, b) => sourceRank(a.id) - sourceRank(b.id) || a.id.localeCompare(b.id));
}

/** Known sources in label order, unknown ids after them. */
function sourceRank(id: string): number {
  const index = SOURCE_ORDER.indexOf(id);
  return index === -1 ? SOURCE_ORDER.length : index;
}

const labelOf = (id: string) => SOURCE_LABELS[id as SourceId] ?? id;
/** "api.ted.europa.eu/v3/notices/search": the address without its scheme. */
const shortUrl = (url: string) => url.replace(/^https?:\/\//, "");

/** "3 sa önce", or "az önce" within the minute. */
function ago(date: Date, now: Date): string {
  const short = formatAgo(date, now);
  return short === "şimdi" ? "az önce" : `${short} önce`;
}

/** Each source's last sync, its health and what it brought in. Reads the session, so render it inside <Suspense>. */
export async function SourceStatus() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; io() keeps the queries to request time.
  await io();
  const now = new Date();
  const rows = await retryRead(() => loadSources(now));

  if (rows.length === 0) {
    return <EmptyState>Kayıtlı kaynak yok. Worker ilk senkronda kaynakları ekler.</EmptyState>;
  }

  const failing = rows.filter((row) => row.lastError);
  return (
    <>
      {failing.map((row) => (
        <Notice key={row.id} tone="err" title={`${labelOf(row.id)}: son senkron hatayla bitti`}>
          {/* Errors can be up to 2,000 characters; clamp them and keep the full text on hover. */}
          <p title={row.lastError ?? undefined} className="line-clamp-3 wrap-anywhere">
            {row.lastError}
          </p>
        </Notice>
      ))}
      <Card>
        <CardHeader>
          <CardTitle>Senkron</CardTitle>
          <CardDescription>
            Saatler İstanbul saatine göre. Tespit edilen: son {RECENT_DAYS} günde ilk kez görülen ihaleler; eşleşen: bunlardan aktif bir
            profile uyanlar.
          </CardDescription>
        </CardHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kaynak</TableHead>
              <TableHead>Sıklık</TableHead>
              <TableHead>Son senkron</TableHead>
              <TableHead className="text-right">Tespit edilen</TableHead>
              <TableHead className="text-right">Eşleşen</TableHead>
              <TableHead>Durum</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const state = STATE_BADGES[syncState([row], now).tone];
              const url = API_URLS[row.id as SourceId];
              return (
                <TableRow key={row.id}>
                  <TableCell>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{labelOf(row.id)}</span>
                      {url && <span className="font-mono text-xs text-ink-500">{shortUrl(url)}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-ink-600">{SCHEDULES[row.id as SourceId] ?? "Bilinmiyor"}</TableCell>
                  <TableCell>
                    {row.lastSyncedAt ? (
                      <div className="flex flex-col gap-0.5">
                        <span className="font-mono text-[13px]">{formatDateTime(row.lastSyncedAt)}</span>
                        <span className="text-xs text-ink-500">{ago(row.lastSyncedAt, now)}</span>
                      </div>
                    ) : (
                      <span className="text-ink-500">Henüz yok</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono">{formatNumber(row.found)}</TableCell>
                  <TableCell className="text-right font-mono">{formatNumber(row.matched)}</TableCell>
                  <TableCell>
                    <Badge variant={state.variant} dot>
                      {state.label}
                    </Badge>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
