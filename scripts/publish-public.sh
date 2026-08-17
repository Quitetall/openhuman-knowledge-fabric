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
# Usage:
#   scripts/publish-public.sh --remote git@github.com:<org>/knowledge-fabric.git [--tag v1.0.0]
#   scripts/publish-public.sh --remote ... --tag v1.0.0 --publish

set -euo pipefail

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
trap 'rm -rf "$work"' EXIT
tree="${work}/tree"
mkdir -p "$tree"
git archive "$tag" | tar -x -C "$tree"

# The licence is a precondition rather than a reminder. BUSL-1.1 has four fields that must be
# filled in — Licensor, Licensed Work, Change Date, Change License — and a repository published
# without a licence is, by default, all-rights-reserved with no grant to anybody.
[ -s "${tree}/LICENSE" ] ||
  die "no LICENSE in the ${tag} tree. Nothing may be published before the licence is decided."
if grep -q '"license": *"UNLICENSED"' "${tree}/package.json"; then
  die "package.json in ${tag} still declares \"UNLICENSED\" while a LICENSE exists. Make them agree."
fi
for field in 'Licensor' 'Licensed Work' 'Change Date' 'Change License'; do
  grep -q "^${field}:" "${tree}/LICENSE" ||
    die "LICENSE has no '${field}:' line — BUSL-1.1 requires it."
  value="$(sed -n "s/^${field}: *//p" "${tree}/LICENSE" | head -1)"
  [ -n "$value" ] || die "LICENSE leaves '${field}:' blank."
  case "$value" in
    *'<'* | *'TODO'* | *'TBD'*) die "LICENSE '${field}:' is still a placeholder: ${value}" ;;
  esac
  note "LICENSE ${field}: ${value}"
done

printf '\n== the tree that would be published ==\n'
files="$(find "$tree" -type f | wc -l)"
note "${files} files, $(du -sh "$tree" | cut -f1), from ${tag}"
note 'top level:'
(cd "$tree" && ls -A) | sed 's/^/    /'

printf '\n== denylist ==\n'
# Paths that must never reach a public repository. Extensions are matched on the tree being
# published, not on the working directory, so an ignored-but-tracked file cannot slip through.
denied=0
check_deny() {
  local description="$1"
  shift
  local hits
  hits="$(cd "$tree" && find . "$@" -print 2>/dev/null | sed 's|^\./||' || true)"
  if [ -n "$hits" ]; then
    printf '  DENIED (%s):\n' "$description"
    printf '%s\n' "$hits" | sed 's/^/    /'
    denied=1
  fi
}
check_deny 'internal review scratch' -path './.omo*'
check_deny 'release staging directory' -path './release/*'
check_deny 'environment file that is not an example' \
  -name '*.env' -not -name '*.example'
check_deny 'dotenv file that is not an example' \
  -name '.env' -o -name '.env.*' -not -name '*.example'
check_deny 'private key material' \
  -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' -o -name '*.p12' -o -name '*.pfx'
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
