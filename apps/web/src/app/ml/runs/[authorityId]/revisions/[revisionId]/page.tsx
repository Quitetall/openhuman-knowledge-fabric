import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ApiError, get } from '../../../../../../lib/api';
import { webCaller } from '../../../../../../lib/session';
import { parseRunProjection } from './parse-run-projection';
import { ProjectionFailure } from './projection-failure';
import {
  paginationHref,
  parseRunRoute,
  projectionQuery,
  type MlRunSearchParams,
} from './run-route';
import { RunView } from './run-view';
import type { RunProjection } from './run-projection';

export const dynamic = 'force-dynamic';

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ authorityId: string; revisionId: string }>;
}): Promise<Metadata> {
  const { authorityId, revisionId } = await params;
  return { title: `ML run ${authorityId} ${revisionId}` };
}

export default async function MlRunPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ authorityId: string; revisionId: string }>;
  readonly searchParams: Promise<MlRunSearchParams>;
}) {
  const route = parseRunRoute(await params);
  if (route === undefined) notFound();

  const query = projectionQuery(await searchParams);
  const caller = await webCaller(route.path);
  let projection: RunProjection;
  try {
    projection = await get(`${route.path}?${query}`, caller, parseRunProjection);
  } catch (error: unknown) {
    const hidden =
      error instanceof ApiError &&
      (error.status === 401 || error.status === 403 || error.status === 404);
    return <ProjectionFailure hidden={hidden} />;
  }

  return (
    <RunView
      projection={projection}
      pageHref={(changes) => paginationHref(route.path, query, changes)}
    />
  );
}
