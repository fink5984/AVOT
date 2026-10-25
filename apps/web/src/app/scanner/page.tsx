import { redirect } from "next/navigation";
import type { Metadata, Viewport } from "next";
import { getCurrentUser } from "@/server/auth/principal";
import { can } from "@/server/auth/permissions";
import { ScannerApp } from "./scanner-app";

export const metadata: Metadata = { title: "מסופון מחסן", manifest: "/scanner.webmanifest" };
export const viewport: Viewport = { themeColor: "#1a1917", width: "device-width", initialScale: 1, maximumScale: 1, userScalable: false };

/**
 * Warehouse handheld (PWA). Mobile-first, works with the device's built-in
 * scanner in keyboard-wedge mode; the worker never needs a desktop.
 */
export default async function ScannerPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/scanner");
  if (!can(user.role, "warehouse.view")) redirect("/?denied=1");
  return (
    <ScannerApp
      user={{ id: user.userId, name: user.name }}
      perms={{ operate: can(user.role, "warehouse.operate"), manage: can(user.role, "warehouse.manage") }}
    />
  );
}
