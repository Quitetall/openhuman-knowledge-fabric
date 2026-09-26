/**
 * `kf:declare-service-actor`, kept as its own entry for the `pnpm` script that names it.
 *
 * Owner credentials, one transaction, fully recorded (ADR 0020). See
 * `./admin/declare-service-actor.ts` for what it creates and why it is an operator command.
 */

import { runDeclareServiceActorCommand } from './admin/commands.js';

process.exitCode = await runDeclareServiceActorCommand(process.argv.slice(2));
