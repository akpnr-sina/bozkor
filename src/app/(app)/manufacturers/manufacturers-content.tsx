import Form from "next/form";
import { io } from "next/cache";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatStrip } from "@/components/stat-strip";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { getCurrentUser } from "@/lib/auth/session";
import { formatNumber } from "@/lib/format";
import { pageIndex } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { FAMILIES } from "@/manufacturers/families";
import { CONTACT_STATE_LABELS, TRI_LABELS } from "@/manufacturers/labels";
import { loadManufacturerPool } from "@/manufacturers/projection";
import { PRODUCT_CATEGORIES } from "@/policy/categories";
import {
  CERTIFICATE_FILTER_LABELS,
  filterManufacturers,
  filterOptions,
  isFiltered,
  manufacturersQuery,
  PAGE_SIZE,
  poolFigures,
  readManufacturerFilters,
  type ManufacturerFilters,
} from "./filters";
import { ManufacturersTable } from "./manufacturers-table";

// The manufacturer pool (SPEC 10, 8.1): the active firms of the last import, searched and filtered in
// memory. The pool is read through loadManufacturerPool, which asks the database only for the last import's
// ID and reloads the firms when it changed.

export async function ManufacturersContent({ searchParams }: { searchParams: PageProps<"/manufacturers">["searchParams"] }) {
  await getCurrentUser();
  const filters = readManufacturerFilters(await searchParams);
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const pool = await retryRead(() => loadManufacturerPool(getDb()));

  const header = (
    <PageHeader
      index={pageIndex("/manufacturers")}
      title="Üreticiler"
      description={
        pool
          ? `Ekibin platform dışında hazırladığı üretici havuzu, sürüm ${pool.poolVersion}. Kayıtlar salt okunur; havuzun yeni sürümü yüklenince güncellenir.`
          : undefined
      }
    />
  );
  if (!pool) {
    return (
      <div className="flex flex-col gap-[18px]">
        {header}
        <EmptyState>Üretici havuzu henüz yüklenmedi.</EmptyState>
      </div>
    );
  }

  const figures = poolFigures(pool.manufacturers);
  const options = filterOptions(pool.manufacturers);
  const found = filterManufacturers(pool.manufacturers, filters);
  const pages = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
  const page = Math.min(filters.page, pages);
  const rows = found.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const first = (page - 1) * PAGE_SIZE + 1;

  return (
    <div className="flex flex-col gap-[18px]">
      {header}
      <StatStrip
        items={[
          { label: "Üretici", value: formatNumber(figures.total), note: "Havuzdaki etkin firmalar" },
          { label: "AQAP", value: formatNumber(figures.aqap), note: "AQAP 2110/2120 ya da AQAP belgesi" },
          { label: "İhracat yapan", value: formatNumber(figures.exports), note: "Havuzdaki kaynağa göre" },
          { label: "İletişim bilgisi olan", value: formatNumber(figures.withContact), note: "Firma düzeyinde e-posta ya da telefon" },
        ]}
      />
      <Filters filters={filters} options={options} />
      <p className="text-[13px] text-ink-600">
        {formatNumber(found.length)} üretici
        {found.length > PAGE_SIZE && rows.length ? ` · ${first}-${first + rows.length - 1} arası` : ""}
      </p>
      {rows.length ? (
        <ManufacturersTable rows={rows} />
      ) : (
        <EmptyState>{isFiltered(filters) ? "Bu filtrelerle üretici bulunamadı." : "Havuzda etkin üretici yok."}</EmptyState>
      )}
      <Pager filters={filters} page={page} pages={pages} />
    </div>
  );
}

function Filters({ filters, options }: { filters: ManufacturerFilters; options: ReturnType<typeof filterOptions> }) {
  return (
    <Form action="/manufacturers" className="flex flex-wrap items-end gap-3">
      <Field label="Ara">
        <Input name="q" type="search" defaultValue={filters.q} placeholder="Unvan, ürün ya da malzeme" className="h-8 w-60 text-[13px] md:text-[13px]" />
      </Field>
      <Field label="Kategori">
        <NativeSelect name="category" defaultValue={filters.category} size="sm" className="w-48">
          <option value="">Tümü</option>
          {options.categories.map((c) => (
            <option key={c} value={c}>
              {PRODUCT_CATEGORIES[c].label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Ürün ailesi">
        <NativeSelect name="family" defaultValue={filters.family} size="sm" className="w-48">
          <option value="">Tümü</option>
          {options.families.map((f) => (
            <option key={f} value={f}>
              {f} {FAMILIES[f].label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="İl">
        <NativeSelect name="province" defaultValue={filters.province} size="sm" className="w-36">
          <option value="">Tümü</option>
          {options.provinces.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="Belge">
        <NativeSelect name="certificate" defaultValue={filters.certificate} size="sm" className="w-44">
          <option value="">Tümü</option>
          {Object.entries(CERTIFICATE_FILTER_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="İhracat">
        <NativeSelect name="exports" defaultValue={filters.exports} size="sm" className="w-32">
          <option value="">Tümü</option>
          {Object.entries(TRI_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label="İletişim durumu">
        <NativeSelect name="contact" defaultValue={filters.contact} size="sm" className="w-44">
          <option value="">Tümü</option>
          {Object.entries(CONTACT_STATE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Button type="submit" variant="outline" size="sm" className="h-8">
        Uygula
      </Button>
      {isFiltered(filters) && (
        <Link href="/manufacturers" className="flex h-8 items-center text-[13px] font-medium text-ink-600 underline underline-offset-4 hover:text-ink-900">
          Filtreleri temizle
        </Link>
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

function Pager({ filters, page, pages }: { filters: ManufacturerFilters; page: number; pages: number }) {
  if (pages <= 1) return null;
  const link = (target: number, label: string, enabled: boolean) =>
    enabled ? (
      <Link href={`/manufacturers${manufacturersQuery(filters, target)}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
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
