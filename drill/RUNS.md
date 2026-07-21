# Drill runs

The log of cast's **real-hardware drill legs** — one section per run, appended.
A release PR's version must have a section here before CI will let it merge
(`.github/scripts/drill-recorded.sh`, wired into ci.yml).

**This file is the record, not the instrument.** cast has **no drill harness
script of its own yet**. Its legs are run by hand, against the documented
procedure: two live Coolify instances and the full A→B promotion —

    team → apply → diff (idempotent) → smoke → inventory → emit-draft →
    fleet → destroy → read-only guard

A harness would make the run reproducible; it would not make it recorded. Those
are separate problems, and this file is the second one. When cast grows a
harness, its output gets pasted into a section here in the same format — the
gate does not change.

## Per-repo, by construction

cast records **cast's own** legs. It does not read box's or rig's drill log to
decide whether cast may ship: a cross-repo lookup silently degrades to "pass"
the moment it fails to resolve — the unreadable-rollup class of bug, where a
guard that cannot read its input reports the happy answer.

The legs above are the **top of one orchestrated run over the whole stack**
(CONTRIBUTING.md, *Releasing*): `rig bootstrap --host yes` on bare Debian
installs box and runs `setup-host`; `box new` mints a seed; the seed converges
by calling `rig bootstrap <tenant>-box`; cast's legs run on the result. rig
appears twice — below box and above it — so the three repos are mutually
recursive, not linearly ordered, and their releases are **not** published in a
fixed order.

The run drills candidate refs rather than released artifacts (`RIG_REPO` /
`RIG_REF` are mint-time variables, default `heavy-duty/rig@main`), which is
what makes that possible: no repo has to ship before another can be drilled.
A record therefore cites the shared **run ID** and the other two repos' commit
SHAs — three records, one run, reassemblable — while each repo's evidence
still lives in its own tree.

## Format

The gate looks for a heading of exactly this shape, and requires the section
under it to be non-empty:

    ## Release drill — X.Y.Z — YYYY-MM-DD

The version is matched **whole**: a `0.2.0` release is not satisfied by a
`0.2.0-rc1` section, or the other way round.

A record says three things: **what ran**, **the numbers**, and **what failed**.
"Nothing failed" is a finding and is worth a line; an empty section is not a
record and the gate refuses it.

### Example of the shape

Illustrative only — no run has happened yet, and the placeholder version keeps
this block from ever satisfying the gate for a real release.

    ## Release drill — X.Y.Z — YYYY-MM-DD

    Run ID: `drill-YYYYMMDD-NN` (the stack run these legs are the top of).
    Stack under test: box `<sha>`, rig `<sha>`, cast `<sha>` — candidate
    refs, pinned at mint time via RIG_REPO/RIG_REF.
    Instances: A `coolify-a.example` (v4.x), B `coolify-b.example` (v4.x).
    Manifest: `examples/two-env.yaml`, 3 applications, 2 environments.
    Operator: @maintainer. Elapsed: 41m.

    | Leg | Result | Notes |
    |---|---|---|
    | team | pass | 2 teams, 4 members reconciled |
    | apply (A→B) | pass | 3 apps created, 11 env vars set |
    | diff (idempotent) | pass | second apply: 0 changes |
    | smoke | pass | 3/3 endpoints 200 |
    | inventory | pass | 3 apps, 2 envs, matches manifest |
    | emit-draft | pass | draft matches inventory round-trip |
    | fleet | pass | both instances listed, versions read |
    | destroy | pass | 3 apps removed, absence asserted |
    | read-only guard | pass | write refused against B with the guard on |

    Failures: none. One rough edge: `smoke` needed a 20s retry window on B —
    filed as #NNN, not a release blocker.

## Waivers

A maintainer may ship without a passing drill, but **not without a record**.
The waiver is a section under the same heading saying who waived it, why, and
what is untested — a deliberate, reviewable commit. The gate requires a record,
not a pass, precisely so that skipping is visible.

## Records

*None yet.* cast has recorded no drill runs. New runs are appended below,
newest first.
