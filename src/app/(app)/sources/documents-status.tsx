import { io } from "next/cache";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { Meter } from "@/components/meter";
import { Notice } from "@/components/notice";
import { Badge, type BadgeVariant } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { getCurrentUser } from "@/lib/auth/session";
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format";
import { FETCH_STATUS_LABELS, loadDocumentsStatus, PLAN_BYTES, type FetchStatus } from "@/documents/status";

/** The usual journey of a link first: fetched, a portal page, still to fetch, then the failures. */
const STATUS_ORDER: FetchStatus[] = ["fetched", "needs_manual", "pending", "failed", "unsupported"];

/** As the tender page's document list colours them: stored, the team's turn, a problem; grey otherwise. */
const STATUS_BADGES: Record<FetchStatus, BadgeVariant> = {
  fetched: "ok",
  needs_manual: "warn",
  pending: "default",
  failed: "err",
  unsupported: "default",
};

/** Storage used against its limit, documents per status and the latest problems. Reads the session, so render it inside <Suspense>. */
export async function DocumentsStatus() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; io() keeps the queries to request time.
  await io();
  const status = await retryRead(() => loadDocumentsStatus(getDb(), new Date()));
  const full = status.storedBytes >= status.limitBytes;
  const total = STATUS_ORDER.reduce((sum, s) => sum + status.byStatus[s], 0);

  return (
    <>
      {full && (
        <Notice tone="err" role="alert" title="Depo sınırı doldu">
          Yeni dosya indirilmiyor ve yüklenemiyor. Kapanmış ihalelerin yüklenen dosyalarını silin.
        </Notice>
      )}
      <div className="grid gap-[18px] lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Doküman deposu</CardTitle>
            <CardDescription>
              Supabase ücretsiz planı {formatBytes(PLAN_BYTES)} dosya saklar; {formatBytes(status.limitBytes)} dolunca yeni dosya indirilmez ve
              yüklenmez.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-heading text-[30px] leading-none font-medium">{formatBytes(status.storedBytes)}</span>
              <span className="font-mono text-[13px] text-ink-500">/ {formatBytes(status.limitBytes)} sınır</span>
            </div>
            <Meter
              value={status.storedBytes}
              max={status.limitBytes}
              tone={full ? "err" : "ink"}
              label="Depo sınırının kullanılan kısmı"
              className="w-full"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Doküman durumu</CardTitle>
            <CardDescription>İlan linklerinden indirilen ve elle yüklenen dosyalar. Portal linklerinin dosyaları ihale sayfasından yüklenir.</CardDescription>
          </CardHeader>
          {total === 0 ? (
            <CardContent>
              <EmptyState>Henüz doküman kaydı yok.</EmptyState>
            </CardContent>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Durum</TableHead>
                  <TableHead className="text-right">Doküman</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {STATUS_ORDER.map((s) => (
                  <TableRow key={s}>
                    <TableCell>
                      <Badge variant={STATUS_BADGES[s]} dot>
                        {FETCH_STATUS_LABELS[s]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono">{formatNumber(status.byStatus[s])}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell className="text-ink-600">Okunmayı bekleyen</TableCell>
                  <TableCell className="text-right font-mono">{formatNumber(status.unread)}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="text-ink-600">Yeniden denenecek</TableCell>
                  <TableCell className="text-right font-mono">{formatNumber(status.retrying)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          )}
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Son doküman sorunları</CardTitle>
        </CardHeader>
        <CardContent>
          {status.recentProblems.length ? (
            <ul className="flex flex-col divide-y divide-line">
              {status.recentProblems.map((problem) => (
                <li key={problem.documentId} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-xs text-ink-500">{formatDateTime(problem.at)}</span>
                    <Badge variant={STATUS_BADGES[problem.status]} dot>
                      {FETCH_STATUS_LABELS[problem.status]}
                    </Badge>
                    <Link href={`/tenders/${problem.tenderId}`} className="font-medium underline-offset-4 hover:underline">
                      {problem.tenderTitle}
                    </Link>
                  </div>
                  <span className="text-[13px] text-ink-600 wrap-anywhere">{problem.document}</span>
                  <p title={problem.message} className="line-clamp-2 max-w-3xl text-[13px] text-err wrap-anywhere">
                    {problem.message}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>Sorun yok.</EmptyState>
          )}
        </CardContent>
      </Card>
    </>
  );
}
