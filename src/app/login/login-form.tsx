"use client";

import { useActionState } from "react";
import { Notice } from "@/components/notice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendMagicLink, type LoginState } from "./actions";

const initialState: LoginState = { status: "idle" };

export function LoginForm() {
  const [state, formAction, pending] = useActionState(sendMagicLink, initialState);

  if (state.status === "sent") {
    return (
      <Notice tone="ok" role="status" title="Giriş bağlantısı gönderildi">
        <span className="font-medium wrap-anywhere">{state.email}</span> adresine gelen e-postadaki bağlantıya tıklayarak giriş yapın.
      </Notice>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">E-posta</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          aria-invalid={state.status === "error" || undefined}
          aria-describedby={state.status === "error" ? "email-error" : undefined}
        />
      </div>
      {state.status === "error" && (
        <Notice tone="err" role="alert" title={<span id="email-error">{state.message}</span>} />
      )}
      <Button type="submit" disabled={pending} className="chamfer w-full">
        {pending ? "Gönderiliyor..." : "Giriş bağlantısı gönder"}
      </Button>
    </form>
  );
}
