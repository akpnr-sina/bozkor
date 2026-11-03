import type { Metadata } from "next";
import { io } from "next/cache";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getDb } from "@/db";
import { retryRead } from "@/db/retry";
import { getCurrentUser } from "@/lib/auth/session";
import { isManufacturerId, loadManufacturer } from "@/manufacturers/queries";
import { ManufacturerView } from "./manufacturer-view";

// /manufacturers/[id]: one firm of the pool, active or not (manufacturer-view.tsx).

export const metadata: Metadata = { title: "Üretici" };

export default function ManufacturerPage(props: PageProps<"/manufacturers/[id]">) {
  return (
    <Suspense
      fallback={
        <div className="flex flex-col gap-4">
          <Link href="/manufacturers" className="w-fit text-[13px] text-ink-500 hover:text-ink-900">
            Üreticiler
          </Link>
          <p className="text-sm text-ink-500">Yükleniyor...</p>
        </div>
      }
    >
      <ManufacturerDetail params={props.params} />
    </Suspense>
  );
}

async function ManufacturerDetail({ params }: { params: PageProps<"/manufacturers/[id]">["params"] }) {
  await getCurrentUser();
  const { id } = await params;
  if (!isManufacturerId(id)) notFound();
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const detail = await retryRead(() => loadManufacturer(getDb(), id));
  if (!detail) notFound();
  return <ManufacturerView detail={detail} />;
}
