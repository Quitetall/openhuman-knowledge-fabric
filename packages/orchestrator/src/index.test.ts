import { describe, expect, it, vi } from 'vitest';
import { composeActionAtoms } from './index.js';

describe('action atom composition', () => {
  it('combines independent atoms without hiding duplicate ownership', () => {
    const first = vi.fn();
    const second = vi.fn();

    expect(
      composeActionAtoms([
        { name: 'work', materializers: { create_work: first } },
        { name: 'documents', materializers: { add_document: second } },
      ]).materializers,
    ).toEqual({ create_work: first, add_document: second });

    expect(() =>
      composeActionAtoms([
        { name: 'work', materializers: { duplicate: first } },
        { name: 'documents', materializers: { duplicate: second } },
      ]),
    ).toThrow("action atom 'duplicate' is owned by both work and documents");
  });
});
