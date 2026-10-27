import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { io } from "next/cache";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Notice } from "@/components/notice";
import { PageHeader } from "@/components/page-header";
import { getDb } from "@/db";
import { criteriaProfiles } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { pageIndex } from "@/lib/nav";
import { cpvItems } from "@/matching/cpv";
import { noticeTypes, sourceIds } from "@/matching/rules";
import { categoryOptions } from "../categories";
import { toState } from "../form-initial";
import { ProfileForm } from "../profile-form";
import { readStoredRules } from "../stored-rules";

export const metadata: Metadata = { title: "Profil" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESCRIPTION = "Kriter profili. Kaydedince açık ihalelerle yeniden eşleştirilir.";

export default function EditProfilePage(props: PageProps<"/profiles/[id]">) {
  return (
    <div className="flex flex-col gap-[18px]">
      <Suspense
        fallback={
          <>
            <PageHeader index={pageIndex("/profiles")} title="Profil" description={DESCRIPTION} />
            <p className="text-[13px] text-ink-500">Yükleniyor...</p>
          </>
        }
      >
        <EditProfile params={props.params} searchParams={props.searchParams} />
      </Suspense>
    </div>
  );
}

async function EditProfile({
  params,
  searchParams,
}: {
  params: PageProps<"/profiles/[id]">["params"];
  searchParams: PageProps<"/profiles/[id]">["searchParams"];
}) {
  await getCurrentUser();
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!UUID.test(id)) notFound();
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  const [profile] = await getDb().select().from(criteriaProfiles).where(eq(criteriaProfiles.id, id));
  if (!profile) notFound();

  const { rules, problems } = readStoredRules(profile.rules);
  const categories = await categoryOptions();
  // The stored codes and the categories' ones shown by name; the vocabulary stays on the server.
  const cpvNames = cpvItems([...rules.cpvInclude, ...rules.cpvExclude, ...categories.flatMap((c) => c.cpvPrefixes)]);

  return (
    <>
      <PageHeader index={pageIndex("/profiles")} title={profile.name} description={DESCRIPTION} />
      {problems.length > 0 && (
        <Notice
          tone="err"
          role="alert"
          title="Kayıtlı kurallarda artık geçerli olmayan değerler var. Bu profil düzeltilene kadar eşleştirmede kullanılmıyor."
        >
          <p>Aşağıdakiler formdan çıkarıldı; kontrol edip kaydedin:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </Notice>
      )}
      <ProfileForm
        profileId={profile.id}
        initialState={toState(profile.name, profile.active, rules)}
        choices={{ sources: sourceIds, noticeTypes }}
        categories={categories}
        cpvNames={cpvNames}
        savedNotice={query.saved ? "Profil oluşturuldu ve açık ihalelerle eşleştirildi." : undefined}
      />
    </>
  );
}
