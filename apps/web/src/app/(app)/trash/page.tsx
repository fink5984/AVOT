import { Trash2 } from "lucide-react";
import { requirePageUser } from "@/server/auth/principal";
import { db } from "@/server/db";
import { assetSelect } from "@/server/services/assets";
import { EmptyState, PageBody, PageHeader } from "@/components/ui/misc";
import { TrashList } from "./trash-client";

export const metadata = { title: "סל מחזור" };

export default async function TrashPage() {
  const user = await requirePageUser("photo.delete");
  const org = await db.organization.findUnique({ where: { id: user.organizationId } });
  const items = await db.photoAsset.findMany({
    where: { organizationId: user.organizationId, deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    take: 500,
    select: { ...assetSelect, deletedById: true, item: { select: { id: true, inventoryNumber: true, title: true } } },
  });
  const deleters = await db.user.findMany({
    where: { id: { in: [...new Set(items.map((i) => i.deletedById).filter((x): x is string => !!x))] } },
    select: { id: true, name: true },
  });
  const retention = org?.trashRetentionDays ?? 30;

  return (
    <>
      <PageHeader title="סל מחזור" meta={<span>תמונות שנמחקו נשמרות {retention} ימים ואז נמחקות לצמיתות. עד אז ניתן לשחזר אותן למקומן.</span>} />
      <PageBody>
        {items.length === 0 ? (
          <div className="card">
            <EmptyState icon={<Trash2 />} title="סל המחזור ריק">
              תמונות שנמחקות מגיעות לכאן ואפשר לשחזר אותן למקומן.
            </EmptyState>
          </div>
        ) : (
          <TrashList
            retentionDays={retention}
            items={items.map((a) => ({
              id: a.id,
              thumbUrl: a.thumbKey ? `/api/assets/${a.id}/thumb` : null,
              rotation: a.rotation,
              category: a.category,
              sequence: a.sequence,
              deletedAt: a.deletedAt!.toISOString(),
              deletedBy: deleters.find((d) => d.id === a.deletedById)?.name ?? null,
              book: { id: a.item.id, inventoryNumber: a.item.inventoryNumber, title: a.item.title },
            }))}
          />
        )}
      </PageBody>
    </>
  );
}
