/**
 * Ontology compiler
 *
 * ontology/*.yaml is canonical; everything under generated/ is output. CI fails on drift,
 * because a hand-edited generated file is an ontology change nobody reviewed.
 */

import type { PackageManifest } from '@kf/domain';

export const PACKAGE: PackageManifest = {
  name: '@kf/ontology-compiler',
  role: 'Ontology compiler',
  owns: [],
};
