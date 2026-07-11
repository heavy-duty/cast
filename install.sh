#!/usr/bin/env bash
set -euo pipefail

# cast installer — intended for: curl -fsSL .../install.sh | bash
#
# Downloads the cast repo tarball, installs the tree under $DEST, builds it,
# and puts a `cast` symlink on PATH via $BINDIR. Re-run any time to upgrade.
#
# Unlike rig (pure bash, runs on bare boxes), cast runs on YOUR machine and
# needs node — it is an API client, never something a server installs.

REPO="${CAST_REPO:-heavy-duty/cast}"
REF="${CAST_REF:-main}"
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
command -v npm  >/dev/null 2>&1 || die "npm is required but was not found."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "node >=22.12 is required (found $(node -v))."

# age is what decrypts the state repo's secrets — apply/diff shell out to it.
command -v age >/dev/null 2>&1 || warn "age not found — 'cast apply' will fail until it is installed."

# --- temp workspace ----------------------------------------------------------
TMPDIR="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

URL="https://github.com/$REPO/archive/refs/heads/$REF.tar.gz"

log "installing cast ($REPO@$REF)"
log "downloading $URL"
curl -fsSL "$URL" -o "$TMPDIR/cast.tar.gz" \
  || die "failed to download $URL"

log "extracting archive"
tar -xzf "$TMPDIR/cast.tar.gz" -C "$TMPDIR" \
  || die "failed to extract archive"

# GitHub archives extract to a single top-level dir like cast-<ref>/
EXTRACTED="$(find "$TMPDIR" -maxdepth 1 -type d -name 'cast-*' | head -n1)"
[ -n "$EXTRACTED" ] || die "could not find extracted cast-* directory in archive"
[ -f "$EXTRACTED/bin/cast" ] || die "archive does not contain bin/cast — is $REPO@$REF correct?"

# --- build (deps + tsc), then drop the dev deps -------------------------------
log "building (npm ci && npm run build)"
( cd "$EXTRACTED" && npm ci --silent && npm run build --silent ) \
  || die "build failed"
( cd "$EXTRACTED" && npm prune --omit=dev --silent ) || warn "could not prune dev dependencies"

# --- atomically replace $DEST --------------------------------------------------
log "installing into $DEST"
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$EXTRACTED" "$DEST"

chmod +x "$DEST/bin/cast" "$DEST"/scripts/*.sh

# --- put cast on PATH ----------------------------------------------------------
mkdir -p "$BINDIR"
ln -sf "$DEST/bin/cast" "$BINDIR/cast"
log "linked $BINDIR/cast -> $DEST/bin/cast"

# --- PATH check ----------------------------------------------------------------
case ":$PATH:" in
  *":$BINDIR:"*) : ;;
  *)
    warn "$BINDIR is not on your PATH."
    warn "  add: export PATH=\"$BINDIR:\$PATH\""
    ;;
esac

log "done — try: cast --help"
