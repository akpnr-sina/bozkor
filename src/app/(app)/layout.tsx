import { Sidebar } from "./sidebar";
import { TopBar } from "./top-bar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-1">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="flex min-w-0 flex-1 flex-col p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}
