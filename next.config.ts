import type { NextConfig } from "next";

const BASE_DOMAIN = process.env.BASE_DOMAIN ?? "trent.app";

const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "connect-src 'self' https: wss:",
      "frame-src 'self' https:",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  typedRoutes: true,
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["e2b", "@daytona/sdk", "pino", "pino-pretty", "thread-stream", "sonic-boom"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },

  /**
   * Subdomain routing: [slug].trent.app → /public/[slug]
   *
   * When deployed, set BASE_DOMAIN=trent.app so that requests to
   * any subdomain (e.g. acme.trent.app) get rewritten to the public
   * company dashboard route.
   */
  async rewrites() {
    return {
      beforeFiles: [
        {
          // Match requests where the host begins with a slug subdomain
          source: "/:path*",
          has: [
            {
              type: "host",
              value: `(?<slug>[^.]+)\\.${BASE_DOMAIN.replace(".", "\\.")}`,
            },
          ],
          destination: "/public/:slug/:path*",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
