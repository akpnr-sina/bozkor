import type { Metadata } from "next";
import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { AssessmentBadge } from "@/components/assessment-badge";
import { DueChip } from "@/components/due-chip";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-strip";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { getCurrentUser } from "@/lib/auth/session";
import { countryName, formatLongDate, formatNumber } from "@/lib/format";
import { pageIndex } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { loadPanel, type CountryStat, type WeekStat } from "./data";

export const metadata: Metadata = { title: "Panel" };

export default function PanelPage() {
  return (
    <div className="flex flex-col gap-[18px]">
      <Suspense
        fallback={
          <>
            <PageHeader index={pageIndex("/panel")} title="Panel" />
            <p className="text-[13px] text-ink-500">Yükleniyor...</p>
          </>
        }
      >
        <PanelContent />
      </Suspense>
    </div>
  );
}

async function PanelContent() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const now = new Date();
  const data = await retryRead(() => loadPanel(getDb()));
  const { counts } = data;

  return (
    <>
      <PageHeader index={pageIndex("/panel")} title="Panel" actions={<span className="text-[13px] text-ink-500">{formatLongDate(now)}</span>} />
      {!data.hasAnyProfile && (
        <EmptyState>
          Henüz kriter profili yok.{" "}
          <Link href="/profiles/new" className="font-medium text-ink-900 underline underline-offset-4">
            İlk profili oluşturun
          </Link>
          ; eşleşen ihaleler burada özetlenir.
        </EmptyState>
      )}
      <StatStrip
        items={[
          { label: "Teklif verilebilir", value: formatNumber(counts.all), note: "Gelen kutusundaki açık ihaleler", href: "/inbox" },
          {
            label: "Umut verici",
            value: formatNumber(counts.groups.promising),
            tone: "ok",
            note: "Yeterlilik politikasına göre",
            href: "/inbox?assessment=promising",
          },
          { label: "GO kararı", value: formatNumber(data.goOpen), note: "Açık, teklif hazırlanacak", href: "/inbox?decision=GO" },
          {
            label: "7 gün içinde kapanan",
            value: formatNumber(counts.closingSoon),
            tone: counts.closingSoon ? "warn" : undefined,
            note: "Teklif verilebilir olanlardan",
          },
        ]}
      />
      <div className="grid gap-[18px] xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Yaklaşan son tarihler</CardTitle>
            <CardAction>
              <Link href="/inbox" className="text-[13px] font-medium text-ink-900 underline underline-offset-4">
                Tümü
              </Link>
            </CardAction>
          </CardHeader>
          {data.upcoming.length ? (
            <ul>
              {data.upcoming.map((row) => (
                <li key={row.tenderId} className="border-b border-line-soft last:border-0">
                  <Link
                    href={`/tenders/${row.tenderId}`}
                    className="grid min-h-14 grid-cols-[minmax(0,1fr)_auto_72px] items-center gap-4 px-4 py-2 transition-colors hover:bg-surface-hover"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-sm font-medium">{row.titleTr ?? row.title}</span>
                      <span className="truncate text-xs text-ink-500">
                        {[row.buyerName, countryName(row.buyerCountry)].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    {row.assessmentStatus ? <AssessmentBadge status={row.assessmentStatus} /> : <Badge dot>Sırada</Badge>}
                    <DueChip deadline={row.submissionDeadline} now={now} className="justify-self-end" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4">
              <EmptyState>Son tarihi yaklaşan, üzerinde çalışılacak ihale yok.</EmptyState>
            </div>
          )}
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Ülke bazında · son 30 gün</CardTitle>
          </CardHeader>
          <CountryBars rows={data.countries} />
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Haftalık yayımlanan ve eşleşen · son {data.weeks.length} hafta</CardTitle>
        </CardHeader>
        <WeekBars weeks={data.weeks} />
      </Card>
    </>
  );
}

// Matched tenders are about 2% of those published: on one scale the matched part was a sliver. Each
// series gets its own scale in its own row (weeks) or column (countries), so neither reads as a share
// of the other.

function CountryBars({ rows }: { rows: readonly CountryStat[] }) {
  if (!rows.length) {
    return (
      <div className="p-4">
        <EmptyState>Son 30 günde yayımlanan ihale yok.</EmptyState>
      </div>
    );
  }
  const maxFound = Math.max(...rows.map((row) => row.found), 1);
  const maxMatched = Math.max(...rows.map((row) => row.matched), 1);
  const columns = "grid grid-cols-[96px_minmax(0,1fr)_44px_56px_28px] items-center gap-x-2.5";
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className={cn(columns, "th-label")}>
        <span>Ülke</span>
        <span className="col-span-2">Yayımlanan</span>
        <span className="col-span-2">Eşleşen</span>
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => (
          <li key={row.country ?? "?"} role="img" aria-label={`${countryName(row.country)}: ${row.found} yayımlanan, ${row.matched} eşleşen`} className={columns}>
            <span className="truncate text-[13px]">{countryName(row.country)}</span>
            <span aria-hidden className="h-2 bg-chart-muted" style={{ width: `${(row.found / maxFound) * 100}%` }} />
            <span className="text-right font-mono text-xs text-ink-500">{formatNumber(row.found)}</span>
            <span aria-hidden className="relative h-2 bg-canvas">
              <span className="absolute inset-y-0 left-0 bg-chart" style={{ width: `${(row.matched / maxMatched) * 100}%` }} />
            </span>
            <span className="text-right font-mono text-xs text-ink-900">{formatNumber(row.matched)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MATCHED_PX = 84;
const FOUND_PX = 32;

function WeekBars({ weeks }: { weeks: readonly WeekStat[] }) {
  const maxMatched = Math.max(...weeks.map((week) => week.matched), 1);
  const maxFound = Math.max(...weeks.map((week) => week.found), 1);
  const columns = { gridTemplateColumns: `84px repeat(${weeks.length}, minmax(0, 1fr))` };
  const row = (label: string, value: (week: WeekStat) => number, max: number, px: number, bar: string, text: string) => (
    <div aria-hidden className="grid items-end gap-x-3" style={columns}>
      <span className="th-label pb-px">{label}</span>
      {weeks.map((week) => (
        <div key={week.week} className="flex flex-col items-center justify-end gap-1" style={{ height: px + 18 }}>
          <span className={cn("font-mono text-[11px]", text)}>{formatNumber(value(week))}</span>
          <div className={cn("w-full max-w-11", bar)} style={{ height: (value(week) / max) * px }} />
        </div>
      ))}
    </div>
  );
  return (
    <div role="img" aria-label={weeks.map((week) => `${Number(week.label)}. hafta: ${week.found} yayımlanan, ${week.matched} eşleşen`).join("; ")} className="flex flex-col gap-2.5 px-4 pt-5 pb-3">
      {row("Eşleşen", (week) => week.matched, maxMatched, MATCHED_PX, "bg-chart", "text-ink-900")}
      {row("Yayımlanan", (week) => week.found, maxFound, FOUND_PX, "bg-chart-muted", "text-ink-500")}
      <div aria-hidden className="grid gap-x-3 border-t border-line pt-2" style={columns}>
        <span />
        {weeks.map((week) => (
          <span key={week.week} className="text-center font-mono text-[11px] text-ink-400">
            H{Number(week.label)}
          </span>
        ))}
      </div>
    </div>
  );
}
