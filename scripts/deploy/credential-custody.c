/* One Linux operation: verify PID 1's read-only, UID-specific credential copy.
 * No credential contents are read or printed. Root remains the trusted custodian.
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/xattr.h>
#include <unistd.h>
#include <stdlib.h>
#include <limits.h>
#include <sched.h>
#include <grp.h>
#include <dirent.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <errno.h>

/* Linux UAPI capability v3 and nsfs type query, from linux/capability.h and
 * linux/nsfs.h. Keep the tiny syscall layouts independent of libc's kernel
 * header installation (in particular musl). The native ABI fixture compares
 * these constants, sizes and offsets against the installed Linux headers.
 */
#define KF_CAPABILITY_VERSION_3 0x20080522U
#define KF_NS_GET_NSTYPE _IO(0xb7, 0x3)
struct kf_cap_header { uint32_t version; int pid; };
struct kf_cap_data { uint32_t effective, permitted, inheritable; };

static uint16_t le16(const unsigned char *p) {
  return (uint16_t)p[0] | (uint16_t)((uint16_t)p[1] << 8);
}

static uint32_t le32(const unsigned char *p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
         ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static int acl_grants_service(const unsigned char *acl, ssize_t length,
                             unsigned int permissions, uid_t service_uid) {
  const uint16_t tags[5] = {1, 2, 4, 16, 32};
  if (length != 44 || le32(acl) != 2 || service_uid == 0) return 0;
  /* Exactly owner, this service UID, root group, mask and other: no extra users
   * or groups. The root group may have read/execute, but other has no access.
   */
  for (unsigned int i = 0; i < 5; ++i) {
    const unsigned char *entry = acl + 4 + 8 * i;
    unsigned int perm = le16(entry + 2);
    if (le16(entry) != tags[i] ||
        le32(entry + 4) != (i == 1 ? (uint32_t)service_uid : UINT32_MAX))
      return 0;
    if (i == 4 ? perm != 0 : i == 2 ? (perm != 0 && perm != permissions)
                                   : perm != permissions)
      return 0;
  }
  return 1;
}

static int credential_policy(const char *name, off_t *minimum, off_t *maximum) {
  *minimum = 0;
  *maximum = 65;
  if (strcmp(name, "index-key") == 0) return 1;
  if (strcmp(name, "database-url") == 0 ||
      strcmp(name, "rehearsal-database-url") == 0) {
    *minimum = 1;
    *maximum = 8192;
    return 1;
  }
  if (strcmp(name, "rehearsal-receipt-key") == 0) {
    *minimum = 32;
    *maximum = 4096;
    return 1;
  }
  if (strcmp(name, "b2-endpoint") == 0 || strcmp(name, "b2-bucket") == 0 ||
      strcmp(name, "b2-key-id") == 0 || strcmp(name, "b2-key") == 0) {
    *minimum = 1;
    *maximum = 514;
    return 1;
  }
  if (strcmp(name, "preservation-signing-key") == 0 ||
      strcmp(name, "checkpoint-signing-key") == 0 ||
      strcmp(name, "backup-decryption-key") == 0) {
    *minimum = 1;
    *maximum = strcmp(name, "backup-decryption-key") == 0 ? 65536 : 4096;
    return 1;
  }
  if (strcmp(name, "s3-secret-access-key") == 0 ||
      strcmp(name, "s3-durable-secret-access-key") == 0) {
    *minimum = 1;
    *maximum = 8192;
    return 1;
  }
  if (strcmp(name, "readiness-token") == 0 ||
      strcmp(name, "master-record-link-secret") == 0) {
    *minimum = 32;
    *maximum = 8192;
    return 1;
  }
  if (strcmp(name, "ntfy-url") == 0 || strcmp(name, "heartbeat-url") == 0) {
    /* The handoff admits a 4096-character URL, optionally followed by a newline.
     * URL grammar and acknowledgement remain the dispatcher's responsibility.
     */
    *minimum = 1;
    *maximum = 4097;
    return 1;
  }
  return 0;
}

static int custody_size(int fd, int is_directory, off_t minimum, off_t maximum) {
  struct stat st;
  struct statfs fs;
  unsigned char acl[64];
  const unsigned long flags = MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC;
  if (fstat(fd, &st) != 0 || fstatfs(fd, &fs) != 0 ||
      st.st_uid != 0 || st.st_gid != 0 ||
      (st.st_mode & 07777) != (is_directory ? 0550 : 0440) ||
      (is_directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) ||
      (!is_directory && (st.st_nlink != 1 || st.st_size < minimum || st.st_size > maximum)) ||
      (unsigned long)fs.f_type != 0x01021994UL ||
      ((unsigned long)fs.f_flags & flags) != flags)
    return 0;
  ssize_t length = fgetxattr(fd, "system.posix_acl_access", acl, sizeof(acl));
  return acl_grants_service(acl, length, is_directory ? 5 : 4, geteuid());
}

static int custody(int fd, int is_directory) {
  return custody_size(fd, is_directory, 0, 65);
}

static int identity_number(const char *text, unsigned int *value) {
  if (!*text || *text == '0') return 0;
  for (const char *p = text; *p; ++p) if (*p < '0' || *p > '9') return 0;
  char *end;
  unsigned long parsed = strtoul(text, &end, 10);
  if (*end || parsed == 0 || parsed >= UINT_MAX) return 0;
  *value = (unsigned int)parsed;
  return 1;
}

/* Root-only observer mode. FD 3 pins the target mount namespace, FD 4 its root.
 * The already-running static checker enters them without executing namespace
 * programs, drops groups/UID/capabilities, then performs the SAME custody checks.
 * No secret bytes, external commands, caller diagnostics or lasting changes.
 */
static int inspect_current(int argc, char **argv) {
  unsigned int uid, gid;
  struct stat root;
  struct kf_cap_header header = {KF_CAPABILITY_VERSION_3, 0};
  struct kf_cap_data capabilities[2] = {{0}, {0}};
  if (argc != 6 || getuid() != 0 || geteuid() != 0 ||
      !identity_number(argv[2], &uid) || !identity_number(argv[3], &gid) ||
      ioctl(3, KF_NS_GET_NSTYPE) != CLONE_NEWNS || fstat(4, &root) != 0 ||
      !S_ISDIR(root.st_mode) || setns(3, CLONE_NEWNS) != 0 ||
      fchdir(4) != 0 || chroot(".") != 0 || chdir("/") != 0 ||
      prctl(PR_SET_KEEPCAPS, 0) != 0 ||
      prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) != 0 ||
      setgroups(0, NULL) != 0 || setresgid(gid, gid, gid) != 0 ||
      setresuid(uid, uid, uid) != 0 ||
      syscall(SYS_capset, &header, capabilities) != 0 ||
      prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 2;
  close(3); close(4);
  if (argv[4][0] != '/' || strlen(argv[5]) >= 1024) return 2;
  char names[1024];
  memcpy(names, argv[5], strlen(argv[5]) + 1);
  const char *expected[17];
  unsigned int count = 0;
  char *cursor = names;
  while (cursor && *cursor) {
    char *next = strchr(cursor, ',');
    if (next) *next++ = '\0';
    off_t minimum, maximum;
    if (count == 17 || !credential_policy(cursor, &minimum, &maximum)) return 2;
    for (unsigned int i = 0; i < count; ++i)
      if (strcmp(expected[i], cursor) == 0) return 2;
    expected[count++] = cursor;
    if (next && !*next) return 2;
    cursor = next;
  }
  if (!count) return 2;
  int fd = open(argv[4], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0 || !custody(fd, 1)) { if (fd >= 0) close(fd); return 1; }
  DIR *directory = fdopendir(fd);
  if (!directory) { close(fd); return 2; }
  unsigned int found = 0;
  int accepted = 1;
  struct dirent *entry;
  while (1) {
    errno = 0;
    entry = readdir(directory);
    if (!entry) { if (errno) accepted = 0; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    unsigned int i;
    for (i = 0; i < count; ++i) if (!strcmp(entry->d_name, expected[i])) break;
    if (i == count || ++found > count) { accepted = 0; break; }
    off_t minimum, maximum;
    if (!credential_policy(expected[i], &minimum, &maximum)) { accepted = 0; break; }
    int file = openat(fd, expected[i], O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (file < 0 || !custody_size(file, 0, minimum, maximum)) accepted = 0;
    if (file >= 0) close(file);
    if (!accepted) break;
  }
  closedir(directory);
  return accepted && found == count ? 0 : 1;
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "--inspect")) {
    int status = inspect_current(argc, argv);
    if (status) fputs("credential custody unavailable\n", stderr);
    return status;
  }
  int directory = -1;
  int file = -1;
  int accepted = 0;
  off_t minimum = 0, maximum = 0;
  const char *name = argc == 2 ? "index-key" : argc == 3 ? argv[2] : "";
  if ((argc == 2 || argc == 3) && argv[1][0] == '/' && geteuid() != 0 &&
      credential_policy(name, &minimum, &maximum)) {
    directory = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory >= 0 && custody(directory, 1)) {
      file = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
      accepted = file >= 0 && custody_size(file, 0, minimum, maximum);
    }
  }
  if (file >= 0) close(file);
  if (directory >= 0) close(directory);
  if (!accepted) fputs("credential custody unavailable\n", stderr);
  return accepted ? 0 : 1;
}
