import { notFound } from "next/navigation";
import { requirePageUser } from "@/server/auth/principal";
import { getHouseBySlug, listHouses } from "@/server/services/houses";
import { CatalogsView, type CatalogsSearch } from "../../catalogs/catalogs-view";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return { title: `קטלוגים · ${(await params).slug === "tavin" ? "טבין" : "אבות"}` };
}

export default async function HouseCatalogsPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<CatalogsSearch> }) {
  const user = await requirePageUser("catalog.view");
  const { slug } = await params;
  const house = await getHouseBySlug(user, slug).catch(() => null);
  if (!house) notFound();
  return <CatalogsView user={user} house={house} houses={await listHouses(user)} sp={await searchParams} />;
}
