import { redirect } from "next/navigation";
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
 *
 * `use cache: private` lets the per-session App Shell prerender read the
 * session: the Supabase client compares the token expiry with Date.now(),
 * which Cache Components only allows inside a cache scope. The result is never
 * stored on the server across requests, so every request verifies the JWT and
 * the allowlist again; only the browser's router cache keeps the rendered
 * output, for the default profile's 5 minute stale time.
 */
export async function getCurrentUser(): Promise<CurrentUser> {
  "use cache: private";
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub || !isEmailAllowed(claims.email)) {
    redirect("/login");
  }

  return { id: claims.sub, email: claims.email };
}
