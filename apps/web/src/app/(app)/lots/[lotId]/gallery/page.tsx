import { redirect } from "next/navigation";

/** The gallery is part of the book screen now; old links keep working. */
export default async function GalleryRedirect({ params, searchParams }: { params: Promise<{ lotId: string }>; searchParams: Promise<{ category?: string }> }) {
  const { lotId } = await params;
  const { category } = await searchParams;
  redirect(`/lots/${lotId}${category ? `?category=${encodeURIComponent(category)}` : ""}`);
}
