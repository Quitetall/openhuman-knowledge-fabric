import type { ActionRequest } from '@kf/actions';
import type { Tx } from '@kf/database';
import { describe, expect, it, vi } from 'vitest';
import {
  composeActionAtoms,
  createFabricTransactionalDispatcher,
  fabricDispatcherOptions,
} from './index.js';

describe('action atom composition', () => {
  it('combines independent atoms without hiding duplicate ownership', () => {
    const first = vi.fn();
    const second = vi.fn();

    expect(
      composeActionAtoms([
        { name: 'work', ownedActions: ['create_work'], materializers: { create_work: first } },
        {
          name: 'documents',
          ownedActions: ['add_document'],
          materializers: { add_document: second },
        },
      ]).materializers,
    ).toEqual({ create_work: first, add_document: second });

    expect(() =>
      composeActionAtoms([
        { name: 'work', ownedActions: ['duplicate'], materializers: { duplicate: first } },
        {
          name: 'documents',
          ownedActions: ['duplicate'],
          materializers: { duplicate: second },
        },
      ]),
    ).toThrow("action 'duplicate' is owned by both work and documents");
  });

  it('refuses a handler whose atom declares no owner', () => {
    expect(() =>
      composeActionAtoms([
        { name: 'unowned', ownedActions: [], effects: { triage_initiative: vi.fn() } },
      ]),
    ).toThrow("action handler 'triage_initiative' from unowned has no declared owner");
  });

  it('keeps built-in pure transitions owned without inventing handlers', () => {
    const options = fabricDispatcherOptions();

    expect(options.allowedActions.has('triage_initiative')).toBe(true);
    expect(options.allowedActions.has('supersede_configuration_item')).toBe(true);
    expect(options.materializers['triage_initiative']).toBeUndefined();
    expect(options.effects['triage_initiative']).toBeUndefined();
    expect(options.preconditions['triage_initiative']).toBeUndefined();
  });

  it('composes all ML authority actions with one declared atom owner', () => {
    const options = fabricDispatcherOptions();

    expect(options.allowedActions.has('authorize_ml_metric_stream')).toBe(true);
    expect(options.allowedActions.has('append_ml_metric_event')).toBe(true);
    expect(options.allowedActions.has('authorize_ml_promotion')).toBe(true);
    expect(options.effects['authorize_ml_metric_stream']).toBeTypeOf('function');
    expect(options.effects['append_ml_metric_event']).toBeTypeOf('function');
    expect(options.effects['authorize_ml_promotion']).toBeTypeOf('function');
    expect(options.preconditions['authorize_ml_metric_stream']).toBeTypeOf('function');
    expect(options.preconditions['append_ml_metric_event']).toBeTypeOf('function');
    expect(options.preconditions['authorize_ml_promotion']).toBeTypeOf('function');
    expect(options.materializers['authorize_ml_promotion']).toBeTypeOf('function');
  });

  it('refuses document actions through the generic route when document atoms are unavailable', async () => {
    const execute = createFabricTransactionalDispatcher();
    const request: ActionRequest = {
      actionType: 'add_authored_fragment',
      actorId: '11111111-1111-7111-8111-111111111111',
      actingRoleId: '22222222-2222-7222-8222-222222222222',
      targetIds: [],
      idempotencyKey: 'document-atom-unavailable-0001',
      organizationId: '33333333-3333-7333-8333-333333333333',
      maxClassification: 'internal',
    };
    const tx = { query: vi.fn(), one: vi.fn(), maybeOne: vi.fn() } as unknown as Tx;

    await expect(execute(tx, request)).rejects.toEqual(
      expect.objectContaining({ failure: 'unknown_action' }),
    );
    expect(tx.query).not.toHaveBeenCalled();
  });
});
