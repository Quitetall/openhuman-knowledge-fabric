import type { Tx } from '@kf/database';

export interface SuspectResult {
  readonly executionId: string;
  readonly title: string;
  /** Null when the execution never recorded one — still suspect, and visibly so. */
  readonly executedOn: string | null;
  readonly subjectId: string | null;
}

/**
 * Every test result produced by a piece of equipment since its last good calibration.
 *
 * This is what makes an out-of-tolerance finding actionable rather than alarming. Without the
 * execution-to-equipment join it answers "some results may be affected", which is not an
 * answer anybody can act on.
 */
export async function resultsSuspectedOfBadCalibration(
  tx: Tx,
  equipmentId: string,
): Promise<SuspectResult[]> {
  const rows = await tx.query<{
    execution_id: string;
    title: string;
    executed_on: Date | null;
    subject_id: string | null;
  }>(
    `with last_good as (
       select max(performed_on) as at
         from quality.calibration
        where equipment_id = $1 and outcome = 'in_tolerance'
     )
     select e.id as execution_id, o.title, e.executed_on, v.subject_id
       from engineering.test_execution_equipment x
       join engineering.test_execution e on e.id = x.execution_id
       join core.object o on o.id = e.id
       left join engineering.verification_link v on v.execution_id = e.id
      where x.equipment_id = $1
        and (
          (select at from last_good) is null
          or e.executed_on is null
          or e.executed_on >= (select at from last_good)
        )
      order by e.executed_on nulls first`,
    [equipmentId],
  );
  return rows.map((r) => ({
    executionId: r.execution_id,
    title: r.title,
    executedOn: r.executed_on === null ? null : r.executed_on.toISOString(),
    subjectId: r.subject_id,
  }));
}
