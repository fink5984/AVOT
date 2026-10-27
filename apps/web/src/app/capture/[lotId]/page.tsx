import { notFound } from "next/navigation";
import { PHOTO_CATEGORIES, type PhotoCategory } from "@avot/shared";
import { requirePageUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { db } from "@/server/db";
import { env } from "@/server/env";
import { loadCaptureContext } from "@/server/services/capture-context";
import { CaptureStudio } from "@/components/capture/studio";
import { getLotForUser } from "@/server/services/lots";

export const metadata = { title: "צילום" };

export default async function CapturePage({ params, searchParams }: { params: Promise<{ lotId: string }>; searchParams: Promise<{ category?: string }> }) {
  const user = await requirePageUser("photo.capture");
  const { lotId } = await params;
  const { category } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(lotId)) notFound();
  // the id may be a catalog lot or an inventory book (scanned tag / inventory screen)
  const ctx = await loadCaptureContext(user.organizationId, lotId);
  if (!ctx) notFound();
  if (ctx.target === "lot" && !(await getLotForUser(user, lotId).catch(() => null))) notFound();

  const pref = await db.userPreference.findUnique({ where: { userId_key: { userId: user.userId, key: "capture" } } });
  const e = env();
  const simulatorAllowed = e.APP_ENV === "development" || e.APP_ENV === "test" || (e.ENABLE_SIMULATOR && can(user.role, "simulator.use"));
  const initialCategory: PhotoCategory = PHOTO_CATEGORIES.includes(category as PhotoCategory) ? (category as PhotoCategory) : "COVER";

  return (
    <CaptureStudio
      user={{ id: user.userId, name: user.name, canOrganize: can(user.role, "photo.organize"), canStatus: can(user.role, "lot.status"), canDelete: can(user.role, "photo.delete"), canCreate: can(user.role, "inventory.create") && can(user.role, "lot.create") }}
      initialContext={ctx}
      initialCategory={initialCategory}
      serverPrefs={pref?.value ?? null}
      simulatorAllowed={simulatorAllowed}
    />
  );
}
