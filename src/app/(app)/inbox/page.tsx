import type { Metadata } from "next";
import { Suspense } from "react";
import { InboxContent } from "./inbox-content";

export const metadata: Metadata = { title: "Gelen kutusu" };

export default function InboxPage(props: PageProps<"/inbox">) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Gelen kutusu</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Yükleniyor...</p>}>
        <InboxContent searchParams={props.searchParams} />
      </Suspense>
    </section>
  );
}
