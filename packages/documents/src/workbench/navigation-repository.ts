import type { Tx } from '@kf/database';
import type { WorkspaceAdrLink, WorkspaceNavigationLink, WorkspaceTopicLink } from './contracts.js';
import { iso } from './support.js';

interface NavigationRow extends Record<string, unknown> {
  readonly id: string;
  readonly relation_type: string;
  readonly direction: 'outbound' | 'inbound';
  readonly peer_object_id: string;
  readonly peer_object_type: string;
  readonly peer_title: string;
  readonly recorded_at: Date;
}

interface AdrRow extends Record<string, unknown> {
  readonly decision_id: string;
  readonly title: string;
  readonly lifecycle_state: string;
  readonly latest_progress_kind: string | null;
  readonly topic_key: string | null;
}

interface TopicRow extends Record<string, unknown> {
  readonly decision_id: string;
  readonly topic_key: string;
  readonly title: string;
  readonly lifecycle_state: string;
}

export async function navigationLinks(
  tx: Tx,
  objectId: string,
): Promise<readonly WorkspaceNavigationLink[]> {
  const rows = await tx.query<NavigationRow>(
    `select /* document.workspace-navigation-links */
            relation.id,
            relation.relation_type,
            case when relation.source_id = $1 then 'outbound' else 'inbound' end as direction,
            peer.id as peer_object_id,
            peer.object_type as peer_object_type,
            peer.title as peer_title,
            relation.created_at as recorded_at
       from core.relation relation
       join core.object peer
         on peer.id = case when relation.source_id = $1 then relation.target_id else relation.source_id end
      where relation.source_id = $1 or relation.target_id = $1
      order by relation.created_at, relation.id`,
    [objectId],
  );
  return rows.map((row) => ({
    id: row.id,
    relationType: row.relation_type,
    direction: row.direction,
    peerObjectId: row.peer_object_id,
    peerObjectType: row.peer_object_type,
    peerTitle: row.peer_title,
    recordedAt: iso(row.recorded_at),
  }));
}

export async function adrLinks(tx: Tx, objectId: string): Promise<readonly WorkspaceAdrLink[]> {
  const rows = await tx.query<AdrRow>(
    `select /* document.workspace-adr-links */
            overview.decision_id,
            overview.title,
            overview.lifecycle_state,
            overview.latest_progress_kind,
            topic.topic_key
       from content.adr_overview overview
       left join content.adr_topic topic on topic.decision_id = overview.decision_id
      where overview.decision_id = $1
         or exists (
              select 1 from core.relation relation
               where relation.relation_type in ('implements', 'supersedes', 'amends', 'extends')
                 and (
                   (relation.source_id = $1 and relation.target_id = overview.decision_id)
                   or (relation.target_id = $1 and relation.source_id = overview.decision_id)
                 )
            )
      order by overview.title, overview.decision_id`,
    [objectId],
  );
  return rows.map((row) => ({
    decisionId: row.decision_id,
    title: row.title,
    lifecycleState: row.lifecycle_state,
    latestProgressKind: row.latest_progress_kind,
    topicKey: row.topic_key,
  }));
}

export async function topicLinks(tx: Tx, objectId: string): Promise<readonly WorkspaceTopicLink[]> {
  const rows = await tx.query<TopicRow>(
    `select /* document.workspace-topic-links */
            topic.decision_id, topic.topic_key, topic.title, topic.lifecycle_state
       from content.adr_topic topic
      where topic.decision_id = $1
      order by topic.topic_key`,
    [objectId],
  );
  return rows.map((row) => ({
    decisionId: row.decision_id,
    topicKey: row.topic_key,
    title: row.title,
    lifecycleState: row.lifecycle_state,
  }));
}
