import type { CatalogStatus, CommercialStatus, LotStatus, PhysicalStatus } from "@avot/shared";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";

export type Tone = "neutral" | "green" | "accent" | "warn" | "danger" | "info";

const TONES: Record<Tone, { box: string; dot: string }> = {
  neutral: { box: "bg-stone text-ink-2", dot: "bg-faint" },
  green: { box: "bg-green-soft text-green-2", dot: "bg-green" },
  accent: { box: "bg-accent-soft text-accent-2", dot: "bg-accent" },
  warn: { box: "bg-warn-soft text-warn", dot: "bg-warn" },
  danger: { box: "bg-danger-soft text-danger", dot: "bg-danger" },
  info: { box: "bg-info-soft text-info", dot: "bg-info" },
};

export function toneDot(tone: Tone) {
  return TONES[tone].dot;
}

export function Badge({ tone = "neutral", children, className, dot = true }: { tone?: Tone; children: React.ReactNode; className?: string; dot?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium leading-none",
        TONES[tone].box,
        className,
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", TONES[tone].dot)} aria-hidden />}
      {children}
    </span>
  );
}

export const LOT_TONE: Record<LotStatus, Tone> = {
  NOT_STARTED: "neutral",
  IN_PROGRESS: "accent",
  PENDING_REVIEW: "info",
  COMPLETED: "green",
  NEEDS_RESHOOT: "danger",
};

export function LotStatusBadge({ status, className }: { status: LotStatus; className?: string }) {
  return (
    <Badge tone={LOT_TONE[status]} className={className}>
      {t.lotStatus[status]}
    </Badge>
  );
}

const CATALOG_TONE: Record<CatalogStatus, Tone> = { DRAFT: "neutral", ACTIVE: "green", ARCHIVED: "neutral" };

export function CatalogStatusBadge({ status }: { status: CatalogStatus }) {
  return <Badge tone={CATALOG_TONE[status]} dot={status !== "ARCHIVED"}>{t.catalogStatus[status]}</Badge>;
}

const UPLOAD_TONE: Record<string, Tone> = { PENDING: "warn", UPLOADING: "info", VERIFIED: "green", FAILED: "danger" };

export function UploadBadge({ status }: { status: "PENDING" | "UPLOADING" | "VERIFIED" | "FAILED" }) {
  return <Badge tone={UPLOAD_TONE[status]}>{t.serverUpload[status]}</Badge>;
}

export const PHYSICAL_TONE: Record<PhysicalStatus, Tone> = {
  AWAITING_STORAGE: "warn",
  IN_STORAGE: "green",
  AWAITING_PICK: "accent",
  PICKED: "info",
  PACKED: "info",
  SHIPPED: "neutral",
  MISSING: "danger",
};

export function PhysicalStatusBadge({ status, className }: { status: PhysicalStatus; className?: string }) {
  return (
    <Badge tone={PHYSICAL_TONE[status]} className={className}>
      {t.physicalStatus[status]}
    </Badge>
  );
}

export const COMMERCIAL_TONE: Record<CommercialStatus, Tone> = {
  UNASSIGNED: "neutral",
  ASSIGNED: "info",
  OFFERED: "accent",
  SOLD: "green",
  UNSOLD: "warn",
  WITHDRAWN: "neutral",
};

export function CommercialStatusBadge({ status, className }: { status: CommercialStatus; className?: string }) {
  return (
    <Badge tone={COMMERCIAL_TONE[status]} className={className} dot={status !== "UNASSIGNED"}>
      {t.commercialStatus[status]}
    </Badge>
  );
}

export function PhotoStatusBadge({ status, className }: { status: LotStatus; className?: string }) {
  return (
    <Badge tone={LOT_TONE[status]} className={className}>
      {t.photoStatus[status]}
    </Badge>
  );
}
