import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { pageIndex } from "@/lib/nav";
import { ManufacturersContent } from "./manufacturers-content";

export const metadata: Metadata = { title: "Üreticiler" };

export default function ManufacturersPage(props: PageProps<"/manufacturers">) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-[18px]">
          <PageHeader index={pageIndex("/manufacturers")} title="Üreticiler" />
          <p className="text-[13px] text-ink-500">Yükleniyor...</p>
        </div>
      }
    >
      <ManufacturersContent searchParams={props.searchParams} />
    </Suspense>
  );
}
