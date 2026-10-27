import { asc } from "drizzle-orm";
import type { Metadata } from "next";
import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { criteriaProfiles } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { formatDateTime, formatNumber } from "@/lib/format";
import { pageIndex } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { openMatchCounts } from "@/matching/apply";
import { ProfileActiveSwitch } from "./profile-active-switch";
import { readStoredRules } from "./stored-rules";

export const metadata: Metadata = { title: "Profiller" };

export default function ProfilesPage() {
  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        index={pageIndex("/profiles")}
        title="Profiller"
        description="Hangi ihalelerin gelen kutusuna düşeceğini belirleyen kriterler. Aktif profiller her yeni ilanla eşleştirilir."
        actions={
          <Link href="/profiles/new" className={cn(buttonVariants(), "chamfer")}>
            Profil oluştur
          </Link>
        }
      />
      <Suspense fallback={<p className="text-[13px] text-ink-500">Yükleniyor...</p>}>
        <ProfileList />
      </Suspense>
    </div>
  );
}

async function ProfileList() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const [profiles, counts] = await retryRead(() => {
    const db = getDb();
    return Promise.all([db.select().from(criteriaProfiles).orderBy(asc(criteriaProfiles.name)), openMatchCounts(db)]);
  });

  if (!profiles.length) {
    return <EmptyState>Henüz profil yok. Bir profil, hangi ihalelerin gelen kutusuna düşeceğini belirleyen kriterlerdir.</EmptyState>;
  }

  const active = profiles.filter((p) => p.active).length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Kriter profilleri</CardTitle>
        <CardDescription>
          {formatNumber(profiles.length)} profil, {formatNumber(active)} aktif. Eşleşme sayısı, profilin şu an teklif verilebilir ihaleleri.
        </CardDescription>
      </CardHeader>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Profil</TableHead>
            <TableHead>Aktif</TableHead>
            <TableHead className="text-right">Teklif verilebilir eşleşme</TableHead>
            <TableHead>Son güncelleme</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {profiles.map((p) => {
            const { rules, problems } = readStoredRules(p.rules);
            return (
              <TableRow key={p.id}>
                <TableCell className="whitespace-normal">
                  <div className="flex min-w-56 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <Link href={`/profiles/${p.id}`} className="font-medium underline-offset-4 hover:underline">
                        {p.name}
                      </Link>
                      {problems.length > 0 && (
                        <Badge variant="err" dot>
                          Kurallar geçersiz
                        </Badge>
                      )}
                    </span>
                    {rules.description && <span className="line-clamp-1 max-w-xl text-[13px] text-ink-600">{rules.description}</span>}
                  </div>
                </TableCell>
                <TableCell>
                  <ProfileActiveSwitch profileId={p.id} name={p.name} active={p.active} />
                </TableCell>
                <TableCell className="text-right font-mono">
                  <Link href={`/inbox?profile=${p.id}`} className="underline-offset-4 hover:underline">
                    {formatNumber(counts.get(p.id) ?? 0)}
                  </Link>
                </TableCell>
                <TableCell className="font-mono text-[13px] text-ink-600">{formatDateTime(p.updatedAt)}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Card>
  );
}
