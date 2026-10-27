import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { isEmailAllowed } from "@/lib/auth/allowlist";
import { requireEnv } from "@/lib/env";

const PUBLIC_PATHS = ["/login", "/auth/"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p));
}

/**
 * Refreshes the Supabase session cookie and performs the optimistic auth
 * redirect. Real authorization happens again close to the data (getCurrentUser).
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
          for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        },
      },
    },
  );

  // Do not run code between createServerClient and getClaims: it can cause
  // hard-to-debug random logouts.
  const { data } = await supabase.auth.getClaims();
  const email = data?.claims.email;
  const signedIn = Boolean(data?.claims.sub);
  const allowed = signedIn && isEmailAllowed(email);

  if (signedIn && !allowed) {
    await supabase.auth.signOut();
  }

  const { pathname } = request.nextUrl;

  const redirectTo = (path: string) => {
    const url = request.nextUrl.clone();
    url.pathname = path;
    url.search = "";
    if (signedIn && !allowed) url.searchParams.set("error", "not_allowed");
    const redirect = NextResponse.redirect(url);
    // Carry over refreshed or cleared session cookies.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  };

  if (!allowed && !isPublicPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    return redirectTo("/login");
  }

  if (allowed && pathname === "/login") {
    return redirectTo("/panel");
  }

  return response;
}
