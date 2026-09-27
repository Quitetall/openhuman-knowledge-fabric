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
  // No request, fetch, server-function or forwarded-console logging. In development Next logs
  // every incoming URL (`GET /search?q=…`), every fetch to the API with its query, and each
  // server function's arguments (titles, notes, file names): query and record text in the
  // terminal and any log it is redirected to, outside search.recorded_query's 90-day bound.
  // Production (`next start`) logs none of these; this makes development say the same.
  logging: false,
  experimental: {
    // 10 MiB decoded document plus multipart framing; API JSON remains capped at 16 MiB.
    serverActions: { bodySizeLimit: '11mb' },
    // The CSP proxy (src/proxy.ts) runs on every request, so Next buffers each body to hand it on,
    // and past this cap it silently forwards only the first bytes: a 10 MiB upload then fails as
    // "Unexpected end of form" inside the action. Held equal to the action limit above.
    proxyClientMaxBodySize: '11mb',
  },
  ...(isolatedDistDir === undefined ? {} : { distDir: isolatedDistDir }),
};

export default nextConfig;
