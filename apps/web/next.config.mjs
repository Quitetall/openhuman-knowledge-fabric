/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source rather than prebuilt bundles.
  transpilePackages: ['@kf/ui'],
  poweredByHeader: false,
};

export default nextConfig;
