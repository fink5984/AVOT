import { requirePageUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { HousesEditor } from "./houses-client";

export const metadata = { title: "בתי מכירות" };

export default async function HouseSettingsPage() {
  const user = await requirePageUser("house.manage");
  const houses = await db.auctionHouse.findMany({ where: { organizationId: user.organizationId }, orderBy: { sortOrder: "asc" } });
  return (
    <HousesEditor
      houses={houses.map((h) => ({
        id: h.id,
        slug: h.slug,
        name: h.name,
        nameEn: h.nameEn,
        logoUrl: h.logoUrl,
        primaryColor: h.primaryColor,
        accentColor: h.accentColor,
        settings: h.settings as { lotNumberWidth?: number; descriptionFooter?: string; publishCurrency?: string },
      }))}
    />
  );
}
