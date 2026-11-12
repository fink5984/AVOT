import { Badge, type Tone } from "@/components/ui/badge";

/** The three independent states of a sale, each with its own badge: financial, physical (stage), and the release to picking. */

export const FINANCIAL_LABEL: Record<string, string> = { NONE: "טרם חושב חיוב", UNPAID: "ממתין לתשלום", PARTIAL: "שולם חלקית", PAID: "שולם במלואו" };
const FINANCIAL_TONE: Record<string, Tone> = { NONE: "neutral", UNPAID: "danger", PARTIAL: "warn", PAID: "green" };

export function FinancialBadge({ status, className }: { status: string; className?: string }) {
  if (status === "HIDDEN") return null;
  return (
    <Badge tone={FINANCIAL_TONE[status] ?? "neutral"} className={className}>
      {FINANCIAL_LABEL[status] ?? status}
    </Badge>
  );
}

export const STAGE_LABEL: Record<string, string> = {
  IN_WAREHOUSE: "במחסן",
  AWAITING_RELEASE: "ממתין לשחרור",
  AWAITING_PICK: "ממתין לליקוט",
  PICKED: "לוקט",
  PACKED: "נארז",
  SHIPPED: "נשלח",
  DELIVERED: "נמסר",
};
const STAGE_TONE: Record<string, Tone> = { IN_WAREHOUSE: "neutral", AWAITING_RELEASE: "neutral", AWAITING_PICK: "info", PICKED: "info", PACKED: "accent", SHIPPED: "green", DELIVERED: "green" };

/** physical / logistic stage; a sale that was not released yet says so instead of just "in the warehouse" */
export function StageBadge({ stage, released, className }: { stage: string; released: boolean; className?: string }) {
  const key = stage === "IN_WAREHOUSE" && !released ? "AWAITING_RELEASE" : stage;
  return (
    <Badge tone={STAGE_TONE[key] ?? "neutral"} className={className}>
      {STAGE_LABEL[key] ?? stage}
    </Badge>
  );
}

export const SHIPMENT_STATUS_LABEL: Record<string, string> = { DRAFT: "בהכנה", PACKED: "נארז", SHIPPED: "נשלח", DELIVERED: "נמסר", CANCELLED: "בוטל" };
const SHIPMENT_TONE: Record<string, Tone> = { DRAFT: "info", PACKED: "accent", SHIPPED: "green", DELIVERED: "green", CANCELLED: "neutral" };
export function ShipmentBadge({ status }: { status: string }) {
  return <Badge tone={SHIPMENT_TONE[status] ?? "neutral"}>{SHIPMENT_STATUS_LABEL[status] ?? status}</Badge>;
}

export const METHOD_LABEL: Record<string, string> = { CARRIER: "חברת משלוחים", PICKUP: "איסוף עצמי", HAND_DELIVERY: "מסירה ישירה" };
