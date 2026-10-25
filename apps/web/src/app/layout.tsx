import type { Metadata, Viewport } from "next";
import { Frank_Ruhl_Libre, IBM_Plex_Sans_Hebrew } from "next/font/google";
import { ToastProvider } from "@/components/ui/toast";
import "./globals.css";

const plex = IBM_Plex_Sans_Hebrew({
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex",
  display: "swap",
});
const frank = Frank_Ruhl_Libre({
  subsets: ["hebrew", "latin"],
  weight: ["500", "700"],
  variable: "--font-frank",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "AVOT Studio", template: "%s · AVOT Studio" },
  description: "מערכת צילום וניהול קטלוגים — אבות | AVOT",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#f4f3f0", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={`${plex.variable} ${frank.variable}`}>
      <body>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
