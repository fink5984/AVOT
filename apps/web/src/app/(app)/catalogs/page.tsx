import { redirect } from "next/navigation";
import { requirePageUser } from "@/server/auth/principal";
import { activeHouse } from "@/server/services/houses";
import { CatalogsView, type CatalogsSearch } from "./catalogs-view";

export const metadata = { title: "קטלוגים" };

/** Catalogs of the auction house selected in the switcher (same view as /houses/<slug>, without a redirect hop). */
export default async function CatalogsPage({ searchParams }: { searchParams: Promise<CatalogsSearch> }) {
  const user = await requirePageUser("catalog.view");
  const { houses, active } = await activeHouse(user);
  if (!active) redirect("/houses");
  return <CatalogsView user={user} house={active} houses={houses} sp={await searchParams} />;
}
