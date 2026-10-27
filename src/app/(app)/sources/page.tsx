import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { pageIndex } from "@/lib/nav";
import { DocumentsStatus } from "./documents-status";
import { SourceStatus } from "./source-status";

export const metadata: Metadata = { title: "Kaynaklar" };

export default function SourcesPage() {
  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader index={pageIndex("/sources")} title="Kaynaklar" description="İlanların ve dokümanların alındığı yerler, son senkronlar ve doküman deposu." />
      <Suspense fallback={<Loading />}>
        <SourceStatus />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <DocumentsStatus />
      </Suspense>
    </div>
  );
}

const Loading = () => <p className="text-[13px] text-ink-500">Yükleniyor...</p>;
