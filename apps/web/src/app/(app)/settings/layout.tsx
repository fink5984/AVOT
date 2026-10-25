import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { PageHeader } from "@/components/ui/misc";
import { SettingsNav } from "./settings-nav";

/** All settings live in one place: one sidebar entry, tabs for each area. */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const items = [
    { href: "/settings", label: "העדפות צילום" },
    ...(can(user.role, "device.manage") ? [{ href: "/settings/stations", label: "עמדות צילום" }] : []),
    ...(can(user.role, "house.manage") ? [{ href: "/settings/houses", label: "בתי מכירות" }] : []),
    ...(can(user.role, "user.manage") ? [{ href: "/settings/users", label: "משתמשים והרשאות" }] : []),
    ...(can(user.role, "audit.view") ? [{ href: "/settings/audit", label: "יומן פעילות" }] : []),
  ];
  return (
    <>
      <PageHeader title="הגדרות" className="pb-0">
        {items.length > 1 && <SettingsNav items={items} />}
      </PageHeader>
      <div className="px-4 pb-10 pt-6 lg:px-8">{children}</div>
    </>
  );
}
