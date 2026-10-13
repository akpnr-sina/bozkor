import type { Metadata } from "next";

export const metadata: Metadata = { title: "Profiller" };

export default function ProfilesPage() {
  return (
    <section className="flex flex-col gap-2">
      <h1 className="text-xl font-semibold">Kriter profilleri</h1>
      <p className="text-sm text-muted-foreground">Henüz profil yok.</p>
    </section>
  );
}
