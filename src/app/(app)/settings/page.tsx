import type { Metadata } from "next";

export const metadata: Metadata = { title: "Ayarlar" };

export default function SettingsPage() {
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">Ayarlar</h1>
      <p className="text-sm text-muted-foreground">
        Kaynak senkron durumu, LLM harcaması ve kategoriler burada görünecek.
      </p>
    </section>
  );
}
