import type { Metadata } from "next";
import { io } from "next/cache";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { getCurrentUser } from "@/lib/auth/session";
import { pageIndex } from "@/lib/nav";
import { cpvItems } from "@/matching/cpv";
import { noticeTypes, profileRulesSchema, sourceIds } from "@/matching/rules";
import { categoryOptions } from "../categories";
import { toState } from "../form-initial";
import { ProfileForm } from "../profile-form";

export const metadata: Metadata = { title: "Yeni profil" };

export default function NewProfilePage() {
  return (
    <div className="flex flex-col gap-[18px]">
      <PageHeader
        index={pageIndex("/profiles")}
        title="Yeni profil"
        description="Kriterleri girin; sağdaki önizleme son 30 günün ilanlarıyla ne yakalanacağını gösterir. Kaydedince açık ihalelerle eşleştirilir."
      />
      <Suspense fallback={<p className="text-[13px] text-ink-500">Yükleniyor...</p>}>
        <NewProfile />
      </Suspense>
    </div>
  );
}

async function NewProfile() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const categories = await categoryOptions();
  return (
    <ProfileForm
      initialState={toState("", true, profileRulesSchema.parse({}))}
      choices={{ sources: sourceIds, noticeTypes }}
      categories={categories}
      cpvNames={cpvItems(categories.flatMap((c) => c.cpvPrefixes))}
    />
  );
}
