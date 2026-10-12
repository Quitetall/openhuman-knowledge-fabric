# shellcheck shell=bash
#
# Semantic search on the host's CPU (ADR 0039 decision 5), installed by provision-host.sh, which
# sources this file and calls ensure_retrieval. It uses that script's MODE, PREFIX, RELEASE, NODE,
# p(), owner_uid(), env_value() and its created/pending/human report; it is not a command.
#
# WHY IT EXISTS. Until 2026-10-11 nothing installed the embedder or the engine on a host, and
# `provision-host.sh --check` listed /etc/kf/retrieval-runtime.json for ever (SAS §100.66). Every
# piece the startup contract (docs/deployment/retrieval-startup.md) names is installed here, each
# only from bytes that match a pin in deploy/retrieval/, and the contract is rendered only when
# all of them verify:
#
#   the engine     LAMU, whose sha256 retrieval.release pins, from /var/lib/kf/retrieval-supply/lamu
#                  (or a pinned URL, when one exists), at /usr/local/lib/kf-retrieval/lamu; then asked
#                  for every option the startup gives it, and refused when it lacks one
#   the runtime    Debian's Python 3.13 and exactly the hash-locked wheels, fetched by pip as the
#                  embedding account (or from /var/lib/kf/retrieval-supply/wheels, offline), assembled
#                  into a closed runtime under /opt/kf-runtimes, its imports tried as that account
#   the model      bge-m3 at the pinned revision: a prepared directory supplied in
#                  /var/lib/kf/retrieval-supply/bge-m3-f16, or the Hub files (supplied in
#                  .../bge-m3, else fetched) checked against bge-m3.sources and converted as the
#                  embedding account; accepted only when its SHA256SUMS is the one model.py pins
#   two contracts  /etc/kf/retrieval-key-release.json (the broker's policy) and
#                  /etc/kf/retrieval-runtime.json, from the release install-release.sh verified and
#                  the accounts provisioning made
#
# NOTHING AT RUNTIME. Every fetch is here, at installation, and checked against its digest before
# anything uses it; the units run with no network but their private loopback.
#
# THE INDEX KEY is never made or kept here. It arrives at each boot from the workstation's
# encrypted store by the credential handoff, exactly as docs/deployment/retrieval-key-release.md
# decides; until it has, --check lists it.

RETRIEVAL_PINS="$RELEASE/deploy/retrieval/retrieval.release"
RETRIEVAL_SOURCES="$RELEASE/deploy/retrieval/bge-m3.sources"
RETRIEVAL_SUPPLY=/var/lib/kf/retrieval-supply
RETRIEVAL_ENGINE=/usr/local/lib/kf-retrieval/lamu
RETRIEVAL_RUNTIMES=/opt/kf-runtimes
RETRIEVAL_CONFIG=/etc/kf/retrieval-runtime.json
RETRIEVAL_KEY_POLICY=/etc/kf/retrieval-key-release.json
RETRIEVAL_INDEX_KEY=/run/kf-workstation-credentials/current/retrieval-index-key
RETRIEVAL_DOC=docs/deployment/retrieval-installation.md
MODEL_FILES=(PROVENANCE.json config.json model.safetensors sentencepiece.bpe.model
  special_tokens_map.json tokenizer.json tokenizer_config.json)

sha_of() { sha256sum -- "$1" | cut -d' ' -f1; }
pin() { env_value "$RETRIEVAL_PINS" "$1"; }

# A fresh working directory for one build, on the host's disk (the model's source is 2.3 GB).
# Traversable, because the embedding account works in subdirectories of it; this script's umask
# (077) would otherwise make it root's alone.
retrieval_work() {
  local work
  mkdir -p -- "$(p /var/tmp)"
  work="$(mktemp -d -p "$(p /var/tmp)" kf-retrieval-install.XXXXXX)"
  chmod 0755 "$work"
  printf '%s' "$work"
}

# As the embedding account, with nothing inherited: what pip fetches and what converts the model
# never run as root.
as_embedding() {
  runuser -u kf-embedding -- env -i PATH=/usr/bin:/bin LANG=C.UTF-8 HOME=/nonexistent "$@"
}

# The release's verified manifest digest, as install-release.sh recorded it.
retrieval_release() {
  local name record digest
  R_RELEASE_DIR="$(readlink -f -- "$RELEASE")"
  name="$(basename -- "$R_RELEASE_DIR")"
  record="$(p /opt/.kf-install)/$name.verified"
  digest="$(env_value "$record" manifest_sha256)"
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    human "/opt/.kf-install/$name.verified" "install this release with install-release.sh: the retrieval startup and its key broker pin the manifest digest it verified, and this release has none recorded"
    R_RELEASE_SHA=""
    return 1
  fi
  R_RELEASE_SHA="$digest"
}

# Every option the startup contract passes the engine, from the contract's own module.
engine_options() {
  "$NODE" --input-type=module -e '
    const { engineArguments } = await import(process.argv[1]);
    const sample = { releaseManifestSha256: "0".repeat(64), modelIdentity: "m", embeddingPort: 1, allowedPeerUids: [1] };
    process.stdout.write(engineArguments(sample).filter((a) => a.startsWith("--")).join("\n"));
  ' "$RELEASE/scripts/retrieval/config.mjs"
}

# Ask a candidate engine, as the engine's own account, for its serve options; name what it lacks.
engine_lacks() {
  local engine="$1" help option options missing=()
  # No options read is a refusal, never a vacuous pass.
  options="$(engine_options 2>/dev/null || true)"
  if [ -z "$options" ]; then printf '%s' "(the startup's options, which scripts/retrieval/config.mjs could not list)"; return 0; fi
  help="$(runuser -u kf-retrieval -- env -i PATH=/usr/bin:/bin HOME=/nonexistent \
    LAMU_SETTINGS=/nonexistent/kf-retrieval-settings "$engine" kf-retrieval serve --help 2>&1 || true)"
  while IFS= read -r option; do
    [ -n "$option" ] || continue
    grep -qE -- "(^|[^a-z-])${option}([^a-z-]|$)" <<< "$help" || missing+=("$option")
  done <<< "$options"
  printf '%s' "${missing[*]:-}"
}

retrieval_engine() {
  local arch sha url commit actual supplied origin work missing
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    *) human "$RETRIEVAL_ENGINE" "no pinned LAMU engine for $(uname -m) in deploy/retrieval/retrieval.release"; return 1 ;;
  esac
  sha="$(pin "LAMU_SHA256_$arch")"
  url="$(pin "LAMU_URL_$arch")"
  commit="$(pin LAMU_COMMIT)"
  actual="$(p "$RETRIEVAL_ENGINE")"
  supplied="$(p "$RETRIEVAL_SUPPLY/lamu")"
  if [ -f "$actual" ] && [ "$(sha_of "$actual")" = "$sha" ]; then
    if getent passwd kf-retrieval >/dev/null; then
      missing="$(engine_lacks "$actual")"
      if [ -n "$missing" ]; then
        human "$RETRIEVAL_ENGINE" "the installed engine (LAMU ${commit:0:8}) has no $missing, which the startup gives it (scripts/retrieval/config.mjs): it cannot take its key from the KF key-release socket. Pin a LAMU build that has them in deploy/retrieval/retrieval.release ($RETRIEVAL_DOC)"
        return 1
      fi
    fi
    return 0
  fi
  if [ -f "$supplied" ]; then
    origin="$supplied"
  elif [ -n "$url" ]; then
    origin=""
  else
    human "$RETRIEVAL_SUPPLY/lamu" "the LAMU engine built from ${commit:0:8} (sha256 $sha), placed here by a person: LAMU publishes no release artifact. provision-host.sh checks it and installs it at $RETRIEVAL_ENGINE"
    return 1
  fi
  if [ -n "$origin" ] && [ "$(sha_of "$origin")" != "$sha" ]; then
    human "$RETRIEVAL_SUPPLY/lamu" "REFUSED: it is not the pinned LAMU engine ${commit:0:8} (sha256 $sha)"
    return 1
  fi
  if [ "$MODE" = check ]; then
    pending "LAMU engine ${commit:0:8} at $RETRIEVAL_ENGINE, from ${origin:-$url}"
    return 2
  fi
  work="$(retrieval_work)"
  if [ -z "$origin" ]; then
    if ! curl --silent --show-error --fail --location --proto '=https,file' --max-time 600 \
        --output "$work/lamu" "$url" 2>"$work/error"; then
      human "$RETRIEVAL_ENGINE" "the LAMU engine could not be fetched from $url ($(head -c 200 "$work/error"))"
      rm -rf -- "$work"
      return 1
    fi
    if [ "$(sha_of "$work/lamu")" != "$sha" ]; then
      human "$RETRIEVAL_ENGINE" "REFUSED: the engine fetched from $url is not the pinned one (sha256 $sha)"
      rm -rf -- "$work"
      return 1
    fi
    origin="$work/lamu"
  fi
  # Staged beside its final path, root-owned and executable, and asked for its options before it
  # replaces anything: an engine the startup cannot start is not installed.
  install -d -m 0755 -- "$(dirname -- "$actual")"
  install -m 0755 -- "$origin" "$actual.staged"
  chown root:root "$actual.staged"
  if [ "$(sha_of "$actual.staged")" != "$sha" ]; then
    human "$RETRIEVAL_ENGINE" "REFUSED: the staged copy changed while it was installed"
    rm -f -- "$actual.staged"
    rm -rf -- "$work"
    return 1
  fi
  missing="$(engine_lacks "$actual.staged")"
  rm -rf -- "$work"
  if [ -n "$missing" ]; then
    rm -f -- "$actual.staged"
    human "$RETRIEVAL_ENGINE" "REFUSED: the pinned engine (LAMU ${commit:0:8}) has no $missing, which the startup gives it (scripts/retrieval/config.mjs): it cannot take its key from the KF key-release socket. Pin a LAMU build that has them in deploy/retrieval/retrieval.release ($RETRIEVAL_DOC)"
    return 1
  fi
  mv -f -- "$actual.staged" "$actual"
  created "LAMU engine ${commit:0:8} at $RETRIEVAL_ENGINE (sha256 $sha)"
}

# The configured runtime, when the contract names one and it still verifies against its pin.
configured_runtime() {
  local config
  config="$(p "$RETRIEVAL_CONFIG")"
  [ -f "$config" ] || return 1
  "$NODE" -e '
    const c = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    if (typeof c.pythonRuntimeDirectory !== "string" || !/^[0-9a-f]{64}$/.test(c.pythonRuntimeManifestSha256 ?? "")) process.exit(1);
    process.stdout.write(c.pythonRuntimeDirectory + "\n" + c.pythonRuntimeManifestSha256);
  ' "$config" 2>/dev/null
}

retrieval_runtime() {
  local found python stdlib lock work wheels dest sha stamp
  if found="$(configured_runtime)"; then
    R_RUNTIME_DIR="$(head -n 1 <<< "$found")"
    R_RUNTIME_SHA="$(tail -n 1 <<< "$found")"
    if "$NODE" "$RELEASE/scripts/embedding/verify-runtime.mjs" "$(p "$R_RUNTIME_DIR")" \
        "$R_RUNTIME_SHA" >/dev/null 2>&1; then
      return 0
    fi
    human "$R_RUNTIME_DIR" "the embedding runtime /etc/kf/retrieval-runtime.json names no longer verifies against its pin (a changed file, or a host library updated under it): move it aside and re-run provision-host.sh, which builds a new one"
    return 1
  fi
  python="$(p "$(pin EMBEDDING_PYTHON)")"
  stdlib="$(p "$(pin EMBEDDING_STDLIB)")"
  lock="$RELEASE/$(pin EMBEDDING_LOCK)"
  if [ ! -x "$python" ] || [ ! -d "$stdlib" ] || ! "$python" -I -m pip --version >/dev/null 2>&1; then
    human "$(pin EMBEDDING_PYTHON)" "Python 3.13 with pip, from which the embedding runtime is built (Debian 13: apt-get install python3 python3-pip)"
    return 1
  fi
  wheels="$(p "$RETRIEVAL_SUPPLY/wheels")"
  if [ "$MODE" = check ]; then
    if [ -d "$wheels" ]; then
      pending "embedding runtime under $RETRIEVAL_RUNTIMES, from the hash-locked wheels supplied in $RETRIEVAL_SUPPLY/wheels"
    else
      pending "embedding runtime under $RETRIEVAL_RUNTIMES, from the wheels $(pin EMBEDDING_LOCK) pins (fetched, each checked against its sha256)"
    fi
    return 2
  fi
  work="$(retrieval_work)"
  install -d -m 0755 -- "$work/site" "$work/tmp"
  chown kf-embedding:kf-embedding "$work/site" "$work/tmp"
  local offline=()
  if [ -d "$wheels" ]; then offline=(--no-index --find-links "$wheels"); fi
  # The lock carries its index URLs; --no-index overrides them for a supplied wheelhouse.
  # Its own temporary directory: pip unpacks the torch wheel there, and /tmp may be a small tmpfs.
  if ! as_embedding TMPDIR="$work/tmp" "$python" -I -m pip install --quiet --disable-pip-version-check --no-cache-dir \
      --no-deps --require-hashes --only-binary=:all: --no-compile --target "$work/site" \
      "${offline[@]}" -r "$lock" >"$work/pip.log" 2>&1; then
    human "$(pin EMBEDDING_LOCK)" "its wheels could not be installed, or one did not match its sha256: $(grep -m1 -E 'ERROR|THESE PACKAGES' "$work/pip.log" | head -c 300)"
    rm -rf -- "$work"
    return 1
  fi
  install -d -m 0755 -- "$(p "$RETRIEVAL_RUNTIMES")"
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="$RETRIEVAL_RUNTIMES/embedding-$(sha_of "$lock" | cut -c1-12)-$stamp"
  if ! sha="$("$NODE" "$RELEASE/scripts/embedding/assemble-runtime.mjs" "$python" "$stdlib" \
      "$work/site" "$(p "$dest")" 2>/dev/null)" || [[ ! "$sha" =~ ^[0-9a-f]{64}$ ]]; then
    human "$dest" "the embedding runtime could not be assembled (scripts/embedding/assemble-runtime.mjs refused it); what it left is kept for inspection and never used"
    rm -rf -- "$work"
    return 1
  fi
  rm -rf -- "$work"
  # The provider's own imports, in the assembled interpreter, as the provider's account: a wheel
  # this CPU or this host's libraries cannot load is found here, not at the first search.
  if ! as_embedding "$(p "$dest")/bin/python3.13" -I -S -c \
      'import sys; sys.path.insert(0, sys.argv[1]); import numpy, safetensors, tokenizers, torch, transformers' \
      "$(p "$dest")/lib/python3.13/site-packages" >/dev/null 2>&1; then
    human "$dest" "the assembled embedding runtime cannot import its packages on this host (numpy, torch, transformers): see docs/deployment/embedding-runtime.md on the CPU baseline"
    return 1
  fi
  if ! "$NODE" "$RELEASE/scripts/embedding/verify-runtime.mjs" "$(p "$dest")" "$sha" >/dev/null 2>&1; then
    human "$dest" "the assembled embedding runtime does not verify against the digest its assembly printed"
    return 1
  fi
  R_RUNTIME_DIR="$dest"
  R_RUNTIME_SHA="$sha"
  created "embedding runtime $dest (manifest sha256 $sha)"
}

# A model directory that is exactly the pinned closed file set, root-owned and not writable by
# anyone else (scripts/embedding/model.py refuses anything else at startup).
model_verified() {
  local dir="$1" root expected name
  [ -d "$dir" ] || return 1
  root="$(owner_uid root || true)"
  expected="$(printf '%s\n' "${MODEL_FILES[@]}" SHA256SUMS | LC_ALL=C sort)"
  [ "$(cd -- "$dir" && LC_ALL=C ls -A)" = "$expected" ] || return 1
  for name in . "${MODEL_FILES[@]}" SHA256SUMS; do
    [ "$(stat -c '%u' -- "$dir/$name")" = "$root" ] || return 1
    [ $((8#$(stat -c '%a' -- "$dir/$name") & 8#022)) -eq 0 ] || return 1
  done
  [ "$(sha_of "$dir/SHA256SUMS")" = "$(pin MODEL_MANIFEST_SHA256)" ] || return 1
  (cd -- "$dir" && sha256sum --check --strict --quiet SHA256SUMS >/dev/null 2>&1)
}

retrieval_model() {
  local runtime="$1" dir actual prepared sources work name url
  dir="$(pin MODEL_DIRECTORY)"
  actual="$(p "$dir")"
  if model_verified "$actual"; then R_MODEL_DIR="$dir"; return 0; fi
  if [ -e "$actual" ]; then
    human "$dir" "is not the pinned model (SHA256SUMS sha256 $(pin MODEL_MANIFEST_SHA256), every file root-owned): move it aside; provision-host.sh then rebuilds it"
    return 1
  fi
  prepared="$(p "$RETRIEVAL_SUPPLY/bge-m3-f16")"
  sources="$(p "$RETRIEVAL_SUPPLY/bge-m3")"
  # Converting needs the runtime; while a person must supply what the runtime needs, that entry
  # says so and this one waits.
  if [ ! -d "$prepared" ] && [ "$runtime" = 1 ]; then return 1; fi
  if [ "$MODE" = check ]; then
    if [ -d "$prepared" ]; then
      pending "bge-m3 model at $dir, from the prepared files in $RETRIEVAL_SUPPLY/bge-m3-f16"
    elif [ -d "$sources" ]; then
      pending "bge-m3 model at $dir, converted from the Hub files supplied in $RETRIEVAL_SUPPLY/bge-m3 (each checked against deploy/retrieval/bge-m3.sources)"
    else
      pending "bge-m3 model at $dir, converted from the Hub files deploy/retrieval/bge-m3.sources pins (fetched, each checked against its sha256)"
    fi
    return 2
  fi
  work="$(retrieval_work)"
  install -d -m 0755 -- "$work/out"
  if [ -d "$prepared" ]; then
    for name in "${MODEL_FILES[@]}"; do
      [ -f "$prepared/$name" ] && cp -- "$prepared/$name" "$work/out/$name"
    done
  else
    if [ -z "$R_RUNTIME_DIR" ]; then
      rm -rf -- "$work"
      return 1 # The runtime's own entry says why; the model is converted with it.
    fi
    install -d -m 0755 -- "$work/src"
    url="$(pin MODEL_SOURCE_URL)"
    while read -r _ name; do
      if [ -f "$sources/$name" ]; then
        cp -- "$sources/$name" "$work/src/$name"
      elif ! curl --silent --show-error --fail --location --proto '=https,file' --max-time 3600 \
          --output "$work/src/$name" "$url/$name" 2>"$work/error"; then
        human "$dir" "the Hub file $name could not be fetched from $url ($(head -c 200 "$work/error")); or place the pinned files in $RETRIEVAL_SUPPLY/bge-m3"
        rm -rf -- "$work"
        return 1
      fi
    done < "$RETRIEVAL_SOURCES"
    chmod 0644 -- "$work/src"/*
    if ! (cd -- "$work/src" && sha256sum --check --strict --quiet "$RETRIEVAL_SOURCES" >/dev/null 2>&1); then
      human "$dir" "REFUSED: a bge-m3 source file is not the one deploy/retrieval/bge-m3.sources pins"
      rm -rf -- "$work"
      return 1
    fi
    chown kf-embedding:kf-embedding "$work/out"
    if ! as_embedding "$(p "$R_RUNTIME_DIR")/bin/python3.13" -I -S \
        "$RELEASE/scripts/embedding/prepare-model.py" \
        "$(p "$R_RUNTIME_DIR")/lib/python3.13/site-packages" "$work/src" "$work/out" \
        >"$work/prepare.log" 2>&1; then
      human "$dir" "converting bge-m3 failed ($(tail -n 1 "$work/prepare.log" | head -c 200))"
      rm -rf -- "$work"
      return 1
    fi
  fi
  (cd -- "$work/out" && LC_ALL=C sha256sum -- $(printf '%s\n' "${MODEL_FILES[@]}" | LC_ALL=C sort)) \
    > "$work/SHA256SUMS" 2>/dev/null || true
  if [ "$(sha_of "$work/SHA256SUMS")" != "$(pin MODEL_MANIFEST_SHA256)" ]; then
    human "$dir" "REFUSED: the prepared model is not the pinned one (its SHA256SUMS is not sha256 $(pin MODEL_MANIFEST_SHA256))"
    rm -rf -- "$work"
    return 1
  fi
  install -d -m 0755 -- "$(dirname -- "$actual")"
  install -d -m 0755 -- "$actual.staged"
  for name in "${MODEL_FILES[@]}"; do install -m 0644 -- "$work/out/$name" "$actual.staged/$name"; done
  install -m 0644 -- "$work/SHA256SUMS" "$actual.staged/SHA256SUMS"
  chown -R root:root "$actual.staged"
  rm -rf -- "$work"
  if ! model_verified "$actual.staged"; then
    human "$dir" "REFUSED: the installed copy of the model did not verify"
    rm -rf -- "$actual.staged"
    return 1
  fi
  mv -T -- "$actual.staged" "$actual"
  R_MODEL_DIR="$dir"
  created "bge-m3 model $dir (SHA256SUMS sha256 $(pin MODEL_MANIFEST_SHA256))"
}

# Write a non-secret root-owned 0644 contract when it differs; report it in --check.
retrieval_contract() {
  local path="$1" text="$2" what="$3" actual
  actual="$(p "$path")"
  [ "$(cat -- "$actual" 2>/dev/null || true)" != "$text" ] || return 0
  if [ "$MODE" = check ]; then pending "$path ($what)"; return 0; fi
  printf '%s\n' "$text" > "$actual.staged"
  chmod 644 "$actual.staged"
  chown root:root "$actual.staged"
  mv -f -- "$actual.staged" "$actual"
  created "$path ($what)"
}

ensure_retrieval() {
  local ok=1 engine_uid peers text
  R_RELEASE_DIR="" R_RELEASE_SHA="" R_RUNTIME_DIR="" R_RUNTIME_SHA="" R_MODEL_DIR=""
  if [ ! -f "$RETRIEVAL_PINS" ] || [ ! -f "$RETRIEVAL_SOURCES" ]; then
    human "$RETRIEVAL_CONFIG" "this release carries no deploy/retrieval pins, so semantic search cannot be installed from it"
    return 0
  fi
  # 0 installed, 1 waiting on a person (a `human` entry says what), 2 provisioning does it.
  local release=0 engine=0 runtime=0 model=0
  retrieval_release || release=$?
  retrieval_engine || engine=$?
  retrieval_runtime || runtime=$?
  retrieval_model "$runtime" || model=$?
  [ "$release$engine$runtime$model" = 0000 ] || ok=0

  # The broker releases the index key to exactly the engine's account, for exactly this release.
  engine_uid="$(owner_uid kf-retrieval || true)"
  if [ -n "$R_RELEASE_SHA" ] && [ -n "$engine_uid" ]; then
    retrieval_contract "$RETRIEVAL_KEY_POLICY" \
      "{\"allowedUid\": $engine_uid, \"releaseDirectory\": \"$R_RELEASE_DIR\", \"releaseManifestSha256\": \"$R_RELEASE_SHA\"}" \
      "the key broker's policy: kf-retrieval, this release"
  else
    ok=0
  fi

  # The API and the worker are the engine's only peers (ensure_retrieval_group admits them to
  # its socket directory; this admits them to the socket).
  peers="$(owner_uid kf-api || true),$(owner_uid kf-worker || true)"
  [[ "$peers" =~ ^[0-9]+,[0-9]+$ ]] || ok=0
  if [ "$ok" = 1 ]; then
    if ! text="$("$NODE" --input-type=module -e '
        const { parseConfig } = await import(process.argv[1]);
        const [release, releaseSha, engine, engineSha, runtime, runtimeSha, model, identity, port, peers] = process.argv.slice(2);
        const config = {
          format: "kf-retrieval-startup-v1",
          releaseDirectory: release,
          releaseManifestSha256: releaseSha,
          enginePath: engine,
          engineSha256: engineSha,
          pythonRuntimeDirectory: runtime,
          pythonRuntimeManifestSha256: runtimeSha,
          modelDirectory: model,
          modelIdentity: identity,
          embeddingPort: Number(port),
          allowedPeerUids: [...new Set(peers.split(",").map(Number))],
        };
        const text = JSON.stringify(config, null, 2);
        parseConfig(text);
        process.stdout.write(text);
      ' "$RELEASE/scripts/retrieval/config.mjs" "$R_RELEASE_DIR" "$R_RELEASE_SHA" \
        "$RETRIEVAL_ENGINE" "$(pin LAMU_SHA256_amd64)" "$R_RUNTIME_DIR" "$R_RUNTIME_SHA" \
        "$R_MODEL_DIR" "$(pin MODEL_IDENTITY)" "$(pin EMBEDDING_PORT)" "$peers" 2>/dev/null)"; then
      human "$RETRIEVAL_CONFIG" "could not be rendered: the startup contract (scripts/retrieval/config.mjs) refused the pinned values"
    else
      retrieval_contract "$RETRIEVAL_CONFIG" "$text" "the retrieval startup contract"
    fi
  elif [ ! -f "$(p "$RETRIEVAL_CONFIG")" ] && [[ "$release$engine$runtime$model" != *1* ]]; then
    # Nothing waits on a person: provisioning installs every piece, then renders this. When one
    # does wait, its own entry says what to supply, and this adds nothing to it.
    pending "$RETRIEVAL_CONFIG: semantic search, rendered once the engine, runtime and model are installed ($RETRIEVAL_DOC)"
  fi

  if [ ! -e "$(p "$RETRIEVAL_INDEX_KEY")" ]; then
    human "$RETRIEVAL_INDEX_KEY" "the retrieval index key, delivered at each boot from the workstation's encrypted store by the credential handoff (docs/deployment/retrieval-key-release.md); never made or kept on this host. The engine starts when it arrives (kf-retrieval-credentials.path)"
  fi
}
