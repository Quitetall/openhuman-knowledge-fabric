/**
 * The refusals are the feature, so they are what gets tested.
 *
 * Before this existed, `attach_evidence` hardcoded `source_system='object_store'` and required
 * a `storage_uri` — meaning the only way anything could enter KF was by copying its bytes. For
 * a vendor datasheet that is the one thing the standing rule forbids, so the safe path did not
 * exist and the unsafe one was the only one available.
 *
 * Every assertion below is about something NOT happening. A test that only proves the happy
 * path would have passed against the old behaviour too.
 */

import { describe, expect, it } from 'vitest';
import { planIngest, referenceOnlyRuleFor, artifactKindFor, mediaTypeFor } from './plan.js';

describe('a batch that does not state its intent is refused', () => {
  it('refuses when no mode is given, rather than choosing one', () => {
    const plan = planIngest({ classification: 'internal', paths: ['/docs/spec.md'] });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    // Asserting the SPECIFIC guidance, not merely that something mentioned --mode. An earlier
    // version checked only for '--mode' and stayed green when the missing-mode branch was
    // deleted, because `undefined` fell through to the unknown-mode branch and that message
    // contains '--mode' too. The two cases need different help — forgetting a flag is not the
    // same mistake as mistyping one — so the test has to be able to tell them apart.
    expect(plan.refusals.join('\n')).toContain('State copy or reference explicitly');
  });

  it('distinguishes a missing mode from an unrecognised one', () => {
    const missing = planIngest({ classification: 'internal', paths: ['/a.md'] });
    const unknown = planIngest({ mode: 'mirror', classification: 'internal', paths: ['/a.md'] });
    expect(missing.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (missing.ok || unknown.ok) return;
    expect(missing.refusals.join('\n')).not.toContain('unknown --mode');
    expect(unknown.refusals.join('\n')).toContain('unknown --mode');
  });

  it('refuses when no classification is given', () => {
    const plan = planIngest({ mode: 'copy', paths: ['/docs/spec.md'] });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals.join('\n')).toContain('--classification');
  });

  it('refuses a reference with no revision, because the row could not say which thing', () => {
    // content.artifact_version CHECK (storage_uri IS NOT NULL OR revision_label IS NOT NULL).
    // Reference mode stores no bytes, so the revision is the only remaining locator.
    const plan = planIngest({
      mode: 'reference',
      classification: 'internal',
      paths: ['/vendor/ads1299.pdf'],
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals.join('\n')).toContain('--revision');
  });

  it('refuses an unknown mode instead of falling back', () => {
    const plan = planIngest({ mode: 'mirror', classification: 'internal', paths: ['/a.md'] });
    expect(plan.ok).toBe(false);
  });
});

describe('reference-only material cannot be copied', () => {
  const cases = [
    ['/proj/vendor/ti/ads1299.pdf', 'vendor-tree'],
    ['/proj/suppliers/acme/terms.pdf', 'suppliers-tree'],
    ['/proj/third-party/lib/notice.txt', 'third-party-tree'],
    ['/proj/docs/ADS1299-datasheet-revH.pdf', 'datasheet-name'],
  ] as const;

  for (const [path, ruleId] of cases) {
    it(`refuses to copy ${path} under rule ${ruleId}`, () => {
      const plan = planIngest({ mode: 'copy', classification: 'internal', paths: [path] });
      expect(plan.ok, 'a copy-mode batch accepted third-party material').toBe(false);
      if (plan.ok) return;
      const text = plan.refusals.join('\n');
      expect(text, 'the refusal does not name the file').toContain(path);
      expect(text, 'the refusal does not name the rule that caught it').toContain(ruleId);
      expect(text, 'the refusal does not tell the operator what to do instead').toContain(
        '--mode=reference',
      );
    });
  }

  it('refuses the WHOLE batch, not just the offending file', () => {
    // A partial ingest leaves somebody deciding whether to re-run, and that decision is where
    // the tenth file quietly gets copied.
    const plan = planIngest({
      mode: 'copy',
      classification: 'internal',
      paths: ['/proj/docs/ours.md', '/proj/vendor/theirs.pdf', '/proj/docs/also-ours.md'],
    });
    expect(plan.ok).toBe(false);
  });

  it('allows the same material in reference mode, which is the point', () => {
    const plan = planIngest({
      mode: 'reference',
      classification: 'internal',
      revisionLabel: 'Rev H',
      paths: ['/proj/vendor/ti/ads1299.pdf'],
    });
    expect(plan.ok, 'reference mode was refused for material it exists to handle').toBe(true);
  });

  it('does not treat ordinary paths as reference-only', () => {
    // A policy that refused everything would pass every test above while being useless.
    expect(referenceOnlyRuleFor('/proj/docs/enclosure-spec.md')).toBeUndefined();
    const plan = planIngest({
      mode: 'copy',
      classification: 'internal',
      paths: ['/proj/docs/enclosure-spec.md'],
    });
    expect(plan.ok).toBe(true);
  });
});

describe('descriptive metadata', () => {
  it('maps mechanical formats to the kinds an enclosure designer would expect', () => {
    expect(artifactKindFor('/a/part.step')).toBe('cad_assembly');
    expect(artifactKindFor('/a/bracket.sldprt')).toBe('cad_part');
    expect(artifactKindFor('/a/outline.dxf')).toBe('drawing');
    expect(artifactKindFor('/a/board.kicad_pcb')).toBe('pcb_layout');
  });

  it('falls back to other rather than guessing wildly, and honours an override', () => {
    expect(artifactKindFor('/a/thing.weird')).toBe('other');
    expect(artifactKindFor('/a/thing.weird', 'certificate')).toBe('certificate');
  });

  it('gives a media type, defaulting to octet-stream', () => {
    expect(mediaTypeFor('/a/spec.md')).toBe('text/markdown');
    expect(mediaTypeFor('/a/thing.weird')).toBe('application/octet-stream');
  });
});

describe('a Drive source is a copy with its origin recorded (ADR 0022)', () => {
  it('plans a Drive-only batch as copy items with the file id and revision carried', () => {
    const plan = planIngest({
      mode: 'copy',
      classification: 'internal',
      paths: [],
      driveRefs: ['F1234567890@r7', 'G1234567890'],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items).toEqual([
      {
        path: 'drive:F1234567890@r7',
        artifactKind: 'other',
        mediaType: 'application/octet-stream',
        drive: { fileId: 'F1234567890', revisionId: 'r7' },
      },
      {
        path: 'drive:G1234567890',
        artifactKind: 'other',
        mediaType: 'application/octet-stream',
        drive: { fileId: 'G1234567890' },
      },
    ]);
  });

  it('refuses a malformed Drive reference by name', () => {
    const plan = planIngest({
      mode: 'copy',
      classification: 'internal',
      paths: [],
      driveRefs: ['https://docs.google.com/document/d/F1234567890/edit'],
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals.join('\n')).toContain('not a Drive reference');
  });

  it('refuses reference mode for a Drive source: we hold the copy or nothing', () => {
    const plan = planIngest({
      mode: 'reference',
      classification: 'internal',
      paths: [],
      driveRefs: ['F1234567890'],
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals.join('\n')).toContain('--mode=reference cannot take --drive');
  });
});
