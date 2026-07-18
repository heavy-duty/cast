#!/usr/bin/env bash
set -euo pipefail

# cast installer — intended for: curl -fsSL .../install.sh | bash
#
# Fetches a cast tree and installs it into the VERSIONED layout under $DEST
# (box#79's layout, ported the way rig#36 ported it):
#
#   $DEST/versions/<version>/    one full tree per installed version
#   $DEST/current -> versions/<version>        the default version
#   $BINDIR/cast  -> $DEST/current/bin/cast    the PATH entry
#
# Versions install side by side: `cast versions` lists them, `cast use <v>`
# switches the default, `cast uninstall` removes them. Re-running with an
# already-installed version is a converging no-op (CAST_REINSTALL=1 replaces
# that version's tree); a NEW version installs beside the old one and becomes
# the default. cast neither refuses nor warns where box refuses and rig
# warns: box protects live boxes and rig a converged host, but cast is an
# API client — flipping its version strands nothing on this machine, and
# `cast use <old>` is always one command away. A pre-versioning flat tree is
# migrated in place, so upgrading is seamless.
#
# The version IS the tree's package.json version — cast's single source of
# truth (deliberately no separate VERSION file).
#
# WHICH tree, and whether it is built here, is the channel's business — three
# channels from this one script (#96; box#83's design, plus the piece unique
# to cast: the PREBUILT release asset, because cast is the one repo where the
# source tarball is not the package):
#
#   CAST_REF unset      the latest RELEASE — the tag is resolved from the
#                       releases/latest redirect, the download is that
#                       release's prebuilt cast-<tag>.tgz asset (bin/,
#                       compiled dist/, production node_modules/): no npm,
#                       no tsc, no devDependencies on this machine
#   CAST_REF=<tag>      that release, pinned — its asset first, source as
#                       the fallback for a ref that has none
#   CAST_REF=<branch>   the development tree, built from source here —
#                       CAST_REF=main is the dev channel, and (with local
#                       source installs) the one place npm is required
#
# Whatever the channel fetched still lands the same way: in versions/<its
# package.json version>, with the current symlink flipped atomically.
#
# CAST_INSTALL_SOURCE=<dir-or-tarball> installs from a local tree instead of
# downloading — for CI and the test suite, so what lands is the code under
# review.
#
# Unlike rig (pure bash, runs on bare boxes), cast runs on YOUR machine and
# needs node — it is an API client, never something a server installs.

REPO="${CAST_REPO:-heavy-duty/cast}"
REF="${CAST_REF:-}" # empty = the latest release, resolved below
DEST="${CAST_HOME:-$HOME/.local/share/cast}"
if [ "$(id -u)" -eq 0 ]; then
  BINDIR="${CAST_BIN:-/usr/local/bin}"
else
  BINDIR="${CAST_BIN:-$HOME/.local/bin}"
fi

log() { printf 'cast-install: %s\n' "$*"; }
warn() { printf 'cast-install: WARNING: %s\n' "$*" >&2; }
die() { printf 'cast-install: ERROR: %s\n' "$*" >&2; exit 1; }

# A version is a DIRECTORY NAME under versions/ — nothing else. One strict
# gate for every caller that builds a path from one (the installer's new_ver,
# migration's flat_ver, and bin/cast's 'use'/single-version uninstall): only
# [A-Za-z0-9._+-], no leading '.' or '-'. That forbids '/', '..'-escapes,
# spaces and option-lookalikes by construction — a crafted version dies HERE,
# never in an rm -rf or an ln. bin/cast carries a byte-identical copy;
# test/install-sh.test.ts diffs the two so the gates cannot drift.
valid_version() {
  case "$1" in
    ''|.*|-*) return 1 ;;
    *[!A-Za-z0-9._+-]*) return 1 ;;
  esac
  return 0
}

# The tree's package.json version, or empty. Read via node (a prerequisite
# anyway) — never by regexing JSON. The path travels by env var, not by
# splicing it into the expression, so no filename can break the quoting.
pkg_version() {
  CAST_PKG_PATH="$1/package.json" node -p 'require(process.env.CAST_PKG_PATH).version' 2>/dev/null || true
}

# --- the release channels (#96; box#83's design, near-verbatim) --------------
# resolve_latest_tag <owner/repo> — print the latest RELEASE tag, resolved by
# following the releases/latest redirect and reading the Location header
# (curl's %{redirect_url} is that header, parsed): no API, no token, no
# rate-limit pain. A repo with no releases redirects to /releases — not to
# /releases/tag/<tag> — so this returns 1 there instead of inventing a ref,
# and the CALLER owns the loud story. test/release.test.ts drives the whole
# installer, this function included, against a stubbed curl.
resolve_latest_tag() {
  local loc
  loc="$(curl -fsSI -o /dev/null -w '%{redirect_url}' "https://github.com/$1/releases/latest")" || return 1
  case "$loc" in
    */releases/tag/?*) printf '%s\n' "${loc##*/releases/tag/}" ;;
    *) return 1 ;;
  esac
}

# --- prerequisites -----------------------------------------------------------
# curl only when something must be downloaded — a local CAST_INSTALL_SOURCE
# needs none, which is what lets the test suite drive REAL installs offline.
# npm is deliberately NOT required here: the release-asset channel installs a
# tree that was built once, in CI. build_tree checks for it, in the only
# paths that build (local source, and source downloads).
if [ -z "${CAST_INSTALL_SOURCE:-}" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is required but was not found."
fi
command -v tar  >/dev/null 2>&1 || die "tar is required but was not found."
command -v node >/dev/null 2>&1 || die "node >=22.12 is required but was not found."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >=22.12 is required (found $(node -v))."

# readlink -f is load-bearing across the layout (the launcher and every verb
# resolve the symlink chain with it). GNU always has it; Apple's readlink
# grew -f in macOS 12.3 (March 2022). Probe once and refuse loudly on the
# museum pieces, instead of failing weirdly mid-flip later.
readlink -f / >/dev/null 2>&1 \
  || die "this system's readlink does not support -f (macOS older than 12.3?) — upgrade, or 'brew install coreutils'."

# age is what decrypts the state repo's secrets — apply/diff shell out to it.
if ! command -v age >/dev/null 2>&1; then
  warn "age not found — 'cast apply' and 'cast diff' will fail until it is installed."
  warn "  Debian/Ubuntu: sudo apt install age | Arch: sudo pacman -S age"
  warn "  Fedora: sudo dnf install age | macOS: brew install age"
fi

# --- pick the channel --------------------------------------------------------
# No CAST_REF → the latest release. While no release exists (cast cuts its
# first, 0.1.0, right after #96 lands), this channel must FAIL, loudly and
# with the way out — never silently fall back to main: "I installed the
# latest release" must not quietly mean "I installed whatever main was that
# second". Resolved before anything on disk is touched (the flat-install
# migration included), so a refusal here has zero side effects.
if [ -n "${CAST_INSTALL_SOURCE:-}" ]; then
  SRCDESC="local source $CAST_INSTALL_SOURCE"
else
  if [ -z "$REF" ]; then
    log "resolving the latest release of $REPO"
    if ! REF="$(resolve_latest_tag "$REPO")"; then
      warn "could not resolve the latest release of $REPO — either no release exists yet, or GitHub was unreachable."
      warn "(cast has no release until 0.1.0 is cut — heavy-duty/cast#96. Until then, install the development tree explicitly.)"
      die "set CAST_REF: e.g.  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | CAST_REF=main bash"
    fi
    log "latest release: $REF"
  fi
  SRCDESC="$REPO@$REF"
fi

# Flip <root>/current to versions/<v> atomically: build the new link beside
# it, rename(2) over. Plain ln -sfn is unlink+create — a window where current
# names nothing and a concurrent 'cast' invocation dies mid-chain. The rename
# rides node's fs.renameSync because the coreutils spelling is not portable —
# GNU mv says "replace, don't descend" with -T, BSD/macOS says -h — while
# rename(2) itself is POSIX and node is a cast prerequisite on every
# platform. bin/cast carries a byte-identical copy; test/install-sh.test.ts
# diffs the two so they cannot drift.
flip_current() {   # $1 = install root, $2 = version
  ln -sfn "versions/$2" "$1/current.new.$$"
  CAST_FLIP_NEW="$1/current.new.$$" CAST_FLIP_CUR="$1/current" \
    node -e 'const fs = require("node:fs"); fs.renameSync(process.env.CAST_FLIP_NEW, process.env.CAST_FLIP_CUR);'
}

# --- migrate a pre-versioning flat install -----------------------------------
# The old installer put the tree FLAT at $DEST (bin/cast directly under it).
# Move such a tree to versions/<its-version> BEFORE anything else, so the
# upgrade is seamless and the version comparison below sees the truth. The
# move is two renames inside one parent directory — no copying, no window with
# no install — and the operator's tree is preserved bit for bit.
if [ -e "$DEST/bin/cast" ] && [ ! -d "$DEST/versions" ]; then
  flat_ver="$(pkg_version "$DEST")"
  [ -n "$flat_ver" ] || flat_ver="0.0.0-unknown"
  # The flat tree's version is data from disk, not from this installer — the
  # same trust boundary as the new_ver check, so the same gate: a corrupted
  # (or hostile) package.json must not steer the mv/ln below out of versions/.
  valid_version "$flat_ver" || die "the flat install's package.json version is not a sane directory name: '$flat_ver' — fix $DEST/package.json, then re-run"
  log "found a pre-versioning flat install at $DEST (version $flat_ver) — migrating it into the versioned layout"
  staging="$DEST.migrating.$$"
  mv "$DEST" "$staging"
  mkdir -p "$DEST/versions"
  mv "$staging" "$DEST/versions/$flat_ver"
  flip_current "$DEST" "$flat_ver"
  mkdir -p "$BINDIR"
  ln -sfn "$DEST/current/bin/cast" "$BINDIR/cast"
  log "migrated: it now lives at $DEST/versions/$flat_ver (still current)"
fi

# --- temp workspace ----------------------------------------------------------
TMPDIR="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# --- acquire the tree --------------------------------------------------------
PREBUILT="" # set when the tree came from a release asset (already built)
if [ -n "${CAST_INSTALL_SOURCE:-}" ]; then
  SRC="$CAST_INSTALL_SOURCE"
  INSTALLED_FROM="local:$SRC"
  if [ -d "$SRC" ]; then
    log "copying local tree $SRC"
    mkdir -p "$TMPDIR/tree"
    # tar, not cp -a: --exclude=.git so a working checkout never carries its
    # VCS state into the install tree, --exclude=./node_modules (top level
    # only — nested ones are npm's own business) because npm ci below builds
    # dependencies fresh from the lockfile anyway.
    tar -C "$SRC" --exclude=.git --exclude=./node_modules -cf - . | tar -xf - -C "$TMPDIR/tree"
    EXTRACTED="$TMPDIR/tree"
  elif [ -f "$SRC" ]; then
    log "extracting local tarball $SRC"
    tar -xzf "$SRC" -C "$TMPDIR" || die "failed to extract $SRC"
    EXTRACTED="$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  else
    die "CAST_INSTALL_SOURCE is set but is neither a directory nor a tarball: $SRC"
  fi
else
  log "installing cast ($REPO@$REF)"

  # A release's package is its PREBUILT asset (#96) — bin/, compiled dist/,
  # production node_modules/, package.json, built once by release.yml — so
  # the asset is tried first for every ref. Only a ref the OPERATOR named may
  # fall back to source: a resolved latest release without its asset is a
  # broken release, not a reason to start compiling here.
  ASSET_URL="https://github.com/$REPO/releases/download/$REF/cast-$REF.tgz"
  log "downloading $ASSET_URL"
  if curl -fsSL "$ASSET_URL" -o "$TMPDIR/cast.tgz"; then
    PREBUILT=1
    INSTALLED_FROM="$REPO@$REF (release asset)"
    log "extracting release asset"
    tar -xzf "$TMPDIR/cast.tgz" -C "$TMPDIR" \
      || die "failed to extract $ASSET_URL"
  else
    [ -n "${CAST_REF:-}" ] \
      || die "release $REF has no cast-$REF.tgz asset (or GitHub was unreachable) — refusing to build the release from source. Report the broken release, or pick a ref yourself: CAST_REF=<tag> pins one, CAST_REF=main builds the development tree."

    # The source fallback, tag first (the pin must win over a branch that
    # happens to share its name), branch second — which keeps CAST_REF=main
    # the dev channel. Source needs a build (build_tree below, the only
    # place npm is used).
    INSTALLED_FROM="$REPO@$REF"
    got=""
    for URL in "https://github.com/$REPO/archive/refs/tags/$REF.tar.gz" \
               "https://github.com/$REPO/archive/refs/heads/$REF.tar.gz"; do
      log "no prebuilt asset for '$REF' — trying source: $URL"
      if curl -fsSL "$URL" -o "$TMPDIR/cast.tar.gz"; then
        got="$URL"
        break
      fi
    done
    [ -n "$got" ] || die "failed to download $REPO@$REF — no release asset, and '$REF' is neither a tag nor a branch."

    log "extracting archive"
    tar -xzf "$TMPDIR/cast.tar.gz" -C "$TMPDIR" \
      || die "failed to extract archive"
  fi

  # GitHub names a source archive's top dir <repo>-<ref> and release.yml
  # stages the asset's as cast-<tag> — deriving either name is guesswork (it
  # broke for real at box's repo rename). Both tarball shapes have exactly
  # ONE top-level directory: take the directory, whatever it is called, and
  # let the bin/cast check below judge whether it is the right tree.
  EXTRACTED="$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -type d | head -n1)"
fi
[ -n "${EXTRACTED:-}" ] || die "could not find the source tree in $SRCDESC"
[ -f "$EXTRACTED/bin/cast" ] || die "source does not contain bin/cast — is $SRCDESC correct?"

# The tree's own package.json names the directory it lands in — the version
# IS the identity of what is being installed, and 'cast versions' lists
# these names.
new_ver="$(pkg_version "$EXTRACTED")"
[ -n "$new_ver" ] || die "source has no package.json version — cannot install it as a version"
valid_version "$new_ver" || die "the source's package.json version is not a sane directory name: '$new_ver'"

# Sanity-check a prebuilt asset BEFORE anything lands in $DEST: a runnable
# tree carries the compiled dist/ and its production node_modules/. Refusing
# here leaves whatever is already installed exactly as it was.
if [ -n "$PREBUILT" ]; then
  { [ -f "$EXTRACTED/dist/cli.js" ] && [ -d "$EXTRACTED/node_modules" ]; } \
    || die "the release asset is not a runnable cast tree (missing dist/ or node_modules/) — refusing to install it. Report the broken release, or build from source: CAST_REF=main."
fi

set_exec() {   # $1 = a cast tree: the executable bits install.sh owns
  chmod +x "$1/bin/cast"
  if [ -d "$1/scripts" ]; then
    find "$1/scripts" -name '*.sh' -exec chmod +x {} +
  fi
}

# Build the tree IN PLACE, in the temp workspace — deps + tsc, then drop the
# dev deps. Landing in versions/ happens after, by rename: a half-built tree
# never sits where the version chain can resolve to it. A PREBUILT release
# asset skips this whole step — that build already happened, once, in CI —
# which is also why npm is checked here and not with the prerequisites: the
# source paths are the only ones that need it.
build_tree() {   # $1 = the tree to build
  if [ -n "$PREBUILT" ]; then
    log "prebuilt release asset — nothing to build here"
    return 0
  fi
  command -v npm >/dev/null 2>&1 || die "npm is required to build cast from source (only the release-asset channel installs without it)."
  log "building (npm ci && npm run build)"
  ( cd "$1" && npm ci --silent && npm run build --silent ) \
    || die "build failed"
  ( cd "$1" && npm prune --omit=dev --silent ) || warn "could not prune dev dependencies"
}

# --- install into $DEST/versions/<version> -----------------------------------
VDIR="$DEST/versions/$new_ver"
newly_installed=0
if [ -d "$VDIR" ]; then
  if [ -n "${CAST_REINSTALL:-}" ]; then
    # Replace THIS version's tree, as atomically as two renames allow — never
    # a partial overlay of new files onto an old tree.
    log "CAST_REINSTALL=1 — replacing the installed $new_ver tree"
    build_tree "$EXTRACTED"
    stage="$VDIR.new.$$"; old="$VDIR.old.$$"
    rm -rf "$stage" "$old"
    set_exec "$EXTRACTED"
    mv "$EXTRACTED" "$stage"
    # Swap by renames, delete LAST: rm-then-move leaves a hole the whole
    # length of the delete where current -> this version resolves to nothing.
    mv "$VDIR" "$old"
    mv "$stage" "$VDIR"
    rm -rf "$old"
    printf '%s\n' "$INSTALLED_FROM" > "$VDIR/INSTALLED_FROM"
    log "reinstalled $new_ver"
  else
    cur_from="$(cat "$VDIR/INSTALLED_FROM" 2>/dev/null || echo '<unknown source>')"
    log "cast $new_ver is already installed ($cur_from) — nothing to do, and nothing was built."
    log "(CAST_REINSTALL=1 replaces this version's tree; 'cast versions' lists what is installed.)"
  fi
else
  build_tree "$EXTRACTED"
  log "installing $new_ver into $VDIR"
  mkdir -p "$DEST/versions"
  set_exec "$EXTRACTED"
  mv "$EXTRACTED" "$VDIR"
  newly_installed=1
  # Record WHAT was installed, so a caller can assert it got what it asked
  # for — an installer invoked with stale env vars silently falls back to the
  # defaults, and INSTALLED_FROM is how that lie gets caught.
  printf '%s\n' "$INSTALLED_FROM" > "$VDIR/INSTALLED_FROM"
fi

# --- which version is the default? -------------------------------------------
# 'current' is the tracked default; flipping it is the ONLY step that changes
# what an operator's `cast` runs. A fresh host (or a dangling current) is
# claimed outright; an upgrade flips, because a re-run that silently left you
# on the old version would make "re-run any time to upgrade" a lie. Judged
# from versions/<v> itself (readlink -f), never from what a wedged current
# claims.
cur="$(readlink -f "$DEST/current" 2>/dev/null || true)"
want="$(readlink -f "$VDIR")"
if [ -z "$cur" ] || [ ! -d "$cur" ]; then
  flip_current "$DEST" "$new_ver"
  log "default version: $new_ver"
elif [ "$cur" = "$want" ]; then
  : # already the default — nothing to flip
elif [ "$newly_installed" -eq 0 ]; then
  # A converge/no-op (or CAST_REINSTALL) of a version that is NOT the default
  # never moves the default — a re-run must change nothing; switching is
  # 'cast use', a deliberate act.
  log "the default stays $(basename "$cur") — 'cast use $new_ver' switches."
else
  old_ver="$(basename "$cur")"
  flip_current "$DEST" "$new_ver"
  log "default version switched: $old_ver -> $new_ver ('cast use $old_ver' switches back)"
fi

# --- put cast on PATH --------------------------------------------------------
# Through the current chain, and converging — that includes HEALING: a stale
# or dangling $BINDIR/cast (say, its tree half-removed by hand) must never
# block or wedge an install — it gets repointed at the current chain,
# whatever it said before.
mkdir -p "$BINDIR"
ln -sfn "$DEST/current/bin/cast" "$BINDIR/cast"
log "linked $BINDIR/cast -> $DEST/current/bin/cast"

# --- wire $BINDIR onto PATH, durably -----------------------------------------
# `curl | bash` runs in a subshell, so exporting PATH here would die with this
# process. The only durable place is the user's shell profile — so append there,
# once, marked. Opt out with CAST_NO_MODIFY_PATH=1 and wire it yourself.
MARKER='# added by cast-install'

on_path() {
  case ":$PATH:" in
    *":$1:"*) return 0 ;;
    *) return 1 ;;
  esac
}

# Which file a *login/interactive* shell of this flavour actually reads.
profile_for_shell() {
  case "${SHELL##*/}" in
    zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      # macOS terminals start login shells (.bash_profile); Linux does not.
      if [ "$(uname -s)" = "Darwin" ]; then
        printf '%s\n' "$HOME/.bash_profile"
      else
        printf '%s\n' "$HOME/.bashrc"
      fi
      ;;
    fish) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

path_line_for() {
  case "$1" in
    */config.fish) printf 'fish_add_path %s\n' "$BINDIR" ;;
    *) printf 'export PATH="%s:$PATH"\n' "$BINDIR" ;;
  esac
}

if on_path "$BINDIR"; then
  : # already reachable — nothing to wire
elif [ -n "${CAST_NO_MODIFY_PATH:-}" ]; then
  warn "$BINDIR is not on your PATH (CAST_NO_MODIFY_PATH set — leaving your profile alone)."
  warn "  add: $(path_line_for "$(profile_for_shell)")"
else
  PROFILE="$(profile_for_shell)"
  if [ -f "$PROFILE" ] && grep -qF "$MARKER" "$PROFILE"; then
    log "$PROFILE already puts $BINDIR on PATH — this shell just predates it."
  else
    mkdir -p "$(dirname "$PROFILE")"
    { printf '\n%s\n' "$MARKER"; path_line_for "$PROFILE"; } >>"$PROFILE" \
      || die "could not write $PROFILE — add this line yourself: $(path_line_for "$PROFILE")"
    log "wired $BINDIR onto PATH in $PROFILE"
  fi
  log "this shell does not have it yet — open a new one, or: source $PROFILE"
fi

log "done ($SRCDESC, version $new_ver) — try: cast --help"
