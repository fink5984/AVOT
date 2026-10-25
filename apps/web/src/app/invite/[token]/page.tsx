import Link from "next/link";
import { AuthFrame } from "@/components/auth-frame";
import { SetPasswordForm } from "@/components/set-password-form";
import { t } from "@/i18n";
import { findInvite } from "@/server/services/users";

export const metadata = { title: "הצטרפות" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await findInvite(token);
  if (!invite) {
    return (
      <AuthFrame title="ההזמנה אינה בתוקף" subtitle="ייתכן שכבר נעשה בה שימוש או שפג תוקפה. בקשו ממנהל המערכת הזמנה חדשה.">
        <Link href="/login" className="mt-6 inline-flex h-10 items-center rounded-md bg-ink px-5 text-[14px] font-medium text-paper hover:bg-[#2d2b28]">
          למסך הכניסה
        </Link>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame
      title={`שלום ${invite.name}`}
      subtitle={
        <>
          הוזמנת להצטרף כ{t.role[invite.role]} <span dir="ltr">({invite.email})</span>. בחרו סיסמה כדי להפעיל את החשבון.
        </>
      }
    >
      <SetPasswordForm endpoint={`/api/auth/invite/${encodeURIComponent(token)}`} submitLabel="הפעלת החשבון" redirectTo="/" />
    </AuthFrame>
  );
}
