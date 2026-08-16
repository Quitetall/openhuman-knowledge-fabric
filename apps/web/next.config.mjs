/** @type {import('next').NextConfig} */
const isolatedDistDir = process.env.KF_NEXT_DIST_DIR;
if (isolatedDistDir !== undefined && !/^\.next-e2e-[0-9]+$/.test(isolatedDistDir)) {
  throw new Error('KF_NEXT_DIST_DIR is reserved for process-scoped browser-test builds');
}

const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript source rather than prebuilt bundles.
  transpilePackages: ['@kf/ui'],
  poweredByHeader: false,
  experimental: {
    // 10 MiB decoded document plus multipart framing; API JSON remains capped at 16 MiB.
    serverActions: { bodySizeLimit: '11mb' },
  },
  ...(isolatedDistDir === undefined ? {} : { distDir: isolatedDistDir }),
};

export default nextConfig;
