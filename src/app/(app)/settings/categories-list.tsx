import { asc } from "drizzle-orm";
import { io } from "next/cache";
import { EmptyState } from "@/components/empty-state";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { categories } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";

/** The shared taxonomy profiles pick from (SPEC section 6). Reads the session, so render it inside <Suspense>. */
export async function CategoriesList() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; io() keeps the queries to request time.
  await io();
  const rows = await retryRead(() =>
    getDb()
      .select({ id: categories.id, name: categories.name, cpvPrefixes: categories.cpvPrefixes, description: categories.description })
      .from(categories)
      .orderBy(asc(categories.name)),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Kategoriler</CardTitle>
        <CardDescription>Profillerin seçtiği ortak sınıflandırma; seçilen kategorinin CPV önekleri profile eklenir.</CardDescription>
      </CardHeader>
      {rows.length === 0 ? (
        <CardContent>
          <EmptyState>Kayıtlı kategori yok.</EmptyState>
        </CardContent>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kategori</TableHead>
              <TableHead>CPV önekleri</TableHead>
              <TableHead>Açıklama</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">{row.name}</TableCell>
                <TableCell className="font-mono text-[13px]">{row.cpvPrefixes.join(", ") || "Yok"}</TableCell>
                <TableCell className="min-w-64 whitespace-normal text-ink-600">{row.description || "Yok"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
