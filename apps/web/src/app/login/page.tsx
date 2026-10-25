import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth/principal";
import { AuthFrame } from "@/components/auth-frame";
import { LoginForm } from "./login-form";

export const metadata = { title: "כניסה" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await getCurrentUser()) redirect(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
  return (
    <AuthFrame
      title="כניסה למערכת"
      subtitle="מערכת הצילום וניהול הקטלוגים של בית המכירות"
      footer="אין לכם חשבון? מנהל המערכת שולח קישור הזמנה. שכחתם סיסמה? מנהל המערכת מפיק קישור איפוס."
    >
      <LoginForm />
    </AuthFrame>
  );
}
