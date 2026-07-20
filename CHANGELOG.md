# Changelog

History before 0.1.0 lives in git — cast has said `0.1.0` in `package.json`
since its first commit, but grew its release surface (this file,
`cast --version`, tagged releases with a prebuilt asset) on the way to
actually cutting it, and this file starts there.

## Unreleased

### Changed

- **PR labels split into two axes: `state:*` (whose ball) and `blocker:*`
  (what is in the way)** (heavy-duty/box#138) — `state:needs-rebase` is
  retired, replaced by `blocker:conflict`, `blocker:ci-red` and
  `blocker:unrequested`. One rule joins the axes: `state:needs-human` requires
  zero blockers.

  The entry below this one, added a day ago, closed by noting that cast had
  not yet been bitten only because nothing had conflicted — that three PRs sat
  at `state:needs-human` at once and would conflict through this very file the
  moment one landed. #128 landed. A dry sweep now finds #119, #120 and #122
  all still wearing `state:needs-human` over branches GitHub calls
  `CONFLICTING`, which is the predicted failure arriving on schedule.

  Fixing *that* is what the previous entry did. What this one fixes is the
  shape that kept regrowing it. The single-label design projected independent
  facts — mergeability, check status, where the review round stands — onto one
  totally-ordered value, and a total order must pick a winner, so the rest
  silently vanish. Every precedence bug this machine has had lived on that
  ordering: `needs-human` surviving a conflict, `MISSING` swallowing `STALE`,
  and `state:needs-rebase` firing on both a conflict and a red check when
  those need opposite work — telling an agent to rebase when what it owed was
  a bug fix. Blockers are a set. A set has no precedence between its members
  to get wrong, and what remains on the ordered axis is purely about reviews,
  the one place an ordering actually means something.

  `state:bots-reviewing` tightens with it, to mean strictly *a request is live
  and an answer is coming*. A ready PR nobody was asked to review used to read
  "waiting on the reviewers" for the 48 hours it took the stale sweep to
  notice; it is now `state:addressing` + `blocker:unrequested`, because the
  ask is the agent's to make. Drafts are exempt, and so is an explicit human
  request — a maintainer claiming a PR early is deliberate, not a dropped ball.

  The reconciler carries a `RETIRED` array and strips `state:needs-rebase` on
  sight, so retiring a label heals the board instead of stranding one that
  nothing recomputes. A verdict is owed in two shapes and both raise
  `blocker:unrequested`: `MISSING` (nobody reviewed) and `STALE` (everybody
  reviewed an older head). Fixtures 51 → 68.

### Fixed

- **A label the repo does not have no longer takes the whole edit down with
  it** — `gh issue edit --add-label` rejects the *entire* call on one unknown
  name, applying nothing. Batching state and blockers into a single edit (for
  anti-flicker) meant one missing `blocker:*` would also drop the `state:*`
  convergence, and the taxonomy was only created by a manual
  `workflow_dispatch` — so the first sweep after this change would have healed
  *nothing* on precisely the PRs it exists to fix, surfacing only as a log
  line. The add side is now filtered against the repo's real label set, read
  once per sweep. Removals need no filter (they are built from `has_label`, so
  they provably exist), and an unreadable label set filters *nothing* rather
  than everything — a failed read must not silently strip the board.

- **An unreadable check rollup is no longer read as "nothing is failing"** —
  when `gh pr view` failed, the fallback left the `statusCheckRollup` key
  absent, and `(.statusCheckRollup // [])` collapsed that into the same `NONE`
  as a PR that genuinely has no checks. `NONE` blocks nothing, so an API
  hiccup presented as mergeable-by-a-human — the unknown-certified-as-green
  shape this machine exists to stop, surviving in the one place the #128 fix
  never looked. `checks_state` now returns `UNREADABLE` for the absent key,
  distinct from `NONE` for a present-but-empty array, and the sweep leaves
  that PR exactly as it is rather than recomputing on facts it did not read.
  Deliberately *not* a blocker: blocking would flap the whole board on one bad
  call, and the next tick is 15 minutes away.

- **`state:needs-human` no longer appears on PRs a human cannot merge**
  (#127, heavy-duty/box#136) — `decide_state()` derived state from three inputs
  (draft flag, requested reviewers, submitted reviews) and read *nothing* about
  mergeability or checks. Combined with the `if requested "$HUMAN"`
  short-circuit at the top of its precedence, the label was **sticky**: once
  the maintainer was requested, the PR read `state:needs-human` through
  conflicts, through red CI, through a force-push that staled every approval.
  Nothing demoted it.

  In this repo the *second* half is the live one: three PRs currently sit at
  `state:needs-human` simultaneously, with nothing saying which to merge first
  — and they will conflict through `CHANGELOG.md` the moment one lands. The
  stickiness has not bitten here yet only because nothing has conflicted; the
  code carried it identically, so the first merge would have reproduced box's
  situation exactly.

  The rule the label now keeps is that **`state:needs-human` means a human
  could merge this right now**, so anything making that false outranks the
  request that put it there. A `CONFLICTING` branch or a failing check is the
  agent's to fix: new `state:needs-rebase`. Approvals staled by a push mean
  nobody reviewed this tree: `state:addressing`, because the agent owes a
  re-request. An *unfinished* round still yields to an explicit human request —
  a maintainer pulling a PR to themselves early is deliberate, and `MISSING`
  (nobody has reviewed yet) is a different fact from `STALE` (everyone reviewed
  something else). Precedence is applied to the round as a whole, after every
  verdict is collected: deciding inside the loop let the order of `BOTS` pick
  the answer, so a round that was *both* unfinished and staled returned on the
  `MISSING` before any later bot's `STALE` was read — and came out
  `needs-human` over a head nobody had reviewed, the original bug wearing a
  different hat.

  Whether a check blocks is judged by listing the outcomes that *don't* —
  `SUCCESS`, `NEUTRAL`, `SKIPPED`, and the pending set — rather than the
  outcomes that do. The rollup mixes two closed enums (`CheckRun.conclusion`
  and `StatusContext.state`), and an outcome the list forgets is one the label
  cannot certify as mergeable: `ERROR`, `CANCELLED` and `STALE` all read as
  green under an allow-list of failures. The costs are not symmetric — a false
  failure parks the PR on the agent, who looks; a false success invites a human
  to merge a tree that will not merge. Superseded runs are dropped first, each
  context collapsing to its newest entry: a re-run does not evict the run it
  replaced, and the rollup keeps both. That shape is live on this board — this
  PR's own tip carried two `scope` and two `reconcile` entries — and on
  heavy-duty/box#137's tip the superseded half was `CANCELLED`, so once
  `CANCELLED` blocks, judging every entry rather than the newest would strand
  every re-run PR in `needs-rebase`.

  Dating a run turned out to be the subtle half, and getting it wrong restored
  the bug. A run still in flight has no completion, but `gh` does not omit the
  field — its Go struct marshals the zero time as `"0001-01-01T00:00:00Z"`, a
  string, which jq's `//` will not fall through. Ordering on completion
  therefore sorted the *live* re-run below every finished one and let the
  collapse discard it, judging the very run it superseded: a green context with
  a replacement mid-flight read `SUCCESS` — the original bug restored, pointing
  a human at a disabled merge button — and a `CANCELLED` original whose
  replacement was still running read `FAILURE`, the flap the collapse exists to
  prevent. So a run is dated by when it **began**, with both spellings of
  absent discarded (`null`, and the zero sentinel) and a fallback only for a
  run that never recorded a beginning — not by the newest stamp of any kind,
  which compares the completion of a finished run against the start of a live
  one. Those are different quantities, and a run cancelled by the concurrency
  group does not stop the instant its replacement starts: the runner winds
  down, so a predecessor routinely finishes *after* its successor began, and
  dating by "newest stamp" let the dead run out-rank the live one that
  replaced it. An entry carrying no usable timestamp at all sorts **last**
  rather than first: something undateable is most likely the thing just
  created, and every ambiguity here resolves toward "not settled" rather than
  toward a stale success.

  `UNKNOWN` mergeability is deliberately not treated as unmergeable: GitHub
  reports it for about a minute after every merge while it recomputes, and
  flapping every open PR through `needs-rebase` on each merge would be worse
  than the bug. A failed read of either fact degrades to the same "do not know"
  value, for the same reason.

  Also adds `merge-next` — the label this repo needs most today, since a
  correct `needs-human` still does not say *which* of three ready PRs to merge
  first. Queue order is intent, so the reconciler never sets it; it only
  **clears** it once the PR stops being mergeable-by-a-human. Ported from
  heavy-duty/box#137 so the three repos' reconcilers stay byte-identical; both
  live shapes, the mixed round, the in-flight run superseding a finished one —
  in both spellings of an absent completion, in both directions, and across the
  wind-down window where the two overlap — and the whole check-outcome enum are
  pinned in `test/labels-reconcile.sh` (fixtures 19 → 51).

## 0.1.1 — 2026-07-19

### Fixed

- **The release ceremony re-arms the changelog, and CI notices when it
  doesn't** (#113) — stamping `## Unreleased` into `## X.Y.Z — DATE` is
  done by hand in the ceremony PR; no workflow writes this file, and
  nothing put the heading back. So `main` sat with the shipped section on
  top and no `## Unreleased` above it — this repo's state from 0.1.0
  until this entry. A PR authored before a release and merged after has
  its entry land under whatever heading now occupies that position: the
  release that already shipped. Git does that *cleanly*. The stamped
  heading and the incoming entry never overlap textually, so the one
  signal an author trusts — "git told me to look" — is missing exactly
  when the result is wrong. rig watched it happen (heavy-duty/rig#66, the
  origin of this fix): an entry landed inside published `## 0.1.0` an
  hour after 0.1.0 shipped, and was caught only because someone was
  reading. The published release body is never at risk — `release.yml`
  extracts notes from the tree at the tag, before anything late can merge
  — which is also why nobody notices: the file that drifts is the one
  only maintainers read. Three moves. `## Unreleased` is back above
  `## 0.1.0` (this entry re-creating it *is* the repair). CONTRIBUTING's
  ceremony step now re-arms in the same diff that stamps. And
  `test/release.test.ts` keys the rule to `package.json`: a stamped top
  section is legal while the version is bare — the ceremony's own tree,
  and main until the `-dev` bump — but once the version says `-dev`, the
  top section must be `## Unreleased`. That is the distinction #108 had
  to collapse to make the ceremony shippable at all, recovered rather
  than reverted: the ceremony stays green at every step, and a disarmed
  dev `main` goes red. The re-arm also forced the older extraction guard
  to move. It asserted that the **top** section extracts non-empty, which
  the re-armed ceremony tree — a deliberately empty `## Unreleased` above
  the stamp — makes false by construction: the re-arm and the guard would
  have contradicted each other, and the next release PR would have been
  unshippable for a second time, the way #108 was. Keying to the top
  section was only ever a stand-in for "the section `release.yml` will
  publish", so the assert now names that section directly — on a bare
  version the `## X.Y.Z` being shipped, on a `-dev` tree the newest
  stamped one. Existence is checked with it: a bare version with no
  matching section is a bump that never stamped, which used to pass every
  test and fail only *after* the merge, in `release.yml`'s notes step,
  past the ship decision and leaving `main` with a minted, unreleased
  version to repair by hand. A double re-arm — two `## Unreleased`
  headings, the extracted section silently the empty one — is red too.
  box and rig carry the same fix (heavy-duty/box#110,
  heavy-duty/rig#67); rig#67 retargeted the identical assert for the
  identical reason.

## 0.1.0 — 2026-07-19

### Fixed

- **The release suite accepts the ceremony's own tree** (#108) —
  `test/release.test.ts` demanded the real `CHANGELOG.md`'s literal
  `Unreleased` section extract non-empty and contain `#96`: false by
  construction on the `release: X.Y.Z` tree the ceremony's own PR produces
  (it stamps that heading into `## X.Y.Z — date`), so the first real
  release PR turned CI red and the flow blocked itself — invisible to the
  fork rehearsals, which tag a branch (`release.yml` runs; `ci.yml` never
  does). The guard now asserts its actual purpose: whatever the TOP `## `
  section is — `Unreleased` between releases, the stamped version on and
  right after one — the exact `release-notes.sh` the workflow runs
  extracts it non-empty. rig's twin is heavy-duty/rig#44.

- **`apply` no longer demands a GitHub App for a manifest that declares no
  applications** (#103) — found live in the 2026-07-19 release drill, where a
  databases-only manifest (`applications: {}`) rendered its plan of two
  creates and then died in preflight on `no GitHub App bound`, over a binding
  nothing in the run would ever have used: a GitHub App exists to clone
  application source, cast reads it in exactly one call (the application
  create), and databases and services never touch it. That unconditional
  resolution gated infra-only projects — the databases a fleet's other
  projects share — behind the GitHub-App browser-registration ceremony for no
  reason. `apply` now resolves the App only when the desired state actually
  contains an application; a manifest that does declare one still refuses on
  a missing binding exactly as before, clean plan or not, because that
  binding is state the next create will need.
- **A manifest with no `${…}` refs applies without a store** (#104) — the
  greenfield manifest-first bootstrap was a chicken-and-egg with no exit,
  found by the 2026-07-19 release drill against two fresh Coolify 4.1.2
  instances: a registered project whose manifest declared databases only
  (zero `${…}` refs) could not take its first `apply` — apply refused with
  `no secret store for <org>/<repo> in <env>`, and `capture`, the documented
  way to get a store, rightly refuses a project that is absent on the box,
  because apply is the verb that would create it. The drill unblocked with a
  hand-rolled empty store (`printf '' | age -r … -o secrets/….env.age`),
  documented nowhere. Now `diff`/`apply` gate that refusal on the manifest
  actually *referencing* a secret, asked via the same parser resolution
  uses: when the templates resolve zero `${…}` refs, an absent store is
  treated as empty and the run proceeds, printing a loud one-line note
  naming the path the store would live at — and since there is nothing to
  decrypt, the age key is not demanded either. The moment any template
  gains a `${…}` ref, the refusal returns byte-identical to before.
  `capture` and `destroy` are untouched.
- **`CAST_AGE_KEY_FILE_<ENV>` is now settable for every environment name**
  (#102) — `<ENV>` was the name uppercased verbatim, so env `drill-b`
  advertised `CAST_AGE_KEY_FILE_DRILL-B`: a variable no POSIX shell can
  export, which walled off the injected-key channel (and its
  process-substitution trick) for every hyphenated environment. Found live
  in the 2026-07-19 release drill. Characters outside `[A-Z0-9]` now map to
  `_` — env `drill-b` reads `CAST_AGE_KEY_FILE_DRILL_B` — and the refusal
  advertises the mapped name. The standing-key path keeps the exact
  environment name, so two names that collide on the variable still resolve
  their own keys on disk.

### Added

- **Merging a release-labeled PR is the release — and the release re-arms
  main itself** (#111; box#96's design) — `release.yml` now also fires on
  pushes to main (not `pull_request` events: fork-sourced ceremony PRs get
  a read-only token there — the round-1 catch). A decide step reads the
  version transition from the push (`event.before` → the pushed head) and
  answers four states: release-flow *work* merged under the `release`
  label — `-dev` endstates, and the post-release window — no-ops green
  with a NOTICE; the two genuinely ambiguous bare states refuse loudly;
  a true transition then requires a merged, `release`-labeled PR behind
  the commit (read via the API — the label is the operator's declared
  intent) before the door opens. It then tags the merge commit, builds
  the `cast-X.Y.Z.tgz` asset once, publishes — and bumps main to
  `X.Y.(Z+1)-dev` itself, direct push with a loud open-a-PR fallback, so
  no follow-up bump PR exists on the paved road. The tag-push path stays
  as the documented fallback and backfill, and both paths run the same
  steps so they cannot drift. First-release edge: 0.1.0 never carried
  `-dev`, so its ceremony (#110) ships by manual tag; the automation
  applies from 0.1.1 on.

- **Tagged releases with a prebuilt dist asset, and an installer that
  installs them** (#96) — the cast half of the flow designed in
  heavy-duty/box#83, plus the piece unique to cast: a **prebuilt asset**,
  because cast is the one repo where the source tarball is *not* the
  package. A release is a PR, then a tag: the `release: X.Y.Z` PR bumps
  `package.json` (and `package-lock.json`) and stamps this file's Unreleased
  section with version + date; the merge commit is tagged bare `X.Y.Z`
  (box's tag scheme — no `v` prefix). `release.yml` turns the tag into the
  GitHub release — after asserting tag == `package.json` version (a
  mismatch fails loudly and creates nothing) — with that version's section
  of this file as the body, extracted by the same
  `.github/scripts/release-notes.sh` the test harness drives, and with the
  runnable tree attached as `cast-X.Y.Z.tgz`: `bin/`, compiled `dist/`,
  production `node_modules/`, `package.json`, built once in CI
  (`npm ci && npm run build && npm prune --omit=dev`). `install.sh` now
  defaults to the **latest release**: the tag is resolved by following the
  `releases/latest` redirect and reading the `Location` header — no API, no
  token — and the download is that release's asset, so **no `npm ci`, no
  `tsc`, no devDependencies ever run on the operator's machine**. `CAST_REF`
  picks the other two channels: a tag pins a release (its asset first,
  source as the fallback for a ref that has none — `refs/tags` outranks a
  same-named branch), a branch (`CAST_REF=main`) tracks the development
  tree and is the one channel that still builds from source, the only place
  `npm` is required. Until 0.1.0 is cut the default channel has nothing to
  resolve and dies saying exactly that, naming `CAST_REF=main` as the way
  to install today — it never falls back to main silently, because "I
  installed the latest release" must not quietly mean "I installed whatever
  main was that second". The channel only decides *which* tree arrives and
  whether it is built here — whatever it fetched lands in the versioned
  layout (`versions/<package.json version>`, `current` flipped atomically)
  like any other install.
