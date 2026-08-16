import type { Ontology } from '../model.js';

export interface Finding {
  readonly rule: string;
  readonly severity: 'error' | 'warning';
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
}

export interface CheckContext {
  readonly ontology: Ontology;
  readonly findings: Finding[];
  readonly objectIds: ReadonlySet<string>;
  readonly relationIds: ReadonlySet<string>;
  readonly actionIds: ReadonlySet<string>;
  readonly machineIds: ReadonlySet<string>;
  readonly sharedNames: ReadonlySet<string>;
  err(rule: string, path: string, message: string, remediation: string): void;
}
