/* One Linux operation: report the kernel credentials of the connected stdin socket. */
#define _GNU_SOURCE
#include <stdio.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(void) {
  struct sockaddr_storage address;
  socklen_t address_length = sizeof(address);
  struct ucred peer;
  socklen_t peer_length = sizeof(peer);
  if (getsockname(STDIN_FILENO, (struct sockaddr *)&address, &address_length) != 0 ||
      address.ss_family != AF_UNIX ||
      getpeername(STDIN_FILENO, (struct sockaddr *)&address, &address_length) != 0 ||
      address.ss_family != AF_UNIX ||
      getsockopt(STDIN_FILENO, SOL_SOCKET, SO_PEERCRED, &peer, &peer_length) != 0 ||
      peer_length != sizeof(peer) || peer.pid <= 0) {
    fputs("local peer credentials unavailable\n", stderr);
    return 1;
  }
  if (printf("%u %u %d\n", (unsigned)peer.uid, (unsigned)peer.gid, (int)peer.pid) < 0)
    return 1;
  return fflush(stdout) == 0 ? 0 : 1;
}
