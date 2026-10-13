import type { Metadata } from "next";
import { io } from "next/cache";
import { Suspense } from "react";
import { getCurrentUser } from "@/lib/auth/session";
import { profileRulesSchema } from "@/matching/rules";
import { categoryOptions } from "../categories";
import { ProfileForm } from "../profile-form";

export const metadata: Metadata = { title: "Yeni profil" };

export default function NewProfilePage() {
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Yeni kriter profili</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Yükleniyor...</p>}>
        <NewProfile />
      </Suspense>
    </section>
  );
}

async function NewProfile() {
  await getCurrentUser();
  // postgres-js calls Math.random() while it builds its pool; keep it out of the prerender.
  await io();
  return (
    <ProfileForm
      initialName=""
      initialActive
      initialRules={profileRulesSchema.parse({})}
      categories={await categoryOptions()}
    />
  );
}
