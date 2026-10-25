import Link from "next/link";
import { AuthFrame } from "@/components/auth-frame";
import { SetPasswordForm } from "@/components/set-password-form";
import { findResetToken } from "@/server/services/users";

export const metadata = { title: "איפוס סיסמה" };

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const row = await findResetToken(token);
  if (!row) {
    return (
      <AuthFrame title="הקישור אינו בתוקף" subtitle="קישורי איפוס תקפים לשעתיים ולשימוש אחד. בקשו קישור חדש ממנהל המערכת.">
        <Link href="/login" className="mt-6 inline-flex h-10 items-center rounded-md bg-ink px-5 text-[14px] font-medium text-paper hover:bg-[#2d2b28]">
          למסך הכניסה
        </Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="איפוס סיסמה" subtitle={<span dir="ltr">{row.user.email}</span>}>
      <SetPasswordForm endpoint={`/api/auth/reset/${encodeURIComponent(token)}`} submitLabel="שמירת סיסמה" redirectTo="/login" />
    </AuthFrame>
  );
}
