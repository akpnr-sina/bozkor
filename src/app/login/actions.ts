"use server";

import { z } from "zod";
import { isEmailAllowed } from "@/lib/auth/allowlist";
import { requireEnv } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type LoginState =
  | { status: "idle" }
  | { status: "sent"; email: string }
  | { status: "error"; message: string };

const emailSchema = z.email();

export async function sendMagicLink(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = emailSchema.safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  if (!parsed.success) {
    return { status: "error", message: "Geçerli bir e-posta adresi girin." };
  }
  const email = parsed.data;

  if (!isEmailAllowed(email)) {
    return { status: "error", message: "Bu e-posta adresinin erişim izni yok." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: new URL("/auth/confirm", requireEnv("APP_URL")).toString(),
      // Users are created in the Supabase dashboard; sign-ups stay disabled.
      shouldCreateUser: false,
    },
  });

  if (error) {
    console.error("[auth] signInWithOtp failed", { email, code: error.code, message: error.message });
    return { status: "error", message: "Bağlantı gönderilemedi. Biraz sonra tekrar deneyin." };
  }

  return { status: "sent", email };
}
