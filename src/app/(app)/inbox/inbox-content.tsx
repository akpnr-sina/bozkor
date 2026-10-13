import { io } from "next/cache";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { reviewDecision } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { DECISION_SHORT, daysLeft, formatDaysLeft, formatMoney, SOURCE_LABELS } from "@/lib/format";
import { sourceIds } from "@/matching/rules";
import { loadInbox, readFilters } from "./data";

export async function InboxContent({ searchParams }: { searchParams: PageProps<"/inbox">["searchParams"] }) {
  await getCurrentUser();
  const filters = readFilters(await searchParams);
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const { profiles, hasAnyProfile, list, total } = await loadInbox(getDb(), filters);
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
        {total} ihale{total > list.length ? `, ilk ${list.length} tanesi gösteriliyor` : ""}. Son tarihe göre sıralı.
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
                <TableHead className="text-right">Triage</TableHead>
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
                          {item.title}
                        </Link>
                        {item.isNew && <Badge>Yeni</Badge>}
                        {item.changedAt && (!item.decidedAt || item.changedAt > item.decidedAt) && (
                          <Badge variant="destructive">Değişti</Badge>
                        )}
                        {!item.current && <Badge variant="outline">Artık eşleşmiyor</Badge>}
                      </div>
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
                  <TableCell className="text-right tabular-nums">{item.bestScore ?? <span className="text-muted-foreground">-</span>}</TableCell>
                  <TableCell>
                    {item.documentCount ? `${item.documentCount} link` : item.documentsPortalUrl ? "Portal" : "Yok"}
                  </TableCell>
                  <TableCell>{item.decision ? DECISION_SHORT[item.decision] : <span className="text-muted-foreground">-</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Bu filtrelerle eşleşen ihale yok.</p>
      )}
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
