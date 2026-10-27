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
            <CardAction>
              <Legend />
            </CardAction>
          </CardHeader>
          <CountryBars rows={data.countries} />
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Haftalık yayımlanan ve eşleşen · son {data.weeks.length} hafta</CardTitle>
          <CardAction>
            <Legend />
          </CardAction>
        </CardHeader>
        <WeekBars weeks={data.weeks} />
      </Card>
    </>
  );
}

function Legend() {
  return (
    <span className="flex gap-3 text-xs text-ink-600">
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-2 bg-line-strong" />
        Yayımlanan
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="size-2 bg-ink-900" />
        Eşleşen
      </span>
    </span>
  );
}

function CountryBars({ rows }: { rows: readonly CountryStat[] }) {
  if (!rows.length) {
    return (
      <div className="p-4">
        <EmptyState>Son 30 günde yayımlanan ihale yok.</EmptyState>
      </div>
    );
  }
  const max = Math.max(...rows.map((row) => row.found), 1);
  return (
    <ul className="flex flex-col gap-3.5 p-4">
      {rows.map((row) => (
        <li key={row.country ?? "?"} className="grid grid-cols-[112px_minmax(0,1fr)_76px] items-center gap-3">
          <span className="truncate text-[13px]">{countryName(row.country)}</span>
          <span
            role="img"
            aria-label={`${row.found} yayımlanan, ${row.matched} eşleşen`}
            className="relative h-2.5 bg-canvas"
          >
            <span className="absolute inset-y-0 left-0 bg-line-strong" style={{ width: `${(row.found / max) * 100}%` }} />
            <span className="absolute inset-y-0 left-0 bg-ink-900" style={{ width: `${(row.matched / max) * 100}%` }} />
          </span>
          <span className="text-right font-mono text-xs text-ink-600">
            {row.found} · {row.matched}
          </span>
        </li>
      ))}
    </ul>
  );
}

const BAR_PX = 130;

function WeekBars({ weeks }: { weeks: readonly WeekStat[] }) {
  const max = Math.max(...weeks.map((week) => week.found), 1);
  return (
    <div className="grid h-[204px] items-end gap-3 px-4 pt-5 pb-3" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
      {weeks.map((week) => (
        <div
          key={week.week}
          role="img"
          aria-label={`${week.label}. hafta: ${week.found} yayımlanan, ${week.matched} eşleşen`}
          className="flex h-full flex-col justify-end gap-1.5"
        >
          <span className="text-center font-mono text-[11px] text-ink-600">{week.found}</span>
          <div className="flex flex-col justify-end bg-line-strong" style={{ height: `${(week.found / max) * BAR_PX}px` }}>
            <div className="bg-ink-900" style={{ height: `${(week.matched / max) * BAR_PX}px` }} />
          </div>
          <span className="text-center font-mono text-[11px] text-ink-400">H{Number(week.label)}</span>
        </div>
      ))}
    </div>
  );
}
