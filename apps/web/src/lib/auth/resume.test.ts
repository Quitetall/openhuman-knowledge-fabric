import { describe, expect, it, vi } from 'vitest';
import { sealContextHint } from './cookies.js';
import { resumeChosenContext, type ContextCheck } from './resume.js';

const KEY = Buffer.alloc(32, 7);
const CONTEXT = {
  actingRoleId: '01900000-0000-7000-8000-000000000001',
  organizationId: '01900000-0000-7000-8000-000000000002',
  maxClassification: 'internal' as const,
};
const session = (subject: string) => ({
  version: 1 as const,
  accessToken: 'renewed-access-token',
  subject,
  expiresAt: Math.floor(Date.now() / 1000) + 300,
});
const hint = () =>
  sealContextHint({ subject: 'subject-a', ...CONTEXT }, Math.floor(Date.now() / 1000) + 3_600, KEY);

describe('resuming a chosen context after renewal', () => {
  it('resumes only after the API confirms the context for the renewed session', async () => {
    const confirm = vi.fn(async (): Promise<ContextCheck> => 'confirmed');
    await expect(
      resumeChosenContext(await hint(), session('subject-a'), KEY, confirm),
    ).resolves.toEqual({ kind: 'resumed', context: CONTEXT });
    expect(confirm).toHaveBeenCalledWith(CONTEXT);
  });

  it('never asks the API about, or resumes, a hint written for another subject', async () => {
    const confirm = vi.fn(async (): Promise<ContextCheck> => 'confirmed');
    await expect(
      resumeChosenContext(await hint(), session('subject-b'), KEY, confirm),
    ).resolves.toEqual({ kind: 'choose', discardHint: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('sends the person to choose when the API refuses, and forgets the refused hint', async () => {
    await expect(
      resumeChosenContext(await hint(), session('subject-a'), KEY, async () => 'refused'),
    ).resolves.toEqual({ kind: 'choose', discardHint: true });
  });

  it('keeps the hint when the API could not answer, but still does not resume', async () => {
    await expect(
      resumeChosenContext(await hint(), session('subject-a'), KEY, async () => 'unavailable'),
    ).resolves.toEqual({ kind: 'choose', discardHint: false });
  });

  it('asks nothing when there is no hint', async () => {
    const confirm = vi.fn(async (): Promise<ContextCheck> => 'confirmed');
    await expect(
      resumeChosenContext(undefined, session('subject-a'), KEY, confirm),
    ).resolves.toEqual({ kind: 'choose', discardHint: false });
    await expect(
      resumeChosenContext('garbage', session('subject-a'), KEY, confirm),
    ).resolves.toEqual({ kind: 'choose', discardHint: true });
    expect(confirm).not.toHaveBeenCalled();
  });
});
