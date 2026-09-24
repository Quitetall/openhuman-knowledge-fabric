/**
 * `kf` — one entry point for everything an operator or an engineer types.
 *
 *   ingest                  records go in (dispatched acts, OIDC identity)
 *   master-record           a person's reading comes out (over the API, as that person)
 *   overview                the development control record, from the specification
 *   bootstrap-organization  the first organization and its first person (bootstrap tier)
 *   grant-authority         a person's role, clearance and identity link (bootstrap tier)
 *   retire-organization     an organization nobody can act in (bootstrap tier)
 *   revoke-identity         withdraw a provider account's link to a person (bootstrap tier)
 *   declare-agent           which OAuth clients may act for a person, ADR 0035 (bootstrap tier)
 *
 * The bootstrap-tier commands need DATABASE_OWNER_URL_FILE and are refused without it; the others
 * never see an owner credential.
 */

import { bootstrapUsage } from './admin/bootstrap-organization.js';
import { declareAgentUsage } from './admin/declare-agent.js';
import {
  runBootstrapCommand,
  runDeclareAgentCommand,
  runGrantAuthorityCommand,
  runRetireOrganizationCommand,
  runRevokeIdentityCommand,
} from './admin/commands.js';
import { retireOrganizationUsage } from './admin/retire-organization.js';
import { revokeIdentityUsage } from './admin/revoke-identity.js';
import { runIngestCommand, usage as ingestUsage } from './ingest/cli.js';
import { masterRecordUsage, runMasterRecordCommand } from './master-record/cli.js';
import { findRoot, overviewUsage, runOverviewCommand } from './overview/cli.js';

const command = process.argv[2];
const rest = process.argv.slice(3);

function allUsage(): string {
  return [
    'kf <command> [options]',
    '',
    '  ingest | master-record | overview | bootstrap-organization | grant-authority |',
    '  retire-organization | revoke-identity | declare-agent',
    '',
    ingestUsage(),
    '',
    masterRecordUsage(),
    '',
    overviewUsage(),
    '',
    bootstrapUsage(),
    '',
    'kf grant-authority --person <uuid> --organization <uuid> --role <id> --clearance <id> \\',
    '    --granted-by <uuid> --reason <text> [--issuer <url> --subject <sub>]',
    '',
    retireOrganizationUsage(),
    '',
    revokeIdentityUsage(),
    '',
    declareAgentUsage(),
  ].join('\n');
}

switch (command) {
  case 'ingest':
    process.exitCode = await runIngestCommand(rest);
    break;
  case 'master-record':
    process.exitCode = await runMasterRecordCommand(rest);
    break;
  case 'overview':
    try {
      const root = findRoot(process.cwd());
      process.exitCode = runOverviewCommand(rest, root, process.stdout, process.stderr);
    } catch (error: unknown) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    }
    break;
  case 'bootstrap-organization':
    process.exitCode = await runBootstrapCommand(rest);
    break;
  case 'grant-authority':
    process.exitCode = await runGrantAuthorityCommand(rest);
    break;
  case 'retire-organization':
    process.exitCode = await runRetireOrganizationCommand(rest);
    break;
  case 'revoke-identity':
    process.exitCode = await runRevokeIdentityCommand(rest);
    break;
  case 'declare-agent':
    process.exitCode = await runDeclareAgentCommand(rest);
    break;
  case 'help':
  case '--help':
  case '-h':
    process.stdout.write(`${allUsage()}\n`);
    break;
  default:
    process.stderr.write(`${allUsage()}\n`);
    process.exitCode = 2;
}
