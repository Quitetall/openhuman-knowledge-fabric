/* Test production predicates, not a second JavaScript interpretation. Metadata
 * plants below are unit evidence; the VM driver checks actual kernel custody.
 */
#define _GNU_SOURCE
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/xattr.h>
#include <unistd.h>
#include <string.h>
static struct stat fixture_stat;
static struct statfs fixture_fs;
static unsigned char fixture_acl[64];
static int fixture_fstat(int fd, struct stat *st) {
  (void)fd;
  *st = fixture_stat;
  return 0;
}
static int fixture_fstatfs(int fd, struct statfs *fs) {
  (void)fd;
  *fs = fixture_fs;
  return 0;
}
static ssize_t fixture_fgetxattr(int fd, const char *name, void *out, size_t limit) {
  (void)fd;
  if (strcmp(name, "system.posix_acl_access") != 0 || limit < 44) return -1;
  memcpy(out, fixture_acl, 44);
  return 44;
}
static uid_t fixture_geteuid(void) { return 1000; }
#define fstat fixture_fstat
#define fstatfs fixture_fstatfs
#define fgetxattr fixture_fgetxattr
#define geteuid fixture_geteuid
#define main credential_custody_main
#include "../../scripts/deploy/credential-custody.c"
#undef main
#undef fstat
#undef fstatfs
#undef fgetxattr
#undef geteuid

static void put16(unsigned char *p, uint16_t n) {
  p[0] = (unsigned char)n;
  p[1] = (unsigned char)(n >> 8);
}
static void put32(unsigned char *p, uint32_t n) {
  p[0] = (unsigned char)n;
  p[1] = (unsigned char)(n >> 8);
  p[2] = (unsigned char)(n >> 16);
  p[3] = (unsigned char)(n >> 24);
}
static void valid(unsigned char *acl, unsigned int perm) {
  const uint16_t tags[5] = {1, 2, 4, 16, 32};
  memset(acl, 0, 64);
  put32(acl, 2);
  for (unsigned int i = 0; i < 5; ++i) {
    put16(acl + 4 + 8 * i, tags[i]);
    put16(acl + 6 + 8 * i, i == 2 || i == 4 ? 0 : (uint16_t)perm);
    put32(acl + 8 + 8 * i, i == 1 ? 1000 : UINT32_MAX);
  }
}
int main(void) {
  unsigned char acl[64];
  for (unsigned int perm = 4; perm <= 5; ++perm) {
    valid(acl, perm);
    if (!acl_grants_service(acl, 44, perm, 1000)) return 1;
    if (acl_grants_service(acl, 43, perm, 1000) ||
        acl_grants_service(acl, 52, perm, 1000) ||
        acl_grants_service(acl, -1, perm, 1000) ||
        acl_grants_service(acl, 44, perm, 999) ||
        acl_grants_service(acl, 44, perm, 0)) return 1;
    put16(acl + 6 + 8 * 2, (uint16_t)perm); // Root group access is permitted.
    if (!acl_grants_service(acl, 44, perm, 1000)) return 1;
    for (unsigned int i = 0; i < 5; ++i) {
      valid(acl, perm);
      put16(acl + 4 + 8 * i, 2); // Duplicate user or replacement group/mask/other.
      if (i != 1 && acl_grants_service(acl, 44, perm, 1000)) return 1;
      valid(acl, perm);
      put16(acl + 6 + 8 * i, 7); // Widened write/execute rights or effective mask.
      if (acl_grants_service(acl, 44, perm, 1000)) return 1;
      valid(acl, perm);
      put32(acl + 8 + 8 * i, 123); // Wrong UID or unexpected qualifier.
      if (acl_grants_service(acl, 44, perm, 1000)) return 1;
    }
    valid(acl, perm);
    put32(acl, 3);
    if (acl_grants_service(acl, 44, perm, 1000)) return 1;
  }
  for (int is_directory = 0; is_directory <= 1; ++is_directory) {
    memset(&fixture_stat, 0, sizeof(fixture_stat));
    fixture_stat.st_mode = is_directory ? S_IFDIR | 0550 : S_IFREG | 0440;
    fixture_stat.st_nlink = 1;
    fixture_stat.st_size = 64;
    fixture_fs.f_type = 0x01021994;
    fixture_fs.f_flags = MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC;
    valid(fixture_acl, is_directory ? 5 : 4);
    if (!custody(123, is_directory)) return 1;
    const unsigned long flags[4] = {MS_RDONLY, MS_NOSUID, MS_NODEV, MS_NOEXEC};
    for (unsigned int i = 0; i < 4; ++i) {
      fixture_fs.f_flags &= ~flags[i];
      if (custody(123, is_directory)) return 1;
      fixture_fs.f_flags |= flags[i];
    }
    fixture_fs.f_type = 0x01021993;
    if (custody(123, is_directory)) return 1;
    fixture_fs.f_type = 0x01021994;
    fixture_stat.st_uid = 1000;
    if (custody(123, is_directory)) return 1;
    fixture_stat.st_uid = 0;
    fixture_stat.st_gid = 1000;
    if (custody(123, is_directory)) return 1;
    fixture_stat.st_gid = 0;
    mode_t mode = fixture_stat.st_mode;
    fixture_stat.st_mode |= 0004;
    if (custody(123, is_directory)) return 1;
    fixture_stat.st_mode = S_IFLNK | (mode & 07777);
    if (custody(123, is_directory)) return 1;
    fixture_stat.st_mode = mode;
    if (!is_directory) {
      fixture_stat.st_size = 66;
      if (custody(123, 0)) return 1;
      fixture_stat.st_size = 64;
      fixture_stat.st_nlink = 2;
      if (custody(123, 0)) return 1;
    }
  }
  /* The named interface must preserve the old index limit and admit only the
   * bounded migration credentials. Unknown names and traversal have no policy.
   */
  const char *names[4] = {"index-key", "database-url", "rehearsal-database-url",
                          "rehearsal-receipt-key"};
  const off_t minimum[4] = {0, 1, 1, 32};
  const off_t maximum[4] = {65, 8192, 8192, 4096};
  fixture_stat.st_mode = S_IFREG | 0440;
  valid(fixture_acl, 4);
  for (unsigned int i = 0; i < 4; ++i) {
    off_t lower = -1, upper = -1;
    if (!credential_policy(names[i], &lower, &upper) ||
        lower != minimum[i] || upper != maximum[i]) return 1;
    fixture_stat.st_nlink = 1;
    fixture_stat.st_size = lower;
    if (!custody_size(123, 0, lower, upper)) return 1;
    fixture_stat.st_size = upper;
    if (!custody_size(123, 0, lower, upper)) return 1;
    fixture_stat.st_size = upper + 1;
    if (custody_size(123, 0, lower, upper)) return 1;
    fixture_stat.st_size = lower - 1;
    if (custody_size(123, 0, lower, upper)) return 1;
  }
  const char *refused[5] = {"", "../database-url", "/database-url", "anything", "index-key/"};
  for (unsigned int i = 0; i < 5; ++i) {
    off_t lower = 0, upper = 0;
    if (credential_policy(refused[i], &lower, &upper)) return 1;
  }
  return 0;
}
