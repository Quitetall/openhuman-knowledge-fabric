export interface RecoveryBarrierOptions {
  stateDirectory: string;
  unitDirectory: string;
  ownerUid: number;
  manager(args: string[]): string;
}
export function recoveryBarrier(
  command: 'hold' | 'resume-confirmed',
  additionalUnits: string[],
  options: RecoveryBarrierOptions,
): void;
