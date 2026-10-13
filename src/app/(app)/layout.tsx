import Link from "next/link";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { signOut } from "./actions";
import { NavLinks, NavList } from "./nav-links";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-4">
          <Link href="/inbox" className="font-semibold">
            Bozkor İhale
          </Link>
          {/* The active link depends on the URL, which dynamic routes only know at request time. */}
          <Suspense fallback={<NavList pathname={null} />}>
            <NavLinks />
          </Suspense>
          <div className="ml-auto">
            <Suspense>
              <UserMenu />
            </Suspense>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">{children}</main>
    </div>
  );
}

async function UserMenu() {
  const user = await getCurrentUser();

  return (
    <form action={signOut} className="flex items-center gap-3 text-sm">
      <span className="text-muted-foreground">{user.email}</span>
      <Button type="submit" variant="outline" size="sm">
        Çıkış
      </Button>
    </form>
  );
}
