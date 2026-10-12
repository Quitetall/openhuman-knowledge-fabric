'use client';

import Link from 'next/link';
import {
  cloneElement,
  startTransition,
  useActionState,
  useId,
  useMemo,
  useState,
  type ReactElement,
} from 'react';
import { packGesture } from './actions';
import {
  DRAFT_AUTHORITY_CLASSES,
  DRAFT_CLOSING,
  DRAFT_CONSEQUENCES,
  DRAFT_MODES,
  DRAFT_PARTS,
  DRAFT_STAGES,
  MODE_LABELS,
  STAGE_LABELS,
  emptyPack,
  emptyRequirement,
  packDocument,
  type AcceptedByKind,
  type PackDraft,
  type RequirementDraft,
} from './pack-model';
import type { PackFormState } from './state';

/**
 * Drafting a qualification pack, field by field (ADR 0038; SAS §24A).
 *
 * The person fills in the pack and its requirements; the page spells the closed
 * `kf-qualification-pack-v1` document from them and shows it. Check runs the pack validator on
 * it; Draft runs the validator again and, when it finds nothing, dispatches
 * `draft_qualification_pack`. Every choice offered is a value the document accepts; role and part
 * lists are suggestions from the API's answer, never a filter, and nothing here reads which role
 * the person holds.
 */
export function PackForm({
  gestureId,
  roles,
  parts,
}: {
  readonly gestureId: string;
  readonly roles: readonly string[];
  readonly parts: readonly string[];
}) {
  const [state, action, pending] = useActionState<PackFormState, FormData>(packGesture, {
    status: 'idle',
    gestureId,
  });
  const [draft, setDraft] = useState<PackDraft>(emptyPack);
  const document = useMemo(() => JSON.stringify(packDocument(draft), null, 2), [draft]);
  const rolesList = useId();
  const partsList = useId();
  const set = (patch: Partial<PackDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setRequirement = (index: number, patch: Partial<RequirementDraft>) =>
    setDraft((d) => ({
      ...d,
      requirements: d.requirements.map((r, i) => (i === index ? { ...r, ...patch } : r)),
    }));

  return (
    // noValidate: the pack validator, not the browser, says what is missing, by path and in the
    // validator's own words; `required` still tells assistive technology which fields are.
    // Submitted by hand rather than through `action`: React resets a form after an action, which
    // would show every select at its first option while the draft still held the person's choice.
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const data = new FormData(event.currentTarget, submitter);
        startTransition(() => action(data));
      }}
      className="kf-pack-form"
      aria-describedby="kf-pack-outcome"
      noValidate
    >
      <input type="hidden" name="document" value={document} />
      <datalist id={rolesList}>
        {roles.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <datalist id={partsList}>
        {parts.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      <fieldset className="kf-pack-fieldset" data-pack-fields>
        <legend className="kf-pack-legend">The pack</legend>
        <div className="kf-pack-grid">
          <Field label="Key" hint="Stable, lower case: aero-engineer">
            <input
              className="kf-control"
              name="pack-key"
              required
              value={draft.key}
              onChange={(e) => set({ key: e.target.value })}
            />
          </Field>
          <Field label="Title">
            <input
              className="kf-control"
              name="pack-title"
              required
              value={draft.title}
              onChange={(e) => set({ title: e.target.value })}
            />
          </Field>
          <Field label="Maintained by (role)" hint="The role that keeps this pack current">
            <input
              className="kf-control"
              name="pack-owner"
              list={rolesList}
              required
              value={draft.ownerRole}
              onChange={(e) => set({ ownerRole: e.target.value })}
            />
          </Field>
          <Field label="Closes" hint="The pack's standing rule">
            <select
              className="kf-control"
              name="pack-closing"
              value={draft.closing}
              onChange={(e) => set({ closing: e.target.value })}
            >
              {DRAFT_CLOSING.map((c) => (
                <option key={c} value={c}>
                  {c === 'on_evidence'
                    ? 'On evidence: when every requirement is credited'
                    : 'On acceptance: a named role accepts'}
                </option>
              ))}
            </select>
          </Field>
          {draft.closing === 'on_acceptance' ? (
            <Field label="Accepted by (role)">
              <input
                className="kf-control"
                name="pack-acceptor"
                list={rolesList}
                required
                value={draft.acceptorRole}
                onChange={(e) => set({ acceptorRole: e.target.value })}
              />
            </Field>
          ) : null}
        </div>
        <p className="kf-footnote">
          Parts compose other approved packs by key and revision, one explicit level, as
          <code> key@revision</code>; a requirement two parts share is one requirement.
        </p>
        <div className="kf-pack-grid">
          {DRAFT_PARTS.map((part) => (
            <Field key={part} label={`${part[0]!.toUpperCase()}${part.slice(1)} parts`}>
              <input
                className="kf-control"
                name={`pack-parts-${part}`}
                list={partsList}
                value={draft.parts[part]}
                onChange={(e) => set({ parts: { ...draft.parts, [part]: e.target.value } })}
              />
            </Field>
          ))}
        </div>
      </fieldset>

      {draft.requirements.map((requirement, index) => (
        <RequirementFields
          key={index}
          index={index}
          requirement={requirement}
          rolesList={rolesList}
          onChange={(patch) => setRequirement(index, patch)}
          {...(draft.requirements.length > 1
            ? {
                onRemove: () =>
                  set({ requirements: draft.requirements.filter((_, i) => i !== index) }),
              }
            : {})}
        />
      ))}
      <p>
        <button
          type="button"
          className="kf-button"
          onClick={() => set({ requirements: [...draft.requirements, emptyRequirement()] })}
        >
          Add a requirement
        </button>
      </p>

      <details className="kf-pack-document">
        <summary>The document this drafts ({draft.requirements.length} requirements)</summary>
        <pre data-pack-document>{document}</pre>
      </details>

      <div className="kf-action-controls kf-pack-actions">
        <button
          type="submit"
          name="intent"
          value="check"
          className="kf-button"
          disabled={pending}
          aria-busy={pending}
        >
          Check
        </button>
        <button
          type="submit"
          name="intent"
          value="draft"
          className="kf-button kf-button-primary"
          disabled={pending}
          aria-busy={pending}
        >
          {pending ? 'Working…' : 'Draft pack'}
        </button>
      </div>
      <Outcome state={state} />
    </form>
  );
}

/**
 * A labelled control. The label names the control and nothing else; a hint describes it
 * (`aria-describedby`), so a screen reader hears "Key" and then the hint, not one run-on name.
 */
function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="kf-pack-field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, {
        id,
        ...(hint === undefined ? {} : { 'aria-describedby': hintId }),
      })}
      {hint === undefined ? null : (
        <span id={hintId} className="kf-footnote">
          {hint}
        </span>
      )}
    </div>
  );
}

function RequirementFields({
  index,
  requirement: r,
  rolesList,
  onChange,
  onRemove,
}: {
  readonly index: number;
  readonly requirement: RequirementDraft;
  readonly rolesList: string;
  readonly onChange: (patch: Partial<RequirementDraft>) => void;
  readonly onRemove?: () => void;
}) {
  const n = index + 1;
  return (
    <fieldset className="kf-pack-fieldset" data-requirement={n}>
      <legend className="kf-pack-legend">Requirement {n}</legend>
      <Field label="What must be true" hint="The outcome, not a document to open">
        <textarea
          className="kf-control"
          name={`r${n}-outcome`}
          rows={2}
          required
          value={r.outcome}
          onChange={(e) => onChange({ outcome: e.target.value })}
        />
      </Field>
      <div className="kf-pack-grid">
        <Field label="Key">
          <input
            className="kf-control"
            name={`r${n}-key`}
            required
            value={r.key}
            onChange={(e) => onChange({ key: e.target.value })}
          />
        </Field>
        <Field label="Revision">
          <input
            className="kf-control"
            name={`r${n}-revision`}
            inputMode="numeric"
            value={r.revision}
            onChange={(e) => onChange({ revision: e.target.value })}
          />
        </Field>
        <Field label="Part">
          <select
            className="kf-control"
            name={`r${n}-part`}
            value={r.part}
            onChange={(e) => onChange({ part: e.target.value })}
          >
            {DRAFT_PARTS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Stage">
          <select
            className="kf-control"
            name={`r${n}-stage`}
            value={r.stage}
            onChange={(e) => onChange({ stage: e.target.value })}
          >
            {DRAFT_STAGES.map((s) => (
              <option key={s} value={s}>
                {STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Evidence that counts">
          <select
            className="kf-control"
            name={`r${n}-mode`}
            value={r.evidenceMode}
            onChange={(e) => onChange({ evidenceMode: e.target.value })}
          >
            {DRAFT_MODES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Accepted by">
          <select
            className="kf-control"
            name={`r${n}-accepted-by`}
            value={r.acceptedByKind}
            onChange={(e) => onChange({ acceptedByKind: e.target.value as AcceptedByKind })}
          >
            <option value="self">The person (acknowledgement only)</option>
            <option value="contact">Their named contact</option>
            <option value="role">Holders of a role</option>
          </select>
        </Field>
        {r.acceptedByKind === 'role' ? (
          <Field label="Accepting role">
            <input
              className="kf-control"
              name={`r${n}-accepted-role`}
              list={rolesList}
              required
              value={r.acceptedByRole}
              onChange={(e) => onChange({ acceptedByRole: e.target.value })}
            />
          </Field>
        ) : null}
      </div>
      <label className="kf-pack-check">
        <input
          type="checkbox"
          name={`r${n}-mandatory`}
          checked={r.mandatory}
          onChange={(e) => onChange({ mandatory: e.target.checked })}
        />{' '}
        Mandatory
      </label>
      <div className="kf-pack-grid">
        <Field label="Without it, the organization is">
          <select
            className="kf-control"
            name={`r${n}-consequence-kind`}
            value={r.consequenceKind}
            onChange={(e) => onChange({ consequenceKind: e.target.value })}
          >
            {DRAFT_CONSEQUENCES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Because"
          hint={
            r.mandatory
              ? 'Required: a mandatory requirement names what it prevents'
              : 'Optional for optional reading'
          }
        >
          <input
            className="kf-control"
            name={`r${n}-consequence`}
            value={r.consequenceStatement}
            onChange={(e) => onChange({ consequenceStatement: e.target.value })}
          />
        </Field>
      </div>
      <Field
        label="Resources"
        hint="One per line: record id, revision, normative | reference | learning, then a label"
      >
        <textarea
          className="kf-control"
          name={`r${n}-resources`}
          rows={2}
          value={r.resources}
          placeholder={`01900000-… 3 ${DRAFT_AUTHORITY_CLASSES[0]} Group procedures index`}
          onChange={(e) => onChange({ resources: e.target.value })}
        />
      </Field>
      <details className="kf-pack-more">
        <summary>Scope, prerequisites, gated acts, equivalents</summary>
        <div className="kf-pack-grid">
          <Field label="Scope object" hint="Empty: the organization">
            <input
              className="kf-control"
              name={`r${n}-scope`}
              value={r.scopeObject}
              onChange={(e) => onChange({ scopeObject: e.target.value })}
            />
          </Field>
          <Field label="Changes required behaviour" hint="Declared on every revision after 1">
            <select
              className="kf-control"
              name={`r${n}-impact`}
              value={r.behaviouralImpact}
              onChange={(e) =>
                onChange({
                  behaviouralImpact: e.target.value as RequirementDraft['behaviouralImpact'],
                })
              }
            >
              <option value="">Not declared</option>
              <option value="true">Yes: it creates a gap</option>
              <option value="false">No: wording or location only</option>
            </select>
          </Field>
          <Field label="Prerequisites" hint="Requirement keys">
            <input
              className="kf-control"
              name={`r${n}-prerequisites`}
              value={r.prerequisites}
              onChange={(e) => onChange({ prerequisites: e.target.value })}
            />
          </Field>
          <Field label="Gates acts" hint="Act ids that declare requires_qualification">
            <input
              className="kf-control"
              name={`r${n}-gates`}
              value={r.gates}
              onChange={(e) => onChange({ gates: e.target.value })}
            />
          </Field>
          <Field label="Equivalent to" hint="Requirement keys whose credit counts">
            <input
              className="kf-control"
              name={`r${n}-equivalent`}
              value={r.equivalentTo}
              onChange={(e) => onChange({ equivalentTo: e.target.value })}
            />
          </Field>
          <Field label="Formats" hint="How help is given: reading, watching">
            <input
              className="kf-control"
              name={`r${n}-formats`}
              value={r.formats}
              onChange={(e) => onChange({ formats: e.target.value })}
            />
          </Field>
        </div>
      </details>
      {onRemove === undefined ? null : (
        <p>
          <button type="button" className="kf-button" onClick={onRemove}>
            Remove requirement {n}
          </button>
        </p>
      )}
    </fieldset>
  );
}

function Outcome({ state }: { readonly state: PackFormState }) {
  switch (state.status) {
    case 'idle':
      return <div id="kf-pack-outcome" aria-live="polite" />;
    case 'checked':
      return (
        <p id="kf-pack-outcome" role="status" className="kf-status kf-status-success">
          The validator finds nothing to refuse. The Fabric checks again when it is drafted, with
          what only the record knows: roles, gated acts and resources at their revisions.
        </p>
      );
    case 'problems':
      return (
        <section id="kf-pack-outcome" role="alert" className="kf-status kf-status-error">
          <p className="kf-pack-problem-head">
            Not drafted: {state.problems.length}{' '}
            {state.problems.length === 1 ? 'problem' : 'problems'}. Nothing was sent.
          </p>
          <ul className="kf-pack-problems">
            {state.problems.map((p, i) => (
              <li key={i} data-problem={p.code}>
                <code>{p.path}</code> {p.message}
              </li>
            ))}
          </ul>
        </section>
      );
    case 'refused':
      return (
        <p id="kf-pack-outcome" role="alert" className="kf-status kf-status-error">
          Refused: {state.message}
        </p>
      );
    case 'drafted':
      return (
        <section
          id="kf-pack-outcome"
          role="status"
          className="kf-status kf-status-success"
          data-pack={state.packId}
        >
          <p>
            {state.replayed ? 'Already drafted: this was the same gesture.' : 'Drafted.'} Pack{' '}
            <Link href={`/objects/${encodeURIComponent(state.packId)}`}>{state.packId}</Link> is a
            draft. Approving it is an institutional act of the person who holds that authority; it
            is not done here, and no record is assigned it until it is approved.
          </p>
        </section>
      );
  }
}
