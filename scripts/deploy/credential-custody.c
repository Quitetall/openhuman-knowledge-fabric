/* One Linux operation: verify PID 1's read-only, UID-specific credential copy.
 * No credential contents are read or printed. Root remains the trusted custodian.
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
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

static int custody(int fd, int is_directory) {
  struct stat st;
  struct statfs fs;
  unsigned char acl[64];
  const unsigned long flags = MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC;
  if (fstat(fd, &st) != 0 || fstatfs(fd, &fs) != 0 ||
      st.st_uid != 0 || st.st_gid != 0 ||
      (st.st_mode & 07777) != (is_directory ? 0550 : 0440) ||
      (is_directory ? !S_ISDIR(st.st_mode) : !S_ISREG(st.st_mode)) ||
      (!is_directory && (st.st_nlink != 1 || st.st_size < 0 || st.st_size > 65)) ||
      (unsigned long)fs.f_type != 0x01021994UL ||
      ((unsigned long)fs.f_flags & flags) != flags)
    return 0;
  ssize_t length = fgetxattr(fd, "system.posix_acl_access", acl, sizeof(acl));
  return acl_grants_service(acl, length, is_directory ? 5 : 4, geteuid());
}

int main(int argc, char **argv) {
  int directory = -1;
  int file = -1;
  int accepted = 0;
  if (argc == 2 && argv[1][0] == '/' && geteuid() != 0) {
    directory = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory >= 0 && custody(directory, 1)) {
      file = openat(directory, "index-key", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
      accepted = file >= 0 && custody(file, 0);
    }
  }
  if (file >= 0) close(file);
  if (directory >= 0) close(directory);
  if (!accepted) fputs("credential custody unavailable\n", stderr);
  return accepted ? 0 : 1;
}
