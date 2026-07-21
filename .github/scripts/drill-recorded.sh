#!/usr/bin/env bash
set -euo pipefail

# drill-recorded.sh [<drills-dir>] [<version-file>] — assert that the version
# this tree claims to ship has a DRILL RECORD at <drills-dir>/<version>.md.
#
# CONTRIBUTING says a release carries the full real-hardware drill. Nothing
# checked that, so no release in this family ever carried one: the step lived
# only in a reviewer's memory, and a step that lives in a reviewer's memory is
# performed exactly as often as the reviewer remembers it. A bot finally
# blocked on it, which is the first time the omission was visible at all. So
# the gate moves into CI, where it is asserted on every release PR rather than
# recalled.
#
# ONE FILE PER VERSION — WHY THE PARSER IS GONE
#
# The first cut kept every record in one drill/RUNS.md and asked awk which
# section belonged to this version. That bought a heading grammar: em-dash
# field matching, an optional ' — DATE' tail, a whole-version comparison so
# 0.2.0-rc1 could not satisfy 0.2.0, a '(NF == 5 || $6 == dash)' tail
# constraint to stay in step with box's twin, and a non-blank body rule.
#
# All of it existed ONLY because records shared a file — and in review this
# repo shipped two defects out of that complexity: a `sed '/./,$!d'`
# extraction where `.` matches a space, so a heading followed by one tab
# satisfied the gate; and heading-grammar drift from box's stricter form.
# Two defects, on the one check whose entire job is to demand evidence.
#
# One file per version makes nearly all of it UNREPRESENTABLE. `0.2.0.md` and
# `0.2.0-rc1.md` are simply different files — the whole-version rule is the
# filesystem's, not a comparison anyone can get wrong. There is no heading to
# parse, so there is no grammar to drift from box's. What is left is a
# question a shell can ask directly: does the file exist, and does it say
# anything.
#
# The directory is plain `drills/`, NOT `.drills/`. Dot-prefixed directories
# are invisible to globs without `dotglob`, which is the exact blind spot that
# produced #118, #121 here and box#116 — a sweep that looks green because it
# never descended into the directory holding the thing it was meant to check.
#
# WHAT IT ASSERTS, AND WHAT IT DELIBERATELY DOES NOT
#
# It asserts a RECORD EXISTS — not that the drill passed. That is the whole
# design. A maintainer may ship on a failed or partial drill; what they may not
# do is ship on silence. Requiring a record makes a waiver a deliberate,
# reviewable commit (a file saying who waived it and what is untested) instead
# of the default outcome of forgetting. A guard that demanded a PASS would be
# argued with and eventually bypassed; one that demands EVIDENCE has nothing to
# argue about.
#
# PER-REPO, ON PURPOSE
#
# This reads cast's OWN drills/. It does not reach into box or rig to ask
# whether the family drilled. A cross-repo lookup has a failure mode this repo
# keeps refusing: when the fetch fails — no network, moved file, renamed repo,
# a token without read on the other repo — the honest answers are "unknown" and
# "blocked", but the shape such code actually takes degrades to "pass". Same
# class as the unreadable check rollup that read as "nothing is failing".
#
# There is also nothing to look up. The three repos' drills are INDEPENDENT
# (CONTRIBUTING.md, "Releasing") — run in any order, on any schedule, in
# separate sittings. What makes that safe is that every drill pins the SAME
# FIXED SET OF CANDIDATE REFS (RIG_REPO/RIG_REF at mint time), so each one
# exercises the combination that will ship rather than whatever main happens
# to be that afternoon.
#
# That pinning, not sequencing, is what dissolves the box<->rig recursion. box
# and rig ARE mutually recursive — rig builds the host that runs box, box's
# seed calls rig back to converge the guest — but candidate refs are static
# identifiers that exist as soon as the release branches do, long before any
# drill runs. A cycle at runtime becomes independent tests against one fixed
# pair, and no repo must ship before another can be drilled. The three
# releases are NOT published in a fixed sequence.
#
# Each repo also drills a DIFFERENT thing: box asserts the isolation contract,
# rig asserts convergence, cast asserts promotion. Three different exercises
# over a shared substrate — which is exactly why the records are per-repo.
# Each cites the shared run ID naming the pinned set, plus the other repos'
# SHAs, so three records still reassemble into one picture without any repo
# reading another's file.
#
# A file of its own, not a clause inlined in ci.yml, for the same reason as
# release-notes.sh and changelog-monotonic.sh: test/release.test.ts drives the
# REAL script against fixtures, so what the tests prove is what CI runs.

drills="${1:-drills}"
version_file="${2:-package.json}"

[ "$#" -le 2 ] || { echo "usage: drill-recorded.sh [<drills-dir>] [<version-file>]" >&2; exit 2; }
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
#
# The record is <drills-dir>/<version>.md, and it must contain at least one
# NON-WHITESPACE character. That second clause is the one surviving piece of
# the whitespace defect found in review (#138): a file of only spaces, tabs
# and newlines is a file, and `[ -f ]` is happy with it, but it is not a
# record — an evidence-free release for the price of an invisible character.
# `grep -q '[^[:space:]]'` asks the question the old `sed '/./,$!d'` only
# claimed to: `.` matches a space, a POSIX class does not.
record="$drills/$ver.md"

if [ ! -f "$record" ] || ! grep -q '[^[:space:]]' "$record"; then
  {
    echo "drill-recorded: version $ver is a release, but there is no drill record at $record."
    echo
    echo "  A release PR's version must have a NON-EMPTY file named for it:"
    echo
    echo "      $drills/$ver.md"
    echo
    echo "  (A file that exists but holds only whitespace counts as no record."
    echo "   One file per version, so '$ver-rc1.md' is a different record and"
    echo "   does not satisfy '$ver', or the other way round.)"
    echo
    echo "  To unblock, either:"
    echo "    * run the drill and record it — the legs (team, apply, idempotent"
    echo "      diff, smoke, inventory, emit-draft, fleet, destroy, read-only"
    echo "      guard), the numbers, and what failed; or"
    echo "    * record an explicit maintainer WAIVER for this version in that"
    echo "      file, saying who waived it and what is untested."
    echo
    echo "  The waiver is allowed on purpose: this gate requires a RECORD, not a"
    echo "  passing result, so shipping without a drill stays possible — and"
    echo "  stays a deliberate, reviewable commit instead of an oversight."
  } >&2
  exit 1
fi

echo "drill-recorded: $record carries a drill record for $ver ($(grep -c '' "$record") line(s))"
