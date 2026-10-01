#!/usr/bin/env bash
# Compile either Linux key-release atom for a target-compatible runtime.
# CC names one compiler executable, not a shell command. Static musl avoids a
# build workstation's glibc/CRT ISA floor leaking into a lower-baseline VM.
set -euo pipefail

compiler="${CC:-cc}"
static="${KF_PEER_CREDENTIALS_STATIC:-0}"
case "$static" in
  0|1) ;;
  *) echo 'KF_PEER_CREDENTIALS_STATIC must be 0 or 1' >&2; exit 1 ;;
esac
command -v "$compiler" >/dev/null 2>&1 || {
  echo 'peer-credential build requires the declared C11 compiler' >&2
  exit 1
}
if [[ "$#" == 1 && "$1" == --check ]]; then exit 0; fi
source_atom=peer-credentials.c
if [[ "$#" == 2 && "$1" == --credential-custody ]]; then
  source_atom=credential-custody.c
  shift
fi
if [[ "$#" != 1 || "$1" == --* || -e "$1" || -L "$1" ]]; then
  echo 'provide one fresh peer-credential output path' >&2
  exit 1
fi
source_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
flags=(-std=c11 -O2 -Wall -Wextra -Werror -D_FORTIFY_SOURCE=3 -fstack-protector-strong -Wl,-z,relro,-z,now)
case "$(uname -m)" in
  x86_64) flags+=(-march=x86-64) ;;
  aarch64) flags+=(-march=armv8-a) ;;
  *) echo 'unsupported peer-credential build architecture' >&2; exit 1 ;;
esac
if [[ "$static" == 1 ]]; then flags+=(-static); fi
"$compiler" "${flags[@]}" "$source_directory/$source_atom" -o "$1"
