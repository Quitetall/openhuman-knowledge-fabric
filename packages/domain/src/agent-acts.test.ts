import { describe, expect, it } from 'vitest';
import { AGENT_ACTS, agentAct, draftAgentAct } from './agent-acts.js';

describe('the closed list of agent acts', () => {
  it('names no act an agent may never perform or record', () => {
    const names = AGENT_ACTS.map((entry) => entry.act);
    for (const forbidden of [
      'verify_record',
      'set_verification_policy',
      'propose_act',
      'resolve_act_proposal',
      'grant_access',
      'correct_record',
      // Qualification: an agent may submit evidence for its person, never decide on it.
      'credit_qualification_evidence',
      'accept_qualification',
      'assign_qualification',
      'withdraw_qualification',
      'supersede_qualification',
    ]) {
      expect(names).not.toContain(forbidden);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  it('drafts the fields a person would fill, and says what is missing', () => {
    const draft = draftAgentAct(agentAct('create_initiative')!, {
      fields: { title: 'Bench automation', surprise: 1 },
    });
    expect(draft.ready).toBe(false);
    expect(draft.fields.map((field) => field.name)).toEqual([
      'title',
      'objective',
      'sponsor_id',
      'project_code',
      'classification',
    ]);
    expect(draft.problems).toEqual(
      expect.arrayContaining([
        'objective: required',
        'sponsor_id: required',
        'surprise: not a field of create_initiative',
      ]),
    );
  });

  it('requires a reason and one target where the act does', () => {
    const draft = draftAgentAct(agentAct('promote_observation')!, {});
    expect(draft.disposition).toBe('propose');
    expect(draft.problems.join()).toMatch(/exactly one observation/);
    expect(draft.problems.join()).toMatch(/reason/);
  });

  it('is ready when complete, and carries only the act’s own fields', () => {
    const draft = draftAgentAct(agentAct('record_observation')!, {
      fields: { body: 'rail at 3.29 V', tags: ['bench'] },
    });
    expect(draft.ready).toBe(true);
    expect(draft.payload).toEqual({ body: 'rail at 3.29 V', tags: ['bench'] });
  });
});
