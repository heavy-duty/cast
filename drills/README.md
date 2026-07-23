# Drills

Per-release evidence: **one file per version**, named `<version>.md`, where
`<version>` matches `package.json`'s `version` exactly — `0.2.0` is recorded in
`0.2.0.md`, `0.2.0-rc1` in `0.2.0-rc1.md`.

A release PR's version must have its file here, holding at least one
non-whitespace character, before CI will let it merge (the
`heavy-duty/ceremony/actions/drill-recorded` guard, pinned in ci.yml).

## One file per version, and why the parser went away

Records used to share a single `drill/RUNS.md`, which meant the gate had to
*parse* it: a heading grammar, an em-dash field match, an optional ` — DATE`
tail, a whole-version comparison, a non-blank-body rule. That machinery existed
only because records shared a file — and it shipped two defects in review: a
`sed '/./,$!d'` extraction where `.` matches a space (so a heading followed by
one tab satisfied the gate), and heading-grammar drift from box's stricter form.

One file per version makes nearly all of that unrepresentable. `0.2.0.md` and
`0.2.0-rc1.md` are different files, so the whole-version rule is the
filesystem's rather than a comparison anyone can get wrong, and there is no
heading to drift. One rule survives: a file of only whitespace is not a record.

The directory is plain `drills/`, **not** `.drills/`. Dot-prefixed directories
are invisible to globs without `dotglob` — the blind spot behind #118, #121 and
box#116.

## What a record should contain

- **What ran** — which legs, against which manifest.
- **On what host** — the instances, their versions, who operated it.
- **The pinned candidate refs** — box, rig and cast SHAs under test.
- **The numbers** — counts, elapsed time, whatever the legs emit.
- **What failed** — and "nothing failed" is itself a finding worth a line.

**A failed drill is still a valid record.** The gate wants evidence, not
success. A maintainer may ship on a failed or partial drill — what they may not
do is ship on silence, so a **waiver** is also a legitimate record: say who
waived it, why, and what is untested. Requiring a record makes skipping a
deliberate, reviewable commit instead of the default outcome of forgetting.

## This directory is the record, not the instrument

cast has **no drill harness script of its own**. Its legs run by hand against
the documented procedure: two live Coolify instances and the full A→B
promotion —

    team → apply → diff (idempotent) → smoke → inventory → emit-draft →
    fleet → destroy → read-only guard

A harness would make the run reproducible; it would not make it recorded. Those
are separate problems, and this directory is the second one.

## Per-repo, by construction

cast records **cast's own** legs. It does not read box's or rig's drill records
to decide whether cast may ship: a cross-repo lookup silently degrades to
"pass" the moment it fails to resolve — the unreadable-rollup class of bug,
where a guard that cannot read its input reports the happy answer.

**The three repos' drills are independent.** Run them in any order, on any
schedule, in separate sittings. They are not phases of one script.

What makes that safe is that every drill **pins the same fixed set of candidate
refs** (`RIG_REPO` / `RIG_REF` are mint-time variables, default
`heavy-duty/rig@main`), so each drill exercises exactly the combination that
will ship rather than whatever `main` happens to be that afternoon. The run
drills **candidate refs, not released artifacts**.

That pinning — **not sequencing** — is what dissolves the box↔rig recursion.
box and rig *are* mutually recursive: rig builds the host that runs box, and
box's seed calls rig back to converge the guest. But candidate refs are static
identifiers that exist as soon as the release branches do, long before any
drill runs, so a cycle at runtime becomes independent tests against one fixed
pair. No repo has to be released before another can be drilled, and there is
**no fixed order in which the three releases must be published**.

Each repo also drills a **different thing**: box asserts the isolation contract
(the VM trust boundary), rig asserts convergence (a machine reaches its role,
idempotently), cast asserts promotion (A→B reproduces, and the diff is
idempotent). Three different exercises sharing a substrate — which is exactly
why the records are per-repo.

cast's legs are the **least coupled** of the three. Two Coolify instances can
be stood up by hand; the July drill did exactly that for instance B, via a
parameterised compose file. Nothing about cast's drill requires box or rig to
have been drilled first, or at all, on that day.

Within a single drill you obviously bring the substrate up before probing it —
a host before a guest before Coolify. That is how you run *a* drill, not an
ordering rule *between repos*.

If a defect shows up only in the combination: patch, re-drill, re-record. The
three releases converge on a set that holds together; they are not required to
be right in one pass.

**Drilling the candidate is drilling the release.** A release PR's diff is the
version file and `CHANGELOG.md` — nothing executable differs between the tree
that was drilled and the tree that ships, so the evidence carries across the
ceremony commit.

Each record cites the shared **run ID** naming the pinned set, plus the other
two repos' SHAs — which is what lets separate records be reassembled into one
picture, while each repo's evidence still lives in its own tree.

## Worked example

Illustrative only. The version below is a **placeholder that can never collide
with a real release** — a realistic-looking version here would be a real record
for it, and the gate would wave that release through on documentation. The
mechanism changed with the move to one file per version; the caution did not.

`drills/9.9.9.md`:

```markdown
# Release drill — 9.9.9 — YYYY-MM-DD

Run ID: `drill-YYYYMMDD-NN` (names the pinned candidate set).
Stack under test: box `<sha>`, rig `<sha>`, cast `<sha>` — candidate refs,
pinned at mint time via RIG_REPO/RIG_REF.
Instances: A `coolify-a.example` (v4.x), B `coolify-b.example` (v4.x),
B stood up by hand from the parameterised compose file.
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
```

## Records

*None yet.* cast has recorded no drill runs.
