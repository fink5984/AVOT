import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // camera is needed on the capture screen (webcam mode); everything else is off
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  transpilePackages: ["@avot/shared"],
  serverExternalPackages: ["sharp", "archiver"],
  poweredByHeader: false,
  // type safety is enforced by `tsc --noEmit` (npm run typecheck) during build; no ESLint config in this repo
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
