import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { pageIndex } from "@/lib/nav";
import { InboxContent } from "./inbox-content";

export const metadata: Metadata = { title: "Gelen kutusu" };

export default function InboxPage(props: PageProps<"/inbox">) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-[18px]">
          <PageHeader index={pageIndex("/inbox")} title="Gelen kutusu" />
          <p className="text-[13px] text-ink-500">Yükleniyor...</p>
        </div>
      }
    >
      <InboxContent searchParams={props.searchParams} />
    </Suspense>
  );
}
