import type { Metadata } from "next";

export const metadata: Metadata = { title: "Gelen kutusu" };

export default function InboxPage() {
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">Gelen kutusu</h1>
      <p className="text-sm text-muted-foreground">Henüz eşleşen ihale yok.</p>
    </section>
  );
}
