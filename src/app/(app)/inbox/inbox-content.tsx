import { io } from "next/cache";
import Link from "next/link";
import { AssessmentBadge } from "@/components/assessment-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { reviewDecision } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { DECISION_SHORT, daysLeft, formatDaysLeft, formatMoney, SOURCE_LABELS } from "@/lib/format";
import { sourceIds } from "@/matching/rules";
import { STATUS_GROUP_LABELS, STATUS_GROUPS, type StatusGroup } from "@/policy/labels";
import { isProductScope } from "@/sources/scope";
import { inboxQuery, loadInbox, PAGE_SIZE, readFilters, type DocumentSummary, type Filters } from "./data";

export async function InboxContent({ searchParams }: { searchParams: PageProps<"/inbox">["searchParams"] }) {
  await getCurrentUser();
  const filters = readFilters(await searchParams);
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const { profiles, hasAnyProfile, list, total } = await retryRead(() => loadInbox(getDb(), filters));
  const now = new Date();

  if (!hasAnyProfile) {
    return (
      <p className="text-sm text-muted-foreground">
        Henüz kriter profili yok.{" "}
        <Link href="/profiles/new" className="underline underline-offset-4">
          İlk profili oluşturun
        </Link>
        ; eşleşen ihaleler burada listelenir.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <form className="flex flex-wrap items-end gap-3 text-sm">
        <Select name="profile" label="Profil" value={filters.profile}>
          <option value="">Tümü</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select name="source" label="Kaynak" value={filters.source}>
          <option value="">Tümü</option>
          {sourceIds.map((id) => (
            <option key={id} value={id}>
              {SOURCE_LABELS[id]}
            </option>
          ))}
        </Select>
        <Select name="status" label="Durum" value={filters.status}>
          <option value="open">Teklif verilebilir</option>
          <option value="closed">Kapanmış, iptal ya da sonuçlanmış</option>
          <option value="all">Tümü</option>
        </Select>
        <Select name="assessment" label="Değerlendirme" value={filters.assessment}>
          <option value="">Tümü</option>
          {(Object.keys(STATUS_GROUPS) as StatusGroup[]).map((group) => (
            <option key={group} value={group}>
              {STATUS_GROUP_LABELS[group]}
            </option>
          ))}
          <option value="none">Henüz değerlendirilmemiş</option>
        </Select>
        <Select name="sort" label="Sıralama" value={filters.sort}>
          <option value="deadline">Son tarih</option>
          <option value="assessment">Değerlendirme</option>
        </Select>
        <Select name="decision" label="Karar" value={filters.decision}>
          <option value="">Tümü</option>
          <option value="none">Karar verilmemiş</option>
          {reviewDecision.enumValues.map((d) => (
            <option key={d} value={d}>
              {DECISION_SHORT[d]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline">
          Uygula
        </Button>
      </form>

      {!profiles.length && (
        <p className="text-sm text-muted-foreground">
          Aktif profil yok, bu yüzden yeni eşleşme gelmiyor. Daha önce karar verdiğiniz ihaleleri Karar filtresiyle bulabilirsiniz.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {total} ihale
        {total > PAGE_SIZE && list.length
          ? `, ${(filters.page - 1) * PAGE_SIZE + 1}-${(filters.page - 1) * PAGE_SIZE + list.length} arası gösteriliyor`
          : ""}
        . {filters.sort === "assessment" ? "En umut verici değerlendirme önce, değerlendirilmeyenler sonda." : "Son tarihe göre sıralı."}
      </p>

      {list.length ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>İhale</TableHead>
                <TableHead>Ülke</TableHead>
                <TableHead className="text-right">Değer (EUR)</TableHead>
                <TableHead className="text-right">Kalan</TableHead>
                <TableHead>Değerlendirme</TableHead>
                <TableHead>Doküman</TableHead>
                <TableHead>Karar</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((item) => (
                <TableRow key={item.tenderId}>
                  <TableCell className="max-w-xl whitespace-normal">
                    <div className="flex flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link href={`/tenders/${item.tenderId}`} className="font-medium hover:underline">
                          {item.titleTr ?? item.title}
                        </Link>
                        {item.isNew && <Badge>Yeni</Badge>}
                        {item.changedAt && (!item.decidedAt || item.changedAt > item.decidedAt) && (
                          <Badge variant="destructive">Değişti</Badge>
                        )}
                        {!isProductScope(item.contractNature, item.cpvMain) ? (
                          <Badge variant="outline" title="Sadece mal alımları takip ediliyor; kararınız olduğu için listede.">
                            Kapsam dışı
                          </Badge>
                        ) : (
                          !item.current && <Badge variant="outline">Artık eşleşmiyor</Badge>
                        )}
                      </div>
                      {item.titleTr && <span className="text-xs text-muted-foreground">{item.title}</span>}
                      {item.assessmentExplanation && <span className="line-clamp-2 text-sm">{item.assessmentExplanation}</span>}
                      <span className="text-xs text-muted-foreground">
                        {[item.buyerName, SOURCE_LABELS[item.source as keyof typeof SOURCE_LABELS], item.profiles.join(", ")]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>{item.buyerCountry ?? "?"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {item.valueEur !== null ? (
                      formatMoney(item.valueEur, "EUR")
                    ) : item.valueAmount !== null ? (
                      <span className="text-muted-foreground">{formatMoney(item.valueAmount, item.valueCurrency)}</span>
                    ) : (
                      <span className="text-muted-foreground">Yok</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatDaysLeft(daysLeft(item.submissionDeadline, now))}</TableCell>
                  <TableCell>
                    {item.assessmentStatus ? (
                      <div className="flex flex-col items-start gap-1">
                        <AssessmentBadge status={item.assessmentStatus} />
                        {item.fitLow !== null && item.fitHigh !== null && (
                          <span
                            className="text-xs text-muted-foreground tabular-nums"
                            title={`Fırsat uyumu. İlanda bilinmeyen ölçütlerle aralık ${item.fitLow}-${item.fitHigh}; gösterilen ortası.`}
                          >
                            uyum {Math.round((item.fitLow + item.fitHigh) / 2)}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Sırada</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <DocumentsCell summary={item.documents} />
                  </TableCell>
                  <TableCell>{item.decision ? DECISION_SHORT[item.decision] : <span className="text-muted-foreground">-</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : filters.page > 1 ? (
        <p className="text-sm text-muted-foreground">
          Bu sayfada ihale yok.{" "}
          <Link href={`/inbox${inboxQuery(filters, 1)}`} className="underline underline-offset-4">
            İlk sayfaya dön
          </Link>
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">Bu filtrelerle eşleşen ihale yok.</p>
      )}
      <Pager filters={filters} total={total} />
    </div>
  );
}

function Select({ name, label, value, children }: { name: string; label: string; value: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground">{label}</span>
      <select
        name={name}
        defaultValue={value}
        className="h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {children}
      </select>
    </label>
  );
}

function Pager({ filters, total }: { filters: Filters; total: number }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;
  const link = (page: number, label: string) => (
    <Link href={`/inbox${inboxQuery(filters, page)}`} className="underline underline-offset-4">
      {label}
    </Link>
  );
  return (
    <nav className="flex items-center gap-4 text-sm" aria-label="Sayfalar">
      {filters.page > 1 ? link(filters.page - 1, "Önceki sayfa") : <span className="text-muted-foreground">Önceki sayfa</span>}
      <span className="text-muted-foreground">
        Sayfa {Math.min(filters.page, pages)} / {pages}
      </span>
      {filters.page < pages ? link(filters.page + 1, "Sonraki sayfa") : <span className="text-muted-foreground">Sonraki sayfa</span>}
    </nav>
  );
}

/** The short word shows; the explanation is a tooltip, and read out by screen readers. */
function DocumentsCell({ summary }: { summary: DocumentSummary }) {
  const cell = (text: string, explanation: string, muted = false) => (
    <span title={explanation} className={muted ? "text-muted-foreground" : undefined}>
      {text}
      <span className="sr-only">: {explanation}</span>
    </span>
  );
  switch (summary.state) {
    case "files":
      return cell(`${summary.files} dosya`, "okunmuş, analize girecek dosyalar");
    case "reading":
      return cell("Okunuyor", "dosyalar depoda, worker okuyor", true);
    case "portal":
      return cell("Portal", "dokümanlar alıcının portalında; ihale sayfasından portala gidip indirin ve yükleyin");
    default:
      return <span className="text-muted-foreground">-</span>;
  }
}
