import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@gleeday/domain"],
  poweredByHeader: false,
  // pg is only used by the local-development data mode (see lib/data.ts).
  serverExternalPackages: ["pg"],
};

export default nextConfig;
