import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isEmailAllowed } from "./allowlist";

export type CurrentUser = {
  id: string;
  email: string;
};

/**
 * Verifies the session JWT and the allowlist on every call; redirects to
 * /login otherwise. Use it in Server Actions and Route Handlers, which must
 * authorize themselves rather than trust a cached render.
 */
export async function requireUser(): Promise<CurrentUser> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.auth.getClaims();
  const claims = data?.claims;

  if (!claims?.sub || !isEmailAllowed(claims.email)) {
    redirect("/login");
  }

  return { id: claims.sub, email: claims.email };
}

/**
 * Data access layer entry point for Server Components: the same check as
 * requireUser. Call it in every page that touches data; the proxy check
 * alone is not authorization.
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
  return requireUser();
}
