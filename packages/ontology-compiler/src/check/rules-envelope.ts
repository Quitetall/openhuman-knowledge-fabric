import type { CheckContext } from './types.js';

export function checkRulesAndEnvelope(context: CheckContext): void {
  checkRules(context);
  checkEnvelope(context);
}

function checkRules(context: CheckContext): void {
  for (const r of context.ontology.rules) {
    if (!/^KF-[A-Z]+-\d{3}$/.test(r.id)) {
      context.err(
        'ONT-010',
        `rules.${r.id}`,
        `rule id does not match KF-<AREA>-<nnn>`,
        'Rule ids are cited from code and tests; they must be stable and uniform.',
      );
    }
    if (r.implementation.length === 0) {
      context.err(
        'ONT-010',
        `rules.${r.id}.implementation`,
        'rule names no enforcement point',
        'Spec §27.1: a rule that exists only in prose is nonconforming. Name where it is enforced.',
      );
    }
    if (r.description.trim().length === 0) {
      context.err(
        'ONT-010',
        `rules.${r.id}.description`,
        'empty description',
        'Describe the invariant.',
      );
    }
  }
}

function checkEnvelope(context: CheckContext): void {
  const envelopeNames = new Set(context.ontology.envelopeFields.map((f) => f.name));
  for (const req of context.ontology.envelopeRequired) {
    if (req === 'node_type' || req === 'state') continue;
    if (!envelopeNames.has(req)) {
      context.err(
        'ONT-011',
        'meta.envelope.required',
        `required envelope field '${req}' is not defined in envelope.fields`,
        'Define it, or remove it from required.',
      );
    }
  }
  for (const t of context.ontology.objectTypes) {
    for (const f of t.fields) {
      if (envelopeNames.has(f.name)) {
        context.err(
          'ONT-011',
          `object_types.${t.id}.fields.${f.name}`,
          `shadows envelope field '${f.name}'`,
          'Rename the attribute. Two fields with one name make the record ambiguous.',
        );
      }
    }
  }
}
