/**
 * `kf` — one entry point for everything an operator or an engineer types.
 *
 *   ingest                  records go in (dispatched acts, OIDC identity)
 *   note                    one observation, one gesture (over the API, as that person)
 *   master-record           a person's reading comes out (over the API, as that person)
 *   overview                the development control record, from the specification
 *   bootstrap-organization  the first organization and its first person (bootstrap tier)
 *   grant-authority         a person's role, clearance and identity link (bootstrap tier)
 *   retire-organization     an organization nobody can act in (bootstrap tier)
 *   revoke-identity         withdraw a provider account's link to a person (bootstrap tier)
 *   declare-agent           which OAuth clients may act for a person, ADR 0035 (bootstrap tier)
 *   define-role             a role name in the vocabulary, ADR 0040 (bootstrap tier)
 *   invite                  a person, their account, authority, qualification and link (ADR 0040)
 *
 * The bootstrap-tier commands need DATABASE_OWNER_URL_FILE and are refused without it; the others
 * never see an owner credential.
 */

import { bootstrapUsage } from './admin/bootstrap-organization.js';
import { declareAgentUsage } from './admin/declare-agent.js';
import { defineRoleUsage } from './admin/define-role.js';
import {
  runBootstrapCommand,
  runDeclareAgentCommand,
  runDefineRoleCommand,
  runInviteCommand,
  runGrantAuthorityCommand,
  runRetireOrganizationCommand,
  runRevokeIdentityCommand,
} from './admin/commands.js';
import { retireOrganizationUsage } from './admin/retire-organization.js';
import { revokeIdentityUsage } from './admin/revoke-identity.js';
import { runIngestCommand, usage as ingestUsage } from './ingest/cli.js';
import { masterRecordUsage, runMasterRecordCommand } from './master-record/cli.js';
import { noteUsage, runNoteCommand } from './note/cli.js';
import { findRoot, overviewUsage, runOverviewCommand } from './overview/cli.js';

const command = process.argv[2];
const rest = process.argv.slice(3);

function allUsage(): string {
  return [
    'kf <command> [options]',
    '',
    '  ingest | note | master-record | overview | bootstrap-organization | grant-authority |',
    '  retire-organization | revoke-identity | declare-agent | define-role | invite',
    '',
    ingestUsage(),
    '',
    noteUsage(),
    '',
    masterRecordUsage(),
    '',
    overviewUsage(),
    '',
    bootstrapUsage(),
    '',
    'kf grant-authority --person <uuid> --organization <uuid> --role <id> --clearance <id> \\',
    '    --granted-by <uuid> --reason <text> [--issuer <url> --subject <sub>] \\',
    '    [--valid-to <YYYY-MM-DD>] [--renew]',
    '  The role assignment ends at --valid-to: at most 366 days away, one year by default',
    '  (ADR 0036). --renew ends the live assignment now and records a new one.',
    '',
    retireOrganizationUsage(),
    '',
    revokeIdentityUsage(),
    '',
    declareAgentUsage(),
    '',
    defineRoleUsage(),
  ].join('\n');
}

switch (command) {
  case 'ingest':
    process.exitCode = await runIngestCommand(rest);
    break;
  case 'note':
    process.exitCode = await runNoteCommand(rest);
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
  case 'define-role':
    process.exitCode = await runDefineRoleCommand(rest);
    break;
  case 'invite':
    process.exitCode = await runInviteCommand(rest);
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
