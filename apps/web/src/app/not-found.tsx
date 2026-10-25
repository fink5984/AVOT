import Link from "next/link";
import { Wordmark } from "@/components/brand";

export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas px-4 text-center">
      <Wordmark />
      <div className="num mt-10 font-display text-[88px] font-bold leading-none text-rule-strong">404</div>
      <h1 className="mt-4 text-[20px] font-semibold">הדף לא נמצא</h1>
      <p className="mt-1.5 text-[14px] text-muted">ייתכן שהפריט הועבר, נמחק, או שאין לך גישה אליו.</p>
      <Link href="/" className="mt-6 inline-flex h-10 items-center rounded-md bg-ink px-5 text-[14px] font-medium text-paper hover:bg-[#2d2b28]">
        ללוח העבודה
      </Link>
    </main>
  );
}
