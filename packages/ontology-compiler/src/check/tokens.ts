import type { CheckContext } from './types.js';

export function checkTokenUniqueness(context: CheckContext): void {
  const { ontology: o } = context;
  const seen = new Map<string, string>();
  const claim = (token: string, kind: string, path: string): void => {
    const prior = seen.get(token);
    if (prior !== undefined && prior !== kind) {
      context.err(
        'ONT-001',
        path,
        `token '${token}' is used as both ${prior} and ${kind}`,
        'Rename one of them. A token must resolve to one meaning across the whole vocabulary.',
      );
    }
    seen.set(token, kind);
  };
  for (const t of o.objectTypes) claim(t.id, 'object type', `object_types.${t.id}`);
  for (const r of o.relationTypes) claim(r.id, 'relation type', `relation_types.${r.id}`);
  for (const a of o.actionTypes) claim(a.id, 'action type', `action_types.${a.id}`);

  dupes(
    context,
    o.objectTypes.map((t) => t.id),
    'object_types',
  );
  dupes(
    context,
    o.relationTypes.map((r) => r.id),
    'relation_types',
  );
  dupes(
    context,
    o.actionTypes.map((a) => a.id),
    'action_types',
  );
  dupes(
    context,
    o.stateMachines.map((m) => m.id),
    'state_machines',
  );
  dupes(
    context,
    o.rules.map((r) => r.id),
    'rules',
  );
}

function dupes(context: CheckContext, ids: string[], kind: string): void {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) {
    if (n > 1) {
      context.err(
        'ONT-001',
        `${kind}.${id}`,
        `${kind} '${id}' is declared ${n} times`,
        'Remove the duplicate. Later declarations silently win otherwise.',
      );
    }
  }
}
