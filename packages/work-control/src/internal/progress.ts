import type { Tx } from '@kf/database';

export interface ProjectProgress {
  readonly totalPackages: number;
  readonly disposedPackages: number;
  /** Fraction in [0, 1]. Null when a project has no work packages yet. */
  readonly fraction: number | null;
}

/**
 * KF-PROJ-001. Progress comes from accepted or waived work packages.
 *
 * Computed on read rather than stored, because a stored number is one more thing that can
 * disagree with the records it summarises.
 */
export async function projectProgress(tx: Tx, projectId: string): Promise<ProjectProgress> {
  const row = await tx.one<{ total: string; disposed: string }>(
    `select count(*)::text as total,
            count(*) filter (where obj.lifecycle_state in ('accepted', 'waived'))::text as disposed
       from work.work_package wp
       join core.object obj on obj.id = wp.id
      where wp.project_id = $1`,
    [projectId],
  );
  const total = Number(row.total);
  const disposed = Number(row.disposed);
  return {
    totalPackages: total,
    disposedPackages: disposed,
    fraction: total === 0 ? null : disposed / total,
  };
}
