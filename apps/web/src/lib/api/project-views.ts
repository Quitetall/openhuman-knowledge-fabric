import { hasStrings, nonNegativeInteger, nullableString, record } from './validation';

export interface ProjectView {
  readonly id: string;
  readonly enterprise_id: string | null;
  readonly title: string;
  readonly lifecycle_state: string;
  readonly row_version: string;
  readonly project_code: string | null;
  readonly objective: string;
  readonly sponsor_id: string;
  readonly started_on: string | null;
  readonly target_completion: string | null;
  readonly packages: readonly {
    readonly id: string;
    readonly title: string;
    readonly lifecycle_state: string;
    readonly sequence_no: number;
    readonly acceptance_criterion: string;
  }[];
  readonly progress: {
    readonly totalPackages: number;
    readonly disposedPackages: number;
    readonly fraction: number | null;
  };
}

export interface HistoryView {
  readonly objectId: string;
  readonly events: readonly {
    readonly seq: string;
    readonly action_type: string;
    readonly actor_id: string;
    readonly acting_role_id: string;
    readonly recorded_at: string;
    readonly effective_at: string;
    readonly reason: string | null;
    readonly digest: string;
  }[];
}

export interface AvailableActionsView {
  readonly objectId: string;
  readonly objectType: string;
  readonly state: string;
  readonly actions: readonly {
    readonly actionType: string;
    readonly toStates: readonly string[];
    readonly requiresChoice: boolean;
    readonly reasonRequired: boolean;
  }[];
}

export function parseProjectView(value: unknown): ProjectView {
  const project = record(value);
  const packages = project?.['packages'];
  const progress = record(project?.['progress']);
  const totalPackages = progress?.['totalPackages'];
  const disposedPackages = progress?.['disposedPackages'];
  const fraction = progress?.['fraction'];
  if (
    project === undefined ||
    !hasStrings(project, [
      'id',
      'title',
      'lifecycle_state',
      'row_version',
      'objective',
      'sponsor_id',
    ]) ||
    !nullableString(project['enterprise_id']) ||
    !nullableString(project['project_code']) ||
    !nullableString(project['started_on']) ||
    !nullableString(project['target_completion']) ||
    !Array.isArray(packages) ||
    !packages.every((candidate) => {
      const item = record(candidate);
      return (
        item !== undefined &&
        hasStrings(item, ['id', 'title', 'lifecycle_state', 'acceptance_criterion']) &&
        nonNegativeInteger(item['sequence_no'])
      );
    }) ||
    progress === undefined ||
    !nonNegativeInteger(totalPackages) ||
    !nonNegativeInteger(disposedPackages) ||
    disposedPackages > totalPackages ||
    packages.length !== totalPackages ||
    !(
      (totalPackages === 0 && disposedPackages === 0 && fraction === null) ||
      (totalPackages > 0 &&
        typeof fraction === 'number' &&
        Number.isFinite(fraction) &&
        fraction >= 0 &&
        fraction <= 1 &&
        fraction === disposedPackages / totalPackages)
    )
  ) {
    throw new Error('project view did not match contract');
  }
  return project as unknown as ProjectView;
}

export function parseHistoryView(value: unknown): HistoryView {
  const history = record(value);
  if (
    history === undefined ||
    typeof history['objectId'] !== 'string' ||
    !Array.isArray(history['events']) ||
    !history['events'].every((candidate) => {
      const event = record(candidate);
      return (
        event !== undefined &&
        hasStrings(event, [
          'seq',
          'action_type',
          'actor_id',
          'acting_role_id',
          'recorded_at',
          'effective_at',
          'digest',
        ]) &&
        nullableString(event['reason'])
      );
    })
  ) {
    throw new Error('history view did not match contract');
  }
  return history as unknown as HistoryView;
}

export function parseAvailableActionsView(value: unknown): AvailableActionsView {
  const available = record(value);
  if (
    available === undefined ||
    !hasStrings(available, ['objectId', 'objectType', 'state']) ||
    !Array.isArray(available['actions']) ||
    !available['actions'].every((candidate) => {
      const action = record(candidate);
      const toStates = action?.['toStates'];
      return (
        action !== undefined &&
        typeof action['actionType'] === 'string' &&
        Array.isArray(toStates) &&
        toStates.length > 0 &&
        toStates.every((state) => typeof state === 'string') &&
        typeof action['requiresChoice'] === 'boolean' &&
        action['requiresChoice'] === toStates.length > 1 &&
        typeof action['reasonRequired'] === 'boolean'
      );
    })
  ) {
    throw new Error('available actions view did not match contract');
  }
  return available as unknown as AvailableActionsView;
}
