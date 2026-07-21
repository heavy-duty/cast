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
      # `read` returns 1 at EOF even when it populated `line` — which is what
      # happens on a file whose FIRST line has no trailing newline (a
      # shebang-only file with no final newline). A bare `|| continue` would
      # skip exactly that file, silently. Fall through whenever `line` is
      # non-empty; the empty case is a genuinely empty file, which has no
      # shebang and is meant to be skipped.
      IFS= read -r line <"$f" || [ -n "$line" ] || continue
      case "$line" in '#!'*) ;; *) continue ;; esac
      # reduce the shebang to a bare interpreter name: drop the '#!', drop any
      # flags, then keep the last path/word component — so both '#!/bin/sh -e'
      # and '#!/usr/bin/env bash' come out as 'sh' and 'bash'.
      interp="${line#\#!}"
      interp="${interp%% -*}"
      interp="${interp##*[ /]}"
      # Two known limits of this reduction, both theoretical in this repo:
      #   - `zsh` is on the allowlist, but shellcheck has no zsh support and
      #     emits SC1071 for it. So a tracked zsh script makes the sweep fail
      #     HARD rather than get linted. That is the right end state — a
      #     script nobody can lint should be loud, not skipped — but the
      #     outcome is "blocked", not "clean". Drop zsh here only if the repo
      #     ever gains one and the answer is to exempt it on purpose.
      #   - `#!/usr/bin/env -S bash` reduces to `env` and is not matched.
      #     Nothing in the repo uses `-S`; see #121 for why that is left.
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

# --- the floor: extensionless scripts --------------------------------------
#
# The check above is derived from `git ls-files '*.sh'`, so it says nothing
# about scripts that have no `.sh` extension — those enter the set only via
# the shebang scan. `bin/cast` is one, and it is the shipped entrypoint. So
# it is covered by the DERIVATION and not by the ASSERTION: break or delete
# the shebang branch and bin/cast drops out of the sweep while this script
# still exits 0. That is #118's failure mode — a lint quietly narrowing while
# CI stays green — one level in from where the *.sh check closed it (#121).
#
# There is no non-circular way to re-derive "every extensionless shell
# script" here; any second derivation would be the same shebang scan, and
# would break with it. So the floor is named rather than computed: the known
# extensionless scripts are listed, and the sweep must contain them. A rename
# turns this red, which is correct — the floor is the thing that has to be
# updated deliberately.

required=(bin/cast)

for req in "${required[@]}"; do
  if ! printf '%s\n' "${files[@]}" | grep -qxF "$req"; then
    echo "shellcheck-all: '$req' is not in the swept set" >&2
    echo "it has no .sh extension, so it enters only via the shebang scan above —" >&2
    echo "that scan is broken, or the file moved. See #121." >&2
    exit 1
  fi
done

# --- lint ------------------------------------------------------------------

printf 'shellcheck: linting %d tracked scripts\n' "${#files[@]}"
printf '  %s\n' "${files[@]}"
shellcheck -x "${files[@]}"
echo "shellcheck: clean"
