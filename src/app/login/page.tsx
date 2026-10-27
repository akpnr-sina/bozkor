import type { Metadata } from "next";
import { Suspense } from "react";
import { BozkorLogo } from "@/components/brand";
import { Notice } from "@/components/notice";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Giriş" };

const ERROR_MESSAGES: Record<string, string> = {
  link: "Bağlantı geçersiz ya da süresi dolmuş. Yeni bir bağlantı isteyin.",
  not_allowed: "Bu e-posta adresinin erişim izni yok.",
};

export default function LoginPage(props: PageProps<"/login">) {
  return (
    <main className="flex flex-1 items-center justify-center bg-canvas p-4">
      <div className="flex w-full max-w-[400px] flex-col gap-6 border border-line bg-surface p-8">
        <div className="flex flex-col gap-5">
          <BozkorLogo className="text-ink-900" />
          <div className="flex flex-col gap-2.5">
            <span className="eyebrow">İhale radarı</span>
            <h1 className="font-heading text-[30px] leading-none font-semibold text-ink-900">Giriş</h1>
            <p className="text-[13px] text-ink-600">E-posta adresinize tek kullanımlık giriş bağlantısı gönderilir.</p>
          </div>
        </div>
        <Suspense>
          <LinkError searchParams={props.searchParams} />
        </Suspense>
        <LoginForm />
      </div>
    </main>
  );
}

async function LinkError({ searchParams }: { searchParams: PageProps<"/login">["searchParams"] }) {
  const { error } = await searchParams;
  const message = typeof error === "string" ? ERROR_MESSAGES[error] : undefined;
  if (!message) return null;
  return <Notice tone="err" role="alert" title={message} />;
}
