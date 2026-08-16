import { compareCanonicalText } from '@kf/canonicalization';
import type { Finding } from './types.js';

/** Above this many findings of one warning rule, print a count instead of every instance. */
const SUMMARISE_WARNINGS_ABOVE = 3;

/**
 * Render findings for a human.
 *
 * Errors always print in full. Warnings that repeat across the whole ontology collapse to a
 * single counted line; the returned `Finding[]` is always complete.
 */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'ontology: OK';

  const detail = (f: Finding): string =>
    `${f.severity.toUpperCase()} ${f.rule} ${f.path}\n    ${f.message}\n    → ${f.remediation}`;

  const warnings = findings.filter((f) => f.severity === 'warning');
  const lines = findings.filter((f) => f.severity === 'error').map(detail);

  const byRule = new Map<string, Finding[]>();
  for (const w of warnings) byRule.set(w.rule, [...(byRule.get(w.rule) ?? []), w]);

  for (const [rule, group] of [...byRule].sort(([a], [b]) => compareCanonicalText(a, b))) {
    if (group.length <= SUMMARISE_WARNINGS_ABOVE) {
      lines.push(...group.map(detail));
      continue;
    }
    const first = group[0]!;
    const sample = group
      .slice(0, 3)
      .map((f) => f.path)
      .join(', ');
    lines.push(
      `WARNING ${rule} ×${group.length}\n    ${first.message}\n    → ${first.remediation}\n` +
        `    (e.g. ${sample}, +${group.length - 3} more)`,
    );
  }

  lines.push(`\n${findings.length - warnings.length} error(s), ${warnings.length} warning(s)`);
  return lines.join('\n');
}
