import { EmptyState } from "@/components/empty-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDateTime } from "@/lib/format";
import type { HistoryRow } from "./tender-view";

// The history tab: what happened to the tender, newest first; only what the
// data records (the notice, the team's decisions, the analyses and their costs).

export function HistoryTab({ rows }: { rows: HistoryRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Geçmiş · {rows.length}</CardTitle>
      </CardHeader>
      {rows.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-44">Zaman</TableHead>
              <TableHead>Olay</TableHead>
              <TableHead className="w-56">Kim</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={`${row.at.getTime()}-${i}`}>
                <TableCell className="px-4 align-top font-mono text-xs whitespace-nowrap text-ink-600">{formatDateTime(row.at)}</TableCell>
                <TableCell className="px-4 py-3 whitespace-normal">
                  <div className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-2 text-sm text-ink-900">
                      {row.event}
                      {row.tone && (
                        <Badge variant={row.tone} dot>
                          {row.tone === "err" ? "Hata" : row.tone === "warn" ? "Değişti" : "Tamam"}
                        </Badge>
                      )}
                    </span>
                    {row.detail && <span className="text-xs whitespace-pre-line text-ink-500 wrap-anywhere">{row.detail}</span>}
                  </div>
                </TableCell>
                <TableCell className="px-4 align-top text-[13px] whitespace-normal text-ink-600 wrap-anywhere">{row.who}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <div className="p-4">
          <EmptyState>Henüz kayıt yok.</EmptyState>
        </div>
      )}
    </Card>
  );
}
