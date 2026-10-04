#define _GNU_SOURCE
#include <stddef.h>
#include <linux/capability.h>
#include <linux/nsfs.h>
#define main custody_program_main
#include "../../scripts/deploy/credential-custody.c"
#undef main

_Static_assert(KF_CAPABILITY_VERSION_3 == _LINUX_CAPABILITY_VERSION_3, "capability version");
_Static_assert(KF_NS_GET_NSTYPE == NS_GET_NSTYPE, "namespace ioctl");
#define COMPARE_LAYOUT(local, kernel, field) \
  _Static_assert(sizeof(struct local) == sizeof(struct kernel), "structure size"); \
  _Static_assert(_Alignof(struct local) == _Alignof(struct kernel), "structure alignment"); \
  _Static_assert(offsetof(struct local, field) == offsetof(struct kernel, field), "field offset")
COMPARE_LAYOUT(kf_cap_header, __user_cap_header_struct, version);
COMPARE_LAYOUT(kf_cap_header, __user_cap_header_struct, pid);
COMPARE_LAYOUT(kf_cap_data, __user_cap_data_struct, effective);
COMPARE_LAYOUT(kf_cap_data, __user_cap_data_struct, permitted);
COMPARE_LAYOUT(kf_cap_data, __user_cap_data_struct, inheritable);

int main(void) { return 0; }
