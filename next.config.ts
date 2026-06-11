import type { NextConfig } from "next";

const BASE_DOMAIN = process.env.BASE_DOMAIN ?? "trent.app";

const nextConfig: NextConfig = {
  typedRoutes: true,
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ["e2b", "@daytona/sdk", "pino", "pino-pretty", "thread-stream", "sonic-boom"],

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
