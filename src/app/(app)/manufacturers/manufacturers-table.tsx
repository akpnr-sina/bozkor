import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FAMILIES } from "@/manufacturers/families";
import { CONTACT_STATE_LABELS, FIT_LEVEL_LABELS } from "@/manufacturers/labels";
import type { ManufacturerForMatch } from "@/manufacturers/types";
import { PRODUCT_CATEGORIES } from "@/policy/categories";

// The /manufacturers list's rows (SPEC 10: name, fields, products, province, certificates), from the pool's
// projection; the firm's page has the rest.

/** Products shown in a row before "ve N ürün daha". */
const PRODUCTS_IN_ROW = 3;
const CERTIFICATES_IN_ROW = 3;

export function ManufacturersTable({ rows }: { rows: ManufacturerForMatch[] }) {
  return (
    <div className="border border-line bg-surface">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Unvan</TableHead>
            <TableHead>Alanlar</TableHead>
            <TableHead className="hidden lg:table-cell">Ürünler</TableHead>
            <TableHead>İl</TableHead>
            <TableHead className="hidden md:table-cell">Belgeler</TableHead>
            <TableHead className="hidden md:table-cell">İletişim</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((m) => (
            <TableRow key={m.id}>
              <TableCell className="max-w-72 whitespace-normal">
                <Link href={`/manufacturers/${m.id}`} className="font-medium text-ink-900 underline-offset-4 hover:underline">
                  {m.legalName}
                </Link>
                {m.fitLevel === "low" && (
                  <div className="mt-1">
                    <Badge variant="warn">Araştırmacı notu: {FIT_LEVEL_LABELS.low}</Badge>
                  </div>
                )}
              </TableCell>
              <TableCell className="max-w-64 whitespace-normal">
                <div className="text-[13px] text-ink-900">{m.categories.map((c) => PRODUCT_CATEGORIES[c].label).join(", ") || "Kategori yok"}</div>
                {m.families.length > 0 && (
                  <div className="mt-0.5 text-xs text-ink-500">{m.families.map((f) => `${f} ${FAMILIES[f].label}`).join(" · ")}</div>
                )}
              </TableCell>
              <TableCell className="hidden max-w-80 whitespace-normal text-[13px] text-ink-600 lg:table-cell">
                <Listed items={m.products} max={PRODUCTS_IN_ROW} />
              </TableCell>
              <TableCell className="text-[13px]">{m.province ?? <span className="text-ink-400">Bilinmiyor</span>}</TableCell>
              <TableCell className="hidden max-w-56 whitespace-normal md:table-cell">
                <Certificates m={m} />
              </TableCell>
              <TableCell className="hidden text-[13px] md:table-cell">
                <div className="text-ink-900">{CONTACT_STATE_LABELS[m.contactState]}</div>
                {!m.hasContact && <div className="text-xs text-ink-500">İletişim bilgisi yok</div>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function Listed({ items, max }: { items: string[]; max: number }) {
  if (!items.length) return <span className="text-ink-400">Yok</span>;
  const rest = items.length - max;
  return (
    <>
      {items.slice(0, max).join(", ")}
      {rest > 0 && <span className="text-ink-500"> ve {rest} ürün daha</span>}
    </>
  );
}

function Certificates({ m }: { m: ManufacturerForMatch }) {
  const names = [...(m.aqap === "2110" || m.aqap === "2120" ? [`AQAP ${m.aqap}`] : []), ...m.certifications.map((c) => c.name)];
  const unique = [...new Set(names)];
  if (!unique.length) return <span className="text-[13px] text-ink-400">Bilinmiyor</span>;
  const rest = unique.length - CERTIFICATES_IN_ROW;
  return (
    <div className="flex flex-wrap gap-1">
      {unique.slice(0, CERTIFICATES_IN_ROW).map((name) => (
        <Badge key={name} variant="outline">
          {name}
        </Badge>
      ))}
      {rest > 0 && <span className="self-center text-xs text-ink-500">+{rest}</span>}
    </div>
  );
}
