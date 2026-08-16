import type { DocumentDetail } from '../../../lib/api';

export const WORKBENCH_TABS = [
  'Preview',
  'Source',
  'Outline',
  'Composition',
  'Navigation',
  'Provenance',
  'Diagnostics',
  'Semantics & proposal',
  'Publication',
  'Metrics',
] as const;

export type WorkbenchTab = (typeof WORKBENCH_TABS)[number];
export type ParsedBlock = DocumentDetail['parsedBlocks'][number];
