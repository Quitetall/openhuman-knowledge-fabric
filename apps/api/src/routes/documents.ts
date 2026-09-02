/** Human-facing document routes composed from artifact, parser, action, and projection atoms. */

import type { FastifyInstance } from 'fastify';
import type { DocumentRoutesOptions } from './documents/contracts.js';
import { registerDocumentImportRoute } from './documents/import-route.js';
import { registerDocumentReadRoutes } from './documents/read-routes.js';
import { registerDocumentProposalRoute } from './documents/proposal-route.js';
import { registerDocumentPlannerProposalRoute } from './documents/planner-proposal-route.js';
import { registerDocumentProjectionRoute } from './documents/projection-route.js';
import { registerDocumentSourceRoute } from './documents/source-route.js';
import { registerDocumentWorkspaceRoute } from './documents/workspace-route.js';
import { registerPublicProjectionRoute } from './documents/public-projection-route.js';
import { registerMasterRecordRoute } from './documents/master-record-route.js';
import { registerMasterRecordLinkRoute } from './documents/master-record-link-route.js';
import { registerMasterRecordProjectionRoute } from './documents/master-record-projection-route.js';

export type { DocumentRoutesOptions } from './documents/contracts.js';

export async function registerDocumentRoutes(
  app: FastifyInstance,
  options: DocumentRoutesOptions,
): Promise<void> {
  registerDocumentReadRoutes(app, options);
  registerMasterRecordRoute(app, options);
  registerMasterRecordLinkRoute(app, options);
  registerMasterRecordProjectionRoute(app, options);
  registerPublicProjectionRoute(app, options);
  registerDocumentSourceRoute(app, options);
  registerDocumentWorkspaceRoute(app, options);
  registerDocumentProjectionRoute(app, options);
  registerDocumentPlannerProposalRoute(app, options);
  registerDocumentProposalRoute(app, options);
  registerDocumentImportRoute(app, options);
}
