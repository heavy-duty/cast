#!/usr/bin/env bash
set -euo pipefail

# drill-recorded.sh [<runs-file>] [<version-file>] — assert that the version
# this tree claims to ship has a DRILL RECORD in drill/RUNS.md.
#
# CONTRIBUTING says a release carries the full real-hardware drill. Nothing
# checked that, so no release in this family ever carried one: the step lived
# only in a reviewer's memory, and a step that lives in a reviewer's memory is
# performed exactly as often as the reviewer remembers it. A bot finally
# blocked on it, which is the first time the omission was visible at all. So
# the gate moves into CI, where it is asserted on every release PR rather than
# recalled.
#
# WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
#
# It asserts a RECORD EXISTS — not that the drill passed. That is the whole
# design. A maintainer may ship on a failed or partial drill; what they may not
# do is ship on silence. Requiring a record makes a waiver a deliberate,
# reviewable commit (a section saying who waived it and what is untested)
# instead of the default outcome of forgetting. A guard that demanded a PASS
# would be argued with and eventually bypassed; one that demands EVIDENCE has
# nothing to argue about.
#
# PER-REPO, ON PURPOSE
#
# This reads cast's OWN drill/RUNS.md. It does not reach into box or rig to ask
# whether the family drilled. A cross-repo lookup has a failure mode this repo
# keeps refusing: when the fetch fails — no network, moved file, renamed repo,
# a token without read on the other repo — the honest answers are "unknown" and
# "blocked", but the shape such code actually takes degrades to "pass". Same
# class as the unreadable check rollup that read as "nothing is failing".
#
# There is also nothing to look up. The drill is ONE orchestrated run over the
# whole stack (CONTRIBUTING.md, "Releasing"): rig bootstraps the host and
# installs box, box mints a seed, the seed calls rig back to converge, and
# cast's legs run on the result. rig therefore sits BELOW box and ABOVE it —
# the three repos are mutually recursive, not linearly ordered, and their
# releases are NOT published in a fixed sequence. The run pins CANDIDATE refs
# (RIG_REPO/RIG_REF at mint time), so no repo must ship before another can be
# drilled. Each repo records its own legs from that run, citing the shared run
# ID and the other repos' SHAs — which is how three records reassemble into one
# run without any repo reading another's file.
#
# A file of its own, not a clause inlined in ci.yml, for the same reason as
# release-notes.sh and changelog-monotonic.sh: test/release.test.ts drives the
# REAL script against fixtures, so what the tests prove is what CI runs.

runs="${1:-drill/RUNS.md}"
version_file="${2:-package.json}"

[ "$#" -le 2 ] || { echo "usage: drill-recorded.sh [<runs-file>] [<version-file>]" >&2; exit 2; }
[ -f "$version_file" ] || { echo "drill-recorded: no such file: $version_file" >&2; exit 1; }

# cast's version lives in package.json (there is no VERSION file), so this
# reads JSON — with sed, not node. release-notes.sh takes the version as an
# ARGUMENT and so never had to; this one is invoked by CI with no arguments and
# has to find it itself. sed keeps the script runnable by `bash -n`, shellcheck
# and a bare shell alike, with no dependency on a toolchain being installed
# before the guard can speak. The first "version" key in package.json is the
# package's own by npm's schema; dependency entries are "<name>": "<range>"
# pairs and carry no "version" key to be confused with it.
ver="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$version_file" | head -1)"
[ -n "$ver" ] || { echo "drill-recorded: no \"version\" key in $version_file" >&2; exit 1; }

# A -dev tree is main between releases. Nothing ships from it, so there is no
# claim to evidence — and demanding a record here would make every ordinary
# feature PR red until somebody drilled for a version that will never be cut.
# The gate is about the SHIP CLAIM, and `-dev` is the absence of one.
case "$ver" in
  *-dev)
    echo "drill-recorded: version $ver is a development tree — nothing ships from it, so there is nothing to assert."
    exit 0
    ;;
esac

# A bare version is a release ceremony tree: this is the tree whose merge IS
# the release, so this is where the evidence has to exist.
[ -f "$runs" ] || {
  {
    echo "drill-recorded: version $ver is a release, but there is no $runs at all."
    echo
    echo "  The release drill has to be RECORDED, not just performed. Create the file"
    echo "  with the run's section (see the format below) and commit it."
  } >&2
  exit 1
}

# $5 of a drill heading ('## Release drill — 0.2.0 — 2026-07-21') is the bare
# version, compared WHOLE — so 0.2.0 can never be satisfied by a 0.2.0-rc1
# section, or the reverse, and no regex-escaping of dots. Exactly the trap
# release-notes.sh solves the same way, with the same awk field split, so the
# two cannot drift apart about what a heading is. The trailing ' — DATE' is
# optional and unread: the gate is about the version, and the date is for the
# humans reading the log.
#
# grab is re-armed by every '## ' line, so the section ends at the next one —
# a record cannot borrow the body of the record below it.
#
# `grab && NF` is the non-blank rule, and it is load-bearing rather than
# tidiness. NF is 0 on a line that is empty OR contains only whitespace, so
# `record` is non-empty exactly when a line with real content exists. The
# first cut of this piped through `sed '/./,$!d'` and the comment here claimed
# "a heading with nothing but whitespace under it extracts to the empty
# string" — which is precisely what that pipeline did NOT guarantee, because
# `.` matches a space. A heading followed by one tab satisfied the gate. The
# comment documented the intended contract and the code did not meet it, which
# on a gate is the whole ballgame: an evidence-free release for the price of an
# invisible character. Found by all three reviewers on #138, independently.
#
# The '(NF == 5 || $6 == dash)' tail constraint keeps this in step with box's
# twin: without it '## Release drill — 0.2.0 stray words' counts as a record
# here and does not there. Two sibling guards disagreeing about what the same
# heading means is the same trap as disagreeing with release-notes.sh.
record="$(awk -v ver="$ver" -v dash="—" '
  /^## / {
    grab = ($2 == "Release" && $3 == "drill" && $4 == dash && $5 == ver \
            && (NF == 5 || $6 == dash))
    next
  }
  grab && NF { print }
' "$runs")"

if [ -z "$record" ]; then
  {
    echo "drill-recorded: $runs has no drill record for version '$ver'."
    echo
    echo "  A release PR's version must have a NON-EMPTY section headed:"
    echo
    echo "      ## Release drill — $ver — YYYY-MM-DD"
    echo
    echo "  (An empty section under a correct heading counts as no record. The"
    echo "   heading matches the version WHOLE — a '$ver-rc1' section does not"
    echo "   satisfy '$ver', and vice versa.)"
    echo
    echo "  To unblock, either:"
    echo "    * run the drill and record it — the legs (team, apply, idempotent"
    echo "      diff, smoke, inventory, emit-draft, fleet, destroy, read-only"
    echo "      guard), the numbers, and what failed; or"
    echo "    * record an explicit maintainer WAIVER for this version in $runs,"
    echo "      saying who waived it and what is untested."
    echo
    echo "  The waiver is allowed on purpose: this gate requires a RECORD, not a"
    echo "  passing result, so shipping without a drill stays possible — and"
    echo "  stays a deliberate, reviewable commit instead of an oversight."
  } >&2
  exit 1
fi

echo "drill-recorded: $runs carries a drill record for $ver ($(printf '%s\n' "$record" | grep -c .) line(s))"
