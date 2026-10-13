import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { io } from "next/cache";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getDb } from "@/db";
import { criteriaProfiles } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth/session";
import { categoryOptions } from "../categories";
import { ProfileForm } from "../profile-form";
import { readStoredRules } from "../stored-rules";

export const metadata: Metadata = { title: "Profil" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function EditProfilePage(props: PageProps<"/profiles/[id]">) {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Kriter profili</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Yükleniyor...</p>}>
        <EditProfile params={props.params} searchParams={props.searchParams} />
      </Suspense>
    </section>
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

  return (
    <>
      {problems.length > 0 && (
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">
            Kayıtlı kurallarda artık geçerli olmayan değerler var. Bu profil düzeltilene kadar eşleştirmede kullanılmıyor.
          </p>
          <p className="mt-1">Aşağıdakiler formdan çıkarıldı; kontrol edip kaydedin:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((problem, i) => (
              <li key={i}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      <ProfileForm
        profileId={profile.id}
        initialName={profile.name}
        initialActive={profile.active}
        initialRules={rules}
        categories={await categoryOptions()}
        savedNotice={query.saved ? "Profil oluşturuldu ve açık ihalelerle eşleştirildi." : undefined}
      />
    </>
  );
}
