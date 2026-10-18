import { io } from "next/cache";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { getCurrentUser } from "@/lib/auth/session";
import { formatBytes, formatDateTime, formatNumber } from "@/lib/format";
import { FETCH_STATUS_LABELS, loadDocumentsStatus, PLAN_BYTES, type FetchStatus } from "@/documents/status";

/** The usual journey of a link first: fetched, a portal page, still to fetch, then the failures. */
const STATUS_ORDER: FetchStatus[] = ["fetched", "needs_manual", "pending", "failed", "unsupported"];

/** Storage used against its limit, documents per status and the latest problems. Reads the session, so render it inside <Suspense>. */
export async function DocumentsStatus() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; io() keeps the queries to request time.
  await io();
  const status = await retryRead(() => loadDocumentsStatus(getDb(), new Date()));
  const share = Math.min(1, status.storedBytes / status.limitBytes);
  const full = status.storedBytes >= status.limitBytes;
  const total = STATUS_ORDER.reduce((sum, s) => sum + status.byStatus[s], 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-muted-foreground">Depo kullanımı</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatBytes(status.storedBytes)}
            <span className="text-sm font-normal text-muted-foreground"> / {formatBytes(status.limitBytes)} sınır</span>
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Depo sınırının kullanılan kısmı"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(share * 100)}
          className="h-2 overflow-hidden rounded-full bg-muted"
        >
          <div className={full ? "h-full bg-destructive" : "h-full bg-primary"} style={{ width: `${share * 100}%` }} />
        </div>
        <p className="text-xs text-muted-foreground">
          Supabase ücretsiz planı {formatBytes(PLAN_BYTES)} dosya saklar; {formatBytes(status.limitBytes)} dolunca yeni dosya indirilmez ve yüklenmez.
        </p>
        {full && (
          <p role="alert" className="text-sm text-destructive">
            Depo sınırı doldu: yeni dosya indirilmiyor ve yüklenemiyor. Kapanmış ihalelerin yüklenen dosyalarını silin.
          </p>
        )}
      </div>

      {total === 0 ? (
        <p className="text-sm text-muted-foreground">Henüz doküman kaydı yok.</p>
      ) : (
        <div className="rounded-lg border">
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
                  <TableCell>{FETCH_STATUS_LABELS[s]}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(status.byStatus[s])}</TableCell>
                </TableRow>
              ))}
              <TableRow>
                <TableCell className="text-muted-foreground">Okunmayı bekleyen</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(status.unread)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-muted-foreground">Yeniden denenecek</TableCell>
                <TableCell className="text-right tabular-nums">{formatNumber(status.retrying)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex flex-col gap-2 text-sm">
        <span className="text-muted-foreground">Son sorunlar</span>
        {status.recentProblems.length ? (
          <ul className="flex flex-col gap-3">
            {status.recentProblems.map((problem) => (
              <li key={problem.documentId} className="flex flex-col gap-0.5">
                <span>
                  {formatDateTime(problem.at)},{" "}
                  <Link href={`/tenders/${problem.tenderId}`} className="underline underline-offset-4">
                    {problem.tenderTitle}
                  </Link>
                </span>
                <span className="text-muted-foreground wrap-anywhere">
                  {problem.document} ({FETCH_STATUS_LABELS[problem.status]})
                </span>
                <p title={problem.message} className="line-clamp-2 max-w-2xl text-destructive wrap-anywhere">
                  {problem.message}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-muted-foreground">Sorun yok</span>
        )}
      </div>
    </div>
  );
}
