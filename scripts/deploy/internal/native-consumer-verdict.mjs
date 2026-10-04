// Current process metadata is not application use, generation currency or release acceptance.
import { applicationCredentialBindings } from '../workstation-credentials.mjs';
const KEYS = [
  'version',
  'role',
  'pid',
  'invocation',
  'state',
  'substate',
  'uid',
  'gid',
  'expectedUid',
  'expectedGid',
  'aliases',
  'localIdentity',
  'stable',
  'noNewPrivileges',
  'capEffective',
  'capPermitted',
  'capAmbient',
  'swapInventoryEmpty',
  'memorySwapMax',
  'coreSoft',
  'coreHard',
  'custody',
].sort();
export function nativeConsumerVerdict(role, observation) {
  const safeRole = ['api', 'worker', 'attestor', 'checkpoint', 'storage', 'readiness'].includes(
    role,
  )
    ? role
    : 'unsupported';
  const unknown = () => ({
    role: safeRole,
    status: 'unverifiable',
    detail:
      'A complete stable current main-process observation is unavailable; inactive jobs need separately captured invocation evidence.',
  });
  try {
    const fields = applicationCredentialBindings(role);
    const v = observation;
    if (
      !v ||
      typeof v !== 'object' ||
      JSON.stringify(Object.keys(v).sort()) !== JSON.stringify(KEYS) ||
      v.version !== 1 ||
      v.role !== role
    )
      return unknown();
    for (const key of ['pid', 'uid', 'gid', 'expectedUid', 'expectedGid'])
      if (!Number.isSafeInteger(v[key]) || v[key] < 0 || v[key] > 0xffffffff) return unknown();
    if (
      v.pid === 0 ||
      typeof v.invocation !== 'string' ||
      !/^[a-f0-9]{32}$/.test(v.invocation) ||
      !['active', 'activating'].includes(v.state) ||
      !['running', 'start'].includes(v.substate)
    )
      return unknown();
    if (
      v.localIdentity !== true ||
      v.stable !== true ||
      !Array.isArray(v.aliases) ||
      !v.aliases.length ||
      v.aliases.length > 32 ||
      v.aliases.some((name) => typeof name !== 'string' || !/^[a-z_][a-z0-9_-]*$/.test(name))
    )
      return unknown();
    if (![0, 1].includes(v.noNewPrivileges) || typeof v.swapInventoryEmpty !== 'boolean')
      return unknown();
    for (const key of ['capEffective', 'capPermitted', 'capAmbient'])
      if (typeof v[key] !== 'string' || !/^[a-f0-9]{1,16}$/.test(v[key])) return unknown();
    for (const key of ['memorySwapMax', 'coreSoft', 'coreHard'])
      if (typeof v[key] !== 'string' || !/^(?:\d+|max|unlimited)$/.test(v[key])) return unknown();
    if (
      !['satisfied', 'unsatisfied', 'unverifiable'].includes(v.custody) ||
      v.custody === 'unverifiable'
    )
      return unknown();
    const failures = [];
    if (
      v.uid === 0 ||
      v.gid === 0 ||
      v.uid !== v.expectedUid ||
      v.gid !== v.expectedGid ||
      v.aliases.length !== 1 ||
      v.aliases[0] !== `kf-${role}`
    )
      failures.push('dedicated numeric identity');
    if (
      !v.swapInventoryEmpty ||
      v.memorySwapMax !== '0' ||
      v.coreSoft !== '0' ||
      v.coreHard !== '0'
    )
      failures.push('current swap/core protection');
    if (
      v.noNewPrivileges !== 1 ||
      [v.capEffective, v.capPermitted, v.capAmbient].some((bits) => BigInt('0x' + bits) !== 0n)
    )
      failures.push('current privilege protection');
    if (v.custody !== 'satisfied') failures.push('namespace-visible exact credential custody');
    const observed = {
      pid: v.pid,
      invocation: v.invocation,
      uid: v.uid,
      gid: v.gid,
      credentialCount: fields.length,
    };
    if (failures.length)
      return {
        role,
        status: 'unsatisfied',
        detail: `Current main-process checks refuse: ${failures.join(', ')}.`,
        observed,
      };
    return {
      role,
      status: 'satisfied',
      detail:
        'Current main-process identity, memory/privilege posture and namespace-visible credential custody verified; not content, use, source-generation currency, application correctness, restart, reboot or qualification evidence.',
      observed,
    };
  } catch {
    return unknown();
  }
}
