#!/usr/bin/env bash
set -euo pipefail

# cast installer — intended for: curl -fsSL .../install.sh | bash
#
# Three channels from one script (cast#96, the flow shared with box#83):
#
#   CAST_REF unset      → the latest GitHub release's prebuilt asset
#                         (cast-X.Y.Z.tgz). No npm ci, no tsc, no
#                         devDependencies on this machine — the build
#                         happened once, in CI, on the tag.
#   CAST_REF=X.Y.Z      → that release's asset, when one exists — a pin.
#   CAST_REF=<branch>   → build from source: the repo tarball for that
#                         ref (tags tried before branches), npm ci + tsc
#                         here. CAST_REF=main is the dev channel.
#
# Re-run any time to upgrade. Unlike rig (pure bash, runs on bare boxes),
# cast runs on YOUR machine and needs node — it is an API client, never
# something a server installs.

REPO="${CAST_REPO:-heavy-duty/cast}"
REF="${CAST_REF:-}"
DEST="${CAST_HOME:-$HOME/.local/share/cast}"
if [ "$(id -u)" -eq 0 ]; then
  BINDIR="${CAST_BIN:-/usr/local/bin}"
else
  BINDIR="${CAST_BIN:-$HOME/.local/bin}"
fi

log() { printf 'cast-install: %s\n' "$*"; }
warn() { printf 'cast-install: WARNING: %s\n' "$*" >&2; }
die() { printf 'cast-install: ERROR: %s\n' "$*" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl is required but was not found."
command -v tar  >/dev/null 2>&1 || die "tar is required but was not found."
command -v node >/dev/null 2>&1 || die "node >=22.12 is required but was not found."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >=22.12 is required (found $(node -v))."

# age is what decrypts the state repo's secrets — apply/diff shell out to it.
if ! command -v age >/dev/null 2>&1; then
  warn "age not found — 'cast apply' and 'cast diff' will fail until it is installed."
  warn "  Debian/Ubuntu: sudo apt install age | Arch: sudo pacman -S age"
  warn "  Fedora: sudo dnf install age | macOS: brew install age"
fi

# --- temp workspace ----------------------------------------------------------
TMPDIR="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

# Resolve the latest release tag by following the releases/latest redirect
# and reading where it landed — no API, no token, no rate-limit pain
# (box#83's trick). GitHub answers .../releases/tag/<TAG>; anything else
# (a repo with no releases redirects nowhere useful) is a loud failure.
resolve_latest_tag() {
  local landed
  landed="$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")" || return 1
  case "$landed" in
    */releases/tag/*) printf '%s\n' "${landed##*/releases/tag/}" ;;
    *) return 1 ;;
  esac
}

# fetch_ok <url> <outfile> — download, true/false. -f keeps a 404 an
# error instead of saving GitHub's error page as a tarball.
fetch_ok() {
  curl -fsSL "$1" -o "$2" 2>/dev/null
}

# --- acquire the tree --------------------------------------------------------
# PREBUILT=1 means the tarball is a CI-built runnable tree (bin/, dist/,
# production node_modules/, package.json) — nothing to compile here.
PREBUILT=0
SRCDESC=""

if [ -z "$REF" ]; then
  TAG="$(resolve_latest_tag)" \
    || die "could not resolve the latest release of $REPO — no releases yet, or no network. CAST_REF=main installs from source."
  URL="https://github.com/$REPO/releases/download/$TAG/cast-$TAG.tgz"
  log "installing cast $TAG (latest release of $REPO)"
  log "downloading $URL"
  fetch_ok "$URL" "$TMPDIR/cast.tar.gz" \
    || die "failed to download the $TAG release asset: $URL"
  PREBUILT=1
  SRCDESC="$REPO@$TAG (release asset)"
else
  # A pinned tag that has a release asset gets the asset — same bits as the
  # default channel, just older. Everything else (a branch, a tag from
  # before releases carried assets) falls back to build-from-source.
  ASSET_URL="https://github.com/$REPO/releases/download/$REF/cast-$REF.tgz"
  if fetch_ok "$ASSET_URL" "$TMPDIR/cast.tar.gz"; then
    log "installing cast $REF (pinned release asset)"
    PREBUILT=1
    SRCDESC="$REPO@$REF (release asset)"
  else
    log "no release asset for '$REF' — building from source"
    for kind in tags heads; do
      URL="https://github.com/$REPO/archive/refs/$kind/$REF.tar.gz"
      if fetch_ok "$URL" "$TMPDIR/cast.tar.gz"; then
        SRCDESC="$REPO@$REF (source, refs/$kind)"
        break
      fi
      SRCDESC=""
    done
    [ -n "$SRCDESC" ] || die "no tag or branch named '$REF' in $REPO (tried the release asset, refs/tags and refs/heads)"
    log "downloaded from refs — $SRCDESC"
  fi
fi

log "extracting archive"
tar -xzf "$TMPDIR/cast.tar.gz" -C "$TMPDIR" \
  || die "failed to extract archive"

# Both shapes carry exactly ONE top-level directory (GitHub names its
# archives <repo>-<ref>; release.yml stages cast-<version>). Deriving that
# name is guesswork — it broke for real at box's repo rename — so take the
# single directory, whatever it is called, and judge the tree by its content.
EXTRACTED="$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[ -n "$EXTRACTED" ] || die "could not find the cast tree in the archive"
[ -f "$EXTRACTED/bin/cast" ] || die "archive does not contain bin/cast — is $SRCDESC correct?"

# --- build (source channel only) ---------------------------------------------
if [ "$PREBUILT" -eq 1 ]; then
  # Verify the shape before touching $DEST: a prebuilt tree that cannot run
  # is better refused here than discovered at `cast apply` time.
  [ -f "$EXTRACTED/dist/cli.js" ] && [ -d "$EXTRACTED/node_modules" ] \
    || die "the release asset is not a runnable tree (missing dist/ or node_modules/) — broken release? CAST_REF=main installs from source"
else
  command -v npm >/dev/null 2>&1 || die "npm is required to build from source (CAST_REF=$REF) but was not found."
  log "building (npm ci && npm run build)"
  ( cd "$EXTRACTED" && npm ci --silent && npm run build --silent ) \
    || die "build failed"
  ( cd "$EXTRACTED" && npm prune --omit=dev --silent ) || warn "could not prune dev dependencies"
fi

# --- atomically replace $DEST --------------------------------------------------
log "installing into $DEST"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$EXTRACTED" "$DEST"

chmod +x "$DEST/bin/cast"
# Source installs carry scripts/; the release asset deliberately does not.
if [ -d "$DEST/scripts" ]; then
  find "$DEST/scripts" -name '*.sh' -exec chmod +x {} +
fi

# --- put cast on PATH ----------------------------------------------------------
mkdir -p "$BINDIR"
ln -sf "$DEST/bin/cast" "$BINDIR/cast"
log "linked $BINDIR/cast -> $DEST/bin/cast"

# --- wire $BINDIR onto PATH, durably -------------------------------------------
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

log "done ($SRCDESC) — try: cast --help"
