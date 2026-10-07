import type { PackDocument } from '@kf/qualification';

export declare const COMMON: string;
export declare const CEO: string;
export declare const AERO: string;
export declare const KEYS: {
  readonly readIn: string;
  readonly references: string;
  readonly ncr: string;
  readonly firstContribution: string;
  readonly authorityMatrix: string;
  readonly capaPlan: string;
  readonly programme: string;
  readonly containment: string;
};

interface Ref {
  readonly id: string;
  readonly revision: string;
}

export interface VeracierPacks {
  readonly common: PackDocument;
  readonly ceo: PackDocument;
  readonly aero: PackDocument;
}

export declare function veracierPacks(options: {
  readonly resources: {
    readonly overview: Ref;
    readonly procedures: Ref;
    readonly ncrExample: Ref;
    readonly authorityMatrix: Ref;
    readonly programme: Ref;
  };
  readonly scope: { readonly av3000: string };
  readonly roles: { readonly owner: string; readonly quality: string; readonly executive: string };
}): VeracierPacks;

export declare function aeroRevision2(
  packs: VeracierPacks,
  options: { readonly key?: string; readonly behavioural: boolean },
): PackDocument;

export declare const JOINERS: readonly {
  readonly key: string;
  readonly name: string;
  readonly title: string;
  readonly pack: string;
  readonly contact: string;
  readonly role: string | null;
}[];
