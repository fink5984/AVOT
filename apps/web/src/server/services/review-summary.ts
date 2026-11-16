import "server-only";
import { db } from "../db";
import type { getItemDetail } from "./inventory";
import type { ReviewSummary } from "@/components/ai/item-review-panel";

type Detail = NonNullable<Awaited<ReturnType<typeof getItemDetail>>>;

/** Who did what to a book's details, for the reviewer: the same lines on the book page and on its lot page. */
export async function buildReviewSummary({ item, events, audit }: Pick<Detail, "item" | "events" | "audit">): Promise<ReviewSummary> {
  // the rows are newest first
  const startEvent = item.reviewStatus === "IN_REVIEW" ? events.find((e) => e.dimension === "REVIEW" && e.toStatus === "IN_REVIEW") : undefined;
  const lastEdit = audit.find((a) => a.action === "inventory.updated");
  const aiEdit = audit.find((a) => a.action === "inventory.updated" && (a.data as { via?: string } | null)?.via === "ai");
  const invalidated = item.reviewStatus !== "APPROVED" ? audit.find((a) => a.action === "item_review.invalidated") : undefined;
  const prev = (invalidated?.data ?? {}) as { previousApprovedById?: string | null; previousApprovedAt?: string | null };
  const prevName = prev.previousApprovedById ? ((await db.user.findUnique({ where: { id: prev.previousApprovedById }, select: { name: true } }))?.name ?? null) : null;
  return {
    startedBy: startEvent?.userName ?? null,
    startedAt: startEvent?.createdAt.toISOString() ?? null,
    lastEditBy: lastEdit?.user?.name ?? null,
    lastEditAt: lastEdit?.createdAt.toISOString() ?? null,
    aiAdditionBy: aiEdit?.user?.name ?? null,
    aiAdditionAt: aiEdit?.createdAt.toISOString() ?? null,
    previousApprovedBy: prevName,
    previousApprovedAt: prev.previousApprovedAt ?? null,
  };
}
