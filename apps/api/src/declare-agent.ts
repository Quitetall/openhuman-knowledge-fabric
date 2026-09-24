/**
 * `kf declare-agent`, kept as its own entry for the `pnpm` script that names it.
 *
 * See `./admin/declare-agent.ts` for why declaring an agent client is an owner-tier decision
 * (ADR 0035), and `docs/operating-model/runbook.md` for when to use it.
 */

import { runDeclareAgentCommand } from './admin/commands.js';

process.exitCode = await runDeclareAgentCommand(process.argv.slice(2));
