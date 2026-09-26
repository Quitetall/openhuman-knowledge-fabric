import { describe, expect, it } from 'vitest';
import { decodeHoldings, encodeHoldings, parseHoldingsRequest } from './attestor.js';
import { IdentityRejected, holdingsFrom, type Holdings } from './identity.js';

const PERSON = '01a0d661-0ab4-7f1b-bf8c-19d9780b243d';
const ORG_A = '01a0d661-0aae-71e9-954f-fb10fb1222db';
const ORG_B = '01a0d661-0aae-71e9-954f-fb10fb1222dc';
const ASSIGNMENT = (n: number) => `01a0d661-8d80-73fb-af78-90e3defb3${String(n).padStart(3, '0')}`;

describe('holdingsFrom', () => {
  it('groups rows by organization in the order they came', () => {
    expect(
      holdingsFrom(PERSON, [
        {
          organizationId: ORG_B,
          legalName: 'B',
          assignmentId: ASSIGNMENT(1),
          roleId: 'r',
          scopeId: ORG_B,
        },
        {
          organizationId: ORG_A,
          legalName: 'A',
          assignmentId: ASSIGNMENT(2),
          roleId: 'r',
          scopeId: ORG_A,
        },
        {
          organizationId: ORG_B,
          legalName: 'B',
          assignmentId: ASSIGNMENT(3),
          roleId: 's',
          scopeId: ORG_B,
        },
      ]),
    ).toEqual({
      personId: PERSON,
      organizations: [
        {
          organizationId: ORG_B,
          legalName: 'B',
          assignments: [
            { assignmentId: ASSIGNMENT(1), roleId: 'r', scopeId: ORG_B },
            { assignmentId: ASSIGNMENT(3), roleId: 's', scopeId: ORG_B },
          ],
        },
        {
          organizationId: ORG_A,
          legalName: 'A',
          assignments: [{ assignmentId: ASSIGNMENT(2), roleId: 'r', scopeId: ORG_A }],
        },
      ],
    });
  });

  it('refuses a person holding nothing anywhere as no_live_assignment', () => {
    const error = (() => {
      try {
        holdingsFrom(PERSON, []);
      } catch (caught: unknown) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(IdentityRejected);
    expect((error as IdentityRejected).failure).toBe('no_live_assignment');
  });
});

describe('holdings on the attestor socket', () => {
  const holdings: Holdings = {
    personId: PERSON,
    organizations: [
      {
        organizationId: ORG_A,
        legalName: 'Redwood Inference',
        assignments: [{ assignmentId: ASSIGNMENT(1), roleId: 'performer', scopeId: ORG_A }],
      },
    ],
  };

  it('round-trips', () => {
    expect(decodeHoldings(JSON.parse(JSON.stringify(encodeHoldings(holdings))))).toEqual(holdings);
  });

  it.each([
    ['no person', { ...encodeHoldings(holdings), personId: undefined }],
    ['a person that is not an id', { ...encodeHoldings(holdings), personId: 'someone' }],
    ['no organizations', { ...encodeHoldings(holdings), organizations: [] }],
    [
      'an organization twice',
      {
        ...encodeHoldings(holdings),
        organizations: [
          encodeHoldings(holdings)['organizations'],
          encodeHoldings(holdings)['organizations'],
        ].flat(),
      },
    ],
    [
      'an organization with no assignments',
      {
        personId: PERSON,
        organizations: [{ organizationId: ORG_A, legalName: 'A', assignments: [] }],
      },
    ],
    [
      'a legal name that is not text',
      {
        personId: PERSON,
        organizations: [
          {
            organizationId: ORG_A,
            legalName: 7,
            assignments: [{ assignmentId: ASSIGNMENT(1), roleId: 'r', scopeId: ORG_A }],
          },
        ],
      },
    ],
    [
      'too many organizations',
      {
        personId: PERSON,
        organizations: Array.from({ length: 65 }, (_, i) => ({
          organizationId: `01a0d661-0aae-71e9-954f-fb10fb12${String(i).padStart(4, '0')}`,
          legalName: 'x',
          assignments: [{ assignmentId: ASSIGNMENT(i), roleId: 'r', scopeId: ORG_A }],
        })),
      },
    ],
    ['not an object', 'holdings'],
  ])('refuses an answer with %s', (_what, body) => {
    expect(() => decodeHoldings(body)).toThrow(/not a list of holdings/);
  });

  it('accepts a request that is a token and nothing else', () => {
    expect(parseHoldingsRequest({ token: 't' })).toEqual({ token: 't' });
    expect(parseHoldingsRequest({ token: 't', personId: PERSON })).toBeUndefined();
    expect(parseHoldingsRequest({ token: 't', organizationId: ORG_A })).toBeUndefined();
    expect(parseHoldingsRequest({ token: 7 })).toBeUndefined();
    expect(parseHoldingsRequest({})).toBeUndefined();
    expect(parseHoldingsRequest(['t'])).toBeUndefined();
    expect(parseHoldingsRequest(null)).toBeUndefined();
  });
});
