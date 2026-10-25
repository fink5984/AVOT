import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { activeHouse } from "@/server/services/houses";
import { AppShell } from "@/components/shell/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  // warehouse-only users never see the auction houses' commercial screens
  const { houses, active } = can(user.role, "catalog.view") ? await activeHouse(user) : { houses: [], active: null };
  return (
    <AppShell
      user={{ userId: user.userId, name: user.name, role: user.role, email: user.email }}
      houses={houses.map((h) => ({ slug: h.slug, name: h.name, color: h.accentColor }))}
      activeHouse={active?.slug ?? null}
    >
      {children}
    </AppShell>
  );
}
