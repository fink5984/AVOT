import { forwardRef, useId } from "react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-md border border-rule-strong bg-paper px-3 text-[13.5px] text-ink shadow-card placeholder:text-faint transition-[border-color,box-shadow] hover:border-[#c6c2b8] focus:border-ink/60 focus:outline-none focus-visible:outline-none focus:ring-[3px] focus:ring-ink/8 disabled:bg-stone-2 disabled:text-muted aria-[invalid=true]:border-danger";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cn(control, "h-9", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, rows = 3, ...rest },
  ref,
) {
  return <textarea ref={ref} rows={rows} className={cn(control, "py-2 leading-relaxed resize-y", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cn(control, "h-9 pe-2 cursor-pointer", className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({
  label,
  hint,
  error,
  children,
  className,
  required,
}: {
  label: string;
  hint?: React.ReactNode;
  error?: string | null;
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => React.ReactNode;
  className?: string;
  required?: boolean;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink-2">
        {label}
        {required && <span className="text-accent ms-0.5" aria-hidden>*</span>}
      </label>
      {children({ id, "aria-invalid": error ? true : undefined, "aria-describedby": error || hint ? descId : undefined })}
      {error ? (
        <p id={descId} className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={descId} className="text-[12px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, className, ...rest }: { label: React.ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cn("inline-flex items-center gap-2 text-[13px] cursor-pointer select-none", className)}>
      <input type="checkbox" className="size-4 rounded-xs accent-[var(--color-ink)] cursor-pointer" {...rest} />
      {label}
    </label>
  );
}

/**
 * On/off switch. A restyled native checkbox (not role="switch"), so labels,
 * keyboard and form behaviour stay exactly those of a checkbox.
 */
export function Switch({
  label,
  tone = "light",
  className,
  ...rest
}: { label: React.ReactNode; tone?: "light" | "studio" } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className={cn("flex cursor-pointer select-none items-center justify-between gap-3 text-[13px]", className)}>
      <span>{label}</span>
      <input
        type="checkbox"
        className={cn(
          "relative h-[18px] w-8 shrink-0 cursor-pointer appearance-none rounded-full transition-colors",
          "before:absolute before:start-[2px] before:top-[2px] before:size-[14px] before:rounded-full before:shadow-sm before:transition-transform checked:before:-translate-x-[14px]",
          tone === "studio" ? "bg-studio-3 before:bg-studio-muted checked:bg-studio-text checked:before:bg-studio" : "bg-rule-strong before:bg-white checked:bg-ink",
        )}
        {...rest}
      />
    </label>
  );
}
