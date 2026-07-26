import type { NextConfig } from "next";

// NOT a static export. The engine runs on the Node runtime. The product's
// marketing site stays static; this engine commits content into its repo and
// triggers its redeploy.
const nextConfig: NextConfig = {
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
