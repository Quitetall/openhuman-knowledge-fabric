'use server';

import { ApiError, replayOrganizationDemand, replayRecordedQuery } from '../../../lib/api';
import { RECORDED_QUERY_ID } from '../../../lib/api/search';
import { webCaller } from '../../../lib/session';
import type { DemandState, ReplayState } from './state';

/** The replay form's one server action: `POST /search/recorded-queries/:id/replay`. */
export async function replayOwnQuery(_previous: ReplayState, form: FormData): Promise<ReplayState> {
  const id = form.get('recordedQueryId');
  if (typeof id !== 'string' || !RECORDED_QUERY_ID.test(id)) {
    return { status: 'refused', message: 'That is not one of your recorded queries.' };
  }
  try {
    const replay = await replayRecordedQuery(await webCaller('/search/recorded'), id);
    return { status: 'replayed', replay };
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) {
      return {
        status: 'refused',
        message: 'This query has expired or is not yours to replay.',
      };
    }
    throw error;
  }
}

/** The demand form's one server action: `POST /search/demand/replay`. */
export async function replayDemand(_previous: DemandState, _form: FormData): Promise<DemandState> {
  const replay = await replayOrganizationDemand(await webCaller('/search/recorded'));
  return { status: 'replayed', replay };
}
