import { X } from "lucide-react";
import Form from "next/form";
import { io } from "next/cache";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-strip";
import { TabNav } from "@/components/tab-nav";
import { Button, buttonVariants } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { reviewDecision } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { DECISION_SHORT, formatNumber, SOURCE_LABELS } from "@/lib/format";
import { pageIndex } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { sourceIds } from "@/matching/rules";
import { STATUS_GROUP_LABELS, type StatusGroup } from "@/policy/labels";
import { inboxCounts, inboxQuery, loadInbox, PAGE_SIZE, readFilters, type Filters, type InboxCounts } from "./data";
import { InboxWorkspace } from "./inbox-workspace";

const GROUPS: StatusGroup[] = ["promising", "conditional", "watch", "rejected", "expired"];

export async function InboxContent({ searchParams }: { searchParams: PageProps<"/inbox">["searchParams"] }) {
  await getCurrentUser();
  const filters = readFilters(await searchParams);
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const [{ profiles, hasAnyProfile, list, total }, counts] = await retryRead(() =>
    Promise.all([loadInbox(getDb(), filters), inboxCounts(getDb(), filters)]),
  );
  const now = new Date();

  const header = (
    <PageHeader
      index={pageIndex("/inbox")}
      title="Gelen kutusu"
      actions={
        <Link href="/profiles" className={buttonVariants({ variant: "outline" })}>
          Profilleri düzenle
        </Link>
      }
    />
  );

  if (!hasAnyProfile) {
    return (
      <div className="flex flex-col gap-[18px]">
        {header}
        <EmptyState>
          Henüz kriter profili yok.{" "}
          <Link href="/profiles/new" className="font-medium text-ink-900 underline underline-offset-4">
            İlk profili oluşturun
          </Link>
          ; eşleşen ihaleler burada listelenir.
        </EmptyState>
      </div>
    );
  }

  const first = (filters.page - 1) * PAGE_SIZE + 1;
  const summary = [
    `${formatNumber(total)} ihale`,
    total > PAGE_SIZE && list.length ? `${first}-${first + list.length - 1} arası` : null,
    filters.sort === "assessment" ? "en umut verici değerlendirme önce" : "son tarihe göre",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <InboxWorkspace
      rows={list}
      now={now}
      top={
        <>
          {header}
          <StatStrip items={keyFigures(counts)} />
          <TabNav label="Değerlendirme" items={tabs(filters, counts)} />
          <Filters filters={filters} profiles={profiles} />
          {!profiles.length && (
            <EmptyState>
              Aktif profil yok, bu yüzden yeni eşleşme gelmiyor. Daha önce karar verdiğiniz ihaleleri Karar filtresiyle bulabilirsiniz.
            </EmptyState>
          )}
          <p className="text-[13px] text-ink-600">{summary}</p>
        </>
      }
      empty={
        filters.page > 1 ? (
          <EmptyState>
            Bu sayfada ihale yok.{" "}
            <Link href={`/inbox${inboxQuery(filters, 1)}`} className="font-medium text-ink-900 underline underline-offset-4">
              İlk sayfaya dönün
            </Link>
            .
          </EmptyState>
        ) : (
          <EmptyState>{filters.q ? `"${filters.q}" için bu filtrelerle ihale bulunamadı.` : "Bu filtrelerle eşleşen ihale yok."}</EmptyState>
        )
      }
      bottom={<Pager filters={filters} total={total} />}
    />
  );
}

function keyFigures(counts: InboxCounts) {
  return [
    { label: "Son 24 saatte yeni", value: formatNumber(counts.newToday), note: "Profillerle yeni eşleşen" },
    { label: "Umut verici", value: formatNumber(counts.groups.promising), tone: "ok" as const, note: "Yeterlilik politikasına göre" },
    { label: "Doküman gerekli", value: formatNumber(counts.needsDocuments), tone: "info" as const, note: "Okunmadan karar verilemez" },
    {
      label: "7 gün içinde kapanan",
      value: formatNumber(counts.closingSoon),
      tone: counts.closingSoon ? ("warn" as const) : undefined,
      note: "Son teklif tarihi yaklaşan",
    },
  ];
}

function tabs(filters: Filters, counts: InboxCounts) {
  const link = (assessment: Filters["assessment"]) => `/inbox${inboxQuery({ ...filters, assessment }, 1)}`;
  return [
    { href: link(""), label: "Tümü", count: counts.all, active: filters.assessment === "" },
    ...GROUPS.map((group) => ({
      href: link(group),
      label: STATUS_GROUP_LABELS[group],
      count: counts.groups[group],
      active: filters.assessment === group,
    })),
    ...(counts.unassessed || filters.assessment === "none"
      ? [{ href: link("none"), label: "Sırada", count: counts.unassessed, active: filters.assessment === "none" }]
      : []),
  ];
}

/** The filters; the search box is the top bar's, a search in force shows here and stays when filters change. */
function Filters({ filters, profiles }: { filters: Filters; profiles: { id: string; name: string }[] }) {
  const narrowed = filters.profile || filters.source || filters.status !== "open" || filters.decision || filters.sort !== "deadline";
  return (
    <Form action="/inbox" className="flex flex-wrap items-end gap-3">
      {filters.assessment && <input type="hidden" name="assessment" value={filters.assessment} />}
      {filters.q && <input type="hidden" name="q" value={filters.q} />}
      <Field label="Profil">
        <NativeSelect name="profile" defaultValue={filters.profile} size="sm" className="w-36">
          <option value="">Tümü</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Kaynak">
        <NativeSelect name="source" defaultValue={filters.source} size="sm" className="w-40">
          <option value="">Tümü</option>
          {sourceIds.map((id) => (
            <option key={id} value={id}>
              {SOURCE_LABELS[id]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Durum">
        <NativeSelect name="status" defaultValue={filters.status} size="sm" className="w-40">
          <option value="open">Teklif verilebilir</option>
          <option value="closed">Kapanmış, iptal ya da sonuçlanmış</option>
          <option value="all">Tümü</option>
        </NativeSelect>
      </Field>
      <Field label="Karar">
        <NativeSelect name="decision" defaultValue={filters.decision} size="sm" className="w-36">
          <option value="">Tümü</option>
          <option value="none">Karar verilmemiş</option>
          {reviewDecision.enumValues.map((d) => (
            <option key={d} value={d}>
              {DECISION_SHORT[d]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Sıralama">
        <NativeSelect name="sort" defaultValue={filters.sort} size="sm" className="w-36">
          <option value="deadline">Son tarih</option>
          <option value="assessment">Değerlendirme</option>
        </NativeSelect>
      </Field>
      <Button type="submit" variant="outline" size="sm" className="h-8">
        Uygula
      </Button>
      {narrowed && (
        <Link
          href={`/inbox${inboxQuery({ ...readFilters({}), assessment: filters.assessment, q: filters.q }, 1)}`}
          className="flex h-8 items-center text-[13px] font-medium text-ink-600 underline underline-offset-4 hover:text-ink-900"
        >
          Filtreleri temizle
        </Link>
      )}
      {filters.q && (
        <span className="flex h-8 items-center gap-2 border border-line-strong bg-surface pr-1 pl-2.5 text-[13px]">
          <span className="text-ink-500">Arama:</span>
          <span className="max-w-60 truncate font-medium">{filters.q}</span>
          <Link
            href={`/inbox${inboxQuery({ ...filters, q: "" }, 1)}`}
            aria-label="Aramayı kaldır"
            className="flex size-6 items-center justify-center text-ink-500 hover:text-ink-900"
          >
            <X className="size-3.5" />
          </Link>
        </span>
      )}
    </Form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-ink-500">{label}</span>
      {children}
    </label>
  );
}

function Pager({ filters, total }: { filters: Filters; total: number }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  const page = Math.min(filters.page, pages);
  const link = (target: number, label: string, enabled: boolean) =>
    enabled ? (
      <Link href={`/inbox${inboxQuery(filters, target)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
        {label}
      </Link>
    ) : (
      <span aria-disabled className={cn(buttonVariants({ variant: "outline", size: "sm" }), "border-line bg-canvas text-ink-400")}>
        {label}
      </span>
    );
  return (
    <nav className="flex items-center gap-3" aria-label="Sayfalar">
      {link(page - 1, "Önceki", page > 1)}
      <span className="font-mono text-xs text-ink-600">
        {page} / {pages}
      </span>
      {link(page + 1, "Sonraki", page < pages)}
    </nav>
  );
}
