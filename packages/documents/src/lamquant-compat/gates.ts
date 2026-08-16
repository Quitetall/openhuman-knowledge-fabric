import type { LamQuantCommandRunner, LamQuantGateEvidence, LamQuantGateName } from './contracts.js';

const GATES: readonly {
  readonly tool: LamQuantGateName;
  readonly args: readonly string[];
}[] = [
  { tool: 'doc_tree_lint', args: ['tools/doc_tree_lint.py'] },
  { tool: 'identifier_collisions', args: ['tools/scripts/check_identifier_collisions.py'] },
  { tool: 'adr_lint', args: ['tools/adr_lint.py', '--strict'] },
  {
    tool: 'adr_governance',
    args: ['-m', 'pytest', '-q', 'tests/contracts/architecture/test_adr_governance.py'],
  },
  { tool: 'doc_compose', args: ['tools/doc_compose.py', '--build'] },
  { tool: 'doc_views', args: ['tools/doc_views.py', '--build'] },
  { tool: 'doc_book', args: ['tools/doc_book.py'] },
];

export async function runGates(
  scratchPath: string,
  pythonExecutable: string,
  runner: LamQuantCommandRunner,
): Promise<readonly LamQuantGateEvidence[]> {
  const evidence: LamQuantGateEvidence[] = [];
  for (const gate of GATES) {
    const result = await runner.run({
      executable: pythonExecutable,
      args: gate.args,
      cwd: scratchPath,
    });
    evidence.push({
      tool: gate.tool,
      executable: pythonExecutable,
      args: [...gate.args],
      ...result,
    });
  }
  return evidence;
}
