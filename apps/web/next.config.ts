import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@gleeday/domain", "@gleeday/migration"],
  poweredByHeader: false,
  // pg is only used by the local-development data mode (see lib/data.ts).
  serverExternalPackages: ["pg"],
  experimental: {
    // The spreadsheet import sends chunks of up to ~600 KB.
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
