import type { Metadata } from "next";
import { Suspense } from "react";
import { LlmUsage } from "./llm-usage";
import { SourceStatus } from "./source-status";

export const metadata: Metadata = { title: "Ayarlar" };

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Ayarlar</h1>
        <p className="text-sm text-muted-foreground">
          Kaynakların senkron durumu ve AI kullanımı. Kategori yönetimi sonraki fazlarda eklenecek.
        </p>
      </header>
      <section aria-labelledby="sources-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="sources-heading" className="text-base font-semibold">
            Kaynaklar
          </h2>
          <p className="text-sm text-muted-foreground">Saatler İstanbul saatine göre gösterilir.</p>
        </div>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Yükleniyor...</p>}>
          <SourceStatus />
        </Suspense>
      </section>
      <section aria-labelledby="llm-usage-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="llm-usage-heading" className="text-base font-semibold">
            AI kullanımı
          </h2>
          <p className="text-sm text-muted-foreground">
            Bu ayın LLM çağrıları ve harcaması (İstanbul takvim ayı). Bütçe LLM_MONTHLY_BUDGET_USD ile ayarlanır.
          </p>
        </div>
        <Suspense fallback={<p className="text-sm text-muted-foreground">Yükleniyor...</p>}>
          <LlmUsage />
        </Suspense>
      </section>
    </div>
  );
}
