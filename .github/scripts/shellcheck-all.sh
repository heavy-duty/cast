#!/usr/bin/env bash
set -euo pipefail

# Lint every tracked shell script in the repo, and prove the set is complete
# (#118). Note for editors: a comment line here must not BEGIN with the word
# "shellcheck" — that is directive syntax, and prose in that position is a
# parse error. This file's own sweep catches it, which is how this note exists.
#
# WHY THE LIST COMES FROM GIT, NOT FROM A GLOB
#
# The obvious sweep is a globstar one:
#
#     shopt -s globstar; files=(bin/* **/*.sh)
#
# and it is quietly wrong. Globs do not match dot-prefixed names without
# `dotglob`, so `**/` never descends into `.github/` — which is where
# release-notes.sh lives, the script that produces the published release body.
#
# `shopt -s globstar dotglob` does fix that, and measured in this repo it
# pulls in nothing unwanted: the sweep runs after `npm ci`, but cast's current
# dependency tree happens to ship zero `.sh` files, so `**/*.sh` stays clean.
# "Happens to" is the problem — that is a property of somebody else's package
# tree, re-decided by every `npm install`, and the day a transitive dep vendors
# a shell script the lint silently becomes partly about their code. `git
# ls-files` does not depend on that: it sees the tracked tree exactly, with no
# dotfile blind spot and no untracked noise, and it stays right when files move.
#
# Extensionless scripts (bin/cast) are found by shebang rather than named, so
# adding one does not require editing this file.

cd "$(git rev-parse --show-toplevel)"

# --- the set to lint -------------------------------------------------------

mapfile -t files < <(
  {
    git ls-files '*.sh'
    git ls-files | while IFS= read -r f; do
      case "$f" in *.sh) continue ;; esac
      [ -f "$f" ] || continue
      IFS= read -r line <"$f" || continue
      case "$line" in '#!'*) ;; *) continue ;; esac
      # reduce the shebang to a bare interpreter name: drop the '#!', drop any
      # flags, then keep the last path/word component — so both '#!/bin/sh -e'
      # and '#!/usr/bin/env bash' come out as 'sh' and 'bash'.
      interp="${line#\#!}"
      interp="${interp%% -*}"
      interp="${interp##*[ /]}"
      case "$interp" in sh | bash | dash | ksh | zsh) printf '%s\n' "$f" ;; esac
    done
  } | sort -u
)

[ "${#files[@]}" -gt 0 ] || { echo "shellcheck-all: found no shell scripts — the sweep is broken" >&2; exit 1; }

# --- the class check -------------------------------------------------------
#
# Assert the set we are about to lint COVERS every tracked *.sh. Today this
# can't fail, because the list above is derived from the same `git ls-files`
# — and that is the point. It is a guard on the STATE ("no tracked script
# goes unlinted"), not on the instance that broke: the day someone rewrites
# the derivation above into something cheaper that skips a directory, this
# fails loudly instead of the lint silently passing over nothing. #118 stayed
# latent precisely because a shrinking sweep looks exactly like a green one.

unlinted="$(comm -23 <(git ls-files '*.sh' | sort -u) <(printf '%s\n' "${files[@]}" | sort -u))"
if [ -n "$unlinted" ]; then
  echo "shellcheck-all: tracked shell scripts that this sweep does not lint:" >&2
  printf '%s\n' "$unlinted" | sed 's/^/  /' >&2
  echo "the sweep must cover every tracked *.sh — see #118" >&2
  exit 1
fi

# --- lint ------------------------------------------------------------------

printf 'shellcheck: linting %d tracked scripts\n' "${#files[@]}"
printf '  %s\n' "${files[@]}"
shellcheck -x "${files[@]}"
echo "shellcheck: clean"
