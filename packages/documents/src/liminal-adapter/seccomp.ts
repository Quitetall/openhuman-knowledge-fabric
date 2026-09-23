/**
 * The syscall filter bubblewrap loads (`--seccomp FD`) just before it execs the compiler.
 *
 * Namespaces decide what the compiler can SEE; this decides what it can ASK the kernel to do.
 * A document compiler reads stdin, writes stdout and allocates memory. It has no business
 * mounting, tracing, loading modules, touching keyrings, setting the clock, creating namespaces
 * or talking to io_uring, and every one of those is kernel attack surface a compromised compiler
 * would otherwise reach.
 *
 * This is a DENY list, the same shape as systemd's `SystemCallFilter=~…`, rather than an allow
 * list: the compiler is a pinned binary whose exact syscall set nobody has measured, and an allow
 * list guessed too tight fails compiles at random. What is denied is what a compiler never needs.
 *
 * It is layered UNDER the worker unit's own `SystemCallFilter=` (kf-worker.service), which the
 * sandbox inherits — seccomp filters are inherited across fork and exec and can only be added
 * to, never removed. That unit filter has to admit what bubblewrap needs to BUILD the sandbox
 * (mount, pivot_root, capset, unshare); this one takes those away again from the process inside
 * it, and it applies however the worker was started, systemd or not.
 *
 * The program is plain classic BPF, assembled here rather than by libseccomp so the build needs
 * no C toolchain and the bytes are reviewable: `seccomp.test.ts` checks the syscall numbers
 * against `scmp_sys_resolver` where it is installed, and runs a real probe under bubblewrap.
 */

/** A syscall is refused with EPERM, or — where a caller falls back on it — with ENOSYS. */
const EPERM = 1;
const ENOSYS = 38;

/** Denied outright: mount, trace, module, clock, keyring, namespace and kernel-admin surface. */
const DENIED = [
  // @mount
  'mount',
  'umount2',
  'pivot_root',
  'chroot',
  'fsopen',
  'fsconfig',
  'fsmount',
  'fspick',
  'move_mount',
  'open_tree',
  'mount_setattr',
  // @debug
  'ptrace',
  'process_vm_readv',
  'process_vm_writev',
  'perf_event_open',
  'pidfd_getfd',
  'lookup_dcookie',
  // @module, @reboot, @swap, @raw-io
  'init_module',
  'finit_module',
  'delete_module',
  'reboot',
  'kexec_load',
  'kexec_file_load',
  'swapon',
  'swapoff',
  'ioperm',
  'iopl',
  // @clock
  'settimeofday',
  'clock_settime',
  'adjtimex',
  'clock_adjtime',
  // @keyring
  'add_key',
  'request_key',
  'keyctl',
  // namespaces and identity
  'unshare',
  'setns',
  'sethostname',
  'setdomainname',
  'capset',
  // the rest of @privileged and friends
  'bpf',
  'userfaultfd',
  'acct',
  'quotactl',
  'quotactl_fd',
  'name_to_handle_at',
  'open_by_handle_at',
  'kcmp',
  'fanotify_init',
  'vhangup',
  'syslog',
] as const;

/**
 * Refused with ENOSYS, because libc and libuv treat ENOSYS as "not on this kernel" and fall
 * back: glibc's pthread_create retries clone3 as clone (which is filtered by flags below), and
 * libuv drops io_uring for its thread pool.
 */
const UNAVAILABLE = ['clone3', 'io_uring_setup', 'io_uring_enter', 'io_uring_register'] as const;

type SyscallName = (typeof DENIED)[number] | (typeof UNAVAILABLE)[number] | 'clone';

/**
 * Syscall numbers, from the kernel's tables (checked against `scmp_sys_resolver -a <arch>` by
 * the test). Absent means the architecture has no such call, so there is nothing to deny.
 */
const NUMBERS: Readonly<Record<SeccompArchitecture, Partial<Record<SyscallName, number>>>> = {
  x86_64: {
    mount: 165,
    umount2: 166,
    pivot_root: 155,
    chroot: 161,
    fsopen: 430,
    fsconfig: 431,
    fsmount: 432,
    fspick: 433,
    move_mount: 429,
    open_tree: 428,
    mount_setattr: 442,
    ptrace: 101,
    process_vm_readv: 310,
    process_vm_writev: 311,
    perf_event_open: 298,
    pidfd_getfd: 438,
    lookup_dcookie: 212,
    init_module: 175,
    finit_module: 313,
    delete_module: 176,
    reboot: 169,
    kexec_load: 246,
    kexec_file_load: 320,
    swapon: 167,
    swapoff: 168,
    ioperm: 173,
    iopl: 172,
    settimeofday: 164,
    clock_settime: 227,
    adjtimex: 159,
    clock_adjtime: 305,
    add_key: 248,
    request_key: 249,
    keyctl: 250,
    unshare: 272,
    setns: 308,
    sethostname: 170,
    setdomainname: 171,
    capset: 126,
    bpf: 321,
    userfaultfd: 323,
    acct: 163,
    quotactl: 179,
    quotactl_fd: 443,
    name_to_handle_at: 303,
    open_by_handle_at: 304,
    kcmp: 312,
    fanotify_init: 300,
    vhangup: 153,
    syslog: 103,
    clone3: 435,
    io_uring_setup: 425,
    io_uring_enter: 426,
    io_uring_register: 427,
    clone: 56,
  },
  aarch64: {
    mount: 40,
    umount2: 39,
    pivot_root: 41,
    chroot: 51,
    fsopen: 430,
    fsconfig: 431,
    fsmount: 432,
    fspick: 433,
    move_mount: 429,
    open_tree: 428,
    mount_setattr: 442,
    ptrace: 117,
    process_vm_readv: 270,
    process_vm_writev: 271,
    perf_event_open: 241,
    pidfd_getfd: 438,
    lookup_dcookie: 18,
    init_module: 105,
    finit_module: 273,
    delete_module: 106,
    reboot: 142,
    kexec_load: 104,
    kexec_file_load: 294,
    swapon: 224,
    swapoff: 225,
    settimeofday: 170,
    clock_settime: 112,
    adjtimex: 171,
    clock_adjtime: 266,
    add_key: 217,
    request_key: 218,
    keyctl: 219,
    unshare: 97,
    setns: 268,
    sethostname: 161,
    setdomainname: 162,
    capset: 91,
    bpf: 280,
    userfaultfd: 282,
    acct: 89,
    quotactl: 60,
    quotactl_fd: 443,
    name_to_handle_at: 264,
    open_by_handle_at: 265,
    kcmp: 272,
    fanotify_init: 262,
    vhangup: 58,
    syslog: 116,
    clone3: 435,
    io_uring_setup: 425,
    io_uring_enter: 426,
    io_uring_register: 427,
    clone: 220,
  },
};

export type SeccompArchitecture = 'x86_64' | 'aarch64';

/** `seccomp_data.arch` for each supported architecture (linux/audit.h). */
const AUDIT_ARCH: Readonly<Record<SeccompArchitecture, number>> = {
  x86_64: 0xc000003e,
  aarch64: 0xc00000b7,
};

/** Every CLONE_NEW* flag: a clone that asks for any of them is refused like unshare. */
const CLONE_NEW_NAMESPACES =
  0x00020000 | // CLONE_NEWNS
  0x02000000 | // CLONE_NEWCGROUP
  0x04000000 | // CLONE_NEWUTS
  0x08000000 | // CLONE_NEWIPC
  0x10000000 | // CLONE_NEWUSER
  0x20000000 | // CLONE_NEWPID
  0x40000000 | // CLONE_NEWNET
  0x00000080; // CLONE_NEWTIME

const X32_SYSCALL_BIT = 0x40000000;

// Classic BPF opcodes (linux/filter.h) and seccomp return values (linux/seccomp.h).
const LD_W_ABS = 0x20;
const JEQ_K = 0x15;
const JGE_K = 0x35;
const JSET_K = 0x45;
const RET_K = 0x06;
const RET_KILL_PROCESS = 0x80000000;
const RET_ERRNO = 0x00050000;
const RET_ALLOW = 0x7fff0000;

// Offsets into struct seccomp_data: nr, arch, then instruction_pointer, then args[6] (u64 each).
const DATA_NR = 0;
const DATA_ARCH = 4;
const DATA_ARG0_LOW = 16;

interface Instruction {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly k: number;
}

const op = (code: number, k: number, jt = 0, jf = 0): Instruction => ({ code, jt, jf, k });

/** The architecture this process runs on, or undefined where no filter is defined for it. */
export function currentSeccompArchitecture(): SeccompArchitecture | undefined {
  if (process.arch === 'x64') return 'x86_64';
  if (process.arch === 'arm64') return 'aarch64';
  return undefined;
}

/** The syscall names this filter refuses, for the test and for anyone reviewing the list. */
export const SECCOMP_DENIED: readonly string[] = [...DENIED, ...UNAVAILABLE];

/** The number of `name` on `arch`, or undefined when that architecture lacks the call. */
export function seccompSyscallNumber(arch: SeccompArchitecture, name: string): number | undefined {
  return NUMBERS[arch][name as SyscallName];
}

/**
 * The filter as bubblewrap reads it from `--seccomp FD`: an array of `struct sock_filter`
 * (u16 code, u8 jt, u8 jf, u32 k), native-endian — little-endian on both supported arches.
 */
export function compilerSeccompProgram(arch: SeccompArchitecture | undefined): Buffer {
  if (arch === undefined) {
    throw new Error(
      `no compiler syscall filter is defined for ${process.arch}; refusing to run the compiler unfiltered`,
    );
  }
  const numbers = NUMBERS[arch];
  const program: Instruction[] = [
    // A foreign-ABI syscall would be numbered from another table and slip every check below.
    op(LD_W_ABS, DATA_ARCH),
    op(JEQ_K, AUDIT_ARCH[arch], 1, 0),
    op(RET_K, RET_KILL_PROCESS),
    op(LD_W_ABS, DATA_NR),
  ];
  if (arch === 'x86_64') {
    // x32 syscalls share the x86_64 audit arch and are told apart only by this bit.
    program.push(op(JGE_K, X32_SYSCALL_BIT, 0, 1), op(RET_K, RET_KILL_PROCESS));
  }
  const refuse = (name: SyscallName, errno: number): void => {
    const number = numbers[name];
    if (number === undefined) return;
    program.push(op(JEQ_K, number, 0, 1), op(RET_K, RET_ERRNO | errno));
  };
  for (const name of DENIED) refuse(name, EPERM);
  for (const name of UNAVAILABLE) refuse(name, ENOSYS);
  // clone(flags, …): threads and forks pass; a clone that asks for a new namespace does not.
  program.push(
    op(JEQ_K, numbers.clone!, 0, 4),
    op(LD_W_ABS, DATA_ARG0_LOW),
    op(JSET_K, CLONE_NEW_NAMESPACES, 0, 1),
    op(RET_K, RET_ERRNO | EPERM),
    op(LD_W_ABS, DATA_NR),
    op(RET_K, RET_ALLOW),
  );
  const bytes = Buffer.alloc(program.length * 8);
  program.forEach((instruction, index) => {
    bytes.writeUInt16LE(instruction.code, index * 8);
    bytes.writeUInt8(instruction.jt, index * 8 + 2);
    bytes.writeUInt8(instruction.jf, index * 8 + 3);
    bytes.writeUInt32LE(instruction.k >>> 0, index * 8 + 4);
  });
  return bytes;
}
