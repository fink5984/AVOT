import { Wordmark } from "@/components/brand";

/** Shared frame for the signed-out screens (login, invite, password reset). */
export function AuthFrame({ title, subtitle, children, footer }: { title: string; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh bg-canvas lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex flex-col px-6 py-8 sm:px-12">
        <Wordmark size="md" />
        <div className="flex flex-1 items-center justify-center py-12">
          <div className="w-full max-w-[380px]">
            <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{title}</h1>
            {subtitle && <div className="mt-2 text-[14px] leading-relaxed text-muted">{subtitle}</div>}
            {children}
            {footer && <div className="mt-8 text-[13px] leading-relaxed text-muted">{footer}</div>}
          </div>
        </div>
        <p className="text-[12px] text-faint">אבות | AVOT — ספרים עבריים, כתבי יד ויודאיקה</p>
      </div>
      <div className="relative hidden overflow-hidden bg-ink p-3 lg:block" aria-hidden>
        <div className="flex h-full flex-col justify-between rounded-2xl p-12 text-paper ring-1 ring-white/8">
          <span className="font-display text-[15px] font-bold tracking-wide text-white/50">AVOT STUDIO</span>
          <div>
            <div className="font-display text-[clamp(96px,11vw,168px)] font-bold leading-[0.85] text-white">
              אבות<span className="text-accent">.</span>
            </div>
            <p className="mt-8 max-w-sm text-[17px] leading-relaxed text-white/60">
              כל ספר, כל עמוד, כל צילום — נשמר, מאומת ומסודר לקטלוג.
            </p>
          </div>
          <div className="flex gap-8 text-[13px] text-white/45">
            <span>כריכה</span>
            <span>שער</span>
            <span>פנים</span>
            <span>חוץ</span>
          </div>
        </div>
      </div>
    </main>
  );
}
