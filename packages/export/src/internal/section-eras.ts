import type { ExportPackage } from './types.js';

/**
 * Sections added to format 2 after format-2 archives were already being written, oldest first.
 *
 * None of them bumped the format, so a format-2 archive written before one arrived has neither its
 * file nor its count, and a snapshot digest computed over the section list of its day. Those
 * archives are the backups, and they must restore: the verifier accepts the section's absence
 * (file, manifest entry and count all absent together — a half-present section is still refused)
 * and recomputes the snapshot identity over the sections the archive's exporter wrote, and the
 * importer then restores what the archive predates as the migration that introduced it would have
 * (`importer/sections.ts`).
 *
 * Named explicitly rather than treating any missing section as optional: a blanket rule would
 * silently accept a truncated export, which is the failure the round trip exists to catch. The
 * manifest is signed, so absence here means the signing exporter never wrote the section.
 *
 * - `object-verifications` — 2026-09-20: its table arrived with it; absence means none.
 * - `access-demand` — 2026-09-24: the demand aggregate arrived with it; absence means none.
 * - `deliverable-retired-attributes` — 20260925130100: its rows are derived from the old-shape
 *   `deliverables` rows the same archive carries, and the importer refuses the absence under
 *   new-shape rows.
 */
export const SECTIONS_ADDED_WITHOUT_FORMAT_BUMP: readonly string[] = [
  'object-verifications',
  'access-demand',
  'deliverable-retired-attributes',
];

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
