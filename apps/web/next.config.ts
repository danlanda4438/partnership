import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@gleeday/domain"],
  poweredByHeader: false,
};

export default nextConfig;
