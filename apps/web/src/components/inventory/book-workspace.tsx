import type { ReactNode } from "react";
import type { UserPrincipal } from "@/server/auth/principal";
import { can, canUser } from "@/server/auth/permissions";
import type { getItemDetail } from "@/server/services/inventory";
import type { AiState } from "@/server/services/ai-analysis";
import { listReviewNotes, noteStamp } from "@/server/services/review-notes";
import { buildReviewSummary } from "@/server/services/review-summary";
import { AiActivity } from "@/components/ai/ai-activity";
import { AiResearchSection } from "@/components/ai/ai-research-section";
import { ItemReviewPanel } from "@/components/ai/item-review-panel";
import { ReviewNotesPanel } from "@/components/review-notes/review-notes-panel";
import { serializeItemFormat } from "@/lib/rich-text";

type Detail = NonNullable<Awaited<ReturnType<typeof getItemDetail>>>;

/**
 * THE editing environment of one book - the same component on the book's page in the inventory and on its lot page in the
 * catalog (and, per book, on a combined lot's page): live AI state, the photos (passed in: each page has its own gallery),
 * "הערות לבדיקה", the catalog content with its editor / AI addition / review / approval, and the research with its sources.
 * Everything is read from the book (InventoryItem) - one source of truth - so both places always show the same data, and
 * the shared poll (AiActivity) keeps every open copy current without a reload.
 */
export async function BookWorkspace({
  user,
  detail,
  ai,
  gallery,
  beforePanel,
  showNotes = true,
  bookLabel,
}: {
  user: UserPrincipal;
  detail: Detail;
  ai: AiState;
  /** the page's photo gallery (shown between the live AI state and the notes) */
  gallery?: ReactNode;
  /** content between the notes and the catalog panel (the lot page's "dedicated text" explanation) */
  beforePanel?: ReactNode;
  /** a combined lot shows every book's notes together, above (see CombinedLotView) */
  showNotes?: boolean;
  /** a combined lot: which book this is ("ITM-000184 · שם הספר") */
  bookLabel?: string;
}) {
  const { item } = detail;
  const [notes, stamp, summary] = await Promise.all([listReviewNotes(user.organizationId, [item.id]), noteStamp(user.organizationId, item.id), buildReviewSummary(detail)]);
  const canEdit = can(user.role, "inventory.edit");
  const openNotes = (notes.get(item.id) ?? []).filter((n) => n.status === "OPEN").length;
  return (
    <>
      <AiActivity bookLabel={bookLabel} itemId={item.id} initial={{ aiStatus: ai.aiStatus, aiError: ai.aiError, detailsVersion: item.detailsVersion, photoStatus: item.photoStatus, notes: stamp, activity: ai.activity }} currentUserId={user.userId} />
      {gallery}
      {showNotes && <ReviewNotesPanel itemId={item.id} initial={notes.get(item.id) ?? []} canAdd={canUser(user, "reviewNote.add")} canResolve={canUser(user, "reviewNote.resolve")} bookLabel={bookLabel} />}
      {beforePanel}
      <ItemReviewPanel
        key={item.id}
        itemId={item.id}
        values={{
          itemType: item.itemType,
          title: item.title,
          subtitle: item.subtitle,
          author: item.author,
          printPlace: item.printPlace,
          printYear: item.printYear,
          publisher: item.publisher,
          edition: item.edition,
          extent: item.extent,
          bibliographicNotes: item.bibliographicNotes,
          conditionNotes: item.conditionNotes,
          catalogHeadline: item.catalogHeadline,
          catalogDescription: item.catalogDescription,
          textFormat: serializeItemFormat(item.textFormat),
          internalNotes: item.internalNotes,
          heightMm: item.heightMm === null ? null : String(item.heightMm),
          widthMm: item.widthMm === null ? null : String(item.widthMm),
          depthMm: item.depthMm === null ? null : String(item.depthMm),
          sizeCategory: item.sizeCategory,
          barcode: item.barcode !== item.inventoryNumber ? item.barcode : null,
          consignorId: item.consignor?.id ?? null,
        }}
        inventoryNumber={item.inventoryNumber}
        consignor={item.consignor ? { id: item.consignor.id, name: item.consignor.name } : null}
        summary={summary}
        detailsVersion={item.detailsVersion}
        ai={ai}
        canEdit={canEdit}
        canReview={canUser(user, "item.review")}
        canApprove={canUser(user, "item.review.approve")}
        canRestore={can(user.role, "ai.restore")}
        canRewrite={canEdit && can(user.role, "ai.analyze") && ai.available}
        canApply={can(user.role, "ai.apply")}
        openNotes={openNotes}
      />
      <AiResearchSection ai={ai} />
    </>
  );
}
