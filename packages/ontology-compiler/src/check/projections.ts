import type { ProjectionFilter } from '../model.js';
import type { CheckContext } from './types.js';

/**
 * Corpus projection definitions (ADR 0013).
 *
 * A projection can only name what the ontology already declares: relation types it walks,
 * object types, lifecycle states and classifications it filters on, envelope fields it sorts
 * by. Each of those is checked here, because the engine enforces ⊆-master and coverage by
 * construction and cannot enforce that a definition means what its author thought — an
 * unknown relation type would silently reach nothing, and a section that filtered on a
 * misspelled state would silently be empty.
 */

const SORTABLE = new Set([
  'object_id',
  'object_type',
  'title',
  'classification',
  'lifecycle_state',
]);
const ITEM_STATES = new Set(['included', 'withdrawn']);

export function checkProjections(context: CheckContext): void {
  const { ontology: o, objectIds, relationIds } = context;
  const seen = new Set<string>();
  const states = new Set(o.objectTypes.flatMap((t) => t.states));

  const checkFilter = (filter: ProjectionFilter | undefined, at: string): void => {
    if (filter === undefined) return;
    for (const type of filter.objectTypes ?? []) {
      if (!objectIds.has(type)) {
        context.err(
          'ONT-014',
          `${at}.object_types`,
          `unknown object type '${type}'`,
          'Filter on an object type object-types.yaml declares.',
        );
      }
    }
    for (const state of filter.lifecycleStates ?? []) {
      if (!states.has(state)) {
        context.err(
          'ONT-014',
          `${at}.lifecycle_states`,
          `no object type has a state '${state}'`,
          'Filter on a lifecycle state some object type declares.',
        );
      }
    }
    if (
      filter.classificationMax !== undefined &&
      !o.classifications.includes(filter.classificationMax)
    ) {
      context.err(
        'ONT-014',
        `${at}.classification_max`,
        `unknown classification '${filter.classificationMax}'`,
        `Use one of: ${o.classifications.join(', ')}`,
      );
    }
    for (const state of filter.itemStates ?? []) {
      if (!ITEM_STATES.has(state)) {
        context.err(
          'ONT-014',
          `${at}.item_states`,
          `unknown item state '${state}'`,
          'Use included or withdrawn.',
        );
      }
    }
  };

  for (const d of o.projectionDefinitions) {
    const at = `projection_definitions.${d.id}`;
    if (seen.has(d.id)) {
      context.err(
        'ONT-013',
        at,
        `duplicate projection definition '${d.id}'`,
        'Give each definition one id.',
      );
    }
    seen.add(d.id);

    if (d.traverse !== undefined && d.traverse.relations !== 'person_anchors') {
      for (const relation of d.traverse.relations) {
        if (!relationIds.has(relation)) {
          context.err(
            'ONT-013',
            `${at}.traverse.relations`,
            `unknown relation type '${relation}'`,
            'Traverse a relation type relation-types.yaml declares.',
          );
        }
      }
    }
    if (
      d.traverse === undefined &&
      d.sections.some((s) => s.select === 'reached' || s.select === 'unreached')
    ) {
      context.err(
        'ONT-013',
        `${at}.sections`,
        'a section selects on reachability but the definition declares no traverse',
        'Add a traverse, or select on all/withdrawn.',
      );
    }

    checkFilter(d.filter, `${at}.filter`);
    const sectionIds = new Set<string>();
    for (const section of d.sections) {
      if (sectionIds.has(section.id) || section.id === d.remainder.id) {
        context.err(
          'ONT-015',
          `${at}.sections.${section.id}`,
          `section id '${section.id}' is not unique within the definition`,
          'Section ids, including the remainder, must be distinct.',
        );
      }
      sectionIds.add(section.id);
      checkFilter(section.filter, `${at}.sections.${section.id}.filter`);
    }
    if (d.remainder.id.trim() === '') {
      context.err(
        'ONT-015',
        `${at}.remainder`,
        'the remainder section has no id',
        'Every projection ends in a named remainder so nothing can be dropped silently.',
      );
    }

    for (const field of d.sort) {
      if (!SORTABLE.has(field)) {
        context.err(
          'ONT-016',
          `${at}.sort`,
          `'${field}' is not a sortable declared field`,
          `Sort by one of: ${[...SORTABLE].join(', ')}`,
        );
      }
    }
    const paramNames = new Set<string>();
    for (const param of d.parameters) {
      if (paramNames.has(param.name)) {
        context.err(
          'ONT-016',
          `${at}.parameters`,
          `duplicate parameter '${param.name}'`,
          'Name each parameter once.',
        );
      }
      paramNames.add(param.name);
      if (param.type === 'enum' && (param.values === undefined || param.values.length === 0)) {
        context.err(
          'ONT-016',
          `${at}.parameters.${param.name}`,
          'an enum parameter with no values can never bind',
          'Declare values, or use another type.',
        );
      }
    }
  }
}
