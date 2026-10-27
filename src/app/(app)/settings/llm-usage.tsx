import { io } from "next/cache";
import { EmptyState } from "@/components/empty-state";
import { Notice } from "@/components/notice";
import { StatStrip, type Stat } from "@/components/stat-strip";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { getCurrentUser } from "@/lib/auth/session";
import { formatDateTime, formatNumber } from "@/lib/format";
import { loadLlmUsage, type AnalysisKind, type KindUsage, type LlmUsageSummary } from "./llm-usage-data";

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

/** The month's figures: what was spent, the budget, what is left and how often triage answered off the schema. */
function usageStats(usage: LlmUsageSummary, calls: number): Stat[] {
  const triage = usage.kinds.find((k) => k.kind === "triage");
  const budget = usage.budgetUsd;
  return [
    {
      label: `${monthFormat.format(usage.monthStart)} harcaması`,
      value: formatUsd(usage.spentUsd),
      note: `${formatNumber(calls)} çağrı`,
      tone: usage.exceeded ? "err" : undefined,
    },
    {
      label: "Aylık sınır",
      value: budget === null ? "Okunamadı" : usdFormat.format(budget),
      note: "LLM_MONTHLY_BUDGET_USD",
      tone: budget === null ? "err" : undefined,
    },
    {
      label: "Kalan",
      value: budget === null ? "Bilinmiyor" : usdFormat.format(Math.max(0, budget - usage.spentUsd)),
      note: budget ? `Sınırın ${percentFormat.format(Math.min(1, usage.spentUsd / budget))} kadarı kullanıldı` : undefined,
      tone: usage.exceeded ? "err" : undefined,
    },
    {
      label: "Triage geçersiz çıktı",
      value: usage.triageInvalidRate === null ? "Yanıt yok" : percentFormat.format(usage.triageInvalidRate),
      note: triage?.answered ? `${formatNumber(triage.invalid)} / ${formatNumber(triage.answered)} yanıt` : undefined,
    },
  ];
}

/** This month's LLM spend against the budget, and how the calls went. Reads the session, so render it inside <Suspense>. */
export async function LlmUsage() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; io() keeps the queries to request time.
  await io();
  const usage = await retryRead(() => loadLlmUsage(getDb(), new Date()));
  const totalCalls = usage.kinds.reduce((sum, k) => sum + k.calls, 0);

  return (
    <>
      {usage.exceeded && (
        <Notice tone="err" role="alert" title="Aylık bütçe doldu">
          Otomatik analizler durdu; elle başlatılan analizler uyarıyla çalışır.
        </Notice>
      )}
      {usage.budgetError && (
        <Notice tone="err" role="alert" title="Bütçe ayarı okunamadı">
          <span className="wrap-anywhere">{usage.budgetError}</span> Düzeltilene kadar triage çalışmaz.
        </Notice>
      )}
      <StatStrip items={usageStats(usage, totalCalls)} />

      <Card>
        <CardHeader>
          <CardTitle>Bu ayın çağrıları</CardTitle>
          <CardDescription>İstanbul takvim ayı. Geçersiz çıktılar ve API hataları da harcamaya dahildir.</CardDescription>
        </CardHeader>
        {totalCalls === 0 ? (
          <CardContent>
            <EmptyState>Bu ay henüz AI çağrısı yapılmadı.</EmptyState>
          </CardContent>
        ) : (
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
                  <TableCell className="text-right font-mono">{formatNumber(k.calls)}</TableCell>
                  <TableCell className="text-right font-mono">{formatNumber(k.answered)}</TableCell>
                  <TableCell className="text-right font-mono">{invalidShare(k)}</TableCell>
                  <TableCell className="text-right font-mono">{formatNumber(k.apiErrors)}</TableCell>
                  <TableCell className="text-right font-mono">{formatUsd(k.costUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bu ayın son hatası</CardTitle>
        </CardHeader>
        <CardContent>
          {usage.lastError ? (
            <div className="flex flex-col gap-1">
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-xs text-ink-500">{formatDateTime(usage.lastError.at)}</span>
                <span className="font-medium">{KIND_LABELS[usage.lastError.kind]}</span>
              </span>
              <p title={usage.lastError.message} className="line-clamp-2 max-w-3xl text-[13px] text-err wrap-anywhere">
                {usage.lastError.message}
              </p>
            </div>
          ) : (
            <EmptyState>Bu ay hata yok.</EmptyState>
          )}
        </CardContent>
      </Card>
    </>
  );
}
