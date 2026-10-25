import { requirePageUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { UsersAdmin } from "./users-client";

export const metadata = { title: "משתמשים" };

export default async function UsersPage() {
  const admin = await requirePageUser("user.manage");
  const [users, invites, houses] = await Promise.all([
    db.user.findMany({ where: { organizationId: admin.organizationId }, orderBy: [{ status: "asc" }, { name: "asc" }], include: { houseAccess: true } }),
    db.invite.findMany({ where: { organizationId: admin.organizationId, acceptedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "desc" } }),
    db.auctionHouse.findMany({ where: { organizationId: admin.organizationId }, orderBy: { sortOrder: "asc" } }),
  ]);
  return (
    <>
      <UsersAdmin
        activeCount={users.filter((u) => u.status === "ACTIVE").length}
        currentUserId={admin.userId}
        houses={houses.map((h) => ({ id: h.id, name: h.name }))}
        users={users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          status: u.status,
          lastActiveAt: u.lastActiveAt?.toISOString() ?? null,
          houseIds: u.houseAccess.map((h) => h.auctionHouseId),
        }))}
        invites={invites.map((i) => ({ id: i.id, name: i.name, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() }))}
      />
    </>
  );
}
