#!/usr/bin/env bash
#
# Publish one release of the Knowledge Fabric to a PUBLIC repository as a single commit,
# leaving this repository's history private and untouched.
#
# WHY A FRESH REPOSITORY AND NOT AN ORPHAN BRANCH. The plan for this was `git checkout --orphan`,
# which shares no ancestry and is the usual advice. This does something stronger: it builds a new
# repository in a temporary directory from `git archive`, so the private objects are not merely
# unreferenced by the branch being pushed — they are NOT PRESENT in the repository doing the
# pushing. An orphan branch lives in a repository that still contains every private commit, and
# one mistyped refspec (`git push public --all`, `--tags`, `--mirror`) sends them. That mistake
# is unrecoverable in the way this project cares about: published bytes cannot be unpublished.
#
# WHAT IT REFUSES TO DO, all fail-closed:
#
#   - publish anything by default. The default is a DRY RUN; `--publish` is required. That is the
#     right way round: the dangerous act needs the flag, not the safe one.
#   - publish from an unclean tree, or from anything other than an ANNOTATED tag.
#   - publish without a LICENSE, or while package.json still says UNLICENSED.
#   - publish without gitleaks installed. A secret scan that skips when its tool is missing is
#     the failure this repository keeps deleting; absence is an error, not a pass.
#   - publish if gitleaks finds anything in the tree it is about to publish.
#   - publish if any denylisted path is present.
#   - publish to the same remote as `origin`.
#   - force-push, ever. It pushes one branch, one ref, no tags, no `--force`.
#
# WHAT IT CANNOT DECIDE, and says so rather than pretending: whether a file under `dogfood/`
# names a real person. It lists them and requires a human to look. A name is not a pattern.
#
# HOW THE PUBLISH PATH WAS PROVEN, and how to prove it again after changing this file. Point
# --remote at a local bare repository and publish a throwaway tag into it; nothing leaves the
# machine and every claim above becomes checkable. Run from the repository root:
#
#   # rm -rf FIRST: `git init --bare` on an existing path REINITIALISES it and keeps the refs,
#   # so a re-run would otherwise report the previous run's commit and look like a pass.
#   rm -rf /tmp/fake-public.git && git init --bare /tmp/fake-public.git
#   ./scripts/publish-public.sh --remote /tmp/fake-public.git --tag <tag> --publish
#   git --git-dir=/tmp/fake-public.git rev-list --count main        # 1
#   git --git-dir=/tmp/fake-public.git log -1 --format=%P main      # empty: a root commit
#   git --git-dir=/tmp/fake-public.git for-each-ref | wc -l         # 1: no tags, no other branch
#   git rev-parse '<tag>^{tree}'                                    # equal to:
#   git --git-dir=/tmp/fake-public.git rev-parse 'main^{tree}'
#   # `cat-file -e` prints NOTHING and only sets an exit code, so say so out loud — a silent
#   # check is one a reader scores as passed without looking, which is the habit this whole
#   # script exists to resist.
#   git --git-dir=/tmp/fake-public.git cat-file -e "$(git rev-parse main)" \
#     && echo 'LEAK: private HEAD is in the public repo' || echo 'clean: private HEAD absent'
#
# The two tree hashes matching is the claim that matters: the published bytes ARE the tag's, not
# a copy that resembles it. The `cat-file` line is the other one: the private HEAD commit is not
# an object in the public repository at all. Both held when this was last run, along with the
# refusal on a mismatched confirmation leaving zero refs behind.
#
# Usage:
#   scripts/publish-public.sh --remote git@github.com:<org>/knowledge-fabric.git [--tag v1.0.0]
#   scripts/publish-public.sh --remote ... --tag v1.0.0 --publish

set -euo pipefail

# Sourced for `kf_at_exit`, not for anything to do with passwords. A bare `trap ... EXIT`
# REPLACES whatever handler is already installed rather than adding to it, which is how a
# temporary credential file survived a script twice in this repository —
# `tests/backup-restore/script-credentials.test.ts` now refuses a bare trap in any script here,
# and refused this one. Sourcing arms the shared dispatcher; the cost is one unused mktemp.
# shellcheck source=lib/secret.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/secret.sh"

die() {
  printf '\nREFUSING: %s\n' "$*" >&2
  exit 1
}
note() { printf '  %s\n' "$*"; }

remote=''
tag=''
publish=false
while [ $# -gt 0 ]; do
  case "$1" in
    --remote)
      remote="${2:-}"
      shift 2
      ;;
    --tag)
      tag="${2:-}"
      shift 2
      ;;
    --publish)
      publish=true
      shift
      ;;
    -h | --help)
      sed -n '2,32p' "$0"
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$remote" ] || die "--remote is required (the PUBLIC repository, not this one)"

command -v git >/dev/null || die 'git is not installed'
command -v gitleaks >/dev/null ||
  die 'gitleaks is not installed. It is the precondition for publishing, not an optional extra —
       install the CLI pinned in .github/workflows/ci.yml and run this again.'

root="$(git rev-parse --show-toplevel)"
cd "$root"

printf '\n== preconditions ==\n'

# Untracked files included: an untracked file is exactly the kind of thing that gets published by
# accident. Ignored files are not, because node_modules and dist are not candidates for the tree.
[ -z "$(git status --porcelain=v1 --untracked-files=all)" ] ||
  die 'working tree is not clean. Publish from a tree that matches the tag exactly.'
note 'working tree clean'

if [ -z "$tag" ]; then
  tag="$(git describe --exact-match --tags HEAD 2>/dev/null)" ||
    die 'HEAD is not at a tag. Pass --tag, or tag the commit being released.'
fi
git rev-parse -q --verify "refs/tags/${tag}" >/dev/null || die "no such tag: ${tag}"
# An annotated tag is a `tag` object; a lightweight one points straight at the commit. A release
# should be a thing somebody made deliberately and can be verified later.
[ "$(git cat-file -t "refs/tags/${tag}")" = 'tag' ] ||
  die "${tag} is a lightweight tag. Re-create it annotated: git tag -a ${tag} -m '...'"
commit="$(git rev-parse "${tag}^{commit}")"
note "annotated tag ${tag} at ${commit}"

origin_url="$(git remote get-url origin 2>/dev/null || true)"
resolved_remote="$(git remote get-url "$remote" 2>/dev/null || printf '%s' "$remote")"
[ "$resolved_remote" != "$origin_url" ] ||
  die "--remote resolves to origin (${origin_url}). That is the PRIVATE repository."
note "public remote ${resolved_remote}"

# ---------------------------------------------------------------------------------------------
# The tree that would be published, materialised so it can be inspected rather than assumed.
#
# EVERYTHING BELOW READS THIS TREE, NOT THE WORKING DIRECTORY, and the first version of this
# script got that wrong: it checked LICENSE and package.json in the working directory while
# publishing the archived tag. Those are the same tree only when the tag is HEAD. Pass `--tag`
# for an earlier release and it would have validated one tree and published another — approving
# a licence that the published bytes did not contain.
# ---------------------------------------------------------------------------------------------
work="$(mktemp -d)"
kf_at_exit 'rm -rf "$work"'
tree="${work}/tree"
mkdir -p "$tree"
git archive "$tag" | tar -x -C "$tree"

# The licence is a precondition rather than a reminder: a repository published without one is,
# by default, all-rights-reserved with no grant to anybody.
[ -s "${tree}/LICENSE" ] ||
  die "no LICENSE in the ${tag} tree. Nothing may be published before the licence is decided."

# WHAT THESE CHECKS USED TO BE, AND WHY THEY ARE GONE. Until 2026-08-21 this validated BUSL-1.1:
# five parameter lines (Licensor, Licensed Work, Additional Use Grant, Change Date, Change
# License), each non-blank and free of placeholders, plus a check that 'Licensed Work' named the
# tag being published — because BUSL applies separately per version and a LICENSE naming v1.0.0
# published as v1.1.0 states the wrong Change Date for the bytes beside it.
#
# The project moved to Apache-2.0, which has NO parameters and is NOT per-version. Every one of
# those checks would now fail against a perfectly correct licence, and the per-version concern
# they existed to catch cannot occur: one Apache-2.0 text governs every release identically.
#
# Recorded rather than quietly deleted, because a gate that disappears in a refactor is
# indistinguishable from a gate that was never there.
#
# What replaces them is stronger, not weaker. Apache-2.0 is a fixed text, so it can be checked
# by identity instead of by parsing fields out of it: any edit at all — a helpfully added
# sentence, a filled-in appendix, a stray CRLF — changes the digest and stops the publish.
apache_sha='c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'
actual_sha="$(sha256sum "${tree}/LICENSE" | cut -d' ' -f1)"
if [ "$actual_sha" != "$apache_sha" ]; then
  die "LICENSE in ${tag} is not the canonical Apache-2.0 text.
       expected sha256 ${apache_sha}
       actual   sha256 ${actual_sha}
       Publish the licence verbatim. Put the copyright in NOTICE, not in LICENSE."
fi
note "LICENSE is the canonical Apache-2.0 text (sha256 ${actual_sha})"

# NOTICE carries the copyright, since the canonical LICENSE keeps the appendix placeholders. If
# it is missing there is no copyright statement anywhere, and Apache-2.0 section 4(d) obliges
# redistributors to reproduce a file that does not exist.
[ -s "${tree}/NOTICE" ] ||
  die "no NOTICE in the ${tag} tree. LICENSE is the verbatim Apache text, so NOTICE is the only
       place the copyright is stated."
grep -qi 'copyright' "${tree}/NOTICE" ||
  die "NOTICE in ${tag} states no copyright."
note "NOTICE: $(grep -i -m1 'copyright' "${tree}/NOTICE")"

# package.json must agree with the file beside it. Disagreement is what tooling and downstream
# scanners read, and they read the metadata, not the text.
declared="$(sed -n 's/.*"license": *"\([^"]*\)".*/\1/p' "${tree}/package.json" | head -1)"
[ "$declared" = 'Apache-2.0' ] ||
  die "package.json in ${tag} declares license \"${declared}\" while LICENSE is Apache-2.0."
note "package.json license: ${declared}"

printf '\n== the tree that would be published ==\n'
files="$(find "$tree" -type f | wc -l)"
note "${files} files, $(du -sh "$tree" | cut -f1), from ${tag}"
note 'top level:'
(cd "$tree" && ls -A) | sed 's/^/    /'

printf '\n== denylist ==\n'
# Paths that must never reach a public repository. Extensions are matched on the tree being
# published, not on the working directory, so an ignored-but-tracked file cannot slip through.
denied=0

# THE ALTERNATIVES ARE PARENTHESISED, AND THAT IS THE WHOLE BUG THIS FUNCTION ONCE HAD.
# `find . -name a -o -name b -o -name c -print` does NOT print every match: `-print` binds to
# the last alternative only, so it means `a -o b -o (c -a -print)`. The first version of this
# denylist was written that way and a `signing.pem` containing a private key sailed through to
# the dry run, because only the final pattern in the list could ever be reported. Every match
# after the first pattern was found and silently dropped.
#
# Building one parenthesised OR group and appending `-print` outside it is the fix. `*.example`
# is excluded once, here, so a checked-in `*.env.example` or `*.pem.example` stays publishable
# without each caller having to remember.
deny_names() {
  local description="$1"
  shift
  local expression=()
  local pattern
  for pattern in "$@"; do
    [ ${#expression[@]} -eq 0 ] || expression+=(-o)
    expression+=(-name "$pattern")
  done
  local hits
  hits="$(cd "$tree" && find . \( "${expression[@]}" \) -not -name '*.example' -print 2>/dev/null |
    sed 's|^\./||' || true)"
  if [ -n "$hits" ]; then
    printf '  DENIED (%s):\n' "$description"
    printf '%s\n' "$hits" | sed 's/^/    /'
    denied=1
  fi
}

deny_paths() {
  local description="$1"
  shift
  local expression=()
  local pattern
  for pattern in "$@"; do
    [ ${#expression[@]} -eq 0 ] || expression+=(-o)
    expression+=(-path "$pattern")
  done
  local hits
  hits="$(cd "$tree" && find . \( "${expression[@]}" \) -print 2>/dev/null | sed 's|^\./||' || true)"
  if [ -n "$hits" ]; then
    printf '  DENIED (%s):\n' "$description"
    printf '%s\n' "$hits" | sed 's/^/    /'
    denied=1
  fi
}

# Deny a file for what it CONTAINS, for the ones whose name alone proves nothing.
deny_content() {
  local description="$1" filename="$2" pattern="$3"
  local hits
  hits="$(cd "$tree" && grep -rlE "$pattern" --include="$filename" . 2>/dev/null |
    sed 's|^\./||' || true)"
  if [ -n "$hits" ]; then
    printf '  DENIED (%s):\n' "$description"
    printf '%s\n' "$hits" | sed 's/^/    /'
    denied=1
  fi
}

deny_paths 'internal scratch and release staging' './.omo*' './release/*'
deny_names 'environment file' '*.env' '.env' '.env.*'
deny_names 'private key material' '*.pem' '*.key' '*.p12' '*.pfx' 'id_rsa*' 'id_ed25519*'
deny_names 'credential store' '*.kdbx' '.netrc' '.pgpass'

# `.npmrc` IS NOT DENIED BY NAME, and the first version of this list got that wrong: it denied
# every `.npmrc` and therefore denied this repository's own, which is tracked, public and holds
# nothing but registry and peer-dependency settings. A denylist that fires on a legitimate file
# is not cautious, it is a rule people learn to override — and the override is what publishes the
# next one. An `.npmrc` becomes a credential store when it carries a token, so that is the test.
deny_content 'npm credentials in .npmrc' '.npmrc' '_(authToken|auth|password)[[:space:]]*='

[ "$denied" -eq 0 ] || die 'denylisted paths are present in the tree (listed above).'
note 'no denylisted paths'

printf '\n== gitleaks over the tree being published ==\n'
# The TREE's config, not the working directory's, for the same reason as the licence: the
# allowlists that belong to a release are the ones shipped in it. A release whose config was
# written later has not been scanned under the policy it was released with.
config_arg=()
[ -f "${tree}/.gitleaks.toml" ] && config_arg=(--config "${tree}/.gitleaks.toml")
if ! gitleaks dir --no-banner --redact "${config_arg[@]}" "$tree"; then
  die 'gitleaks found something in the tree that would be published.'
fi
note 'clean'

printf '\n== what a human still has to judge ==\n'
# Deliberately not automated. The plan asks to exclude "anything under dogfood/ naming a real
# person", and no pattern decides that. Listing beats a check that would quietly pass.
if [ -d "${tree}/dogfood" ]; then
  note 'dogfood/ is in the tree. Read these for real names before publishing:'
  (cd "$tree" && find dogfood -type f | sort) | sed 's/^/    /'
else
  note 'no dogfood/ directory in the tree'
fi
note 'Commit messages are NOT published — the public repository gets one squashed commit — but'
note 'file contents are. Comments, fixtures and docs carry names as readily as a directory does.'

if [ "$publish" != true ]; then
  printf '\n== DRY RUN ==\n'
  note 'Nothing was pushed. Every precondition above passed.'
  note "To publish: $0 --remote ${remote} --tag ${tag} --publish"
  exit 0
fi

printf '\n== publish ==\n'
note "About to create ONE commit containing the tree above and push it to:"
note "    ${resolved_remote}  ->  refs/heads/main"
note 'This is public and permanent. Published bytes cannot be unpublished.'
printf '\nType the tag (%s) to confirm: ' "$tag"
read -r confirmation
[ "$confirmation" = "$tag" ] || die 'confirmation did not match; nothing was pushed.'

pub="${work}/pub"
mkdir -p "$pub"
cp -a "${tree}/." "$pub/"
cd "$pub"
git init --quiet --initial-branch=main
git add -A
# The tag's own date and tagger, so the public commit carries the release's provenance rather
# than the moment somebody happened to run this script.
GIT_AUTHOR_DATE="$(git -C "$root" log -1 --format=%aI "$commit")" \
  GIT_COMMITTER_DATE="$(git -C "$root" log -1 --format=%cI "$commit")" \
  git commit --quiet -m "Knowledge Fabric ${tag}" \
  -m "Squashed release of ${tag} (${commit}). Development history is not public."
git remote add public "$resolved_remote"
# One branch, one ref. No --all, no --tags, no --force, no --mirror.
git push public main:main

printf '\npublished %s to %s\n' "$tag" "$resolved_remote"
note 'Verify with a fresh clone: git log --oneline should show exactly one commit.'
