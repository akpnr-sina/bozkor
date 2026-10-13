import { asc } from "drizzle-orm";
import type { Metadata } from "next";
import { io } from "next/cache";
import Link from "next/link";
import { Suspense } from "react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { criteriaProfiles } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { formatDateTime, formatNumber } from "@/lib/format";
import { openMatchCounts } from "@/matching/apply";
import { readStoredRules } from "./stored-rules";

export const metadata: Metadata = { title: "Profiller" };

export default function ProfilesPage() {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">Kriter profilleri</h1>
        <Link href="/profiles/new" className={buttonVariants()}>
          Yeni profil
        </Link>
      </div>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Yükleniyor...</p>}>
        <ProfileList />
      </Suspense>
    </section>
  );
}

async function ProfileList() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const db = getDb();
  const [profiles, counts] = await Promise.all([
    db.select().from(criteriaProfiles).orderBy(asc(criteriaProfiles.name)),
    openMatchCounts(db),
  ]);

  if (!profiles.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Henüz profil yok. Bir profil, hangi ihalelerin gelen kutusuna düşeceğini belirleyen kriterlerdir.
      </p>
    );
  }

  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Profil</TableHead>
            <TableHead>Durum</TableHead>
            <TableHead className="text-right">Teklif verilebilir eşleşme</TableHead>
            <TableHead>Son güncelleme</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {profiles.map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                <Link href={`/profiles/${p.id}`} className="font-medium hover:underline">
                  {p.name}
                </Link>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  <Badge variant={p.active ? "default" : "secondary"}>{p.active ? "Aktif" : "Pasif"}</Badge>
                  {readStoredRules(p.rules).problems.length > 0 && <Badge variant="destructive">Kurallar geçersiz</Badge>}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                <Link href={`/inbox?profile=${p.id}`} className="hover:underline">
                  {formatNumber(counts.get(p.id) ?? 0)}
                </Link>
              </TableCell>
              <TableCell>{formatDateTime(p.updatedAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
