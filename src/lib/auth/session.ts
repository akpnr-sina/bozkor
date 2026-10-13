import { redirect } from "next/navigation";
import { cache } from "react";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isEmailAllowed } from "./allowlist";

export type CurrentUser = {
  id: string;
  email: string;
};

/**
 * Data access layer entry point: verifies the session JWT and the allowlist.
 * Call it in every page, Server Action and Route Handler that touches data;
 * the proxy check alone is not authorization.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser> => {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub || !isEmailAllowed(claims.email)) {
    redirect("/login");
  }

  return { id: claims.sub, email: claims.email };
});
