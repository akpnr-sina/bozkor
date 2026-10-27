import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { pageIndex } from "@/lib/nav";
import { CategoriesList } from "./categories-list";
import { LlmUsage } from "./llm-usage";

export const metadata: Metadata = { title: "Ayarlar" };

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        index={pageIndex("/settings")}
        title="Ayarlar"
        description="Bu ayın AI kullanımı ve bütçesi, profillerin kategorileri. Kaynakların durumu Kaynaklar sayfasında."
      />
      <Suspense fallback={<Loading />}>
        <LlmUsage />
      </Suspense>
      <Suspense fallback={<Loading />}>
        <CategoriesList />
      </Suspense>
    </div>
  );
}

const Loading = () => <p className="text-[13px] text-ink-500">Yükleniyor...</p>;
