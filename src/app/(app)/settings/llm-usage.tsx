import { io } from "next/cache";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { getCurrentUser } from "@/lib/auth/session";
import { formatDateTime, formatNumber } from "@/lib/format";
import { loadLlmUsage, type AnalysisKind, type KindUsage } from "./llm-usage-data";

const KIND_LABELS: Record<AnalysisKind, string> = {
  triage: "Triage",
  deep: "Derin analiz",
  translation: "Çeviri",
  facts: "Olgu çıkarma",
};

const usdFormat = new Intl.NumberFormat("tr-TR", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const percentFormat = new Intl.NumberFormat("tr-TR", { style: "percent", maximumFractionDigits: 1 });
const monthFormat = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", month: "long", year: "numeric" });

/** Two decimals; a non-zero amount under half a cent shows as "< $0,01" rather than zero. */
function formatUsd(amount: number): string {
  return amount > 0 && amount < 0.005 ? `< ${usdFormat.format(0.01)}` : usdFormat.format(amount);
}

function invalidShare(usage: KindUsage): string {
  if (!usage.invalid) return formatNumber(0);
  return `${formatNumber(usage.invalid)} (${percentFormat.format(usage.invalid / usage.answered)})`;
}

/** This month's LLM spend against the budget, and how the calls went. Reads the session, so render it inside <Suspense>. */
export async function LlmUsage() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; io() keeps the queries to request time.
  await io();
  const usage = await retryRead(() => loadLlmUsage(getDb(), new Date()));
  const triage = usage.kinds.find((k) => k.kind === "triage");
  const totalCalls = usage.kinds.reduce((sum, k) => sum + k.calls, 0);
  const share = usage.budgetUsd ? Math.min(1, usage.spentUsd / usage.budgetUsd) : 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-sm text-muted-foreground">{monthFormat.format(usage.monthStart)} harcaması</span>
          <span className="text-lg font-semibold tabular-nums">
            {formatUsd(usage.spentUsd)}
            {usage.budgetUsd !== null && (
              <span className="text-sm font-normal text-muted-foreground"> / {usdFormat.format(usage.budgetUsd)} bütçe</span>
            )}
          </span>
        </div>
        {usage.budgetUsd !== null && (
          <div
            role="progressbar"
            aria-label="Aylık bütçenin kullanılan kısmı"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
            className="h-2 overflow-hidden rounded-full bg-muted"
          >
            <div className={usage.exceeded ? "h-full bg-destructive" : "h-full bg-primary"} style={{ width: `${share * 100}%` }} />
          </div>
        )}
        {usage.exceeded && (
          <p role="alert" className="text-sm text-destructive">
            Aylık bütçe doldu. Otomatik analizler durdu; elle başlatılan analizler uyarıyla çalışır.
          </p>
        )}
        {usage.budgetError && (
          <p role="alert" className="text-sm text-destructive wrap-anywhere">
            Bütçe ayarı okunamadı: {usage.budgetError} Düzeltilene kadar triage çalışmaz.
          </p>
        )}
      </div>

      {totalCalls === 0 ? (
        <p className="text-sm text-muted-foreground">Bu ay henüz AI çağrısı yapılmadı.</p>
      ) : (
        <>
          {triage && (
            <p className="text-sm">
              Triage geçersiz çıktı oranı:{" "}
              {usage.triageInvalidRate === null ? (
                <span className="text-muted-foreground">henüz yanıt yok</span>
              ) : (
                <span className="font-medium tabular-nums">
                  {percentFormat.format(usage.triageInvalidRate)} ({formatNumber(triage.invalid)} / {formatNumber(triage.answered)}{" "}
                  yanıt)
                </span>
              )}
            </p>
          )}
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tür</TableHead>
                  <TableHead className="text-right">Çağrı</TableHead>
                  <TableHead className="text-right">Yanıt gelen</TableHead>
                  <TableHead className="text-right">Geçersiz çıktı</TableHead>
                  <TableHead className="text-right">API hatası</TableHead>
                  <TableHead className="text-right">Harcama</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usage.kinds.map((k) => (
                  <TableRow key={k.kind}>
                    <TableCell className="font-medium">{KIND_LABELS[k.kind]}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(k.calls)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(k.answered)}</TableCell>
                    <TableCell className="text-right tabular-nums">{invalidShare(k)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatNumber(k.apiErrors)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatUsd(k.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      <div className="flex flex-col gap-1 text-sm">
        <span className="text-muted-foreground">Son hata</span>
        {usage.lastError ? (
          <>
            <span>
              {formatDateTime(usage.lastError.at)}, {KIND_LABELS[usage.lastError.kind]}
            </span>
            <p title={usage.lastError.message} className="line-clamp-2 max-w-2xl text-destructive wrap-anywhere">
              {usage.lastError.message}
            </p>
          </>
        ) : (
          <span className="text-muted-foreground">Bu ay hata yok</span>
        )}
      </div>
    </div>
  );
}
