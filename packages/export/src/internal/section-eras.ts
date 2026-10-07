import type { ExportPackage } from './types.js';

/**
 * Sections added to format 2 after format-2 archives were already being written.
 *
 * Format 2 was first written at bffc6739 (2026-08-15). None of the sections below bumped the
 * format, so a format-2 archive written before one arrived has neither its file nor its count,
 * and a snapshot digest computed over the section list of its day. Those archives are the
 * backups, and they must restore: the verifier accepts the section's absence (file, manifest
 * entry and count all absent together — a half-present section is still refused) and recomputes
 * the snapshot identity over the sections the archive's exporter wrote, and the importer then
 * restores what the archive predates as the migration that introduced it would have
 * (`importer/sections.ts`, `importer/restore.ts`).
 *
 * Named explicitly rather than treating any missing section as optional: a blanket rule would
 * silently accept a truncated export, which is the failure the round trip exists to catch. The
 * manifest is signed, so absence here means the signing exporter never wrote the section. A name
 * here is a claim, checked against the migration that created its table: every table below was
 * created by a migration first committed together with its section, so no database held the
 * table under an exporter that did not write it; and none was renamed from an earlier section —
 * no section has left the exporter since bffc6739.
 *
 * Each arrival is one commit, and its sections arrived together: an archive has all of them or
 * none. An exporter that wrote an arrival wrote every arrival its commit descends from, so an
 * archive that predates one arrival predates every arrival after it (`after` names the arrivals
 * a commit directly descends from; history forked once, on 2026-09-24). `sectionEraProblems`
 * checks both, so that forty optional names do not let an archive drop `warrants.json` alone.
 *
 * Absence means none — the migration created the table empty and nothing seeded it:
 *
 * - 2184efba (2026-08-26) — `20260826000200_classification_clearance_entitlement`:
 *   `person-clearances`, `person-clearance-retirements`, `person-entitlement-exclusions`;
 *   `20260826000300_master_record_runtime`: `master-records`, `master-record-items`,
 *   `master-record-withholdings`; `20260826000400_master_record_delivery`: `master-record-links`,
 *   `master-record-link-revocations`, `master-record-delivery-receipts`,
 *   `master-record-link-access`. Their only insert is inside a function a later act calls.
 * - f6d32c35 (2026-09-02) — `20260902000100_access_grants`: `access-grants`. Role assignments,
 *   project memberships and capabilities were NOT copied into grants; the migration presents them
 *   beside the grants through the `org.effective_access_grant` view, and each travels in its own
 *   section.
 * - e8745ef8 (2026-09-02) — `20260902000300_identifier_allocation`: `identifier-sequences`,
 *   `identifier-allocations`. Not seeded: `core.allocate_enterprise_id` creates a namespace's
 *   sequence on its first allocation and skips any value an existing identifier occupies.
 * - 20ead1c9 (2026-09-02) — `20260902000400_warrants`: `warrants`, `warrant-contract-revisions`.
 * - 519f4c64 (2026-09-02) — `20260902000500_warrant_projections`: the thirteen `warrant-*`
 *   projections. The acts that write them had been logging their payloads in `core.action`; the
 *   migration did not project those payloads, so it left the tables empty.
 * - ceb15c4b (2026-09-20): `object-verifications`.
 * - defd6fb1 (2026-09-23) — `20260924000400`: `orphan-collections`.
 * - beb2a9d3 (2026-09-24) — `20260925030100`: `product-systems`, `baselines`, `releases`,
 *   `requirements`, `risks`, `tests`.
 * - 79124c0a (2026-09-24) — `20260925030200`: `observations`.
 * - de59c226 (2026-09-24, on a branch without beb2a9d3 and 79124c0a): `access-demand`.
 * - b535bb14 (2026-10-07) — `20261007100000`: `verification-policies`, `act-proposals`,
 *   `act-proposal-resolutions`. Created empty; only the acts ADR 0040 adds write them.
 *
 * Absence does NOT mean none, and the importer restores what the migration derived:
 *
 * - b240779c (2026-09-02) — `20260902000200_artifact_locations`: `artifact-stores`,
 *   `artifact-locations`. The migration declared the `working` store and gave every
 *   `content.artifact_version` with a `storage_uri` its working location. The restoring
 *   database's own migrations declared the same `working` store, so the importer keeps it rather
 *   than clearing the stores for the package's (its `declared_at` is when THIS database ran the
 *   migration: the archive predates the row, so it cannot say when the source did), and records
 *   each addressed version's working location from the archive's `artifact-versions` exactly as
 *   the migration did — the version's `created_at`, no recorder.
 * - b8886185 (2026-09-24) — `20260925130100`: `deliverable-retired-attributes`. Its rows are
 *   derived from the old-shape `deliverables` rows the same archive carries, and the importer
 *   refuses the absence under new-shape rows.
 *
 * FORMAT 1 is not an era of format 2: it predates every section above. `verifyExport` refuses it
 * unless the caller passes `allowUnsignedLegacyV1` with a warning callback, because a format-1
 * manifest carries no signature and so no authenticated origin. The refusal-by-default is
 * deliberate — the option's type makes the opt-in impossible to express without naming where the
 * warning goes — and with the opt-in the importer's format-1 path runs (`kf-export
 * --allow-unsigned-legacy-v1`; `tests/round-trip/export.test.ts`, "restores original format-1
 * archives").
 */
interface SectionArrival {
  /** The commit that first wrote these sections. */
  readonly commit: string;
  /** The arrivals this commit directly descends from. */
  readonly after: readonly string[];
  readonly sections: readonly string[];
}

export const SECTION_ARRIVALS: readonly SectionArrival[] = [
  {
    commit: '2184efba',
    after: [],
    sections: [
      'person-clearances',
      'person-clearance-retirements',
      'person-entitlement-exclusions',
      'master-records',
      'master-record-items',
      'master-record-withholdings',
      'master-record-links',
      'master-record-link-revocations',
      'master-record-delivery-receipts',
      'master-record-link-access',
    ],
  },
  { commit: 'f6d32c35', after: ['2184efba'], sections: ['access-grants'] },
  { commit: 'b240779c', after: ['f6d32c35'], sections: ['artifact-stores', 'artifact-locations'] },
  {
    commit: 'e8745ef8',
    after: ['b240779c'],
    sections: ['identifier-sequences', 'identifier-allocations'],
  },
  { commit: '20ead1c9', after: ['e8745ef8'], sections: ['warrants', 'warrant-contract-revisions'] },
  {
    commit: '519f4c64',
    after: ['20ead1c9'],
    sections: [
      'warrant-preflights',
      'warrant-dispatches',
      'warrant-runtime-receipts',
      'warrant-submissions',
      'warrant-blockers',
      'warrant-deviations',
      'warrant-discovered-gaps',
      'warrant-artifacts',
      'warrant-evidence',
      'warrant-gate-runs',
      'warrant-inferences',
      'warrant-judgments',
      'warrant-resolution-requests',
    ],
  },
  { commit: 'ceb15c4b', after: ['519f4c64'], sections: ['object-verifications'] },
  { commit: 'defd6fb1', after: ['ceb15c4b'], sections: ['orphan-collections'] },
  {
    commit: 'beb2a9d3',
    after: ['defd6fb1'],
    sections: ['product-systems', 'baselines', 'releases', 'requirements', 'risks', 'tests'],
  },
  { commit: '79124c0a', after: ['beb2a9d3'], sections: ['observations'] },
  { commit: 'de59c226', after: ['defd6fb1'], sections: ['access-demand'] },
  {
    commit: 'b8886185',
    after: ['79124c0a', 'de59c226'],
    sections: ['deliverable-retired-attributes'],
  },
  {
    commit: 'b535bb14',
    after: ['b8886185'],
    sections: ['verification-policies', 'act-proposals', 'act-proposal-resolutions'],
  },
];

/** Every section above, oldest arrival first. */
export const SECTIONS_ADDED_WITHOUT_FORMAT_BUMP: readonly string[] = SECTION_ARRIVALS.flatMap(
  (arrival) => arrival.sections,
);

/** The later sections this package predates: named above, and absent from files, list and counts. */
export function predatedSections(pkg: ExportPackage): ReadonlySet<string> {
  const counts: unknown = pkg.manifest.counts;
  const listed = Array.isArray(pkg.manifest.files)
    ? (pkg.manifest.files as readonly unknown[])
    : [];
  return new Set(
    SECTIONS_ADDED_WITHOUT_FORMAT_BUMP.filter((name) => {
      const path = `${name}.json`;
      return (
        !pkg.files.some((file) => file.path === path) &&
        !listed.some(
          (entry) =>
            entry !== null &&
            typeof entry === 'object' &&
            (entry as Record<string, unknown>)['path'] === path,
        ) &&
        !(counts !== null && typeof counts === 'object' && Object.hasOwn(counts, name))
      );
    }),
  );
}

/** Every arrival whose commit descends from `commit`. */
function arrivalsAfter(commit: string): readonly SectionArrival[] {
  const later = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const arrival of SECTION_ARRIVALS) {
      if (later.has(arrival.commit)) continue;
      if (arrival.after.some((parent) => parent === commit || later.has(parent))) {
        later.add(arrival.commit);
        grew = true;
      }
    }
  }
  return SECTION_ARRIVALS.filter((arrival) => later.has(arrival.commit));
}

/**
 * Why a set of absent sections is not one any exporter wrote: part of one arrival absent, or an
 * arrival absent while one after it is present. Empty when the absence is an archive's era.
 */
export function sectionEraProblems(predated: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const arrival of SECTION_ARRIVALS) {
    const missing = arrival.sections.filter((name) => predated.has(name));
    if (missing.length === 0) continue;
    if (missing.length < arrival.sections.length) {
      problems.push(
        `sections ${arrival.sections.join(', ')} arrived together (${arrival.commit}), ` +
          `but only ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} absent`,
      );
      continue;
    }
    for (const later of arrivalsAfter(arrival.commit)) {
      const carried = later.sections.filter((name) => !predated.has(name));
      if (carried.length === 0) continue;
      problems.push(
        `the archive predates ${arrival.sections.join(', ')} (${arrival.commit}) ` +
          `but carries ${carried.join(', ')}, which arrived after it (${later.commit})`,
      );
    }
  }
  return problems;
}
