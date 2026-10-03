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
      strcmp(name, "backup-decryption-key") == 0) {
    *minimum = 1;
    *maximum = strcmp(name, "preservation-signing-key") == 0 ? 4096 : 65536;
    return 1;
  }
  if (strcmp(name, "s3-secret-access-key") == 0) {
    *minimum = 1;
    *maximum = 8192;
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

int main(int argc, char **argv) {
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
